import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-project-protocols-'));
process.env.DATA_DIR = root;
const {
  cleanupExpiredProjectProtocols,
  ensureProjectProtocolSummaries,
  getProjectProtocol,
  listProjectProtocols,
  recordProjectWorkflowResult,
} = await import(`../projects/protocols.js?test=${Date.now()}`);
const { buildFundingDealActions, fundingReportArtifacts } = await import('../local-mac-helper/funding-project-report.mjs');

const fundingDealActions = buildFundingDealActions({
  results: [{ dealId: '7479', status: 'auto_uploaded_to_pipedrive', uploadedFiles: ['KfW_Zusage.pdf'] }],
  productionOutcomes: [{ dealId: '7479', status: 'missing_documents_draft_created', emailDraft: { subject: 'Fehlende Förderunterlagen' }, note: { action: 'created' } }],
  followUpOutcomes: [{ dealId: '7520', status: 'reminder_draft_created', subject: 'Erinnerung Förderunterlagen' }],
});
assert.equal(fundingDealActions.length, 2);
assert.deepEqual(fundingDealActions[0].uploadedFiles, ['KfW_Zusage.pdf']);
assert.equal(fundingDealActions[0].drafts[0].subject, 'Fehlende Förderunterlagen');
assert.ok(fundingReportArtifacts(fundingDealActions).some(item => item.includes('Deal 7479: Datei KfW_Zusage.pdf')));

const now = new Date('2026-08-15T16:15:00+02:00');
await recordProjectWorkflowResult('heat-hero', {
  runId: 'planbar-2026-08-15', workflowId: 'planbar-weekly-export', workflowName: 'Planbar-Wochenlauf',
  status: 'sent-and-verified', completedAt: now, summary: '65 Baustellen und zehn Anlagen geprüft versandt.',
  metrics: { customerCount: 65, attachmentCount: 10 },
}, { now });
await recordProjectWorkflowResult('heat-hero', {
  runId: 'funding-2026-08-15', workflowId: 'funding-monitor', workflowName: 'Fördermonitor',
  status: 'blocked', completedAt: new Date('2026-08-15T23:05:00+02:00'), summary: 'Pipedrive-Sitzung musste erneuert werden.',
}, { now: new Date('2026-08-15T23:05:00+02:00') });

// Derselbe runId aktualisiert den vorhandenen Lauf und erzeugt keine Dublette.
await recordProjectWorkflowResult('heat-hero', {
  runId: 'funding-2026-08-15', workflowId: 'funding-monitor', workflowName: 'Fördermonitor',
  status: 'completed', completedAt: new Date('2026-08-15T23:10:00+02:00'), summary: 'Sitzung erneuert und Lauf abgeschlossen.',
}, { now: new Date('2026-08-15T23:10:00+02:00') });

let listed = await listProjectProtocols('heat-hero');
const dailyFolder = listed.folders.find(item => item.id === 'daily');
const weeklyFolder = listed.folders.find(item => item.id === 'weekly');
assert.equal(dailyFolder.retentionDays, 7);
assert.equal(weeklyFolder.retentionDays, 30);
assert.equal(dailyFolder.files.length, 1);
assert.equal(weeklyFolder.files.length, 1);
assert.equal(dailyFolder.files[0].runs.length, 2);
assert.equal(dailyFolder.files[0].result.successful, 2);
assert.deepEqual(dailyFolder.files[0].tags, ['TÄGLICH', 'AUFBEWAHRUNG 7 TAGE', 'AUTOMATISCHE LÖSCHUNG 22.08.2026']);
assert.deepEqual(weeklyFolder.files[0].tags, ['WÖCHENTLICH', 'AUFBEWAHRUNG 30 TAGE', 'AUTOMATISCHE LÖSCHUNG 15.09.2026']);
assert.equal((await getProjectProtocol('heat-hero', 'daily', dailyFolder.files[0].fileId)).fileName, 'Tagesprotokoll_2026-08-15.json');

await ensureProjectProtocolSummaries('heat-hero', {
  now,
  finalizeDaily: true,
  expectedWorkflows: [
    { workflowId: 'funding-monitor', workflowName: 'Fördermonitor', cadence: 'daily' },
    { workflowId: 'planbar-weekly-export', workflowName: 'Planbar-Wochenlauf', cadence: 'weekly', weekday: 6 },
  ],
});
listed = await listProjectProtocols('heat-hero');
assert.equal(listed.folders.find(item => item.id === 'daily').files[0].finalized, true);
assert.equal(listed.folders.find(item => item.id === 'daily').files[0].health, 'complete');

await ensureProjectProtocolSummaries('gap-project', {
  now,
  finalizeDaily: true,
  expectedWorkflows: [{ workflowId: 'funding-monitor', workflowName: 'Fördermonitor', cadence: 'daily' }],
});
const gapDaily = (await listProjectProtocols('gap-project')).folders.find(item => item.id === 'daily').files[0];
assert.equal(gapDaily.health, 'missing_results');
assert.equal(gapDaily.expectations[0].missingRuns, 1);

const dailyCleanup = await cleanupExpiredProjectProtocols({ projectId: 'heat-hero', now: new Date('2026-08-22T00:30:00+02:00') });
assert.equal(dailyCleanup.deletedCount, 1);
listed = await listProjectProtocols('heat-hero');
assert.equal(listed.folders.find(item => item.id === 'daily').files.length, 0);
assert.equal(listed.folders.find(item => item.id === 'weekly').files.length, 1);

const weeklyCleanup = await cleanupExpiredProjectProtocols({ projectId: 'heat-hero', now: new Date('2026-09-15T00:30:00+02:00') });
assert.equal(weeklyCleanup.deletedCount, 1);
listed = await listProjectProtocols('heat-hero');
assert.equal(listed.folders.find(item => item.id === 'weekly').files.length, 0);

console.log('PASS Projekt-Protokolle: Tages-/Wochenresultate, Datei-Tags, Dublettenschutz und automatische 7-/30-Tage-Löschung.');
