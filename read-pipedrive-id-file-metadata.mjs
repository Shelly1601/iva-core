import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executePipedriveJavaScript } from './local-mac-helper/chrome-pipedrive.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(here, '../outputs/pipedrive-custom-audience-2026-08-15');
const inputFile = path.join(outputDir, 'deal-index.json');
const progressFile = path.join(outputDir, 'id-file-metadata-progress.json');
const sourceDealId = '541';
const batchSize = 10;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function startBatch(ids) {
  const jobId = `iva-id-files-${randomUUID()}`;
  const started = await executePipedriveJavaScript(String.raw`(() => {
    const jobId = ${JSON.stringify(jobId)};
    const ids = ${JSON.stringify(ids)};
    window.__ivaIdFileJobs = window.__ivaIdFileJobs || {};
    window.__ivaIdFileJobs[jobId] = { status: 'running' };
    (async () => {
      const resource = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('session_token='));
      const sessionToken = resource ? new URL(resource).searchParams.get('session_token') : '';
      if (!sessionToken) throw new Error('missing_session_token');
      const request = async path => {
        const separator = path.includes('?') ? '&' : '?';
        const response = await fetch(path + separator + 'strict_mode=true&session_token=' + encodeURIComponent(sessionToken), { credentials: 'same-origin' });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.success === false) throw new Error('HTTP ' + response.status + ' für ' + path.split('?')[0]);
        return payload?.data;
      };
      const items = await Promise.all(ids.map(async id => {
        try {
          const files = await request('/api/v1/deals/' + encodeURIComponent(id) + '/files?start=0&limit=500') || [];
          return {
            dealId: String(id),
            files: files.map(file => ({
              id: file?.id == null ? null : String(file.id),
              name: String(file?.name || file?.file_name || ''),
              fileType: file?.file_type || file?.mime_type || null,
              size: file?.file_size ?? file?.size ?? null,
              addTime: file?.add_time || null,
              updateTime: file?.update_time || null,
              url: file?.url || null,
              downloadUrl: file?.download_url || null,
              remoteLocation: file?.remote_location || null,
              keys: Object.keys(file || {})
            })),
            readOnly: true,
            mutated: false
          };
        } catch (error) {
          return { dealId: String(id), error: String(error?.message || error), files: [], readOnly: true, mutated: false };
        }
      }));
      window.__ivaIdFileJobs[jobId] = { status: 'complete', value: { items } };
    })().catch(error => {
      window.__ivaIdFileJobs[jobId] = { status: 'failed', error: String(error?.message || error) };
    });
    return jobId;
  })()`, { dealId: sourceDealId, timeoutMs: 20000 });
  if (started !== jobId) throw new Error('Pipedrive-Dateileselauf konnte nicht gestartet werden.');
  return jobId;
}

async function pollBatch(jobId) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const raw = await executePipedriveJavaScript(String.raw`(() => {
      const jobs = window.__ivaIdFileJobs || {};
      const job = jobs[${JSON.stringify(jobId)}];
      if (!job) return JSON.stringify({ status: 'missing' });
      if (job.status === 'complete' || job.status === 'failed') delete jobs[${JSON.stringify(jobId)}];
      return JSON.stringify(job);
    })()`, { dealId: sourceDealId, timeoutMs: 20000 });
    const status = JSON.parse(raw);
    if (status.status === 'complete') return status.value;
    if (status.status === 'failed') throw new Error(status.error || 'Pipedrive-Dateileselauf fehlgeschlagen.');
    await wait(500);
  }
  throw new Error('Zeitlimit beim Lesen der Pipedrive-Dateien überschritten.');
}

const index = await readJson(inputFile);
const allIds = [...new Set((index?.records || []).map(record => String(record.id || '')).filter(id => /^\d+$/.test(id)))];
if (!allIds.length) throw new Error('Keine Deal-IDs gefunden.');

const existing = await readJson(progressFile, { records: [] });
const recordById = new Map((existing.records || []).map(record => [String(record.dealId), record]));
const pending = allIds.filter(id => !recordById.has(id));

for (let offset = 0; offset < pending.length; offset += batchSize) {
  const ids = pending.slice(offset, offset + batchSize);
  const result = await pollBatch(await startBatch(ids));
  for (const item of result.items || []) recordById.set(String(item.dealId), item);
  const records = allIds.map(id => recordById.get(id)).filter(Boolean);
  const filesRead = records.reduce((sum, record) => sum + (record.files?.length || 0), 0);
  await writeFile(progressFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalDeals: allIds.length,
    processedDeals: records.length,
    remainingDeals: allIds.length - records.length,
    filesRead,
    records
  }, null, 2));
  console.log(JSON.stringify({ processed: records.length, total: allIds.length, filesRead }));
}

console.log(JSON.stringify({ complete: true, total: allIds.length, progressFile }));
