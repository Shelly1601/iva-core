#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { appendFile, lstat, mkdir, readFile, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const STORAGE_MAINTENANCE_INTERVAL_SECONDS = 48 * 60 * 60;
export const STORAGE_MAINTENANCE_LABEL = 'de.iva.storage-maintenance';
export const STORAGE_MAINTENANCE_LOG_LIMIT_BYTES = 1024 * 1024;
export const STORAGE_MAINTENANCE_LOG_RETAIN_BYTES = 512 * 1024;

const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'blocked', 'timed_out', 'incomplete']);
const DEFAULT_COMPLETED_TASK_RETENTION_DAYS = 30;
const DEFAULT_OTHER_TERMINAL_TASK_RETENTION_DAYS = 90;

function dataRoot() {
  return process.env.IVA_MAC_HELPER_DATA_DIR
    || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper');
}

export function storageMaintenancePaths({ home = os.homedir(), root = dataRoot() } = {}) {
  const resolvedHome = path.resolve(home);
  const resolvedRoot = path.resolve(root);
  if (!path.isAbsolute(resolvedHome) || resolvedHome === path.parse(resolvedHome).root) {
    throw new Error('Unsicherer Benutzerordner für die Speicherwartung.');
  }
  return Object.freeze({
    home: resolvedHome,
    root: resolvedRoot,
    trash: path.join(resolvedHome, '.Trash'),
    codexTasks: path.join(resolvedRoot, 'codex-tasks'),
    state: path.join(resolvedRoot, 'storage-maintenance-state.json'),
    auditLog: path.join(resolvedRoot, 'logs', 'storage-maintenance.log'),
  });
}

function assertExactTrashPath(paths) {
  const expected = path.join(path.resolve(paths.home), '.Trash');
  if (path.resolve(paths.trash) !== expected || path.dirname(expected) !== path.resolve(paths.home)) {
    throw new Error('Papierkorb-Ziel ist nicht exakt der Papierkorb des aktuellen Benutzers.');
  }
  return expected;
}

async function allocatedBytes(target) {
  let info;
  try { info = await lstat(target); } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  if (info.isSymbolicLink()) return Number(info.blocks || 0) * 512;
  let total = Number(info.blocks || 0) * 512;
  if (!info.isDirectory()) return total;
  const entries = await readdir(target, { withFileTypes: true }).catch(error => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) total += await allocatedBytes(path.join(target, entry.name));
  return total;
}

async function diskFreeBytes(target) {
  const info = await statfs(target);
  return Number(info.bavail) * Number(info.bsize);
}

