import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { MAC_SESSION_RECHECK_MS, parseMacSessionLockStatus, readMacSessionLockStatus } from '../local-mac-helper/mac-session-lock.mjs';
import { macWakeGuardPolicy } from '../local-mac-helper/mac-wake-guard.mjs';

const uid = 501;
const registry = (locked, sessions = [{ uid, onConsole: true, login: true }]) => `  "IOConsoleLocked" = ${locked}\n  "IOConsoleUsers" = (${sessions.map(item => `{"kCGSSessionUserIDKey"=${item.uid},"kCGSSessionOnConsoleKey"=${item.onConsole ? 'Yes' : 'No'},"kCGSessionLoginDoneKey"=${item.login ? 'Yes' : 'No'}${item.locked ? ',"CGSSessionScreenIsLocked"=Yes' : ''}}`).join(',')})`;
const unlocked = { usable: true, locked: false, reason: 'console-unlocked' };
const locked = { usable: false, locked: true, reason: 'password-locked' };
assert.deepEqual(parseMacSessionLockStatus(registry('No'), { uid }), unlocked);
assert.deepEqual(parseMacSessionLockStatus(registry('Yes'), { uid }), locked);
assert.equal(parseMacSessionLockStatus('', { uid }).usable, false);
assert.equal(parseMacSessionLockStatus(registry('No', []), { uid }).usable, false);
assert.equal(parseMacSessionLockStatus(registry('No'), { uid: 502 }).reason, 'different-console-user');
assert.equal(parseMacSessionLockStatus(registry('No', [{ uid, onConsole: true, login: false }]), { uid }).usable, false);
assert.equal(parseMacSessionLockStatus(registry('No', [{ uid, onConsole: true, login: true, locked: true }]), { uid }).locked, true);
assert.equal(parseMacSessionLockStatus(registry('No', [{ uid, onConsole: true, login: true }, { uid: 502, onConsole: true, login: true }]), { uid }).usable, false);
assert.equal((await readMacSessionLockStatus({ platform: 'linux', exec: () => { throw new Error('must not execute'); } })).reason, 'unsupported-platform');
assert.equal((await readMacSessionLockStatus({ platform: 'darwin', exec: async () => { throw new Error('secret hidden'); } })).reason, 'session-probe-failed');
assert.deepEqual(await readMacSessionLockStatus({ platform: 'darwin', uid, exec: async (binary, args, options) => {
  assert.equal(binary, '/usr/sbin/ioreg'); assert.deepEqual(args, ['-n', 'Root', '-d1']); assert.equal(options.timeout, 5_000);
  return { stdout: registry('No') };
} }), unlocked);
assert.equal(macWakeGuardPolicy().automaticLockPreventedDuringRun, false);
assert.equal(macWakeGuardPolicy().automaticUnlockAvailable, false);
assert.equal(macWakeGuardPolicy().passwordLockPolicyChanged, false);

