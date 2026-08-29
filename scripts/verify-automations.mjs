import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-automations-'));
process.env.DATA_DIR = testDir;
process.env.RESEND_API_KEY = 'test-resend-key';
process.env.IVA_REPORT_FROM_EMAIL = 'iva@example.test';
process.env.IVA_REPORT_TO_EMAIL = 'Nadine.iva.inbox@gmail.com';

const store = await import('../automations/store.js');
const { createAutomationOrchestrator, automationSlotKey } = await import('../automations/orchestrator.js');
const { buildAutomationReport, collapseAutomationRunAttempts, deliverReportEmail, deliverReportEmailWithTelegramFallback, deliverReportTelegram, formatAutomationReportText } = await import('../automations/reporting.js');
const { ensureProjectProtocolSummaries, recordProjectWorkflowResult } = await import('../projects/protocols.js');

let failures = 0;
function check(name, value) {
  const ok = Boolean(value);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures += 1;
}

const initial = await store.listAutomations();
check('Zentrale Automationsliste ist vorhanden', initial.length >= 10);
check('CRM-Sync startet sicherheitshalber ausgeschaltet', initial.find(item => item.id === 'crm-qonekto-sync')?.enabled === false);
check('E-Mail-Reports sind der aktive Hauptkanal', initial.filter(item => item.id.startsWith('report-email-')).every(item => item.enabled === true));
check('Separater Telegram-Report startet ohne Doppelzustellung ausgeschaltet', initial.find(item => item.id === 'report-telegram-morning')?.enabled === false);
check('Monatlicher Integrations-Check-up ist standardmäßig aktiv', initial.find(item => item.id === 'integration-checkup-monthly')?.enabled === true);
const fundingSequence = initial.find(item => item.id === 'funding-daily-sequence');
check('Förder-Tageslauf ist täglich um 05:00 Uhr aktiv', fundingSequence?.enabled === true && fundingSequence.cron === '0 5 * * *');
check('Förder-Tageslauf benennt die feste Reihenfolge', /1 → 2 → 3/.test(fundingSequence?.name || ''));
const planbarForecast = initial.find(item => item.id === 'planbar-weekly-export');
check('Planbar-Forecast ist zentral freitags um 19:00 Uhr aktiv', planbarForecast?.enabled === true && planbarForecast.cron === '0 19 * * 5');
check('Alle angesetzten täglichen iMac-Projektworkflows sind zentral terminiert', [
  ['funding-daily-sequence', '0 5 * * *'],
  ['montage-required-fields-morning', '0 7 * * *'],
  ['planbar-completion-morning', '0 8 * * *'],
].every(([id, cron]) => initial.find(item => item.id === id)?.enabled === true && initial.find(item => item.id === id)?.cron === cron));
await store.setAutomationEnabled('crm-qonekto-sync', true);
check('Schalter wird persistent gespeichert', (await store.getAutomation('crm-qonekto-sync')).enabled === true);

let handlerCalls = 0;
const runner = createAutomationOrchestrator({
  'daily-briefing': async () => { handlerCalls += 1; return { summary: 'Testlauf erfolgreich.' }; },
});
const fixedNow = new Date('2026-08-17T07:30:00+02:00');
const first = await runner.runAutomation('daily-briefing', { now: fixedNow, slotKey: 'test:daily:2026-08-17' });
const duplicate = await runner.runAutomation('daily-briefing', { now: fixedNow, slotKey: 'test:daily:2026-08-17' });
check('Ein Slot wird nur einmal ausgeführt', first.run?.status === 'completed' && duplicate.reason === 'duplicate' && handlerCalls === 1);

let failedCalls = 0;
const failing = createAutomationOrchestrator({
  'report-email-daily': async () => { failedCalls += 1; throw new Error('absichtlicher Testfehler'); },
});
for (let attempt = 0; attempt < 3; attempt += 1) {
  try { await failing.runAutomation('report-email-daily', { now: fixedNow, slotKey: 'test:retry' }); } catch {}
}
const exhausted = await failing.runAutomation('report-email-daily', { now: fixedNow, slotKey: 'test:retry' });
check('Fehler werden begrenzt erneut versucht', failedCalls === 3 && exhausted.reason === 'attempts-exhausted');

let blockedCalls = 0;
const blockedRunner = createAutomationOrchestrator({
  'report-email-daily': async () => { blockedCalls += 1; return { status: 'blocked', summary: 'Provider fehlt.', error: 'Provider fehlt.' }; },
});
const blockedFirst = await blockedRunner.runAutomation('report-email-daily', { now: fixedNow, slotKey: 'test:blocked' });
const blockedDuplicate = await blockedRunner.runAutomation('report-email-daily', { now: fixedNow, slotKey: 'test:blocked' });
check('Konfigurationsblocker wird nicht dreimal wiederholt', blockedFirst.run?.status === 'blocked' && blockedDuplicate.reason === 'duplicate' && blockedCalls === 1);

