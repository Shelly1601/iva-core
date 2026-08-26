import 'dotenv/config';
import crypto from 'node:crypto';
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
import { importPanasonicLeadsToMeinCrm } from './integrations/meincrm-panasonic-leads.js';
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
import { lumitSkill } from './skills/lumit.js';
import { capabilityReviewSkill } from './skills/capability-review.js';
import { knowledgeLibrarySkill } from './skills/knowledge-library.js';
import { recruitingSkill } from './skills/recruiting.js';
import { deviceControlSkill } from './skills/device-control.js';
import { builderSkill } from './skills/builder.js';
import { planbarSkill } from './skills/planbar.js';
import { investmentSkill } from './skills/investment.js';
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
  markImprovementRequestDispatched,
  recordVoiceEvaluation,
  saveCommunicationPreference,
  savePronunciationCorrection,
  saveTranscriptionCorrection,
  voiceLabSummary,
  voiceLearningPromptContext,
} from './voice-lab/store.js';
import { transcribeAudio, transcriptionProviderStatus } from './voice-lab/transcribe.js';
import { askArchitect } from './agents/architect.js';
import * as workspaces from './workspaces/store.js';
import {
  cleanupExpiredProjectProtocols,
  ensureProjectProtocolSummaries,
  getProjectProtocol,
  listProjectProtocols,
  listProjectWorkflowRuns,
  recordProjectWorkflowResult,
} from './projects/protocols.js';
import {
  createAppointmentType,
  createBooking,
  createBookingIcs,
  getAppointmentTypeBySlug,
  listAppointmentTypes,
  listAvailableSlots,
  listBookings,
  updateAppointmentType,
} from './scheduling/store.js';
import {
  addCustomerSchedulingRequest,
  addProjectNote,
  createProject,
  createProjectFolder,
  deleteProjectLogo,
  deleteProject,
  getProject,
  listProjects,
  readProjectFile,
  readProjectLogo,
  renameProjectAutomation,
  setProjectAutomationEnabled,
  storeProjectFile,
  storeProjectLogo,
  updatePlanbarCapacity,
  updateProject,
} from './projects/store.js';
import {
  getPlanbarSearchIndex,
  replacePlanbarSearchIndex,
  searchPlanbarAppointments,
} from './operations/planbar-search.js';
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
  listOpportunityMarketAnalyses,
  listOpportunityWatchSources,
  listOpportunities,
  listOpportunityLinkChecks,
  listOpportunityRuns,
  prepareOpportunityHandoff,
  setOpportunityWatchSource,
  updateOpportunity,
  updateOpportunitySettings,
  upsertOpportunity,
} from './opportunities/store.js';
import { formatWeeklyPitch, scoreOpportunity } from './opportunities/score.js';
import { opportunityRadarStatus, runOpportunityScout } from './opportunities/scout.js';
import { checkOpportunityLink } from './opportunities/link-check.js';
import { opportunityMarketResearchStatus, runOpportunityMarketResearch } from './opportunities/market-research.js';
import { evaluateCapability, listCapabilityReviews } from './capabilities/evaluator.js';
import { assessKnowledgeSourceCandidate, knowledgeLibraryStatus, listKnowledgeLibrary } from './knowledge/library.js';
import { createCandidateSearchPlan, createInterviewGuide, screenResumeAgainstCriteria } from './recruiting/assistant.js';
import {
  createRecruitingCandidate,
  createRecruitingRole,
  deleteRecruitingCandidate,
  deleteRecruitingRole,
  getRecruitingCandidate,
  getRecruitingRole,
  listRecruitingCandidates,
  listRecruitingRoles,
  readRecruitingCandidateDocument,
  recruitingSummary,
  storeRecruitingCandidateDocument,
  updateRecruitingCandidate,
  updateRecruitingRole,
} from './recruiting/store.js';
import { calculateHeatLoad, calculateKfw458Funding, ENERGY_SOURCES } from './workspaces/energy-calculations.js';
import { calculateHeatPumpElectricity, calculatePvPrice, pvPriceCatalog } from './workspaces/pv-price-calculator.js';
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
import { crmQonektoSyncStatus, normalizeCrmLeadForIvaWorkspace, runCrmQonektoSync } from './integrations/crm-qonekto-sync.js';
import { buildNameSearchVariants, resolveLeadName } from './crm/name-matching.js';
import { suggestGermanAddresses } from './integrations/address-autocomplete.js';
import {
  completeGoogleGmailOAuth,
  createGoogleGmailAuthUrl,
  googleGmailStatus,
  listGoogleGmailLabels,
  listGoogleGmailMessages,
  probeGoogleGmail,
} from './integrations/google-gmail.js';
import { classifyTooOftenReplyWithAi } from './heat-hero/too-often-classifier.js';
import {
  TOO_OFTEN_LABEL_NAME,
  buildTooOftenGatewayRequest,
  createTooOftenReplyStore,
  runTooOftenReplyWorkflow,
} from './heat-hero/too-often-replies.js';
import {
  attachLumitCustomerPackage,
  calculateLumitPriceQuote,
  createLumitServicedApplication,
  getLumitApplication,
  listLumitApplications,
  lumitWorkflowConfig,
  markLumitApplicationStep,
  suggestLumitStartDate,
  validateLumitStartDate,
} from './integrations/lumit.js';
import { createLumitCustomerPackagePdf } from './integrations/lumit-package.js';
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
  listWhatsAppHandoffs,
  listWhatsAppProfiles,
  updateWhatsAppHandoff,
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
  upsertExternalAgentRun,
} from './operations/store.js';
import { buildJobsNeedingRefresh, buildProgressSnapshot, CURRENT_BUILD_RELEASE } from './operations/build-progress.js';
import { buildControlActivityFeed, buildProjectWorkflowOverview } from './operations/activity-feed.js';
import {
  AUTOMATION_DEFINITIONS,
  automationSummary,
  listAutomationReports,
  listAutomationRuns,
  listAutomations,
  setAutomationEnabled,
} from './automations/store.js';
import { createAutomationOrchestrator } from './automations/orchestrator.js';
import { formatCheckupTelegram, getIntegrationCheckupStatus, runIntegrationCheckup } from './maintenance/checkup.js';
import {
  buildAutomationReport,
  deliverReportEmailWithTelegramFallback,
  deliverReportTelegram,
  isMondayInBerlin,
  reportingStatus,
} from './automations/reporting.js';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  IVA_IMAC_DEVICE_ID,
  cancelDeviceCommand,
  claimNextDeviceCommand,
  completeDeviceCommand,
  deviceAgentStatus,
  deviceCommandStatus,
  enqueueDeviceCommand,
  listDeviceCommands,
  recordDeviceAgentHeartbeat,
} from './device-control/store.js';
import { createInvestmentModule } from './investment/index.js';

const app = express();
app.use(express.json({
  verify(req, _res, buffer) {
    if (req.originalUrl?.startsWith('/webhooks/whatsapp')) req.rawBody = Buffer.from(buffer);
  },
}));

const DATA_DIR = process.env.DATA_DIR || '/data';
const MEM_FILE = DATA_DIR + '/memory.json';
const tooOftenReplyStore = createTooOftenReplyStore({ dataDir: DATA_DIR });
const investment = createInvestmentModule({ dataDir: DATA_DIR });
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

function secureTokenMatch(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

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

DIESE ANFRAGE KOMMT PER SPRACHE. Sprich mit Nadine wie in einem echten, zügigen Gespräch – nicht wie in einem Bericht. Antworte direkt mit dem wichtigsten Gedanken. Standardmäßig höchstens vier kurze, flüssige Sätze und nur ein Gedanke pro Satz; ausführlicher nur, wenn Nadine das ausdrücklich verlangt. Wenn dir eine Angabe fehlt, stelle genau eine konkrete Rückfrage. Namen aus der Transkription sind ausdrücklich NICHT als korrekt geschrieben bestätigt. Bei einer CRM-Anfrage mit Personenname zuerst findHeatHeroLeads mit dem gehörten Namen aufrufen. Das Werkzeug prüft Schreibvarianten. Nur bei matchStatus "unique" den gespeicherten CRM-Namen verwenden. Bei "ambiguous" höchstens drei gefundene Namen zur Auswahl nennen; bei "not-found" genau fragen, wie der Nachname geschrieben wird. Namen niemals aus der Transkription erraten. Keine Einleitungs- oder Schlussfloskeln, kein Markdown, keine Listen, keine Tabellen, keine Emojis, keine URLs, E-Mail-Adressen oder Dateipfade zum Vorlesen. Schreibe Datum, Uhrzeit, Zahlen und Abkürzungen so, dass sie auf Deutsch natürlich gesprochen werden. Übersetze sperrige Fachkürzel in verständliche Alltagssprache. Sicherheits-, Quellen- und Bestätigungsregeln bleiben vollständig bestehen: Nichts erfinden, keine Änderung ohne die dafür vorgesehene Bestätigung und keine wichtige Warnung weglassen.`;
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

async function fetchGoogleGmailInbox(limit, folder = 'INBOX') {
  const mailbox = String(folder || 'INBOX').trim() || 'INBOX';
  const query = mailbox.toUpperCase() === 'INBOX' ? 'in:inbox' : `label:"${mailbox.replace(/"/g, '\\"')}"`;
  const result = await listGoogleGmailMessages({ limit, query });
  return result.messages.map(message => {
    const addresses = [message.to, message.deliveredTo, message.from].filter(Boolean).join(', ');
    return {
      konto: 'IVA Gmail API',
      ordner: mailbox,
      bereich: bereichFor(addresses),
      an: [message.to, message.deliveredTo].filter(Boolean).join(', '),
      von: message.from,
      von_name: '',
      betreff: message.subject,
      datum: message.date || null,
      ungelesen: (message.labelIds || []).includes('UNREAD'),
      snippet: message.snippet || '',
      gmail_id: message.id,
      gmail_labels: message.labelIds || [],
    };
  });
}

async function fetchAllMailSources(limit = 15, folder = 'INBOX', konto = '') {
  const needle = String(konto || '').trim().toLowerCase();
  const allowedGoogleAccount = String(process.env.GMAIL_ALLOWED_ACCOUNT || '').trim().toLowerCase();
  const googleStatus = await googleGmailStatus().catch(() => ({ ready: false }));
  let all = [];

  const wantsGoogle = !needle || `iva gmail api ${allowedGoogleAccount}`.includes(needle);
  if (googleStatus.ready && wantsGoogle) {
    try { all = all.concat(await fetchGoogleGmailInbox(limit, folder)); }
    catch (error) { all.push({ konto: 'IVA Gmail API', ordner: folder, fehler: error.message }); }
  }

  let accounts = loadMailAccounts();
  if (googleStatus.ready && allowedGoogleAccount) {
    accounts = accounts.filter(acc => String(acc.user || '').trim().toLowerCase() !== allowedGoogleAccount);
  }
  if (needle) accounts = accounts.filter(acc => `${acc.label} ${acc.user}`.toLowerCase().includes(needle));
  for (const acc of accounts) {
    try { all = all.concat(await fetchInbox(acc, limit, folder)); }
    catch (error) { all.push({ konto: acc.label, ordner: folder, fehler: error.message }); }
  }
  return all;
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

function crmLeadRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.leads)) return value.leads;
  if (Array.isArray(value?.leads?.data)) return value.leads.data;
  return [];
}

