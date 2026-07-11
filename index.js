import 'dotenv/config';
import express from 'express';
import fs from 'fs/promises';
import ical from 'node-ical';
import cron from 'node-cron';
import { ImapFlow } from 'imapflow';
import { generateText, tool } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import * as campaigns from './marketing/campaigns.js';
import { analyzeReferences } from './marketing/analyze.js';
import { generateImage } from './marketing/images.js';
import { generateContent } from './marketing/content.js';
import * as brands from './marketing/brands.js';
import { refineTone, analyzeWebsite } from './marketing/assist.js';

const app = express();
app.use(express.json());

const DATA_DIR = '/data';
const MEM_FILE = DATA_DIR + '/memory.json';
const HEATHERO_LEADS_URL = 'https://thbvjafssbealqsswhdv.supabase.co/functions/v1/api-gateway/v1/leads';
const MEINCRM_REST_URL = 'https://qqyoqshjwpkmerilhjus.supabase.co/rest/v1/leads';

const CRM_SOURCES = [
  { label: 'HeatHero', group: 'Arbeit', mode: 'gateway', projectId: null },
  { label: 'HeatHero (Mein CRM)', group: 'Mein CRM', mode: 'rest', projectId: process.env.HEATHERO_PROJECT_ID },
  { label: 'Goals & Concepts', group: 'Mein CRM', mode: 'rest', projectId: process.env.GOALS_CONCEPTS_PROJECT_ID },
  { label: 'Koop Steuerberater', group: 'Mein CRM', mode: 'rest', projectId: process.env.KOOP_STEUERBERATER_PROJECT_ID },
  { label: 'Sol', group: 'Mein CRM', mode: 'rest', projectId: process.env.SOL_PROJECT_ID },
  { label: 'Versuro', group: 'Mein CRM', mode: 'rest', projectId: process.env.VERSURO_PROJECT_ID },
];

const MAIL_BEREICHE = [
  { match: 'heat-hero.com', label: 'HeatHero' },
  { match: 'goalsandconcepts.de', label: 'Goals & Concepts' },
  { match: 'sol-living.de', label: 'Sol Living' },
  { match: 'sell.nadine@outlook.de', label: 'Privat (Outlook)' },
];
function bereichFor(an) {
  const s = (an || '').toLowerCase();
  for (const b of MAIL_BEREICHE) if (s.includes(b.match)) return b.label;
  return 'Sonstige';
}

async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}
function safeJson(t) { try { return JSON.parse(t); } catch { return t.slice(0, 1500); } }

async function loadMemory() {
  try { return JSON.parse(await fs.readFile(MEM_FILE, 'utf8')); } catch { return { todos: [], notes: [] }; }
}
async function saveMemory(mem) {
  await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  await fs.writeFile(MEM_FILE, JSON.stringify(mem, null, 2));
}

// --- Gespraechs-Gedaechtnis (pro Session/Chat), eigene Datei, stoert die Todos/Notizen nicht ---
const CONV_FILE = DATA_DIR + '/conversations.json';
const MAX_TURNS = 16; // letzte 16 Nachrichten (8 Paare) als Kontext je Session
async function loadConversations() {
  try { return JSON.parse(await fs.readFile(CONV_FILE, 'utf8')); } catch { return {}; }
}
async function saveConversations(c) {
  await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  await fs.writeFile(CONV_FILE, JSON.stringify(c, null, 2));
}

