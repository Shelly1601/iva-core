#!/usr/bin/env node
// scripts/smoke.js
// Baseline-Smoke-Test fuer IVA-Core.
// Prueft die kritischen Endpunkte im laufenden System (lokal ODER Railway).
// Modifiziert keinen Code und keine Daten. Auth via Bearer-Token aus ENV.
//
// Ausfuehrung:   npm run test:smoke
// Doku:          ../SMOKE_TESTS.md

// Laedt dieselbe .env-Datei wie die App (index.js: `import 'dotenv/config'`).
// dotenv ueberschreibt bewusst KEINE bereits geerbten Prozess-Variablen -> daraus
// ergibt sich die Precedence:
//   (1) Explizite Prozess-ENV (Shell / CI / "NAME=value npm run test:smoke")
//   (2) Werte aus iva-core/.env
//   (3) Hartkodierte Defaults / Fallbacks in diesem Skript
import 'dotenv/config';

const DEFAULT_BASE_URL = 'https://iva-core-production.up.railway.app';

// SMOKE_BASE_URL > Default (Produktion). Trailing-Slashes werden gestrippt.
const BASE_URL_SOURCE = process.env.SMOKE_BASE_URL ? 'SMOKE_BASE_URL' : 'Default';
const BASE_URL = (process.env.SMOKE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

// SMOKE_API_TOKEN > API_TOKEN (aus .env, gleiche Variable wie die App).
const TOKEN_SOURCE =
  process.env.SMOKE_API_TOKEN ? 'SMOKE_API_TOKEN' :
  process.env.API_TOKEN ? 'API_TOKEN (Fallback)' :
                          '(fehlt)';
const TOKEN = process.env.SMOKE_API_TOKEN || process.env.API_TOKEN || '';

const INCLUDE_CHAT = process.env.SMOKE_INCLUDE_CHAT === '1';
const INCLUDE_SPEAK = process.env.SMOKE_INCLUDE_SPEAK === '1';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 15000;
const CHAT_TIMEOUT_MS = Number(process.env.SMOKE_CHAT_TIMEOUT_MS) || 60000;

// --- Setup-Guardrails ---------------------------------------------------------

if (!TOKEN) {
  console.error('\x1b[31mFehler:\x1b[0m Kein Bearer-Token gefunden. Entweder SMOKE_API_TOKEN setzen oder API_TOKEN in iva-core/.env pflegen (gleiche Variable wie die App).');
  process.exit(2);
}
if (typeof fetch !== 'function') {
  console.error('\x1b[31mFehler:\x1b[0m Kein globales fetch verfuegbar. Node 18+ noetig.');
  process.exit(2);
}

// --- Ergebnis-Sammler ---------------------------------------------------------

const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
  const tag =
    status === 'pass' ? '\x1b[32mPASS\x1b[0m' :
    status === 'skip' ? '\x1b[33mSKIP\x1b[0m' :
                        '\x1b[31mFAIL\x1b[0m';
  console.log('[' + tag + '] ' + name + (detail ? ' -- ' + detail : ''));
}

// --- HTTP-Helfer --------------------------------------------------------------

