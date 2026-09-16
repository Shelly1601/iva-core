import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const MAC_SESSION_RECHECK_MS = 30_000;

// IOConsoleLocked is an OS state, unlike display power or an open app window.
// Never return the raw registry: it contains console-user names and identifiers.
export function parseMacSessionLockStatus(output, { uid = process.getuid?.() } = {}) {
  const text = String(output || '');
  const locked = text.match(/^\s*"IOConsoleLocked"\s*=\s*(Yes|No)\s*$/m)?.[1];
  if (locked === 'Yes') return { usable: false, locked: true, reason: 'password-locked' };
  if (locked !== 'No') return { usable: false, locked: null, reason: 'session-state-unknown' };
  const users = text.match(/^\s*"IOConsoleUsers"\s*=\s*\((.*)\)\s*$/m)?.[1];
  const sessions = users?.match(/\{[^{}]*\}/g) || [];
  const active = sessions.filter(item => /"kCGSSessionOnConsoleKey"\s*=\s*Yes\b/.test(item));
  if (active.length !== 1) return { usable: false, locked: null, reason: 'console-session-unavailable' };
  const sessionUid = Number(active[0].match(/"kCGSSessionUserIDKey"\s*=\s*(\d+)/)?.[1]);
  if (!Number.isInteger(uid) || sessionUid !== uid) return { usable: false, locked: null, reason: 'different-console-user' };
  if (!/"kCGSessionLoginDoneKey"\s*=\s*Yes\b/.test(active[0])) return { usable: false, locked: null, reason: 'console-login-incomplete' };
  if (/"CGSSessionScreenIsLocked"\s*=\s*Yes\b/.test(active[0])) return { usable: false, locked: true, reason: 'password-locked' };
  return { usable: true, locked: false, reason: 'console-unlocked' };
}

export async function readMacSessionLockStatus({ exec = execFileAsync, platform = process.platform, uid = process.getuid?.() } = {}) {
  if (platform !== 'darwin') return { usable: false, locked: null, reason: 'unsupported-platform' };
  try {
    const result = await exec('/usr/sbin/ioreg', ['-n', 'Root', '-d1'], { timeout: 5_000, maxBuffer: 2 * 1024 * 1024 });
    return parseMacSessionLockStatus(result.stdout, { uid });
  } catch {
    return { usable: false, locked: null, reason: 'session-probe-failed' };
  }
}
