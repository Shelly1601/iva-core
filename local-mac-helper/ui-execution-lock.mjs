import os from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const defaultRoot = path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper', 'ui-execution-lock');
export function imacUiIsBusy() {
  try { const owner = JSON.parse(readFileSync(path.join(defaultRoot, 'owner.json'), 'utf8')); process.kill(owner.pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export async function withImacExecutionLock(task, options = {}) {
  const { acquirePriorityLease } = await import('./execution-priority.mjs');
  const lease = await acquirePriorityLease({ root: defaultRoot, ...options });
  try { return await task(lease); }
  finally { await lease.release(); }
}
