import os from 'node:os';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { reportKnowledgeImportCompletion } from './device-agent.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);
const DATA_ROOT = path.resolve(process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper'));
const REPO_ROOT = path.resolve(path.join(path.dirname(MODULE_PATH), '..'));

function allowedManifest(value) {
  const absolute = path.resolve(String(value || ''));
  const inDataRoot = absolute.startsWith(`${DATA_ROOT}${path.sep}`);
  const inTaskQueue = absolute.startsWith(`${path.join(REPO_ROOT, '.iva-task-queue')}${path.sep}`);
  if (!inDataRoot && !inTaskQueue) throw new Error('Das Abschlussmanifest liegt außerhalb des verwalteten IVA-Auftragsordners.');
  return absolute;
}

export async function completeKnowledgeImportFromManifest(importId, manifestPath, dependencies = {}) {
  const report = dependencies.report || reportKnowledgeImportCompletion;
  if (!/^[a-f0-9-]{36}$/i.test(String(importId || ''))) throw new Error('Ungültiger Wissensimport.');
  const absolute = allowedManifest(manifestPath);
  const info = await stat(absolute);
  if (!info.isFile() || info.size < 2 || info.size > 2 * 1024 * 1024) throw new Error('Das Wissensmanifest ist ungültig oder zu groß.');
  const parsed = JSON.parse(await readFile(absolute, 'utf8'));
  return report(importId, {
    title: String(parsed.title || '').slice(0, 240),
    content: String(parsed.content || '').slice(0, 250_000),
    notes: String(parsed.notes || '').slice(0, 12_000),
    tags: (Array.isArray(parsed.tags) ? parsed.tags : []).map(value => String(value).slice(0, 100)).slice(0, 24),
    summary: String(parsed.summary || '').slice(0, 1800),
    completedLessons: Math.max(0, Number(parsed.completedLessons) || 0),
    totalLessons: Math.max(0, Number(parsed.totalLessons) || 0),
    archiveFolderUrl: String(parsed.archiveFolderUrl || '').slice(0, 1800),
  });
}

if (path.resolve(process.argv[1] || '') === path.resolve(MODULE_PATH) && process.argv[2] === 'complete') {
  try { console.log(JSON.stringify(await completeKnowledgeImportFromManifest(process.argv[3], process.argv[4]))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
