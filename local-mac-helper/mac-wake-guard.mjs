import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
} = {}) {
  if (typeof task !== 'function') throw new Error('Mac-Wachschutz benötigt einen lokalen Arbeitslauf.');
  if (process.env.IVA_MAC_WAKE_GUARD_ACTIVE === '1') return task();
  const seconds = Math.max(30, Math.min(1200, Number(maxSeconds) || 180));
  const wakeLock = spawnProcess('/usr/bin/caffeinate', ['-dimsu', '-t', String(seconds + 10)], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    wakeLock.once('spawn', resolve);
    wakeLock.once('error', reject);
  }).catch(error => { throw new Error(`Wachschutz konnte nicht gestartet werden: ${error.message}`); });
  const previousGuard = process.env.IVA_MAC_WAKE_GUARD_ACTIVE;
  process.env.IVA_MAC_WAKE_GUARD_ACTIVE = '1';
  try {
    return await task();
  } finally {
    if (previousGuard === undefined) delete process.env.IVA_MAC_WAKE_GUARD_ACTIVE;
    else process.env.IVA_MAC_WAKE_GUARD_ACTIVE = previousGuard;
    await stopProcess(wakeLock);
    if (sleepDisplays) {
      await exec('/usr/bin/pmset', ['displaysleepnow'], { timeout: 10_000, maxBuffer: 64 * 1024 })
        .catch(error => { throw new Error(`Display konnte nach dem IVA-Lauf nicht ausgeschaltet werden: ${error.message}`); });
    }
  }
}

export function macWakeGuardPolicy() {
  return Object.freeze({
    idleSleepPrevented: true,
    displaySleepPreventedDuringRun: true,
    automaticLockPreventedDuringRun: true,
    displaySleepAfterRun: true,
    nestedGuardEnvironment: 'IVA_MAC_WAKE_GUARD_ACTIVE=1',
  });
}
