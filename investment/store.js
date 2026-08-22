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

const RISK_LEVELS = new Set(['conservative', 'balanced', 'growth', 'aggressive']);
const ASSET_TYPES = new Set(['Stock', 'Etf', 'MutualFund', 'Bond']);
const DIRECTIONS = new Set(['Buy', 'Sell']);
const ORDER_TYPES = new Set(['Market', 'Limit']);
const DURATION_TYPES = new Set(['DayOrder', 'GoodTillCancel']);
const DRAFT_STATUSES = new Set(['draft', 'prechecked', 'blocked', 'archived']);
const clean = (value, max = 2000) => String(value ?? '').trim().slice(0, max);
const clone = value => JSON.parse(JSON.stringify(value));
const pct = (value, fallback) => Math.max(0, Math.min(100, Number.isFinite(Number(value)) ? Number(value) : fallback));
const positive = (value, fallback = 0) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const unique = (values, max = 20) => [...new Set((Array.isArray(values) ? values : []).map(value => clean(value, 80)).filter(Boolean))].slice(0, max);

function emptyStore() {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, watchlist: [], orderDrafts: [], audit: [] };
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
        settings: normalizeSettings(parsed.settings || {}),
        watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist : [],
        orderDrafts: Array.isArray(parsed.orderDrafts) ? parsed.orderDrafts : [],
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

  return {
    summary, getSettings, updateSettings,
    listWatchlist, addWatchlist, removeWatchlist,
    listOrderDrafts, getOrderDraft, createOrderDraft, updateOrderDraft, savePrecheck,
    listAudit,
  };
}

export { DEFAULT_SETTINGS };