const CALENDARS = [
  { label: 'Privat', url: process.env.PRIVAT_GOOGLE_ICS_URL },
  { label: 'Familie', url: process.env.FAMILIE_GOOGLE_ICS_URL },
  { label: 'Projekte', url: process.env.PROJEKTE_GOOGLE_ICS_URL },
  { label: 'Outlook', url: process.env.OUTLOOK_ICS_URL },
];
function fmtDate(d) { return d.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }); }
function berlinDay(d) { return d.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' }); }
function fmtEvents(arr) { return arr.map(e => `${e.label} · ${fmtDate(e.start)} – ${e.summary}`); }
async function getEventsRaw(days) {
  const now = new Date(); const until = new Date(now.getTime() + days * 86400000);
  const lists = await Promise.all(CALENDARS.filter(c => c.url).map(async cal => {
    const out = [];
    try {
      const data = await ical.async.fromURL(cal.url);
      for (const e of Object.values(data)) {
        if (e.type !== 'VEVENT') continue;
        if (e.rrule) { for (const d of e.rrule.between(now, until)) out.push({ start: d, label: cal.label, summary: e.summary || '(ohne Titel)' }); }
        else if (e.start) { const s = new Date(e.start); if (s >= now && s <= until) out.push({ start: s, label: cal.label, summary: e.summary || '(ohne Titel)' }); }
      }
    } catch (err) { console.error('ICS-Fehler:', err.message); }
    return out;
  }));
  return lists.flat().sort((a, b) => a.start - b.start);
}

async function calendlyGet(path) {
  const r = await fetchWithTimeout('https://api.calendly.com' + path, { headers: { Authorization: 'Bearer ' + process.env.CALENDLY_TOKEN, 'Content-Type': 'application/json' } }, 8000);
  if (!r.ok) throw new Error(r.status + ': ' + (await r.text()).slice(0, 150));
  return r.json();
}
async function getCalendlyEvents(days) {
  if (!process.env.CALENDLY_TOKEN) return { fehler: 'kein CALENDLY_TOKEN' };
  try {
    const me = await calendlyGet('/users/me');
    const userUri = me.resource.uri;
    const now = new Date().toISOString();
    const max = new Date(Date.now() + (days || 14) * 86400000).toISOString();
    const data = await calendlyGet(`/scheduled_events?user=${encodeURIComponent(userUri)}&status=active&min_start_time=${now}&max_start_time=${max}&sort=start_time:asc&count=20`);
    const events = await Promise.all((data.collection || []).map(async ev => {
      let bucher = '';
      try {
        const uuid = ev.uri.split('/').pop();
        const inv = await calendlyGet(`/scheduled_events/${uuid}/invitees`);
        bucher = (inv.collection || []).map(i => i.name).filter(Boolean).join(', ');
      } catch {}
      return { wann: fmtDate(new Date(ev.start_time)), termin: ev.name, bucher, ort: ev.location?.location || ev.location?.type || '' };
    }));
    return { count: events.length, events };
  } catch (e) { return { fehler: e.message }; }
}

function hostFor(user, override) {
  if (override) return override;
  const d = (user.split('@')[1] || '').toLowerCase();
  if (d.includes('gmail') || d.includes('googlemail')) return 'imap.gmail.com';
  if (['outlook', 'hotmail', 'live', 'msn'].some(x => d.includes(x))) return 'outlook.office365.com';
  if (d.includes('gmx')) return 'imap.gmx.net';
  if (d.includes('web.de')) return 'imap.web.de';
  return null;
}
function loadMailAccounts() {
  const a = [];
  for (let i = 1; i <= 20; i++) {
    const user = process.env[`MAIL_${i}_USER`], pass = process.env[`MAIL_${i}_PASS`];
    if (!user || !pass) continue;
    const host = hostFor(user, process.env[`MAIL_${i}_HOST`]);
    if (host) a.push({ user, pass, host, label: process.env[`MAIL_${i}_LABEL`] || user });
  }
  return a;
}
async function fetchInbox(acc, limit) {
  const client = new ImapFlow({ host: acc.host, port: 993, secure: true, auth: { user: acc.user, pass: acc.pass }, logger: false });
  const out = []; await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const total = client.mailbox.exists;
    if (total > 0) {
      const start = Math.max(1, total - limit + 1);
      for await (const m of client.fetch(`${start}:*`, { envelope: true, flags: true, headers: ['delivered-to', 'x-original-to', 'x-forwarded-to', 'to'] })) {
        const toEnv = (m.envelope?.to || []).map(x => x.address);
        let hdr = ''; try { hdr = m.headers ? m.headers.toString() : ''; } catch {}
        const hdrAddrs = hdr.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g) || [];
        const an = [...new Set([...toEnv, ...hdrAddrs])].join(', ');
        out.push({ konto: acc.label, bereich: bereichFor(an), an, von: m.envelope?.from?.[0]?.address || '', betreff: m.envelope?.subject || '(kein Betreff)', ungelesen: !m.flags?.has('\\Seen') });
      }
    }
  } finally { lock.release(); await client.logout(); }
  return out.reverse();
}

