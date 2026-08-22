import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-investment-'));
const env = {
  SAXO_ENVIRONMENT: 'sim',
  SAXO_APP_KEY: 'sim-app-key',
  SAXO_APP_SECRET: 'sim-app-secret',
  SAXO_REDIRECT_URI: 'https://iva.example.test/oauth/saxo/callback',
  SAXO_TOKEN_KEY: 'test-encryption-key-with-at-least-32-characters',
  SAXO_TRADING_ENABLED: 'true',
};
const calls = [];
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const chartSamples = (count, horizonMinutes) => Array.from({ length: count }, (_, index) => {
  const base = 100 + index * 0.18 + Math.sin(index / 8) * 2;
  const close = index === count - 1 ? base + 4 : base;
  return {
    Time: new Date(Date.now() - (count - 1 - index) * horizonMinutes * 60_000).toISOString(),
    Open: base - 0.3, High: close + 1, Low: base - 1, Close: close, Volume: 1000 + index * 3,
  };
});
const fetchImpl = async (input, options = {}) => {
  const url = new URL(String(input));
  calls.push({ url: url.toString(), method: options.method || 'GET', body: options.body });
  if (url.href === 'https://sim.logonvalidation.net/token') {
    const body = new URLSearchParams(String(options.body || ''));
    assert.equal(body.get('grant_type'), 'authorization_code');
    return json({ access_token: 'plain-access-token', refresh_token: 'plain-refresh-token', expires_in: 1200, refresh_token_expires_in: 2400, token_type: 'Bearer' });
  }
  if (url.pathname.endsWith('/port/v1/users/me')) return json({ Active: true, Name: 'Nadine Test', ClientKey: 'client-key', LegalAssetTypes: ['Stock', 'Etf'], MarketDataViaOpenApiTermsAccepted: true });
  if (url.pathname.endsWith('/port/v1/clients/me')) return json({ Name: 'Nadine Test', ClientKey: 'client-key', DefaultAccountKey: 'account-key', DefaultAccountId: 'EUR-1', DefaultCurrency: 'EUR', IsMarginTradingAllowed: false });
  if (url.pathname.endsWith('/port/v1/balances/me')) return json({ CalculationReliability: 'Ok', TotalValue: 100000, CashBalance: 10000, CashAvailableForTrading: 10000, MarginUtilizationPct: 0 });
  if (url.pathname.endsWith('/port/v1/netpositions/me')) return json({ Data: [
    { NetPositionId: '101_Stock', DisplayAndFormat: { Description: 'Beispiel AG', Symbol: 'BSP', Currency: 'EUR' }, NetPositionBase: { Uic: 101, AssetType: 'Stock', Amount: 100, OpeningDirection: 'Buy', AccountId: 'EUR-1' }, NetPositionView: { ExposureInBaseCurrency: 20000, CurrentPrice: 200, AverageOpenPrice: 180, ProfitLossOnTrade: 2000, PositionCount: 1 } },
  ] });
  if (url.pathname.endsWith('/port/v1/orders/me')) return json({ Data: [] });
  if (url.pathname.endsWith('/port/v1/accounts')) return json({ Data: [{ AccountKey: 'account-key', AccountId: 'EUR-1', Currency: 'EUR', AccountType: 'Normal', Active: true }] });
  if (url.pathname.endsWith('/hist/v4/performance/timeseries')) return json({ Balance: { AccountValue: [{ Date: '2026-01-02', Value: 95000 }, { Date: '2026-08-22', Value: 100000 }] } });
  if (url.pathname.endsWith('/ref/v1/instruments')) return json({ Data: [{ Identifier: 101, AssetType: 'Stock', Symbol: 'BSP', Description: 'Beispiel AG', ExchangeId: 'XETR', CurrencyCode: 'EUR', TradableAs: ['Stock'] }] });
  if (url.pathname.endsWith('/ref/v1/instruments/details/101/Stock')) return json({ Uic: 101, AssetType: 'Stock', Symbol: 'BSP', Description: 'Beispiel AG', CurrencyCode: 'EUR', Exchange: { ExchangeId: 'XETR', Name: 'Xetra', CountryCode: 'DE' }, IsTradable: true, TradingStatus: 'Tradable', MinimumTradeSize: 1, TickSize: 0.01, SupportedOrderTypes: ['Market', 'Limit'] });
  if (url.pathname.endsWith('/chart/v3/charts')) {
    const horizon = Number(url.searchParams.get('Horizon'));
    const count = horizon === 10080 ? 260 : 320;
    return json({ ChartInfo: { DelayedByMinutes: 0, ExchangeId: 'XETR', Horizon: horizon }, Data: chartSamples(count, horizon), DisplayAndFormat: { Symbol: 'BSP', Description: 'Beispiel AG', Currency: 'EUR', Decimals: 2 } });
  }
  if (url.pathname.endsWith('/trade/v2/orders/precheck')) {
    const body = JSON.parse(options.body);
    assert.equal(body.AccountKey, 'account-key');
    assert.equal(body.ManualOrder, true);
    return json({ PreCheckResult: 'Ok', EstimatedCashRequired: 2000, EstimatedTotalCostInAccountCurrency: 2000, Cost: { Commission: 5 } });
  }
  return json({ error: `Unerwarteter Aufruf ${url}` }, 500);
};

