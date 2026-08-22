import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_SETTINGS = Object.freeze({
  objective: 'Langfristiger Vermoegensaufbau',
  horizonYears: 10,
  riskLevel: 'balanced',
  referenceCurrency: 'EUR',
  minCashPct: 5,
  maxPositionPct: 15,
  maxOrderValuePct: 10,
  allowedAssetTypes: ['Stock', 'Etf', 'MutualFund', 'Bond'],
  allowShorting: false,
  allowMargin: false,
  notes: '',
});

const DEFAULT_MANDATE = Object.freeze({
  objective: 'Risikoadjustiertes Wachstum des monatlichen Investmentbudgets',
  monthlyAmount: 0,
  currency: 'EUR',
  analysisCadence: 'daily',
  autonomyStage: 'observe',
  targetAutonomy: 'managed-live',
  reservePct: 10,
  maxMonthlyLossPct: 5,
  maxDrawdownPct: 15,
  maxPortfolioVolatilityPct: 25,
  maxNewPositionsPerMonth: 3,
  permittedUniverse: 'watchlist-and-portfolio',
  allowOptionsContracts: false,
  allowLeveragedProducts: false,
  simulationMinimumDecisions: 30,
  simulationMinimumMonths: 6,
  minimumCalibrationScore: 70,
  notes: '',
});

const RISK_LEVELS = new Set(['conservative', 'balanced', 'growth', 'aggressive']);
const ASSET_TYPES = new Set(['Stock', 'Etf', 'MutualFund', 'Bond']);
const DIRECTIONS = new Set(['Buy', 'Sell']);
const ORDER_TYPES = new Set(['Market', 'Limit']);
const DURATION_TYPES = new Set(['DayOrder', 'GoodTillCancel']);
const DRAFT_STATUSES = new Set(['draft', 'prechecked', 'blocked', 'archived']);
const AUTONOMY_STAGES = new Set(['observe', 'propose', 'sim-auto']);
const ANALYSIS_CADENCES = new Set(['daily', 'weekdays', 'weekly']);
const clean = (value, max = 2000) => String(value ?? '').trim().slice(0, max);
const clone = value => JSON.parse(JSON.stringify(value));
const pct = (value, fallback) => Math.max(0, Math.min(100, Number.isFinite(Number(value)) ? Number(value) : fallback));
const positive = (value, fallback = 0) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const unique = (values, max = 20) => [...new Set((Array.isArray(values) ? values : []).map(value => clean(value, 80)).filter(Boolean))].slice(0, max);

function emptyStore() {
  return { version: 2, settings: { ...DEFAULT_SETTINGS }, mandate: { ...DEFAULT_MANDATE }, watchlist: [], orderDrafts: [], analyses: [], opportunityScans: [], journal: [], audit: [] };
}

function normalizeMandate(input = {}, current = DEFAULT_MANDATE) {
  const requestedStage = clean(input.autonomyStage ?? current.autonomyStage, 30);
  if (requestedStage === 'live-auto') throw new Error('LIVE-Autonomie ist erst nach dokumentierter SIM-Bewaehrung und separater Aktivierung zulaessig.');
  const currency = clean(input.currency ?? current.currency, 3).toUpperCase();
  return {
    objective: clean(input.objective ?? current.objective, 800) || DEFAULT_MANDATE.objective,
    monthlyAmount: Math.max(0, Math.min(10_000_000, Number(input.monthlyAmount ?? current.monthlyAmount) || 0)),
    currency: /^[A-Z]{3}$/.test(currency) ? currency : current.currency,
    analysisCadence: ANALYSIS_CADENCES.has(input.analysisCadence) ? input.analysisCadence : current.analysisCadence,
    autonomyStage: AUTONOMY_STAGES.has(requestedStage) ? requestedStage : current.autonomyStage,
    targetAutonomy: 'managed-live',
    reservePct: pct(input.reservePct, current.reservePct),
    maxMonthlyLossPct: Math.max(0.5, Math.min(50, pct(input.maxMonthlyLossPct, current.maxMonthlyLossPct))),
    maxDrawdownPct: Math.max(1, Math.min(80, pct(input.maxDrawdownPct, current.maxDrawdownPct))),
    maxPortfolioVolatilityPct: Math.max(1, Math.min(100, pct(input.maxPortfolioVolatilityPct, current.maxPortfolioVolatilityPct))),
    maxNewPositionsPerMonth: Math.max(1, Math.min(50, Math.round(positive(input.maxNewPositionsPerMonth, current.maxNewPositionsPerMonth)))),
    permittedUniverse: 'watchlist-and-portfolio',
    allowOptionsContracts: input.allowOptionsContracts === true,
    allowLeveragedProducts: input.allowLeveragedProducts === true,
    simulationMinimumDecisions: Math.max(10, Math.min(1000, Math.round(positive(input.simulationMinimumDecisions, current.simulationMinimumDecisions)))),
    simulationMinimumMonths: Math.max(1, Math.min(60, Math.round(positive(input.simulationMinimumMonths, current.simulationMinimumMonths)))),
    minimumCalibrationScore: Math.max(1, Math.min(100, pct(input.minimumCalibrationScore, current.minimumCalibrationScore))),
    notes: clean(input.notes ?? current.notes, 5000),
  };
}

