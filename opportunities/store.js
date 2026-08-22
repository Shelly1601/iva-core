import fs from 'fs/promises';

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = DATA_DIR + '/opportunity-radar.json';
const STATUSES = new Set(['new', 'watch', 'validate', 'rejected', 'selected']);
const LINK_CHECK_MODES = new Set(['iva-integration', 'business']);
const LINK_CHECK_REQUESTED_MODES = new Set(['auto', 'iva-integration', 'business']);
const LINK_CHECK_STATUSES = new Set(['complete', 'failed']);
const MARKET_SOURCE_TYPES = new Set(['instagram', 'website', 'newsletter', 'youtube', 'linkedin', 'podcast', 'other']);
const MARKET_ANALYSIS_STATUSES = new Set(['complete', 'failed']);
let mutationQueue = Promise.resolve();

const DEFAULT_SETTINGS = Object.freeze({
  weeklyEnabled: true,
  weeklyDay: 'monday',
  weeklyTime: '08:30',
  hashtags: ['aibusinessideen', 'passiveseinkommen', 'digitalesprodukt', 'microsaas', 'facelessmarketing', 'kionlinebusiness'],
  seedAccounts: [],
  maxInitialBudgetEur: 500,
  maxSetupHours: 20,
  maxOngoingHoursPerWeek: 3,
  maxSourcesPerRun: 80,
  topIdeasPerPitch: 5,
  notes: 'KI-gestuetzte, legal umsetzbare Modelle mit wenig laufender Pflege. Keine Einkommensversprechen.',
});

function emptyStore() {
  return { version: 3, settings: { ...DEFAULT_SETTINGS }, runs: [], opportunities: [], handoffs: [], linkChecks: [], marketAnalyses: [], watchSources: [] };
}

