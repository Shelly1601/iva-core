import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {
  DISPLAY_SLEEP_POLICY,
  assessDisplaySleepAfterRun,
  assessPendingDisplayWork,
  isNightHour,
  parseMacInputIdleSeconds,
  requestDisplaySleepAfterRun,
} from '../local-mac-helper/display-sleep-policy.mjs';

assert.equal(DISPLAY_SLEEP_POLICY.minimumIdleSeconds, 60);
assert.equal(DISPLAY_SLEEP_POLICY.maximumSettleSeconds, 60);
assert.equal(DISPLAY_SLEEP_POLICY.activeUserAlwaysProtected, true);
assert.equal(isNightHour(21), false);
assert.equal(isNightHour(22), true);
assert.equal(isNightHour(6), true);
assert.equal(isNightHour(7), false);
assert.equal(parseMacInputIdleSeconds('"HIDIdleTime" = 2500000000'), 2.5);
assert.equal(parseMacInputIdleSeconds('kein Wert'), null);

const calls = [];
let idleSeconds = 0;
let waitedMs = 0;
const idleExec = async (command, args) => {
  calls.push([command, args]);
  if (command === '/usr/sbin/ioreg') return { stdout: `"HIDIdleTime" = ${idleSeconds * 1e9}` };
  assert.equal(command, '/usr/bin/pmset');
  assert.deepEqual(args, ['displaysleepnow']);
  return { stdout: '' };
};
const base = {
  now: new Date(2026, 8, 16, 1, 30), platform: 'darwin', exec: idleExec,
  assessWork: async () => ({ busy: false }),
  wait: async ms => { waitedMs += ms; idleSeconds += ms / 1000; },
};
const result = await requestDisplaySleepAfterRun(base);
assert.equal(result.requested, true);
assert.equal(waitedMs, 60_000);
assert.equal(calls.filter(([command]) => command === '/usr/bin/pmset').length, 1);

calls.length = 0;
waitedMs = 0;
idleSeconds = 0;
const activeUser = await requestDisplaySleepAfterRun({ ...base, wait: async ms => { waitedMs += ms; idleSeconds = 0; } });
assert.equal(activeUser.requested, false);
assert.equal(activeUser.reason, 'user-active');
assert.equal(waitedMs, 60_000);
assert.equal(calls.some(([command]) => command === '/usr/bin/pmset'), false);

calls.length = 0;
const idleDay = await requestDisplaySleepAfterRun({ ...base, now: new Date(2026, 8, 16, 14, 0) });
assert.equal(idleDay.requested, false);
assert.equal(idleDay.reason, 'outside-night-window');
assert.equal(calls.length, 0);

const unknownIdle = await assessDisplaySleepAfterRun({ ...base, exec: async () => ({ stdout: 'HIDIdleTime fehlt' }) });
assert.equal(unknownIdle.allowed, false);
assert.equal(unknownIdle.reason, 'input-idle-unknown');

calls.length = 0;
waitedMs = 0;
const queued = await requestDisplaySleepAfterRun({ ...base, assessWork: async () => ({ busy: true, reason: 'pending-ui-work' }) });
assert.equal(queued.requested, false);
assert.equal(waitedMs, 0, 'Queued work must not wait for a quiet minute');
assert.equal(calls.length, 0);

idleSeconds = 0;
let workChecks = 0;
const arrivedDuringWait = await requestDisplaySleepAfterRun({ ...base,
  assessWork: async () => ({ busy: ++workChecks > 1, reason: 'other-ui-work' }),
});
assert.equal(arrivedDuringWait.requested, false);
assert.equal(arrivedDuringWait.waitedMs, 5000);
assert.equal(calls.some(([command]) => command === '/usr/bin/pmset'), false);

idleSeconds = 120;
workChecks = 0;
const arrivedBeforeRequest = await requestDisplaySleepAfterRun({ ...base,
  assessWork: async () => ({ busy: ++workChecks > 1, reason: 'other-ui-work' }),
});
assert.equal(arrivedBeforeRequest.requested, false, 'Final check catches a newly arrived workflow');
assert.equal(calls.some(([command]) => command === '/usr/bin/pmset'), false);

