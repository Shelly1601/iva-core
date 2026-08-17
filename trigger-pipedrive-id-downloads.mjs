import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executePipedriveJavaScript } from './local-mac-helper/chrome-pipedrive.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(here, '../outputs/pipedrive-custom-audience-2026-08-15');
const queue = JSON.parse(await readFile(path.join(outputDir, 'id-explicit-download-queue.json'), 'utf8'));
const start = Math.max(0, Number(process.argv[2]) || 0);
const limit = Math.max(1, Number(process.argv[3]) || 25);
const batch = queue.slice(start, start + limit);
const sourceDealId = '541';
if (!batch.length) throw new Error('Der Download-Block ist leer.');

const jobId = `iva-id-download-${randomUUID()}`;
const started = await executePipedriveJavaScript(String.raw`(() => {
  const jobId = ${JSON.stringify(jobId)};
  const files = ${JSON.stringify(batch.map(item => ({ fileId: item.fileId, name: item.name })))};
  window.__ivaIdDownloadJobs = window.__ivaIdDownloadJobs || {};
  window.__ivaIdDownloadJobs[jobId] = { status: 'running', processed: 0, total: files.length };
  (async () => {
    const resource = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('session_token='));
    const sessionToken = resource ? new URL(resource).searchParams.get('session_token') : '';
    if (!sessionToken) throw new Error('missing_session_token');
    for (const file of files) {
      const anchor = document.createElement('a');
      anchor.href = '/api/v1/files/' + encodeURIComponent(file.fileId) + '/download?strict_mode=true&session_token=' + encodeURIComponent(sessionToken);
      anchor.download = file.name || ('pipedrive-file-' + file.fileId);
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.__ivaIdDownloadJobs[jobId].processed += 1;
      await new Promise(resolve => setTimeout(resolve, 900));
    }
    window.__ivaIdDownloadJobs[jobId].status = 'complete';
  })().catch(error => {
    window.__ivaIdDownloadJobs[jobId].status = 'failed';
    window.__ivaIdDownloadJobs[jobId].error = String(error?.message || error);
  });
  return jobId;
})()`, { dealId: sourceDealId, timeoutMs: 20000 });

if (started !== jobId) throw new Error('Download-Lauf konnte nicht gestartet werden.');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = Date.now() + Math.max(120000, batch.length * 3000);
while (Date.now() < deadline) {
  await wait(1000);
  const raw = await executePipedriveJavaScript(String.raw`(() => {
    const job = window.__ivaIdDownloadJobs?.[${JSON.stringify(jobId)}];
    if (!job) return JSON.stringify({ status: 'missing' });
    const result = { ...job };
    if (job.status === 'complete' || job.status === 'failed') delete window.__ivaIdDownloadJobs[${JSON.stringify(jobId)}];
    return JSON.stringify(result);
  })()`, { dealId: sourceDealId, timeoutMs: 20000 });
  const status = JSON.parse(raw);
  console.log(JSON.stringify(status));
  if (status.status === 'complete') process.exit(0);
  if (status.status === 'failed' || status.status === 'missing') throw new Error(status.error || status.status);
}
throw new Error('Download-Lauf hat das Zeitlimit überschritten.');
