import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executePipedriveJavaScript } from './local-mac-helper/chrome-pipedrive.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(here, '../outputs/pipedrive-custom-audience-2026-08-15');
const inputFile = path.join(outputDir, 'deal-index.json');
const progressFile = path.join(outputDir, 'phase1-salescycle-progress.json');
const sourceDealId = '541';
const batchSize = 10;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function startBatch(ids) {
  const jobId = `iva-phase1-${randomUUID()}`;
  const started = await executePipedriveJavaScript(String.raw`(() => {
    const jobId = ${JSON.stringify(jobId)};
    const ids = ${JSON.stringify(ids)};
    const targetAliases = [
      'Antrag eingereicht / Förderunterlagen einreichen',
      'Antrag eingereicht / Förderunterlagen',
      'Auftrag eingereicht / Förderunterlagen einreichen',
      'Auftrag eingereicht / Förderunterlagen'
    ];
    window.__ivaPhase1Jobs = window.__ivaPhase1Jobs || {};
    window.__ivaPhase1Jobs[jobId] = { status: 'running' };
    (async () => {
      const resource = performance.getEntriesByType('resource')
        .map(entry => entry.name)
        .find(name => name.includes('session_token='));
      const sessionToken = resource ? new URL(resource).searchParams.get('session_token') : '';
      if (!sessionToken) throw new Error('missing_session_token');
      const request = async path => {
        const separator = path.includes('?') ? '&' : '?';
        const response = await fetch(path + separator + 'strict_mode=true&session_token=' + encodeURIComponent(sessionToken), {
          credentials: 'same-origin'
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.success === false) {
          throw new Error('HTTP ' + response.status + ' für ' + path.split('?')[0]);
        }
        return payload?.data;
      };
      const stages = await request('/api/v1/stages?pipeline_id=1&start=0&limit=500') || [];
      const stageById = new Map(stages.map(stage => [String(stage.id), String(stage.name || '')]));
      const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const target = stages.find(stage => targetAliases.some(alias => normalize(stage.name) === normalize(alias)));
      if (!target) throw new Error('target_stage_not_found');
      const extractStageEvents = flow => (Array.isArray(flow) ? flow : []).flatMap(item => {
        const data = item?.data && typeof item.data === 'object' ? item.data : item;
        const fieldKey = String(data?.field_key ?? item?.field_key ?? '');
        if (!/stage/i.test(fieldKey)) return [];
        const oldValue = data?.old_value ?? item?.old_value ?? null;
        const newValue = data?.new_value ?? item?.new_value ?? null;
        const oldName = data?.old_value_formatted ?? item?.old_value_formatted ?? stageById.get(String(oldValue)) ?? null;
        const newName = data?.new_value_formatted ?? item?.new_value_formatted ?? stageById.get(String(newValue)) ?? null;
        const timestamp = data?.log_time ?? data?.add_time ?? item?.timestamp ?? item?.log_time ?? item?.add_time ?? item?.update_time ?? null;
        return [{ fieldKey, oldValue, newValue, oldName, newName, timestamp, object: item?.object ?? null }];
      });
      const items = await Promise.all(ids.map(async id => {
        try {
          const [deal, flow] = await Promise.all([
            request('/api/v1/deals/' + encodeURIComponent(id) + '?get_activity_summary=false&get_updated_deal_stage_averages=false'),
            request('/api/v1/deals/' + encodeURIComponent(id) + '/flow?start=0&limit=500')
          ]);
          const stageEvents = extractStageEvents(flow).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
          const targetEvents = stageEvents.filter(event =>
            String(event.newValue) === String(target.id)
            || normalize(event.newName) === normalize(target.name)
            || targetAliases.some(alias => normalize(event.newName) === normalize(alias))
          );
          return {
            dealId: String(id),
            title: String(deal?.title || ''),
            addTime: deal?.add_time || null,
            currentStageId: deal?.stage_id == null ? null : String(deal.stage_id),
            currentStage: stageById.get(String(deal?.stage_id)) || null,
            targetStageId: String(target.id),
            targetStage: String(target.name || ''),
            targetEnteredAt: targetEvents[0]?.timestamp || null,
            stageEvents,
            readOnly: true,
            mutated: false
          };
        } catch (error) {
          return { dealId: String(id), error: String(error?.message || error), readOnly: true, mutated: false };
        }
      }));
      window.__ivaPhase1Jobs[jobId] = {
        status: 'complete',
        value: { targetStageId: String(target.id), targetStage: String(target.name || ''), items }
      };
    })().catch(error => {
      window.__ivaPhase1Jobs[jobId] = { status: 'failed', error: String(error?.message || error) };
    });
    return jobId;
  })()`, { dealId: sourceDealId, timeoutMs: 20000 });
  if (started !== jobId) throw new Error('Pipedrive-Leseauftrag konnte nicht gestartet werden.');
  return jobId;
}

async function pollBatch(jobId) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const raw = await executePipedriveJavaScript(String.raw`(() => {
      const jobs = window.__ivaPhase1Jobs || {};
      const job = jobs[${JSON.stringify(jobId)}];
      if (!job) return JSON.stringify({ status: 'missing' });
      if (job.status === 'complete' || job.status === 'failed') delete jobs[${JSON.stringify(jobId)}];
      return JSON.stringify(job);
    })()`, { dealId: sourceDealId, timeoutMs: 20000 });
    const status = JSON.parse(raw);
    if (status.status === 'complete') return status.value;
    if (status.status === 'failed') throw new Error(status.error || 'Pipedrive-Leseauftrag fehlgeschlagen.');
    await wait(500);
  }
  throw new Error('Zeitlimit beim Lesen der Pipedrive-Historie überschritten.');
}

const index = await readJson(inputFile);
const allIds = [...new Set((index?.records || []).map(record => String(record.id || '')).filter(id => /^\d+$/.test(id)))];
if (!allIds.length) throw new Error('Keine Deal-IDs in deal-index.json gefunden.');

const existing = await readJson(progressFile, { records: [] });
const recordById = new Map((existing.records || []).map(record => [String(record.dealId), record]));
const pending = allIds.filter(id => !recordById.has(id));

for (let offset = 0; offset < pending.length; offset += batchSize) {
  const ids = pending.slice(offset, offset + batchSize);
  const jobId = await startBatch(ids);
  const result = await pollBatch(jobId);
  for (const item of result.items || []) recordById.set(String(item.dealId), item);
  const records = allIds.map(id => recordById.get(id)).filter(Boolean);
  await writeFile(progressFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    definition: 'Deal-Erstellung bis erster Eintritt in Antrag eingereicht / Förderunterlagen einreichen',
    targetStageId: result.targetStageId,
    targetStage: result.targetStage,
    totalDeals: allIds.length,
    processedDeals: records.length,
    remainingDeals: allIds.length - records.length,
    records
  }, null, 2));
  console.log(JSON.stringify({ processed: records.length, total: allIds.length, remaining: allIds.length - records.length }));
}

console.log(JSON.stringify({ complete: true, total: allIds.length, progressFile }));
