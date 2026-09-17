import os from 'node:os';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { RESOURCE_SCOPES, resourceLockRoot } from './execution-priority.mjs';

const defaultRoot = path.join(process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper'), 'ui-execution-lock');
function readOwner(directory) {
  try {
    const owner = JSON.parse(readFileSync(path.join(directory, 'owner.json'), 'utf8'));
    if (!owner || typeof owner !== 'object' || !Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('Unknown owner');
    return owner;
  } catch {
    try { statSync(directory); }
    catch (error) { if (error.code === 'ENOENT') return null; }
    return { safeToYield: false, ownerStatus: 'unreadable' };
  }
}
function ownerBusy(owner) {
  if (!owner) return false;
  if (owner.safeToYield === false || !Number.isInteger(owner.pid) || owner.pid <= 0) return true;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
function lockLocations(root, scope) {
  return scope ? [['legacy-ui', root], [scope, resourceLockRoot(root, scope)], ...(scope === 'pipedrive-write' ? [['pipedrive-write', path.join(path.dirname(root), 'pipedrive-browser-lock')]] : [])] : [
    ['legacy-ui', root], ...RESOURCE_SCOPES.map(value => [value, resourceLockRoot(root, value)]),
    ['pipedrive-write', path.join(path.dirname(root), 'pipedrive-browser-lock')],
  ];
}
export function imacUiIsBusy({ scope, root = defaultRoot } = {}) {
  return lockLocations(root, scope).some(([, directory]) => ownerBusy(readOwner(directory)));
}
export function listResourceLocks({ root = defaultRoot } = {}) {
  const text = value => typeof value === 'string' ? value.slice(0, 200) : '';
  const timestamp = value => Number.isFinite(value) && value > 0 ? value : null;
  return lockLocations(root).flatMap(([scope, directory]) => {
    const owner = readOwner(directory);
    if (!owner) return [];
    return [{ scope, jobId: text(owner.jobId), title: text(owner.title), acquiredAt: timestamp(owner.acquiredAt),
      heartbeat: timestamp(owner.heartbeat), criticalSection: text(owner.criticalSection),
      safeToYield: owner.safeToYield === true, busy: ownerBusy(owner), ownerStatus: owner.ownerStatus || 'identified' }];
  });
}
export const resourceExecutionRoot = defaultRoot;

export async function withImacExecutionLock(task, options = {}) {
  const { acquirePriorityLease } = await import('./execution-priority.mjs');
  const lease = await acquirePriorityLease({ root: defaultRoot, ...options });
  try { return await task(lease); }
  finally { await lease.release(); }
}

export async function withResourceExecutionLock(scope, task, options = {}) {
  return withImacExecutionLock(task, { ...options, scope });
}
