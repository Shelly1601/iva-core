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
import { opportunitiesSkill } from './skills/opportunities.js';
import { selfImprovementSkill } from './skills/self-improvement.js';
import { accountingSkill } from './skills/accounting.js';
import { energyTariffsSkill } from './skills/energy-tariffs.js';
import { listAgents, routeAgent } from './agents/registry.js';
import { marketAnalysis } from './marketing/market.js';
import { fetchMetaAdsInsights, marketingConnectorStatus } from './marketing/connectors.js';
import { listResearchRuns, listResearchedCompanies, runMarketIntelligence } from './marketing/intelligence.js';
import { approveAdRecommendation, createContentPlan, createEmailCampaign, createMarketingReport, listMarketingCollection, recordAdSnapshot } from './marketing/planning.js';
import { speak } from './voice.js';
import {
  captureImprovementRequest,
  listVoiceEvaluations,
  listVoiceLearning,
  recordVoiceEvaluation,
  saveCommunicationPreference,
  savePronunciationCorrection,
  voiceLabSummary,
  voiceLearningPromptContext,
} from './voice-lab/store.js';
import { transcribeAudio } from './voice-lab/transcribe.js';
import { askArchitect } from './agents/architect.js';
import * as workspaces from './workspaces/store.js';
import {
  ACCOUNTING_CATEGORIES,
  accountingSummary,
  createAccountingEntity,
  exportAccountingCsv,
  getAccountingDocument,
  listAccountingDocuments,
  listAccountingEntities,
  readAccountingFile,
  storeAccountingDocument,
  updateAccountingDocument,
} from './accounting/store.js';
import { createTmbPdf } from './workspaces/tmb-pdf.js';
import {
  getOpportunity,
  getOpportunitySettings,
  listOpportunities,
  listOpportunityRuns,
  prepareOpportunityHandoff,
  updateOpportunity,
  updateOpportunitySettings,
  upsertOpportunity,
} from './opportunities/store.js';
import { formatWeeklyPitch, scoreOpportunity } from './opportunities/score.js';
import { opportunityRadarStatus, runOpportunityScout } from './opportunities/scout.js';
import { calculateHeatLoad, calculateKfw458Funding, ENERGY_SOURCES } from './workspaces/energy-calculations.js';
import {
  energyTariffStatus,
  prepareEnergyTariffRequest,
  prepareWorkspaceEnergyTariffRequest,
} from './integrations/energy-tariffs.js';
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
import {
  beginAgentRun,
  createApproval,
  finishAgentRun,
  listAgentRuns,
  listApprovals,
  listAudit,
  operationsSummary,
  recordAudit,
  resolveApprovalByExternalKey,
} from './operations/store.js';
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
const VOICE_SYSTEM_SUFFIX = `

DIESE ANFRAGE KOMMT PER SPRACHE. Sprich mit Nadine wie in einem echten, zügigen Gespräch – nicht wie in einem Bericht. Antworte direkt mit dem wichtigsten Gedanken. Standardmäßig höchstens vier kurze, flüssige Sätze und nur ein Gedanke pro Satz; ausführlicher nur, wenn Nadine das ausdrücklich verlangt. Wenn dir eine Angabe fehlt, stelle genau eine konkrete Rückfrage. Keine Einleitungs- oder Schlussfloskeln, kein Markdown, keine Listen, keine Tabellen, keine Emojis, keine URLs, E-Mail-Adressen oder Dateipfade zum Vorlesen. Schreibe Datum, Uhrzeit, Zahlen und Abkürzungen so, dass sie auf Deutsch natürlich gesprochen werden. Übersetze sperrige Fachkürzel in verständliche Alltagssprache. Sicherheits-, Quellen- und Bestätigungsregeln bleiben vollständig bestehen: Nichts erfinden, keine Änderung ohne die dafür vorgesehene Bestätigung und keine wichtige Warnung weglassen.`;
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
  const learnedCommunication = await voiceLearningPromptContext().catch(() => 'Gespeicherte Kommunikationspräferenzen konnten gerade nicht geladen werden.');
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