async function req(path, { method = 'GET', body, auth = true, timeoutMs = TIMEOUT_MS, accept } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = 'Bearer ' + TOKEN;
    if (accept) headers.Accept = accept;
    return await fetch(BASE_URL + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
}

async function safeJson(r) { try { return await r.json(); } catch { return null; } }

// --- Einzeltests --------------------------------------------------------------

async function testCockpit() {
  const name = 'GET /cockpit (statisches Frontend)';
  try {
    const r = await req('/cockpit', { auth: false });
    if (r.status !== 200) return record(name, 'fail', 'Status ' + r.status);
    const ct = r.headers.get('content-type') || '';
    if (!/html/i.test(ct)) return record(name, 'fail', 'Content-Type ' + ct);
    const text = await r.text();
    if (!text.includes('IVA')) return record(name, 'fail', 'HTML enthaelt kein "IVA"');
    record(name, 'pass', 'HTML geliefert (' + text.length + ' B)');
  } catch (e) { record(name, 'fail', e.message); }
}

async function testTelegramWebhook() {
  const name = 'POST /telegram (Webhook erreichbar)';
  try {
    // Leere Payload -> Handler antwortet sofort 200 und macht nichts weiter.
    const r = await req('/telegram', { method: 'POST', body: {}, auth: false });
    if (r.status !== 200) return record(name, 'fail', 'Status ' + r.status);
    record(name, 'pass', 'antwortet 200 auf leere Payload');
  } catch (e) { record(name, 'fail', e.message); }
}

async function testAuthRequired() {
  const name = 'Bearer-Auth erzwungen (/api ohne Token = 401)';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(BASE_URL + '/api/todos', { method: 'GET', signal: ctrl.signal });
    if (r.status !== 401) return record(name, 'fail', 'ohne Token Status ' + r.status);
    record(name, 'pass');
  } catch (e) {
    record(name, 'fail', e.message);
  } finally {
    clearTimeout(timer);
  }
}

async function testTodos() {
  const name = 'GET /api/todos';
  try {
    const r = await req('/api/todos');
    if (r.status !== 200) return record(name, 'fail', 'Status ' + r.status);
    const j = await safeJson(r);
    if (!Array.isArray(j)) return record(name, 'fail', 'Antwort ist kein Array');
    record(name, 'pass', j.length + ' offene Todos');
  } catch (e) { record(name, 'fail', e.message); }
}

async function testCalendar() {
  const name = 'GET /api/calendar';
  try {
    const r = await req('/api/calendar');
    if (r.status !== 200) return record(name, 'fail', 'Status ' + r.status);
    const j = await safeJson(r);
    if (!Array.isArray(j)) return record(name, 'fail', 'Antwort ist kein Array');
    record(name, 'pass', j.length + ' Eintraege in 7 Tagen');
  } catch (e) { record(name, 'fail', e.message); }
}

async function testCalendly() {
  const name = 'GET /api/calendly';
  try {
    const r = await req('/api/calendly');
    if (r.status !== 200) return record(name, 'fail', 'Status ' + r.status);
    const j = await safeJson(r);
    if (!j || typeof j !== 'object') return record(name, 'fail', 'keine Objekt-Antwort');
    if (j.fehler) {
      // Server-seitige Fehler-Strings (z.B. "kein CALENDLY_TOKEN" oder "401: <api-body>").
      // Auf 200 Zeichen kappen, damit keine unerwartet langen Provider-Antworten geloggt werden.
      const msg = String(j.fehler).replace(/\s+/g, ' ').trim().slice(0, 200);
      return record(name, 'fail', 'Backend meldet Fehler: ' + msg);
    }
    if (typeof j.count !== 'number' || !Array.isArray(j.events)) {
      return record(name, 'fail', 'Shape { count, events } fehlt');
    }
    record(name, 'pass', j.count + ' Buchungen');
  } catch (e) { record(name, 'fail', e.message); }
}

async function testMails() {
  const name = 'GET /api/mails';
  try {
    const r = await req('/api/mails');
    if (r.status !== 200) return record(name, 'fail', 'Status ' + r.status);
    const j = await safeJson(r);
    if (!Array.isArray(j)) return record(name, 'fail', 'Antwort ist kein Array');
    record(name, 'pass', j.length + ' Nachrichten');
  } catch (e) { record(name, 'fail', e.message); }
}

async function testLeads() {
  const name = 'GET /api/leads';
  try {
    const r = await req('/api/leads');
    if (r.status !== 200) return record(name, 'fail', 'Status ' + r.status);
    const j = await safeJson(r);
    if (!Array.isArray(j)) return record(name, 'fail', 'Antwort ist kein Array');
    const bad = j.find(x => !x || typeof x.projekt !== 'string' || typeof x.gruppe !== 'string');
    if (bad) return record(name, 'fail', 'Eintrag ohne projekt/gruppe');
    record(name, 'pass', j.length + ' Quellen');
  } catch (e) { record(name, 'fail', e.message); }
}

