import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { inspectRouting, setRuntimeModelOverrides } from '../core/router.js';

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = `${DATA_DIR}/integration-checkup.json`;
const GOOGLE_TASKS = ['marketing-assist', 'marketing-market', 'marketing-intelligence'];

function safeMessage(error) {
  return String(error?.message || error || 'Unbekannter Fehler').replace(/[?&](key|token)=[^&\s]+/gi, '?$1=<geschützt>').slice(0, 500);
}

async function requestJson(url, options = {}, { fetchImpl = fetch, timeoutMs = 12_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    let body = null;
    try { body = await response.json(); } catch {}
    if (!response.ok) throw new Error(`HTTP ${response.status}${body?.error?.message ? `: ${body.error.message}` : ''}`);
    return body || {};
  } finally { clearTimeout(timeout); }
}

function emptyState() {
  return { version: 1, lastRun: null, modelOverrides: {}, history: [] };
}

async function loadState() {
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, 'utf8'));
    return { ...emptyState(), ...parsed, modelOverrides: parsed.modelOverrides || {}, history: Array.isArray(parsed.history) ? parsed.history : [] };
  } catch { return emptyState(); }
}

async function saveState(state) {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, FILE);
}

function versionTuple(modelId) {
  const match = String(modelId).match(/gemini-(\d+)(?:\.(\d+))?-flash$/i);
  return match ? [Number(match[1]), Number(match[2] || 0)] : null;
}

export function newestStableGeminiFlash(modelIds = []) {
  return modelIds
    .map(id => String(id).replace(/^models\//, ''))
    .filter(id => versionTuple(id))
    .sort((a, b) => {
      const av = versionTuple(a), bv = versionTuple(b);
      return (bv[0] - av[0]) || (bv[1] - av[1]);
    })[0] || '';
}

async function probeGemini(modelId, apiKey, fetchImpl) {
  await requestJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Antworte nur mit OK.' }] }], generationConfig: { maxOutputTokens: 8 } }),
    },
    { fetchImpl },
  );
}

async function checkGemini({ state, fetchImpl }) {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) return { id: 'gemini', label: 'Gemini', status: 'not-configured', detail: 'GEMINI_API_KEY fehlt.', updates: [] };
  try {
    const catalog = await requestJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1000`, {}, { fetchImpl });
    const available = (catalog.models || []).filter(model => (model.supportedGenerationMethods || []).includes('generateContent')).map(model => String(model.name || '').replace(/^models\//, ''));
    const routing = inspectRouting().resolved;
    const configured = [...new Set(GOOGLE_TASKS.map(task => String(routing[task]?.key || '').replace(/^google:/, '')).filter(Boolean))];
    const missing = configured.filter(modelId => !available.includes(modelId));
    const updates = [];
    if (missing.length) {
      const replacement = newestStableGeminiFlash(available);
      if (!replacement) throw new Error(`Konfigurierte Modelle nicht verfügbar (${missing.join(', ')}); kein stabiles Flash-Ersatzmodell gefunden.`);
      await probeGemini(replacement, key, fetchImpl);
      for (const task of GOOGLE_TASKS) state.modelOverrides[task] = `google:${replacement}`;
      setRuntimeModelOverrides(state.modelOverrides);
      updates.push({ type: 'model', provider: 'google', from: missing.join(', '), to: replacement, tasks: GOOGLE_TASKS });
    }
    return {
      id: 'gemini', label: 'Gemini', status: updates.length ? 'updated' : 'ok',
      detail: updates.length ? `Nicht mehr verfügbare Modellroute automatisch auf ${updates[0].to} umgestellt und erfolgreich getestet.` : `${configured.join(', ')} ist verfügbar.`,
      configuredModels: configured, updates,
    };
  } catch (error) {
    return { id: 'gemini', label: 'Gemini', status: 'error', detail: safeMessage(error), updates: [] };
  }
}

async function checkAnthropic({ fetchImpl }) {
  const key = String(process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return { id: 'anthropic', label: 'Anthropic', status: 'not-configured', detail: 'ANTHROPIC_API_KEY fehlt.', updates: [] };
  try {
    const catalog = await requestJson('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    }, { fetchImpl });
    const available = (catalog.data || []).map(model => model.id);
    const configured = [...new Set(Object.values(inspectRouting().resolved).map(item => item?.key).filter(keyName => String(keyName).startsWith('anthropic:')).map(keyName => keyName.slice('anthropic:'.length)))];
    const missing = configured.filter(modelId => !available.includes(modelId));
    return {
      id: 'anthropic', label: 'Anthropic', status: missing.length ? 'attention' : 'ok', configuredModels: configured, updates: [],
      detail: missing.length ? `Nicht im aktuellen Modellkatalog: ${missing.join(', ')}. Kernmodelle werden aus Qualitäts- und Haftungsgründen nicht ungeprüft gewechselt.` : `${configured.join(', ')} ist verfügbar.`,
    };
  } catch (error) { return { id: 'anthropic', label: 'Anthropic', status: 'error', detail: safeMessage(error), updates: [] }; }
}

const CONNECTOR_PROBES = [
  {
    id: 'telegram', label: 'Telegram', env: 'TELEGRAM_BOT_TOKEN',
    request: token => [`https://api.telegram.org/bot${token}/getMe`, {}],
  },
  {
    id: 'calendly', label: 'Calendly', env: 'CALENDLY_TOKEN',
    request: token => ['https://api.calendly.com/users/me', { headers: { Authorization: `Bearer ${token}` } }],
  },
  {
    id: 'groq', label: 'Groq Spracheingabe', env: 'GROQ_API_KEY',
    request: token => ['https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${token}` } }],
  },
  {
    id: 'elevenlabs', label: 'ElevenLabs Stimme', env: 'ELEVENLABS_API_KEY',
    request: token => ['https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': token } }],
  },
  {
    id: 'apify', label: 'Apify Research', env: 'APIFY_TOKEN',
    request: token => [`https://api.apify.com/v2/users/me?token=${encodeURIComponent(token)}`, {}],
  },
];