async function importCrmCustomerFile({ projekt = '', suche = '' } = {}) {
  const query = String(suche || '').trim();
  if (!query) throw new Error('Kundenname fuer den CRM-Import fehlt.');
  const sources = (await fetchAllLeads()).filter(source => !projekt || source.projekt.toLocaleLowerCase('de').includes(String(projekt).toLocaleLowerCase('de')));
  const candidates = sources.flatMap(source => crmLeadRows(source.leads).map(lead => ({ ...lead, __ivaProject: source.projekt })));
  const resolution = resolveLeadName(query, candidates, 8);
  if (resolution.matchStatus !== 'unique') {
    return {
      saved: false,
      matchStatus: resolution.matchStatus,
      candidates: resolution.candidates.slice(0, 3).map(candidate => ({ name: candidate.name, project: candidate.lead.__ivaProject, email: candidate.email, city: candidate.city })),
      clarification: resolution.matchStatus === 'ambiguous'
        ? `Welche Person ist gemeint: ${resolution.candidates.slice(0, 3).map(candidate => `${candidate.name} (${candidate.lead.__ivaProject})`).join(', ')}?`
        : 'Wie wird der Nachname geschrieben? Im CRM wurde kein eindeutiger Treffer gefunden.',
    };
  }
  const lead = resolution.bestMatch.lead;
  const input = normalizeCrmLeadForIvaWorkspace(lead, { project: lead.__ivaProject || projekt || 'CRM' });
  const localFiles = await workspaces.listWorkspaces({ mode: 'kunde' });
  const exactName = String(input.customer.name || '').toLocaleLowerCase('de');
  const exactEmail = String(input.customer.email || '').toLocaleLowerCase('de');
  const possibleDuplicates = localFiles.filter(workspace => {
    if (workspace.data?.crm?.sourceKey === input.data.crm.sourceKey) return false;
    if (exactEmail && String(workspace.customer?.email || '').toLocaleLowerCase('de') === exactEmail) return true;
    return exactName && String(workspace.customer?.name || '').toLocaleLowerCase('de') === exactName;
  });
  if (possibleDuplicates.length > 1) {
    return {
      saved: false,
      matchStatus: 'local-duplicates',
      candidates: possibleDuplicates.slice(0, 5).map(workspace => ({ id: workspace.id, name: workspace.customer?.name || workspace.title, email: workspace.customer?.email || '' })),
      clarification: 'In IVA gibt es bereits mehrere Akten mit diesem Namen. Bitte die überzähligen Akten im Kundenbereich löschen und den Import danach erneut starten.',
    };
  }
  if (possibleDuplicates.length === 1) input.data.idempotencyKey = possibleDuplicates[0].data?.idempotencyKey || `workspace:${possibleDuplicates[0].id}`;
  const workspace = possibleDuplicates.length === 1
    ? await workspaces.updateWorkspace(possibleDuplicates[0].id, { title: input.title, status: 'active', customer: input.customer, data: input.data })
    : await workspaces.createWorkspace(input);
  for (const note of input.notes || []) {
    if (!(workspace.notes || []).some(existing => existing.text === note.text && existing.source === note.source)) await workspaces.addWorkspaceNote(workspace.id, note.text, note.source);
  }
  return {
    saved: true,
    matchStatus: 'unique',
    action: possibleDuplicates.length === 1 ? 'updated-existing-customer-file' : 'created-or-updated-customer-file',
    workspace: await workspaces.getWorkspace(workspace.id),
    transferredToQonekto: false,
  };
}

async function syncStrategyCustomersToQonekto({ force = false } = {}) {
  return runCrmQonektoSync({
    fetchLeads: () => fetchLeads(GOALS_CONCEPTS_CRM_SOURCE),
    upsertCustomer: upsertQonektoCustomerAutomatically,
    force,
  });
}

async function heatHeroGateway(path = '', { method = 'GET', body, timeoutMs = 8000 } = {}) {
  const key = process.env.HEATHERO_API_KEY;
  if (!key) throw new Error('kein HEATHERO_API_KEY gesetzt');
  const r = await fetchWithTimeout(`${HEATHERO_LEADS_URL}${path}`, {
    method,
    headers: {
      'X-API-Key': key,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, timeoutMs);
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
  const query = String(search || '').trim();
  const safeLimit = Math.min(Math.max(limit || 20, 1), 50);
  const fetchVariant = async variant => {
    const params = new URLSearchParams({ search: variant, limit: String(Math.max(safeLimit, 30)) });
    const payload = await heatHeroGateway(`?${params.toString()}`);
    const leads = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.leads) ? payload.leads : Array.isArray(payload) ? payload : [];
    return { variant, leads };
  };
  const direct = await fetchVariant(query);
  const looksLikeName = /\p{L}/u.test(query) && !query.includes('@') && !/\d{5,}/.test(query);
  if (!looksLikeName) {
    return {
      system: 'Heat Hero CRM (eigenstaendig)', query, searchedVariants: [query], count: direct.leads.length,
      matchStatus: direct.leads.length === 1 ? 'unique' : direct.leads.length ? 'ambiguous' : 'not-found',
      leads: direct.leads.slice(0, safeLimit),
    };
  }
  let combined = [...direct.leads];
  let resolution = resolveLeadName(query, combined, safeLimit);
  const variants = buildNameSearchVariants(query, 8);
  if (resolution.matchStatus !== 'unique') {
    const additional = await Promise.all(variants.filter(variant => variant !== query).slice(0, 6).map(fetchVariant));
    combined = combined.concat(...additional.flatMap(result => result.leads));
    resolution = resolveLeadName(query, combined, safeLimit);
  }
  return {
    system: 'Heat Hero CRM (eigenstaendig)',
    ...resolution,
    searchedVariants: variants,
    count: resolution.candidates.length,
    leads: resolution.candidates.map(candidate => candidate.lead),
  };
}

function tooOftenRepliesWriteEnabled() {
  return process.env.HEATHERO_TOO_OFTEN_REPLIES_WRITE_ENABLED !== 'false';
}

async function submitTooOftenReplyAction({ leadId, action }) {
  if (!tooOftenRepliesWriteEnabled()) throw new Error('Der Live-Schreibschalter für Rückmeldungen ist nicht aktiv.');
  const request = buildTooOftenGatewayRequest(leadId, action);
  const payload = await heatHeroGateway(request.path, { method: request.method, body: request.body, timeoutMs: 45_000 });
  return {
    ...((payload && typeof payload === 'object') ? payload : {}),
    verified: payload?.verified === true,
    idempotentReplay: payload?.idempotentReplay === true || payload?.idempotent_replay === true,
  };
}

async function tooOftenReplyWorkflowStatus() {
  const [gmail, state] = await Promise.all([
    googleGmailStatus().catch(error => ({ ready: false, error: error.message })),
    tooOftenReplyStore.summary(),
  ]);
  const endpointConfigured = true;
  const writeEnabled = tooOftenRepliesWriteEnabled();
  const missing = [];
  if (!gmail.ready) missing.push('Google-Gmail-Verbindung');
  if (!process.env.HEATHERO_API_KEY) missing.push('HEATHERO_API_KEY');
  if (!writeEnabled) missing.push('HEATHERO_TOO_OFTEN_REPLIES_WRITE_ENABLED ist deaktiviert');
  return {
    label: TOO_OFTEN_LABEL_NAME,
    schedule: 'Täglich · 08:15 Uhr',
    gmailReady: gmail.ready === true,
    endpointConfigured,
    writeEnabled,
    liveReady: gmail.ready === true && Boolean(process.env.HEATHERO_API_KEY) && endpointConfigured && writeEnabled,
    missing,
    state,
  };
}

async function runHeatHeroTooOftenReplies() {
  const status = await tooOftenReplyWorkflowStatus();
  if (!status.gmailReady) return { status: 'blocked', error: 'Google-Gmail-Verbindung fehlt.', summary: 'Rückmeldungsworkflow blockiert: Google-Gmail-Verbindung fehlt.' };
  const result = await runTooOftenReplyWorkflow({
    listMessages: listGoogleGmailMessages,
    findLead: searchHeatHeroLeads,
    submitAction: submitTooOftenReplyAction,
    classifyUnclear: classifyTooOftenReplyWithAi,
    store: tooOftenReplyStore,
    writeEnabled: status.liveReady,
    limit: 100,
  });
  if (!status.liveReady) {
    return {
      ...result,
      status: 'blocked',
      error: `Livegang fehlt: ${status.missing.join(', ')}`,
      summary: `${result.summary} Livegang fehlt: ${status.missing.join(', ')}.`,
    };
  }
  return result;
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
- Umsetzung ohne ausdrücklichen Bauauftrag (Signale: "wie mache ich", "hilf mir einrichten"): genau ein konkreter nächster Schritt. Ein ausdrücklicher Bauauftrag ("mach das", "bau das", "setz das um" oder gleichbedeutend) wird dagegen vollständig und ohne erneute Planbestätigung über startIvaBuild gestartet.
- Steht ein vorhandener Workflow auf geplant, vorbereitet, pausiert, blockiert oder fehlerhaft und Nadine sagt "mach das", "fix das", "bau das fertig" oder nutzt den Fertig-bauen-Button, ist genau dieser Zustand Teil des Bauauftrags und keine Antwort. Finde eigenständig einen funktionierenden technischen Weg oder übergib den vollständigen Auftrag sofort mit startIvaBuild an Codex. Ein alter Bug, fehlende interne Anbindung oder früherer Blocker ist kein Endergebnis. Bau, Befehle, Tests, Git/Push, Railway-Deploy und Live-Prüfung laufen bevorzugt über den dauerhaft aktiven iMac und den gesicherten iMac-/Codex-Kanal. Zurück zu Nadine darf nur ein nach konkretem Versuch technisch erzwungener Schritt, den ausschließlich sie leisten kann; nenne dann den bereits versuchten Weg und genau den verbleibenden Schritt.
- Typ unklar: eine (nicht mehrere) präzise Rückfrage.

So denkst du je Fachgebiet:

- Vertrieb, Marketing, Business: wie ein erfahrener Unternehmer und Verkäufer. Perspektiven Cashflow, Kundenwert, Skalierbarkeit, USP, Timing. Bei Verkaufssituationen konkrete Formulierungen (Öffner, Einwandbehandlung, Closing-Frage), keine Prinzipien-Vorträge.
- Finanz und Versicherung (Nadines Kernfach): rechne konkret in Größenordnungen, nenn gesetzliche Basis wenn relevant. Bei unklaren Fakten kurz nachfragen, sonst weitermachen.
- Technisch: bei Erklärungen kompakt und schrittweise. Bei einem ausdrücklichen Bauauftrag nicht auf Feedback warten, sondern startIvaBuild sofort verwenden.

Challenge- und Alternativen-Reflex:

- Vorschlag oder Plan wirkt schwach: in einem Satz sagen warum, sofort eine bessere Variante mit einem Grund liefern. Keine Weichspüler.
- Bei jeder inhaltlichen Antwort außer reinen Faktenfragen: eine Alternative oder Verbesserung als kurzer Bullet oder Halbsatz am Ende — nicht als eigene Sektion.
- Widerspruch nur bei echtem Business- oder Fach-Zweifel, nicht bei Stil oder Formulierung.

Tool-Nutzung:

- Bevor du aus einem Reel, Profil, fremden Tool oder einer spontanen Idee eine neue IVA-Funktion oder einen neuen Agenten empfiehlst, MUSST du assessCapability aufrufen. Pruefe echten Zusatznutzen, bestehende Abdeckung, offiziellen Nachweis, Rechte, Kosten, Datenschutz und Sicherheitsfolgen. Ergebnis "integrate-existing" bedeutet: keinen neuen Agenten bauen. "needs-verification" oder "watch" bedeutet: noch nicht integrieren. Fremden Code, geschuetzte Texte oder Designs niemals kopieren; nur eigenstaendig implementierte Funktionsmuster uebernehmen.
- Live-Daten oder Aktion nötig (Kalender, Mails, Leads, Todos, Kampagnen, Bilder, Qonekto/blau direkt): Tool sofort aufrufen. Nie "hätte ich Zugriff auf…", nie "soll ich mal nachsehen?" — machen und dann zusammenfassen.
- Eine Anmeldeseite, eine abgelaufene Sitzung oder eine erneute Authentifizierungsaufforderung ist kein Abbruchgrund. Bei jedem von Nadine freigegebenen System selbstständig die bereits vorhandenen Zugangsdaten und, falls erforderlich, den eingerichteten Authenticator aus dem sicheren lokalen beziehungsweise verbundenen Kontext verwenden, anmelden und die Aufgabe fortsetzen. Nadine nicht erneut nach bekannten Zugangsdaten oder einer normalen Anmeldung fragen. Passwörter und Einmalcodes niemals anzeigen, kopieren, in Prompts oder Dateien speichern oder protokollieren. Erst ein tatsächlich erschienener CAPTCHA, eine technisch erzwungene externe Bestätigung, eine Kontosperre oder nach einem konkreten Anmeldeversuch ausdrücklich abgelehnte beziehungsweise im sicheren Kontext technisch nicht verfügbare Zugangsdaten sind ein echter Blocker; diesen präzise benennen.
- Das Wort "oben" bedeutet bei Nadine immer den iMac. Wenn eine normale freigegebene Aktion "oben" oder "auf dem iMac" passieren soll, darf sie niemals auf dem MacBook ausgeführt werden. Für eine direkt unterstützte Geräteaktion sendCommandToImac verwenden. Passt keine engere Geräteaktion, aber Nadine hat eine gewöhnliche lokale iMac-Aktion ausdrücklich beauftragt, runTaskOnImac verwenden. Für Panasonic, Bosch, Pipedrive, Airtable oder Planbar bei Bedarf ensureImacPortalLogin verwenden: normale Wiederanmeldungen sind von Nadine dauerhaft freigegeben und brauchen keine neue Rückfrage; Zugangsdaten bleiben im lokalen macOS-Schlüsselbund, Panasonic-2FA wird ohne Zwischenablage direkt aus dem fest freigegebenen Ente-Auth-Eintrag eingesetzt. Erst CAPTCHA, Kontosperre, externe Bestätigung, ausdrücklich abgelehnte oder lokal nicht vorhandene Zugangsdaten sind ein echter Login-Blocker. Für ausdrücklich beauftragte IVA-Code-, App- oder Systemänderungen stattdessen startIvaBuild verwenden; dieses Werkzeug übergibt den vollständigen Auftrag kontrolliert an Codex. Niemals so tun, als sei ein nur eingereihter Befehl bereits ausgeführt; anschließend den passenden Befehls- beziehungsweise Codex-Auftragsstatus prüfen. Keine Zugangsdaten und keine beliebigen Dateipfade an den Gerätekanal übergeben.
- CRM-Namen aus Sprache oder freier Texteingabe können falsch geschrieben beziehungsweise transkribiert sein. Vor jeder CRM-Auskunft oder -Aktion zu einer namentlich genannten Person findHeatHeroLeads mit der gelieferten Schreibweise aufrufen. Das Werkzeug durchsucht Schreibvarianten. Bei matchStatus "unique" ausschließlich den gespeicherten CRM-Namen und die gespeicherte ID verwenden. Bei "ambiguous" mit höchstens drei Kandidaten nachfragen, welcher gemeint ist. Bei "not-found" genau eine Frage stellen: wie der Nachname geschrieben wird. Niemals einen ähnlich klingenden Namen stillschweigend auswählen. Bei anderen CRM-Projekten ohne eigenen Resolver gilt mindestens dieselbe Rückfragepflicht, bis der gespeicherte Vollname eindeutig ist.
- Wenn Nadine verlangt, eine Kundenakte aus dem CRM anzulegen oder CRM-Daten in die Kundenakte zu ziehen, ausschließlich importCrmCustomerFile aufrufen. Dieses Werkzeug erstellt eine aktive Kundenakte, übernimmt vorhandene Kontaktdaten und CRM-Notizen und verhindert Dubletten. Dafür niemals mehrfach createWorkspace aufrufen. Eine Qonekto-/Blau-direkt-Übertragung erfolgt dadurch ausdrücklich noch nicht.
- Mehrere Quellen relevant (z. B. Kalender + Mails + Leads): parallel abrufen.
- Fach-/Recherche-Anfragen: askArchitect mit der präzisen Frage. Der Router entscheidet zwischen knowledge (zeitloses Fachwissen zu Finanz/Versicherung/Vorsorge/Rente) und web-research (aktuelle öffentliche Fakten wie Gesetze, Grenzwerte, Beitragssätze, Freibeträge, Fördersätze, Produktdatenblätter, Versicherungsbedingungen, Preise, Nachrichten, Öffnungszeiten). Für JEDE aktuelle Zahl / jeden aktuellen Grenzwert PFLICHT diesen Router nutzen statt aus dem Kopf zu antworten. Für eigene Systeme (Kalender/Mails/CRM/Leads/Kampagnen/Todos/Bilder) stattdessen direkt das passende Tool.
- Kundinnen, Kunden, Vertraege, Dokumente, Archiv, Aufgaben oder Schaeden aus blau direkt/AMEISE/Qonekto: zuerst listQonektoTools nutzen. Lesende Werkzeuge mit callQonektoReadTool sofort ausfuehren. Veraendernde Werkzeuge ausschliesslich mit prepareQonektoWrite vorbereiten, Aenderung klar wiederholen und Nadine fragen, ob sie das wirklich will. Ausgefuehrt wird serverseitig erst nach ihrer separaten, exakten Antwort "Ja, Qonekto-Aenderung ausfuehren". Niemals behaupten, eine nur vorbereitete Aenderung sei bereits erfolgt. Destruktive Werkzeuge bleiben blockiert. Niemals Qonekto-Daten raten oder durch oeffentliche Web-Recherche ersetzen.
- Beratungsarten und vorhandene Fachmodule mit listAdviceModules ermitteln. Bei Tarif-, Altvertrags- oder Produktvergleichen zuerst searchAdviceKnowledge nutzen. Leistungsmerkmale ausschliesslich aus belegten Originalunterlagen nennen; fehlende Tarifstaende, Bedingungen oder Produktinformationsblaetter als Datenluecke markieren und niemals erfinden. DIN 77230 betrifft Privathaushalte, DIN 77235 Selbststaendige und KMU. Ohne vollstaendig hinterlegtes lizenziertes Regelwerk nur "DIN-orientierte Vorbereitung" sagen, niemals "DIN-konform".
- Nach Toolaufruf: Ergebnis im passenden Antwort-Format (siehe oben), nicht die Rohdaten.

Direktes Lernen und Selbstverbesserung:

- Wenn Nadine ausdrücklich sagt, dass ein Begriff, Name oder Kürzel anders ausgesprochen wird, sofort savePronunciationCorrection verwenden und die genaue Zuordnung bestätigen. Die Korrektur gilt ab der nächsten Sprachausgabe.
- Wenn Nadine ausdrücklich eine dauerhafte Kommunikationsregel nennt, zum Beispiel kürzer antworten, zuerst das Ergebnis sagen oder einen Ausdruck nicht mehr verwenden, saveCommunicationPreference verwenden. Aus bloßem Ärger oder einer mehrdeutigen Bemerkung keine dauerhafte Regel ableiten; dann genau eine Rückfrage stellen.
- Wenn Nadine eine Funktion oder Systemänderung nur als Idee nennt, captureImprovementRequest verwenden und ehrlich sagen, dass sie lediglich gemerkt wurde.
- Wenn Nadine die Umsetzung klar beauftragt, etwa mit "mach das", "bau das", "setz das um" oder gleichbedeutend, startIvaBuild sofort mit dem vollständigen Gesprächskontext verwenden. Keine erneute Plan-, Code-, Push- oder Deployment-Bestätigung verlangen. Der Codex-Auftrag folgt AGENTS.md und umfasst Bau, Tests, Fehlerbehebung, Commit, Push, Railway-Deployment und Live-Prüfung.
- Dass ein Workflow aktuell blockiert, fehlerhaft, nur geplant oder noch nicht angebunden ist, verhindert startIvaBuild nicht. Übernimm Status, Zweck, Sicherheitsregel, bisherigen Blocker und gewünschtes Ergebnis vollständig in den Bauauftrag, damit Codex den Ausführungsweg fertigstellt und live prüft.
- Niemals behaupten, IVA habe sich bereits repariert, gebaut oder weiterentwickelt, wenn der Codex-Auftrag nur eingereiht oder noch nicht nachweislich abgeschlossen ist.

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
  calendar:  calendarSkill({ getEventsRaw, getCalendlyEvents, fmtEvents, listAppointmentTypes, createAppointmentType }),
  mails:     mailsSkill({ loadMailAccounts, fetchInbox, fetchAllMailSources }),
  crm:       crmSkill({ fetchAllLeads, searchHeatHeroLeads, updateHeatHeroLeadStatus, importCrmCustomerFile }),
  marketing: marketingSkill({ campaigns, brands, analyzeReferences, generateImage, generateContent }),
  research:  researchSkill({ askArchitect }),
  workspaces: workspacesSkill({ workspaces }),
  advice:    adviceSkill({ publicAdviceCatalog, listAdviceKnowledge }),
  opportunities: opportunitiesSkill({ listOpportunities, runOpportunityScout, checkOpportunityLink, runOpportunityMarketResearch, listOpportunityWatchSources, prepareOpportunityHandoff }),
  accounting: accountingSkill({ listAccountingEntities, listAccountingDocuments, getAccountingDocument, accountingSummary }),
  energyTariffs: energyTariffsSkill({ workspaces, energyTariffStatus, prepareWorkspaceEnergyTariffRequest }),
  selfImprovement: selfImprovementSkill({ savePronunciationCorrection, saveCommunicationPreference, captureImprovementRequest, listVoiceLearning }),
  builder: builderSkill({ captureImprovementRequest, markImprovementRequestDispatched, enqueueDeviceCommand, deviceCommandStatus }),
  lumit:      lumitSkill({ lumitWorkflowConfig, listLumitApplications, createLumitServicedApplication, markLumitApplicationStep }),
  capabilityReview: capabilityReviewSkill({ evaluateCapability, listCapabilityReviews }),
  knowledgeLibrary: knowledgeLibrarySkill({ listKnowledgeLibrary, knowledgeLibraryStatus, assessKnowledgeSourceCandidate }),
  recruiting: recruitingSkill({ createCandidateSearchPlan, screenResumeAgainstCriteria, createInterviewGuide }),
  deviceControl: deviceControlSkill({ enqueueDeviceCommand, deviceCommandStatus }),
  planbar:    planbarSkill({ searchPlanbarAppointments, enqueueDeviceCommand, deviceCommandStatus, getProject }),
  investment: investmentSkill({ investment }),
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
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN fehlt.');
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: toTelegramHTML(text), parse_mode: 'HTML' }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.description || `Telegram HTTP ${response.status}`);
  return payload.result || payload;
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
  const mem = await loadMemory(); if (!mem.chatId) throw new Error('Telegram-Chat-ID fehlt. IVA muss zuerst einmal in Telegram angeschrieben werden.');
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
  return { chatId: mem.chatId, summary: 'Morning-Briefing per Telegram zugestellt.' };
}