async function directoryEntries(target) {
  try { return await readdir(target, { withFileTypes: true }); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function emptyCurrentUserTrash({ paths = storageMaintenancePaths(), commit = false, removeEntry = rm } = {}) {
  const trash = assertExactTrashPath(paths);
  await mkdir(trash, { recursive: true, mode: 0o700 });
  const entries = await directoryEntries(trash);
  const bytesBefore = await allocatedBytes(trash);
  const failures = [];
  let deletedCount = 0;
  if (commit) {
    for (const entry of entries) {
      const target = path.resolve(trash, entry.name);
      if (path.dirname(target) !== trash) throw new Error('Papierkorb-Eintrag liegt außerhalb des erlaubten Ziels.');
      try {
        await removeEntry(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        deletedCount += 1;
      } catch (error) {
        failures.push({ code: String(error?.code || 'UNKNOWN').slice(0, 40) });
      }
    }
  }
  return {
    committed: commit,
    entryCount: entries.length,
    deletedCount,
    failedCount: failures.length,
    failureCodes: [...new Set(failures.map(item => item.code))],
    bytesBefore,
    bytesAfter: commit ? await allocatedBytes(trash) : bytesBefore,
  };
}

function taskRetentionMs(state, completedDays, otherDays) {
  return (state === 'completed' ? completedDays : otherDays) * 24 * 60 * 60 * 1000;
}

export async function pruneTerminalCodexTasks({
  paths = storageMaintenancePaths(),
  commit = false,
  now = Date.now(),
  completedRetentionDays = DEFAULT_COMPLETED_TASK_RETENTION_DAYS,
  otherTerminalRetentionDays = DEFAULT_OTHER_TERMINAL_TASK_RETENTION_DAYS,
} = {}) {
  const root = path.resolve(paths.codexTasks);
  if (root !== path.join(path.resolve(paths.root), 'codex-tasks')) throw new Error('Unsicherer Codex-Auftragsordner.');
  const entries = await directoryEntries(root);
  const candidates = [];
  let bytesBefore = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const target = path.resolve(root, entry.name);
    if (path.dirname(target) !== root) continue;
    let state;
    try { state = JSON.parse(await readFile(path.join(target, 'state.json'), 'utf8')); } catch { continue; }
    if (!TERMINAL_TASK_STATES.has(state?.status)) continue;
    const updatedAt = Date.parse(state.updatedAt || state.completedAt || state.createdAt || '');
    if (!Number.isFinite(updatedAt)) continue;
    if (now - updatedAt < taskRetentionMs(state.status, completedRetentionDays, otherTerminalRetentionDays)) continue;
    const bytes = await allocatedBytes(target);
    candidates.push({ target, bytes });
    bytesBefore += bytes;
  }
  if (commit) {
    for (const candidate of candidates) await rm(candidate.target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
  return { committed: commit, candidateCount: candidates.length, bytesBefore, bytesAfter: commit ? 0 : bytesBefore };
}

async function rotateAuditLog(paths) {
  let raw;
  try { raw = await readFile(paths.auditLog); } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (raw.byteLength <= STORAGE_MAINTENANCE_LOG_LIMIT_BYTES) return;
  await writeFile(paths.auditLog, raw.subarray(raw.byteLength - STORAGE_MAINTENANCE_LOG_RETAIN_BYTES), { mode: 0o600 });
}

async function writeStateAtomically(paths, state) {
  await mkdir(path.dirname(paths.state), { recursive: true, mode: 0o700 });
  const temporary = `${paths.state}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, paths.state);
}

export async function runStorageMaintenance({
  paths = storageMaintenancePaths(),
  commit = false,
  now = new Date(),
  completedRetentionDays,
  otherTerminalRetentionDays,
} = {}) {
  const startedAt = now.toISOString();
  const freeBefore = await diskFreeBytes(paths.home);
  const trash = await emptyCurrentUserTrash({ paths, commit });
  const codexTasks = await pruneTerminalCodexTasks({
    paths,
    commit,
    now: now.getTime(),
    ...(completedRetentionDays === undefined ? {} : { completedRetentionDays }),
    ...(otherTerminalRetentionDays === undefined ? {} : { otherTerminalRetentionDays }),
  });
  const freeAfter = await diskFreeBytes(paths.home);
  const state = {
    version: 1,
    host: os.hostname(),
    mode: commit ? 'commit' : 'dry-run',
    status: 'completed',
    startedAt,
    completedAt: new Date().toISOString(),
    intervalSeconds: STORAGE_MAINTENANCE_INTERVAL_SECONDS,
    freeBefore,
    freeAfter,
    freedBytes: Math.max(0, freeAfter - freeBefore),
    trash: {
      entryCount: trash.entryCount,
      deletedCount: trash.deletedCount,
      failedCount: trash.failedCount,
      failureCodes: trash.failureCodes,
      bytesBefore: trash.bytesBefore,
      bytesAfter: trash.bytesAfter,
    },
    codexTasks: { candidateCount: codexTasks.candidateCount, bytesBefore: codexTasks.bytesBefore, bytesAfter: codexTasks.bytesAfter },
  };
  if (commit) {
    await writeStateAtomically(paths, state);
    await mkdir(path.dirname(paths.auditLog), { recursive: true, mode: 0o700 });
    await appendFile(paths.auditLog, `${JSON.stringify({ at: state.completedAt, status: state.status, freedBytes: state.freedBytes, trashEntries: trash.entryCount, trashDeleted: trash.deletedCount, trashFailed: trash.failedCount, failureCodes: trash.failureCodes, codexTasks: codexTasks.candidateCount })}\n`, { mode: 0o600 });
    await rotateAuditLog(paths);
  }
  return state;
}

export async function readStorageMaintenanceStatus({ paths = storageMaintenancePaths() } = {}) {
  try { return JSON.parse(await readFile(paths.state, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'never-run', intervalSeconds: STORAGE_MAINTENANCE_INTERVAL_SECONDS };
    throw error;
  }
}

async function main() {
  const [command = 'dry-run', confirmation] = process.argv.slice(2);
  if (command === 'status') return console.log(JSON.stringify(await readStorageMaintenanceStatus(), null, 2));
  if (command === 'dry-run') return console.log(JSON.stringify(await runStorageMaintenance({ commit: false }), null, 2));
  if (command === 'run') {
    if (confirmation !== '--commit') throw new Error('Papierkorb und alte IVA-Auftragsreste wurden nicht gelöscht. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await runStorageMaintenance({ commit: true }), null, 2));
  }
  throw new Error('Erlaubte Befehle: dry-run, run --commit, status');
}

if (process.argv[1] && path.basename(process.argv[1]) === path.basename(fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
