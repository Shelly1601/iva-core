import { spawn } from 'node:child_process';
import { assessPendingDisplayWork } from './display-sleep-policy.mjs';
import { readMacSessionLockStatus } from './mac-session-lock.mjs';

// Keep protection across worker exits, retries and queue handoffs. This is a
// power assertion, never an unlock mechanism or a change to password policy.
export function createQueueWakeGuard({
  assessWork = assessPendingDisplayWork,
  sessionStatus = readMacSessionLockStatus,
  spawnProcess = spawn,
  now = Date.now,
  pid = process.pid,
  idleGraceMs = 120_000,
  pulseEveryMs = 30_000,
  onStatus = async () => {},
} = {}) {
  let display = null, activity = null, lastWorkAt = null, lastPulseAt = null, busy = false;
  const alive = child => child && child.exitCode === null && child.signalCode == null && !child.killed;
  async function launch(args) {
    const child = spawnProcess('/usr/bin/caffeinate', args, { stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.on('error', () => {});
    child.unref?.();
    return child;
  }
  function stopChild(child) { if (alive(child)) child.kill('SIGTERM'); }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const work = await assessWork();
      const at = now();
      if (work.busy) lastWorkAt = at;
      const required = work.busy || lastWorkAt !== null && at - lastWorkAt < idleGraceMs;
      if (!required) {
        stopChild(display); stopChild(activity); display = activity = null; lastPulseAt = null;
        const result = { protected: false, reason: 'no-pending-work' };
        await onStatus(result); return result;
      }
      if (!alive(display)) display = await launch(['-di', '-w', String(pid)]);
      const session = await sessionStatus();
      if (session.usable && (!alive(activity) || lastPulseAt === null || at - lastPulseAt >= pulseEveryMs)) {
        // Explicit lifetime avoids caffeinate -u's five-second default.
        // A replacement is acquired before releasing the previous assertion.
        const replacement = await launch(['-u', '-t', '120']);
        stopChild(activity); activity = replacement; lastPulseAt = at;
      }
      const result = { protected: alive(display), userActivityProtected: session.usable && alive(activity),
        sessionLocked: session.locked, unlockAvailable: false, reason: work.busy ? work.reason : 'worker-handoff-grace' };
      await onStatus(result); return result;
    } finally { busy = false; }
  }
  return { tick, stop() { stopChild(display); stopChild(activity); display = activity = null; } };
}
