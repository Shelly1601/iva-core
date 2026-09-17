// Model Router. Zentrale Fassade fuer Modell-Auswahl, Kosten-Tracking und
// Budget-Enforcement. Kein automatischer Provider-Fallback, kein stiller
// Modellwechsel - Wahl passiert ausschliesslich ueber die Konfiguration (ENV
// oder Defaults). Bei ueberschrittenem Budget wirft der Router einen Fehler,
// statt heimlich auf ein schwaecheres Modell umzuschalten.
//
// Every paid provider dispatch must reserve an enforced upper bound first.
// checkBudget alone is a status check; runWithModelBudget owns settlement.
import fsSync from 'node:fs';
import { createModelBudget, priceModelUsage } from './model-budget.js';
import { wrapBudgetedModel } from './budgeted-model.js';
import { anthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGoogleSchemaFetch, googleRateLimitFetch } from './google-schema-transport.js';
import { createOpenAI } from '@ai-sdk/openai';

const DATA_DIR = process.env.DATA_DIR || '/data';
const USAGE_FILE = DATA_DIR + '/model-usage.json';
const INTEGRATION_CHECKUP_FILE = DATA_DIR + '/integration-checkup.json';
const budgetedModels = new WeakSet();
const centrallyBudgeted = routed => budgetedModels.has(routed?.model);

// Model identities remain unchanged. Provider prices must be explicitly
// verified/configured; model names never imply an invented price profile.
const MODELS = {
  'anthropic:claude-sonnet-4-6': { provider: 'anthropic', id: 'claude-sonnet-4-6' },
  'anthropic:claude-haiku-4-5-20251001': { provider: 'anthropic', id: 'claude-haiku-4-5-20251001' },
  'google:gemini-3.6-flash': { provider: 'google', id: 'gemini-3.6-flash' },
  'groq:openai/gpt-oss-120b': { provider: 'groq', id: 'openai/gpt-oss-120b' },
};

// Task-Profile: 1:1 die heute im Code verwendeten Modelle. KEIN Verhaltens-
// Delta ohne ENV-Ueberschreibung. Erweiterung um neue Task-Profile ist ein
// bewusster Schritt (spaeter fuer neue Skills / Agenten).
const TASK_DEFAULTS = {
  chat:               'anthropic:claude-sonnet-4-6',
  route:              'anthropic:claude-haiku-4-5-20251001',
  knowledge:          'anthropic:claude-sonnet-4-6',
  classification:     'anthropic:claude-haiku-4-5-20251001',
  whatsapp:           'anthropic:claude-haiku-4-5-20251001',
  'marketing-assist': 'google:gemini-3.6-flash',
  'marketing-market': 'google:gemini-3.6-flash',
  'marketing-intelligence': 'google:gemini-3.6-flash',
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
  whatsapp:           'operational',
  'marketing-assist': 'creative',
  'marketing-market': 'creative',
  'marketing-intelligence': 'creative',
};

// Gemini bekommt einen eigenen Transport pro Modellaufruf, damit die
// Signaturen mehrstufiger Werkzeugaufrufe innerhalb ihrer Sitzung bleiben.
function googleClient() {
  return createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY, fetch: createGoogleSchemaFetch(fetch, { maxRetries: 0 }) });
}

// Env-Overrides pro Task-Profil: IVA_MODEL_CHAT, IVA_MODEL_ROUTE, ...
// Format: '<provider>:<model-id>' (muss in MODELS registriert sein).
function envKeyFor(task) { return 'IVA_MODEL_' + String(task).toUpperCase().replace(/-/g, '_'); }

const configurationError = () => Object.assign(new Error('Router: explizite Modellkonfiguration ist ungueltig oder nicht lesbar; keine Ersatzroute aktiviert.'), { code: 'router_config_invalid' });
const plainObject = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function validateRuntimeOverrides(overrides) {
  if (!plainObject(overrides)) throw configurationError();
  for (const [task, key] of Object.entries(overrides)) {
    if (!Object.hasOwn(TASK_DEFAULTS, task) || typeof key !== 'string' || !Object.hasOwn(MODELS, key)) throw configurationError();
  }
  return { ...overrides };
}

