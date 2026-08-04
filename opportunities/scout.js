import { generateText } from 'ai';
import { chooseModel, recordUsage, checkBudget } from '../core/router.js';
import { scrapeInstagram } from '../marketing/analyze.js';
import {
  createOpportunityRun,
  getOpportunitySettings,
  opportunityRadarCounts,
  updateOpportunity,
  updateOpportunityRun,
  upsertOpportunity,
} from './store.js';
import { formatWeeklyPitch, scoreOpportunity, sortOpportunities } from './score.js';

const HASHTAG_ACTOR_URL = 'https://api.apify.com/v2/acts/apify~instagram-hashtag-scraper/run-sync-get-dataset-items';
const clean = (value, max = 1000) => String(value || '').trim().slice(0, max);
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

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
  const query = new URLSearchParams({ token, timeout: '180', clean: 'true', maxItems: String(Math.max(10, Math.min(150, resultsLimit))), maxTotalChargeUsd: '1' });
  const response = await fetch(`${HASHTAG_ACTOR_URL}?${query}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashtags: list, resultsLimit: Math.max(10, Math.min(150, resultsLimit)) }),
  });
  if (!response.ok) throw new Error(`Apify ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const data = await response.json();
  return Array.isArray(data) ? data : [];
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
  const { text, usage } = await generateText({
    model: routed.model,
    system: `Du bist IVAs Chancen-Analyst. Du sichtest reale Instagram-Signale, aber du glaubst weder Einkommensversprechen noch Reichweite blind. Finde maximal 8 eigenstaendig umsetzbare, legale Geschaeftsmodelle, bei denen KI den Aufwand deutlich senken kann. Keine Kopie fremder Inhalte, kein Spam, keine MLM-/Trading-/Gluecksspiel-/Krypto-Schnellreich-Ideen, keine Dark Patterns. "Passiv" bedeutet hier: nach einem realistischen Aufbau mit begrenzter laufender Pflege, niemals ohne Arbeit.

Arbeite AUSSCHLIESSLICH mit den gelieferten Quellen. Mehrere Posts, die nur denselben Hype wiederholen, sind noch kein Marktnachweis. Umsatz- oder Einkommensangaben sind unbestaetigte Claims. Jede Chance braucht einen kleinen bezahlbaren 7-Tage-Validierungstest.

Antworte ausschließlich als valides JSON ohne Markdown:
{"ideas":[{"title":"","summary":"","customer":"","offer":"","monetization":"","aiLeverage":"","firstValidation":"","evidence":"","evidenceLimits":"","risks":"","saturation":"","setupHours":0,"ongoingHoursPerWeek":0,"initialBudgetEur":0,"revenueClaim":"nur falls Quelle einen Claim nennt, dann ausdrücklich unbestätigt","recommendedAgent":"marketing|course|web|sales|energy|other","sourceRefs":[1],"ratings":{"demandEvidence":0,"monetizationClarity":0,"automationFit":0,"lowOngoingEffort":0,"speedToValidate":0,"nadineFit":0,"evidenceQuality":0,"defensibility":0,"platformRisk":0,"legalRisk":0,"saturationRisk":0,"hypeRisk":0}}],"discardedSignals":[{"signal":"","reason":""}]}

Alle Ratings sind ganze Zahlen von 0 bis 10. NadineFit bewertet Synergien mit Finanz-/Versicherungsberatung, Energie, KI-Automatisierung, Kursen und Marketing. Wenn Belege schwach sind, evidenceQuality und demandEvidence niedrig bewerten.`,
    prompt: JSON.stringify({ constraints: settings, sources: evidence }),
  });
  await recordUsage(routed, usage);
  const parsed = parseJson(text);
  return { ideas: Array.isArray(parsed.ideas) ? parsed.ideas.slice(0, 8) : [], discardedSignals: Array.isArray(parsed.discardedSignals) ? parsed.discardedSignals.slice(0, 20) : [], evidence };
}

export async function runOpportunityScout({ trigger = 'manual' } = {}) {
  const settings = await getOpportunitySettings();
  const run = await createOpportunityRun({ trigger });
  try {
    if (!process.env.APIFY_TOKEN) throw new Error('APIFY_TOKEN fehlt. Ohne echten Instagram-Datenzugang wird kein Wochenranking erfunden.');
    const hashtagRaw = await scrapeInstagramHashtags(settings.hashtags, { resultsLimit: settings.maxSourcesPerRun });
    const sourcePosts = hashtagRaw.map(post => normalizePost(post, 'hashtag'));
    for (const account of settings.seedAccounts.slice(0, 5)) {
      try {
        const posts = await scrapeInstagram(account, { resultsLimit: Math.max(8, Math.min(20, Math.floor(settings.maxSourcesPerRun / 4))) });
        sourcePosts.push(...posts.map(post => normalizePost(post, 'seed-account')));
      } catch (error) {
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
      const refs = [...new Set((idea.sourceRefs || []).map(value => Math.max(1, Math.floor(number(value, 0)))).filter(Boolean))];
      const sources = refs.map(ref => synthesized.evidence.find(item => item.ref === ref)).filter(Boolean).map(source => ({
        url: source.url, account: source.account, signal: source.caption.slice(0, 420), observedAt: source.timestamp || new Date().toISOString(),
      }));
      const candidate = { ...idea, sources, sourceRunId: run.id, status: 'new' };
      const scored = scoreOpportunity(candidate, settings);
      saved.push(await upsertOpportunity({ ...candidate, score: scored.score, scoreBreakdown: scored }));
      const latest = saved.at(-1);
      if (latest) {
        // upsertOpportunity intentionally sanitizes the domain fields. Score metadata is added in a second, explicit update by the caller route.
        latest.score = scored.score;
        latest.scoreBreakdown = scored;
      }
    }
    // Persist score metadata without weakening the normalizer.
    for (const item of saved) await updateOpportunity(item.id, { score: item.score, scoreBreakdown: item.scoreBreakdown });
    const ranked = sortOpportunities(saved);
    const completed = await updateOpportunityRun(run.id, {
      status: 'complete', sourceCount: posts.length, ideaCount: ranked.length,
      discardedSignals: synthesized.discardedSignals, opportunityIds: ranked.map(item => item.id), completedAt: new Date().toISOString(),
    });
    return { ok: true, run: completed, opportunities: ranked, pitch: formatWeeklyPitch(ranked, { max: settings.topIdeasPerPitch }) };
  } catch (error) {
    await updateOpportunityRun(run.id, { status: 'failed', error: error.message, completedAt: new Date().toISOString() });
    throw error;
  }
}

export async function opportunityRadarStatus() {
  const [settings, counts] = await Promise.all([getOpportunitySettings(), opportunityRadarCounts()]);
  return {
    configured: Boolean(process.env.APIFY_TOKEN),
    ready: Boolean(process.env.APIFY_TOKEN),
    provider: 'Apify · öffentliche Instagram-Signale',
    weekly: { enabled: settings.weeklyEnabled, schedule: 'Montag 08:30 · Europe/Berlin', telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN) },
    safeguards: ['Quellenpflicht', 'keine Einkommensgarantie', 'Kosten-/Zeit-Caps', 'keine automatische Umsetzung'],
    missing: process.env.APIFY_TOKEN ? [] : ['APIFY_TOKEN'],
    counts,
  };
}
