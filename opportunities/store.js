import fs from 'fs/promises';

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = DATA_DIR + '/opportunity-radar.json';
const STATUSES = new Set(['new', 'watch', 'validate', 'rejected', 'selected']);
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
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, runs: [], opportunities: [], handoffs: [] };
}

const clean = (value, max = 1000) => String(value || '').trim().slice(0, max);
const uniq = values => [...new Set((Array.isArray(values) ? values : []).map(value => clean(value, 120).replace(/^#/, '')).filter(Boolean))];
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

async function load() {
  try {
    const data = JSON.parse(await fs.readFile(FILE, 'utf8'));
    return {
      ...emptyStore(),
      ...data,
      settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
      runs: Array.isArray(data.runs) ? data.runs : [],
      opportunities: Array.isArray(data.opportunities) ? data.opportunities : [],
      handoffs: Array.isArray(data.handoffs) ? data.handoffs : [],
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
    pendingHandoffs: data.handoffs.filter(item => item.status === 'awaiting-confirmation').length,
  };
}

export { DEFAULT_SETTINGS };