function normalizeSettings(input = {}, current = DEFAULT_SETTINGS) {
  const allowed = input.allowedAssetTypes === undefined
    ? current.allowedAssetTypes
    : unique(input.allowedAssetTypes).filter(value => ASSET_TYPES.has(value));
  if (!allowed.length) throw new Error('Mindestens eine zulässige Anlageklasse fehlt.');
  return {
    objective: clean(input.objective ?? current.objective, 500) || DEFAULT_SETTINGS.objective,
    horizonYears: Math.max(1, Math.min(60, Math.round(positive(input.horizonYears, current.horizonYears)))),
    riskLevel: RISK_LEVELS.has(input.riskLevel) ? input.riskLevel : current.riskLevel,
    referenceCurrency: /^[A-Z]{3}$/.test(clean(input.referenceCurrency ?? current.referenceCurrency, 3).toUpperCase())
      ? clean(input.referenceCurrency ?? current.referenceCurrency, 3).toUpperCase()
      : current.referenceCurrency,
    minCashPct: pct(input.minCashPct, current.minCashPct),
    maxPositionPct: Math.max(1, pct(input.maxPositionPct, current.maxPositionPct)),
    maxOrderValuePct: Math.max(0.5, pct(input.maxOrderValuePct, current.maxOrderValuePct)),
    allowedAssetTypes: allowed,
    allowShorting: input.allowShorting === undefined ? current.allowShorting === true : input.allowShorting === true,
    allowMargin: input.allowMargin === undefined ? current.allowMargin === true : input.allowMargin === true,
    notes: clean(input.notes ?? current.notes, 5000),
  };
}

function normalizeInstrument(input = {}) {
  const uic = Math.round(Number(input.uic ?? input.Uic));
  const assetType = clean(input.assetType ?? input.AssetType, 80);
  if (!Number.isInteger(uic) || uic <= 0) throw new Error('Gueltige Saxo-UIC fehlt.');
  if (!assetType) throw new Error('Saxo-Anlageklasse fehlt.');
  return {
    uic,
    assetType,
    symbol: clean(input.symbol ?? input.Symbol, 120),
    description: clean(input.description ?? input.Description, 300),
    exchangeId: clean(input.exchangeId ?? input.ExchangeId, 100),
    currency: clean(input.currency ?? input.CurrencyCode, 3).toUpperCase(),
  };
}

