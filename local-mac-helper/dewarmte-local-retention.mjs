import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const BASE_DIR = process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper');
const INPUT_DIR = path.join(BASE_DIR, 'dewarmte-inputs');
const TASK_ROOT = process.env.IVA_CODEX_TASK_ROOT || path.join(BASE_DIR, 'codex-tasks');
const REPO_ROOT = path.resolve(process.env.IVA_DEVICE_WORKSPACE || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const OUTPUT_DIR = path.join(REPO_ROOT, 'output', 'pdf');
const TEMP_PDF_DIR = path.join(REPO_ROOT, 'tmp', 'pdfs');
export const DEWARMTE_LOCAL_RETENTION_MS = 3 * 24 * 60 * 60_000;

function safeJobId(value) {
  const jobId = String(value || '').trim();
  if (!/^[a-f0-9-]{36}$/i.test(jobId)) throw new Error('Ungültiger DeWarmte-Job-Schlüssel.');
  return jobId;
}

export async function storeDewarmteLocalSupplement({ jobId, name, buffer } = {}) {
  const id = safeJobId(jobId);
  if (!Buffer.isBuffer(buffer) || buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('Die geladene DeWarmte-Zusatzdatei ist keine gültige PDF.');
  }
  const directory = path.join(INPUT_DIR, id);
  const fileName = `${crypto.randomUUID()}-${path.basename(String(name || 'Zusatzinformation.pdf')).replace(/[^a-z0-9._-]/gi, '_').slice(-180)}`;
  const filePath = path.join(directory, fileName);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(filePath, buffer, { mode: 0o600 });
  return filePath;
}

export async function cleanupExpiredDewarmteLocalData({ now = Date.now() } = {}) {
  let removedInputs = 0;
  let removedTasks = 0;
  let removedOutputs = 0;
  let removedTemps = 0;
  for (const entry of await readdir(INPUT_DIR, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/i.test(entry.name)) continue;
    const directory = path.join(INPUT_DIR, entry.name);
    const info = await stat(directory).catch(() => null);
    if (info && now - info.mtimeMs >= DEWARMTE_LOCAL_RETENTION_MS) {
      await rm(directory, { recursive: true, force: true });
      removedInputs += 1;
    }
  }
  for (const entry of await readdir(TASK_ROOT, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{20,80}$/i.test(entry.name)) continue;
    const directory = path.join(TASK_ROOT, entry.name);
    let request = null;
    try { request = JSON.parse(await readFile(path.join(directory, 'request.json'), 'utf8')); } catch {}
    if (request?.projectId !== 'dewarmte' || now - Date.parse(request.createdAt) < DEWARMTE_LOCAL_RETENTION_MS) continue;
    await rm(directory, { recursive: true, force: true });
    removedTasks += 1;
  }
  for (const entry of await readdir(OUTPUT_DIR, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !/^DeWarmte_Materialliste_.*\.pdf$/i.test(entry.name)) continue;
    const filePath = path.join(OUTPUT_DIR, entry.name);
    const info = await stat(filePath).catch(() => null);
    if (info && now - info.mtimeMs >= DEWARMTE_LOCAL_RETENTION_MS) {
      await rm(filePath, { force: true });
      removedOutputs += 1;
    }
  }
  for (const entry of await readdir(TEMP_PDF_DIR, { withFileTypes: true }).catch(() => [])) {
    if (!/^dewarmte-/i.test(entry.name)) continue;
    const target = path.join(TEMP_PDF_DIR, entry.name);
    const info = await stat(target).catch(() => null);
    if (info && now - info.mtimeMs >= DEWARMTE_LOCAL_RETENTION_MS) {
      await rm(target, { recursive: true, force: true });
      removedTemps += 1;
    }
  }
  return { removedInputs, removedTasks, removedOutputs, removedTemps, retentionDays: 3 };
}
