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
    execute: async ({ text }) => { const m = await loadMemory(); m.todos = m.todos || [];