Direktes Lernen und Selbstverbesserung:

- Wenn Nadine ausdrücklich sagt, dass ein Begriff, Name oder Kürzel anders ausgesprochen wird, sofort savePronunciationCorrection verwenden und die genaue Zuordnung bestätigen. Die Korrektur gilt ab der nächsten Sprachausgabe.
- Wenn Nadine ausdrücklich eine dauerhafte Kommunikationsregel nennt, zum Beispiel kürzer antworten, zuerst das Ergebnis sagen oder einen Ausdruck nicht mehr verwenden, saveCommunicationPreference verwenden. Aus bloßem Ärger oder einer mehrdeutigen Bemerkung keine dauerhafte Regel ableiten; dann genau eine Rückfrage stellen.
- Wenn Nadine eine neue Funktion oder Systemänderung wünscht, captureImprovementRequest verwenden. Danach ehrlich sagen: Der Bauauftrag ist erfasst, aber noch nicht programmiert oder deployt.
- Eine beiläufige Sprachäußerung darf niemals selbstständig Code ändern oder produktiv deployen. Codeänderung, Tests und Produktionsdeployment bleiben getrennte Schritte mit ausdrücklicher Bestätigung.
- Niemals behaupten, IVA habe sich bereits repariert, gebaut oder weiterentwickelt, wenn nur eine Korrektur oder ein Bauauftrag gespeichert wurde.

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
${todoText}

