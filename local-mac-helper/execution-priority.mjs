import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withFundingFileLock } from './funding-intake-state.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = file => readFile(file, 'utf8').then(JSON.parse).catch(() => null);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

// All contenders use the existing desktop lock: legacy live owners are never
// preempted. Priority only changes admission, never interrupts a UI write.
export async function acquirePriorityLease({ root, priority = 0, jobId = '', timeoutMs = 43200000, pollMs = 100, signal } = {}) {
  const queue = `${root}.queue`, ticket = randomUUID(), file = path.join(queue, `${ticket}.json`);
  const owner = { pid: process.pid, nonce: ticket, jobId, priority, createdAt: Date.now() };
  await mkdir(queue, { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
  const deadline = Date.now() + timeoutMs;
  let held = false;
  const release = async () => {
    await withFundingFileLock(`${root}.admission`, async () => {
      if ((await json(path.join(root, 'owner.json')))?.nonce === ticket) await rm(root, { recursive: true, force: true });
      held = false;
    });
  };
  const acquire = async () => {
    for (;;) {
      signal?.throwIfAborted();
      held = await withFundingFileLock(`${root}.admission`, async () => {
        const current = await json(path.join(root, 'owner.json'));
        const emptyAge = !current ? Date.now() - (await stat(root).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs : 0;
        if ((!current && emptyAge > 10000) || (current && !alive(current.pid))) await rm(root, { recursive: true, force: true });
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
        await writeFile(path.join(root, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
        await rm(file, { force: true });
        return true;
      });
      if (held) return;
      if (Date.now() >= deadline) throw new Error('UI wartet auf eine laufende Aktion; kein paralleler Schreibversuch.');
      await sleep(pollMs);
    }
  };
  try { await acquire(); }
  catch (e) { await rm(file, { force: true }); throw e; }
  return {
    release,
    async checkpoint({ writeOutcomeVerified = false } = {}) {
      if (!writeOutcomeVerified) throw new Error('Yield erst nach verifiziertem Schreibausgang.');
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
      const yielded = await lease.checkpoint({ writeOutcomeVerified: request.writeOutcomeVerified === true });
      await writeFile(requestFile, JSON.stringify({ ...request, status: 'resumed', yielded }), { mode: 0o600 });
    })().finally(() => { active = null; });
    active.catch(() => {}); // caller's command retains an unacknowledged request
  }, 100);
  try { return await execute(); }
  finally { clearInterval(timer); if (active) await active; }
}

export async function requestUiCheckpoint(directory) {
  const file = path.join(directory, 'ui-checkpoint.json'), nonce = randomUUID();
  await writeFile(file, JSON.stringify({ nonce, status: 'requested', writeOutcomeVerified: true }), { mode: 0o600 });
  const deadline = Date.now() + 43200000;
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
  let active = null, held = null, unlock = null, seen = '', closing = false;
  const controller = new AbortController();
  const timer = setInterval(() => {
    if (active || closing) return;
    active = (async () => {
      const request = await json(file);
      if (!request?.nonce || request.nonce === seen || request.status !== 'requested') return;
      seen = request.nonce;
      if (request.action === 'acquire' && !held) {
        let acquired;
        const ready = new Promise(resolve => { acquired = resolve; });
        held = withUiLock(async () => { acquired(); await new Promise(resolve => { unlock = resolve; }); }, { signal: controller.signal });
        try { await Promise.race([ready, held]); } catch (error) { held = null; unlock = null; throw error; }
      } else if (request.action === 'release' && held) {
        unlock(); await held; held = null; unlock = null;
      }
      await writeFile(file, JSON.stringify({ ...request, status: 'confirmed' }), { mode: 0o600 });
    })().finally(() => { active = null; });
    active.catch(async () => {
      const request = await json(file);
      if (request?.nonce === seen) await writeFile(file, JSON.stringify({ ...request, status: 'failed', error: 'UI-Freigabe nicht erteilt; Sitzung und laufenden Besitzer prüfen.' }), { mode: 0o600 });
    }).catch(() => {});
  }, 100);
  try { return await execute(); }
  finally { closing = true; clearInterval(timer); controller.abort(); if (unlock) unlock(); if (active) await active.catch(() => {}); if (held) await held.catch(() => {}); }
}

export async function requestBuildUiAccess(directory, action) {
  if (!['acquire', 'release'].includes(action)) throw new Error('UI-Zugang: acquire oder release erforderlich.');
  const file = path.join(directory, 'ui-access.json'), nonce = randomUUID();
  await writeFile(file, JSON.stringify({ nonce, action, status: 'requested' }), { mode: 0o600 });
  while (true) {
    const value = await json(file);
    if (value?.nonce === nonce && value.status === 'failed') throw new Error(value.error);
    if (value?.nonce === nonce && value.status === 'confirmed') return value;
    await sleep(100);
  }
}
