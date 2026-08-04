import 'dotenv/config';
import express from 'express';
import fs from 'fs/promises';
import ical from 'node-ical';
import cron from 'node-cron';
import { ImapFlow } from 'imapflow';
import { generateText, streamText } from 'ai';
import * as campaigns from './marketing/campaigns.js';
import { analyzeReferences } from './marketing/analyze.js';
import { generateImage } from './marketing/images.js';
import { generateContent } from './marketing/content.js';
import * as brands from './marketing/brands.js';
import { refineTone, analyzeWebsite } from './marketing/assist.js';
import { klassifiziereMailBatch } from './klassifikation.js';
// Stufe 1-3: Model Router, Skills, Agent-Registry.
import { chooseModel, recordUsage, checkBudget } from './core/router.js';
import { memorySkill } from './skills/memory.js';
import { calendarSkill } from './skills/calendar.js';
import { mailsSkill } from './skills/mails.js';
import { crmSkill } from './skills/crm.js';
import { marketingSkill } from './skills/marketing.js';
import { researchSkill } from './skills/research.js';
import { workspacesSkill } from './skills/workspaces.js';
import { qonektoSkill } from './skills/qonekto.js';
import { adviceSkill } from './skills/advice.js';
import { getAgent } from './agents/registry.js';
import { marketAnalysis } from './marketing/market.js';
import { fetchMetaAdsInsights, marketingConnectorStatus } from './marketing/connectors.js';
import { listResearchRuns, listResearchedCompanies, runMarketIntelligence } from './marketing/intelligence.js';
import { approveAdRecommendation, createContentPlan, createEmailCampaign, createMarketingReport, listMarketingCollection, recordAdSnapshot } from './marketing/planning.js';
import { speak } from './voice.js';
import { askArchitect } from './agents/architect.js';
import * as workspaces from './workspaces/store.js';
import { createTmbPdf } from './workspaces/tmb-pdf.js';
import { calculateHeatLoad, calculateKfw458Funding, ENERGY_SOURCES } from './workspaces/energy-calculations.js';
import {
  qonektoStatus,
  listQonektoTools,
  callQonektoReadTool,
  prepareQonektoWriteAction,
  handleQonektoConfirmation,
} from './integrations/qonekto.js';
import {
  getQonektoCustomerDetail,
  getQonektoCustomerReferences,
  invalidateQonektoCustomerCache,
  listQonektoCustomers,
  prepareQonektoCustomerAction,
  qonektoCustomerCapabilityStatus,
  upsertQonektoCustomerAutomatically,
} from './integrations/qonekto-customers.js';
import { crmQonektoSyncStatus, runCrmQonektoSync } from './integrations/crm-qonekto-sync.js';
import { extractWhatsAppMessages, sendWhatsAppText, verifyWhatsAppChallenge, verifyWhatsAppSignature, whatsappStatus } from './integrations/whatsapp.js';
import {
  getWhatsAppHubMe,
  listWhatsAppHubAccounts,
  listWhatsAppHubChats,
  listWhatsAppHubTemplates,
  whatsappHubStatus,
} from './integrations/whatsapp-hub.js';
import { handleWhatsAppMessage } from './integrations/whatsapp-agent.js';
import {
  createWhatsAppProfile,
  deleteWhatsAppProfile,
  listClaimIntakes,
  listWhatsAppProfiles,
  updateWhatsAppProfile,
} from './integrations/whatsapp-store.js';
import { adviceConnectorStatus, publicAdviceCatalog } from './advice/catalog.js';
import { addAdviceKnowledgeSource, adviceKnowledgeStatus, listAdviceKnowledge } from './advice/knowledge-store.js';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
app.use(express.json({
  verify(req, _res, buffer) {
    if (req.originalUrl?.startsWith('/webhooks/whatsapp')) req.rawBody = Buffer.from(buffer);
  },
}));

const DATA_DIR = process.env.DATA_DIR || '/data';
const MEM_FILE = DATA_DIR + '/memory.json';
const HEATHERO_LEADS_URL = 'https://thbvjafssbealqsswhdv.supabase.co/functions/v1/api-gateway/v1/leads';
const MEINCRM_REST_URL = 'https://qqyoqshjwpkmerilhjus.supabase.co/rest/v1/leads';

