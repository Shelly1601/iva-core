import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

export const DISPLAY_SLEEP_POLICY = Object.freeze({
  minimumIdleSeconds: 60,
  maximumSettleSeconds: 60,
  nightStartHour: 22,
  nightEndHour: 7,
  timezone: 'local-Mac Mini-time',
  activeUserAlwaysProtected: true,
  sleepWhenIdleDuringDay: false,
});

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// Read only: never remove a live lease or another workflow's execution lock.
export async function assessPendingDisplayWork({
  dataRoot = process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper'),
  wakeRoot = process.env.IVA_MAC_WAKE_ROOT || path.join(dataRoot, 'wake-guards'),
  taskRoot = process.env.IVA_CODEX_TASK_ROOT || path.join(dataRoot, 'codex-tasks'),
  ownPid = process.pid,
  processAlive = processIsAlive,
} = {}) {
  const json = async file => JSON.parse(await readFile(file, 'utf8'));
  const list = async root => readdir(root, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  try {
    const lockRoot = path.join(dataRoot, 'ui-execution-lock');
    const owner = await json(path.join(lockRoot, 'owner.json')).catch(async error => {
      if (error.code === 'ENOENT' && !await stat(lockRoot).catch(() => null)) return null;
      throw error;
    });
    if (owner && Number(owner.pid) !== ownPid && processAlive(Number(owner.pid))) return { busy: true, reason: 'other-ui-work' };
    for (const entry of await list(wakeRoot)) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'display-sleep.json') continue;
      const lease = await json(path.join(wakeRoot, entry.name)).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (lease && Number(lease.pid) !== ownPid && processAlive(Number(lease.pid))) return { busy: true, reason: 'other-ui-work' };
    }
    for (const entry of await list(taskRoot)) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{20,80}$/i.test(entry.name)) continue;
      const task = await json(path.join(taskRoot, entry.name, 'state.json')).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (task?.status === 'queued' || (task?.status === 'running' && Number(task.workerPid) !== ownPid
        && (processAlive(Number(task.workerPid)) || processAlive(Number(task.childPid))))) {
        return { busy: true, reason: 'pending-ui-work' };
      }
    }
    return { busy: false, reason: 'no-pending-ui-work' };
  } catch {
    return { busy: true, reason: 'work-state-unknown' };
  }
}

function boundedHour(value, fallback) {
  const hour = Number(value);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : fallback;
}

export function isNightHour(hour, {
  nightStartHour = DISPLAY_SLEEP_POLICY.nightStartHour,
  nightEndHour = DISPLAY_SLEEP_POLICY.nightEndHour,
} = {}) {
  const current = boundedHour(hour, -1);
  const start = boundedHour(nightStartHour, DISPLAY_SLEEP_POLICY.nightStartHour);
  const end = boundedHour(nightEndHour, DISPLAY_SLEEP_POLICY.nightEndHour);
  if (current < 0 || start === end) return false;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function parseMacInputIdleSeconds(output) {
  const match = String(output || '').match(/"HIDIdleTime"\s*=\s*(\d+)/);
  if (!match) return null;
  const nanoseconds = Number(match[1]);
  return Number.isFinite(nanoseconds) && nanoseconds >= 0 ? nanoseconds / 1_000_000_000 : null;
}

export async function assessDisplaySleepAfterRun({
  now = new Date(),
  exec = execFileAsync,
  platform = process.platform,
  minimumIdleSeconds = DISPLAY_SLEEP_POLICY.minimumIdleSeconds,
  nightStartHour = DISPLAY_SLEEP_POLICY.nightStartHour,
  nightEndHour = DISPLAY_SLEEP_POLICY.nightEndHour,
  assessWork = assessPendingDisplayWork,
} = {}) {
  const localHour = now instanceof Date && Number.isFinite(now.getTime()) ? now.getHours() : new Date().getHours();
  if (!isNightHour(localHour, { nightStartHour, nightEndHour })) {
    return { allowed: false, reason: 'outside-night-window', localHour, idleSeconds: null };
  }
  if (platform !== 'darwin') {
    return { allowed: false, reason: 'unsupported-platform', localHour, idleSeconds: null };
  }
  const work = await assessWork();
  if (work.busy) return { allowed: false, reason: work.reason, localHour, idleSeconds: null };

  let stdout = '';
  try {
    ({ stdout } = await exec('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeout: 10_000, maxBuffer: 256 * 1024 }));
  } catch {
    return { allowed: false, reason: 'input-idle-check-failed', localHour, idleSeconds: null };
  }
  const idleSeconds = parseMacInputIdleSeconds(stdout);
  if (idleSeconds == null) {
    return { allowed: false, reason: 'input-idle-unknown', localHour, idleSeconds: null };
  }
  const requiredIdleSeconds = Math.max(60, Number(minimumIdleSeconds) || DISPLAY_SLEEP_POLICY.minimumIdleSeconds);
  if (idleSeconds < requiredIdleSeconds) {
    return { allowed: false, reason: 'user-active', localHour, idleSeconds, requiredIdleSeconds };
  }
  return { allowed: true, reason: 'unattended-night-run', localHour, idleSeconds, requiredIdleSeconds };
}

export async function requestDisplaySleepAfterRun(options = {}) {
  const exec = options.exec || execFileAsync;
  const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const maximumWaitMs = Math.max(0, Math.min(60_000, Number(options.maximumWaitMs ?? DISPLAY_SLEEP_POLICY.maximumSettleSeconds * 1000)));
  let waitedMs = 0;
  let decision = await assessDisplaySleepAfterRun({ ...options, exec });
  while (!decision.allowed && decision.reason === 'user-active' && waitedMs < maximumWaitMs) {
    const delay = Math.min(5000, maximumWaitMs - waitedMs);
    await wait(delay);
    waitedMs += delay;
    decision = await assessDisplaySleepAfterRun({ ...options, exec });
  }
  if (!decision.allowed) return { ...decision, requested: false, waitedMs };
  // A new workflow may have arrived during the quiet interval. The wake guard
  // serializes this last check with new wake leases, and deduplicates this idle period.
  const finalize = options.finalize || (action => action());
  return finalize(async () => {
    decision = await assessDisplaySleepAfterRun({ ...options, exec });
    if (!decision.allowed) return { ...decision, requested: false, waitedMs };
    await exec('/usr/bin/pmset', ['displaysleepnow'], { timeout: 10_000, maxBuffer: 64 * 1024 });
    return { ...decision, requested: true, waitedMs };
  });
}