function loadRuntimeOverrides() {
  let content;
  try { content = fsSync.readFileSync(INTEGRATION_CHECKUP_FILE, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw configurationError();
  }
  try {
    const parsed = JSON.parse(content);
    if (!plainObject(parsed)) throw configurationError();
    return Object.hasOwn(parsed, 'modelOverrides') ? validateRuntimeOverrides(parsed.modelOverrides) : {};
  } catch { throw configurationError(); }
}

// Keep diagnostics available on a broken configuration, but refuse model
// selection until a valid explicit update repairs it. Never activate defaults.
let runtimeModelOverrides = {};
let runtimeConfigurationError = null;
try { runtimeModelOverrides = loadRuntimeOverrides(); }
catch (error) { runtimeConfigurationError = error; }

function dynamicModelConfig(key) {
  const [provider, id] = String(key || '').split(':', 2);
  if (provider === 'google' && /^gemini-[a-z0-9.-]+$/i.test(id || '')) {
    return { provider, id };
  }
  if (provider === 'anthropic' && /^claude-[a-z0-9.-]+$/i.test(id || '')) {
    return { provider, id };
  }
  return null;
}

function modelConfig(key) { return Object.hasOwn(MODELS, key) ? MODELS[key] : dynamicModelConfig(key); }

export function setRuntimeModelOverrides(overrides = {}) {
  try {
    runtimeModelOverrides = validateRuntimeOverrides(overrides);
    runtimeConfigurationError = null;
  } catch (error) {
    runtimeConfigurationError = error;
    throw error;
  }
}

function resolveModelKey(task) {
  if (runtimeConfigurationError) throw runtimeConfigurationError;
  if (!Object.hasOwn(TASK_DEFAULTS, task)) throw configurationError();
  const envKey = envKeyFor(task);
  const override = process.env[envKey];
  if (override !== undefined) {
    if (!Object.hasOwn(MODELS, override)) throw configurationError();
    return override;
  }
  if (Object.hasOwn(runtimeModelOverrides, task)) return runtimeModelOverrides[task];
  return TASK_DEFAULTS[task];
}

// Waehlt Modell + gibt AI-SDK-Instanz zurueck.
// Rueckgabe:
//   { task, key, provider, modelId, safetyLevel, model } - "model" ist direkt in generateText({model: ...}) verwendbar.
export function chooseModel({ task }) {
  const key = resolveModelKey(task);
  return chooseModelKey(key, { task });
}

// Explicit secondary model selection never changes the configured main route.
export function chooseModelKey(key, { task = 'brain-review' } = {}) {
  if (runtimeConfigurationError) throw runtimeConfigurationError;
  const cfg = modelConfig(key);
  if (!cfg) throw new Error(`Router: unbekanntes Modell "${key}"`);
  let model;
  if (cfg.provider === 'anthropic') model = anthropic(cfg.id);
  else if (cfg.provider === 'google') model = googleClient()(cfg.id);
  else if (cfg.provider === 'groq') model = createOpenAI({apiKey:process.env.GROQ_API_KEY,baseURL:'https://api.groq.com/openai/v1',compatibility:'compatible',fetch:(url,init)=>googleRateLimitFetch(fetch,url,init,{maxRetries:0})}).chat(cfg.id,{structuredOutputs:false});
  else throw new Error(`Router: unbekannter Provider "${cfg.provider}"`);
  const routed = {
    task,
    key,
    provider: cfg.provider,
    modelId: cfg.id,
    safetyLevel: TASK_SAFETY[task] || 'operational',
    model,
  };
  Object.defineProperty(routed, 'budgetEnforced', { value: true });
  routed.model = wrapBudgetedModel(model, routed, { reserve: reserveProviderRequest, estimate: estimateUsageEUR });
  budgetedModels.add(routed.model);
  return routed;
}

// ----------------------- Kosten & Budget ---------------------------

// Official USD list prices checked 2026-09-17. These are conservative internal
// EUR accounting ceilings, not invoices or a guarantee of the provider balance.
// USD * 1.5 reserves FX/tax headroom. Anthropic input uses twice the base price
// to include the more expensive cache-write class. All reasoning output must be
// counted by the provider adapter. Additional paid provider tools are excluded.
const PRICE_EVIDENCE = {
  verifiedAt: '2026-09-17T00:00:00.000Z', validUntil: '2026-12-16T00:00:00.000Z',
  includesAllCharges: true, eurPerUsdCeiling: 1.5,
};
const VERIFIED_PRICING = {
  'anthropic:claude-sonnet-4-6': { ...PRICE_EVIDENCE, eurPerMTokIn: 9, eurPerMTokOut: 22.5, source: 'https://platform.claude.com/docs/en/about-claude/pricing' },
  'anthropic:claude-haiku-4-5-20251001': { ...PRICE_EVIDENCE, eurPerMTokIn: 3, eurPerMTokOut: 7.5, source: 'https://platform.claude.com/docs/en/about-claude/pricing' },
  'google:gemini-3.6-flash': { ...PRICE_EVIDENCE, eurPerMTokIn: 1.125, eurPerMTokOut: 5.625, source: 'https://ai.google.dev/gemini-api/docs/pricing' },
  'groq:openai/gpt-oss-120b': { ...PRICE_EVIDENCE, eurPerMTokIn: 0.225, eurPerMTokOut: 0.9, source: 'https://console.groq.com/docs/models' },
};

// EUR upper bounds must include provider taxes/FX and every billed token type.
// Keep evidence and an expiry with each profile; a free/paid tier guess is unsafe.
// IVA_MODEL_PRICING_JSON = { "provider:model": {
//   eurPerMTokIn, eurPerMTokOut, source, verifiedAt, validUntil,
//   includesAllCharges: true
// } }. No network lookup, credential change or cheaper model switch occurs here.
function configuredNumber(name, fallback) {
  const raw = process.env[name];
  const value = raw == null || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < 0) throw Object.assign(new Error(`Router: ungueltige Budget-Konfiguration ${name}.`), { code: 'budget_config_invalid' });
  return value;
}