async function sendMarketingMorningReport() {
  const mem = await loadMemory(); if (!mem.chatId) throw new Error('Telegram-Chat-ID fehlt. IVA muss zuerst einmal in Telegram angeschrieben werden.');
  const report = await createMarketingReport({ period: 'morning' });
  await sendTelegram(mem.chatId, report.text);
  return { chatId: mem.chatId, reportId: report.id || '', summary: 'Marketing-Morgenreport per Telegram zugestellt.' };
}

async function sendWeeklyOpportunityPitch() {
  const settings = await getOpportunitySettings();
  if (!settings.weeklyEnabled) return { status: 'skipped', summary: 'Wochenlauf ist im Chancenradar-Suchprofil ausgeschaltet.' };
  if (!process.env.APIFY_TOKEN) return { status: 'blocked', summary: 'Chancenradar kann ohne APIFY_TOKEN nicht automatisch laufen.', error: 'APIFY_TOKEN fehlt.' };
  const result = await runOpportunityScout({ trigger: 'weekly' });
  const mem = await loadMemory();
  if (mem.chatId) await sendTelegram(mem.chatId, result.pitch);
  return { ...result, summary: mem.chatId ? 'Chancenradar abgeschlossen und Wochenpitch zugestellt.' : 'Chancenradar abgeschlossen; Telegram-Chat-ID fehlt.' };
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

function authorizedImacAgent(req) {
  const expected = String(process.env.IMAC_DEVICE_TOKEN || '');
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (expected.length < 32 || supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function imacAgentMetadataFromRequest(req) {
  return {
    hostname: String(req.headers['x-iva-agent-host'] || ''),
    protocolVersion: Number(req.headers['x-iva-agent-protocol'] || 0),
    release: String(req.headers['x-iva-agent-release'] || ''),
    workspace: String(req.headers['x-iva-agent-workspace'] || ''),
    iCloudAuthoritative: String(req.headers['x-iva-agent-icloud'] || '').toLowerCase() === 'true',
  };
}

// Der iMac baut die Verbindung ausschließlich ausgehend zu Railway auf. Diese
// Endpunkte verwenden ein eigenes Gerätetoken statt des Cockpit-Tokens.
app.post('/device-agent/:deviceId/heartbeat', async (req, res) => {
  if (!authorizedImacAgent(req) || req.params.deviceId !== IVA_IMAC_DEVICE_ID) return res.sendStatus(401);
  try {
    const headerMetadata = imacAgentMetadataFromRequest(req);
    const bodyMetadata = req.body || {};
    if (String(bodyMetadata.hostname || '').toLowerCase().replace(/\.local$/, '') !== headerMetadata.hostname.toLowerCase().replace(/\.local$/, '')
      || Number(bodyMetadata.protocolVersion || 0) !== headerMetadata.protocolVersion
      || String(bodyMetadata.release || '') !== headerMetadata.release
      || String(bodyMetadata.workspace || '') !== headerMetadata.workspace
      || (bodyMetadata.iCloudAuthoritative === true) !== headerMetadata.iCloudAuthoritative) {
      return res.status(409).json({ error: 'Geräte-Attestierung abgelehnt: Heartbeat und Agent-Header widersprechen sich.' });
    }
    res.json(await recordDeviceAgentHeartbeat({ deviceId: req.params.deviceId, ...bodyMetadata }));
  } catch (error) { res.status(403).json({ error: error.message }); }
});
app.get('/device-agent/:deviceId/status', async (req, res) => {
  if (!authorizedImacAgent(req) || req.params.deviceId !== IVA_IMAC_DEVICE_ID) return res.sendStatus(401);
  res.json(await deviceAgentStatus(req.params.deviceId));
});
app.get('/device-agent/:deviceId/commands/next', async (req, res) => {
  if (!authorizedImacAgent(req) || req.params.deviceId !== IVA_IMAC_DEVICE_ID) return res.sendStatus(401);
  try { res.json({ command: await claimNextDeviceCommand(req.params.deviceId, imacAgentMetadataFromRequest(req)) }); }
  catch (error) { res.status(/Attestierung/.test(error.message) ? 403 : 500).json({ error: error.message }); }
});
app.post('/device-agent/:deviceId/commands/:commandId/complete', async (req, res) => {
  if (!authorizedImacAgent(req) || req.params.deviceId !== IVA_IMAC_DEVICE_ID) return res.sendStatus(401);
  try {
    res.json(await completeDeviceCommand({
      deviceId: req.params.deviceId,
      commandId: req.params.commandId,
      leaseToken: req.body?.leaseToken,
      ok: req.body?.ok === true,
      result: req.body?.result || null,
      error: req.body?.error || '',
      agentMetadata: imacAgentMetadataFromRequest(req),
    }));
  } catch (error) { res.status(409).json({ error: error.message }); }
});

function schedulingStatus() {
  const calendarWriteReady = String(process.env.SCHEDULING_CALENDAR_WRITE_READY || '').toLowerCase() === 'true';
  const confirmationMailReady = String(process.env.SCHEDULING_MAIL_SEND_READY || '').toLowerCase() === 'true';
  return {
    previewReady: true,
    liveReady: calendarWriteReady && confirmationMailReady,
    calendarWriteReady,
    confirmationMailReady,
    calendarProvider: String(process.env.SCHEDULING_CALENDAR_PROVIDER || 'noch nicht verbunden'),
    mailProvider: String(process.env.SCHEDULING_MAIL_PROVIDER || 'noch nicht verbunden'),
  };
}

// Oeffentliche Buchungsseiten verwenden absichtlich keinen IVA-API-Token.
// Nur ausdruecklich aktivierte Terminarten sind erreichbar; live geht erst nach
// verifiziertem Kalender-Schreibzugriff und Bestätigungs-Mailkanal.
app.get('/booking-api/:slug', async (req, res) => {
  const appointmentType = await getAppointmentTypeBySlug(String(req.params.slug || ''));
  if (!appointmentType) return res.status(404).json({ error: 'Terminlink nicht gefunden oder noch nicht aktiv.' });
  res.json({ appointmentType, slots: await listAvailableSlots(appointmentType, { days: Math.min(Number(req.query?.days) || 21, 60) }) });
});
app.post('/booking-api/:slug', async (req, res) => {
  try {
    const result = await createBooking(String(req.params.slug || ''), req.body || {});
    res.status(201).json({ ...result, icsUrl: `/booking-api/${encodeURIComponent(req.params.slug)}/bookings/${encodeURIComponent(result.booking.id)}.ics` });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

// Der iMac meldet Workflow-Ergebnisse über seinen bereits eingerichteten,
// ausschließlich im macOS-Schlüsselbund gespeicherten Gerätetoken. Dieser
// enge Schreibweg akzeptiert nur Protokolle und keine sonstigen Projektfelder.
app.post('/device-agent/:deviceId/project-workflow-runs', async (req, res) => {
  if (!authorizedImacAgent(req) || req.params.deviceId !== IVA_IMAC_DEVICE_ID) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try { res.status(201).json(await recordProjectWorkflowResult('heat-hero', req.body || {})); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/device-agent/:deviceId/operational-runs', async (req, res) => {
  if (!authorizedImacAgent(req) || req.params.deviceId !== IVA_IMAC_DEVICE_ID) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try { res.status(201).json(await upsertExternalAgentRun(req.body || {})); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/device-agent/:deviceId/planbar-capacity', async (req, res) => {
  if (!authorizedImacAgent(req) || req.params.deviceId !== IVA_IMAC_DEVICE_ID) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try { res.status(200).json(await updatePlanbarCapacity('heat-hero', req.body || {})); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/device-agent/:deviceId/planbar-search-index', async (req, res) => {
  if (!authorizedImacAgent(req) || req.params.deviceId !== IVA_IMAC_DEVICE_ID) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try { res.status(200).json(await replacePlanbarSearchIndex(req.body || {})); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

// Die lokalen iMac-Läufe brauchen vor dem Start ausschließlich ihre
// projektbezogenen Ein-/Aus-Schalter. Der Endpunkt gibt bewusst keine
// Projektnotizen, Dateien oder sonstigen internen Daten preis; Änderungen
// bleiben weiterhin über die geschützte Projektakte authentifiziert.
app.get('/public-api/projects/heat-hero/automation-flags', async (_req, res) => {
  try {
    const project = await getProject('heat-hero');
    const allowedIds = new Set(['kfw-approval-morning', 'montage-required-fields-morning', 'planbar-completion-morning']);
    const automations = Object.fromEntries((project?.automations || [])
      .filter(item => allowedIds.has(item.id))
      .map(item => [item.id, { enabled: item.enabled === true, status: item.status }]));
    res.set('Cache-Control', 'no-store').json({ projectId: 'heat-hero', automations });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/booking-api/:slug/bookings/:bookingId.ics', async (req, res) => {
  const type = await getAppointmentTypeBySlug(String(req.params.slug || ''));
  const booking = (await listBookings({ limit: 1000 })).find(item => item.id === req.params.bookingId && item.appointmentTypeId === type?.id);
  if (!type || !booking) return res.status(404).send('Termin nicht gefunden.');
  res.type('text/calendar; charset=utf-8').set('Content-Disposition', 'attachment; filename="IVA-Termin.ics"').send(createBookingIcs(booking, type));
});

// Google leitet nach der ausdruecklichen Gmail-Freigabe auf diesen oeffentlichen
// Callback zurueck. Ein kurzlebiger, verschluesselt gespeicherter State schuetzt
// vor fremden oder wiederholten Callback-Anfragen. Zugangsdaten erscheinen nie
// in HTML, Logs oder der URL.
app.get('/oauth/google/start', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.redirect(await createGoogleGmailAuthUrl()); }
  catch (error) {
    console.error('Google-Gmail OAuth-Start:', error.message);
    res.status(503).type('text/plain').send('Die Google-Gmail-Verbindung ist noch nicht vollstaendig konfiguriert.');
  }
});
app.get('/oauth/google/callback', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.query?.error) return res.status(400).type('text/plain').send('Die Google-Freigabe wurde nicht erteilt.');
  try {
    const result = await completeGoogleGmailOAuth({ code: String(req.query?.code || ''), state: String(req.query?.state || '') });
    const heatHeroCount = Number(result.probe?.heatHeroMessages30d || 0);
    const fundingCount = Number(result.probe?.fundingMessages30d || 0);
    res.type('html').send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>IVA Gmail verbunden</title><style>body{font:16px system-ui;max-width:720px;margin:64px auto;padding:0 24px;color:#172033}h1{color:#137333}.box{padding:20px;border:1px solid #d7dee8;border-radius:12px;background:#f8fafc}li{margin:10px 0}</style></head><body><h1>IVA Gmail ist verbunden</h1><div class="box"><p>Die Gmail-API ist erreichbar und der dauerhafte Zugriff wurde verschluesselt gespeichert.</p><ul><li>Heat-Hero-Nachrichten der letzten 30 Tage: <strong>${heatHeroCount}</strong></li><li>Foerderungs-Nachrichten der letzten 30 Tage: <strong>${fundingCount}</strong></li><li>Gmail-Labels erkannt: <strong>${Number(result.probe?.labels || 0)}</strong></li></ul></div><p>Dieses Fenster kann jetzt geschlossen werden.</p></body></html>`);
  } catch (error) {
    console.error('Google-Gmail OAuth-Callback:', error.message);
    res.status(400).type('text/plain').send('Die Google-Gmail-Verbindung konnte nicht abgeschlossen werden. Bitte den Vorgang erneut starten.');
  }
});
app.get('/health/google-gmail', async (_req, res) => {
  const status = await googleGmailStatus();
  res.set('Cache-Control', 'no-store').status(status.ready ? 200 : 503).json({
    configured: status.configured,
    authorized: status.authorized,
    ready: status.ready,
    lastCheckedAt: status.lastProbe?.checkedAt || null,
  });
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

investment.registerRoutes(app);

function envReady(...names) {
  return names.every(name => Boolean(String(process.env[name] || '').trim()));
}

function connector(id, label, ready, missing = [], detail = '') {
  return { id, label, ready: Boolean(ready), missing: ready ? [] : missing, detail };
}

async function controlSnapshot() {
  const [ops, agentRunsResult, qonektoResult, syncResult, voiceResult, knowledgeResult, opportunityResult, learningResult, automationsResult, automationRunsResult, googleGmailResult, tooOftenResult, deviceCommandsResult, projectsResult, protocolRunsResult] = await Promise.all([
    operationsSummary(),
    listAgentRuns({ limit: 300 }).catch(() => []),
    qonektoStatus().catch(error => ({ configured: envReady('QONEKTO_MCP_TOKEN'), reachable: false, error: error.message })),
    crmQonektoSyncStatus().catch(error => ({ enabled: false, error: error.message })),
    voiceLabSummary().catch(error => ({ configured: {}, error: error.message })),
    adviceKnowledgeStatus().catch(error => ({ total: 0, error: error.message })),
    opportunityRadarStatus().catch(error => ({ configured: false, ready: false, missing: ['APIFY_TOKEN'], error: error.message })),
    listVoiceLearning().catch(() => ({ improvementRequests: [] })),
    automationSummary().catch(error => ({ enabled: 0, disabled: 0, running: 0, failedToday: 0, reports: 0, error: error.message })),
    listAutomationRuns({ limit: 500 }).catch(() => []),
    googleGmailStatus().catch(error => ({ configured: false, authorized: false, ready: false, missing: ['Google-Gmail-Verbindung'], error: error.message })),
    tooOftenReplyWorkflowStatus().catch(error => ({ liveReady: false, missing: ['Rückmeldungsworkflow'], error: error.message, state: {} })),
    listDeviceCommands({ limit: 500 }).catch(() => []),
    listProjects().catch(() => []),
    listProjectWorkflowRuns('heat-hero', { limit: 500 }).catch(() => []),
  ]);
  const improvementRequests = learningResult.improvementRequests || [];
  const buildRefreshJobs = buildJobsNeedingRefresh({ requests: improvementRequests, commands: deviceCommandsResult });
  if (buildRefreshJobs.length) {
    await Promise.all(buildRefreshJobs.map(job => enqueueDeviceCommand({
      action: 'codex.task.status',
      payload: { jobId: job.jobId },
      requestedBy: 'control-center',
      requestText: `Baufortschritt: ${job.title || job.requestId}`,
    }).catch(() => null)));
  }
  const buildProgress = buildProgressSnapshot({ requests: improvementRequests, commands: deviceCommandsResult, operationRuns: agentRunsResult, release: CURRENT_BUILD_RELEASE });
  const activity = buildControlActivityFeed({
    agentRuns: agentRunsResult,
    automationRuns: automationRunsResult,
    deviceCommands: deviceCommandsResult,
    projects: projectsResult,
    protocolRuns: protocolRunsResult,
  });
  const projectWorkflows = buildProjectWorkflowOverview(projectsResult, activity);
  const marketing = marketingConnectorStatus();
  const transcription = transcriptionProviderStatus();
  const metaWhatsApp = whatsappStatus();
  const hubWhatsApp = whatsappHubStatus();
  const adviceConnectors = adviceConnectorStatus();
  const tariffConnector = energyTariffStatus();
  const projectIds = CRM_SOURCES.filter(source => source.mode === 'rest' && source.projectId).length;
  const connectors = [
    connector('core-api', 'IVA API-Schutz', envReady('API_TOKEN'), ['API_TOKEN'], 'Schuetzt Cockpit und App-Zugriffe.'),
    connector('imac-device-agent', 'iMac-Gerätekanal', envReady('IMAC_DEVICE_TOKEN'), ['IMAC_DEVICE_TOKEN'], 'Ausgehender, gerätegebundener Befehlskanal ohne offenen iMac-Port.'),
    connector('anthropic', 'IVA Kernmodell', envReady('ANTHROPIC_API_KEY'), ['ANTHROPIC_API_KEY'], 'Chat, Planung und Fachagenten.'),
    connector('gemini', 'Gemini Nebenmodell', envReady('GEMINI_API_KEY'), ['GEMINI_API_KEY'], 'Guentige Marketing-, Markt- und Nebenanalysen.'),
    connector('telegram', 'Telegram', envReady('TELEGRAM_BOT_TOKEN'), ['TELEGRAM_BOT_TOKEN'], 'Assistentenkanal und proaktive Berichte.'),
    connector('voice-input', 'Spracheingabe', transcription.ready, ['OPENAI_API_KEY oder GROQ_API_KEY'], transcription.ready ? `Server-Transkription mit ${transcription.activeProvider} · ${transcription.activeModel} · IVA-Fachwörterbuch aktiv.` : 'Serverseitige Transkription ist noch nicht konfiguriert.'),
    connector('voice-output', 'IVA Stimme', Boolean(voiceResult.configured?.elevenLabs), ['ELEVENLABS_API_KEY'], 'Sprachausgabe mit ElevenLabs; eine feste Voice-ID ist optional.'),
    connector('codex-builder', 'IVA → Codex Bauaufträge', envReady('IMAC_DEVICE_TOKEN'), ['IMAC_DEVICE_TOKEN'], 'Ausdrücklich beauftragte IVA-Änderungen werden ohne erneute Planbestätigung an den lokalen Codex übergeben.'),
    connector('qonekto', 'Qonekto / blau direkt', Boolean(qonektoResult.reachable), ['QONEKTO_MCP_TOKEN'], qonektoResult.reachable ? `${qonektoResult.toolCount || qonektoResult.tools?.total || 0} Werkzeuge erreichbar.` : (qonektoResult.error || 'Nicht erreichbar.')),
    connector('lumit', 'Mannheimer LUMIT · servicierter Antrag', true, [], `Agentur ${lumitWorkflowConfig().agency.display} · Vermittler ${lumitWorkflowConfig().brokerNumber} · Nachprozess vorbereitet.`),
    connector('crm-goals', 'CRM · Goals & Concepts', envReady('MEINCRM_SERVICE_KEY', 'GOALS_CONCEPTS_PROJECT_ID'), ['MEINCRM_SERVICE_KEY', 'GOALS_CONCEPTS_PROJECT_ID'], `${projectIds} CRM-Projektzuordnungen hinterlegt.`),
    connector('crm-heathero', 'HeatHero CRM', envReady('HEATHERO_API_KEY'), ['HEATHERO_API_KEY'], 'Eigener Lead-Zugang.'),
    connector(
      'crm-heathero-too-often-replies',
      'HeatHero · Rückmeldungen „Zu oft n.e.“',
      tooOftenResult.liveReady,
      tooOftenResult.missing || ['CRM-Anhangsweg und Live-Freigabe'],
      tooOftenResult.liveReady
        ? `Täglicher Lauf bereit; ${tooOftenResult.state?.completed || 0} Mails abgeschlossen.`
        : 'Der tägliche Gmail-Lauf ist aktiv; die fehlende Verbindung ist oben konkret aufgeführt.',
    ),
    connector(
      'crm-qonekto-sync',
      'Strategiegespraech → Qonekto',
      Boolean(syncResult.enabled && syncResult.projectConfigured),
      [!syncResult.projectConfigured && 'GOALS_CONCEPTS_PROJECT_ID', !syncResult.enabled && 'CRM_QONEKTO_SYNC_ENABLED=true'].filter(Boolean),
      syncResult.enabled ? 'Automatischer Abgleich aktiv; Anrede-/Vermittler-Defaults sind nur bei fehlenden CRM-Werten nötig.' : 'Bewusst noch nicht aktiviert; zuerst mit einem Testkunden prüfen.',
    ),
    connector('calendar', 'Kalender', CALENDARS.some(item => item.url), ['PRIVAT_GOOGLE_ICS_URL oder weitere ICS-URL'], `${CALENDARS.filter(item => item.url).length} Kalender verbunden.`),
    connector('mail', 'E-Mail-Eingang', loadMailAccounts().length > 0, ['MAIL_1_USER/MAIL_1_PASS oder MAIL_2_USER/MAIL_2_PASS'], `${loadMailAccounts().length} Postfaecher konfiguriert.`),
    connector('google-gmail', 'Google Gmail API', googleGmailResult.ready, googleGmailResult.missing || ['Google-Gmail einmal freigeben'], googleGmailResult.ready ? 'Direkter, bildschirmloser Gmail-Zugriff aktiv.' : 'OAuth ist vorbereitet; die einmalige Kontofreigabe fehlt noch.'),
    connector('report-email', 'Workflow-Reports per E-Mail', reportingStatus().ready, reportingStatus().missing, reportingStatus().ready ? `Versand über ${reportingStatus().provider} an ${reportingStatus().recipient}.` : 'Provider-Key und verifizierter Absender fehlen noch.'),
    connector('calendly', 'Calendly', envReady('CALENDLY_TOKEN'), ['CALENDLY_TOKEN'], 'Termine und Bucher.'),
    connector('iva-scheduling', 'IVA-Terminbuchung', schedulingStatus().liveReady, ['SCHEDULING_CALENDAR_WRITE_READY=true', 'SCHEDULING_MAIL_SEND_READY=true'], schedulingStatus().liveReady ? 'Eigene Terminlinks live.' : 'Terminarten im Vorschaumodus; Live-Schaltung bis zum Ende-zu-Ende-Test gesperrt.'),
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
  const imacAgent = await deviceAgentStatus().catch(error => ({ deviceId: IVA_IMAC_DEVICE_ID, attested: false, online: false, error: error.message }));
  return {
    generatedAt: new Date().toISOString(),
    agents,
    operations: ops,
    automations: automationsResult,
    connectors: {
      ready: uniqueConnectors.filter(item => item.ready).length,
      total: uniqueConnectors.length,
      items: uniqueConnectors,
    },
    systems: {
      qonekto: qonektoResult,
      crmQonektoSync: syncResult,
      voice: { ...voiceResult, transcription },
      adviceKnowledge: knowledgeResult,
      opportunityRadar: opportunityResult,
      reporting: reportingStatus(),
      googleGmail: googleGmailResult,
      tooOftenReplies: tooOftenResult,
      imacAgent,
    },
    buildProgress,
    activity,
    projectWorkflows,
    buildBacklog: improvementRequests.filter(item => !['done', 'rejected'].includes(item.status)).slice(-30).reverse(),
  };
}

app.get('/api/control/status', async (_req, res) => {
  try { res.json(await controlSnapshot()); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/device-agent/status', async (_req, res) => res.json(await deviceAgentStatus()));
app.get('/api/control/runs', async (req, res) => res.json(await listAgentRuns({ limit: req.query?.limit, status: String(req.query?.status || ''), agentId: String(req.query?.agentId || '') })));
app.get('/api/control/approvals', async (req, res) => res.json(await listApprovals({ limit: req.query?.limit, status: String(req.query?.status || '') })));
app.get('/api/control/audit', async (req, res) => res.json(await listAudit({ limit: req.query?.limit, category: String(req.query?.category || '') })));
app.get('/api/automations', async (_req, res) => res.json(await listAutomations()));
app.patch('/api/automations/:id', async (req, res) => {
  try { res.json(await setAutomationEnabled(req.params.id, req.body?.enabled === true)); }
  catch (error) { res.status(404).json({ error: error.message }); }
});
app.get('/api/automations/runs', async (req, res) => res.json(await listAutomationRuns({ automationId: String(req.query?.automationId || ''), status: String(req.query?.status || ''), limit: req.query?.limit, since: String(req.query?.since || '') })));
app.get('/api/automation-reports', async (req, res) => res.json(await listAutomationReports({ type: String(req.query?.type || ''), limit: req.query?.limit })));
app.get('/api/projects', async (_req, res) => res.json(await listProjects()));
app.get('/api/projects/:id', async (req, res) => {
  const project = await getProject(req.params.id);
  res.status(project ? 200 : 404).json(project || { error: 'not found' });
});
app.get('/api/projects/:id/planbar-capacity', async (req, res) => {
  const project = await getProject(req.params.id);
  res.status(project ? 200 : 404).json(project?.planbarCapacity || { error: 'not found' });
});
app.get('/api/projects/:id/planbar-search', async (req, res) => {
  if (req.params.id !== 'heat-hero') return res.status(404).json({ error: 'not found' });
  try {
    res.json(await searchPlanbarAppointments({
      query: req.query?.query,
      weeks: req.query?.weeks,
      fromDate: req.query?.fromDate,
    }));
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/projects/:id/planbar-search-index', async (req, res) => {
  if (req.params.id !== 'heat-hero') return res.status(404).json({ error: 'not found' });
  try {
    const index = await getPlanbarSearchIndex();
    res.json({
      updatedAt: index.updatedAt,
      source: index.source,
      rangeStart: index.rangeStart || null,
      rangeEndExclusive: index.rangeEndExclusive || null,
      appointmentCount: index.appointmentCount,
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/projects', async (req, res) => {
  try { res.status(201).json(await createProject(req.body || {})); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.patch('/api/projects/:id', async (req, res) => {
  try {
    const project = await updateProject(req.params.id, req.body || {});
    res.status(project ? 200 : 404).json(project || { error: 'not found' });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/projects/:id/logo', express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '5mb' }), async (req, res) => {
  try {
    const project = await storeProjectLogo(req.params.id, {
      name: req.query?.name,
      mime: req.query?.mime || req.headers['content-type'],
      buffer: req.body,
    });
    res.status(project ? 201 : 404).json(project || { error: 'not found' });
  } catch (error) { res.status(error?.type === 'entity.too.large' ? 413 : 400).json({ error: error.message }); }
});
app.get('/api/projects/:id/logo', async (req, res) => {
  try {
    const logo = await readProjectLogo(req.params.id);
    if (!logo) return res.status(404).json({ error: 'not found' });
    res.set('Content-Type', logo.meta.mime);
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(logo.meta.name)}`);
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(logo.buffer);
  } catch { res.status(404).json({ error: 'not found' }); }
});
app.delete('/api/projects/:id/logo', async (req, res) => {
  try {
    const project = await deleteProjectLogo(req.params.id);
    res.status(project ? 200 : 404).json(project || { error: 'not found' });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.delete('/api/projects/:id', async (req, res) => {
  try {
    const project = await deleteProject(req.params.id);
    res.status(project ? 200 : 404).json(project ? { ok: true, deletedId: project.id, deletedFiles: true } : { error: 'not found' });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/projects/:id/notes', async (req, res) => {
  try {
    const project = await addProjectNote(req.params.id, req.body?.text, req.body?.source || 'manual');
    res.status(project ? 200 : 404).json(project || { error: 'not found' });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/projects/:id/customer-scheduling-requests', async (req, res) => {
  try {
    const project = await addCustomerSchedulingRequest(req.params.id, req.body || {});
    if (!project) return res.status(404).json({ error: 'not found' });
    const schedulingRequest = project.customerSchedulingRequests?.[0];
    const command = await enqueueDeviceCommand({
      action: 'planbar.customer.schedule',
      payload: {
        ...(req.body || {}),
        partnerId: schedulingRequest?.partnerId,
        partnerName: schedulingRequest?.partnerName,
        partnerPrefix: schedulingRequest?.partnerPrefix,
        schedulingMode: schedulingRequest?.schedulingMode,
        allowFreeResourceFallback: schedulingRequest?.allowFreeResourceFallback,
      },
      requestedBy: 'heat-hero-project',
      requestText: `${req.body?.customerName || 'Kunde'} in KW ${req.body?.week || '?'} terminieren`,
    });
    res.status(202).json({
      ...project,
      schedulingDispatch: { commandId: command.id, deviceId: command.deviceId, status: command.status },
    });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/projects/:id/folders', async (req, res) => {
  try {
    const project = await createProjectFolder(req.params.id, req.body || {});
    res.status(project ? 201 : 404).json(project || { error: 'not found' });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/projects/:id/files', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  try {
    const file = await storeProjectFile(req.params.id, {
      name: req.query?.name,
      folderId: req.query?.folderId,
      mime: req.query?.mime || req.headers['content-type'],
      buffer: req.body,
    });
    res.status(file ? 201 : 404).json(file || { error: 'not found' });
  } catch (error) { res.status(error?.type === 'entity.too.large' ? 413 : 400).json({ error: error.message }); }
});
app.get('/api/projects/:id/files/:fileId', async (req, res) => {
  try {
    const file = await readProjectFile(req.params.id, req.params.fileId);
    if (!file) return res.status(404).json({ error: 'not found' });
    res.set('Content-Type', file.meta.mime || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.meta.name)}`);
    res.send(file.buffer);
  } catch { res.status(404).json({ error: 'not found' }); }
});
app.get('/api/devices/:deviceId/commands', async (req, res) => {
  try {
    if (req.params.deviceId !== IVA_IMAC_DEVICE_ID) return res.status(404).json({ error: 'device not found' });
    res.json({ commands: await listDeviceCommands({ deviceId: req.params.deviceId, limit: req.query?.limit }) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/devices/:deviceId/commands/:commandId', async (req, res) => {
  try {
    const command = await deviceCommandStatus(req.params.commandId);
    if (!command || command.deviceId !== req.params.deviceId) return res.status(404).json({ error: 'command not found' });
    res.json({ command });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/devices/:deviceId/commands/:commandId/cancel', async (req, res) => {
  try {
    if (req.params.deviceId !== IVA_IMAC_DEVICE_ID) return res.status(404).json({ error: 'device not found' });
    const command = await cancelDeviceCommand({
      deviceId: req.params.deviceId,
      commandId: req.params.commandId,
      reason: req.body?.reason,
    });
    res.json({ canceled: true, command });
  } catch (error) { res.status(409).json({ error: error.message }); }
});
app.post('/api/devices/:deviceId/commands', async (req, res) => {
  try {
    const command = await enqueueDeviceCommand({
      deviceId: req.params.deviceId,
      action: req.body?.action,
      payload: req.body?.payload || {},
      requestedBy: req.body?.requestedBy || 'api',
      requestText: req.body?.requestText || '',
    });
    res.status(202).json({ queued: true, command });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.patch('/api/projects/:id/automations/:automationId', async (req, res) => {
  try {
    let project = await getProject(req.params.id);
    let automation = project?.automations?.find(item => item.id === req.params.automationId);
    if (!project || !automation) return res.status(404).json({ error: 'not found' });
    if (Object.hasOwn(req.body || {}, 'name')) {
      project = await renameProjectAutomation(req.params.id, req.params.automationId, req.body?.name);
      automation = project?.automations?.find(item => item.id === req.params.automationId);
    }
    if (Object.hasOwn(req.body || {}, 'enabled')) {
      if (!automation?.toggleAvailable) return res.status(409).json({ error: 'Dieser Workflow ist noch nicht ausführbar und kann deshalb nicht eingeschaltet werden.' });
      if (req.params.automationId === 'workflow-protocol-summaries') {
        await Promise.all([
          setAutomationEnabled('project-protocol-daily', req.body?.enabled === true),
          setAutomationEnabled('project-protocol-weekly', req.body?.enabled === true),
          setAutomationEnabled('project-protocol-cleanup', req.body?.enabled === true),
        ]);
      }
      project = await setProjectAutomationEnabled(req.params.id, req.params.automationId, req.body?.enabled === true);
    }
    res.status(project ? 200 : 404).json(project || { error: 'not found' });
  } catch (error) { res.status(409).json({ error: error.message }); }
});
app.post('/api/projects/:id/automations/:automationId/run', async (req, res) => {
  try {
    const result = await triggerProjectWorkflowManually(req.params.id, req.params.automationId);
    res.status(202).json(result);
  } catch (error) {
    const status = /nicht gefunden/i.test(error.message) ? 404 : /noch nicht|nicht manuell|blockiert/i.test(error.message) ? 409 : 500;
    res.status(status).json({ error: error.message });
  }
});
app.post('/api/projects/:id/automations/:automationId/prepare', async (req, res) => {
  try {
    const result = await prepareProjectWorkflowWithIva(req.params.id, req.params.automationId);
    res.status(202).json(result);
  } catch (error) {
    res.status(/nicht gefunden/i.test(error.message) ? 404 : 500).json({ error: error.message });
  }
});
app.get('/api/projects/:id/protocols', async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  await syncProjectRunLog(project);
  await ensureProjectProtocolSummaries(project.id);
  res.json(await listProjectProtocols(project.id));
});
app.get('/api/projects/:id/protocols/:type/:fileId', async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  const file = await getProjectProtocol(project.id, req.params.type, req.params.fileId);
  if (!file) return res.status(404).json({ error: 'protocol not found' });
  if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
  res.json(file);
});
app.post('/api/projects/:id/workflow-runs', async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  try { res.status(201).json(await recordProjectWorkflowResult(project.id, req.body || {})); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/leads', async (_req, res) => res.json(await fetchAllLeads()));
app.post('/api/crm/panasonic-leads/import', async (req, res) => {
  try {
    res.status(201).json(await importPanasonicLeadsToMeinCrm(req.body?.leads));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
app.get('/api/crm-qonekto-sync/status', async (_req, res) => res.json(await crmQonektoSyncStatus()));
app.post('/api/crm-qonekto-sync/run', async (req, res) => {
  try {
    const result = await syncStrategyCustomersToQonekto({ force: req.body?.force === true });
    res.status(result.enabled ? 200 : 409).json(result);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});
app.get('/api/mails', async (_req, res) => res.json(await fetchAllMailSources(15)));
app.get('/api/google-gmail/status', async (req, res) => {
  try { res.json(await googleGmailStatus({ probe: req.query?.probe === '1' })); }
  catch (error) { res.status(502).json({ error: error.message }); }
});
app.get('/api/google-gmail/labels', async (_req, res) => {
  try { res.json({ labels: await listGoogleGmailLabels() }); }
  catch (error) { res.status(502).json({ error: error.message }); }
});
app.get('/api/google-gmail/messages', async (req, res) => {
  try {
    res.json(await listGoogleGmailMessages({
      limit: req.query?.limit,
      query: String(req.query?.q || 'in:inbox'),
      includeBody: req.query?.body === '1',
    }));
  } catch (error) { res.status(502).json({ error: error.message }); }
});
app.post('/api/google-gmail/probe', async (_req, res) => {
  try { res.json(await probeGoogleGmail()); }
  catch (error) { res.status(502).json({ error: error.message }); }
});
app.get('/api/mails/klassifiziert', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query?.limit) || 15, 1), 50);
  try {
    const mails = await fetchAllMailSources(limit);
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
app.get('/api/scheduling/status', (_req, res) => res.json(schedulingStatus()));
app.get('/api/scheduling/types', async (_req, res) => res.json(await listAppointmentTypes()));
app.post('/api/scheduling/types', async (req, res) => {
  try { res.status(201).json(await createAppointmentType(req.body || {})); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.patch('/api/scheduling/types/:id', async (req, res) => {
  try {
    const type = await updateAppointmentType(req.params.id, req.body || {}, { allowActivation: schedulingStatus().liveReady });
    res.status(type ? 200 : 404).json(type || { error: 'not found' });
  } catch (error) { res.status(409).json({ error: error.message }); }
});
app.get('/api/scheduling/types/:id/slots', async (req, res) => {
  const type = (await listAppointmentTypes()).find(item => item.id === req.params.id);
  res.status(type ? 200 : 404).json(type ? await listAvailableSlots(type, { days: Math.min(Number(req.query?.days) || 14, 60) }) : { error: 'not found' });
});
app.get('/api/scheduling/bookings', async (req, res) => res.json(await listBookings({ limit: req.query?.limit })));
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
app.post('/api/voice-lab/transcription-corrections', async (req, res) => {
  try { res.status(201).json(await saveTranscriptionCorrection({ ...(req.body || {}), source: 'voice-lab' })); }
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

// --- Mannheimer LUMIT: Onlineabschluss plus kontrollierter Nachprozess. ---
app.get('/api/lumit/config', (_req, res) => res.json(lumitWorkflowConfig()));
app.post('/api/lumit/price-quote', (req, res) => {
  try { res.json(calculateLumitPriceQuote(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/lumit/start-date/suggestion', (req, res) => {
  try {
    const suggestion = suggestLumitStartDate(req.body || {});
    const validation = req.body?.selectedDate
      ? validateLumitStartDate(req.body || {})
      : null;
    res.json({ suggestion, validation });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/lumit/applications', async (req, res) => {
  try {
    res.json(await listLumitApplications({
      customerId: String(req.query?.customerId || '').slice(0, 180),
      status: String(req.query?.status || '').slice(0, 80),
      limit: Math.min(Math.max(Number(req.query?.limit) || 100, 1), 500),
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/lumit/applications/:id', async (req, res) => {
  const application = await getLumitApplication(req.params.id);
  res.status(application ? 200 : 404).json(application || { error: 'LUMIT-Vorgang nicht gefunden.' });
});
app.post('/api/lumit/applications', async (req, res) => {
  try {
    const application = await createLumitServicedApplication(req.body || {});
    await recordAudit({
      category: 'lumit',
      action: 'servicierter-antrag-vorbereitet',
      status: application.duplicate ? 'duplicate' : 'pending',
      actor: 'iva-customer',
      target: application.customerId,
      detail: `${application.label} · ${application.applicationNumber || application.applicationFileName}`,
    });
    res.status(application.duplicate ? 200 : 201).json(application);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/lumit/applications/:id/customer-package', async (req, res) => {
  try {
    const application = await getLumitApplication(req.params.id);
    if (!application) return res.status(404).json({ error: 'LUMIT-Vorgang nicht gefunden.' });
    if (req.body?.policyReviewedByHauswertschutz !== true) {
      return res.status(400).json({ error: 'Die Hauswertschutz-Pruefung der Originalpolice muss ausdruecklich bestaetigt werden.' });
    }
    const policy = await workspaces.readWorkspaceFile(application.workspaceId, String(req.body?.policyDocumentId || ''));
    if (!policy || policy.meta?.mime !== 'application/pdf') return res.status(400).json({ error: 'Die Mannheimer-Originalpolice fehlt oder ist keine PDF.' });

    if (req.body?.insurerLogoDocumentId) {
      return res.status(400).json({ error: 'Auf Hauswertschutz-Markenseiten wird kein Versichererlogo eingebunden. Der Risikotraeger wird auf der Vertragsseite in Textform genannt.' });
    }
    const trustBadges = [];
    const trustBadgeDocumentIds = Array.isArray(req.body?.trustBadgeDocumentIds)
      ? req.body.trustBadgeDocumentIds.filter(Boolean).slice(0, 3)
      : [];
    for (const documentId of trustBadgeDocumentIds) {
      const badge = await workspaces.readWorkspaceFile(application.workspaceId, String(documentId));
      if (!badge || !['image/png', 'image/jpeg'].includes(badge.meta?.mime)) {
        return res.status(400).json({ error: 'Trust-Badges müssen als PNG oder JPEG vorliegen.' });
      }
      trustBadges.push({ buffer: badge.buffer, mime: badge.meta.mime, name: badge.meta.name });
    }

    const pdf = await createLumitCustomerPackagePdf({
      customerName: application.customerName,
      policyNumber: req.body?.policyNumber,
      totalPrice: req.body?.totalPrice,
      insurancePremium: req.body?.insurancePremium,
      serviceFee: req.body?.serviceFee,
      billingPeriod: req.body?.billingPeriod,
      servicePackageName: req.body?.servicePackageName,
      customerSalutation: req.body?.customerSalutation,
      insuredTechnologies: req.body?.insuredTechnologies,
      propertyInsuranceIncluded: req.body?.propertyInsuranceIncluded === true,
      propertyHazardsIncluded: req.body?.propertyHazardsIncluded === true,
      yieldLossIncluded: req.body?.yieldLossIncluded === true,
      operatorLiabilityIncluded: req.body?.operatorLiabilityIncluded === true,
      assemblyCoverIncluded: req.body?.assemblyCoverIncluded === true,
      officialScopeConfirmed: req.body?.officialScopeConfirmed === true,
      servicePhone: '02183 3989753',
      serviceEmail: 'info@hauswertschutz.de',
      serviceAddress: 'Olfenweg 12, 41569 Rommerskirchen',
      claimsWhatsapp: req.body?.claimsWhatsapp,
      claimsEmail: req.body?.claimsEmail,
      claimsAvailability: req.body?.claimsAvailability,
      claimsServiceHours: req.body?.claimsServiceHours,
      claimsChannelsReady: req.body?.claimsChannelsReady === true,
      insuranceStartDate: application.requestedStartMode === 'immediate'
        ? 'sofort / nächstmöglich'
        : application.requestedStartDate,
      originalPolicyBuffer: policy.buffer,
      originalPolicyFileName: policy.meta.name,
      trustBadges,
    });
    const safeCustomer = String(application.customerName || 'Kunde').normalize('NFKD').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 70) || 'Kunde';
    const packageFile = await workspaces.storeWorkspaceFile(application.workspaceId, {
      name: `Hauswertschutz-Energietechnik-Kundenpaket-${safeCustomer}.pdf`,
      mime: 'application/pdf',
      kind: 'lumit-customer-package',
      buffer: pdf,
    });
    const updated = await attachLumitCustomerPackage(application.id, {
      policyDocumentId: policy.meta.id,
      policyFileName: policy.meta.name,
      policySha256: policy.meta.sha256,
      packageDocumentId: packageFile.id,
      packageFileName: packageFile.name,
      totalPrice: req.body?.totalPrice,
      insurancePremium: req.body?.insurancePremium,
      serviceFee: req.body?.serviceFee,
      billingPeriod: req.body?.billingPeriod,
      customerSalutation: req.body?.customerSalutation,
      insuredTechnologies: req.body?.insuredTechnologies,
      propertyInsuranceIncluded: req.body?.propertyInsuranceIncluded === true,
      propertyHazardsIncluded: req.body?.propertyHazardsIncluded === true,
      yieldLossIncluded: req.body?.yieldLossIncluded === true,
      operatorLiabilityIncluded: req.body?.operatorLiabilityIncluded === true,
      assemblyCoverIncluded: req.body?.assemblyCoverIncluded === true,
      officialScopeConfirmed: req.body?.officialScopeConfirmed === true,
      claimsWhatsapp: req.body?.claimsWhatsapp,
      claimsEmail: req.body?.claimsEmail,
      claimsAvailability: req.body?.claimsAvailability,
      claimsServiceHours: req.body?.claimsServiceHours,
      claimsChannelsReady: req.body?.claimsChannelsReady === true,
      insurerLogoIncluded: false,
      insurerLogoUsageApproved: false,
      trustBadgeFileNames: trustBadges.length
        ? trustBadges.map(item => item.name)
        : lumitWorkflowConfig().customerPackage.defaultTrustBadges.map(item => item.name),
      policyReviewedByHauswertschutz: true,
    });
    await recordAudit({
      category: 'lumit', action: 'hauswertschutz-kundenpaket-erzeugt', status: 'review', actor: 'iva-customer',
      target: application.customerId, detail: packageFile.name,
    });
    res.status(201).json({
      application: updated,
      file: packageFile,
      downloadUrl: `/api/workspaces/${encodeURIComponent(application.workspaceId)}/files/${encodeURIComponent(packageFile.id)}`,
      automaticCustomerDelivery: false,
      approvalRequired: true,
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/lumit/applications/:id/steps/:step', async (req, res) => {
  try {
    const application = await markLumitApplicationStep(req.params.id, req.params.step, req.body?.completed !== false);
    if (!application) return res.status(404).json({ error: 'LUMIT-Vorgang nicht gefunden.' });
    await recordAudit({
      category: 'lumit',
      action: req.params.step,
      status: application.steps?.[req.params.step] ? 'completed' : 'reopened',
      actor: 'iva-customer',
      target: application.customerId,
      detail: application.applicationNumber || application.applicationFileName,
    });
    res.json(application);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Kundenportal: Qonekto/Blau direkt ist Stammdatenquelle, IVA die Arbeitsakte. ---
app.get('/api/address-suggestions', async (req, res) => {
  try {
    res.json(await suggestGermanAddresses(req.query?.q, {
      limit: Math.min(Math.max(Number(req.query?.limit) || 6, 1), 8),
    }));
  } catch (e) { res.status(502).json({ error: `Adressvorschläge konnten nicht geladen werden: ${e.message}` }); }
});
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
app.delete('/api/workspaces/:id', async (req, res) => {
  try {
    const workspace = await workspaces.deleteWorkspace(req.params.id, { mode: req.query?.mode || undefined });
    res.status(workspace ? 200 : 404).json(workspace ? { ok: true, deletedId: workspace.id, mode: workspace.mode } : { error: 'not found' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/workspaces/:id/notes', async (req, res) => {
  const workspace = await workspaces.addWorkspaceNote(req.params.id, req.body?.text || '', req.body?.source || 'manual');
  res.status(workspace ? 200 : 404).json(workspace || { error: 'not found' });
});
app.post('/api/workspaces/:id/meetings', async (req, res) => {
  try {
    const result = await workspaces.addWorkspaceMeeting(req.params.id, req.body || {});
    res.status(result ? (result.duplicate ? 200 : 201) : 404).json(result || { error: 'not found' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/workspaces/:id/meetings/:meetingId', async (req, res) => {
  try {
    const result = await workspaces.updateWorkspaceMeeting(req.params.id, req.params.meetingId, req.body || {});
    res.status(result ? 200 : 404).json(result || { error: 'not found' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/workspaces/:id/follow-up-drafts', async (req, res) => {
  try {
    const result = await workspaces.createWorkspaceFollowUpDraft(req.params.id, req.body || {});
    res.status(result ? 201 : 404).json(result || { error: 'not found' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/workspaces/:id/follow-up-drafts/:draftId', async (req, res) => {
  try {
    const result = await workspaces.updateWorkspaceFollowUpDraft(req.params.id, req.params.draftId, req.body || {});
    res.status(result ? 200 : 404).json(result || { error: 'not found' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/workspaces/:id/files', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  try {
    const file = await workspaces.storeWorkspaceFile(req.params.id, {
      name: req.query?.name,
      kind: req.query?.kind,
      category: req.query?.category,
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
app.get('/api/energy/pv-price/catalog', (_req, res) => res.json(pvPriceCatalog()));
app.post('/api/energy/pv-price/calculate', (req, res) => {
  try { res.json(calculatePvPrice(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/energy/heat-pump-electricity/calculate', (req, res) => {
  try { res.json(calculateHeatPumpElectricity(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/workspaces/:id/energy/pv-price/calculate', async (req, res) => {
  try {
    const workspace = await workspaces.getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'not found' });
    if (workspace.mode !== 'energie') return res.status(400).json({ error: 'PV-Preisplanungen sind nur für Energie-Fallakten verfügbar.' });
    const quote = calculatePvPrice(req.body || {});
    const pv = workspace.data?.pv || {};
    const updated = await workspaces.updateWorkspace(workspace.id, {
      data: {
        pv: {
          ...pv,
          status: 'price-planned',
          present: true,
          power: quote.sizing.systemKwp,
          batteryPresent: quote.sizing.storageCapacityKwh > 0,
          batteryCapacity: quote.sizing.storageCapacityKwh,
          pricePlanning: quote,
        },
      },
    });
    res.json({ quote, workspace: updated });
  } catch (e) { res.status(400).json({ error: e.message }); }
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

// --- Nutzenpruefung: neue Tools/Agenten erst nach Beleg-, Doppelungs- und Rechtecheck ---
app.get('/api/capabilities/reviews', (req, res) => res.json({ reviews: listCapabilityReviews({ category: String(req.query?.category || ''), decision: String(req.query?.decision || '') }) }));
app.post('/api/capabilities/assess', (req, res) => {
  try { res.json(evaluateCapability(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Wissensmediathek: kuratierte Quellen statt ungepruefter Volltextsammlung ---
app.get('/api/knowledge-library/status', (_req, res) => res.json(knowledgeLibraryStatus()));
app.get('/api/knowledge-library', (req, res) => res.json({ sources: listKnowledgeLibrary({ domain: String(req.query?.domain || ''), status: String(req.query?.status || '') }) }));
app.post('/api/knowledge-library/assess', (req, res) => {
  try { res.json(assessKnowledgeSourceCandidate(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Recruiting: Vorbereitung und Belegpruefung, ohne autonomes Sourcing/Entscheiden ---
app.get('/api/recruiting/status', async (_req, res) => res.json(await recruitingSummary()));
app.get('/api/recruiting/roles', async (_req, res) => res.json(await listRecruitingRoles()));
app.get('/api/recruiting/roles/:id', async (req, res) => {
  const role = await getRecruitingRole(req.params.id);
  res.status(role ? 200 : 404).json(role || { error: 'not found' });
});
app.post('/api/recruiting/roles', async (req, res) => {
  try { res.status(201).json(await createRecruitingRole(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/recruiting/roles/:id', async (req, res) => {
  try {
    const role = await updateRecruitingRole(req.params.id, req.body || {});
    res.status(role ? 200 : 404).json(role || { error: 'not found' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/recruiting/roles/:id', async (req, res) => {
  try {
    const role = await deleteRecruitingRole(req.params.id);
    res.status(role ? 200 : 404).json(role ? { ok: true, deletedId: role.id } : { error: 'not found' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/recruiting/candidates', async (req, res) => res.json(await listRecruitingCandidates({ roleId: String(req.query?.roleId || ''), status: String(req.query?.status || '') })));
app.get('/api/recruiting/candidates/:id', async (req, res) => {
  const candidate = await getRecruitingCandidate(req.params.id);
  res.status(candidate ? 200 : 404).json(candidate || { error: 'not found' });
});
app.post('/api/recruiting/roles/:id/candidates', async (req, res) => {
  try {
    const candidate = await createRecruitingCandidate(req.params.id, req.body || {});
    res.status(candidate ? 201 : 404).json(candidate || { error: 'not found' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/recruiting/candidates/:id', async (req, res) => {
  try {
    const candidate = await updateRecruitingCandidate(req.params.id, req.body || {});
    res.status(candidate ? 200 : 404).json(candidate || { error: 'not found' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/recruiting/candidates/:id', async (req, res) => {
  try {
    const candidate = await deleteRecruitingCandidate(req.params.id);
    res.status(candidate ? 200 : 404).json(candidate ? { ok: true, deletedId: candidate.id } : { error: 'not found' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/recruiting/candidates/:id/document', express.raw({ type: ['application/pdf', 'text/plain', 'application/octet-stream'], limit: '10mb' }), async (req, res) => {
  try {
    const candidate = await storeRecruitingCandidateDocument(req.params.id, { name: req.query?.name, mime: req.query?.mime || req.headers['content-type'], buffer: req.body });
    res.status(candidate ? 201 : 404).json(candidate || { error: 'not found' });
  } catch (e) { res.status(e?.type === 'entity.too.large' ? 413 : 400).json({ error: e.message }); }
});
app.get('/api/recruiting/candidates/:id/document', async (req, res) => {
  try {
    const file = await readRecruitingCandidateDocument(req.params.id);
    if (!file) return res.status(404).json({ error: 'not found' });
    res.set('Content-Type', file.meta.mime || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.meta.name)}`);
    res.send(file.buffer);
  } catch { res.status(404).json({ error: 'not found' }); }
});
app.post('/api/recruiting/search-plan', (req, res) => {
  try { res.json(createCandidateSearchPlan(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/recruiting/screen-resume', (req, res) => {
  try { res.json(screenResumeAgainstCriteria(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/recruiting/interview-guide', (req, res) => {
  try { res.json(createInterviewGuide(req.body || {})); }
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
app.get('/api/opportunities/link-checks', async (req, res) => res.json(await listOpportunityLinkChecks({ mode: req.query?.mode || '', limit: req.query?.limit || 30 })));
app.post('/api/opportunities/check-link', async (req, res) => {
  try { res.status(201).json(await checkOpportunityLink(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message, linkCheck: e.linkCheck || null }); }
});
app.get('/api/opportunities/market-research/status', (_req, res) => {
  try { res.json(opportunityMarketResearchStatus()); }
  catch (e) { res.status(500).json({ ready: false, error: e.message }); }
});
app.get('/api/opportunities/market-analyses', async (req, res) => res.json(await listOpportunityMarketAnalyses({ limit: req.query?.limit || 20 })));
app.post('/api/opportunities/market-research', async (req, res) => {
  try { res.status(201).json(await runOpportunityMarketResearch(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message, marketAnalysis: e.marketAnalysis || null }); }
});
app.get('/api/opportunities/watch-sources', async (_req, res) => res.json(await listOpportunityWatchSources()));
app.put('/api/opportunities/watch-sources', async (req, res) => {
  try { res.json(await setOpportunityWatchSource(req.body?.source || {}, req.body?.enabled === true)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
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
app.get('/api/whatsapp/handoffs', async (req, res) => res.json(await listWhatsAppHandoffs({ status: String(req.query?.status || ''), limit: req.query?.limit })));
app.patch('/api/whatsapp/handoffs/:id', async (req, res) => {
  try {
    const ticket = await updateWhatsAppHandoff(req.params.id, req.body || {});
    res.status(ticket ? 200 : 404).json(ticket || { error: 'not found' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
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

async function syncProjectRunLog(project) {
  for (const run of project.runLog || []) {
    await recordProjectWorkflowResult(project.id, {
      runId: run.id,
      workflowId: run.automationId,
      workflowName: project.automations?.find(item => item.id === run.automationId)?.name || run.automationId,
      status: run.status,
      startedAt: run.executedAt,
      completedAt: run.executedAt,
      summary: run.summary,
      metrics: { customerCount: run.customerCount, attachmentCount: run.attachmentCount, scope: run.scope },
      artifacts: [],
    });
  }
}

async function updateProjectProtocolSummaries(options = {}) {
  const projects = await listProjects();
  for (const project of projects.filter(item => item.protocolPolicy?.enabled)) {
    await syncProjectRunLog(project);
    await ensureProjectProtocolSummaries(project.id, {
      ...options,
      expectedWorkflows: project.protocolPolicy?.expectedWorkflows || [],
    });
  }
}

const automationRunner = createAutomationOrchestrator({
  'report-email-daily': async ({ now }) => {
    const report = await buildAutomationReport('daily', now);
    const mem = await loadMemory();
    const delivery = await deliverReportEmailWithTelegramFallback(report, { chatId: mem.chatId, sendTelegram });
    const summary = delivery.deliveredChannel === 'email'
      ? `Tagesreport per E-Mail an ${reportingStatus().recipient} geprüft.`
      : `E-Mail-Zustellung fehlgeschlagen; Tagesreport ersatzweise per Telegram zugestellt. Grund: ${delivery.emailError}`;
    return { reportKey: report.key, delivery, summary };
  },
  'report-email-weekly': async ({ now }) => {
    const report = await buildAutomationReport('weekly', now);
    const mem = await loadMemory();
    const delivery = await deliverReportEmailWithTelegramFallback(report, { chatId: mem.chatId, sendTelegram });
    const summary = delivery.deliveredChannel === 'email'
      ? `Wochenreport per E-Mail an ${reportingStatus().recipient} geprüft.`
      : `E-Mail-Zustellung fehlgeschlagen; Wochenreport ersatzweise per Telegram zugestellt. Grund: ${delivery.emailError}`;
    return { reportKey: report.key, delivery, summary };
  },
  'daily-briefing': async () => sendBriefing(),
  'marketing-morning-report': async () => sendMarketingMorningReport(),
  'heat-hero-too-often-replies': async () => runHeatHeroTooOftenReplies(),
  'report-telegram-morning': async ({ now }) => {
    const mem = await loadMemory();
    if (!mem.chatId) return { status: 'blocked', summary: 'Workflow-Report nicht versandt: Telegram-Chat-ID fehlt.', error: 'Telegram-Chat-ID fehlt.' };
    const daily = await buildAutomationReport('daily', now);
    const deliveries = [await deliverReportTelegram(daily, { chatId: mem.chatId, sendTelegram })];
    if (isMondayInBerlin(now)) {
      const weekly = await buildAutomationReport('weekly', now);
      deliveries.push(await deliverReportTelegram(weekly, { chatId: mem.chatId, sendTelegram }));
    }
    return { deliveries, summary: `Separater Workflow-Report per Telegram geprüft (${deliveries.filter(item => item.delivered).length} neu zugestellt).` };
  },
  'opportunity-weekly': async () => sendWeeklyOpportunityPitch(),
  'integration-checkup-monthly': async () => {
    const result = await runIntegrationCheckup();
    const mem = await loadMemory();
    if (mem.chatId) await sendTelegram(mem.chatId, formatCheckupTelegram(result));
    return { ...result, summary: `${result.summary}${mem.chatId ? ' Telegram-Bericht zugestellt.' : ' Telegram-Chat-ID fehlt; Ergebnis im Cockpit gespeichert.'}` };
  },
  'crm-qonekto-sync': async () => {
    const result = await syncStrategyCustomersToQonekto();
    if (!result.enabled) return { status: 'blocked', summary: 'CRM-Qonekto-Sync ist durch die Integrationsfreigabe blockiert.', error: result.reason || 'CRM_QONEKTO_SYNC_ENABLED ist nicht aktiv.', ...result };
    return { ...result, summary: `CRM-Qonekto-Abgleich abgeschlossen: ${result.processed || result.checked || 0} Datensätze geprüft.` };
  },
  'project-protocol-daily': async () => { await updateProjectProtocolSummaries({ finalizeDaily: true }); return { summary: 'Projekt-Tagesprotokolle finalisiert.' }; },
  'project-protocol-weekly': async () => { await updateProjectProtocolSummaries({ finalizeWeekly: true }); return { summary: 'Projekt-Wochenprotokolle finalisiert.' }; },
  'project-protocol-cleanup': async () => { const result = await cleanupExpiredProjectProtocols(); return { result, summary: 'Abgelaufene Projektprotokolle bereinigt.' }; },
});

const SERVER_MANUAL_PROJECT_WORKFLOWS = Object.freeze({
  'workflow-protocol-summaries': ['project-protocol-daily', 'project-protocol-weekly'],
});
const IMAC_MANUAL_PROJECT_WORKFLOWS = new Set([
  'funding-monitor',
  'planbar-weekly-export',
  'planbar-completion-morning',
  'montage-required-fields-morning',
]);

async function triggerProjectWorkflowManually(projectId, workflowId) {
  const project = await getProject(projectId);
  const workflow = project?.automations?.find(item => item.id === workflowId);
  if (!project || !workflow) throw new Error('Projekt-Workflow nicht gefunden.');
  if (!['active', 'paused'].includes(workflow.status)) {
    throw new Error(`„${workflow.name}“ ist noch nicht ausführbar. ${workflow.nextStep || 'Der vorbereitete Ablauf muss zuerst freigeschaltet werden.'}`);
  }
  const serverAutomationIds = SERVER_MANUAL_PROJECT_WORKFLOWS[workflow.id];
  if (serverAutomationIds) {
    const requestedAt = Date.now();
    void Promise.all(serverAutomationIds.map(automationId => automationRunner.runAutomation(automationId, {
      trigger: 'manual',
      allowDisabled: true,
      slotKey: `${automationId}:manual:${requestedAt}`,
    }))).catch(error => console.error(`Manueller Projekt-Workflow ${workflow.id}:`, error.message));
    return {
      accepted: true,
      mode: 'server',
      workflowId: workflow.id,
      message: `„${workflow.name}“ wurde auf IVA Core gestartet.`,
    };
  }
  if (project.id === 'heat-hero' && IMAC_MANUAL_PROJECT_WORKFLOWS.has(workflow.id)) {
    const command = await enqueueDeviceCommand({
      deviceId: IVA_IMAC_DEVICE_ID,
      action: 'project.workflow.run',
      payload: { projectId: project.id, workflowId: workflow.id, displayName: workflow.name },
      requestedBy: 'projects-manual-trigger',
      requestText: `Projekt-Workflow manuell auslösen: ${workflow.name}`,
    });
    return {
      accepted: true,
      mode: 'imac',
      workflowId: workflow.id,
      commandId: command.id,
      message: `„${workflow.name}“ wurde an Nadines iMac übergeben.`,
    };
  }
  throw new Error('Dieser Workflow kann noch nicht manuell ausgelöst werden. Der Ausführungsweg ist noch nicht angebunden.');
}

async function prepareProjectWorkflowWithIva(projectId, workflowId) {
  const project = await getProject(projectId);
  const workflow = project?.automations?.find(item => item.id === workflowId);
  if (!project || !workflow) throw new Error('Projekt-Workflow nicht gefunden.');
  const command = await enqueueDeviceCommand({
    deviceId: IVA_IMAC_DEVICE_ID,
    action: 'codex.task.start',
    payload: {
      title: `${workflow.name} fertig bauen`,
      requestId: `project-${project.id}-${workflow.id}-${Date.now()}`,
      prompt: `Stelle den vorhandenen IVA-Projekt-Workflow vollständig fertig und liefere ihn live aus.\n\nProjekt: ${project.name} (${project.id})\nWorkflow: ${workflow.name} (${workflow.id})\nAktueller Status: ${workflow.status}\nZeitplan: ${workflow.schedule || 'noch offen'}\nAusführungsort: ${workflow.execution || 'noch offen'}\nZweck: ${workflow.purpose || 'noch zu konkretisieren'}\nSicherheitsregel: ${workflow.safety || 'bestehende IVA-Sicherheitsregeln anwenden'}\nBisheriger nächster Schritt/Blocker: ${workflow.nextStep || 'Ausführungsweg vollständig anbinden'}\n\nFinde eigenständig einen funktionierenden technischen Weg. Ein alter Bug, der bisherige Status oder eine fehlende interne Anbindung ist Teil dieses Bauauftrags und kein Endergebnis. Nutze vorhandene sichere Zugänge und Authenticator-Wege selbstständig. Baue den echten Ausführungsweg, verbinde ihn mit Zeitplan, Ein-/Aus-Schalter und manuellem Start in /projects, protokolliere das Ergebnis nachvollziehbar und halte alle genannten Sicherheitsregeln ein. Nur ein nach konkretem Versuch technisch erzwungener Schritt, den ausschließlich Nadine erledigen kann, darf als präziser Restblocker zurückbleiben.`,
      acceptanceCriteria: [
        'Der Workflow ist technisch ausführbar und nicht nur als vorbereitet oder geplant dargestellt.',
        'Ein-/Aus-Schalter, manueller Start und verständlicher Status in /projects funktionieren.',
        'Sicherheitsregel, Idempotenz, Ergebnisprotokoll und echte Fehlerpfade sind getestet.',
        'Tests, Commit, Push, Railway-Deployment und öffentliche Live-Prüfung sind abgeschlossen.',
      ],
    },
    requestedBy: 'projects-finish-workflow',
    requestText: `Workflow mit IVA fertig bauen: ${workflow.name}`,
  });
  return {
    accepted: true,
    mode: 'iva-build',
    workflowId: workflow.id,
    commandId: command.id,
    message: `„${workflow.name}“ wurde als vollständiger Fertigstellungsauftrag an IVA/Codex übergeben.`,
  };
}

app.get('/api/integration-checkup', async (_req, res) => {
  try { res.json(await getIntegrationCheckupStatus()); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/integration-checkup/run', async (_req, res) => {
  try { res.json(await automationRunner.runAutomation('integration-checkup-monthly', { trigger: 'manual', slotKey: `integration-checkup-monthly:manual:${Date.now()}` })); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/heat-hero/too-often-replies/status', async (_req, res) => {
  try { res.json(await tooOftenReplyWorkflowStatus()); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/heat-hero/too-often-replies/run', async (_req, res) => {
  try { res.json(await automationRunner.runAutomation('heat-hero-too-often-replies', { trigger: 'manual', slotKey: `heat-hero-too-often-replies:manual:${Date.now()}` })); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

for (const automation of AUTOMATION_DEFINITIONS) {
  cron.schedule(automation.cron, () => {
    void automationRunner.runAutomation(automation.id, { trigger: 'schedule' })
      .catch(error => console.error(`Automation ${automation.id}:`, error.message));
  }, { timezone: 'Europe/Berlin' });
}

const firstAutomationCatchUp = setTimeout(() => {
  void automationRunner.runDueAutomations().catch(error => console.error('Automation-Catch-up:', error.message));
}, 20_000);
firstAutomationCatchUp.unref?.();
const automationCatchUpInterval = setInterval(() => {
  void automationRunner.runDueAutomations().catch(error => console.error('Automation-Catch-up:', error.message));
}, 15 * 60 * 1000);
automationCatchUpInterval.unref?.();
const __dirnameIva = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirnameIva, 'public')));
app.get('/cockpit', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'cockpit.html')));
app.get('/workspace', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'workspace.html')));
app.get('/pv-calculator', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'pv-calculator.html')));
app.get('/pv-schnellrechner', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'pv-calculator.html')));
app.get('/customers', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'customers.html')));
app.get('/scheduling', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'scheduling.html')));
app.get('/book/:slug', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'booking.html')));
app.get('/advice', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'advice.html')));
app.get('/whatsapp', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'whatsapp.html')));
app.get('/marketing', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'marketing.html')));
app.get('/accounting', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'accounting.html')));
app.get('/opportunities', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'opportunities.html')));
app.get('/voice-lab', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'voice-lab.html')));
app.get('/control', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'control.html')));
app.get('/projects', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'projects.html')));
app.get('/recruiting', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'recruiting.html')));
app.get('/investment', (_req, res) => res.sendFile(path.join(__dirnameIva, 'public', 'investment.html')));
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
