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

async function loadMemory() {
  try { return JSON.parse(await fs.readFile(MEM_FILE, 'utf8')); }
  catch { return { todos: [], notes: [] }; }
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

function fmtDate(d) {
  return d.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
}
function berlinDay(d) { return d.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' }); }
function fmtEvents(arr) { return arr.map(e => `${e.label} · ${fmtDate(e.start)} – ${e.summary}`); }

async function getEventsRaw(days) {
  const now = new Date();
  const until = new Date(now.getTime() + days * 86400000);
  const out = [];
  for (const cal of CALENDARS) {
    if (!cal.url) continue;
    try {
      const data = await ical.async.fromURL(cal.url);
      for (const e of Object.values(data)) {
        if (e.type !== 'VEVENT') continue;
        if (e.rrule) {
          for (const d of e.rrule.between(now, until)) out.push({ start: d, label: cal.label, summary: e.summary || '(ohne Titel)' });
        } else if (e.start) {
          const s = new Date(e.start);
          if (s >= now && s <= until) out.push({ start: s, label: cal.label, summary: e.summary || '(ohne Titel)' });
        }
      }
    } catch (err) { console.error('ICS-Fehler bei ' + cal.label + ':', err.message); }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

function hostFor(user, override) {
  if (override) return override;
  const d = (user.split('@')[1] || '').toLowerCase();
  if (d.includes('gmail') || d.includes('googlemail')) return 'imap.gmail.com';
  if (['outlook', 'hotmail', 'live', 'msn'].some(x => d.includes(x))) return 'outlook.office365.com';
  if (d.includes('gmx')) return 'imap.gmx.net';
  if (d.includes('web.de')) return 'imap.web.de';
  if (d.includes('yahoo')) return 'imap.mail.yahoo.com';
  return null;
}
function loadMailAccounts() {
  const accounts = [];
  for (let i = 1; i <= 20; i++) {
    const user = process.env[`MAIL_${i}_USER`];
    const pass = process.env[`MAIL_${i}_PASS`];
    if (!user || !pass) continue;
    const host = hostFor(user, process.env[`MAIL_${i}_HOST`]);
    if (host) accounts.push({ user, pass, host, label: process.env[`MAIL_${i}_LABEL`] || user });
  }
  return accounts;
}
async function fetchInbox(acc, limit) {
  const client = new ImapFlow({ host: acc.host, port: 993, secure: true, auth: { user: acc.user, pass: acc.pass }, logger: false });
  const out = [];
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const total = client.mailbox.exists;
    if (total > 0) {
      const start = Math.max(1, total - limit + 1);
      for await (const m of client.fetch(`${start}:*`, { envelope: true, flags: true })) {
        out.push({
          konto: acc.label,
          von: m.envelope?.from?.[0]?.address || '',
          betreff: m.envelope?.subject || '(kein Betreff)',
          ungelesen: !m.flags?.has('\\Seen'),
        });
      }
    }
  } finally { lock.release(); await client.logout(); }
  return out.reverse();
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

Das hast du dir gemerkt:
${notes}

Offene Todos:
${todoText}`;
}

const tools = {
  createTodo: tool({
    description: 'Legt ein neues Todo an.',
    parameters: z.object({ text: z.string() }),
    execute: async ({ text }) => {
      const mem = await loadMemory(); mem.todos = mem.todos || [];
      mem.todos.push({ text, done: false, ts: Date.now() }); await saveMemory(mem);
      return { ok: true, text };
    },
  }),
  completeTodo: tool({
    description: 'Markiert ein Todo per Textsuche als erledigt.',
    parameters: z.object({ text: z.string() }),
    execute: async ({ text }) => {
      const mem = await loadMemory();
      const t = (mem.todos || []).find(t => !t.done && t.text.toLowerCase().includes(text.toLowerCase()));
      if (t) { t.done = true; await saveMemory(mem); return { ok: true, done: t.text }; }
      return { ok: false, msg: 'nicht gefunden' };
    },
  }),
  remember: tool({
    description: 'Merkt sich dauerhaft eine Information (bereichsuebergreifend).',
    parameters: z.object({ fact: z.string() }),
    execute: async ({ fact }) => {
      const mem = await loadMemory(); mem.notes = mem.notes || [];
      mem.notes.push(fact); await saveMemory(mem);
      return { ok: true, fact };
    },
  }),
  getCalendar: tool({
    description: 'Liest Termine aus Nadines Kalendern fuer die naechsten Tage.',
    parameters: z.object({ days: z.number().optional().describe('Tage ab jetzt, 1 = heute, 7 = Woche') }),
    execute: async ({ days }) => {
      const events = fmtEvents(await getEventsRaw(days || 7));
      return { count: events.length, events };
    },
  }),
  getMails: tool({
    description: 'Liest die neuesten E-Mails aus allen Postfaechern (Betreff, Absender, gelesen/ungelesen).',
    parameters: z.object({ proKonto: z.number().optional().describe('Neueste Mails pro Postfach, Standard 8') }),
    execute: async ({ proKonto }) => {
      let all = [];
      for (const acc of loadMailAccounts()) {
        try { all = all.concat(await fetchInbox(acc, proKonto || 8)); }
        catch (e) { all.push({ konto: acc.label, fehler: e.message }); }
      }
      return { count: all.length, mails: all };
    },
  }),
};

async function askIva(userText) {
  const system = await buildSystemPrompt();
  const { text } = await generateText({
    model: anthropic('claude-sonnet-4-6'), system, prompt: userText, tools, maxSteps: 5,
  });
  return text;
}

async function sendTelegram(chatId, text) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function transcribeVoice(fileId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const filePath = (await fileRes.json()).result.file_path;
  const audioRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  const audioBuf = Buffer.from(await audioRes.arrayBuffer());
  const form = new FormData();
  form.append('file', new Blob([audioBuf]), 'voice.ogg');
  form.append('model', 'whisper-large-v3-turbo');
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body: form,
  });
  return (await r.json()).text;
}

async function sendBriefing() {
  const mem = await loadMemory();
  if (!mem.chatId) { console.log('Briefing: keine chatId.'); return; }
  const today = berlinDay(new Date());
  const todays = (await getEventsRaw(2)).filter(e => berlinDay(e.start) === today);
  const eventsText = todays.length ? fmtEvents(todays).join('\n') : 'keine Termine';
  const open = (mem.todos || []).filter(t => !t.done).map(t => t.text);
  const todosText = open.length ? open.map(t => '- ' + t).join('\n') : 'keine offenen';
  const { text } = await generateText({
    model: anthropic('claude-sonnet-4-6'),
    system: 'Du bist IVA. Schreibe ein kurzes, motivierendes Morning-Briefing auf Deutsch. Max 6 Zeilen, klare Prioritaeten, knackiger Schlusssatz. Kein Fuelltext.',
    prompt: `Termine heute:\n${eventsText}\n\nOffene Todos:\n${todosText}`,
  });
  await sendTelegram(mem.chatId, text);
}

app.post('/telegram', async (req, res) => {
  const msg = req.body?.message;
  const chatId = msg?.chat?.id;
  res.sendStatus(200);
  if (!chatId) return;
  try {
    const mem = await loadMemory();
    if (mem.chatId !== chatId) { mem.chatId = chatId; await saveMemory(mem); }
    let userText = msg?.text;
    if (!userText && msg?.voice) userText = await transcribeVoice(msg.voice.file_id);
    if (!userText) return;
    if (userText.trim().toLowerCase() === '/briefing') { await sendBriefing(); return; }
    const reply = await askIva(userText);
    await sendTelegram(chatId, reply);
  } catch (e) { console.error('Fehler:', e); }
});

async function setupTelegramWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (!token || !domain) { console.log('Telegram: Token/Domain fehlt.'); return; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook?url=https://${domain}/telegram`);
    console.log('Telegram-Webhook:', await r.text());
  } catch (e) { console.error('Webhook-Fehler:', e); }
}

cron.schedule('0 7 * * *', sendBriefing, { timezone: 'Europe/Berlin' });

app.get('/', (_req, res) => res.send('IVA laeuft.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('IVA-Core auf Port ' + PORT); setupTelegramWebhook(); });