export function modelPricing(routed) {
  let profiles;
  try { profiles = JSON.parse(process.env.IVA_MODEL_PRICING_JSON || '{}'); }
  catch { throw Object.assign(new Error('Router: IVA_MODEL_PRICING_JSON ist ungueltig.'), { code: 'budget_pricing_unknown' }); }
  const profile = profiles?.[routed?.key] ?? VERIFIED_PRICING[routed?.key];
  const verified = Date.parse(profile?.verifiedAt);
  const expires = Date.parse(profile?.validUntil);
  if (!profile || profile.includesAllCharges !== true || typeof profile.source !== 'string' || !/^https:\/\//.test(profile.source) ||
      !Number.isFinite(verified) || !Number.isFinite(expires) || verified > Date.now() || expires <= Date.now() || expires <= verified ||
      ![profile.eurPerMTokIn, profile.eurPerMTokOut].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0) ||
      profile.eurPerMTokIn + profile.eurPerMTokOut <= 0) {
    throw Object.assign(new Error(`Router: verifizierte EUR-Preisobergrenze fuer "${routed?.key}" fehlt oder ist abgelaufen.`), { code: 'budget_pricing_unknown' });
  }
  return { eurPerMTokIn: profile.eurPerMTokIn, eurPerMTokOut: profile.eurPerMTokOut, source: profile.source, verifiedAt: profile.verifiedAt, validUntil: profile.validUntil, includesAllCharges: true };
}

const budget = createModelBudget({
  file: USAGE_FILE,
  monthlyLimitEUR: configuredNumber('IVA_MONTHLY_BUDGET_EUR', 30),
  warnAtEUR: configuredNumber('IVA_BUDGET_WARN_EUR', 24),
  pricingFor: modelPricing,
  onWarn: ({ monthKey, totalEUR, warnAtEUR }) => console.warn(`[ROUTER] Monatsverbrauch ${totalEUR.toFixed(2)} EUR >= Warnschwelle ${warnAtEUR} EUR (${monthKey}).`),
});

export const currentSpendEUR = month => budget.currentSpend(month);

// Compatibility for unreserved completed calls only. Admission control requires
// reserveModelBudget/runWithModelBudget before dispatch, even for liability tasks.
export const recordUsage = (routed, usage) => centrallyBudgeted(routed) ? Promise.resolve() : budget.record(routed, usage);
export const checkBudget = () => budget.check();
export function estimateUsageEUR(routed, usage = {}) {
  return priceModelUsage(usage, modelPricing(routed)).eur;
}

// The callable handle preserves pre-dispatch cancellation compatibility. Once
// sent, release without verified usage keeps the full reservation and fails shut.
async function reserveProviderRequest(routed, upperBoundEUR) {
  const id = await budget.reserve(routed, upperBoundEUR);
  const handle = options => budget.release(id, options);
  handle.id = id;
  handle.markDispatched = () => budget.markDispatched(id);
  handle.settle = usage => budget.settle(id, usage);
  handle.release = handle;
  return handle;
}

export async function reserveModelBudget(routed, upperBoundEUR) {
  if (!centrallyBudgeted(routed)) return reserveProviderRequest(routed, upperBoundEUR);
  // Existing advisory callers have an outer reservation. The wrapped provider
  // now reserves each actual dispatch, so that outer scope must not double bill.
  await checkBudget();
  const handle = async () => {};
  handle.markDispatched = handle;
  handle.settle = handle;
  handle.release = handle;
  return handle;
}

// Recovery by a persisted reservation id, including after a process restart.
export const settleModelBudget = (id, usage) => budget.settle(id, usage);
export const releaseModelBudget = (id, options) => budget.release(id, options);

// The callback must enforce the bounds used to calculate upperBoundEUR (input,
// output, tool steps, retries, and non-token charges). A provider error is not
// evidence that the request was unbilled; only provider usage can reconcile it.
export async function runWithModelBudget(routed, { upperBoundEUR }, execute) {
  const reservation = await reserveModelBudget(routed, upperBoundEUR);
  try {
    await reservation.markDispatched();
    const result = await execute(reservation);
    await reservation.settle(result?.totalUsage ?? result?.usage);
    return result;
  } catch (error) {
    try { await reservation.release(); } catch { /* durable unresolved hold retained */ }
    throw error;
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
  return { defaults: TASK_DEFAULTS, resolved: out, budget: budget.limits };
}