const { createSaxoClient } = await import('../investment/saxo.js');
const { createInvestmentStore } = await import('../investment/store.js');
const { analyzePortfolio } = await import('../investment/risk.js');
const { createInvestmentModule } = await import('../investment/index.js');

const unconfigured = createSaxoClient({ dataDir, env: {}, fetchImpl });
assert.equal((await unconfigured.status()).configured, false);
assert.ok((await unconfigured.status()).missing.includes('SAXO_APP_KEY'));

const saxo = createSaxoClient({ dataDir, env, fetchImpl });
const authUrl = new URL(saxo.createAuthUrl());
assert.equal(authUrl.origin, 'https://sim.logonvalidation.net');
assert.equal(authUrl.searchParams.get('client_id'), 'sim-app-key');
assert.equal(authUrl.searchParams.get('redirect_uri'), env.SAXO_REDIRECT_URI);
assert.ok(authUrl.searchParams.get('state'));
await saxo.completeOAuth({ code: 'one-time-code', state: authUrl.searchParams.get('state') });

const encrypted = await fs.readFile(path.join(dataDir, 'saxo-sim-oauth.enc.json'), 'utf8');
assert.equal(encrypted.includes('plain-access-token'), false);
assert.equal(encrypted.includes('plain-refresh-token'), false);
assert.equal((await saxo.status()).authorized, true);
assert.equal((await saxo.status()).saxoAppTradingPermission, true);
assert.equal((await saxo.status()).orderExecutionEnabled, false);
assert.equal((await saxo.status({ probe: true })).reachable, true);

const rawPortfolio = await saxo.portfolio();
assert.equal(rawPortfolio.accounts[0].accountId, 'EUR-1');
assert.equal(rawPortfolio.netPositions.length, 1);
assert.equal(rawPortfolio.performance.Balance.AccountValue.length, 2);
assert.equal((await saxo.searchInstruments({ query: 'Beispiel' }))[0].uic, 101);
assert.equal((await saxo.instrumentDetails({ uic: 101, assetType: 'Stock' })).Exchange.ExchangeId, 'XETR');
assert.equal((await saxo.chart({ uic: 101, assetType: 'Stock', horizon: 1440, count: 320 })).Data.length, 320);

const store = createInvestmentStore({ dataDir });
const settings = await store.updateSettings({ maxPositionPct: 15, minCashPct: 5, maxOrderValuePct: 10 });
assert.equal(settings.allowMargin, false);
const watch = await store.addWatchlist({ uic: 101, assetType: 'Stock', symbol: 'BSP', description: 'Beispiel AG', exchangeId: 'XETR', currency: 'EUR', thesis: 'Langfristiger Testwert' });
assert.equal((await store.listWatchlist()).length, 1);
assert.equal(watch.key, 'Stock:101');

const draft = await store.createOrderDraft({ instrument: watch, accountKey: 'account-key', accountId: 'EUR-1', direction: 'Buy', amount: 10, orderType: 'Market', durationType: 'DayOrder', thesis: 'Langfristige Beispielthese mit nachvollziehbarem Grund.' });
assert.equal(draft.status, 'draft');
assert.ok(draft.externalReference.startsWith('IVA-'));
await assert.rejects(() => store.createOrderDraft({ instrument: watch, direction: 'Buy', amount: 1, orderType: 'Market', thesis: 'kurz' }), /Investmentthese/);

const risk = analyzePortfolio({ balance: rawPortfolio.balance, positions: rawPortfolio.netPositions, settings });
assert.equal(risk.status, 'yellow');
assert.equal(risk.positions[0].weightPct, 20);
assert.ok(risk.warnings.some(item => item.code === 'position-concentration'));

const investment = createInvestmentModule({ dataDir, env, fetchImpl });
const snapshot = await investment.portfolio();
assert.equal(snapshot.balance.totalValue, 100000);
assert.equal(snapshot.performance.series.length, 2);
await investment.updateSettings({ maxPositionPct: 25 });
const checked = await investment.precheckOrderDraft(draft.id);
assert.equal(checked.status, 'prechecked');
assert.equal(checked.precheck.SaxoPreCheckResult, 'Ok');
assert.equal(checked.precheck.IvaChecks.estimatedOrderPct, 2);

const oversizedSale = await investment.createOrderDraft({ instrument: watch, accountKey: 'account-key', accountId: 'EUR-1', direction: 'Sell', amount: 101, orderType: 'Market', thesis: 'Verkaufsentwurf testet den Schutz vor einer ungeplanten Short-Position.' });
const precheckCallsBeforeShortGuard = calls.filter(call => call.url.includes('/trade/v2/orders/precheck')).length;
const blockedShort = await investment.precheckOrderDraft(oversizedSale.id);
assert.equal(blockedShort.status, 'blocked');
assert.equal(blockedShort.precheck.SaxoPreCheckResult, 'NotRun');
assert.match(blockedShort.precheck.IvaChecks.blocks[0], /Shorting ist nicht freigegeben/);
assert.equal(calls.filter(call => call.url.includes('/trade/v2/orders/precheck')).length, precheckCallsBeforeShortGuard);

