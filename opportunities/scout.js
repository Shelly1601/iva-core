import { generateText } from 'ai';
import { chooseModel, recordUsage, checkBudget } from '../core/router.js';
import { scrapeInstagram } from '../marketing/analyze.js';
import {
  createOpportunityRun,
  getOpportunitySettings,
  listOpportunityRuns,
  opportunityRadarCounts,
  updateOpportunity,
  updateOpportunityRun,
  upsertOpportunity,
} from './store.js';
import { formatWeeklyPitch, scoreOpportunity, sortOpportunities } from './score.js';

const HASHTAG_ACTOR_URL = 'https://api.apify.com/v2/acts/apify~instagram-hashtag-scraper/run-sync-get-dataset-items';
export const CURATED_DISCOVERY_ACCOUNTS = Object.freeze(['iamformed', 'herr_tech', 'setupsai', 'lucaswebq', 'nickgeringer', 'beasttechx']);
const clean = (value, max = 1000) => String(value || '').trim().slice(0, max);
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
let activeScoutPromise = null;

function opportunityModelStatus() {
  try {
    const routed = chooseModel({ task: 'marketing-intelligence' });
    const envName = routed.provider === 'google' ? 'GEMINI_API_KEY' : routed.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : '';
    return {
      ready: Boolean(envName && process.env[envName]),
      provider: routed.provider,
      modelId: routed.modelId,
      missing: envName && !process.env[envName] ? [envName] : [],
    };
  } catch (error) {
    return { ready: false, provider: '', modelId: '', missing: ['gültige IVA_MODEL_MARKETING_INTELLIGENCE-Konfiguration'], error: error.message };
  }
}

async function withRetry(operation, { attempts = 2, timeoutMs = 110_000, label = 'Quelle' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let timer;
    try {
      return await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label}: Zeitlimit erreicht`)), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      lastError = error;
      if (error?.retryable === false || /^Apify 4(?!08|29)/.test(String(error?.message || '')) || attempt === attempts) break;
    } finally { clearTimeout(timer); }
  }
  throw lastError || new Error(`${label} konnte nicht geladen werden`);
}

function postUrl(post = {}) {
  if (/^https?:\/\//i.test(post.url || '')) return post.url;
  if (/^https?:\/\//i.test(post.inputUrl || '')) return post.inputUrl;
  const code = post.shortCode || post.shortcode;
  return code ? `https://www.instagram.com/p/${code}/` : '';
}

function normalizePost(post = {}, sourceKind = 'hashtag') {
  const url = postUrl(post);
  const caption = clean(post.caption || post.text || post.title, 1600);
  if (!url && !caption) return null;
  return {
    url,
    account: clean(post.ownerUsername || post.username || post.ownerFullName, 120),
    caption,
    likes: number(post.likesCount || post.likes),
    comments: number(post.commentsCount || post.comments),
    views: number(post.videoViewCount || post.videoPlayCount || post.videoViews),
    timestamp: clean(post.timestamp || post.takenAt || post.publishedAt, 80),
    hashtags: Array.isArray(post.hashtags) ? post.hashtags.slice(0, 15).map(item => clean(item, 80)) : [],
    sourceKind,
  };
}

function dedupePosts(posts = []) {
  const seen = new Set();
  return posts.filter(Boolean).filter(post => {
    const key = post.url || `${post.account}:${post.caption.slice(0, 120)}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function scrapeInstagramHashtags(hashtags = [], { resultsLimit = 80 } = {}) {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN fehlt');
  const list = [...new Set(hashtags.map(item => clean(item, 100).replace(/^#/, '').replace(/\s+/g, '')).filter(Boolean))].slice(0, 12);
  if (!list.length) throw new Error('Mindestens ein Instagram-Hashtag fehlt');
  const totalLimit = Math.max(10, Math.min(150, number(resultsLimit, 80)));
  // Beim Actor gilt resultsLimit PRO Hashtag. Deshalb wird das Gesamtbudget
  // auf die Begriffe verteilt und der Dataset-Output zusaetzlich gedeckelt.
  const perHashtagLimit = Math.max(1, Math.ceil(totalLimit / list.length));
  const query = new URLSearchParams({ token, timeout: '100', clean: 'true', limit: String(totalLimit), maxTotalChargeUsd: '1' });
  return withRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 105_000);
    try {
      const response = await fetch(`${HASHTAG_ACTOR_URL}?${query}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ hashtags: list, resultsType: 'posts', resultsLimit: perHashtagLimit }),
      });
      if (!response.ok) {
        const error = new Error(`Apify ${response.status}: ${(await response.text()).slice(0, 300)}`);
        error.retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
        throw error;
      }
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error('Apify lieferte kein Dataset-Array');
      return data.slice(0, totalLimit);
    } finally { clearTimeout(timer); }
  }, { attempts: 2, timeoutMs: 110_000, label: 'Instagram-Hashtags' });
}