async function checkConnector(probe, fetchImpl) {
  const token = String(process.env[probe.env] || '').trim();
  if (!token) return { id: probe.id, label: probe.label, status: 'not-configured', detail: `${probe.env} fehlt.`, updates: [] };
  try {
    const [url, options] = probe.request(token);
    await requestJson(url, options, { fetchImpl });
    return { id: probe.id, label: probe.label, status: 'ok', detail: 'Verbindung und Zugang geprüft.', updates: [] };
  } catch (error) { return { id: probe.id, label: probe.label, status: 'error', detail: safeMessage(error), updates: [] }; }
}

export function formatCheckupTelegram(result) {
  const problem = result.checks.filter(item => ['error', 'attention'].includes(item.status));
  const updated = result.updates;
  const lines = [
    '**IVA Monats-Check-up**',
    `Geprüft: ${result.counts.checked} · OK: ${result.counts.ok} · Handlungsbedarf: ${result.counts.attention}`,
  ];
  if (updated.length) {
    lines.push('', '**Automatisch aktualisiert**');
    for (const item of updated) lines.push(`- ${item.provider}: ${item.from} → ${item.to}`);
  }
  if (problem.length) {
    lines.push('', '**Bitte ansehen**');
    for (const item of problem) lines.push(`- ${item.label}: ${item.detail}`);
  }
  if (!problem.length && !updated.length) lines.push('', 'Alle konfigurierten Verbindungen und KI-Modelle sind aktuell erreichbar.');
  lines.push('', 'Node-Pakete werden monatlich separat geprüft; Patch-/Minor-Updates gehen nur nach grüner Testsuite automatisch live. Große Versionssprünge bleiben zur Prüfung offen.');
  return lines.join('\n');
}

export async function getIntegrationCheckupStatus() {
  const state = await loadState();
  return {
    lastRun: state.lastRun,
    modelOverrides: state.modelOverrides,
    packageUpdates: { cadence: 'monthly', safeAutoMergeAfterTests: true, majorUpdatesRequireReview: true },
  };
}

export async function runIntegrationCheckup({ fetchImpl = fetch } = {}) {
  const state = await loadState();
  const checks = [];
  checks.push(await checkGemini({ state, fetchImpl }));
  checks.push(await checkAnthropic({ fetchImpl }));
  for (const probe of CONNECTOR_PROBES) checks.push(await checkConnector(probe, fetchImpl));
  const updates = checks.flatMap(item => item.updates || []);
  const configuredChecks = checks.filter(item => item.status !== 'not-configured');
  const result = {
    id: crypto.randomUUID(), checkedAt: new Date().toISOString(), checks, updates,
    counts: {
      checked: configuredChecks.length,
      ok: configuredChecks.filter(item => ['ok', 'updated'].includes(item.status)).length,
      attention: configuredChecks.filter(item => ['error', 'attention'].includes(item.status)).length,
      notConfigured: checks.length - configuredChecks.length,
    },
  };
  result.summary = `Monats-Check-up: ${result.counts.checked} aktive Dienste geprüft, ${result.counts.attention} mit Handlungsbedarf, ${updates.length} automatisch aktualisiert.`;
  state.lastRun = result;
  state.history = [...state.history, { id: result.id, checkedAt: result.checkedAt, counts: result.counts, updates }].slice(-24);
  await saveState(state);
  return result;
}
