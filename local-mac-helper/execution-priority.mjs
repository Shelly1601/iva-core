import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withFundingFileLock } from './funding-intake-state.mjs';

// FIFO within one worker prevents hot polling contenders from starving release
// transactions. The filesystem lock still provides cross-process exclusion.
const admissions = new Map();
function withAdmission(root, action) {
  const operation = (admissions.get(root) || Promise.resolve()).catch(() => {}).then(() => withFundingFileLock(root, action, { timeoutMs: 30000 }));
  admissions.set(root, operation);
  operation.finally(() => { if (admissions.get(root) === operation) admissions.delete(root); }).catch(() => {});
  return operation;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = file => readFile(file, 'utf8').then(JSON.parse).catch(() => null);
async function lockOwner(directory) {
  try {
    const raw = await readFile(path.join(directory, 'owner.json'), 'utf8');
    const owner = JSON.parse(raw);
    if (!owner || typeof owner !== 'object' || !Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('Unknown lock owner');
    return owner;
  } catch {
    try { await stat(directory); }
    catch (error) { if (error.code === 'ENOENT') return null; }
    return { pid: null, safeToYield: false, ownerStatus: 'unreadable' };
  }
}
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return true; try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

export const RESOURCE_SCOPES = Object.freeze(['planbar-write', 'pipedrive-write', 'outlook-write', 'native-whatsapp', 'browser-read']);
export function resourceLockRoot(root, scope) {
  if (!scope) return root; // Unmigrated callers remain conservatively serialized.
  if (!RESOURCE_SCOPES.includes(scope)) throw new Error(`Unbekannter Ressourcenscope: ${scope}`);
  return path.join(`${root}.resources`, scope);
}
const atomicJson = async (file, value) => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
};
// Priority changes admission only. Even an expired heartbeat cannot revoke a
// living writer; unresolved writes survive process death until target readback.
export async function acquirePriorityLease({ root, priority = 0, jobId = '', title = '', scope = '', criticalSection = '', heartbeatMs = 1000, timeoutMs = 30 * 60_000, pollMs = 100, signal } = {}) {
  const baseRoot = root, admissionRoot = `${root}.admission`;
  root = resourceLockRoot(root, scope);
  const queue = `${root}.queue`, ticket = randomUUID(), file = path.join(queue, `${ticket}.json`);
  const owner = { pid: process.pid, nonce: ticket, jobId, title, scope: scope || 'legacy-ui', priority, createdAt: Date.now(), acquiredAt: null, heartbeat: null, criticalSection: criticalSection || scope || 'legacy-ui', safeToYield: true, activeScope: scope || 'legacy-ui', caseCheckpoint: null };
  await mkdir(queue, { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
  const deadline = Date.now() + timeoutMs;
  let held = false, heartbeatTimer = null;
  const stopHeartbeat = () => { clearInterval(heartbeatTimer); heartbeatTimer = null; };
  const release = async ({ safeToYield } = {}) => {
    if (safeToYield === false || owner.safeToYield === false) throw new Error('Yield erst nach verifiziertem Schreibausgang.');
    stopHeartbeat();
    await withAdmission(admissionRoot, async () => {
      if ((await json(path.join(root, 'owner.json')))?.nonce === ticket) await rm(root, { recursive: true, force: true });
      held = false;
    });
  };
  const acquire = async () => {
    for (;;) {
      signal?.throwIfAborted();
      held = await withAdmission(admissionRoot, async () => {
        signal?.throwIfAborted();
        // During rolling upgrades an old global owner conflicts with every
        // resource. Short admission transactions close the cross-scope race.
        const conflictingRoots = scope ? [baseRoot] : RESOURCE_SCOPES.map(value => resourceLockRoot(baseRoot, value));
        if (scope === 'pipedrive-write') conflictingRoots.push(path.join(path.dirname(baseRoot), 'pipedrive-browser-lock'));
        for (const directory of conflictingRoots) {
          const other = await lockOwner(directory);
          if (other && (alive(other.pid) || other.safeToYield === false)) return false;
        }
        const current = await lockOwner(root);
        if (current && !alive(current.pid) && current.safeToYield !== false) await rm(root, { recursive: true, force: true });
        if (current && (alive(current.pid) || current.safeToYield === false)) return false;
        const waiting = [];
        for (const name of await readdir(queue)) {
          const candidateFile = path.join(queue, name), candidate = await json(candidateFile);
          if (!candidate) continue;
          if (!alive(candidate.pid)) { await rm(candidateFile, { force: true }); continue; }
          waiting.push(candidate);
        }
        waiting.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt || a.nonce.localeCompare(b.nonce));
        if (waiting[0]?.nonce !== ticket) return false;
        try { await mkdir(root, { mode: 0o700 }); }
        catch (e) { if (e.code === 'EEXIST') return false; throw e; }
        owner.acquiredAt = Date.now(); owner.heartbeat = owner.acquiredAt;
        await atomicJson(path.join(root, 'owner.json'), owner);
        await rm(file, { force: true });
        return true;
      });
      if (held) {
        heartbeatTimer = setInterval(() => {
          withAdmission(admissionRoot, async () => {
            if (held && (await json(path.join(root, 'owner.json')))?.nonce === ticket) {
              owner.heartbeat = Date.now(); await atomicJson(path.join(root, 'owner.json'), owner);
            }
          }).catch(() => {});
        }, Math.max(100, heartbeatMs));
        heartbeatTimer.unref();
        return;
      }
      if (Date.now() >= deadline) throw new Error('UI wartet auf eine laufende Aktion; kein paralleler Schreibversuch.');
      await sleep(pollMs);
    }
  };
  try { await acquire(); }
  catch (e) { await rm(file, { force: true }); throw e; }
  return {
    release,
    get owner() { return { ...owner }; },
    async beginCriticalSection({ criticalSection = owner.criticalSection, caseCheckpoint = owner.caseCheckpoint } = {}) {
      await withAdmission(admissionRoot, async () => {
        if (!held || (await json(path.join(root, 'owner.json')))?.nonce !== ticket) throw new Error('Ressourcensperre nicht gehalten.');
        Object.assign(owner, { safeToYield: false, criticalSection, caseCheckpoint, heartbeat: Date.now() });
        await atomicJson(path.join(root, 'owner.json'), owner);
      });
    },
    async checkpoint({ writeOutcomeVerified = false, safeToYield = writeOutcomeVerified, activeScope = owner.activeScope, caseCheckpoint = owner.caseCheckpoint } = {}) {
      if (!safeToYield || !writeOutcomeVerified) throw new Error('Yield erst nach verifiziertem Schreibausgang.');
      await withAdmission(admissionRoot, async () => {
        if (!held || (await json(path.join(root, 'owner.json')))?.nonce !== ticket) throw new Error('Ressourcensperre nicht gehalten.');
        Object.assign(owner, { safeToYield: true, activeScope, caseCheckpoint, heartbeat: Date.now() });
        await atomicJson(path.join(root, 'owner.json'), owner);
      });
      const waiting = await Promise.all((await readdir(queue)).map(name => json(path.join(queue, name))));
      if (!waiting.some(item => item && alive(item.pid) && item.priority > priority)) return false;
      await writeFile(file, JSON.stringify(owner), { mode: 0o600 });
      await release();
      try { await acquire(); } catch (e) { await rm(file, { force: true }); throw e; }
      return true;
    },
  };
}

export async function serveUiCheckpoints(directory, lease, execute) {
  const requestFile = path.join(directory, 'ui-checkpoint.json');
  let active = null, seen = '';
  const timer = setInterval(() => {
    if (active) return;
    active = (async () => {
      const request = await json(requestFile);
      if (!request?.nonce || request.nonce === seen || request.status !== 'requested') return;
      seen = request.nonce;
      const yielded = await lease.checkpoint({ writeOutcomeVerified: request.writeOutcomeVerified === true, safeToYield: request.safeToYield ?? request.writeOutcomeVerified === true, activeScope: request.activeScope, caseCheckpoint: request.caseCheckpoint });
      await writeFile(requestFile, JSON.stringify({ ...request, status: 'resumed', yielded }), { mode: 0o600 });
    })().finally(() => { active = null; });
    active.catch(() => {}); // caller's command retains an unacknowledged request
  }, 100);
  try { return await execute(); }
  finally { clearInterval(timer); if (active) await active; }
}

export async function requestUiCheckpoint(directory, { safeToYield = true, activeScope, caseCheckpoint } = {}) {
  if (!safeToYield) throw new Error('Yield erst nach verifiziertem Schreibausgang.');
  const file = path.join(directory, 'ui-checkpoint.json'), nonce = randomUUID();
  await writeFile(file, JSON.stringify({ nonce, status: 'requested', writeOutcomeVerified: true, safeToYield, activeScope, caseCheckpoint }), { mode: 0o600 });
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const result = await json(file);
    if (result?.nonce === nonce && result.status === 'resumed') return result;
    await sleep(100);
  }
  throw new Error('UI-Checkpoint nicht bestätigt; keine weitere UI-Aktion freigegeben.');
}

// Builds hold no desktop lease during compilation/tests. Their explicit UI
// sections acquire the same lease as operational workflows.
export async function serveBuildUiAccess(directory, withUiLock, execute) {
  const file = path.join(directory, 'ui-access.json');
  let active = null, held = null, unlock = null, heldScope = '', seen = '', closing = false;
  const controller = new AbortController();
  const timer = setInterval(() => {
    if (active || closing) return;
    active = (async () => {
      const request = await json(file);
      if (!request?.nonce || request.nonce === seen || request.status !== 'requested') return;
      seen = request.nonce;
      const requestedScope = request.scope || 'browser-read';
      resourceLockRoot('', requestedScope);
      if (request.action === 'acquire' && held && requestedScope !== heldScope) throw new Error('Vor Scope-Wechsel muss der bisherige Schreibausgang verifiziert freigegeben werden.');
      if (request.action === 'acquire' && !held) {
        let acquired;
        const ready = new Promise(resolve => { acquired = resolve; });
        heldScope = requestedScope;
        held = withUiLock(async lease => {
          if (requestedScope !== 'browser-read') await lease?.beginCriticalSection?.({ criticalSection: request.criticalSection || 'build-ui', caseCheckpoint: request.caseCheckpoint });
          acquired();
          const verifiedRelease = await new Promise(resolve => { unlock = resolve; });
          if (verifiedRelease) await lease?.checkpoint?.({ writeOutcomeVerified: true, safeToYield: true, activeScope: requestedScope, caseCheckpoint: 'explicit-ui-release-readback' });
          else if (requestedScope !== 'browser-read') throw new Error('Schreibausgang unklar; Ressourcensperre bleibt bis zum Ziel-Readback erhalten.');
        }, { signal: controller.signal, scope: requestedScope, criticalSection: request.criticalSection || 'build-ui' });
        held.catch(() => {});
        try { await Promise.race([ready, held]); } catch (error) { held = null; unlock = null; throw error; }
      } else if (request.action === 'release' && held) {
        unlock(true); await held; held = null; unlock = null; heldScope = '';
      }
      await writeFile(file, JSON.stringify({ ...request, status: 'confirmed' }), { mode: 0o600 });
    })().finally(() => { active = null; });
    active.catch(async () => {
      const request = await json(file);
      if (request?.nonce === seen) await writeFile(file, JSON.stringify({ ...request, status: 'failed', error: 'UI-Freigabe nicht erteilt; Sitzung und laufenden Besitzer prüfen.' }), { mode: 0o600 });
    }).catch(() => {});
  }, 100);
  try { return await execute(); }
  finally { closing = true; clearInterval(timer); controller.abort(); if (unlock) unlock(false); if (active) await active.catch(() => {}); if (held) await held.catch(() => {}); }
}

export async function requestBuildUiAccess(directory, action, { scope = 'browser-read', criticalSection = 'build-ui' } = {}) {
  resourceLockRoot('', scope);
  if (!['acquire', 'release'].includes(action)) throw new Error('UI-Zugang: acquire oder release erforderlich.');
  const file = path.join(directory, 'ui-access.json'), nonce = randomUUID();
  await writeFile(file, JSON.stringify({ nonce, action, scope, criticalSection, status: 'requested' }), { mode: 0o600 });
  while (true) {
    const value = await json(file);
    if (value?.nonce === nonce && value.status === 'failed') throw new Error(value.error);
    if (value?.nonce === nonce && value.status === 'confirmed') return value;
    await sleep(100);
  }
}

// Recovery is explicit and conditional on the persisted owner identity. A
// dead ambiguous writer is not an invitation to replay its write.
export async function reconcileResourceLease({ root, scope, nonce, readback, recoveredOwner, ownerSha256 } = {}) {
  if (readback?.verified !== true || !readback.verifiedAt || !readback.reference) throw new Error('Verifizierter Ziel-Readback für Lock-Recovery erforderlich.');
  const directory = resourceLockRoot(root, scope);
  return withAdmission(`${root}.admission`, async () => {
    let owner = await lockOwner(directory);
    if (owner?.ownerStatus === 'unreadable') {
      // Explicit recovery uses a trusted recovered identity plus the exact
      // corrupt bytes. Age alone is never evidence that a writer has stopped.
      const bytes = await readFile(path.join(directory, 'owner.json')).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; });
      if (!ownerSha256 || createHash('sha256').update(bytes).digest('hex') !== ownerSha256
        || !Number.isInteger(recoveredOwner?.pid) || recoveredOwner.pid <= 0 || recoveredOwner.nonce !== nonce
        || recoveredOwner.verified !== true || !recoveredOwner.reference) throw new Error('Unbekannter Lock-Owner: verifizierte Besitzeridentität und Dateifingerprint erforderlich.');
      owner = recoveredOwner;
    }
    if (!owner || owner.nonce !== nonce) return false;
    if (alive(owner.pid)) throw new Error('Lebender Writer darf nicht entfernt werden.');
    await atomicJson(`${directory}.recovery.json`, { nonce, jobId: owner.jobId, scope: owner.scope, reconciledAt: Date.now(), readback, ...(ownerSha256 ? { ownerSha256, recoveredOwner: { pid: owner.pid, reference: recoveredOwner?.reference } } : {}) });
    await rm(directory, { recursive: true, force: true });
    return true;
  });
}