function sourceExcerpt(post, index) {
  const engagement = post.views || (post.likes + post.comments);
  return {
    ref: index + 1,
    url: post.url,
    account: post.account,
    caption: post.caption.slice(0, 1000),
    engagementSignal: engagement,
    likes: post.likes,
    comments: post.comments,
    views: post.views,
    timestamp: post.timestamp,
    sourceKind: post.sourceKind,
  };
}

function parseJson(text) {
  const cleanText = String(text || '').replace(/```json|```/gi, '').trim();
  try { return JSON.parse(cleanText); } catch {}
  const start = cleanText.indexOf('{'); const end = cleanText.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(cleanText.slice(start, end + 1));
  throw new Error('KI-Antwort war kein valides JSON');
}

async function synthesizeOpportunities(posts, settings) {
  const evidence = posts.slice(0, settings.maxSourcesPerRun).map(sourceExcerpt);
  const routed = chooseModel({ task: 'marketing-intelligence' });
  await checkBudget(routed);
  const system = `Du bist IVAs Chancen-Analyst. Du sichtest reale Instagram-Signale, aber du glaubst weder Einkommensversprechen noch Reichweite blind. Finde maximal 8 eigenstaendig umsetzbare, legale Geschaeftsmodelle, bei denen KI den Aufwand deutlich senken kann. Keine Kopie fremder Inhalte, kein Spam, keine MLM-/Trading-/Gluecksspiel-/Krypto-Schnellreich-Ideen, keine Dark Patterns. "Passiv" bedeutet hier: nach einem realistischen Aufbau mit begrenzter laufender Pflege, niemals ohne Arbeit.

Arbeite AUSSCHLIESSLICH mit den gelieferten Quellen. Instagram-Posts und Creator-Profile sind Entdeckungssignale, keine Produkt-, Preis-, Lizenz- oder Wirksamkeitsbelege. Mehrere Posts, die nur denselben Hype wiederholen, sind noch kein Marktnachweis. Umsatz- oder Einkommensangaben sind unbestaetigte Claims. Jede Chance braucht einen kleinen bezahlbaren 7-Tage-Validierungstest und vor jeder Tool-/Agenten-Integration zusaetzlich IVAs Capability-Gate mit offizieller Primarquelle.

Antworte ausschließlich als valides JSON ohne Markdown:
{"ideas":[{"title":"","summary":"","customer":"","offer":"","monetization":"","aiLeverage":"","firstValidation":"","evidence":"","evidenceLimits":"","risks":"","saturation":"","setupHours":0,"ongoingHoursPerWeek":0,"initialBudgetEur":0,"revenueClaim":"nur falls Quelle einen Claim nennt, dann ausdrücklich unbestätigt","recommendedAgent":"marketing|course|web|sales|energy|other","sourceRefs":[1],"ratings":{"demandEvidence":0,"monetizationClarity":0,"automationFit":0,"lowOngoingEffort":0,"speedToValidate":0,"nadineFit":0,"evidenceQuality":0,"defensibility":0,"platformRisk":0,"legalRisk":0,"saturationRisk":0,"hypeRisk":0}}],"discardedSignals":[{"signal":"","reason":""}]}

Alle Ratings sind ganze Zahlen von 0 bis 10. NadineFit bewertet Synergien mit Finanz-/Versicherungsberatung, Energie, KI-Automatisierung, Kursen und Marketing. Wenn Belege schwach sind, evidenceQuality und demandEvidence niedrig bewerten.`;
  const prompt = JSON.stringify({ constraints: settings, sources: evidence });
  let parsed;
  let priorText = '';
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { text, usage } = await generateText({
        model: routed.model,
        system,
        prompt: attempt === 1 || !priorText
          ? prompt
          : `Repariere ausschließlich das Format der folgenden Antwort zu validem JSON im geforderten Schema. Keine neuen Fakten ergänzen.\n\n${clean(priorText, 12_000)}`,
      });
      priorText = text;
      await recordUsage(routed, usage);
      parsed = parseJson(text);
      break;
    } catch (error) {
      lastError = error;
      const nonRetryable = error?.code === 'budget_exceeded' || /(?:401|403|api.?key|authentication|unauthorized)/i.test(String(error?.message || ''));
      if (nonRetryable || attempt === 2) throw error;
    }
  }
  if (!parsed) throw lastError || new Error('Chancen-Auswertung lieferte kein Ergebnis');
  return { ideas: Array.isArray(parsed.ideas) ? parsed.ideas.slice(0, 8) : [], discardedSignals: Array.isArray(parsed.discardedSignals) ? parsed.discardedSignals.slice(0, 20) : [], evidence };
}

