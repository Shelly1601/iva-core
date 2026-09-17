import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { acquirePriorityLease, reconcileResourceLease, resourceLockRoot, serveBuildUiAccess, requestBuildUiAccess, requestUiCheckpoint } from '../local-mac-helper/execution-priority.mjs';
import { withPipedriveBrowserLock, PIPEDRIVE_BROWSER_LOCK_ROOT } from '../local-mac-helper/pipedrive-browser-lock.mjs';
import { resourceExecutionRoot, imacUiIsBusy, listResourceLocks } from '../local-mac-helper/ui-execution-lock.mjs';
const temp = await mkdtemp(path.join(os.tmpdir(), 'iva-resources-'));
after(() => rm(temp, { recursive: true, force: true }));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('scoped worker serves UI checkpoints under the same owner and yields to urgent waiter', async () => {
  const root = path.join(temp, 'scoped-checkpoint'), directory = path.join(temp, 'scoped-checkpoint-task');
  await mkdir(directory); let heldLease, urgentFinished = false;
  const withLock = async (task, options) => {
    heldLease = await acquirePriorityLease({ root, ...options });
    try { return await task(heldLease); } finally { await heldLease.release(); }
  };
  await serveBuildUiAccess(directory, withLock, async () => {
    const idleCheckpoint = await requestUiCheckpoint(directory); assert.equal(idleCheckpoint.yielded, false);
    await requestBuildUiAccess(directory, 'acquire', { scope: 'planbar-write' });
    const ownerNonce = heldLease.owner.nonce;
    const urgent = acquirePriorityLease({ root, scope: 'planbar-write', priority: 100, pollMs: 5 }).then(async lease => { urgentFinished = true; await lease.release(); });
    await delay(25);
    const checkpoint = await requestUiCheckpoint(directory, { safeToYield: true, caseCheckpoint: 'reservation-readback' });
    assert.equal(checkpoint.yielded, true); assert.equal(urgentFinished, true);
    assert.equal(heldLease.owner.nonce, ownerNonce); assert.equal(heldLease.owner.safeToYield, false);
    await requestBuildUiAccess(directory, 'release'); await urgent;
  });
});

test('old malformed or missing owner remains busy and cannot be stale-evicted', async () => {
  for (const malformed of [true, false]) {
    const root = path.join(temp, `unknown-${malformed}`), scope = 'planbar-write';
    await mkdir(root);
    const raw = '{bad owner';
    if (malformed) await writeFile(path.join(root, 'owner.json'), raw);
    await utimes(root, 1, 1);
    assert.equal(imacUiIsBusy({ root }), true);
    assert.equal(listResourceLocks({ root })[0].ownerStatus, 'unreadable');
    await assert.rejects(acquirePriorityLease({ root, scope, timeoutMs: 30, pollMs: 5 }), /laufende Aktion/);
    await assert.rejects(acquirePriorityLease({ root, timeoutMs: 30, pollMs: 5 }), /laufende Aktion/);
    const readback = { verified: true, verifiedAt: new Date().toISOString(), reference: 'target-readback' };
    await assert.rejects(reconcileResourceLease({ root, nonce: 'restored', readback }), /Besitzeridentität/);
    const ownerSha256 = createHash('sha256').update(malformed ? raw : '').digest('hex');
    await assert.rejects(reconcileResourceLease({ root, nonce: 'restored', readback, ownerSha256,
      recoveredOwner: { pid: process.pid, nonce: 'restored', verified: true, reference: 'trusted-owner-backup' } }), /Lebender Writer/);
    assert.equal(await reconcileResourceLease({ root, nonce: 'restored', readback, ownerSha256,
      recoveredOwner: { pid: 2147483647, nonce: 'restored', verified: true, reference: 'trusted-owner-backup' } }), true);
    assert.equal(imacUiIsBusy({ root }), false);
  }
});

test('dashboard lock metadata is an explicit whitelist without raw owner extras', async () => {
  const root = path.join(temp, 'dashboard'), scope = 'native-whatsapp';
  const directory = resourceLockRoot(root, scope); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'owner.json'), JSON.stringify({ pid: process.pid, jobId: 'job-1', title: 'Send', acquiredAt: 123, heartbeat: 456, criticalSection: 'readback', safeToYield: false, token: 'secret-fixture', customerDocument: 'private-fixture' }));
  const rows = listResourceLocks({ root }); assert.equal(rows.length, 1);
  assert.equal(rows[0].scope, scope); assert.equal(rows[0].jobId, 'job-1'); assert.equal(rows[0].busy, true);
  assert.equal(JSON.stringify(rows).includes('fixture'), false);
});