let waitingCalls = 0;
const waitingRunner = createAutomationOrchestrator({
  'planbar-weekly-export': async ({ previousResult }) => {
    waitingCalls += 1;
    if (!previousResult.commandId) return { status: 'waiting', commandId: 'forecast-command', summary: 'iMac läuft.' };
    return { commandId: previousResult.commandId, sentFolderVerified: true, summary: 'Outlook-Gesendet verifiziert.' };
  },
});
const waitingFirst = await waitingRunner.runAutomation('planbar-weekly-export', { now: fixedNow, slotKey: 'test:forecast-waiting' });
const waitingResumed = await waitingRunner.runAutomation('planbar-weekly-export', { now: fixedNow, slotKey: 'test:forecast-waiting' });
const waitingDuplicate = await waitingRunner.runAutomation('planbar-weekly-export', { now: fixedNow, slotKey: 'test:forecast-waiting' });
check('Ein wartender iMac-Lauf wird nach Serverzyklen fortgesetzt und erst mit Endnachweis abgeschlossen', waitingFirst.run?.status === 'waiting'
  && waitingResumed.run?.status === 'completed' && waitingResumed.run?.result?.sentFolderVerified === true
  && waitingDuplicate.reason === 'duplicate' && waitingCalls === 2);

const automationStoreFile = path.join(testDir, 'automation-control.json');
const staleStore = JSON.parse(await fs.readFile(automationStoreFile, 'utf8'));
staleStore.runs.push({
  id: 'stale-opportunity-run',
  automationId: 'opportunity-weekly',
  automationName: 'Chancenradar-Wochenlauf',
  slotKey: 'test:stale-opportunity',
  trigger: 'schedule',
  attempt: 1,
  status: 'running',
  summary: '',
  error: '',
  startedAt: new Date(Date.now() - (7 * 60 * 1000)).toISOString(),
  completedAt: '',
  durationMs: null,
});
await fs.writeFile(automationStoreFile, JSON.stringify(staleStore));
let recoveredCalls = 0;
const recoveredRunner = createAutomationOrchestrator({
  'opportunity-weekly': async () => { recoveredCalls += 1; return { summary: 'Wiederholung erfolgreich.' }; },
});
const recovered = await recoveredRunner.runAutomation('opportunity-weekly', { slotKey: 'test:stale-opportunity' });
const recoveredRuns = await store.listAutomationRuns({ automationId: 'opportunity-weekly', limit: 10 });
check('Nach Serverneustart hängende Läufe werden freigegeben und einmal sicher wiederholt', recovered.run?.status === 'completed'
  && recovered.run?.attempt === 2
  && recoveredCalls === 1
  && recoveredRuns.some(item => item.id === 'stale-opportunity-run' && item.status === 'failed' && item.completedAt));

const weeklyDefinition = initial.find(item => item.id === 'project-protocol-weekly');
check('Verpasster Sonntagslauf behält montags denselben Wochenslot', automationSlotKey(weeklyDefinition, new Date('2026-08-17T08:00:00+02:00')).endsWith('2026-W33'));
const monthlyDefinition = initial.find(item => item.id === 'integration-checkup-monthly');
check('Monatlicher Check-up hat genau einen Slot je Kalendermonat', automationSlotKey(monthlyDefinition, new Date('2026-08-22T08:00:00+02:00')).endsWith('2026-08'));
const tooOftenDefinition = initial.find(item => item.id === 'heat-hero-too-often-replies');
check('HeatHero-Rückmeldungen sind täglich um 08:15 Uhr aktiv', tooOftenDefinition?.enabled && tooOftenDefinition.cron === '15 8 * * *');

