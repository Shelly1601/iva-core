import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { DISPLAY_SLEEP_POLICY, requestDisplaySleepAfterRun } from './display-sleep-policy.mjs';

const execFileAsync = promisify(execFile);
const WAKE_ROOT = process.env.IVA_MAC_WAKE_ROOT || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper', 'wake-guards');
const RELEASE_LOCK = path.join(WAKE_ROOT, '.release-lock');
const DISPLAY_SLEPT = path.join(WAKE_ROOT, '.display-slept');

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

async function createWakeLease() {
  await mkdir(WAKE_ROOT, { recursive: true, mode: 0o700 });
  const id = crypto.randomUUID();
  const file = path.join(WAKE_ROOT, `${id}.json`);
  if (!await acquireReleaseLock()) throw new Error('Display-Koordination ist noch belegt.');
  try {
    await writeFile(file, `${JSON.stringify({ id, pid: process.pid, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    await unlink(DISPLAY_SLEPT).catch(error => { if (error.code !== 'ENOENT') throw error; });
  } finally { await rmdir(RELEASE_LOCK).catch(() => {}); }
  return file;
}

async function acquireReleaseLock() {
  // The final ioreg + pmset check has two bounded 10-second calls. A newly
  // arriving task must be allowed to wait for it rather than fail after 4 seconds.
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      await mkdir(RELEASE_LOCK, { mode: 0o700 });
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const age = Date.now() - Number((await stat(RELEASE_LOCK).catch(() => null))?.mtimeMs || Date.now());
      if (age > 30_000) await rmdir(RELEASE_LOCK).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  return false;
}

async function activeWakeLeases() {
  const entries = await readdir(WAKE_ROOT, { withFileTypes: true }).catch(error => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  const active = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(WAKE_ROOT, entry.name);
    const lease = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
    if (lease && processIsAlive(Number(lease.pid))) active.push(lease);
    else await unlink(file).catch(() => {});
  }
  return active;
}

async function releaseWakeLease(file, { sleepDisplays, exec, displaySleepOptions, onDisplaySleepDecision }) {
  const locked = await acquireReleaseLock();
  if (!locked) return;
  try {
    await unlink(file).catch(() => {});
  } finally {
    await rmdir(RELEASE_LOCK).catch(() => {});
  }
  // Release the mutex first, so a just-started child can actually register its
  // lease during this handoff interval.
  await new Promise(resolve => setTimeout(resolve, 700));
  if (!sleepDisplays) return;
  const decision = await requestDisplaySleepAfterRun({
    ...displaySleepOptions,
    exec,
    finalize: async action => {
      if (!await acquireReleaseLock()) return { requested: false, reason: 'display-coordinator-busy' };
      try {
        if ((await activeWakeLeases()).length) return { requested: false, reason: 'other-ui-work' };
        if (await stat(DISPLAY_SLEPT).catch(() => null)) return { requested: false, reason: 'already-requested' };
        const result = await action();
        if (result.requested) await writeFile(DISPLAY_SLEPT, `${new Date().toISOString()}\n`, { mode: 0o600 });
        return result;
      } finally { await rmdir(RELEASE_LOCK).catch(() => {}); }
    },
  });
  onDisplaySleepDecision(decision);
}

function closeResult(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([closeResult(child).catch(() => null), new Promise(resolve => setTimeout(resolve, 1_500))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

export async function withMacWakeGuard(task, {
  maxSeconds = 180,
  spawnProcess = spawn,
  exec = execFileAsync,
  sleepDisplays = true,
  displaySleepOptions = {},
  onCleanupWarning = message => console.warn(message),
  onDisplaySleepDecision = () => {},
} = {}) {
  if (typeof task !== 'function') throw new Error('Mac-Wachschutz benötigt einen lokalen Arbeitslauf.');
  if (process.env.IVA_MAC_WAKE_GUARD_ACTIVE === '1') return task();
  void Math.max(30, Math.min(14_400, Number(maxSeconds) || 180));
  const leaseFile = await createWakeLease();
  const wakeLock = spawnProcess('/usr/bin/caffeinate', ['-dimsu', '-w', String(process.pid)], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    wakeLock.once('spawn', resolve);
    wakeLock.once('error', reject);
  }).catch(async error => {
    await unlink(leaseFile).catch(() => {});
    throw new Error(`Wachschutz konnte nicht gestartet werden: ${error.message}`);
  });
  const previousGuard = process.env.IVA_MAC_WAKE_GUARD_ACTIVE;
  process.env.IVA_MAC_WAKE_GUARD_ACTIVE = '1';
  try {
    return await task();
  } finally {
    if (previousGuard === undefined) delete process.env.IVA_MAC_WAKE_GUARD_ACTIVE;
    else process.env.IVA_MAC_WAKE_GUARD_ACTIVE = previousGuard;
    // Aufräumen darf weder ein Geschäftsergebnis noch den ursprünglichen Fehler
    // ersetzen. Insbesondere ist ein pmset-Fehler kein Grund für eine Neuanlage.
    await stopProcess(wakeLock).catch(error => {
      try { onCleanupWarning(`IVA-Wachschutz: ${error.message}`); } catch {}
    });
    await releaseWakeLease(leaseFile, { sleepDisplays, exec, displaySleepOptions, onDisplaySleepDecision })
      .catch(error => { try { onCleanupWarning(`Display konnte nach dem IVA-Lauf nicht sauber freigegeben werden: ${error.message}`); } catch {} });
  }
}

export function macWakeGuardPolicy() {
  return Object.freeze({
    idleSleepPrevented: true,
    displaySleepPreventedDuringRun: true,
    automaticLockPreventedDuringRun: true,
    displaySleepAfterRun: true,
    displaySleepRequiresUnattendedNight: true,
    displaySleepMinimumIdleSeconds: DISPLAY_SLEEP_POLICY.minimumIdleSeconds,
    activeUserAlwaysProtected: true,
    daytimeForcedDisplaySleep: false,
    sharedRunLeases: true,
    displaySleepOnlyAfterLastRun: true,
    nestedGuardEnvironment: 'IVA_MAC_WAKE_GUARD_ACTIVE=1',
  });
}