const clean = (value, max = 1000) => String(value || '').trim().slice(0, max);
const uniq = values => [...new Set((Array.isArray(values) ? values : []).map(value => clean(value, 120).replace(/^#/, '')).filter(Boolean))];
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function publicHttpUrl(value) {
  try {
    const url = new URL(clean(value, 1500));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    return url.toString();
  } catch { return ''; }
}

async function load() {
  try {
    const data = JSON.parse(await fs.readFile(FILE, 'utf8'));
    return {
      ...emptyStore(),
      ...data,
      version: 3,
      settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
      runs: Array.isArray(data.runs) ? data.runs : [],
      opportunities: Array.isArray(data.opportunities) ? data.opportunities : [],
      handoffs: Array.isArray(data.handoffs) ? data.handoffs : [],
      linkChecks: Array.isArray(data.linkChecks) ? data.linkChecks : [],
      marketAnalyses: Array.isArray(data.marketAnalyses) ? data.marketAnalyses : [],
      watchSources: Array.isArray(data.watchSources) ? data.watchSources : [],
    };
  } catch {
    return emptyStore();
  }
}

async function save(data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, FILE);
}

async function mutate(fn) {
  let result;
  const mutation = mutationQueue.catch(() => {}).then(async () => {
    const data = await load();
    result = await fn(data);
    await save(data);
  });
  mutationQueue = mutation.catch(() => {});
  await mutation;
  return result;
}

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export async function getOpportunitySettings() {
  return { ...(await load()).settings };
}

export async function updateOpportunitySettings(input = {}) {
  return mutate(async data => {
    const current = data.settings;
    data.settings = {
      ...current,
      weeklyEnabled: input.weeklyEnabled === undefined ? current.weeklyEnabled : input.weeklyEnabled === true,
      hashtags: input.hashtags === undefined ? current.hashtags : uniq(input.hashtags).slice(0, 20),
      seedAccounts: input.seedAccounts === undefined ? current.seedAccounts : uniq(input.seedAccounts).slice(0, 20),
      maxInitialBudgetEur: Math.max(0, Math.min(100_000, finite(input.maxInitialBudgetEur, current.maxInitialBudgetEur))),
      maxSetupHours: Math.max(1, Math.min(500, finite(input.maxSetupHours, current.maxSetupHours))),
      maxOngoingHoursPerWeek: Math.max(0, Math.min(80, finite(input.maxOngoingHoursPerWeek, current.maxOngoingHoursPerWeek))),
      maxSourcesPerRun: Math.max(10, Math.min(150, finite(input.maxSourcesPerRun, current.maxSourcesPerRun))),
      topIdeasPerPitch: Math.max(1, Math.min(10, finite(input.topIdeasPerPitch, current.topIdeasPerPitch))),
      notes: input.notes === undefined ? current.notes : clean(input.notes, 3000),
      updatedAt: new Date().toISOString(),
    };
    return { ...data.settings };
  });
}

export async function createOpportunityRun(input = {}) {
  return mutate(async data => {
    const now = new Date().toISOString();
    const run = { id: id('run'), trigger: clean(input.trigger || 'manual', 30), status: 'running', sourceCount: 0, ideaCount: 0, error: '', startedAt: now, updatedAt: now };
    data.runs.push(run);
    data.runs = data.runs.slice(-200);
    return { ...run };
  });
}

export async function updateOpportunityRun(runId, patch = {}) {
  return mutate(async data => {
    const run = data.runs.find(item => item.id === runId);
    if (!run) return null;
    Object.assign(run, patch, { id: run.id, startedAt: run.startedAt, updatedAt: new Date().toISOString() });
    return { ...run };
  });
}

function normalizedOpportunity(input = {}, existing = {}) {
  const now = new Date().toISOString();
  const sources = (Array.isArray(input.sources) ? input.sources : existing.sources || []).map(source => ({
    url: clean(source?.url, 1000),
    account: clean(source?.account, 120),
    signal: clean(source?.signal, 500),
    observedAt: clean(source?.observedAt, 60) || now,
  })).filter(source => source.url || source.signal).slice(0, 12);
  return {
    ...existing,
    title: clean(input.title ?? existing.title, 180),
    summary: clean(input.summary ?? existing.summary, 1800),
    customer: clean(input.customer ?? existing.customer, 500),
    offer: clean(input.offer ?? existing.offer, 800),
    monetization: clean(input.monetization ?? existing.monetization, 800),
    aiLeverage: clean(input.aiLeverage ?? existing.aiLeverage, 1000),
    firstValidation: clean(input.firstValidation ?? existing.firstValidation, 1500),
    evidence: clean(input.evidence ?? existing.evidence, 1600),
    evidenceLimits: clean(input.evidenceLimits ?? existing.evidenceLimits, 1200),
    risks: clean(input.risks ?? existing.risks, 1200),
    saturation: clean(input.saturation ?? existing.saturation, 600),
    setupHours: Math.max(0, finite(input.setupHours, existing.setupHours || 0)),
    ongoingHoursPerWeek: Math.max(0, finite(input.ongoingHoursPerWeek, existing.ongoingHoursPerWeek || 0)),
    initialBudgetEur: Math.max(0, finite(input.initialBudgetEur, existing.initialBudgetEur || 0)),
    revenueClaim: clean(input.revenueClaim ?? existing.revenueClaim, 500),
    recommendedAgent: clean(input.recommendedAgent ?? existing.recommendedAgent, 80) || 'marketing',
    ratings: { ...(existing.ratings || {}), ...(input.ratings || {}) },
    sources,
    sourceRunId: clean(input.sourceRunId ?? existing.sourceRunId, 80),
    status: STATUSES.has(input.status) ? input.status : (existing.status || 'new'),
    updatedAt: now,
  };
}

export async function upsertOpportunity(input = {}) {
  if (!clean(input.title, 180)) throw new Error('Titel der Chance fehlt');
  return mutate(async data => {
    const key = clean(input.title, 180).toLocaleLowerCase('de-DE');
    const existing = data.opportunities.find(item => clean(item.title, 180).toLocaleLowerCase('de-DE') === key);
    const item = normalizedOpportunity(input, existing || {});
    if (existing) Object.assign(existing, item, { id: existing.id, createdAt: existing.createdAt });
    else {
      Object.assign(item, { id: id('opp'), createdAt: new Date().toISOString() });
      data.opportunities.push(item);
    }
    data.opportunities = data.opportunities.slice(-1000);
    return { ...(existing || item) };
  });
}

export async function listOpportunities({ status = '', limit = 100 } = {}) {
  const data = await load();
  return data.opportunities
    .filter(item => !status || item.status === status)
    .sort((a, b) => finite(b.score) - finite(a.score) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, Math.max(1, Math.min(1000, finite(limit, 100))));
}

export async function getOpportunity(opportunityId) {
  return (await load()).opportunities.find(item => item.id === opportunityId) || null;
}

export async function updateOpportunity(opportunityId, patch = {}) {
  return mutate(async data => {
    const item = data.opportunities.find(entry => entry.id === opportunityId);
    if (!item) return null;
    const updated = normalizedOpportunity(patch, item);
    Object.assign(item, updated, { id: item.id, createdAt: item.createdAt });
    if (patch.score !== undefined) item.score = finite(patch.score);
    if (patch.scoreBreakdown) item.scoreBreakdown = patch.scoreBreakdown;
    return { ...item };
  });
}

export async function listOpportunityRuns({ limit = 30 } = {}) {
  return (await load()).runs.slice().sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, Math.max(1, Math.min(200, finite(limit, 30))));
}

function normalizedLinkCheck(input = {}) {
  const now = new Date().toISOString();
  const assessment = input.assessment && typeof input.assessment === 'object' ? input.assessment : {};
  const stringList = (values, maxItems = 10, maxLength = 500) => (Array.isArray(values) ? values : [])
    .map(value => clean(value, maxLength)).filter(Boolean).slice(0, maxItems);
  return {
    id: clean(input.id, 80) || id('link'),
    mode: LINK_CHECK_MODES.has(input.mode) ? input.mode : 'business',
    requestedMode: LINK_CHECK_REQUESTED_MODES.has(input.requestedMode) ? input.requestedMode : (LINK_CHECK_MODES.has(input.mode) ? input.mode : 'business'),
    classificationReason: clean(input.classificationReason, 800),
    classificationConfidence: Math.max(0, Math.min(1, finite(input.classificationConfidence))),
    status: LINK_CHECK_STATUSES.has(input.status) ? input.status : 'complete',
    url: publicHttpUrl(input.url),
    finalUrl: clean(input.finalUrl, 1500),
    sourceType: clean(input.sourceType, 80),
    sourceTitle: clean(input.sourceTitle, 300),
    sourceExcerpt: clean(input.sourceExcerpt, 1800),
    error: clean(input.error, 800),
    assessment: {
      headline: clean(assessment.headline, 240),
      verdict: clean(assessment.verdict, 80),
      score: Math.max(0, Math.min(100, finite(assessment.score))),
      summary: clean(assessment.summary, 1800),
      whatItIs: clean(assessment.whatItIs, 1200),
      evidence: stringList(assessment.evidence, 10, 600),
      assumptions: stringList(assessment.assumptions, 10, 600),
      fit: stringList(assessment.fit, 10, 600),
      gaps: stringList(assessment.gaps, 10, 600),
      risks: stringList(assessment.risks, 10, 600),
      costsAndEffort: clean(assessment.costsAndEffort, 1000),
      nextTest: clean(assessment.nextTest, 1200),
      recommendedArea: clean(assessment.recommendedArea, 120),
    },
    createdAt: clean(input.createdAt, 60) || now,
  };
}

export async function recordOpportunityLinkCheck(input = {}) {
  return mutate(async data => {
    const item = normalizedLinkCheck(input);
    data.linkChecks.push(item);
    data.linkChecks = data.linkChecks.slice(-300);
    return { ...item, assessment: { ...item.assessment } };
  });
}

export async function listOpportunityLinkChecks({ mode = '', limit = 30 } = {}) {
  const data = await load();
  return data.linkChecks
    .filter(item => !mode || item.mode === mode)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(200, finite(limit, 30))));
}

