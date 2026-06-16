import 'dotenv/config';
import express from 'express';
import fs from 'fs/promises';
import ical from 'node-ical';
import cron from 'node-cron';
import { ImapFlow } from 'imapflow';
import { generateText, tool } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';

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
      for await (const m of client.fetch(`${start}:*`, { envelope: true, flags: true })) {
        out.push({ konto: acc.label, von: m.envelope?.from?.[0]?.address || '', betreff: m.envelope?.subject || '(kein Betreff)', ungelesen: !m.flags?.has('\\Seen') });
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
  getMails: tool({ description: 'Liest die neuesten E-Mails.', parameters: z.object({ proKonto: z.number().optional() }),
    execute: async ({ proKonto }) => { let all = []; for (const acc of loadMailAccounts()) { try { all = all.concat(await fetchInbox(acc, proKonto || 8)); } catch (e) { all.push({ konto: acc.label, fehler: e.message }); } } return { count: all.length, mails: all }; } }),
  getLeads: tool({ description: 'Ruft Leads ab. Ohne projekt: alle. Mit projekt (z.B. HeatHero, Versuro): nur dieses.', parameters: z.object({ projekt: z.string().optional() }),
    execute: async ({ projekt }) => {
      let list = await fetchAllLeads();
      if (projekt) list = list.filter(x => x.projekt.toLowerCase().includes(projekt.toLowerCase()));
      return list.map(x => ({ projekt: x.projekt, gruppe: x.gruppe, fehler: x.fehler, leads: x.leads ? JSON.stringify(x.leads).slice(0, 5000) : null }));
    } }),
};

async function askIva(userText) {
  const system = await buildSystemPrompt();
  const { text } = await generateText({ model: anthropic('claude-sonnet-4-6'), system, prompt: userText, tools, maxSteps: 6 });
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
    system: 'Du bist IVA. Morning-Briefing auf Deutsch fuer Telegram. **Fett** nur fuer Ueberschriften, KEINE Tabellen, kurze Zeilen mit Bindestrich. Aufbau: kurze Begruessung, **Termine heute**, **Offene Todos**, dann **Arbeit – HeatHero**, danach **Mein CRM (privat)** mit den Unterprojekten. Je Projekt die Kategorien (nur nicht-leere zeigen): Neue unbearbeitete Leads, Follow-Ups heute, Wiedervorlagen heute, Ohne Update nach Termin, Status "Montage terminieren". Pro Lead: Name + kurzer Grund. Leere Projekte weglassen. Motivierender Schlusssatz.',
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
    await sendTelegram(chatId, await askIva(userText));
  } catch (e) { console.error('Fehler:', e); }
});

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