await recordProjectWorkflowResult('heat-hero', {
  runId: 'funding-monitor-report-test',
  workflowId: 'funding-monitor',
  workflowName: 'Fördermonitor und Pipedrive-Nachlauf',
  status: 'completed',
  startedAt: '2026-08-14T21:00:00.000Z',
  completedAt: '2026-08-14T21:05:00.000Z',
  summary: 'Ein Förderfall wurde verarbeitet.',
  metrics: {
    dealActions: [{
      dealId: '7479',
      uploadedFiles: ['KfW_Zusage.pdf'],
      drafts: [{ subject: 'Fehlende Förderunterlagen', recipient: 'kunde@example.test' }],
      fieldUpdates: [{ field: 'Förderhöhe', value: '18.000 €' }],
      status: 'Geprüft',
    }],
  },
  artifacts: ['Pipedrive-Datei KfW_Zusage.pdf'],
});
await ensureProjectProtocolSummaries('heat-hero', {
  now: new Date('2026-08-15T23:58:00+02:00'),
  finalizeWeekly: true,
  expectedWorkflows: [{ workflowId: 'kfw-approval-morning', workflowName: 'KfW-Zusagen morgens prüfen', cadence: 'daily' }],
});
const report = await buildAutomationReport('weekly', fixedNow);
check('Wochenreport hat eine stabile Perioden-ID', report.key === 'workflow-report:weekly:2026-W33');
check('Report zeigt Deal, Upload, Mail-Entwurf und Pipedrive-Feld', report.text.includes('Deal 7479') && report.text.includes('KfW_Zusage.pdf') && report.text.includes('Mail-Entwurf: Fehlende Förderunterlagen') && report.text.includes('Pipedrive-Feld: Förderhöhe = 18.000 €'));
check('Report enthält keine technischen Report- und Bereinigungsläufe', !report.text.includes('Täglicher Workflow-Report per E-Mail') && !report.text.includes('Protokoll-Aufbewahrung bereinigen'));
check('Nicht gelaufener fachlicher Workflow wird ausdrücklich rot gemeldet', report.text.includes('KfW-Zusagen morgens prüfen') && report.text.includes('Status: NICHT GELAUFEN'));
const collapsedAttempts = collapseAutomationRunAttempts([
  { id: '1', slotKey: 'same-slot', status: 'failed', startedAt: '2026-08-17T04:45:00Z' },
  { id: '2', slotKey: 'same-slot', status: 'failed', startedAt: '2026-08-17T05:00:00Z' },
  { id: '3', slotKey: 'same-slot', status: 'failed', startedAt: '2026-08-17T05:15:00Z' },
]);
check('Drei Fehlversuche erscheinen im Report als ein Lauf', collapsedAttempts.length === 1 && collapsedAttempts[0].attemptCount === 3);
const formattedTelegram = formatAutomationReportText({
  title: 'IVA Workflow-Tagesreport 2026-08-20',
  counts: { total: 2, completed: 1, failed: 1, blocked: 0 },
  runs: [
    { automationName: 'Erfolgsworkflow', status: 'completed', summary: 'Alles erledigt.' },
    { automationName: 'Fehlerworkflow', status: 'failed', summary: 'Automatischer Lauf fehlgeschlagen.', error: 'Testgrund.' },
  ],
});
check('Telegram stellt Workflownamen fett und Abschnitte mit Leerzeilen dar', formattedTelegram.includes('**Erfolgsworkflow**\nStatus: Erfolgreich durchgelaufen') && formattedTelegram.includes('\n\n**Fehlerworkflow**\nStatus: Fehler'));

let emailRequests = 0;
const fetchImpl = async () => {
  emailRequests += 1;
  return { ok: true, status: 200, json: async () => ({ id: 'email-test-1' }) };
};
const emailFirst = await deliverReportEmail(report, { fetchImpl });
const emailDuplicate = await deliverReportEmail(report, { fetchImpl });
check('E-Mail-Wochenreport wird nicht doppelt versandt', emailFirst.delivered && emailDuplicate.duplicate && emailRequests === 1);

let telegramRequests = 0;
const sendTelegram = async () => { telegramRequests += 1; };
const telegramFirst = await deliverReportTelegram(report, { chatId: '12345', sendTelegram });
const telegramDuplicate = await deliverReportTelegram(report, { chatId: '12345', sendTelegram });
check('Telegram-Wochenreport wird nicht doppelt versandt', telegramFirst.delivered && telegramDuplicate.duplicate && telegramRequests === 1);

const fallbackReport = { ...report, key: `${report.key}:fallback-test` };
const fallback = await deliverReportEmailWithTelegramFallback(fallbackReport, {
  chatId: '12345', sendTelegram,
  fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ message: 'Provider-Testfehler' }) }),
});
check('Bei E-Mail-Fehler wird genau ein Telegram-Ersatzreport versandt', fallback.deliveredChannel === 'telegram' && fallback.emailError.includes('Provider-Testfehler') && telegramRequests === 2);

const runs = await store.listAutomationRuns({ limit: 100 });
check('Laufstatus und Fehler bleiben für Reports erhalten', runs.some(item => item.status === 'completed') && runs.filter(item => item.status === 'failed').length >= 3);

await fs.rm(testDir, { recursive: true, force: true });
console.log(failures ? `${failures} Fehler` : 'Automationssteuerung erfolgreich verifiziert.');
process.exit(failures ? 1 : 0);
