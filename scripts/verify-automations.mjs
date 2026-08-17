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
const { buildAutomationReport, deliverReportEmail, deliverReportTelegram } = await import('../automations/reporting.js');

let failures = 0;
function check(name, value) {
  const ok = Boolean(value);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures += 1;
}

const initial = await store.listAutomations();
check('Zentrale Automationsliste ist vorhanden', initial.length >= 10);
check('CRM-Sync startet sicherheitshalber ausgeschaltet', initial.find(item => item.id === 'crm-qonekto-sync')?.enabled === false);
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

const weeklyDefinition = initial.find(item => item.id === 'project-protocol-weekly');
check('Verpasster Sonntagslauf behält montags denselben Wochenslot', automationSlotKey(weeklyDefinition, new Date('2026-08-17T08:00:00+02:00')).endsWith('2026-W33'));

const report = await buildAutomationReport('weekly', fixedNow);
check('Wochenreport hat eine stabile Perioden-ID', report.key === 'workflow-report:weekly:2026-W33');

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

const runs = await store.listAutomationRuns({ limit: 100 });
check('Laufstatus und Fehler bleiben für Reports erhalten', runs.some(item => item.status === 'completed') && runs.filter(item => item.status === 'failed').length === 3);

await fs.rm(testDir, { recursive: true, force: true });
console.log(failures ? `${failures} Fehler` : 'Automationssteuerung erfolgreich verifiziert.');
process.exit(failures ? 1 : 0);