Zusätzlich gelernte Kommunikationspräferenzen:
${learnedCommunication}`;
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
  opportunities: opportunitiesSkill({ listOpportunities, runOpportunityScout, prepareOpportunityHandoff }),
  accounting: accountingSkill({ listAccountingEntities, listAccountingDocuments, getAccountingDocument, accountingSummary }),
  energyTariffs: energyTariffsSkill({ workspaces, energyTariffStatus, prepareWorkspaceEnergyTariffRequest }),
  selfImprovement: selfImprovementSkill({ savePronunciationCorrection, saveCommunicationPreference, captureImprovementRequest, listVoiceLearning }),
  qonekto:   null, // wird pro Anfrage mit der echten sessionId erzeugt
};

// Baut die Tool-Map fuer einen konkreten Agenten aus dessen allowedSkills.
// Fuer iva-standard = alle Skills -> identisches Tool-Set wie zuvor.
function assembleTools(agent, { sessionId = 'default' } = {}) {
  const out = {};
  for (const skillId of agent.allowedSkills) {
    const s = skillId === 'qonekto'
      ? qonektoSkill({ sessionId, qonektoStatus, listQonektoTools, callQonektoReadTool, prepareQonektoWriteAction: prepareTrackedQonektoWrite })
      : ALL_SKILLS[skillId];
    if (!s) { console.warn(`[REGISTRY] Skill "${skillId}" fuer Agent "${agent.id}" nicht gefunden.`); continue; }
    Object.assign(out, s);
  }
  return out;
}

function qonektoApprovalKey(sessionId) { return `qonekto:${String(sessionId || 'default').slice(0, 180)}`; }

async function prepareTrackedQonektoWrite(input = {}) {
  const prepared = await prepareQonektoWriteAction(input);
  await createApproval({
    type: 'qonekto-write',
    title: `Qonekto-Aenderung: ${input.toolName || 'Werkzeug'}`,
    summary: prepared?.preview || prepared?.message || `Vorbereitete Aenderung mit ${input.toolName || 'Qonekto'}`,
    agentId: 'iva-customer',
    externalKey: qonektoApprovalKey(input.sessionId),
    confirmationPhrase: 'Ja, Qonekto-Aenderung ausfuehren',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  await recordAudit({ category: 'approval', action: 'qonekto-write-prepared', status: 'pending', actor: 'iva-customer', target: input.toolName });
  return prepared;
}

async function handleTrackedQonektoConfirmation(sessionId, userText) {
  const directAnswer = await handleQonektoConfirmation(sessionId, userText);
  if (!directAnswer) return null;
  const succeeded = /^Erledigt\./.test(directAnswer);
  await resolveApprovalByExternalKey(qonektoApprovalKey(sessionId), { status: succeeded ? 'approved' : 'failed', result: directAnswer });
  await recordAudit({ category: 'approval', action: 'qonekto-write-confirmation', status: succeeded ? 'completed' : 'failed', actor: 'nadine', detail: directAnswer });
  return directAnswer;
}

function usedToolNames(steps = []) {
  return [...new Set((steps || []).flatMap(step => (step.toolCalls || []).map(call => call.toolName).filter(Boolean)))];
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
  const directAnswer = await handleTrackedQonektoConfirmation(sessionId, userText);
  if (directAnswer) {
    await recordDirectAnswer(sessionId, userText, directAnswer);
    return directAnswer;
  }
  const routedAgent = routeAgent(userText, agentId);
  const agent = routedAgent.agent;
  const started = Date.now();
  const run = await beginAgentRun({ agentId: agent.id, agentName: agent.name, routeReason: routedAgent.reason, channel: voice ? 'voice' : 'chat', sessionId, requestPreview: userText });
  const agentTools = assembleTools(agent, { sessionId });
  let system = await buildSystemPrompt();
  if (agent.rolePrompt) system += `\n\nAktiver Fachagent: ${agent.name}\n${agent.rolePrompt}`;
  if (voice) system += VOICE_SYSTEM_SUFFIX;
  const conv = await loadConversations();
  const history = Array.isArray(conv[sessionId]) ? conv[sessionId] : [];
  const messages = [...history, { role: 'user', content: userText }];
  try {
    const routed = chooseModel({ task: agent.modelProfile });
    await checkBudget(routed);
    const { text, usage, steps } = await generateText({ model: routed.model, system, messages, tools: agentTools, maxSteps: 6, ...(voice ? { maxTokens: 420 } : {}) });
    await recordUsage(routed, usage);
    conv[sessionId] = [...messages, { role: 'assistant', content: text || '(ok)' }].slice(-MAX_TURNS);
    await saveConversations(conv);
    await finishAgentRun(run.id, { status: 'completed', durationMs: Date.now() - started, tools: usedToolNames(steps), resultPreview: text });
    return text;
  } catch (error) {
    await finishAgentRun(run.id, { status: 'failed', durationMs: Date.now() - started, error: error.message });
    throw error;
  }
}

// Streaming-Variante von askIva fuer /api/chat/stream (Phase 1). Teilt Prompt-Aufbau,
// Verlauf und Tools mit askIva ueber die Modul-Helper (buildSystemPrompt, loadConversations,
// saveConversations, tools, MAX_TURNS). askIva selbst bleibt unangetastet -> Telegram sicher.
async function streamIva(userText, sessionId = 'default', voice = false, agentId = 'iva-standard', abortSignal) {
  const directAnswer = await handleTrackedQonektoConfirmation(sessionId, userText);
  if (directAnswer) {
    await recordDirectAnswer(sessionId, userText, directAnswer);
    return directTextStream(directAnswer);
  }
  const routedAgent = routeAgent(userText, agentId);
  const agent = routedAgent.agent;
  const started = Date.now();
  const run = await beginAgentRun({ agentId: agent.id, agentName: agent.name, routeReason: routedAgent.reason, channel: voice ? 'voice' : 'chat', sessionId, requestPreview: userText });
  const agentTools = assembleTools(agent, { sessionId });
  let system = await buildSystemPrompt();
  if (agent.rolePrompt) system += `\n\nAktiver Fachagent: ${agent.name}\n${agent.rolePrompt}`;
  if (voice) system += VOICE_SYSTEM_SUFFIX;
  const conv = await loadConversations();
  const history = Array.isArray(conv[sessionId]) ? conv[sessionId] : [];
  const messages = [...history, { role: 'user', content: userText }];
  try {
    const routed = chooseModel({ task: agent.modelProfile });
    await checkBudget(routed);
    return streamText({
      model: routed.model,
      system, messages, tools: agentTools, maxSteps: 6,
      ...(voice ? { maxTokens: 420 } : {}),
      abortSignal,
      onFinish: async ({ text, usage, steps }) => {
        await recordUsage(routed, usage);
        conv[sessionId] = [...messages, { role: 'assistant', content: text || '(ok)' }].slice(-MAX_TURNS);
        await saveConversations(conv);
        await finishAgentRun(run.id, { status: abortSignal?.aborted ? 'stopped' : 'completed', durationMs: Date.now() - started, tools: usedToolNames(steps), resultPreview: text });
      },
    });
  } catch (error) {
    await finishAgentRun(run.id, { status: 'failed', durationMs: Date.now() - started, error: error.message });
    throw error;
  }
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
  return (await transcribeAudio(audioBuf, { mime: 'audio/ogg', fileName: 'telegram-voice.ogg' })).text;
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

async function sendWeeklyOpportunityPitch() {
  const settings = await getOpportunitySettings();
  if (!settings.weeklyEnabled || !process.env.APIFY_TOKEN) return;
  const mem = await loadMemory();
  if (!mem.chatId) return;
  const result = await runOpportunityScout({ trigger: 'weekly' });
  await sendTelegram(mem.chatId, result.pitch);
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
    if (userText.trim().toLowerCase() === '/chancen') {
      const settings = await getOpportunitySettings();
      await sendTelegram(chatId, formatWeeklyPitch(await listOpportunities({ limit: settings.topIdeasPerPitch }), { max: settings.topIdeasPerPitch }));
      return;
    }
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
  if (!expected && (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PUBLIC_DOMAIN)) {
    return res.status(503).json({ error: 'API_TOKEN fehlt in der Produktionsumgebung.' });
  }
  if (expected && (req.headers.authorization || '') !== 'Bearer ' + expected) return res.status(401).json({ error: 'unauthorized' });
  next();
});

function envReady(...names) {
  return names.every(name => Boolean(String(process.env[name] || '').trim()));
}

function connector(id, label, ready, missing = [], detail = '') {
  return { id, label, ready: Boolean(ready), missing: ready ? [] : missing, detail };
}

async function controlSnapshot() {
  const [ops, qonektoResult, syncResult, voiceResult, knowledgeResult, opportunityResult, learningResult] = await Promise.all([
    operationsSummary(),
    qonektoStatus().catch(error => ({ configured: envReady('QONEKTO_MCP_TOKEN'), reachable: false, error: error.message })),
    crmQonektoSyncStatus().catch(error => ({ enabled: false, error: error.message })),
    voiceLabSummary().catch(error => ({ configured: {}, error: error.message })),
    adviceKnowledgeStatus().catch(error => ({ total: 0, error: error.message })),
    opportunityRadarStatus().catch(error => ({ configured: false, ready: false, missing: ['APIFY_TOKEN'], error: error.message })),
    listVoiceLearning().catch(() => ({ improvementRequests: [] })),
  ]);
  const marketing = marketingConnectorStatus();
  const metaWhatsApp = whatsappStatus();
  const hubWhatsApp = whatsappHubStatus();
  const adviceConnectors = adviceConnectorStatus();
  const tariffConnector = energyTariffStatus();
  const projectIds = CRM_SOURCES.filter(source => source.mode === 'rest' && source.projectId).length;
  const connectors = [
    connector('core-api', 'IVA API-Schutz', envReady('API_TOKEN'), ['API_TOKEN'], 'Schuetzt Cockpit und App-Zugriffe.'),
    connector('anthropic', 'IVA Kernmodell', envReady('ANTHROPIC_API_KEY'), ['ANTHROPIC_API_KEY'], 'Chat, Planung und Fachagenten.'),
    connector('gemini', 'Gemini Nebenmodell', envReady('GEMINI_API_KEY'), ['GEMINI_API_KEY'], 'Guentige Marketing-, Markt- und Nebenanalysen.'),
    connector('telegram', 'Telegram', envReady('TELEGRAM_BOT_TOKEN'), ['TELEGRAM_BOT_TOKEN'], 'Assistentenkanal und proaktive Berichte.'),
    connector('voice-input', 'Spracheingabe', Boolean(voiceResult.configured?.groq), ['GROQ_API_KEY'], 'Transkription mit Groq Whisper.'),
    connector('voice-output', 'IVA Stimme', Boolean(voiceResult.configured?.elevenLabs), ['ELEVENLABS_API_KEY'], 'Sprachausgabe mit ElevenLabs; eine feste Voice-ID ist optional.'),
    connector('qonekto', 'Qonekto / blau direkt', Boolean(qonektoResult.reachable), ['QONEKTO_MCP_TOKEN'], qonektoResult.reachable ? `${qonektoResult.toolCount || qonektoResult.tools?.total || 0} Werkzeuge erreichbar.` : (qonektoResult.error || 'Nicht erreichbar.')),
    connector('crm-goals', 'CRM · Goals & Concepts', envReady('MEINCRM_SERVICE_KEY', 'GOALS_CONCEPTS_PROJECT_ID'), ['MEINCRM_SERVICE_KEY', 'GOALS_CONCEPTS_PROJECT_ID'], `${projectIds} CRM-Projektzuordnungen hinterlegt.`),
    connector('crm-heathero', 'HeatHero CRM', envReady('HEATHERO_API_KEY'), ['HEATHERO_API_KEY'], 'Eigener Lead-Zugang.'),
    connector(
      'crm-qonekto-sync',
      'Strategiegespraech → Qonekto',
      Boolean(syncResult.enabled && syncResult.projectConfigured),
      [!syncResult.projectConfigured && 'GOALS_CONCEPTS_PROJECT_ID', !syncResult.enabled && 'CRM_QONEKTO_SYNC_ENABLED=true'].filter(Boolean),
      syncResult.enabled ? 'Automatischer Abgleich aktiv; Anrede-/Vermittler-Defaults sind nur bei fehlenden CRM-Werten nötig.' : 'Bewusst noch nicht aktiviert; zuerst mit einem Testkunden prüfen.',
    ),
    connector('calendar', 'Kalender', CALENDARS.some(item => item.url), ['PRIVAT_GOOGLE_ICS_URL oder weitere ICS-URL'], `${CALENDARS.filter(item => item.url).length} Kalender verbunden.`),
    connector('mail', 'E-Mail-Eingang', loadMailAccounts().length > 0, ['MAIL_1_USER/MAIL_1_PASS oder MAIL_2_USER/MAIL_2_PASS'], `${loadMailAccounts().length} Postfaecher konfiguriert.`),
    connector('calendly', 'Calendly', envReady('CALENDLY_TOKEN'), ['CALENDLY_TOKEN'], 'Termine und Bucher.'),
    connector('fal-images', 'fal.ai Bildgenerierung', envReady('FAL_KEY'), ['FAL_KEY'], 'Bilder und Creatives fuer freigegebene Content-Plaene.'),
    ...marketing.connectors.filter(item => item.id !== 'whatsapp').map(item => connector(`marketing-${item.id}`, item.label, item.configured, item.requires || [], item.capabilities?.join(' · ') || '')),
    connector('whatsapp-meta', 'WhatsApp Business · Meta', metaWhatsApp.configured, ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_GRAPH_VERSION'], metaWhatsApp.configured ? 'Ein- und Ausgang bereit.' : 'Live-Kanal noch nicht komplett.'),
    connector('whatsapp-hub', 'Multi-WhatsApp Hub', hubWhatsApp.configured, ['WHATSAPP_HUB_API_KEY'], hubWhatsApp.configured ? 'Konten und Chats lesbar.' : 'Hub-Key fehlt.'),
    connector('gkv', 'GKV-Vergleich', Boolean(adviceConnectors.gkv?.configured), ['GKV_COMPARE_PROVIDER', 'GKV_COMPARE_URL'], 'Sicherer Startlink/API des gewaehlten Portals.'),
    connector(
      'energy-tariffs',
      'Strom & Gas · EnergyPartner24',
      Boolean(tariffConnector.comparisonEnabled),
      tariffConnector.portalLoginConfigured || tariffConnector.apiCredentialsConfigured
        ? ['Provider-Freigabe und verifizierter Tarifadapter']
        : ['ENERGY_TARIFF_PORTAL_USER/PASSWORD oder offizieller API-Zugang'],
      tariffConnector.reason,
    ),
    connector('opportunity-radar', 'Chancenradar', Boolean(opportunityResult.ready), opportunityResult.missing || ['APIFY_TOKEN'], opportunityResult.provider || ''),
  ];
  const uniqueConnectors = [...new Map(connectors.map(item => [item.id, item])).values()];
  const agents = listAgents();
  return {
    generatedAt: new Date().toISOString(),
    agents,
    operations: ops,
    connectors: {
      ready: uniqueConnectors.filter(item => item.ready).length,
      total: uniqueConnectors.length,
      items: uniqueConnectors,
    },
    systems: {
      qonekto: qonektoResult,
      crmQonektoSync: syncResult,
      voice: voiceResult,
      adviceKnowledge: knowledgeResult,
      opportunityRadar: opportunityResult,
    },
    buildBacklog: (learningResult.improvementRequests || []).filter(item => !['done', 'rejected'].includes(item.status)).slice(-30).reverse(),
  };
}

app.get('/api/control/status', async (_req, res) => {
  try { res.json(await controlSnapshot()); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/control/runs', async (req, res) => res.json(await listAgentRuns({ limit: req.query?.limit, status: String(req.query?.status || ''), agentId: String(req.query?.agentId || '') })));
app.get('/api/control/approvals', async (req, res) => res.json(await listApprovals({ limit: req.query?.limit, status: String(req.query?.status || '') })));
app.get('/api/control/audit', async (req, res) => res.json(await listAudit({ limit: req.query?.limit, category: String(req.query?.category || '') })));
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
app.post('/api/chat', async (req, res) => { try { res.json({ reply: await askIva(req.body?.message || '', req.body?.sessionId || 'web', req.body?.voice === true, req.body?.agentId || 'iva-standard') }); } catch (e) { res.json({ reply: 'Fehler: ' + e.message }); } });
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

// Voice-Lab: Roh-Audio wird nur transkribiert und nie gespeichert. Gespeichert werden
// ausschliesslich Transkript, Korrektur, Antwortbewertung und technische Messwerte.
app.post('/api/voice/transcribe', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '15mb' }), async (req, res) => {
  try {
    const result = await transcribeAudio(Buffer.from(req.body || []), {
      mime: String(req.headers['content-type'] || 'audio/webm'),
      fileName: String(req.headers['x-file-name'] || ''),
    });
    res.json(result);
  } catch (error) {
    res.status(/fehlt/.test(error.message) ? 503 : 400).json({ error: error.message });
  }
});
app.get('/api/voice-lab/summary', async (_req, res) => res.json(await voiceLabSummary()));
app.get('/api/voice-lab/evaluations', async (req, res) => {
  res.json(await listVoiceEvaluations({ limit: req.query?.limit, source: String(req.query?.source || '') }));
});
app.post('/api/voice-lab/evaluations', async (req, res) => {
  try { res.status(201).json(await recordVoiceEvaluation(req.body || {})); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/voice-lab/learning', async (_req, res) => res.json(await listVoiceLearning()));
app.post('/api/voice-lab/pronunciations', async (req, res) => {
  try { res.status(201).json(await savePronunciationCorrection({ ...(req.body || {}), source: 'voice-lab' })); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/voice-lab/preferences', async (req, res) => {
  try { res.status(201).json(await saveCommunicationPreference(req.body || {})); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/voice-lab/improvements', async (req, res) => {
  try { res.status(201).json(await captureImprovementRequest(req.body || {})); }
  catch (error) { res.status(400).json({ error: error.message }); }
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
    const sessionId = String(req.body?.sessionId || 'customers-web').slice(0, 200);
    const result = await prepareQonektoCustomerAction({
      sessionId,
      kind: req.body?.kind,
      customerId: req.body?.customerId,
      values: req.body?.values || {},
    });
    await createApproval({
      type: 'qonekto-write',
      title: result.kind === 'create-customer' ? 'Neue Qonekto-Kundenakte' : 'Qonekto-Stammdaten aendern',
      summary: result.preview || result.message || result.kind,
      agentId: 'iva-customer',
      externalKey: qonektoApprovalKey(sessionId),
      confirmationPhrase: result.confirmationPhrase,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    await recordAudit({ category: 'approval', action: result.kind, status: 'pending', actor: 'iva-customer', target: req.body?.customerId || 'neuer-kunde' });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/customers/actions/confirm', async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || 'customers-web').slice(0, 200);
    const result = await handleTrackedQonektoConfirmation(sessionId, req.body?.confirmation || '');
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

// --- Strom-/Gas-Tarife: sichere Anfragevorbereitung, Provider-Ergebnis bleibt belegpflichtig ---
app.get('/api/energy/tariffs/status', (_req, res) => res.json(energyTariffStatus()));
app.post('/api/energy/tariffs/prepare', (req, res) => {
  try { res.status(201).json(prepareEnergyTariffRequest(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/workspaces/:id/energy/tariffs/prepare', async (req, res) => {
  try {
    const prepared = await prepareWorkspaceEnergyTariffRequest({ workspaces, workspaceId: req.params.id, input: req.body || {} });
    res.status(prepared ? 201 : 404).json(prepared || { error: 'not found' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- IVA Buchhaltung: eigene Belegablage, Vorprüfung und Steuerberater-Übergabe ---
app.get('/api/accounting/summary', async (req, res) => {
  try { res.json(await accountingSummary({ month: String(req.query?.month || '').slice(0, 7) })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/accounting/categories', (_req, res) => res.json(ACCOUNTING_CATEGORIES));
app.get('/api/accounting/entities', async (_req, res) => res.json(await listAccountingEntities()));
app.post('/api/accounting/entities', async (req, res) => {
  try { res.status(201).json(await createAccountingEntity(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/accounting/documents', async (req, res) => {
  try {
    res.json(await listAccountingDocuments({
      month: String(req.query?.month || '').slice(0, 7),
      status: String(req.query?.status || '').slice(0, 20),
      entityId: String(req.query?.entityId || '').slice(0, 100),
      search: String(req.query?.search || '').slice(0, 200),
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/accounting/documents/:id', async (req, res) => {
  const document = await getAccountingDocument(req.params.id);
  res.status(document ? 200 : 404).json(document || { error: 'not found' });
});
app.post('/api/accounting/documents', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  try {
    const document = await storeAccountingDocument({
      name: req.query?.name,
      mime: req.query?.mime || req.headers['content-type'],
      entityId: String(req.query?.entityId || ''),
      buffer: req.body,
    });
    res.status(201).json(document);
  } catch (e) { res.status(e?.type === 'entity.too.large' ? 413 : 400).json({ error: e.message }); }
});
app.patch('/api/accounting/documents/:id', async (req, res) => {
  try {
    const document = await updateAccountingDocument(req.params.id, req.body || {});
    res.status(document ? 200 : 404).json(document || { error: 'not found' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/accounting/documents/:id/file', async (req, res) => {
  try {
    const file = await readAccountingFile(req.params.id);
    if (!file) return res.status(404).json({ error: 'not found' });
    res.set('Content-Type', file.meta.mime || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.meta.name)}`);
    res.send(file.buffer);
  } catch { res.status(404).json({ error: 'not found' }); }
});
app.get('/api/accounting/export.csv', async (req, res) => {
  try {
    const month = String(req.query?.month || '').slice(0, 7);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="IVA-Buchhaltung-${month || 'gesamt'}.csv"`);
    res.send(await exportAccountingCsv({ month }));
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// --- Chancen-Agent: Instagram-Signale -> Quellencheck -> Potenzialranking ---
app.get('/api/opportunities/status', async (_req, res) => res.json(await opportunityRadarStatus()));
app.get('/api/opportunities/settings', async (_req, res) => res.json(await getOpportunitySettings()));
app.patch('/api/opportunities/settings', async (req, res) => {
  try { res.json(await updateOpportunitySettings(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/opportunities/runs', async (req, res) => res.json(await listOpportunityRuns({ limit: req.query?.limit || 30 })));
app.get('/api/opportunities', async (req, res) => res.json(await listOpportunities({ status: req.query?.status || '', limit: req.query?.limit || 100 })));
app.get('/api/opportunities/:id', async (req, res) => {
  const item = await getOpportunity(req.params.id);
  res.status(item ? 200 : 404).json(item || { error: 'not found' });
});
app.post('/api/opportunities/scout', async (_req, res) => {
  try { res.status(201).json(await runOpportunityScout({ trigger: 'manual' })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/opportunities', async (req, res) => {
  try {
    const settings = await getOpportunitySettings();
    const scoring = scoreOpportunity(req.body || {}, settings);
    const item = await upsertOpportunity({ ...(req.body || {}), status: req.body?.status || 'new' });
    res.status(201).json(await updateOpportunity(item.id, { score: scoring.score, scoreBreakdown: scoring }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/opportunities/:id', async (req, res) => {
  try {
    const current = await getOpportunity(req.params.id);
    if (!current) return res.status(404).json({ error: 'not found' });
    const settings = await getOpportunitySettings();
    const merged = { ...current, ...(req.body || {}), ratings: { ...(current.ratings || {}), ...(req.body?.ratings || {}) } };
    const scoring = scoreOpportunity(merged, settings);
    res.json(await updateOpportunity(req.params.id, { ...(req.body || {}), score: scoring.score, scoreBreakdown: scoring }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/opportunities/:id/handoff', async (req, res) => {
  try { res.status(201).json(await prepareOpportunityHandoff(req.params.id)); }
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
    { command: 'chancen', description: 'Aktuelles Chancen-Ranking' },
    { command: 'stimme', description: 'Sprachausgabe an/aus' },
  ];
  try { await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commands }) }); }
  catch (e) { console.error('setMyCommands-Fehler:', e); }
}

cron.schedule('0 7 * * *', sendBriefing, { timezone: 'Europe/Berlin' });
cron.schedule('10 7 * * *', () => { void sendMarketingMorningReport().catch(error => console.error('Marketing-Morgenreport:', error.message)); }, { timezone: 'Europe/Berlin' });
cron.schedule('30 8 * * 1', () => { void sendWeeklyOpportunityPitch().catch(error => console.error('Chancenradar-Wochenpitch:', error.message)); }, { timezone: 'Europe/Berlin' });
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
app.get('/accounting', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'accounting.html')));
app.get('/opportunities', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'opportunities.html')));
app.get('/voice-lab', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'voice-lab.html')));
app.get('/control', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'control.html')));
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
app.get('/health/voice', async (_req, res) => res.json(await voiceLabSummary()));
app.get('/', (_req, res) => res.send('IVA laeuft.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('IVA-Core auf Port ' + PORT); setupTelegramWebhook(); setBotCommands(); });