async function fetchLeads(src) {
  try {
    if (src.mode === 'gateway') {
      const key = process.env.HEATHERO_API_KEY;
      if (!key) return { projekt: src.label, gruppe: src.group, fehler: 'kein HEATHERO_API_KEY' };
      const r = await fetchWithTimeout(HEATHERO_LEADS_URL, { headers: { 'X-API-Key': key } }, 8000);
      const t = await r.text();
      if (!r.ok) return { projekt: src.label, gruppe: src.group, fehler: r.status + ': ' + t.slice(0, 150) };
      return { projekt: src.label, gruppe: src.group, leads: safeJson(t) };
    } else {
      const key = process.env.MEINCRM_SERVICE_KEY;
      if (!key) return { projekt: src.label, gruppe: src.group, fehler: 'kein MEINCRM_SERVICE_KEY gesetzt' };
      if (!src.projectId) return { projekt: src.label, gruppe: src.group, fehler: 'keine Project-ID' };
      const url = `${MEINCRM_REST_URL}?project_id=eq.${encodeURIComponent(src.projectId)}&select=*&order=created_at.desc&limit=1000`;
      const r = await fetchWithTimeout(url, { headers: { apikey: key, Authorization: 'Bearer ' + key } }, 8000);
      const t = await r.text();
      if (!r.ok) return { projekt: src.label, gruppe: src.group, fehler: r.status + ': ' + t.slice(0, 150) };
      return { projekt: src.label, gruppe: src.group, leads: safeJson(t) };
    }
  } catch (e) {
    return { projekt: src.label, gruppe: src.group, fehler: e.name === 'AbortError' ? 'Timeout' : e.message };
  }
}
async function fetchAllLeads() {
  return await Promise.all(CRM_SOURCES.map(fetchLeads));
}

async function buildSystemPrompt() {
  const mem = await loadMemory();
  const notes = mem.notes?.length ? mem.notes.map(n => '- ' + n).join('\n') : '(noch nichts gemerkt)';
  const open = (mem.todos || []).filter(t => !t.done);
  const todoText = open.length ? open.map(t => '- ' + t.text).join('\n') : '(keine offenen)';
  return `Du bist IVA, der persoenliche Assistent von Nadine.
Charakter: Sparringspartner, kein Jasager. Loesungsorientiert, direkt, ehrlich.
Keine Moralkeule - bei Grauzonen Weg UND Haken in einem Satz, dann die Loesung.
Fasse dich kurz. Hoechstens eine Rueckfrage, nur wenn noetig.
Nutze deine Werkzeuge, statt nur darueber zu reden.
Telegram-Format: **Fett** NUR fuer Ueberschriften. KEINE Tabellen, keine ###-Header - kurze Zeilen mit Bindestrich.
E-Mails haben ein Feld "bereich" (HeatHero, Goals & Concepts, Sol Living, Privat) - nutze es zum Gruppieren/Filtern nach Firma.

Das hast du dir gemerkt:
${notes}

Offene Todos:
${todoText}`;
}