await investment.updateSettings({ maxOrderValuePct: 1 });
const blockedDraft = await investment.createOrderDraft({ instrument: watch, accountKey: 'account-key', accountId: 'EUR-1', direction: 'Buy', amount: 10, orderType: 'Market', thesis: 'Zweite nachvollziehbare Beispielthese fuer den Grenztest.' });
const blocked = await investment.precheckOrderDraft(blockedDraft.id);
assert.equal(blocked.status, 'blocked');
assert.equal(blocked.precheck.PreCheckResult, 'IvaRiskLimit');

const knowledge = investment.getInvestmentKnowledge();
assert.ok(knowledge.lensCount >= 10);
assert.ok(knowledge.deterministicAnalytics.includes('RSI 14'));
const analysis = await investment.analyzeInstrument({ instrument: watch });
assert.equal(analysis.instrument.uic, 101);
assert.equal(analysis.market.technical.sampleCount, 320);
assert.equal(analysis.market.weeklyTechnical.sampleCount, 260);
assert.ok(analysis.market.technical.metrics.sma200 > 0);
assert.ok(Array.isArray(analysis.market.technical.patterns));
assert.equal(analysis.market.timeframeAgreement.status, 'aligned');
assert.equal((await investment.listAnalyses({ limit: 10 })).length, 1);

const mandate = await investment.updateMandate({ monthlyAmount: 750, autonomyStage: 'propose', maxMonthlyLossPct: 4, maxDrawdownPct: 12, analysisCadence: 'weekdays' });
assert.equal(mandate.monthlyAmount, 750);
assert.equal(mandate.autonomyStage, 'propose');
await assert.rejects(() => investment.updateMandate({ autonomyStage: 'live-auto' }), /LIVE-Autonomie/);
const readiness = await investment.autonomyReadiness();
assert.equal(readiness.eligibleForLiveReview, false);
assert.equal(readiness.liveOrderExecutionEnabled, false);
assert.ok(readiness.blockers.some(item => item.includes('Journalentscheidungen')));

const journal = await investment.createJournalEntry({
  instrument: watch,
  analysisId: analysis.id,
  thesis: 'Der Testwert zeigt einen stabilen, mehrperiodigen Aufwaertstrend mit positiver Marktstruktur.',
  counterThesis: 'Das Momentum kann ohne fundamentale Bestaetigung abrupt drehen.',
  invalidation: 'Schlusskurs faellt am Review-Ende unter den dokumentierten Referenzkurs.',
  referencePrice: analysis.market.technical.metrics.latestPrice,
  probabilityPositiveReturnPct: 60,
  expectedReturnPct: 5,
  horizonDays: 30,
});
assert.equal(journal.status, 'open');
const reviewed = await investment.reviewJournalEntry(journal.id, { actualPrice: journal.referencePrice * 1.05, thesisHeld: true, notes: 'Testreview' });
assert.equal(reviewed.status, 'reviewed');
assert.equal(reviewed.review.actualPositive, true);
assert.equal(reviewed.review.brierScore, 0.16);
assert.equal((await investment.calibrationSummary()).reviewedCount, 1);

const opportunities = await investment.screenOpportunities({ limit: 5 });
assert.equal(opportunities.candidateCount, 1);
assert.equal(opportunities.candidates[0].instrument.uic, 101);
assert.ok(opportunities.candidates[0].researchPriority.components.length > 3);
assert.equal((await investment.latestOpportunityScan()).trigger, 'manual');

const html = await fs.readFile(new URL('../public/investment.html', import.meta.url), 'utf8');
const browserJs = await fs.readFile(new URL('../public/investment.js', import.meta.url), 'utf8');
const serverSource = await fs.readFile(new URL('../investment/index.js', import.meta.url), 'utf8');
assert.match(html, /Charts lesen/);
assert.match(html, /Analyse-Labor/);
assert.match(html, /Chancen & Mandat/);
assert.match(html, /Lernjournal/);
assert.match(html, /LIVE-Orderversand bleibt bis zur Bewährung gesperrt/);
assert.match(html, /iva-face/);
assert.match(browserJs, /Saxo-Precheck/);
assert.match(browserJs, /Analysiert Charts/);
assert.match(browserJs, /QUELLENRESEARCH STARTEN/);
assert.doesNotMatch(serverSource, /trade\/v2\/orders[^/]*['"],\s*\{\s*method:\s*['"]POST/i, 'Es darf keinen Saxo-Orderausfuehrungsweg geben.');
assert.ok(calls.some(call => call.url.includes('/trade/v2/orders/precheck')));

console.log('IVA Investment Intelligence, Saxo, Chancenmonitor, Mandat und Lernjournal: OK');
