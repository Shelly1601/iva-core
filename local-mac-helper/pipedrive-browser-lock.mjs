import { withImacExecutionLock, resourceExecutionRoot } from './ui-execution-lock.mjs';

export const PIPEDRIVE_BROWSER_LOCK_ROOT = resourceExecutionRoot;

export function withPipedriveBrowserLock(task, {
  root = PIPEDRIVE_BROWSER_LOCK_ROOT,
  timeoutMs = 30 * 60_000,
  pollMs = 250,
} = {}) {
  return withImacExecutionLock(task, { root, timeoutMs, pollMs, scope: 'pipedrive-write', criticalSection: 'pipedrive-browser' });
}