test('scoped UI access retains ambiguous writer on crash; explicit release confirms readback', async () => {
  const root = path.join(temp, 'ui-crash'), directory = path.join(temp, 'ui-protocol');
  await mkdir(directory);
  let captured;
  const withLock = async (task, options) => {
    captured = await acquirePriorityLease({ root, ...options });
    try { return await task(captured); } finally { await captured.release(); }
  };
  await assert.rejects(serveBuildUiAccess(directory, withLock, async () => {
    await requestBuildUiAccess(directory, 'acquire', { scope: 'pipedrive-write' });
    assert.equal(captured.owner.safeToYield, false);
    await assert.rejects(requestBuildUiAccess(directory, 'acquire', { scope: 'outlook-write' }), /Freigabe/);
    throw new Error('worker-crash');
  }), /worker-crash/);
  const ownerFile = path.join(resourceLockRoot(root, 'pipedrive-write'), 'owner.json');
  assert.equal(JSON.parse(await readFile(ownerFile)).safeToYield, false);
  await assert.rejects(acquirePriorityLease({ root, scope: 'pipedrive-write', timeoutMs: 30, pollMs: 5 }), /laufende Aktion/);
  await captured.checkpoint({ writeOutcomeVerified: true }); await captured.release();
  await serveBuildUiAccess(directory, withLock, async () => {
    await requestBuildUiAccess(directory, 'acquire', { scope: 'pipedrive-write' });
    await requestBuildUiAccess(directory, 'release', { scope: 'pipedrive-write' });
  });
  await assert.rejects(readFile(ownerFile), { code: 'ENOENT' });
});

test('Pipedrive browser and resource clients share exactly the same write lock', async () => {
  assert.equal(PIPEDRIVE_BROWSER_LOCK_ROOT, resourceExecutionRoot);
  const root = path.join(temp, 'pipedrive-wrapper');
  const lease = await acquirePriorityLease({ root, scope: 'pipedrive-write' });
  let executed = false;
  const browser = withPipedriveBrowserLock(async () => { executed = true; }, { root, pollMs: 5 });
  await delay(30); assert.equal(executed, false);
  await lease.release(); await browser; assert.equal(executed, true);
});

test('different scopes overlap, twenty same-scope writers serialize', async () => {
  const root = path.join(temp, 'parallel');
  const planbar = await acquirePriorityLease({ root, scope: 'planbar-write' });
  const outlook = await acquirePriorityLease({ root, scope: 'outlook-write', timeoutMs: 200 });
  await Promise.all([planbar.release(), outlook.release()]);
  let count = 0, maximum = 0;
  await Promise.all(Array.from({ length: 20 }, async (_, index) => {
    const lease = await acquirePriorityLease({ root, scope: 'pipedrive-write', jobId: String(index), pollMs: 5 });
    count++; maximum = Math.max(count, maximum); await delay(5); count--; await lease.release();
  }));
  assert.equal(maximum, 1);
});

test('metadata and heartbeat persist; unsafe writer requires readback before yield', async () => {
  const root = path.join(temp, 'metadata'), scope = 'outlook-write';
  const lease = await acquirePriorityLease({ root, scope, jobId: 'mail-1', title: 'Mail', heartbeatMs: 100 });
  await lease.beginCriticalSection({ criticalSection: 'send-draft', caseCheckpoint: 'draft-1' });
  await delay(140);
  const owner = JSON.parse(await readFile(path.join(resourceLockRoot(root, scope), 'owner.json')));
  assert.equal(owner.jobId, 'mail-1'); assert.equal(owner.title, 'Mail'); assert.equal(owner.scope, scope);
  assert.equal(owner.criticalSection, 'send-draft'); assert.ok(owner.heartbeat > owner.acquiredAt);
  await assert.rejects(lease.release(), /verifiziert/);
  await assert.rejects(lease.checkpoint({ safeToYield: true }), /verifiziert/);
  await lease.checkpoint({ writeOutcomeVerified: true, safeToYield: true, caseCheckpoint: 'sent-readback' });
  await lease.release();
});

test('live legacy writer blocks scoped migration; old heartbeat never evicts writer', async () => {
  const root = path.join(temp, 'legacy'); await mkdir(root);
  await writeFile(path.join(root, 'owner.json'), JSON.stringify({ pid: process.pid, heartbeat: 1, safeToYield: false }));
  await assert.rejects(acquirePriorityLease({ root, scope: 'planbar-write', timeoutMs: 30, pollMs: 5 }), /laufende Aktion/);
});

test('dead ambiguous write requires explicit verified recovery; no blind replay', async () => {
  const root = path.join(temp, 'recovery'), scope = 'pipedrive-write', directory = resourceLockRoot(root, scope);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'owner.json'), JSON.stringify({ pid: 2147483647, nonce: 'old', scope, safeToYield: false }));
  await assert.rejects(acquirePriorityLease({ root, scope, timeoutMs: 30, pollMs: 5 }), /laufende Aktion/);
  await assert.rejects(reconcileResourceLease({ root, scope, nonce: 'old' }), /Readback/);
  assert.equal(await reconcileResourceLease({ root, scope, nonce: 'old', readback: { verified: true, verifiedAt: new Date().toISOString(), reference: 'phase-target-readback' } }), true);
  const next = await acquirePriorityLease({ root, scope, timeoutMs: 100 }); await next.release();
});

test('urgent resource waiter yields only at a verified case boundary', async () => {
  const root = path.join(temp, 'urgent'), scope = 'planbar-write', events = [];
  const low = await acquirePriorityLease({ root, scope, priority: -10 });
  await low.beginCriticalSection({ criticalSection: 'reserve' });
  const urgent = acquirePriorityLease({ root, scope, priority: 100, pollMs: 5 }).then(async lease => { events.push('urgent'); await lease.release(); });
  await delay(20); assert.deepEqual(events, []);
  assert.equal(await low.checkpoint({ writeOutcomeVerified: true, caseCheckpoint: 'reservation-readback' }), true);
  assert.deepEqual(events, ['urgent']); await low.release(); await urgent;
});