async function executeOpportunityScout({ trigger = 'manual' } = {}) {
  const settings = await getOpportunitySettings();
  const run = await createOpportunityRun({ trigger });
  try {
    if (!process.env.APIFY_TOKEN) throw new Error('APIFY_TOKEN fehlt. Ohne echten Instagram-Datenzugang wird kein Wochenranking erfunden.');
    const modelStatus = opportunityModelStatus();
    if (!modelStatus.ready) throw new Error(`${modelStatus.missing.join(', ')} fehlt. Der Chancenradar sammelt deshalb noch keine kostenpflichtigen Quellen.`);
    const sourcePosts = [];
    const sourceWarnings = [];
    try {
      const hashtagRaw = await scrapeInstagramHashtags(settings.hashtags, { resultsLimit: settings.maxSourcesPerRun });
      sourcePosts.push(...hashtagRaw.map(post => normalizePost(post, 'hashtag')));
    } catch (error) {
      sourceWarnings.push({ source: 'hashtags', error: clean(error.message, 500) });
      console.warn(`Chancenradar Hashtags: ${error.message}`);
    }
    // Die kuratierten Creator bleiben reine Entdeckungsquellen. Pro Lauf rotieren
    // nur zwei davon, damit der bestehende Wochenlauf nicht unbemerkt teuer wird.
    const week = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
    const curatedRotation = [0, 1].map(offset => CURATED_DISCOVERY_ACCOUNTS[(week + offset) % CURATED_DISCOVERY_ACCOUNTS.length]);
    const seedAccounts = [...new Set([...settings.seedAccounts.slice(0, 3), ...curatedRotation])].slice(0, 5);
    for (const account of seedAccounts) {
      try {
        const posts = await withRetry(
          () => scrapeInstagram(account, { resultsLimit: Math.max(8, Math.min(20, Math.floor(settings.maxSourcesPerRun / 4))) }),
          { attempts: 2, timeoutMs: 110_000, label: `Instagram @${account}` },
        );
        sourcePosts.push(...posts.map(post => normalizePost(post, 'seed-account')));
      } catch (error) {
        sourceWarnings.push({ source: `@${account}`, error: clean(error.message, 500) });
        console.warn(`Chancenradar Instagram ${account}: ${error.message}`);
      }
    }
    const posts = dedupePosts(sourcePosts)
      .sort((a, b) => (b.views || b.likes + b.comments) - (a.views || a.likes + a.comments))
      .slice(0, settings.maxSourcesPerRun);
    if (!posts.length) throw new Error('Instagram lieferte fuer die hinterlegten Quellen keine verwertbaren Posts');
    const synthesized = await synthesizeOpportunities(posts, settings);
    const saved = [];
    for (const idea of synthesized.ideas) {
      try {
        const refs = [...new Set((idea.sourceRefs || []).map(value => Math.max(1, Math.floor(number(value, 0)))).filter(Boolean))];
        const sources = refs.map(ref => synthesized.evidence.find(item => item.ref === ref)).filter(Boolean).map(source => ({
          url: source.url, account: source.account, signal: source.caption.slice(0, 420), observedAt: source.timestamp || new Date().toISOString(),
        }));
        // Ohne Status-Angabe bleiben bereits beobachtete, verworfene oder
        // ausgewaehlte Chancen bei einem spaeteren Wiederfund in ihrem Zustand.
        const candidate = { ...idea, sources, sourceRunId: run.id };
        const scored = scoreOpportunity(candidate, settings);
        saved.push(await upsertOpportunity({ ...candidate, score: scored.score, scoreBreakdown: scored }));
        const latest = saved.at(-1);
        if (latest) {
          // upsertOpportunity intentionally sanitizes the domain fields. Score metadata is added in a second, explicit update by the caller route.
          latest.score = scored.score;
          latest.scoreBreakdown = scored;
        }
      } catch (error) {
        sourceWarnings.push({ source: `KI-Idee ${clean(idea?.title || 'ohne Titel', 120)}`, error: clean(error.message, 500) });
      }
    }
    // Persist score metadata without weakening the normalizer.
    for (const item of saved) await updateOpportunity(item.id, { score: item.score, scoreBreakdown: item.scoreBreakdown });
    const ranked = sortOpportunities(saved);
    const completed = await updateOpportunityRun(run.id, {
      status: 'complete', sourceCount: posts.length, ideaCount: ranked.length,
      sourceWarnings, discardedSignals: synthesized.discardedSignals, opportunityIds: ranked.map(item => item.id), completedAt: new Date().toISOString(),
    });
    return { ok: true, run: completed, opportunities: ranked, warnings: sourceWarnings, pitch: formatWeeklyPitch(ranked, { max: settings.topIdeasPerPitch }) };
  } catch (error) {
    await updateOpportunityRun(run.id, { status: 'failed', error: error.message, completedAt: new Date().toISOString() });
    throw error;
  }
}