export function createInvestmentStore({ dataDir = process.env.DATA_DIR || '/data' } = {}) {
  const storeFile = path.join(dataDir, 'investment.json');
  let writeQueue = Promise.resolve();

  async function load() {
    try {
      const parsed = JSON.parse(await fs.readFile(storeFile, 'utf8'));
      return {
        ...emptyStore(),
        ...parsed,
        version: 2,
        settings: normalizeSettings(parsed.settings || {}),
        mandate: normalizeMandate(parsed.mandate || {}),
        watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist : [],
        orderDrafts: Array.isArray(parsed.orderDrafts) ? parsed.orderDrafts : [],
        analyses: Array.isArray(parsed.analyses) ? parsed.analyses : [],
        opportunityScans: Array.isArray(parsed.opportunityScans) ? parsed.opportunityScans : [],
        journal: Array.isArray(parsed.journal) ? parsed.journal : [],
        audit: Array.isArray(parsed.audit) ? parsed.audit : [],
      };
    } catch {
      return emptyStore();
    }
  }

  async function save(data) {
    await fs.mkdir(dataDir, { recursive: true });
    const temporary = `${storeFile}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(temporary, storeFile);
  }

  async function mutate(fn) {
    let result;
    const job = writeQueue.catch(() => {}).then(async () => {
      const data = await load();
      result = await fn(data);
      data.audit = data.audit.slice(-1000);
      data.orderDrafts = data.orderDrafts.slice(-500);
      data.analyses = data.analyses.slice(-300);
      data.opportunityScans = data.opportunityScans.slice(-100);
      data.journal = data.journal.slice(-1000);
      await save(data);
    });
    writeQueue = job.catch(() => {});
    await job;
    return clone(result);
  }

  const audit = (data, action, detail = '') => data.audit.push({
    id: crypto.randomUUID(), action: clean(action, 100), detail: clean(detail, 500), createdAt: new Date().toISOString(),
  });

  async function summary() {
    const data = await load();
    return {
      settings: clone(data.settings),
      watchlistCount: data.watchlist.length,
      draftCount: data.orderDrafts.filter(item => !['archived'].includes(item.status)).length,
      precheckedCount: data.orderDrafts.filter(item => item.status === 'prechecked').length,
      analysisCount: data.analyses.length,
      lastOpportunityScanAt: data.opportunityScans.at(-1)?.scannedAt || null,
      openJournalCount: data.journal.filter(item => item.status === 'open').length,
      reviewedJournalCount: data.journal.filter(item => item.status === 'reviewed').length,
      mandate: clone(data.mandate),
      lastActivityAt: data.audit.at(-1)?.createdAt || null,
    };
  }

  async function getSettings() {
    return clone((await load()).settings);
  }

  async function updateSettings(patch = {}) {
    return mutate(data => {
      data.settings = normalizeSettings(patch, data.settings);
      audit(data, 'settings.updated', 'Anlagestrategie und Risikogrenzen aktualisiert.');
      return data.settings;
    });
  }

  async function getMandate() {
    return clone((await load()).mandate);
  }

  async function updateMandate(patch = {}) {
    return mutate(data => {
      data.mandate = normalizeMandate(patch, data.mandate);
      audit(data, 'mandate.updated', `Monatsbudget ${data.mandate.monthlyAmount} ${data.mandate.currency}; Stufe ${data.mandate.autonomyStage}.`);
      return data.mandate;
    });
  }

  async function listWatchlist() {
    return clone((await load()).watchlist.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));
  }

  async function addWatchlist(input = {}) {
    return mutate(data => {
      const instrument = normalizeInstrument(input);
      const key = `${instrument.assetType}:${instrument.uic}`;
      const existing = data.watchlist.find(item => item.key === key);
      const now = new Date().toISOString();
      const item = {
        ...(existing || {}), ...instrument, key,
        thesis: clean(input.thesis ?? existing?.thesis, 5000),
        targetPrice: positive(input.targetPrice, existing?.targetPrice || 0) || null,
        alertBelow: positive(input.alertBelow, existing?.alertBelow || 0) || null,
        alertAbove: positive(input.alertAbove, existing?.alertAbove || 0) || null,
        tags: unique(input.tags ?? existing?.tags, 12),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      if (existing) Object.assign(existing, item);
      else data.watchlist.push(item);
      audit(data, existing ? 'watchlist.updated' : 'watchlist.added', `${instrument.assetType}:${instrument.uic}`);
      return item;
    });
  }

  async function removeWatchlist(key = '') {
    return mutate(data => {
      const index = data.watchlist.findIndex(item => item.key === clean(key, 200));
      if (index < 0) return null;
      const [removed] = data.watchlist.splice(index, 1);
      audit(data, 'watchlist.removed', removed.key);
      return removed;
    });
  }

  async function listOrderDrafts({ status = '' } = {}) {
    const data = await load();
    return clone(data.orderDrafts
      .filter(item => !status || item.status === status)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));
  }

  async function getOrderDraft(id) {
    const item = (await load()).orderDrafts.find(draft => draft.id === id);
    return item ? clone(item) : null;
  }

  function draftInput(input = {}, existing = {}) {
    const instrument = normalizeInstrument({ ...existing.instrument, ...(input.instrument || {}) });
    const direction = DIRECTIONS.has(input.direction) ? input.direction : existing.direction || 'Buy';
    const orderType = ORDER_TYPES.has(input.orderType) ? input.orderType : existing.orderType || 'Market';
    const durationType = DURATION_TYPES.has(input.durationType) ? input.durationType : existing.durationType || 'DayOrder';
    const amount = positive(input.amount, existing.amount);
    const orderPrice = orderType === 'Limit' ? positive(input.orderPrice, existing.orderPrice) : null;
    const thesis = clean(input.thesis ?? existing.thesis, 8000);
    if (!amount) throw new Error('Ordermenge muss groesser als null sein.');
    if (orderType === 'Limit' && !orderPrice) throw new Error('Fuer eine Limitorder fehlt der Limitpreis.');
    if (thesis.length < 10) throw new Error('Bitte die Investmentthese nachvollziehbar festhalten.');
    return {
      ...existing,
      instrument,
      accountKey: clean(input.accountKey ?? existing.accountKey, 200),
      accountId: clean(input.accountId ?? existing.accountId, 120),
      direction,
      amount,
      orderType,
      orderPrice,
      durationType,
      thesis,
      invalidation: clean(input.invalidation ?? existing.invalidation, 4000),
      horizon: clean(input.horizon ?? existing.horizon, 300),
      notes: clean(input.notes ?? existing.notes, 5000),
      status: DRAFT_STATUSES.has(input.status) ? input.status : existing.status || 'draft',
    };
  }

  async function createOrderDraft(input = {}) {
    return mutate(data => {
      const now = new Date().toISOString();
      const item = {
        ...draftInput(input),
        id: crypto.randomUUID(),
        externalReference: `IVA-${Date.now().toString(36).toUpperCase()}`.slice(0, 50),
        status: 'draft',
        precheck: null,
        createdAt: now,
        updatedAt: now,
      };
      data.orderDrafts.push(item);
      audit(data, 'order-draft.created', `${item.direction} ${item.amount} ${item.instrument.symbol || item.instrument.uic}`);
      return item;
    });
  }

  async function updateOrderDraft(id, patch = {}) {
    return mutate(data => {
      const index = data.orderDrafts.findIndex(item => item.id === id);
      if (index < 0) return null;
      const current = data.orderDrafts[index];
      const item = { ...draftInput(patch, current), id: current.id, externalReference: current.externalReference, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
      const materialChange = ['instrument', 'accountKey', 'direction', 'amount', 'orderType', 'orderPrice', 'durationType'].some(key => patch[key] !== undefined);
      if (materialChange) { item.status = 'draft'; item.precheck = null; }
      data.orderDrafts[index] = item;
      audit(data, 'order-draft.updated', item.id);
      return item;
    });
  }

  async function savePrecheck(id, result) {
    return mutate(data => {
      const item = data.orderDrafts.find(draft => draft.id === id);
      if (!item) return null;
      const ok = String(result?.PreCheckResult || '').toLowerCase() === 'ok';
      item.precheck = { ...clone(result), checkedAt: new Date().toISOString() };
      item.status = ok ? 'prechecked' : 'blocked';
      item.updatedAt = new Date().toISOString();
      audit(data, ok ? 'order-draft.prechecked' : 'order-draft.blocked', item.id);
      return item;
    });
  }

  async function listAudit({ limit = 100 } = {}) {
    const data = await load();
    return clone(data.audit.slice(-Math.max(1, Math.min(500, Number(limit) || 100))).reverse());
  }

  function compactResearch(input = null) {
    if (!input || typeof input !== 'object') return null;
    return {
      kind: clean(input.kind, 80),
      query: clean(input.query, 3000),
      answerBrief: clean(input.answerBrief, 1200),
      overallConfidence: clean(input.overallConfidence, 30) || 'unknown',
      unverifiedNotice: clean(input.unverifiedNotice, 500),
      fetchedAt: input.fetchedAt || null,
      gaps: unique(input.gaps, 15).map(value => clean(value, 500)),
      claims: (Array.isArray(input.claims) ? input.claims : []).slice(0, 30).map(claim => ({
        statement: clean(claim?.statement, 1800),
        confidence: clean(claim?.confidence, 30),
        verified: claim?.verified === true,
        verificationReason: clean(claim?.verificationReason, 600),
        recencyNote: clean(claim?.recencyNote, 500),
        disagreements: (Array.isArray(claim?.disagreements) ? claim.disagreements : []).slice(0, 8).map(item => ({ statement: clean(item?.statement, 600) })),
        sources: (Array.isArray(claim?.sources) ? claim.sources : []).slice(0, 10).map(source => ({
          url: clean(source?.url, 1500), title: clean(source?.title, 500), tier: Number(source?.tier) || null,
          sourceKind: clean(source?.sourceKind, 80), publishedAt: source?.publishedAt || null,
          quotedSpan: clean(source?.quotedSpan, 800),
        })),
      })),
    };
  }

  async function saveAnalysis(input = {}) {
    return mutate(data => {
      const now = new Date().toISOString();
      const item = {
        id: crypto.randomUUID(),
        mode: input.mode === 'market-and-sources' ? 'market-and-sources' : 'market-only',
        instrument: normalizeInstrument(input.instrument || {}),
        fetchedAt: input.fetchedAt || now,
        market: clone(input.market || {}),
        portfolioContext: clone(input.portfolioContext || {}),
        sourceResearch: compactResearch(input.sourceResearch),
        evidenceAudit: clone(input.evidenceAudit || null),
        decisionGate: clone(input.decisionGate || {}),
        playbookVersion: clean(input.playbook?.version, 120),
        caveat: clean(input.caveat, 1000),
        createdAt: now,
      };
      data.analyses.push(item);
      audit(data, 'analysis.saved', `${item.mode} ${item.instrument.assetType}:${item.instrument.uic}`);
      return item;
    });
  }

  async function listAnalyses({ limit = 50, key = '' } = {}) {
    const data = await load();
    return clone(data.analyses
      .filter(item => !key || `${item.instrument?.assetType}:${item.instrument?.uic}` === key)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, Math.max(1, Math.min(300, Number(limit) || 50))));
  }

  async function getAnalysis(id) {
    const item = (await load()).analyses.find(analysis => analysis.id === id);
    return item ? clone(item) : null;
  }

  async function createJournalEntry(input = {}) {
    return mutate(data => {
      const instrument = normalizeInstrument(input.instrument || {});
      const thesis = clean(input.thesis, 8000);
      const counterThesis = clean(input.counterThesis, 5000);
      const invalidation = clean(input.invalidation, 5000);
      const referencePrice = positive(input.referencePrice);
      const probability = Number(input.probabilityPositiveReturnPct);
      if (thesis.length < 20) throw new Error('Bitte eine nachvollziehbare These mit mindestens 20 Zeichen festhalten.');
      if (counterThesis.length < 10) throw new Error('Bitte die staerkste Gegenhypothese festhalten.');
      if (invalidation.length < 10) throw new Error('Bitte ein konkretes Widerlegungskriterium festhalten.');
      if (!referencePrice) throw new Error('Gueltiger Referenzkurs fehlt.');
      if (!Number.isFinite(probability) || probability < 5 || probability > 95) throw new Error('Die Wahrscheinlichkeit muss zwischen 5 und 95 Prozent liegen.');
      const now = new Date().toISOString();
      const item = {
        id: crypto.randomUUID(), analysisId: clean(input.analysisId, 100), instrument,
        thesis, counterThesis, invalidation,
        referencePrice, probabilityPositiveReturnPct: probability,
        expectedReturnPct: Number.isFinite(Number(input.expectedReturnPct)) ? Number(input.expectedReturnPct) : null,
        horizonDays: Math.max(1, Math.min(3650, Math.round(positive(input.horizonDays, 30)))),
        risks: unique(input.risks, 20), notes: clean(input.notes, 5000),
        status: 'open', openedAt: now, reviewDueAt: new Date(Date.now() + Math.max(1, Math.min(3650, Math.round(positive(input.horizonDays, 30)))) * 86_400_000).toISOString(),
        review: null, updatedAt: now,
      };
      data.journal.push(item);
      audit(data, 'journal.created', `${instrument.assetType}:${instrument.uic}; P(positiv) ${probability} %.`);
      return item;
    });
  }

  async function reviewJournalEntry(id, input = {}) {
    return mutate(data => {
      const item = data.journal.find(entry => entry.id === id);
      if (!item) return null;
      const actualPrice = positive(input.actualPrice);
      if (!actualPrice) throw new Error('Gueltiger Schlusskurs fuer den Review fehlt.');
      const actualReturnPct = ((actualPrice / item.referencePrice) - 1) * 100;
      const actualPositive = actualReturnPct > 0 ? 1 : 0;
      const probability = item.probabilityPositiveReturnPct / 100;
      const brierScore = ((probability - actualPositive) ** 2);
      item.review = {
        actualPrice,
        actualReturnPct: Number(actualReturnPct.toFixed(2)),
        actualPositive: actualPositive === 1,
        brierScore: Number(brierScore.toFixed(4)),
        calibrationScore: Number(((1 - brierScore) * 100).toFixed(2)),
        thesisHeld: input.thesisHeld === true,
        notes: clean(input.notes, 5000),
        reviewedAt: new Date().toISOString(),
      };
      item.status = 'reviewed';
      item.updatedAt = item.review.reviewedAt;
      audit(data, 'journal.reviewed', `${item.instrument.assetType}:${item.instrument.uic}; Brier ${item.review.brierScore}.`);
      return item;
    });
  }

  async function listJournal({ status = '', limit = 100 } = {}) {
    const data = await load();
    return clone(data.journal.filter(item => !status || item.status === status)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, Math.max(1, Math.min(500, Number(limit) || 100))));
  }

  async function calibrationSummary() {
    const reviewed = (await load()).journal.filter(item => item.status === 'reviewed' && Number.isFinite(Number(item.review?.brierScore)));
    const averageBrier = reviewed.length ? reviewed.reduce((sum, item) => sum + Number(item.review.brierScore), 0) / reviewed.length : null;
    const hitRate = reviewed.length ? reviewed.filter(item => item.review.actualPositive === (item.probabilityPositiveReturnPct >= 50)).length / reviewed.length : null;
    return {
      reviewedCount: reviewed.length,
      averageBrierScore: averageBrier === null ? null : Number(averageBrier.toFixed(4)),
      calibrationScore: averageBrier === null ? null : Number(((1 - averageBrier) * 100).toFixed(2)),
      directionalHitRatePct: hitRate === null ? null : Number((hitRate * 100).toFixed(2)),
      methodology: 'Brier-Score fuer das vorab definierte Ereignis: Kurs am Review-Ende ueber dem Referenzkurs. 0 ist perfekt, 1 maximal schlecht. Die Stichprobengroesse bleibt sichtbar.',
    };
  }

  async function saveOpportunityScan(input = {}, trigger = 'manual') {
    return mutate(data => {
      const item = {
        id: crypto.randomUUID(),
        trigger: clean(trigger, 50) || 'manual',
        scannedAt: input.scannedAt || new Date().toISOString(),
        universe: clean(input.universe, 200),
        cadence: clean(input.cadence, 30),
        candidateCount: Number(input.candidateCount) || 0,
        candidates: clone(Array.isArray(input.candidates) ? input.candidates.slice(0, 30) : []),
        nextAction: clean(input.nextAction, 1000),
        caveat: clean(input.caveat, 1000),
      };
      data.opportunityScans.push(item);
      audit(data, 'opportunities.scanned', `${item.trigger}; ${item.candidateCount} Kandidaten.`);
      return item;
    });
  }

  async function latestOpportunityScan() {
    const item = (await load()).opportunityScans.at(-1);
    return item ? clone(item) : null;
  }

  return {
    summary, getSettings, updateSettings, getMandate, updateMandate,
    listWatchlist, addWatchlist, removeWatchlist,
    listOrderDrafts, getOrderDraft, createOrderDraft, updateOrderDraft, savePrecheck,
    saveAnalysis, listAnalyses, getAnalysis,
    saveOpportunityScan, latestOpportunityScan,
    createJournalEntry, reviewJournalEntry, listJournal, calibrationSummary,
    listAudit,
  };
}

export { DEFAULT_SETTINGS, DEFAULT_MANDATE };