function stringList(values, maxItems = 12, maxLength = 500) {
  return (Array.isArray(values) ? values : []).map(value => clean(value, maxLength)).filter(Boolean).slice(0, maxItems);
}

function normalizedMarketSource(input = {}) {
  return {
    id: clean(input.id, 100) || id('source'),
    name: clean(input.name, 240) || clean(input.handle, 120) || 'Quelle',
    type: MARKET_SOURCE_TYPES.has(input.type) ? input.type : 'other',
    url: publicHttpUrl(input.url),
    handle: clean(input.handle, 120).replace(/^@/, ''),
    score: Math.max(0, Math.min(100, Math.round(finite(input.score)))),
    reason: clean(input.reason, 1600),
    strengths: stringList(input.strengths),
    topics: stringList(input.topics),
    contentPatterns: stringList(input.contentPatterns),
    evidence: stringList(input.evidence),
    cadence: ['weekly', 'monthly', 'quarterly'].includes(input.cadence) ? input.cadence : 'monthly',
    monitoringValue: ['high', 'medium', 'low'].includes(input.monitoringValue) ? input.monitoringValue : 'medium',
    sampleSize: Math.max(0, Math.min(500, Math.round(finite(input.sampleSize)))),
    latestObservedAt: clean(input.latestObservedAt, 80),
  };
}