async function testChat() {
  const name = 'POST /api/chat';
  if (!INCLUDE_CHAT) return record(name, 'skip', 'SMOKE_INCLUDE_CHAT!=1 (LLM-Kosten)');
  try {
    const r = await req('/api/chat', {
      method: 'POST',
      body: {
        message: 'Ping vom Smoke-Test. Bitte kurz mit "ok" antworten.',
        sessionId: '__smoke__',
        voice: false,
      },
      timeoutMs: CHAT_TIMEOUT_MS,
    });
    if (r.status !== 200) return record(name, 'fail', 'Status ' + r.status);
    const j = await safeJson(r);
    if (!j || typeof j.reply !== 'string' || !j.reply.trim()) {
      return record(name, 'fail', '{reply} fehlt/leer');
    }
    record(name, 'pass', 'Reply-Laenge ' + j.reply.length);
  } catch (e) { record(name, 'fail', e.message); }
}

async function testSpeak() {
  const name = 'POST /api/speak';
  if (!INCLUDE_SPEAK) return record(name, 'skip', 'SMOKE_INCLUDE_SPEAK!=1 (ElevenLabs-Kosten)');
  try {
    const r = await req('/api/speak', {
      method: 'POST',
      body: { text: 'Smoke Test.' },
      accept: 'audio/mpeg',
    });
    // 204 heisst: Server hat kein Audio zurueckgeliefert (kein TTS-Provider, TTS-Fehler,
    // oder Text leer). Wenn Speak scharf geschaltet ist, ist das kein Erfolg.
    if (r.status === 204) return record(name, 'fail', '204 (kein Audio geliefert)');
    if (r.status !== 200) return record(name, 'fail', 'Status ' + r.status);
    const ct = r.headers.get('content-type') || '';
    if (!/audio\//i.test(ct)) return record(name, 'fail', 'Content-Type ' + ct);
    const buf = await r.arrayBuffer();
    if (!buf.byteLength) return record(name, 'fail', 'leerer Audio-Body');
    record(name, 'pass', 'Audio ' + buf.byteLength + ' B (' + ct + ')');
  } catch (e) { record(name, 'fail', e.message); }
}

// --- Maskierung fuer Log-Ausgabe ---------------------------------------------

function maskedOrigin() {
  try { return new URL(BASE_URL).origin; } catch { return '(ungueltige URL)'; }
}
function maskedToken() {
  if (TOKEN.length <= 6) return '***';
  return TOKEN.slice(0, 3) + '...' + TOKEN.slice(-2);
}

// --- Runner -------------------------------------------------------------------

(async () => {
  console.log('IVA Smoke Test');
  console.log('  Ziel:   ' + maskedOrigin() + ' (Quelle: ' + BASE_URL_SOURCE + ')');
  console.log('  Token:  ' + maskedToken() + ' (Laenge ' + TOKEN.length + ', Quelle: ' + TOKEN_SOURCE + ')');
  console.log('  Chat:   ' + (INCLUDE_CHAT ? 'aktiv' : 'skip (setze SMOKE_INCLUDE_CHAT=1)'));
  console.log('  Speak:  ' + (INCLUDE_SPEAK ? 'aktiv' : 'skip (setze SMOKE_INCLUDE_SPEAK=1)'));
  console.log('');

  await testCockpit();
  await testTelegramWebhook();
  await testAuthRequired();
  await testTodos();
  await testCalendar();
  await testCalendly();
  await testMails();
  await testLeads();
  await testChat();
  await testSpeak();

  const pass = results.filter(r => r.status === 'pass').length;
  const skip = results.filter(r => r.status === 'skip').length;
  const fail = results.filter(r => r.status === 'fail').length;

  console.log('');
  console.log('Summary: ' + pass + ' PASS, ' + fail + ' FAIL, ' + skip + ' SKIP  (' + results.length + ' total)');
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => {
  console.error('\x1b[31mRunner-Fehler:\x1b[0m ' + e.message);
  process.exit(2);
});
