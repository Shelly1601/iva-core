import os from 'node:os';
import path from 'node:path';
import { withImacExecutionLock } from './ui-execution-lock.mjs';

export const PIPEDRIVE_BROWSER_LOCK_ROOT = path.join(
  process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper'),
  'pipedrive-browser-lock',
);

export function withPipedriveBrowserLock(task, {
  root = PIPEDRIVE_BROWSER_LOCK_ROOT,
  timeoutMs = 30 * 60_000,
  pollMs = 250,
} = {}) {
  return withImacExecutionLock(task, { root, timeoutMs, pollMs });
}