function normalizedMarketAnalysis(input = {}) {
  const now = new Date().toISOString();
  return {
    id: clean(input.id, 100) || id('market'),
    status: MARKET_ANALYSIS_STATUSES.has(input.status) ? input.status : 'complete',
    topic: clean(input.topic, 240),
    keywords: stringList(input.keywords, 20, 120),
    region: clean(input.region, 120) || 'DACH',
    language: clean(input.language, 80) || 'Deutsch',
    summary: clean(input.summary, 3000),
    marketPatterns: stringList(input.marketPatterns, 15, 800),
    blindSpots: stringList(input.blindSpots, 15, 800),
    nextQueries: stringList(input.nextQueries, 15, 300),
    sources: (Array.isArray(input.sources) ? input.sources : []).map(normalizedMarketSource).filter(source => source.url).slice(0, 30),
    searchQueries: stringList(input.searchQueries, 12, 500),
    warnings: stringList(input.warnings, 20, 800),
    error: clean(input.error, 1200),
    createdAt: clean(input.createdAt, 80) || now,
  };
}

export async function recordOpportunityMarketAnalysis(input = {}) {
  return mutate(async data => {
    const analysis = normalizedMarketAnalysis(input);
    data.marketAnalyses.push(analysis);
    data.marketAnalyses = data.marketAnalyses.slice(-100);
    return structuredClone(analysis);
  });
}

export async function listOpportunityMarketAnalyses({ limit = 20 } = {}) {
  return (await load()).marketAnalyses.slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(100, finite(limit, 20))))
    .map(item => structuredClone(item));
}

function sourceIdentity(source = {}) {
  return `${clean(source.type, 40)}:${clean(source.handle || source.url, 1500).toLocaleLowerCase('de-DE')}`;
}

export async function setOpportunityWatchSource(input = {}, enabled = true) {
  const source = normalizedMarketSource(input);
  if (!source.url) throw new Error('Die Beobachtungsquelle braucht eine öffentliche URL.');
  return mutate(async data => {
    const identity = sourceIdentity(source);
    const existingIndex = data.watchSources.findIndex(item => sourceIdentity(item) === identity);
    if (enabled !== true) {
      if (existingIndex >= 0) data.watchSources.splice(existingIndex, 1);
      return { enabled: false, source };
    }
    const now = new Date().toISOString();
    const watched = { ...(existingIndex >= 0 ? data.watchSources[existingIndex] : {}), ...source, id: existingIndex >= 0 ? data.watchSources[existingIndex].id : id('watch'), analysisId: clean(input.analysisId, 100), monitoredAt: existingIndex >= 0 ? data.watchSources[existingIndex].monitoredAt : now, updatedAt: now };
    if (existingIndex >= 0) data.watchSources[existingIndex] = watched;
    else data.watchSources.push(watched);
    data.watchSources = data.watchSources.slice(-100);
    return { enabled: true, source: structuredClone(watched) };
  });
}

export async function listOpportunityWatchSources() {
  return (await load()).watchSources.slice()
    .sort((a, b) => finite(b.score) - finite(a.score) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map(item => structuredClone(item));
}

export async function prepareOpportunityHandoff(opportunityId) {
  return mutate(async data => {
    const opportunity = data.opportunities.find(item => item.id === opportunityId);
    if (!opportunity) throw new Error('Chance nicht gefunden');
    const now = new Date().toISOString();
    const shortId = opportunity.id.replace(/^opp_/, '').slice(-6).toUpperCase();
    const handoff = {
      id: id('handoff'), opportunityId, title: opportunity.title,
      targetAgent: opportunity.recommendedAgent || 'marketing', status: 'awaiting-confirmation',
      confirmation: `Ja, Chancenidee ${shortId} umsetzen`,
      brief: { summary: opportunity.summary, firstValidation: opportunity.firstValidation, budgetCapEur: opportunity.initialBudgetEur, setupHours: opportunity.setupHours },
      createdAt: now, updatedAt: now,
    };
    data.handoffs.push(handoff);
    data.handoffs = data.handoffs.slice(-300);
    opportunity.status = 'selected';
    opportunity.updatedAt = now;
    return { ...handoff };
  });
}

export async function opportunityRadarCounts() {
  const data = await load();
  return {
    opportunities: data.opportunities.length,
    highPotential: data.opportunities.filter(item => finite(item.score) >= 75).length,
    validation: data.opportunities.filter(item => item.status === 'validate').length,
    runs: data.runs.length,
    linkChecks: data.linkChecks.length,
    marketAnalyses: data.marketAnalyses.length,
    watchSources: data.watchSources.length,
    pendingHandoffs: data.handoffs.filter(item => item.status === 'awaiting-confirmation').length,
  };
}

export { DEFAULT_SETTINGS };