const CRM_SOURCES = [
  { label: 'Heat Hero CRM (eigenstaendig)', group: 'Arbeit', mode: 'gateway', projectId: null },
  { label: 'Heat Hero (im Multi CRM)', group: 'Mein CRM', mode: 'rest', projectId: process.env.HEATHERO_PROJECT_ID },
  { label: 'Goals & Concepts', group: 'Mein CRM', mode: 'rest', projectId: process.env.GOALS_CONCEPTS_PROJECT_ID },
  { label: 'Koop Steuerberater', group: 'Mein CRM', mode: 'rest', projectId: process.env.KOOP_STEUERBERATER_PROJECT_ID },
  { label: 'Sol', group: 'Mein CRM', mode: 'rest', projectId: process.env.SOL_PROJECT_ID },
  { label: 'Versuro', group: 'Mein CRM', mode: 'rest', projectId: process.env.VERSURO_PROJECT_ID },
];
const GOALS_CONCEPTS_CRM_SOURCE = CRM_SOURCES.find(source => source.label === 'Goals & Concepts');

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
// Gemeinsamer Zusatz an den System-Prompt fuer sprach-getriggerte Anfragen.
// Wird identisch von askIva (Telegram) und streamIva (Cockpit-Stream) angehaengt.
const VOICE_SYSTEM_SUFFIX = '\n\nWICHTIG – diese Anfrage kam per SPRACHE: Deine Antwort wird von ElevenLabs auf Deutsch vorgelesen. Formuliere sie als natuerliche gesprochene Prosa, wie du sie einem intelligenten Menschen ins Gesicht sagen wuerdest. Nutze kurze, fluessige Saetze und vermeide Schachtelsaetze. KEINE Markdown-Formatierung – keine Sternchen, keine Fett-Ueberschriften, keine Backticks, keine Aufzaehlungszeichen, keine Bindestrich-Listen, keine nummerierten Listen, keine Tabellen, keine Emojis. KEINE URLs, Dateipfade oder E-Mail-Adressen vorlesen – wenn eine Quelle wichtig ist, nenne den Betreiber in Worten oder sag "eine offizielle Quelle". Zahlen und Abkuerzungen so schreiben, dass ElevenLabs sie auf Deutsch natuerlich ausspricht: Datum und Uhrzeit ausschreiben (also "einunddreissigster Dezember" statt "31.12.", "vierzehn Uhr" statt "14:00"), grosse Zahlen entweder in Worten oder als reine Ziffern OHNE Punkt-Tausender-Trennung (also "siebenundsiebzigtausendvierhundert Euro" oder notfalls "77400 Euro", aber NIEMALS "77.400 EUR"), Prozente ausformulieren (also "fuenfundzwanzig Prozent"), Paragraphen und gaengige Kuerzel ausschreiben (also "Paragraph zweiunddreissig a" statt Paragraphenzeichen plus Zahl, "zum Beispiel" statt "z.B.", "und so weiter" statt "usw."). Schwer aussprechbare deutsche Komposita und Fach-Abkuerzungen automatisch in gesprochene Alltagssprache uebersetzen — Beispiele: "Jahresarbeitsentgeltgrenze" wird zu "Einkommensgrenze fuer die gesetzliche Krankenversicherung", "PKV" wird zu "private Krankenversicherung", "GKV" wird zu "gesetzliche Krankenversicherung", "BBG" wird zu "Beitragsbemessungsgrenze", "bAV" wird zu "betriebliche Altersvorsorge", "bKV" wird zu "betriebliche Krankenversicherung". Der INHALT bleibt identisch, nur die Formulierung wird verstaendlicher. Fremdwoerter und englische Begriffe nur, wenn wirklich noetig – sonst verstaendlich deutsch formulieren. NIEMALS schaetzen. Wenn keine verlaessliche Information vorliegt (etwa weil askArchitect / web-research nichts Belastbares geliefert hat oder overallConfidence "unknown" bzw. unverifiedNotice gesetzt ist), sag exakt: "Ich konnte dazu gerade keine verlaessliche Information finden." — kein "vermutlich", kein "schaetze grob", kein "soweit ich weiss", kein "muesste". KEINE Einleitungsfloskeln wie "Gerne", "Natuerlich" oder "Selbstverstaendlich". KEINE Schlussfloskeln wie "Kann ich sonst noch helfen?". Der INHALT bleibt vollstaendig – es wird ausschliesslich die Formulierung fuer Sprache optimiert, nichts weglassen, nichts erfinden.';
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
async function fetchInbox(acc, limit, folder = 'INBOX') {
  const client = new ImapFlow({ host: acc.host, port: 993, secure: true, auth: { user: acc.user, pass: acc.pass }, logger: false });
  const mailbox = String(folder || 'INBOX').trim() || 'INBOX';
  const out = []; await client.connect();
  const lock = await client.getMailboxLock(mailbox);
  try {
    const total = client.mailbox.exists;
    if (total > 0) {
      const start = Math.max(1, total - limit + 1);
      for await (const m of client.fetch(`${start}:*`, { envelope: true, flags: true, headers: ['delivered-to', 'x-original-to', 'x-forwarded-to', 'to'] })) {
        const toEnv = (m.envelope?.to || []).map(x => x.address);
        let hdr = ''; try { hdr = m.headers ? m.headers.toString() : ''; } catch {}
        const hdrAddrs = hdr.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g) || [];
        const an = [...new Set([...toEnv, ...hdrAddrs])].join(', ');
        out.push({
          konto: acc.label,
          ordner: mailbox,
          bereich: bereichFor(an),
          an,
          von: m.envelope?.from?.[0]?.address || '',
          von_name: m.envelope?.from?.[0]?.name || '',
          betreff: m.envelope?.subject || '(kein Betreff)',
          datum: m.envelope?.date?.toISOString?.() || null,
          ungelesen: !m.flags?.has('\\Seen'),
        });
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

async function syncStrategyCustomersToQonekto({ force = false } = {}) {
  return runCrmQonektoSync({
    fetchLeads: () => fetchLeads(GOALS_CONCEPTS_CRM_SOURCE),
    upsertCustomer: upsertQonektoCustomerAutomatically,
    force,
  });
}

async function heatHeroGateway(path = '', { method = 'GET', body } = {}) {
  const key = process.env.HEATHERO_API_KEY;
  if (!key) throw new Error('kein HEATHERO_API_KEY gesetzt');
  const r = await fetchWithTimeout(`${HEATHERO_LEADS_URL}${path}`, {
    method,
    headers: {
      'X-API-Key': key,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, 8000);
  const text = await r.text();
  const payload = safeJson(text);
  if (!r.ok) {
    const message = payload && typeof payload === 'object' && payload.error
      ? payload.error
      : `${r.status}: ${String(text).slice(0, 200)}`;
    throw new Error(message);
  }
  return payload;
}

async function searchHeatHeroLeads(search, limit = 20) {
  const params = new URLSearchParams({ search: String(search || '').trim(), limit: String(Math.min(Math.max(limit || 20, 1), 50)) });
  const payload = await heatHeroGateway(`?${params.toString()}`);
  return { system: 'Heat Hero CRM (eigenstaendig)', count: payload?.count ?? payload?.data?.length ?? 0, leads: payload?.data ?? [] };
}

async function updateHeatHeroLeadStatus(id, status, reason) {
  const leadId = encodeURIComponent(String(id));
  const current = await heatHeroGateway(`/${leadId}`);
  const oldStatus = current?.data?.status_detail ?? null;
  const updated = await heatHeroGateway(`/${leadId}`, { method: 'PATCH', body: { status_detail: status } });
  const note = `IVA: Status von "${oldStatus ?? 'unbekannt'}" auf "${status}" geaendert.${reason ? ` Anlass: ${reason}` : ''}`;
  let noteSaved = true;
  try {
    await heatHeroGateway(`/${leadId}/notes`, { method: 'POST', body: { content: note } });
  } catch (_) {
    noteSaved = false;
  }
  return {
    system: 'Heat Hero CRM (eigenstaendig)',
    lead: updated?.data ?? updated,
    alter_status: oldStatus,
    neuer_status: status,
    protokollnotiz_gespeichert: noteSaved,
  };
}

async function buildSystemPrompt() {
  const mem = await loadMemory();
  const notes = mem.notes?.length ? mem.notes.map(n => '- ' + n).join('\n') : '(noch nichts gemerkt)';
  const open = (mem.todos || []).filter(t => !t.done);
  const todoText = open.length ? open.map(t => '- ' + t.text).join('\n') : '(keine offenen)';
  const jetzt = new Date().toLocaleString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
  return `Du bist IVA, der persönliche KI-Sparringspartner von Nadine.

Du bist ihre rechte Hand: Senior Business Partner, operative Unterstützung, Fach-Sounding-Board. Kein Assistent im Service-Sinn, kein Erklärautomat.

So sprichst du:

- Direkt, intelligent, locker. Humor ja, aber nie auf Kosten der Antwort.
- Kein Gelaber, kein KI-Geschwafel. Nie "Als KI…", nie "Ich bin ein Assistent…", nie Rollen-Hinweise.
- Zeitloses Allgemeinwissen beantwortest du direkt aus eigenem Wissen. Nie "dafür gibt es Google", nie "das ist nicht mein Bereich".
- Fragen nach AKTUELLEN konkreten Fakten (Gesetze, Grenzwerte, Steuersätze, Freibeträge, Sozialversicherungs-Beiträge, Beitragsbemessungsgrenzen, Fördersätze, Preise, Nachrichten, Produktdaten, Öffnungszeiten): NIEMALS aus dem Kopf antworten, NIEMALS schätzen, NIEMALS "vermutlich" / "schätze grob" / "soweit ich weiß" / "das müsste …". IMMER zwingend askArchitect aufrufen — der routet an web-research. Wenn web-research keine belastbare Antwort liefert (overallConfidence "unknown" ODER unverifiedNotice gesetzt): antworte wörtlich "Ich konnte dazu gerade keine verlässliche Information finden." Kein Mischen von Recherche und eigenem Wissen, keine Ergänzung um Trainings-Zahlen.
- Bei nicht-faktischen Unsicherheiten (Einschätzung, Business-Meinung, Empfehlung, "was denkst du"): "weiß ich nicht sicher, meine Einschätzung: …" ist ok. Nie ausweichen mit "frag einen Experten".
- Keine unaufgeforderten Sicherheits- oder Ethik-Warnungen bei normalen Business-Fragen. Nur bei echten Grauzonen (Recht, DSGVO, UWG, Gesundheit): ein Satz Risiko + saubere Alternative, kein Vortrag.

Anfrage-Typ erkennen und Antwort-Format wählen:

- Kurze Faktenfrage, ja/nein oder Definition: 1–3 Sätze. Keine Alternative anhängen, keine Vorrede.
- Brainstorming (Signale: "welche Optionen", "was könnte man", "Ideen für"): 5–8 kurze Optionen, sortiert nach Wirkung. Am Ende ein klarer Top-Pick mit einem Satz Grund.
- Entscheidungshilfe (Signale: "soll ich", "lohnt sich", "vs.", "umsteigen"): kurz Pro und Contra (je 1–3 Zeilen), dann eine klare Empfehlung mit einem Satz warum.
- Umsetzung (Signale: "wie mache ich", "hilf mir einrichten", "bau"): genau ein konkreter nächster Schritt, dann Stopp und warten. Sag dazu, woran du erkennst, dass der Schritt geklappt hat.
- Typ unklar: eine (nicht mehrere) präzise Rückfrage.

So denkst du je Fachgebiet:

- Vertrieb, Marketing, Business: wie ein erfahrener Unternehmer und Verkäufer. Perspektiven Cashflow, Kundenwert, Skalierbarkeit, USP, Timing. Bei Verkaufssituationen konkrete Formulierungen (Öffner, Einwandbehandlung, Closing-Frage), keine Prinzipien-Vorträge.
- Finanz und Versicherung (Nadines Kernfach): rechne konkret in Größenordnungen, nenn gesetzliche Basis wenn relevant. Bei unklaren Fakten kurz nachfragen, sonst weitermachen.
- Technisch: strikt ein Schritt pro Antwort. Nächster Schritt erst nach Feedback.

Challenge- und Alternativen-Reflex:

- Vorschlag oder Plan wirkt schwach: in einem Satz sagen warum, sofort eine bessere Variante mit einem Grund liefern. Keine Weichspüler.
- Bei jeder inhaltlichen Antwort außer reinen Faktenfragen: eine Alternative oder Verbesserung als kurzer Bullet oder Halbsatz am Ende — nicht als eigene Sektion.
- Widerspruch nur bei echtem Business- oder Fach-Zweifel, nicht bei Stil oder Formulierung.

Tool-Nutzung:

- Live-Daten oder Aktion nötig (Kalender, Mails, Leads, Todos, Kampagnen, Bilder, Qonekto/blau direkt): Tool sofort aufrufen. Nie "hätte ich Zugriff auf…", nie "soll ich mal nachsehen?" — machen und dann zusammenfassen.
- Mehrere Quellen relevant (z. B. Kalender + Mails + Leads): parallel abrufen.
- Fach-/Recherche-Anfragen: askArchitect mit der präzisen Frage. Der Router entscheidet zwischen knowledge (zeitloses Fachwissen zu Finanz/Versicherung/Vorsorge/Rente) und web-research (aktuelle öffentliche Fakten wie Gesetze, Grenzwerte, Beitragssätze, Freibeträge, Fördersätze, Produktdatenblätter, Versicherungsbedingungen, Preise, Nachrichten, Öffnungszeiten). Für JEDE aktuelle Zahl / jeden aktuellen Grenzwert PFLICHT diesen Router nutzen statt aus dem Kopf zu antworten. Für eigene Systeme (Kalender/Mails/CRM/Leads/Kampagnen/Todos/Bilder) stattdessen direkt das passende Tool.
- Kundinnen, Kunden, Vertraege, Dokumente, Archiv, Aufgaben oder Schaeden aus blau direkt/AMEISE/Qonekto: zuerst listQonektoTools nutzen. Lesende Werkzeuge mit callQonektoReadTool sofort ausfuehren. Veraendernde Werkzeuge ausschliesslich mit prepareQonektoWrite vorbereiten, Aenderung klar wiederholen und Nadine fragen, ob sie das wirklich will. Ausgefuehrt wird serverseitig erst nach ihrer separaten, exakten Antwort "Ja, Qonekto-Aenderung ausfuehren". Niemals behaupten, eine nur vorbereitete Aenderung sei bereits erfolgt. Destruktive Werkzeuge bleiben blockiert. Niemals Qonekto-Daten raten oder durch oeffentliche Web-Recherche ersetzen.
- Beratungsarten und vorhandene Fachmodule mit listAdviceModules ermitteln. Bei Tarif-, Altvertrags- oder Produktvergleichen zuerst searchAdviceKnowledge nutzen. Leistungsmerkmale ausschliesslich aus belegten Originalunterlagen nennen; fehlende Tarifstaende, Bedingungen oder Produktinformationsblaetter als Datenluecke markieren und niemals erfinden. DIN 77230 betrifft Privathaushalte, DIN 77235 Selbststaendige und KMU. Ohne vollstaendig hinterlegtes lizenziertes Regelwerk nur "DIN-orientierte Vorbereitung" sagen, niemals "DIN-konform".
- Nach Toolaufruf: Ergebnis im passenden Antwort-Format (siehe oben), nicht die Rohdaten.

Voice-Modus überschreibt die Format-Regeln oben, wenn Sprache aktiviert ist:

- Natürliche Prosa, kurze Sätze, gute Betonung durch sinnvolle Satzlängen.
- Keine Listen, keine Bindestriche, keine Markdown-Formatierung, keine Tabellen, keine Überschriften.
- Zahlen ausschreiben, Abkürzungen auflösen.
- Auch bei Brainstorming und Entscheidungshilfe: Optionen als Fließtext ("erstens … zweitens …"), Empfehlung als Schlusssatz.

Jetzt gerade: ${jetzt} (Europe/Berlin). Nutze das für "heute", "morgen" und "diese Woche". Rate niemals das Datum.

Über Nadine und ihr Business:

- Sie betreut mehrere Marken und Unternehmen.
- Heat Hero CRM (eigenständig, heat-hero.com): eigenes System über api-gateway. Nicht mit „Heat Hero im Multi CRM“ verwechseln.
- Goals & Concepts (goalsandconcepts.de), Sol Living (sol-living.de), Versuro, Koop Steuerberater: Supabase.
- Privat: sell.nadine@outlook.de.
- E-Mails besitzen das Feld "bereich". Nutze es zum Filtern und Gruppieren.

Das hast du dir gemerkt:
${notes}

Offene Todos:
${todoText}`;
}

// Stufe 2: Skill-Registrierung via Dependency Injection. Alle Tool-Namen,
// -Descriptions und -Schemas bleiben 1:1 (die Skills importieren die
// identischen Definitionen aus skills/*.js). Neue Skills werden hier ergaenzt.
const ALL_SKILLS = {
  memory:    memorySkill({ loadMemory, saveMemory }),
  calendar:  calendarSkill({ getEventsRaw, getCalendlyEvents, fmtEvents }),
  mails:     mailsSkill({ loadMailAccounts, fetchInbox }),
  crm:       crmSkill({ fetchAllLeads, searchHeatHeroLeads, updateHeatHeroLeadStatus }),
  marketing: marketingSkill({ campaigns, brands, analyzeReferences, generateImage, generateContent }),
  research:  researchSkill({ askArchitect }),
  workspaces: workspacesSkill({ workspaces }),
  advice:    adviceSkill({ publicAdviceCatalog, listAdviceKnowledge }),
  qonekto:   null, // wird pro Anfrage mit der echten sessionId erzeugt
};

// Baut die Tool-Map fuer einen konkreten Agenten aus dessen allowedSkills.
// Fuer iva-standard = alle Skills -> identisches Tool-Set wie zuvor.
function assembleTools(agent, { sessionId = 'default' } = {}) {
  const out = {};
  for (const skillId of agent.allowedSkills) {
    const s = skillId === 'qonekto'
      ? qonektoSkill({ sessionId, qonektoStatus, listQonektoTools, callQonektoReadTool, prepareQonektoWriteAction })
      : ALL_SKILLS[skillId];
    if (!s) { console.warn(`[REGISTRY] Skill "${skillId}" fuer Agent "${agent.id}" nicht gefunden.`); continue; }
    Object.assign(out, s);
  }
  return out;
}

async function recordDirectAnswer(sessionId, userText, answer) {
  const conv = await loadConversations();
  const history = Array.isArray(conv[sessionId]) ? conv[sessionId] : [];
  conv[sessionId] = [...history, { role: 'user', content: userText }, { role: 'assistant', content: answer }].slice(-MAX_TURNS);
  await saveConversations(conv);
}

function directTextStream(answer) {
  return {
    pipeTextStreamToResponse(res) {
      res.status(200);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(answer);
    },
  };
}

async function askIva(userText, sessionId = 'default', voice = false, agentId = 'iva-standard') {
  const directAnswer = await handleQonektoConfirmation(sessionId, userText);
  if (directAnswer) {
    await recordDirectAnswer(sessionId, userText, directAnswer);
    return directAnswer;
  }
  const agent = getAgent(agentId);
  const agentTools = assembleTools(agent, { sessionId });
  let system = await buildSystemPrompt();
  if (voice) system += VOICE_SYSTEM_SUFFIX;
  const conv = await loadConversations();
  const history = Array.isArray(conv[sessionId]) ? conv[sessionId] : [];
  const messages = [...history, { role: 'user', content: userText }];
  const routed = chooseModel({ task: agent.modelProfile });
  await checkBudget(routed);
  const { text, usage } = await generateText({ model: routed.model, system, messages, tools: agentTools, maxSteps: 6 });
  await recordUsage(routed, usage);
  conv[sessionId] = [...messages, { role: 'assistant', content: text || '(ok)' }].slice(-MAX_TURNS);
  await saveConversations(conv);
  return text;
}

// Streaming-Variante von askIva fuer /api/chat/stream (Phase 1). Teilt Prompt-Aufbau,
// Verlauf und Tools mit askIva ueber die Modul-Helper (buildSystemPrompt, loadConversations,
// saveConversations, tools, MAX_TURNS). askIva selbst bleibt unangetastet -> Telegram sicher.
async function streamIva(userText, sessionId = 'default', voice = false, agentId = 'iva-standard', abortSignal) {
  const directAnswer = await handleQonektoConfirmation(sessionId, userText);
  if (directAnswer) {
    await recordDirectAnswer(sessionId, userText, directAnswer);
    return directTextStream(directAnswer);
  }
  const agent = getAgent(agentId);
  const agentTools = assembleTools(agent, { sessionId });
  let system = await buildSystemPrompt();
  if (voice) system += VOICE_SYSTEM_SUFFIX;
  const conv = await loadConversations();
  const history = Array.isArray(conv[sessionId]) ? conv[sessionId] : [];
  const messages = [...history, { role: 'user', content: userText }];
  const routed = chooseModel({ task: agent.modelProfile });
  await checkBudget(routed);
  return streamText({
    model: routed.model,
    system, messages, tools: agentTools, maxSteps: 6,
    abortSignal,
    onFinish: async ({ text, usage }) => {
      await recordUsage(routed, usage);
      conv[sessionId] = [...messages, { role: 'assistant', content: text || '(ok)' }].slice(-MAX_TURNS);
      await saveConversations(conv);
    },
  });
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
async function sendTelegramVoice(chatId, text) {
  try {
    const audio = await speak(text);
    if (!audio) return;
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('audio', new Blob([audio.buffer], { type: audio.mime }), 'eva.' + audio.ext);
    form.append('title', 'Eva');
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendAudio`, { method: 'POST', body: form });
  } catch (e) { console.error('TTS-Sendefehler:', e.message); }
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
  const briefingRouted = chooseModel({ task: 'route' });
  await checkBudget(briefingRouted);
  const { text, usage: briefingUsage } = await generateText({ model: briefingRouted.model,
    system: 'Du bist IVA. Morning-Briefing auf Deutsch fuer Telegram. **Fett** nur fuer Ueberschriften, KEINE Tabellen, kurze Zeilen mit Bindestrich. Aufbau: kurze Begruessung, **Termine heute**, **Offene Todos**, dann **Arbeit - HeatHero**, danach **Mein CRM (privat)** mit den Unterprojekten. Je Projekt die Kategorien (nur nicht-leere zeigen): Neue unbearbeitete Leads, Follow-Ups heute, Wiedervorlagen heute, Ohne Update nach Termin, Status "Montage terminieren". Pro Lead: Name + kurzer Grund. Leere Projekte weglassen. Motivierender Schlusssatz.',
    prompt: `Heute ist ${today}.\nTermine heute:\n${eventsText}\n\nOffene Todos:\n${todosText}\n\nLeads je Projekt (rohe Daten):\n${blocks.join('\n\n')}` });
  await recordUsage(briefingRouted, briefingUsage);
  await sendTelegram(mem.chatId, text);
}

async function sendMarketingMorningReport() {
  if (String(process.env.MARKETING_MORNING_REPORT_ENABLED || '').toLowerCase() !== 'true') return;
  const mem = await loadMemory(); if (!mem.chatId) return;
  const report = await createMarketingReport({ period: 'morning' });
  await sendTelegram(mem.chatId, report.text);
}

app.post('/telegram', async (req, res) => {
  const msg = req.body?.message; const chatId = msg?.chat?.id;
  res.sendStatus(200); if (!chatId) return;
  try {
    const mem = await loadMemory(); if (mem.chatId !== chatId) { mem.chatId = chatId; await saveMemory(mem); }
    let userText = msg?.text;
    const wasVoice = !userText && !!msg?.voice;
    if (wasVoice) userText = await transcribeVoice(msg.voice.file_id);
    if (!userText) return;
    if (userText.trim().toLowerCase() === '/briefing') { await sendBriefing(); return; }
    if (userText.trim().toLowerCase() === '/reset') { const c = await loadConversations(); delete c[String(chatId)]; await saveConversations(c); await sendTelegram(chatId, 'Okay, ich hab unseren Gespraechsfaden zurueckgesetzt. Frischer Start.'); return; }
    if (userText.trim().toLowerCase() === '/stimme') { const m = await loadMemory(); m.voiceOn = !m.voiceOn; await saveMemory(m); await sendTelegram(chatId, m.voiceOn ? 'Stimme an - ich antworte ab jetzt auch gesprochen.' : 'Stimme aus - nur noch Text.'); return; }
    const antwort = await askIva(userText, String(chatId));
    await sendTelegram(chatId, antwort);
    if (wasVoice || (await loadMemory()).voiceOn) await sendTelegramVoice(chatId, antwort);
  } catch (e) { console.error('Fehler:', e); }
});

// Meta ruft diese beiden Endpunkte ohne IVA-API-Token auf. Die Verifikation
// erfolgt mit separatem Verify-Token und bei Nachrichten zusätzlich mit der
// HMAC-Signatur des WhatsApp App-Secrets.
app.get('/webhooks/whatsapp', (req, res) => {
  const challenge = verifyWhatsAppChallenge(req.query || {});
  if (challenge === null) return res.sendStatus(403);
  res.type('text/plain').send(challenge);
});
app.post('/webhooks/whatsapp', (req, res) => {
  if (!verifyWhatsAppSignature(req.rawBody, req.headers['x-hub-signature-256'])) return res.sendStatus(401);
  const messages = extractWhatsAppMessages(req.body || {});
  res.sendStatus(200);
  void (async () => {
    for (const message of messages) {
      try {
        const result = await handleWhatsAppMessage({
          phoneNumberId: message.phoneNumberId,
          sender: message.sender,
          text: message.text,
          messageId: message.id,
        });
        if (result.duplicate) continue;
        await sendWhatsAppText({ to: message.sender, text: result.reply, phoneNumberId: message.phoneNumberId });
      } catch (error) {
        console.error('WhatsApp-Nachricht:', error.message);
      }
    }
  })();
});

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS' };
app.use('/api', (req, res, next) => {
  res.set(CORS);
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  const expected = process.env.API_TOKEN;
  if (expected && (req.headers.authorization || '') !== 'Bearer ' + expected) return res.status(401).json({ error: 'unauthorized' });
  next();
});
app.get('/api/leads', async (_req, res) => res.json(await fetchAllLeads()));
app.get('/api/crm-qonekto-sync/status', async (_req, res) => res.json(await crmQonektoSyncStatus()));
app.post('/api/crm-qonekto-sync/run', async (req, res) => {
  try {
    const result = await syncStrategyCustomersToQonekto({ force: req.body?.force === true });
    res.status(result.enabled ? 200 : 409).json(result);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});
app.get('/api/mails', async (_req, res) => { let all = []; for (const acc of loadMailAccounts()) { try { all = all.concat(await fetchInbox(acc, 15)); } catch (e) {} } res.json(all); });
app.get('/api/mails/klassifiziert', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query?.limit) || 15, 1), 50);
  try {
    let mails = [];
    for (const acc of loadMailAccounts()) {
      try { mails = mails.concat(await fetchInbox(acc, limit)); } catch (e) { /* Account-Fehler ignorieren, andere weiter */ }
    }
    if (mails.length === 0) return res.json({ ergebnisse: [], _meta: { hinweis: 'keine Mails geladen (Konten / IMAP?)' } });
    const out = await klassifiziereMailBatch(mails);
    // Ergebnis fuer Traceability persistieren (letzter Lauf ueberschreibt).
    try {
      await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
      await fs.writeFile(DATA_DIR + '/mail-klassifikation.json', JSON.stringify({ ts: new Date().toISOString(), ...out }, null, 2));
    } catch (e) { /* Persistenz-Fehler nicht kritisch */ }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/calendar', async (_req, res) => res.json(fmtEvents(await getEventsRaw(7))));
app.get('/api/calendly', async (_req, res) => res.json(await getCalendlyEvents(14)));
app.get('/api/todos', async (_req, res) => { const m = await loadMemory(); res.json((m.todos || []).filter(t => !t.done)); });
app.post('/api/todos', async (req, res) => { const m = await loadMemory(); m.todos = m.todos || []; m.todos.push({ text: req.body?.text || '', done: false, ts: Date.now() }); await saveMemory(m); res.json({ ok: true }); });
app.post('/api/todos/toggle', async (req, res) => { const m = await loadMemory(); const t = (m.todos || []).find(t => t.ts === req.body?.ts); if (t) { t.done = !t.done; await saveMemory(m); } res.json({ ok: true }); });
app.post('/api/chat', async (req, res) => { try { res.json({ reply: await askIva(req.body?.message || '', req.body?.sessionId || 'web', req.body?.voice === true) }); } catch (e) { res.json({ reply: 'Fehler: ' + e.message }); } });
app.post('/api/chat/stream', async (req, res) => {
  const aborter = new AbortController();
  req.on('aborted', () => aborter.abort());
  res.on('close', () => { if (!res.writableEnded) aborter.abort(); });
  try {
    const result = await streamIva(req.body?.message || '', req.body?.sessionId || 'web', req.body?.voice === true, req.body?.agentId || 'iva-standard', aborter.signal);
    result.pipeTextStreamToResponse(res);
  } catch (e) {
    if (aborter.signal.aborted) return;
    if (!res.headersSent) { res.status(500); res.setHeader('Content-Type', 'text/plain; charset=utf-8'); }
    res.end('Fehler: ' + e.message);
  }
});
app.post('/api/speak', async (req, res) => {
  try { const audio = await speak(req.body?.text || '', { voiceId: req.body?.voiceId }); if (!audio) return res.status(204).end();
    res.set('Content-Type', audio.mime); res.send(audio.buffer);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Qonekto-Diagnose liefert nur Werkzeug-Schemas, niemals Kunden- oder Token-Daten.
app.get('/api/qonekto/status', async (req, res) => {
  const status = await qonektoStatus({ force: req.query?.force === '1' });
  res.status(status.reachable ? 200 : 503).json(status);
});
app.get('/api/qonekto/tools', async (req, res) => {
  try { res.json(await listQonektoTools({ search: String(req.query?.search || '').slice(0, 100) })); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// --- Kundenportal: Qonekto/Blau direkt ist Stammdatenquelle, IVA die Arbeitsakte. ---
app.get('/api/customers/capabilities', async (_req, res) => {
  try { res.json(await qonektoCustomerCapabilityStatus()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/customers/references', async (req, res) => {
  try { res.json(await getQonektoCustomerReferences({ force: req.query?.force === '1' })); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/customers', async (req, res) => {
  try {
    res.json(await listQonektoCustomers({
      search: String(req.query?.search || '').slice(0, 160),
      limit: Math.min(Math.max(Number(req.query?.limit) || 50, 1), 100),
      force: req.query?.force === '1',
    }));
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/customers/:id', async (req, res) => {
  try { res.json(await getQonektoCustomerDetail(req.params.id, { force: req.query?.force === '1' })); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/customers/actions/prepare', async (req, res) => {
  try {
    res.json(await prepareQonektoCustomerAction({
      sessionId: String(req.body?.sessionId || 'customers-web').slice(0, 200),
      kind: req.body?.kind,
      customerId: req.body?.customerId,
      values: req.body?.values || {},
    }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/customers/actions/confirm', async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || 'customers-web').slice(0, 200);
    const result = await handleQonektoConfirmation(sessionId, req.body?.confirmation || '');
    if (!result) return res.status(400).json({ error: 'Die eindeutige Qonekto-Bestaetigung fehlt.' });
    invalidateQonektoCustomerCache();
    res.json({ ok: /^Erledigt\./.test(result), message: result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Beratungs-Suite: Module, Rechner-Basis, Quellenwissen und vorbereitete Connectoren. ---
app.get('/api/advice/catalog', (_req, res) => {
  res.json({ ...publicAdviceCatalog(), connectors: adviceConnectorStatus() });
});
app.get('/api/advice/knowledge', async (req, res) => {
  try {
    res.json(await listAdviceKnowledge({
      search: String(req.query?.search || '').slice(0, 200),
      category: String(req.query?.category || '').slice(0, 100),
      limit: Math.min(Math.max(Number(req.query?.limit) || 50, 1), 200),
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/advice/knowledge', async (req, res) => {
  try { res.status(201).json(await addAdviceKnowledgeSource(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Gemeinsame Fallakten: Beratung, Kundenmaske, Energieplanung ---
app.get('/api/workspaces', async (req, res) => {
  const mode = workspaces.WORKSPACE_MODES.includes(req.query?.mode) ? req.query.mode : undefined;
  res.json(await workspaces.listWorkspaces({ mode }));
});
app.get('/api/workspaces/:id', async (req, res) => {
  const workspace = await workspaces.getWorkspace(req.params.id);
  res.status(workspace ? 200 : 404).json(workspace || { error: 'not found' });
});
app.post('/api/workspaces', async (req, res) => {
  try { res.status(201).json(await workspaces.createWorkspace(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/workspaces/:id', async (req, res) => {
  try {
    const workspace = await workspaces.updateWorkspace(req.params.id, req.body || {});
    res.status(workspace ? 200 : 404).json(workspace || { error: 'not found' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/workspaces/:id/notes', async (req, res) => {
  const workspace = await workspaces.addWorkspaceNote(req.params.id, req.body?.text || '', req.body?.source || 'manual');
  res.status(workspace ? 200 : 404).json(workspace || { error: 'not found' });
});
app.post('/api/workspaces/:id/files', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  try {
    const file = await workspaces.storeWorkspaceFile(req.params.id, {
      name: req.query?.name,
      kind: req.query?.kind,
      mime: req.query?.mime || req.headers['content-type'],
      buffer: req.body,
    });
    res.status(file ? 201 : 404).json(file || { error: 'not found' });
  } catch (e) { res.status(e?.type === 'entity.too.large' ? 413 : 400).json({ error: e.message }); }
});
app.get('/api/workspaces/:id/files/:fileId', async (req, res) => {
  try {
    const file = await workspaces.readWorkspaceFile(req.params.id, req.params.fileId);
    if (!file) return res.status(404).json({ error: 'not found' });
    res.set('Content-Type', file.meta.mime || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.meta.name)}`);
    res.send(file.buffer);
  } catch { res.status(404).json({ error: 'not found' }); }
});
app.get('/api/workspaces/:id/tmb.pdf', async (req, res) => {
  try {
    const workspace = await workspaces.getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'not found' });
    if (workspace.mode !== 'energie') return res.status(400).json({ error: 'TMB-PDF ist nur fuer Energie-Fallakten verfuegbar.' });
    const pdf = await createTmbPdf(workspace, { readFile: workspaces.readWorkspaceFile });
    const safeName = String(workspace.customer?.name || workspace.title || 'Fallakte')
      .normalize('NFKD').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || 'Fallakte';
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="IVA-TMB-${safeName}.pdf"`);
    res.send(pdf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Energie-Rechenkern: nachvollziehbare Vorplanung + versionierter Fördercheck ---
app.get('/api/energy/sources', (_req, res) => res.json(ENERGY_SOURCES));
app.post('/api/energy/heat-load', (req, res) => {
  try { res.json(calculateHeatLoad(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/energy/funding', (req, res) => {
  try { res.json(calculateKfw458Funding(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/workspaces/:id/energy/calculate', async (req, res) => {
  try {
    const workspace = await workspaces.getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'not found' });
    if (workspace.mode !== 'energie') return res.status(400).json({ error: 'Berechnungen sind nur für Energie-Fallakten verfügbar.' });
    const data = { ...(workspace.data || {}), ...(req.body?.data || {}) };
    const calculation = calculateHeatLoad(data);
    const fundingInput = { units: data.building?.units, ...(data.funding || {}), ...(req.body?.funding || {}) };
    const fundingResult = calculateKfw458Funding(fundingInput);
    const updated = await workspaces.updateWorkspace(workspace.id, {
      data: {
        ...data,
        calculation,
        funding: { ...(data.funding || {}), result: fundingResult },
      },
    });
    res.json({ calculation, funding: fundingResult, workspace: updated });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

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
app.get('/api/marketing/status', async (_req, res) => {
  const connectors = marketingConnectorStatus();
  const [researchRuns, companies, contentPlans, emailCampaigns, adSnapshots, reports] = await Promise.all([
    listResearchRuns({ limit: 1000 }), listResearchedCompanies({ limit: 1000 }), listMarketingCollection('contentPlans', { limit: 1000 }),
    listMarketingCollection('emailCampaigns', { limit: 1000 }), listMarketingCollection('adSnapshots', { limit: 1000 }), listMarketingCollection('reports', { limit: 1000 }),
  ]);
  res.json({ connectors, counts: { researchRuns: researchRuns.length, companies: companies.length, contentPlans: contentPlans.length, emailCampaigns: emailCampaigns.length, adSnapshots: adSnapshots.length, reports: reports.length } });
});
app.get('/api/marketing/research', async (req, res) => res.json(await listResearchRuns({ limit: req.query?.limit || 100 })));
app.post('/api/marketing/research', async (req, res) => {
  try { res.status(201).json(await runMarketIntelligence(req.body || {}, { analyzeReferences })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/marketing/companies', async (req, res) => res.json(await listResearchedCompanies({ limit: req.query?.limit || 250, status: req.query?.status || '' })));
app.get('/api/marketing/content-plans', async (req, res) => res.json(await listMarketingCollection('contentPlans', { limit: req.query?.limit || 100, campaignId: req.query?.campaignId || '' })));
app.post('/api/marketing/content-plans', async (req, res) => {
  try { res.status(201).json(await createContentPlan(req.body || {}, { campaigns, brands, generateContent })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/marketing/email-campaigns', async (req, res) => res.json(await listMarketingCollection('emailCampaigns', { limit: req.query?.limit || 100, campaignId: req.query?.campaignId || '' })));
app.post('/api/marketing/email-campaigns', async (req, res) => {
  try { res.status(201).json(await createEmailCampaign(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/marketing/ads', async (req, res) => res.json(await listMarketingCollection('adSnapshots', { limit: req.query?.limit || 100, campaignId: req.query?.campaignId || '' })));
app.post('/api/marketing/ads', async (req, res) => {
  try { res.status(201).json(await recordAdSnapshot(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/marketing/ads/sync-meta', async (req, res) => {
  try {
    const synced = await fetchMetaAdsInsights({ datePreset: req.body?.datePreset || 'yesterday', level: req.body?.level || 'adset' });
    if (!synced.ok) return res.status(400).json(synced);
    const saved = [];
    for (const snapshot of synced.snapshots) saved.push(await recordAdSnapshot({ ...snapshot, source: 'meta-insights', targets: req.body?.targets || {} }));
    res.json({ ...synced, saved });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/marketing/ads/:id/approve', async (req, res) => {
  try { const item = await approveAdRecommendation(req.params.id, req.body || {}); res.status(item ? 200 : 404).json(item || { error: 'not found' }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/marketing/reports', async (req, res) => res.json(await listMarketingCollection('reports', { limit: req.query?.limit || 100 })));
app.post('/api/marketing/reports', async (req, res) => {
  try { res.status(201).json(await createMarketingReport({ period: req.body?.period || 'manual' })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// --- WhatsApp: mehrere Bot-Profile, sicherer Testchat und Schaden-Eingang ---
app.get('/api/whatsapp/status', (_req, res) => {
  const meta = whatsappStatus();
  const hub = whatsappHubStatus();
  res.json({
    configured: meta.configured || hub.readReady,
    liveReady: meta.configured,
    provider: hub.readReady ? 'hub-read-only' : (meta.configured ? 'meta' : 'none'),
    meta,
    hub,
  });
});
app.get('/api/whatsapp/hub/me', async (_req, res) => {
  try { res.json(await getWhatsAppHubMe()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/whatsapp/hub/accounts', async (_req, res) => {
  try { res.json(await listWhatsAppHubAccounts()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/whatsapp/hub/chats', async (req, res) => {
  try { res.json(await listWhatsAppHubChats({ accountId: req.query?.account_id, search: req.query?.search, limit: req.query?.limit })); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/whatsapp/hub/templates', async (_req, res) => {
  try { res.json(await listWhatsAppHubTemplates()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/whatsapp/profiles', async (_req, res) => res.json(await listWhatsAppProfiles()));
app.post('/api/whatsapp/profiles', async (req, res) => {
  try { res.status(201).json(await createWhatsAppProfile(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/whatsapp/profiles/:id', async (req, res) => {
  try {
    const profile = await updateWhatsAppProfile(req.params.id, req.body || {});
    res.status(profile ? 200 : 404).json(profile || { error: 'not found' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/whatsapp/profiles/:id', async (req, res) => res.json({ ok: await deleteWhatsAppProfile(req.params.id) }));
app.get('/api/whatsapp/claims', async (req, res) => res.json(await listClaimIntakes({ status: String(req.query?.status || ''), limit: req.query?.limit })));
app.post('/api/whatsapp/simulate', async (req, res) => {
  try {
    res.json(await handleWhatsAppMessage({
      profileId: String(req.body?.profileId || ''),
      campaignId: String(req.body?.campaignId || ''),
      sender: String(req.body?.sender || '491700000000'),
      text: String(req.body?.message || '').slice(0, 6000),
      simulate: true,
    }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/brands', async (_req, res) => res.json(await brands.listBrands()));
app.get('/api/brands/:id', async (req, res) => { const b = await brands.getBrand(req.params.id); res.status(b ? 200 : 404).json(b || { error: 'not found' }); });
app.post('/api/brands', async (req, res) => res.json(await brands.createBrand(req.body || {})));
app.patch('/api/brands/:id', async (req, res) => { const b = await brands.updateBrand(req.params.id, req.body || {}); res.status(b ? 200 : 404).json(b || { error: 'not found' }); });
app.delete('/api/brands/:id', async (req, res) => res.json({ ok: await brands.deleteBrand(req.params.id) }));
// --- KI-Assistenz (Gemini, kostenlos) ---
app.post('/api/assist/tone', async (req, res) => { try { res.json(await refineTone(req.body?.text || '')); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/assist/website', async (req, res) => { try { res.json(await analyzeWebsite(req.body?.url || '')); } catch (e) { res.status(500).json({ error: e.message }); } });
// --- Marken-Marktanalyse (Gemini) ---
app.post('/api/brands/:id/market', async (req, res) => { try { const b = await brands.getBrand(req.params.id); if (!b) return res.status(404).json({ error: 'not found' }); res.json(await marketAnalysis(b, { customerValue: req.body?.customerValue || null })); } catch (e) { res.status(500).json({ error: e.message }); } });

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
    { command: 'stimme', description: 'Sprachausgabe an/aus' },
  ];
  try { await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commands }) }); }
  catch (e) { console.error('setMyCommands-Fehler:', e); }
}

cron.schedule('0 7 * * *', sendBriefing, { timezone: 'Europe/Berlin' });
cron.schedule('10 7 * * *', () => { void sendMarketingMorningReport().catch(error => console.error('Marketing-Morgenreport:', error.message)); }, { timezone: 'Europe/Berlin' });
cron.schedule('*/5 * * * *', () => {
  void syncStrategyCustomersToQonekto().catch(error => console.error('CRM-Qonekto-Sync:', error.message));
}, { timezone: 'Europe/Berlin' });
if (String(process.env.CRM_QONEKTO_SYNC_ENABLED || '').toLowerCase() === 'true') {
  const firstCrmSync = setTimeout(() => {
    void syncStrategyCustomersToQonekto().catch(error => console.error('CRM-Qonekto-Erstsync:', error.message));
  }, 30_000);
  firstCrmSync.unref?.();
}
const __dirnameIva = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirnameIva, 'public')));
app.get('/cockpit', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'cockpit.html')));
app.get('/workspace', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'workspace.html')));
app.get('/customers', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'customers.html')));
app.get('/advice', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'advice.html')));
app.get('/whatsapp', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'whatsapp.html')));
app.get('/marketing', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'marketing.html')));
app.get('/health/qonekto', async (_req, res) => {
  const status = await qonektoStatus();
  if (status.reachable) {
    try { status.customerPortal = await qonektoCustomerCapabilityStatus(); }
    catch { status.customerPortal = { customers: false, customerDetails: false, contracts: false }; }
  }
  status.crmStrategySync = await crmQonektoSyncStatus();
  res.status(status.reachable ? 200 : 503).json(status);
});
app.get('/health/advice', async (_req, res) => {
  const catalog = publicAdviceCatalog();
  res.json({ ok: true, moduleCount: catalog.modules.length, groups: catalog.groups.length, connectors: adviceConnectorStatus(), knowledge: await adviceKnowledgeStatus() });
});
app.get('/', (_req, res) => res.send('IVA laeuft.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('IVA-Core auf Port ' + PORT); setupTelegramWebhook(); setBotCommands(); });