// Real temporary files, fake process liveness: no inspection/mutation of the live UI lock.
const root = await mkdtemp(path.join(os.tmpdir(), 'iva-display-policy-'));
try {
  const workOptions = { dataRoot: root, wakeRoot: path.join(root, 'wake-guards'), taskRoot: path.join(root, 'codex-tasks'), ownPid: 101,
    processAlive: pid => [101, 202, 303].includes(pid) };
  const put = async (file, data) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(data)); };
  assert.equal((await assessPendingDisplayWork(workOptions)).busy, false);
  const owner = path.join(root, 'ui-execution-lock', 'owner.json');
  await put(owner, { pid: 101 });
  assert.equal((await assessPendingDisplayWork(workOptions)).busy, false, 'Completed own guard still owns its surrounding UI lock');
  await put(owner, { pid: 202 });
  assert.equal((await assessPendingDisplayWork(workOptions)).reason, 'other-ui-work');
  await put(owner, { pid: 101 });
  const lease = path.join(root, 'wake-guards', 'another.json');
  await put(lease, { pid: 202 });
  assert.equal((await assessPendingDisplayWork(workOptions)).reason, 'other-ui-work');
  await rm(lease);
  const task = path.join(root, 'codex-tasks', '11111111-1111-1111-1111-111111111111', 'state.json');
  await put(task, { status: 'queued' });
  assert.equal((await assessPendingDisplayWork(workOptions)).reason, 'pending-ui-work');
  await put(task, { status: 'running', workerPid: 101 });
  assert.equal((await assessPendingDisplayWork(workOptions)).busy, false);
  await put(task, { status: 'running', workerPid: 999, childPid: 303 });
  assert.equal((await assessPendingDisplayWork(workOptions)).reason, 'pending-ui-work', 'Orphaned live child still needs the display');
  await put(task, { status: 'completed', workerPid: 202 });
  assert.equal((await assessPendingDisplayWork(workOptions)).busy, false);
  await writeFile(owner, '{partial');
  assert.equal((await assessPendingDisplayWork(workOptions)).reason, 'work-state-unknown');
} finally { await rm(root, { recursive: true, force: true }); }

// Two independent processes release their last leases at almost the same time.
// Only fakes are spawned: neither caffeinate nor pmset is actually executed.
const concurrentRoot = await mkdtemp(path.join(os.tmpdir(), 'iva-display-coordination-'));
try {
  const moduleUrl = new URL('../local-mac-helper/mac-wake-guard.mjs', import.meta.url).href;
  const worker = `
    import { EventEmitter } from 'node:events';
    import { appendFile } from 'node:fs/promises';
    const { withMacWakeGuard } = await import(${JSON.stringify(moduleUrl)});
    delete process.env.IVA_MAC_WAKE_GUARD_ACTIVE;
    await withMacWakeGuard(async () => new Promise(resolve => setTimeout(resolve, 100)), {
      spawnProcess: () => {
        const child = new EventEmitter(); child.exitCode = null;
        child.kill = () => { child.exitCode = 0; setImmediate(() => child.emit('close', 0)); };
        setImmediate(() => child.emit('spawn')); return child;
      },
      displaySleepOptions: { now: new Date(2026, 8, 16, 1, 30), platform: 'darwin' },
      exec: async command => {
        if (command === '/usr/sbin/ioreg') return { stdout: '\"HIDIdleTime\" = 120000000000' };
        if (command !== '/usr/bin/pmset') throw new Error('Unexpected command');
        await appendFile(process.env.DISPLAY_TEST_LOG, 'sleep\\n'); return { stdout: '' };
      },
      onCleanupWarning: message => { throw new Error(message); },
    });
  `;
  const run = promisify(execFile);
  const env = { ...process.env, IVA_MAC_HELPER_DATA_DIR: concurrentRoot, IVA_MAC_WAKE_ROOT: path.join(concurrentRoot, 'wake-guards'),
    IVA_CODEX_TASK_ROOT: path.join(concurrentRoot, 'codex-tasks'), DISPLAY_TEST_LOG: path.join(concurrentRoot, 'calls') };
  await Promise.all([1, 2].map(() => run(process.execPath, ['--input-type=module', '-e', worker], { env, timeout: 15_000 })));
  assert.equal(await readFile(env.DISPLAY_TEST_LOG, 'utf8'), 'sleep\n', 'Concurrent finishes request display sleep once');
} finally { await rm(concurrentRoot, { recursive: true, force: true }); }

console.log('PASS Display-Schlaf: einmal nach ruhigem Abschluss; aktive/queued Aufträge, aktive Nutzer, Tageszeit und Nachlauf-Rennen geschützt.');
