import fs from 'fs/promises';
import os from 'os';
import path from 'path';

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-operations-'));

const {
  beginAgentRun, finishAgentRun, listAgentRuns, createApproval, resolveApprovalByExternalKey,
  listApprovals, recordAudit, listAudit, operationsSummary,
} = await import('../operations/store.js');
const { AGENTS, getAgent, listAgents, routeAgent } = await import('../agents/registry.js');
const { accountingSkill } = await import('../skills/accounting.js');

let failures = 0;
function check(name, value) { const ok = Boolean(value); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failures += 1; }

const run = await beginAgentRun({
  agentId: 'iva-customer', agentName: 'Kunden & Backoffice', routeReason: 'Test', channel: 'chat',
  sessionId: 'private-session', requestPreview: 'Schreib an test@example.de und +49 151 12345678',
});
check('Agentenlauf startet', run.status === 'running' && run.session && run.session !== 'private-session');
check('Agentenlauf redigiert Kontaktdaten', run.requestPreview.includes('[E-Mail]') && run.requestPreview.includes('[Telefon]'));
await finishAgentRun(run.id, { status: 'completed', durationMs: 1234, tools: ['listQonektoTools', 'callQonektoReadTool'], resultPreview: 'Erledigt' });
const runs = await listAgentRuns({ limit: 5 });
check('Agentenlauf endet mit Werkzeugen', runs[0].status === 'completed' && runs[0].tools.length === 2 && runs[0].durationMs === 1234);

await createApproval({ type: 'qonekto-write', title: 'Test', summary: 'IBAN DE02120300000000202051', agentId: 'iva-customer', externalKey: 'qonekto:test', confirmationPhrase: 'Ja, Qonekto-Aenderung ausfuehren' });
let approvals = await listApprovals({ status: 'pending' });
check('Freigabe wartet und maskiert IBAN', approvals.length === 1 && approvals[0].summary.includes('[IBAN]'));
await resolveApprovalByExternalKey('qonekto:test', { status: 'approved', result: 'Erledigt.' });
approvals = await listApprovals({ status: 'approved' });
check('Freigabe wird aufgeloest', approvals.length === 1 && approvals[0].status === 'approved');

await recordAudit({ category: 'approval', action: 'test-confirmed', status: 'completed', actor: 'nadine', detail: 'Test' });
const audit = await listAudit({ category: 'approval' });
const summary = await operationsSummary();
check('Audit und Kennzahlen vorhanden', audit.length === 1 && summary.runs.today === 1 && summary.approvals.pending === 0);

const routingCases = [
  ['Bitte prüfe meine Buchhaltung und Belege', 'iva-accounting'],
  ['Mach eine Heizlast für die Wärmepumpe', 'iva-energy'],
  ['Erstelle eine Instagram Marketing Kampagne', 'iva-marketing'],
  ['Pruefe diesen Lebenslauf fuer das Vorstellungsgespraech', 'iva-recruiting'],
  ['Hilf mir beim Einwand im Verkaufsgespräch', 'iva-sales'],
  ['Prüfe mein Saxo Portfolio und die Watchlist', 'iva-investment'],
  ['Baue eine Altersvorsorgeberatung auf', 'iva-finance'],
  ['Öffne die Kundenakte in Qonekto', 'iva-customer'],
  ['Was steht heute an?', 'iva-standard'],
];
for (const [text, expected] of routingCases) check(`Routing ${expected}`, routeAgent(text).agent.id === expected);
check('Explizite aktive Rolle wird respektiert', routeAgent('gemischtes Thema', 'iva-energy').agent.id === 'iva-energy');
check('Deaktivierter Agent fällt sicher zurück', getAgent('iva-builder').id === 'iva-standard');
check('Zehn Rollen sind aktiv', listAgents().filter(agent => agent.enabled).length === 10);
check('Nur der autonome Builder bleibt gesperrt', !AGENTS['iva-builder'].enabled && AGENTS['iva-knowledge'].enabled && AGENTS['iva-recruiting'].enabled);
check('Marketing hat kein Qonekto-Schreibwerkzeug', !AGENTS['iva-marketing'].allowedSkills.includes('qonekto'));

const tools = accountingSkill({
  accountingSummary: async () => ({ open: 2 }), listAccountingEntities: async () => [],
  listAccountingDocuments: async () => [], getAccountingDocument: async id => ({ id }),
});
check('Buchhaltungsagent hat nur lesende Buchhaltungstools', Object.keys(tools).sort().join(',') === ['getAccountingDocument','getAccountingSummary','listAccountingDocuments','listAccountingEntities'].join(','));

console.log(failures ? `${failures} Fehler` : 'Operations- und Agentenschicht erfolgreich verifiziert.');
process.exit(failures ? 1 : 0);
