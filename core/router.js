// Model Router. Zentrale Fassade fuer Modell-Auswahl, Kosten-Tracking und
// Budget-Enforcement. Kein automatischer Provider-Fallback, kein stiller
// Modellwechsel - Wahl passiert ausschliesslich ueber die Konfiguration (ENV
// oder Defaults). Bei ueberschrittenem Budget wirft der Router einen Fehler,
// statt heimlich auf ein schwaecheres Modell umzuschalten.
//
// Nutzung:
//   const routed = chooseModel({ task: 'chat' });
//   const { text, usage } = await generateText({ model: routed.model, ... });
//   recordUsage(routed, usage);
//
// Vor dem Call optional:
//   checkBudget(routed);   // wirft, wenn Monatsbudget hart ueberschritten
import fs from 'fs/promises';
import { anthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

const DATA_DIR = process.env.DATA_DIR || '/data';
const USAGE_FILE = DATA_DIR + '/model-usage.json';

// Grobe EUR-Preise pro 1 Mio. Tokens. Dienen NUR der Budget-Anzeige, nicht
// der Abrechnung. Bei Provider-Preisaenderungen hier zentral pflegbar.
const MODELS = {
  'anthropic:claude-sonnet-4-6':          { provider: 'anthropic', id: 'claude-sonnet-4-6',          eurPerMTokIn: 2.75, eurPerMTokOut: 13.80 },
  'anthropic:claude-haiku-4-5-20251001':  { provider: 'anthropic', id: 'claude-haiku-4-5-20251001',  eurPerMTokIn: 0.75, eurPerMTokOut:  3.68 },
  'google:gemini-2.0-flash':              { provider: 'google',    id: 'gemini-2.0-flash',           eurPerMTokIn: 0.09, eurPerMTokOut:  0.37 },
};

// Task-Profile: 1:1 die heute im Code verwendeten Modelle. KEIN Verhaltens-
// Delta ohne ENV-Ueberschreibung. Erweiterung um neue Task-Profile ist ein
// bewusster Schritt (spaeter fuer neue Skills / Agenten).
const TASK_DEFAULTS = {
  chat:               'anthropic:claude-sonnet-4-6',
  route:              'anthropic:claude-haiku-4-5-20251001',
  knowledge:          'anthropic:claude-sonnet-4-6',
  classification:     'anthropic:claude-haiku-4-5-20251001',
  'marketing-assist': 'google:gemini-2.0-flash',
  'marketing-market': 'google:gemini-2.0-flash',
};

// Safety-Level pro Task-Profil (fuer Stufe 4 vorbereitet).
// - creative:     LLM darf frei formulieren
// - operational:  LLM macht Vorschlaege / Antworten, Aktionen brauchen Bestaetigung
// - liability:    LLM darf NICHT Quelle der Wahrheit sein - deterministische Quellen Pflicht
const TASK_SAFETY = {
  chat:               'operational',
  route:              'creative',
  knowledge:          'operational',
  classification:     'operational',
  'marketing-assist': 'creative',
  'marketing-market': 'creative',
};

// Provider-Instanzen einmal cachen (Gemini braucht expliziten Key).
let _googleClient = null;
function googleClient() {
  if (_googleClient) return _googleClient;
  _googleClient = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
  return _googleClient;
}

// Env-Overrides pro Task-Profil: IVA_MODEL_CHAT, IVA_MODEL_ROUTE, ...
// Format: '<provider>:<model-id>' (muss in MODELS registriert sein).
function envKeyFor(task) { return 'IVA_MODEL_' + String(task).toUpperCase().replace(/-/g, '_'); }

function resolveModelKey(task) {
  const envKey = envKeyFor(task);
  const override = process.env[envKey];
  if (override) {
    if (!MODELS[override]) {
      throw new Error(`Router: unbekanntes Modell "${override}" in ${envKey}. Erlaubt: ${Object.keys(MODELS).join(', ')}`);
    }
    return override;
  }
  const def = TASK_DEFAULTS[task];
  if (!def) throw new Error(`Router: unbekanntes Task-Profil "${task}". Erlaubt: ${Object.keys(TASK_DEFAULTS).join(', ')}`);
  return def;
}

// Waehlt Modell + gibt AI-SDK-Instanz zurueck.
// Rueckgabe:
//   { task, key, provider, modelId, safetyLevel, model } - "model" ist direkt in generateText({model: ...}) verwendbar.
export function chooseModel({ task }) {
  const key = resolveModelKey(task);
  const cfg = MODELS[key];
  let model;
  if (cfg.provider === 'anthropic') model = anthropic(cfg.id);
  else if (cfg.provider === 'google') model = googleClient()(cfg.id);
  else throw new Error(`Router: unbekannter Provider "${cfg.provider}"`);
  return {
    task,
    key,
    provider: cfg.provider,
    modelId: cfg.id,
    safetyLevel: TASK_SAFETY[task] || 'operational',
    model,
  };
}

// ----------------------- Kosten & Budget ---------------------------

const MONTHLY_BUDGET_EUR = Number(process.env.IVA_MONTHLY_BUDGET_EUR || 100);
const WARN_THRESHOLD_EUR = Number(process.env.IVA_BUDGET_WARN_EUR || 70);

function currentMonthKey(d = new Date()) {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

let _usageCache = null;
async function loadUsage() {
  if (_usageCache) return _usageCache;
  try { _usageCache = JSON.parse(await fs.readFile(USAGE_FILE, 'utf8')); }
  catch { _usageCache = { months: {} }; }
  return _usageCache;
}
async function saveUsage(u) {
  _usageCache = u;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
    await fs.writeFile(USAGE_FILE, JSON.stringify(u, null, 2));
  } catch { /* Persistenz-Fehler nicht kritisch */ }
}

// Aktuellen Monatsverbrauch abfragen (EUR + Tokens pro Task/Modell).
export async function currentSpendEUR(monthKey = currentMonthKey()) {
  const u = await loadUsage();
  const month = u.months?.[monthKey];
  if (!month) return { monthKey, totalEUR: 0, byModel: {}, byTask: {} };
  const totalEUR = Object.values(month.byModel || {}).reduce((s, v) => s + (v.eur || 0), 0);
  return { monthKey, totalEUR, byModel: month.byModel || {}, byTask: month.byTask || {} };
}

// Nach jedem LLM-Call aufrufen. usage = { promptTokens, completionTokens } (AI-SDK-Shape).
export async function recordUsage(routed, usage) {
  if (!routed || !usage) return;
  const cfg = MODELS[routed.key];
  if (!cfg) return;
  const tin = Number(usage.promptTokens || 0);
  const tout = Number(usage.completionTokens || 0);
  const eur = (tin / 1e6) * cfg.eurPerMTokIn + (tout / 1e6) * cfg.eurPerMTokOut;
  const u = await loadUsage();
  const mk = currentMonthKey();
  u.months = u.months || {};
  const month = u.months[mk] || { byModel: {}, byTask: {} };
  const m = month.byModel[routed.key] || { tokensIn: 0, tokensOut: 0, eur: 0, calls: 0 };
  m.tokensIn += tin; m.tokensOut += tout; m.eur += eur; m.calls += 1;
  month.byModel[routed.key] = m;
  const t = month.byTask[routed.task] || { tokensIn: 0, tokensOut: 0, eur: 0, calls: 0 };
  t.tokensIn += tin; t.tokensOut += tout; t.eur += eur; t.calls += 1;
  month.byTask[routed.task] = t;
  u.months[mk] = month;
  await saveUsage(u);
  // Warn-Log bei Ueberschreitung der Warn-Schwelle (idempotent: einmal pro Monat).
  const totalEUR = Object.values(month.byModel).reduce((s, v) => s + (v.eur || 0), 0);
  if (totalEUR >= WARN_THRESHOLD_EUR && !month._warnedAt) {
    month._warnedAt = new Date().toISOString();
    console.warn(`[${new Date().toISOString()}] [ROUTER] WARN: Monatsverbrauch ${totalEUR.toFixed(2)} EUR >= Warnschwelle ${WARN_THRESHOLD_EUR} EUR (Monat ${mk}).`);
    await saveUsage(u);
  }
}

// Vor dem LLM-Call aufrufen. Wirft bei hartem Budget-Limit, es sei denn das
// Task-Profil ist explizit als "liability" markiert (haftungsrelevant, darf
// niemals aus Kostengruenden blockiert werden).
export async function checkBudget(routed) {
  const { totalEUR } = await currentSpendEUR();
  if (totalEUR >= MONTHLY_BUDGET_EUR && routed?.safetyLevel !== 'liability') {
    const err = new Error(`Router: Monatsbudget ${MONTHLY_BUDGET_EUR} EUR erreicht (aktuell ${totalEUR.toFixed(2)} EUR). Task "${routed?.task}" gestoppt. Erhoehe IVA_MONTHLY_BUDGET_EUR oder warte auf naechsten Monat.`);
    err.code = 'budget_exceeded';
    throw err;
  }
}

// Fuer Introspection (Tests, spaetere UI).
export function listModels() { return Object.keys(MODELS); }
export function listTasks() { return Object.keys(TASK_DEFAULTS); }
export function inspectRouting() {
  const out = {};
  for (const task of listTasks()) {
    try { const r = chooseModel({ task }); out[task] = { key: r.key, safetyLevel: r.safetyLevel }; }
    catch (e) { out[task] = { error: e.message }; }
  }
  return { defaults: TASK_DEFAULTS, resolved: out, budget: { monthly: MONTHLY_BUDGET_EUR, warnAt: WARN_THRESHOLD_EUR } };
}