const tools = {
  createTodo: tool({ description: 'Legt ein neues Todo an.', parameters: z.object({ text: z.string() }),
    execute: async ({ text }) => { const m = await loadMemory(); m.todos = m.todos || []; m.todos.push({ text, done: false, ts: Date.now() }); await saveMemory(m); return { ok: true, text }; } }),
  completeTodo: tool({ description: 'Markiert ein Todo per Textsuche als erledigt.', parameters: z.object({ text: z.string() }),
    execute: async ({ text }) => { const m = await loadMemory(); const t = (m.todos || []).find(t => !t.done && t.text.toLowerCase().includes(text.toLowerCase())); if (t) { t.done = true; await saveMemory(m); return { ok: true, done: t.text }; } return { ok: false }; } }),
  remember: tool({ description: 'Merkt sich dauerhaft eine Info.', parameters: z.object({ fact: z.string() }),
    execute: async ({ fact }) => { const m = await loadMemory(); m.notes = m.notes || []; m.notes.push(fact); await saveMemory(m); return { ok: true, fact }; } }),
  getCalendar: tool({ description: 'Liest Termine aus den Kalendern.', parameters: z.object({ days: z.number().optional() }),
    execute: async ({ days }) => { const ev = fmtEvents(await getEventsRaw(days || 7)); return { count: ev.length, events: ev }; } }),
  getCalendly: tool({ description: 'Liest kommende Calendly-Buchungen.', parameters: z.object({ days: z.number().optional() }),
    execute: async ({ days }) => await getCalendlyEvents(days || 14) }),
  getMails: tool({ description: 'Liest die neuesten E-Mails. Feld "bereich" = Firma (aus Empfaenger).', parameters: z.object({ proKonto: z.number().optional() }),
    execute: async ({ proKonto }) => { let all = []; for (const acc of loadMailAccounts()) { try { all = all.concat(await fetchInbox(acc, proKonto || 12)); } catch (e) { all.push({ konto: acc.label, fehler: e.message }); } } return { count: all.length, mails: all }; } }),
  getLeads: tool({ description: 'Ruft Leads ab. Ohne projekt: alle. Mit projekt: nur dieses.', parameters: z.object({ projekt: z.string().optional() }),
    execute: async ({ projekt }) => {
      let list = await fetchAllLeads();
      if (projekt) list = list.filter(x => x.projekt.toLowerCase().includes(projekt.toLowerCase()));
      return list.map(x => ({ projekt: x.projekt, gruppe: x.gruppe, fehler: x.fehler, leads: x.leads ? JSON.stringify(x.leads).slice(0, 5000) : null }));
    } }),
  listCampaigns: tool({ description: 'Listet alle Marketing-Kampagnen.', parameters: z.object({}),
    execute: async () => ({ campaigns: await campaigns.listCampaigns() }) }),
  createCampaign: tool({ description: 'Legt eine Marketing-Kampagne an. type: content|lead-gen|ads. autonomy: observe|suggest|auto.', parameters: z.object({ name: z.string(), brand: z.string().optional(), type: z.enum(['content', 'lead-gen', 'ads']).optional(), references: z.array(z.string()).optional(), tone: z.string().optional(), targetChannel: z.string().optional(), autonomy: z.enum(['observe', 'suggest', 'auto']).optional() }),
    execute: async (input) => await campaigns.createCampaign(input) }),
  analyzeReferences: tool({ description: 'Analysiert Referenz-Konten (Instagram-Handles) und liefert ein Muster-Profil + Content-Ideen. Dauert ~30-60s (scrapt live via Apify).', parameters: z.object({ handles: z.array(z.string()), brand: z.string().optional() }),
    execute: async ({ handles, brand }) => await analyzeReferences(handles, { brand }) }),
  analyzeCampaign: tool({ description: 'Analysiert die Referenz-Konten einer bestehenden Kampagne (per id) und speichert das Muster-Profil in der Kampagne.', parameters: z.object({ id: z.string() }),
    execute: async ({ id }) => {
      const c = await campaigns.getCampaign(id);
      if (!c) return { ok: false, error: 'Kampagne nicht gefunden' };
      const res = await analyzeReferences(c.references, { brand: c.brand });
      if (res.ok) await campaigns.updateCampaign(id, { analysis: { profile: res.profile, accounts: res.accounts, at: new Date().toISOString() } });
      return res;
    } }),
  generateImage: tool({ description: 'Generiert ein Bild aus einem Prompt (fal.ai). model: schnell (guenstig, default) | flux | flux-pro | nanobanana (premium, stark bei Text im Bild). Gibt Bild-URLs zurueck.', parameters: z.object({ prompt: z.string(), model: z.string().optional(), numImages: z.number().optional() }),
    execute: async ({ prompt, model, numImages }) => await generateImage(prompt, { model: model || 'nanobanana', numImages: numImages || 1 }) }),
  generateContent: tool({ description: 'Erzeugt fertigen Content fuer eine Kampagne im gelernten Stil + Brand-Profil. format: reel (Reel-Skript, default) | image (Bild-Post) | email. Optionale Vorgabe (briefing).', parameters: z.object({ campaignId: z.string(), briefing: z.string().optional(), count: z.number().optional(), format: z.enum(['reel', 'image', 'email']).optional() }),
    execute: async ({ campaignId, briefing, count, format }) => {
      const c = await campaigns.getCampaign(campaignId);
      if (!c) return { ok: false, error: 'Kampagne nicht gefunden' };
      const brand = c.brandId ? await brands.getBrand(c.brandId) : null;
      return await generateContent(c, brand, { briefing, count: count || 3, format: format || 'reel' });
    } }),
  listBrands: tool({ description: 'Listet alle Marken-Profile (eigene + Referenz-Brands).', parameters: z.object({}),
    execute: async () => ({ brands: await brands.listBrands() }) }),
  createBrand: tool({ description: 'Legt ein Marken-Profil an. type: own (eigene Marke) | reference (Vorbild-Marke). Felder: name, website, instagram, linkedin, colors[], tone, audience.', parameters: z.object({ name: z.string(), type: z.enum(['own', 'reference']).optional(), website: z.string().optional(), instagram: z.string().optional(), linkedin: z.string().optional(), colors: z.array(z.string()).optional(), tone: z.string().optional(), audience: z.string().optional() }),
    execute: async (input) => await brands.createBrand(input) }),
  updateBrand: tool({ description: 'Aktualisiert ein Marken-Profil per id (beliebige Felder: name, website, instagram, linkedin, colors, tone, audience).', parameters: z.object({ id: z.string(), name: z.string().optional(), website: z.string().optional(), instagram: z.string().optional(), linkedin: z.string().optional(), colors: z.array(z.string()).optional(), tone: z.string().optional(), audience: z.string().optional() }),
    execute: async ({ id, ...patch }) => await brands.updateBrand(id, patch) }),
};

