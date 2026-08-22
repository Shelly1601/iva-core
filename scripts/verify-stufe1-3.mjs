// Verifikation Stufe 1-3. Kein Server-Start. Deckt ab:
//  1) Router-Defaults ohne ENV-Ueberschreibungen
//  2) Registrierte Tool-Namen unveraendert gegenueber Baseline
//  3) Agent-Registry-Inhalt + Fallback-Verhalten
//  4) Ein echter Anthropic-Call via Router (ohne Tools, minimaler Prompt)
//  5) Persistenz: recordUsage schreibt Datei, addiert bei zweitem Call
//  6) Ungueltiges IVA_MODEL_<TASK> wirft klaren Fehler (kein stiller Fallback)
import 'dotenv/config';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { generateText } from 'ai';

// Router-Persistenz muss im Test in einem Wegwerfverzeichnis landen. Der Wert
// wird vor dem dynamischen Router-Import gesetzt, weil der Router DATA_DIR beim
// Laden des Moduls bindet.
const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-router-test-'));
process.env.DATA_DIR = TEST_DATA_DIR;

const { chooseModel, listTasks, listModels, inspectRouting, recordUsage, currentSpendEUR } = await import('../core/router.js');
const { AGENTS, getAgent, listAgents, routeAgent } = await import('../agents/registry.js');
const { memorySkill } = await import('../skills/memory.js');
const { calendarSkill } = await import('../skills/calendar.js');
const { mailsSkill } = await import('../skills/mails.js');
const { crmSkill } = await import('../skills/crm.js');
const { marketingSkill } = await import('../skills/marketing.js');
const { researchSkill } = await import('../skills/research.js');

const BASELINE = [
  'createTodo', 'completeTodo', 'remember',
  'getCalendar', 'getCalendly', 'getIvaAppointmentTypes', 'createIvaAppointmentTypeDraft',
  'getMails',
  'getLeads', 'findHeatHeroLeads', 'importCrmCustomerFile', 'updateHeatHeroLeadStatus',
  'listCampaigns', 'createCampaign', 'analyzeReferences', 'analyzeCampaign', 'generateImage', 'generateContent', 'listBrands', 'createBrand', 'updateBrand',
  'askArchitect',
];
const EXPECTED_TASKS_TO_MODELS = {
  chat: 'anthropic:claude-sonnet-4-6',
  route: 'anthropic:claude-haiku-4-5-20251001',
  knowledge: 'anthropic:claude-sonnet-4-6',
  classification: 'anthropic:claude-haiku-4-5-20251001',
  'marketing-assist': 'google:gemini-3.6-flash',
  'marketing-market': 'google:gemini-3.6-flash',
};

let fails = 0;
function eq(name, got, exp) {
  const ok = JSON.stringify(got) === JSON.stringify(exp);
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (ok ? '' : `\n         got=${JSON.stringify(got)}\n         exp=${JSON.stringify(exp)}`));
  if (!ok) fails++;
}
function truthy(name, v, msg = '') { const ok = !!v; console.log((ok ? '  PASS ' : '  FAIL ') + name + (ok ? '' : ' -- ' + msg)); if (!ok) fails++; }

console.log('\n[1] Router - Task-Profile & Default-Mappings');
for (const task of Object.keys(EXPECTED_TASKS_TO_MODELS)) {
  const r = chooseModel({ task });
  eq(`  ${task} -> ${EXPECTED_TASKS_TO_MODELS[task]}`, r.key, EXPECTED_TASKS_TO_MODELS[task]);
}
console.log('  inspectRouting():', JSON.stringify(inspectRouting().resolved));
console.log('  models registered:', listModels().join(', '));
console.log('  tasks registered:', listTasks().join(', '));

console.log('\n[2] Skill-Registry - Tool-Namen 1:1 mit Baseline');
const deps = {
  loadMemory: async () => ({}), saveMemory: async () => {},
  getEventsRaw: async () => [], getCalendlyEvents: async () => ({ count: 0, events: [] }), fmtEvents: () => [],
  listAppointmentTypes: async () => [], createAppointmentType: async input => ({ ...input, active: false }),
  loadMailAccounts: () => [], fetchInbox: async () => [],
  fetchAllLeads: async () => [],
  searchHeatHeroLeads: async () => ({ count: 0, leads: [] }),
  updateHeatHeroLeadStatus: async () => ({ neuer_status: 'test' }),
  importCrmCustomerFile: async () => ({ saved: true }),
  campaigns: { listCampaigns: async () => [], createCampaign: async () => ({}), getCampaign: async () => null, updateCampaign: async () => ({}), deleteCampaign: async () => true },
  brands: { listBrands: async () => [], createBrand: async () => ({}), getBrand: async () => null, updateBrand: async () => ({}), deleteBrand: async () => true },
  analyzeReferences: async () => ({ ok: true }),
  generateImage: async () => ({}),
  generateContent: async () => ({}),
  askArchitect: async () => ({ source: 'architect', note: 'stub' }),
};
const assembled = {
  ...memorySkill(deps),
  ...calendarSkill(deps),
  ...mailsSkill(deps),
  ...crmSkill(deps),
  ...marketingSkill(deps),
  ...researchSkill(deps),
};
const registered = Object.keys(assembled);
const missing = BASELINE.filter(n => !registered.includes(n));
const extra = registered.filter(n => !BASELINE.includes(n));
eq('  Baseline vollstaendig registriert (fehlend)', missing, []);
eq('  Keine zusaetzlichen Tools (extra)', extra, []);
console.log(`  registriert: ${registered.length} Tools`);