export async function runOpportunityScout(options = {}) {
  // Railway und UI koennen denselben Lauf nahezu gleichzeitig anstossen.
  // Ein Prozess fuehrt deshalb immer nur einen kostenpflichtigen Scan aus;
  // weitere Aufrufer erhalten dasselbe Ergebnis statt eines Doppel-Laufs.
  if (activeScoutPromise) return activeScoutPromise;
  const promise = executeOpportunityScout(options);
  activeScoutPromise = promise;
  try { return await promise; }
  finally { if (activeScoutPromise === promise) activeScoutPromise = null; }
}

export async function opportunityRadarStatus() {
  const [settings, counts, runs] = await Promise.all([getOpportunitySettings(), opportunityRadarCounts(), listOpportunityRuns({ limit: 1 })]);
  const model = opportunityModelStatus();
  const missing = [...(!process.env.APIFY_TOKEN ? ['APIFY_TOKEN'] : []), ...model.missing];
  return {
    configured: missing.length === 0,
    ready: missing.length === 0,
    provider: `Apify · öffentliche Instagram-Signale · ${model.modelId || 'Auswertungsmodell nicht bereit'}`,
    model,
    weekly: { enabled: settings.weeklyEnabled, schedule: 'Montag 08:30 · Europe/Berlin', telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN) },
    safeguards: ['Instagram nur als Entdeckungssignal', 'offizielle Primarquelle vor Integration', 'keine Einkommensgarantie', 'Kosten-/Zeit-Caps', 'keine automatische Umsetzung'],
    curatedDiscoveryAccounts: CURATED_DISCOVERY_ACCOUNTS,
    lastRun: runs[0] || null,
    missing,
    counts,
  };
}