const root = await mkdtemp(path.join(os.tmpdir(), 'iva-session-preflight-'));
process.env.IVA_CODEX_TASK_ROOT = root;
const tasks = await import('../local-mac-helper/codex-tasks.mjs');
let workerStarts = 0;
let modelStarts = 0;
let wakeStarts = 0;
let lockStarts = 0;
let session = locked;
const report = async () => true;
const fakeSpawn = () => {
  workerStarts += 1;
  const child = new EventEmitter(); child.unref = () => {};
  queueMicrotask(() => child.emit('spawn')); return child;
};
const options = {
  report, sessionStatus: async () => session,
  withUiLock: async task => { lockStarts += 1; return task(); },
  withWakeGuard: async task => { wakeStarts += 1; return task(); },
  execute: async jobId => { modelStarts += 1; return { jobId, executed: true }; },
};
const readState = async id => JSON.parse(await readFile(path.join(root, id, 'state.json'), 'utf8'));
const newJob = requestId => tasks.startCodexTask({ requestId, prompt: 'Prüfe die Förderunterlagen vollständig.', mode: 'project-workflow', workflowId: 'funding-monitor' }, { report, spawnProcess: fakeSpawn });
try {
  assert.equal(tasks.codexTaskRequiresUi({ mode: 'build' }), false);
  assert.equal(tasks.codexTaskRequiresUi({ mode: 'operational', requiresUi: false }), true, 'untrusted request cannot bypass');
  assert.equal(tasks.codexTaskRequiresUi({ mode: 'project-workflow', workflowId: 'funding-monitor', requiresUi: false }), true);
  assert.equal(tasks.codexTaskRequiresUi({ mode: 'project-workflow', workflowId: 'api-only' }, { 'api-only': { requiresUi: false } }), false, 'trusted workflow config can opt out');
  const job = await newJob('locked-test');
  const before = await readState(job.jobId);
  const deferred = await tasks.runCodexTask(job.jobId, options);
  assert.equal(deferred.phase, 'waiting_for_unlock');
  assert.equal(modelStarts, 0); assert.equal(wakeStarts, 0); assert.equal(lockStarts, 0);
  const waiting = await readState(job.jobId);
  assert.equal(waiting.status, 'queued'); assert.equal(waiting.workerPid, null);
  assert.equal(waiting.launchAttempts, before.launchAttempts); assert.equal(waiting.recoveryAttempts || 0, 0);
  const persistedRequest = await readFile(path.join(root, job.jobId, 'request.json'), 'utf8');
  const progress = { reservation: { appointmentId: 'existing-slot', verified: true } };
  await writeFile(path.join(root, job.jobId, 'planbar-progress.json'), JSON.stringify(progress));
  const probeAt = Date.parse(waiting.nextAttemptAt) + 1;
  let launches = 0;
  const launch = async request => { launches += 1; assert.equal(request.jobId, job.jobId); await tasks.runCodexTask(request.jobId, options); };
  await tasks.syncCodexTaskStates({ force: true, now: probeAt, report, launch, sessionStatus: async () => locked, processAlive: () => false });
  assert.equal(launches, 0); assert.equal(modelStarts, 0);
  assert.equal((await readState(job.jobId)).updatedAt, waiting.updatedAt, 'unchanged wait does not produce status noise');
  await tasks.syncCodexTaskStates({ force: true, now: probeAt + MAC_SESSION_RECHECK_MS + 1, report, launch,
    sessionStatus: async () => ({ usable: false, locked: null, reason: 'session-probe-failed' }), processAlive: () => false });
  assert.equal(launches, 0); assert.equal(workerStarts, 1);
  session = unlocked;
  await tasks.syncCodexTaskStates({ force: true, now: probeAt + MAC_SESSION_RECHECK_MS * 2 + 2, report, launch, sessionStatus: async () => unlocked });
  assert.equal(launches, 1); assert.equal(modelStarts, 1);
  assert.equal(await readFile(path.join(root, job.jobId, 'request.json'), 'utf8'), persistedRequest);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, job.jobId, 'planbar-progress.json'), 'utf8')), progress);
  assert.equal((await tasks.runCodexTask(job.jobId, options)).duplicate, true, 'existing execution claim prevents duplicate effects');
  assert.equal(modelStarts, 1);

  const raceJob = await newJob('lock-during-ui-queue');
  // This fixture exercises the retained legacy lease; protocol 2 rechecks at each explicit UI acquire.
  const raceRequestPath = path.join(root, raceJob.jobId, 'request.json');
  const raceRequest = JSON.parse(await readFile(raceRequestPath, 'utf8'));
  await writeFile(raceRequestPath, JSON.stringify({ ...raceRequest, resourceProtocol: 1 }));
  const raced = await tasks.runCodexTask(raceJob.jobId, { ...options, withUiLock: async task => { session = locked; return task(); } });
  assert.equal(raced.phase, 'waiting_for_unlock'); assert.equal(modelStarts, 1); assert.equal(wakeStarts, 1);
  const unknownJob = await newJob('unknown-session-state');
  const unknownWait = await tasks.runCodexTask(unknownJob.jobId, { ...options,
    sessionStatus: async () => ({ usable: false, locked: null, reason: 'session-probe-failed' }) });
  assert.equal(unknownWait.phase, 'waiting_for_unlock'); assert.equal(modelStarts, 1);
  const unknownState = await readState(unknownJob.jobId);
  // A crash after parking and before archiving leaves a claim: a live owner must
  // still be protected, then the dead claim may be retired before same-job resume.
  await writeFile(path.join(root, unknownJob.jobId, 'execution-claim.json'), JSON.stringify({ pid: process.pid }));
  let claimLaunches = 0;
  const claimLaunch = async request => {
    if (request.jobId === unknownJob.jobId) claimLaunches += 1;
  };
  const claimNow = Date.parse(unknownState.nextAttemptAt) + 1;
  await tasks.syncCodexTaskStates({ force: true, now: claimNow, report, launch: claimLaunch,
    processAlive: pid => pid === process.pid, sessionStatus: async () => unlocked });
  assert.equal(claimLaunches, 0, 'live claim preserved');
  await tasks.syncCodexTaskStates({ force: true, now: claimNow + 1, report, launch: claimLaunch,
    processAlive: () => false, sessionStatus: async () => unlocked });
  assert.equal(claimLaunches, 1, 'dead preflight claim safely resumes');
  // A newer old-worker heartbeat must not resurrect a parked task's child PID.
  await writeFile(path.join(root, raceJob.jobId, 'heartbeat.json'), JSON.stringify({ heartbeatAt: new Date(Date.now() + 60_000).toISOString(), workerPid: 12345, childPid: 67890 }));
  assert.equal((await tasks.getCodexTaskStatus(raceJob.jobId)).workerPid, null);
  // Deterministic interleaving: sync has read a parked task and waits for ioreg;
  // meanwhile a manual re-delivery claims and starts it. Both locked and unlocked
  // probe results must preserve the newer worker and its business/child receipt.
  for (const probeResult of [locked, unlocked]) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, 'state.json');
      const state = JSON.parse(await readFile(file, 'utf8'));
      await writeFile(file, JSON.stringify({ ...state, status: 'completed' }));
    }
    const interleavedJob = await newJob(`interleave-${probeResult.reason}`);
    session = locked;
    await tasks.runCodexTask(interleavedJob.jobId, options);
    const parked = await readState(interleavedJob.jobId);
    let enteredProbe;
    let finishProbe;
    const probeEntered = new Promise(resolve => { enteredProbe = resolve; });
    const probeReply = new Promise(resolve => { finishProbe = resolve; });
    const sync = tasks.syncCodexTaskStates({ force: true, now: Date.parse(parked.nextAttemptAt) + 1,
      report, processAlive: pid => pid === process.pid,
      launch: async () => { throw new Error('A live worker must not be relaunched'); },
      sessionStatus: async () => { enteredProbe(); return probeReply; },
    });
    await probeEntered;
    session = unlocked;
    const execution = await tasks.runCodexTask(interleavedJob.jobId, { ...options,
      execute: async jobId => {
        const state = await readState(jobId);
        const next = { ...state, status: 'running', phase: 'executing', childPid: process.pid,
          businessReceipt: { actionId: 'already-submitted', verified: true } };
        await writeFile(path.join(root, jobId, 'state.json'), JSON.stringify(next));
        return next;
      },
    });
    finishProbe(probeResult);
    await sync;
    const preserved = await readState(interleavedJob.jobId);
    assert.equal(preserved.status, 'running'); assert.equal(preserved.phase, 'executing');
    assert.equal(preserved.workerPid, process.pid); assert.equal(preserved.childPid, process.pid);
    assert.deepEqual(preserved.businessReceipt, execution.businessReceipt);
  }
  console.log('macOS session preflight verified: locked/unknown waits, no model retries, same-job resume, queue race, interleaved manual claim, receipt preservation, duplicate protection, honest wake capability.');
} finally {
  await rm(root, { recursive: true, force: true });
}
