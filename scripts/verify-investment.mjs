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
};
const calls = [];
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
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
assert.equal((await saxo.status({ probe: true })).reachable, true);

const rawPortfolio = await saxo.portfolio();
assert.equal(rawPortfolio.accounts[0].accountId, 'EUR-1');
assert.equal(rawPortfolio.netPositions.length, 1);
assert.equal(rawPortfolio.performance.Balance.AccountValue.length, 2);
assert.equal((await saxo.searchInstruments({ query: 'Beispiel' }))[0].uic, 101);

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

const html = await fs.readFile(new URL('../public/investment.html', import.meta.url), 'utf8');
const browserJs = await fs.readFile(new URL('../public/investment.js', import.meta.url), 'utf8');
const serverSource = await fs.readFile(new URL('../investment/index.js', import.meta.url), 'utf8');
assert.match(html, /Portfolio verstehen/);
assert.match(html, /Orderausführung bleibt technisch gesperrt/);
assert.match(html, /iva-face/);
assert.match(browserJs, /Saxo-Precheck/);
assert.doesNotMatch(serverSource, /trade\/v2\/orders[^/]*['"],\s*\{\s*method:\s*['"]POST/i, 'Es darf keinen Saxo-Orderausfuehrungsweg geben.');
assert.ok(calls.some(call => call.url.includes('/trade/v2/orders/precheck')));

console.log('IVA Investment-Agent und Saxo-Grundlage: OK');
