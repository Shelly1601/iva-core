import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DISPLAY_SLEEP_POLICY = Object.freeze({
  minimumIdleSeconds: 60 * 60,
  nightStartHour: 22,
  nightEndHour: 7,
  timezone: 'local-iMac-time',
  activeUserAlwaysProtected: true,
  sleepWhenIdleDuringDay: false,
});

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
} = {}) {
  const localHour = now instanceof Date && Number.isFinite(now.getTime()) ? now.getHours() : new Date().getHours();
  if (!isNightHour(localHour, { nightStartHour, nightEndHour })) {
    return { allowed: false, reason: 'outside-night-window', localHour, idleSeconds: null };
  }
  if (platform !== 'darwin') {
    return { allowed: false, reason: 'unsupported-platform', localHour, idleSeconds: null };
  }

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
  const decision = await assessDisplaySleepAfterRun({ ...options, exec });
  if (!decision.allowed) return { ...decision, requested: false };
  await exec('/usr/bin/pmset', ['displaysleepnow'], { timeout: 10_000, maxBuffer: 64 * 1024 });
  return { ...decision, requested: true };
}