async function askIva(userText, sessionId = 'default') {
  const system = await buildSystemPrompt();
  const conv = await loadConversations();
  const history = Array.isArray(conv[sessionId]) ? conv[sessionId] : [];
  const messages = [...history, { role: 'user', content: userText }];
  const { text } = await generateText({ model: anthropic('claude-sonnet-4-6'), system, messages, tools, maxSteps: 6 });
  conv[sessionId] = [...messages, { role: 'assistant', content: text || '(ok)' }].slice(-MAX_TURNS);
  await saveConversations(conv);
  return text;
}

function toTelegramHTML(s) {
  s = String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}
async function sendTelegram(chatId, text) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: toTelegramHTML(text), parse_mode: 'HTML' }),
  });
}
async function transcribeVoice(fileId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const filePath = (await (await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`)).json()).result.file_path;
  const audioBuf = Buffer.from(await (await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)).arrayBuffer());
  const form = new FormData();
  form.append('file', new Blob([audioBuf]), 'voice.ogg');
  form.append('model', 'whisper-large-v3-turbo');
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body: form });
  return (await r.json()).text;
}

async function sendBriefing() {
  const mem = await loadMemory(); if (!mem.chatId) return;
  const today = berlinDay(new Date());
  const [evRaw, leadsAll] = await Promise.all([getEventsRaw(2), fetchAllLeads()]);
  const todays = evRaw.filter(e => berlinDay(e.start) === today);
  const eventsText = todays.length ? fmtEvents(todays).join('\n') : 'keine Termine';
  const open = (mem.todos || []).filter(t => !t.done).map(t => t.text);
  const todosText = open.length ? open.map(t => '- ' + t).join('\n') : 'keine offenen';
  const blocks = leadsAll.map(x => `[${x.gruppe} / ${x.projekt}]\n${x.fehler ? ('Fehler: ' + x.fehler) : JSON.stringify(x.leads).slice(0, 3500)}`);
  const { text } = await generateText({ model: anthropic('claude-haiku-4-5-20251001'),
    system: 'Du bist IVA. Morning-Briefing auf Deutsch fuer Telegram. **Fett** nur fuer Ueberschriften, KEINE Tabellen, kurze Zeilen mit Bindestrich. Aufbau: kurze Begruessung, **Termine heute**, **Offene Todos**, dann **Arbeit - HeatHero**, danach **Mein CRM (privat)** mit den Unterprojekten. Je Projekt die Kategorien (nur nicht-leere zeigen): Neue unbearbeitete Leads, Follow-Ups heute, Wiedervorlagen heute, Ohne Update nach Termin, Status "Montage terminieren". Pro Lead: Name + kurzer Grund. Leere Projekte weglassen. Motivierender Schlusssatz.',
    prompt: `Heute ist ${today}.\nTermine heute:\n${eventsText}\n\nOffene Todos:\n${todosText}\n\nLeads je Projekt (rohe Daten):\n${blocks.join('\n\n')}` });
  await sendTelegram(mem.chatId, text);
}

app.post('/telegram', async (req, res) => {
  const msg = req.body?.message; const chatId = msg?.chat?.id;
  res.sendStatus(200); if (!chatId) return;
  try {
    const mem = await loadMemory(); if (mem.chatId !== chatId) { mem.chatId = chatId; await saveMemory(mem); }
    let userText = msg?.text;
    if (!userText && msg?.voice) userText = await transcribeVoice(msg.voice.file_id);
    if (!userText) return;
    if (userText.trim().toLowerCase() === '/briefing') { await sendBriefing(); return; }
    if (userText.trim().toLowerCase() === '/reset') { const c = await loadConversations(); delete c[String(chatId)]; await saveConversations(c); await sendTelegram(chatId, 'Okay, ich hab unseren Gespraechsfaden zurueckgesetzt. Frischer Start.'); return; }
    await sendTelegram(chatId, await askIva(userText, String(chatId)));
  } catch (e) { console.error('Fehler:', e); }
});

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS' };
app.use('/api', (req, res, next) => {
  res.set(CORS);
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if ((req.headers.authorization || '') !== 'Bearer ' + (process.env.API_TOKEN || '')) return res.status(401).json({ error: 'unauthorized' });
  next();
});
app.get('/api/leads', async (_req, res) => res.json(await fetchAllLeads()));
app.get('/api/mails', async (_req, res) => { let all = []; for (const acc of loadMailAccounts()) { try { all = all.concat(await fetchInbox(acc, 15)); } catch (e) {} } res.json(all); });
app.get('/api/calendar', async (_req, res) => res.json(fmtEvents(await getEventsRaw(7))));
app.get('/api/calendly', async (_req, res) => res.json(await getCalendlyEvents(14)));
app.get('/api/todos', async (_req, res) => { const m = await loadMemory(); res.json((m.todos || []).filter(t => !t.done)); });
app.post('/api/todos', async (req, res) => { const m = await loadMemory(); m.todos = m.todos || []; m.todos.push({ text: req.body?.text || '', done: false, ts: Date.now() }); await saveMemory(m); res.json({ ok: true }); });
app.post('/api/todos/toggle', async (req, res) => { const m = await loadMemory(); const t = (m.todos || []).find(t => t.ts === req.body?.ts); if (t) { t.done = !t.done; await saveMemory(m); } res.json({ ok: true }); });
app.post('/api/chat', async (req, res) => { try { res.json({ reply: await askIva(req.body?.message || '', req.body?.sessionId || 'web') }); } catch (e) { res.json({ reply: 'Fehler: ' + e.message }); } });

// --- Marketing-Maschine: Kampagnen + Analyse-Engine ---
app.get('/api/campaigns', async (_req, res) => res.json(await campaigns.listCampaigns()));
app.get('/api/campaigns/:id', async (req, res) => { const c = await campaigns.getCampaign(req.params.id); res.status(c ? 200 : 404).json(c || { error: 'not found' }); });
app.post('/api/campaigns', async (req, res) => res.json(await campaigns.createCampaign(req.body || {})));
app.patch('/api/campaigns/:id', async (req, res) => { const c = await campaigns.updateCampaign(req.params.id, req.body || {}); res.status(c ? 200 : 404).json(c || { error: 'not found' }); });
app.delete('/api/campaigns/:id', async (req, res) => res.json({ ok: await campaigns.deleteCampaign(req.params.id) }));
app.post('/api/campaigns/:id/analyze', async (req, res) => {
  try {
    const c = await campaigns.getCampaign(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    const result = await analyzeReferences(c.references, { brand: c.brand });
    if (result.ok) await campaigns.updateCampaign(c.id, { analysis: { profile: result.profile, accounts: result.accounts, at: new Date().toISOString() } });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/analyze', async (req, res) => {
  try { res.json(await analyzeReferences(req.body?.handles || [], { brand: req.body?.brand || '' })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/generate-image', async (req, res) => {
  try { res.json(await generateImage(req.body?.prompt || '', { model: req.body?.model, imageSize: req.body?.imageSize, numImages: req.body?.numImages || 1 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/campaigns/:id/generate', async (req, res) => {
  try {
    const c = await campaigns.getCampaign(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    const brand = c.brandId ? await brands.getBrand(c.brandId) : null;
    res.json(await generateContent(c, brand, { briefing: req.body?.briefing || '', count: req.body?.count || 3, format: req.body?.format || 'reel' }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/brands', async (_req, res) => res.json(await brands.listBrands()));
app.get('/api/brands/:id', async (req, res) => { const b = await brands.getBrand(req.params.id); res.status(b ? 200 : 404).json(b || { error: 'not found' }); });
app.post('/api/brands', async (req, res) => res.json(await brands.createBrand(req.body || {})));
app.patch('/api/brands/:id', async (req, res) => { const b = await brands.updateBrand(req.params.id, req.body || {}); res.status(b ? 200 : 404).json(b || { error: 'not found' }); });
app.delete('/api/brands/:id', async (req, res) => res.json({ ok: await brands.deleteBrand(req.params.id) }));
// --- KI-Assistenz (Gemini, kostenlos) ---
app.post('/api/assist/tone', async (req, res) => { try { res.json(await refineTone(req.body?.text || '')); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/assist/website', async (req, res) => { try { res.json(await analyzeWebsite(req.body?.url || '')); } catch (e) { res.status(500).json({ error: e.message }); } });

async function setupTelegramWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN, domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (!token || !domain) return;
  try { const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook?url=https://${domain}/telegram`); console.log('Webhook:', await r.text()); }
  catch (e) { console.error('Webhook-Fehler:', e); }
}
async function setBotCommands() {
  const token = process.env.TELEGRAM_BOT_TOKEN; if (!token) return;
  const commands = [
    { command: 'briefing', description: 'Tagesueberblick jetzt senden' },
    { command: 'leads', description: 'Offene Leads / Handlungsbedarf' },
    { command: 'termine', description: 'Termine der Woche' },
    { command: 'calendly', description: 'Kommende Calendly-Buchungen' },
    { command: 'mails', description: 'Neue Mails zusammenfassen' },
    { command: 'todos', description: 'Offene Todos anzeigen' },
  ];
  try { await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commands }) }); }
  catch (e) { console.error('setMyCommands-Fehler:', e); }
}

cron.schedule('0 7 * * *', sendBriefing, { timezone: 'Europe/Berlin' });
app.get('/', (_req, res) => res.send('IVA laeuft.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('IVA-Core auf Port ' + PORT); setupTelegramWebhook(); setBotCommands(); });