console.log('\n[3] Agent-Registry - Fallbacks');
console.log('  Registrierte Agenten:', listAgents().map(a => `${a.id}(enabled=${a.enabled})`).join(', '));
eq('  Standard-Agent existiert', getAgent('iva-standard').id, 'iva-standard');
eq('  iva-marketing enabled', AGENTS['iva-marketing'].enabled, true);
eq('  iva-finance enabled', AGENTS['iva-finance'].enabled, true);
eq('  iva-sales enabled', AGENTS['iva-sales'].enabled, true);
eq('  iva-knowledge enabled', AGENTS['iva-knowledge'].enabled, true);
eq('  iva-recruiting enabled', AGENTS['iva-recruiting'].enabled, true);
eq('  getAgent(disabled) -> iva-standard (kein Aktivierungs-Bypass)', getAgent('iva-builder').id, 'iva-standard');
eq('  getAgent(unbekannt) -> iva-standard', getAgent('does-not-exist').id, 'iva-standard');
eq('  iva-standard allowedSkills', getAgent('iva-standard').allowedSkills, ['memory', 'calendar', 'mails', 'crm', 'marketing', 'research', 'workspaces', 'advice', 'opportunities', 'accounting', 'energyTariffs', 'selfImprovement', 'qonekto', 'lumit', 'capabilityReview', 'knowledgeLibrary', 'recruiting', 'deviceControl', 'planbar', 'investment']);
eq('  LUMIT routet zu Kunden/Backoffice', routeAgent('LUMIT als servicierter Antrag anlegen').agent.id, 'iva-customer');
truthy('  Kunden-Agent besitzt LUMIT-Skill', getAgent('iva-customer').allowedSkills.includes('lumit'));
eq('  Planbar-Anfrage routet zu Kunden/Backoffice', routeAgent('Suche Schneider in Planbar').agent.id, 'iva-customer');
truthy('  Kunden-Agent besitzt Planbar-Skill', getAgent('iva-customer').allowedSkills.includes('planbar'));
eq('  Saxo-Anfrage routet zum Investment-Agent', routeAgent('Bitte mein Saxo Portfolio und die Positionsrisiken pruefen').agent.id, 'iva-investment');
truthy('  Investment-Agent besitzt Investment-Skill', getAgent('iva-investment').allowedSkills.includes('investment'));
eq('  Recruiting-Anfrage routet zum Recruiting-Agent', routeAgent('Bitte Lebenslauf fuer das Vorstellungsgespraech pruefen').agent.id, 'iva-recruiting');
eq('  iva-standard modelProfile', getAgent('iva-standard').modelProfile, 'chat');

console.log('\n[4] Echter LLM-Call via Router (chat-Profil, ohne Tools)');
let spendBefore = 0, spendAfter = 0;
try {
  spendBefore = (await currentSpendEUR()).totalEUR;
  const r = chooseModel({ task: 'chat' });
  const t0 = Date.now();
  const { text, usage } = await generateText({
    model: r.model,
    system: 'Antworte in genau EINEM Wort.',
    prompt: 'Sag "OK" und nichts anderes.',
    temperature: 0,
  });
  const dur = Date.now() - t0;
  console.log(`  Model: ${r.key} | Dauer: ${dur}ms | Antwort: "${text.trim()}"`);
  truthy('  Antwort erhalten', text && text.length > 0);
  truthy('  Usage-Objekt erhalten', usage && typeof usage.promptTokens === 'number');
  await recordUsage(r, usage);
  spendAfter = (await currentSpendEUR()).totalEUR;
  console.log(`  Monatsverbrauch nach Call: EUR ${spendAfter.toFixed(4)}`);
  truthy('  currentSpendEUR > vorher (Persistenz aktiv)', spendAfter > spendBefore);
} catch (e) {
  console.log(`  FAIL LLM-Call: ${e.message}`); fails++;
}

console.log('\n[5] Persistenz-Test - synth. Recording, Datei-Reload');
try {
  const spend1 = await currentSpendEUR();
  const r = chooseModel({ task: 'route' });
  await recordUsage(r, { promptTokens: 1000, completionTokens: 200 });
  const dataDir = process.env.DATA_DIR;
  const raw = JSON.parse(await fs.readFile(dataDir + '/model-usage.json', 'utf8'));
  const monthKey = new Date().getUTCFullYear() + '-' + String(new Date().getUTCMonth() + 1).padStart(2, '0');
  const month = raw.months?.[monthKey];
  truthy('  Datei enthaelt aktuellen Monat', !!month);
  truthy('  Datei enthaelt route-Task-Eintrag', !!month?.byTask?.route);
  const spend2 = await currentSpendEUR();
  truthy('  spend nach synth. Recording gestiegen', spend2.totalEUR > spend1.totalEUR);
} catch (e) {
  console.log(`  FAIL Persistenz-Test: ${e.message}`); fails++;
}

console.log('\n[6] ENV-Override IVA_MODEL_CHAT ungueltig -> harter Fehler');
try {
  process.env.IVA_MODEL_CHAT = 'openai:gpt-fake-999';
  let threw = false;
  try { chooseModel({ task: 'chat' }); } catch (e) {
    threw = true;
    truthy('  Fehler enthaelt Modellname', /openai:gpt-fake-999/.test(e.message));
    truthy('  Fehler enthaelt "unbekannt"', /unbekannt/i.test(e.message));
  }
  truthy('  chooseModel wirft bei ungueltigem Override', threw);
  delete process.env.IVA_MODEL_CHAT;
  const r = chooseModel({ task: 'chat' });
  eq('  Nach Reset zurueck auf Default', r.key, 'anthropic:claude-sonnet-4-6');
} catch (e) {
  console.log(`  FAIL ENV-Override-Test: ${e.message}`); fails++;
}

console.log('\n' + (fails === 0 ? 'ALLE TESTS PASS' : `${fails} FAIL(S)`));
await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
process.exitCode = fails === 0 ? 0 : 1;
