import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createInvestmentMonitor, assessInvestmentQuote } from '../investment/monitor.js';
import { createSaxoClient } from '../investment/saxo.js';

const instrument = { key: 'Stock:101', uic: 101, assetType: 'Stock', symbol: 'EXAMPLE', currency: 'EUR' };
const config = { enabled: true, mode: 'paper', currency: 'EUR', monthlyDepositLimit: 1000, capitalLimit: 2000, maxOrderValue: 500, maxPositionValue: 1000, maxDailyLoss: 100, maxDrawdownPct: 20, feePerOrder: 1, slippageBps: 10 };
const rule = (patch = {}) => ({ key: instrument.key, action: 'paper-buy', condition: 'at-or-below', price: 101, amount: 2, enabled: true, ...patch });
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'iva-investment-monitor-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let timestamp = Date.UTC(2026, 8, 14, 12);
  const source = { calls: 0, failure: null, ready: true, pending: null, entered: null, rows: null };
  const quote = patch => ({ key: 'Stock:101', uic: 101, assetType: 'Stock', symbol: 'EXAMPLE', currency: 'EUR', bid: 99, ask: 100, mid: 99.5, updatedAt: new Date(timestamp).toISOString(), receivedAt: new Date(timestamp).toISOString(), delayedByMinutes: 0, marketOpen: true, priceTypeBid: 'Tradable', priceTypeAsk: 'Tradable', errorCode: 'None', source: 'Saxo OpenAPI InfoPrices', environment: 'sim', ...patch });
  const saxo = { status: async () => ({ ready: source.ready, environment: 'sim' }), quotes: async () => { source.calls++; source.entered?.resolve(); if (source.pending) await source.pending; if (source.failure) throw source.failure; return source.rows || [quote()]; } };
  const options = { dataDir, saxo, store: { listWatchlist: async () => [instrument] }, now: () => timestamp, autoStart: false };
  const monitor = createInvestmentMonitor(options);
  t.after(() => monitor.close());
  return { monitor, source, quote, dataDir, options, advance: milliseconds => { timestamp += milliseconds; } };
}
async function enable(f, rules = [rule()], patch = {}) { return f.monitor.configure({ baseRevision: (await f.monitor.status()).revision, config: { ...config, ...patch }, rules }); }

test('new monitor is disabled with no invented funding or risk mandate and performs no Saxo call', async t => {
  const f = await fixture(t), state = await f.monitor.poll({ manual: true });
  assert.equal(state.config.enabled, false);
  for (const key of ['monthlyDepositLimit', 'capitalLimit', 'maxOrderValue', 'maxPositionValue', 'maxDailyLoss', 'maxDrawdownPct', 'feePerOrder', 'slippageBps']) assert.equal(state.config[key], null);
  assert.equal(f.source.calls, 0);
  assert.equal(state.liveOrderExecutionEnabled, false);
  assert.equal(state.depositsEnabled, false);
  await assert.rejects(f.monitor.configure({ baseRevision: 0, config: { enabled: true, mode: 'paper' } }), /alle Kapital/);
  await assert.rejects(f.monitor.configure({ baseRevision: 0, config: { mode: 'live' } }), /lokaler Paper/);
});

test('funding limits serialize across concurrent monitor instances and use calendar months', async t => {
  const f = await fixture(t); await enable(f);
  const second = createInvestmentMonitor(f.options); t.after(() => second.close());
  const outcomes = await Promise.allSettled([f.monitor.deposit({ amount: 700 }), second.deposit({ amount: 700 })]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal((await f.monitor.status()).paper.cash, 700);
  await f.monitor.deposit({ amount: 300 });
  await assert.rejects(f.monitor.deposit({ amount: 0.01 }), /Monats- oder Kapitalgrenze/);
  f.advance(32 * 86400000);
  await f.monitor.deposit({ amount: 1000 });
  f.advance(32 * 86400000);
  await assert.rejects(f.monitor.deposit({ amount: 1 }), /Kapitalgrenze/);
  assert.equal((await f.monitor.status()).paper.contributed, 2000);
});

test('paper rule produces one local fill with spread, fees and slippage, never repeated automatically', async t => {
  const f = await fixture(t); await enable(f); await f.monitor.deposit({ amount: 1000 });
  const state = await f.monitor.poll({ manual: true });
  assert.equal(state.paper.orders.length, 1);
  assert.equal(state.paper.orders[0].execution, 'local-paper-only');
  assert.equal(state.paper.orders[0].price, 100.1);
  assert.equal(state.paper.cash, 798.8);
  assert.equal(state.paper.positions[0].amount, 2);
  assert.equal(state.paper.feesPaid, 1);
  await f.monitor.poll({ manual: true });
  assert.equal((await f.monitor.status()).paper.orders.length, 1);
  assert.equal((await stat(path.join(f.dataDir, 'investment-monitor.json'))).mode & 0o777, 0o600);
});

test('missing, delayed, stale, closed-market and invalid prices cannot trigger paper orders', async t => {
  for (const patch of [{ updatedAt: null }, { delayedByMinutes: 15 }, { delayedByMinutes: null }, { updatedAt: '2020-01-01T00:00:00Z' }, { marketOpen: false }, { errorCode: 'NoAccess' }, { bid: 0 }, { ask: 98 }, { priceTypeAsk: 'NoMarket' }]) {
    const f = await fixture(t); await enable(f); await f.monitor.deposit({ amount: 1000 }); f.source.rows = [f.quote(patch)];
    const state = await f.monitor.poll({ manual: true });
    assert.equal(state.paper.orders.length, 0, JSON.stringify(patch));
    assert.equal(state.quotes[0].usable, false);
    assert(state.journal.some(item => item.type === 'rule-blocked'));
  }
});

test('disconnection retains provenance but marks cached quotes unavailable and honors Retry-After', async t => {
  const f = await fixture(t); await enable(f, [], { mode: 'observe' });
  await f.monitor.poll({ manual: true });
  f.source.failure = Object.assign(new Error('token=secret must not leak'), { providerStatus: 429, retryAfterSeconds: 60 });
  const state = await f.monitor.poll({ manual: true });
  assert.equal(state.connection.status, 'disconnected');
  assert.equal(state.quotes[0].usable, false);
  assert(!JSON.stringify(state).includes('secret'));
  const calls = f.source.calls; await f.monitor.poll({ manual: true }); assert.equal(f.source.calls, calls);
  f.advance(61_000); f.source.failure = null;
  assert.equal((await f.monitor.poll({ manual: true })).connection.status, 'connected');
  f.advance(91_000);
  assert.equal((await f.monitor.status()).connection.status, 'stale');
});

test('live-quote evidence cannot override order, cash, position, short-sale or currency restrictions', async t => {
  for (const [candidate, patch, expected] of [
    [rule({ amount: 6 }), {}, /Einzelordergrenze/],
    [rule({ amount: 2 }), { maxPositionValue: 100 }, /Positionsgrenze/],
    [rule({ action: 'paper-sell', amount: 1 }), {}, /Leerverkauf/],
    [rule({ amount: 2 }), { maxDailyLoss: 2 }, /Tagesverlustgrenze/],
    [rule({ amount: 2 }), { maxDrawdownPct: 0.2 }, /Drawdown-Grenze/],
  ]) {
    const f = await fixture(t); await enable(f, [candidate], patch); await f.monitor.deposit({ amount: 1000 });
    const state = await f.monitor.poll({ manual: true });
    assert.equal(state.paper.orders.length, 0);
    assert(state.journal.some(item => expected.test(item.message)));
  }
  const f = await fixture(t); await enable(f); await f.monitor.deposit({ amount: 100 });
  assert((await f.monitor.poll({ manual: true })).journal.some(item => /Guthaben/.test(item.message)));
  f.source.rows = [f.quote({ currency: 'USD' })];
  assert((await f.monitor.poll({ manual: true })).journal.some(item => /Währungsumrechnung/.test(item.message)));
});

test('daily loss and drawdown stop additional paper purchases while preserving configured limits', async t => {
  const f = await fixture(t); await enable(f, [rule({ amount: 4 })]); await f.monitor.deposit({ amount: 1000 }); await f.monitor.poll({ manual: true });
  const first = await f.monitor.status();
  await f.monitor.configure({ baseRevision: first.revision, rules: [...first.rules, rule({ amount: 1 })] });
  f.source.rows = [f.quote({ bid: 70, ask: 71, mid: 70.5 })];
  const state = await f.monitor.poll({ manual: true });
  assert.equal(state.paper.orders.length, 1);
  assert.equal(state.paper.halted, true);
  assert.equal(state.config.maxDailyLoss, 100);
  assert.equal(state.config.maxDrawdownPct, 20);
});

test('configuration changes while quote fetch is pending invalidate the decision cycle', async t => {
  const f = await fixture(t); await enable(f); await f.monitor.deposit({ amount: 1000 });
  const entered = gate(), release = gate(); f.source.entered = entered; f.source.pending = release.promise; t.after(() => release.resolve());
  const pending = f.monitor.poll({ manual: true }); await entered.promise;
  await f.monitor.configure({ baseRevision: 1, config: { maxOrderValue: 100 } });
  release.resolve();
  assert.equal((await pending).paper.orders.length, 0);
  assert.equal((await f.monitor.status()).config.maxOrderValue, 100);
  await assert.rejects(f.monitor.configure({ baseRevision: 1, config: { maxOrderValue: 200 } }), error => error.status === 409);
  await assert.rejects(f.monitor.configure({ baseRevision: 2, config: { maxOrderValue: 200 } }, { actor: 'automatic' }), error => error.status === 403);
});

test('an overnight price gap counts toward the new day loss limit', async t => {
  const f = await fixture(t); await enable(f, [rule({ amount: 4 })]); await f.monitor.deposit({ amount: 1000 }); await f.monitor.poll({ manual: true });
  const first = await f.monitor.status();
  await f.monitor.configure({ baseRevision: first.revision, rules: [...first.rules, rule({ amount: 1 })] });
  f.advance(86400000); f.source.rows = [f.quote({ bid: 70, ask: 71 })];
  const state = await f.monitor.poll({ manual: true });
  assert.equal(state.paper.orders.length, 1);
  assert(state.paper.dailyLoss >= 100);
  assert(state.paper.reasons.some(item => /Tagesverlustgrenze/.test(item)));
});

test('disconnecting pauses paper decisions even while an earlier quote request is pending', async t => {
  const f = await fixture(t); await enable(f); await f.monitor.deposit({ amount: 1000 });
  const entered = gate(), release = gate(); f.source.entered = entered; f.source.pending = release.promise; t.after(() => release.resolve());
  const pending = f.monitor.poll({ manual: true }); await entered.promise;
  await f.monitor.pause(); release.resolve();
  const state = await pending;
  assert.equal(state.config.enabled, false);
  assert.equal(state.connection.status, 'disabled');
  assert.equal(state.paper.orders.length, 0);
});

test('learning appends a review without changing rules, limits or the original error event', async t => {
  const f = await fixture(t); await enable(f); await f.monitor.poll({ manual: true });
  const before = await f.monitor.status(), entry = before.journal.find(item => item.type === 'rule-blocked');
  assert(entry);
  const after = await f.monitor.review(entry.id, { lesson: 'Vor einer Simulation zuerst bewusst virtuelles Kapital zuweisen.' });
  assert.deepEqual(after.config, before.config);
  assert.deepEqual(after.rules, before.rules);
  assert.deepEqual(after.journal.find(item => item.id === entry.id), entry);
  assert.equal(after.learning.reviewed, 1);
  assert(!JSON.stringify(after).includes('token='));
});

test('duplicate existing rule IDs cannot execute twice and corrupt or linked stores fail closed', async t => {
  const f = await fixture(t); const first = await enable(f);
  await assert.rejects(f.monitor.configure({ baseRevision: first.revision, rules: [first.rules[0], first.rules[0]] }), /nicht doppelt/);
  assert.equal((await f.monitor.status()).rules.length, 1);
  const target = path.join(f.dataDir, 'other.json'), file = path.join(f.dataDir, 'investment-monitor.json');
  const original = await readFile(file, 'utf8');
  await writeFile(target, original); await rm(file); await symlink(target, file);
  await assert.rejects(f.monitor.status(), error => error.code === 'ELOOP');
  await assert.rejects(f.monitor.deposit({ amount: 10 }), error => error.code === 'ELOOP');
  assert.equal(await readFile(target, 'utf8'), original);
  await rm(file); await writeFile(file, '{broken');
  await assert.rejects(f.monitor.status(), SyntaxError);
});

test('paper sells realize their simulated result but fees cannot create negative cash', async t => {
  const f = await fixture(t); await enable(f); await f.monitor.deposit({ amount: 1000 }); await f.monitor.poll({ manual: true });
  const first = await f.monitor.status();
  await f.monitor.configure({ baseRevision: first.revision, rules: [...first.rules, rule({ action: 'paper-sell', amount: 2, condition: 'at-or-above', price: 105 })], config: { feePerOrder: 2000 } });
  f.source.rows = [f.quote({ bid: 110, ask: 111 })];
  let state = await f.monitor.poll({ manual: true });
  assert.equal(state.paper.orders.length, 1);
  assert(state.journal.some(item => /Verkaufsgebühr/.test(item.message)));
  await f.monitor.configure({ baseRevision: state.revision, config: { feePerOrder: 1 } });
  state = await f.monitor.poll({ manual: true });
  assert.equal(state.paper.orders.length, 2);
  assert.equal(state.paper.positions.length, 0);
  assert.equal(state.paper.cash, 1017.58);
  assert.equal(state.paper.realizedProfitLoss, 17.58);
  assert.equal(state.paper.netProfitLoss, 17.58);
});

test('an empty watchlist never claims a successful Saxo price connection', async t => {
  const f = await fixture(t); await enable(f, [], { mode: 'observe' });
  const empty = createInvestmentMonitor({ ...f.options, store: { listWatchlist: async () => [] } }); t.after(() => empty.close());
  const state = await empty.poll({ manual: true });
  assert.equal(state.connection.status, 'waiting');
  assert.equal(state.connection.lastSuccessAt, null);
  assert.equal(f.source.calls, 0);
});

test('Saxo client groups read-only InfoPrices, reports entitlement evidence and refuses live writes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iva-saxo-quotes-')); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], env = { SAXO_ENVIRONMENT: 'live', SAXO_APP_KEY: 'key', SAXO_APP_SECRET: 'secret', SAXO_REDIRECT_URI: 'https://iva.example.org/oauth/saxo/callback', SAXO_TOKEN_KEY: 'a-private-encryption-key-at-least-32-characters' };
  const client = createSaxoClient({ dataDir: root, env, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), method: options.method });
    assert.equal(options.redirect, 'error'); assert(options.signal);
    if (String(url).endsWith('/token')) return new Response(JSON.stringify({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 1200, refresh_token_expires_in: 2400 }));
    assert.equal(options.method, 'GET'); assert(String(url).includes('/trade/v1/infoprices/list?'));
    return new Response(JSON.stringify({ Data: [{ Uic: 101, AssetType: 'Stock', LastUpdated: new Date().toISOString(), DisplayAndFormat: { Currency: 'EUR', Symbol: 'EXAMPLE' }, Quote: { Bid: 99, Ask: 100, Mid: 99.5, DelayedByMinutes: 15, ErrorCode: 'None', PriceTypeBid: 'Indicative', PriceTypeAsk: 'Indicative' }, InstrumentPriceDetails: { IsMarketOpen: true } }] }));
  } });
  const state = new URL(client.createAuthUrl()).searchParams.get('state');
  await client.completeOAuth({ code: 'fixture-code', state });
  await assert.rejects(client.completeOAuth({ code: 'replayed', state }), /bereits verwendet/);
  const rows = await client.quotes([instrument]);
  assert.equal(rows[0].environment, 'live'); assert.equal(rows[0].delayedByMinutes, 15);
  assert.equal(assessInvestmentQuote(rows[0], { maxQuoteAgeSeconds: 90 }).usable, false);
  for (const [endpoint, method] of [['trade/v2/orders', 'POST'], ['cash/v1/transfers', 'POST'], ['root/v1/sessions/capabilities', 'PATCH'], ['trade/v2/orders/id', 'DELETE']]) await assert.rejects(client.request(endpoint, { method }), /gesperrt/);
  assert.equal(calls.length, 2);
  assert(!JSON.stringify(await client.status()).includes('private-access'));
  assert(!(await readFile(path.join(root, 'saxo-live-oauth.enc.json'), 'utf8')).includes('private-access'));
});

test('OAuth expiration is never extended and malformed provider responses do not disclose token text', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iva-saxo-expiry-')); t.after(() => rm(root, { recursive: true, force: true }));
  const env = { SAXO_APP_KEY: 'key', SAXO_APP_SECRET: 'secret', SAXO_REDIRECT_URI: 'https://iva.example.org/oauth/saxo/callback', SAXO_TOKEN_KEY: 'a-private-encryption-key-at-least-32-characters' };
  let malformed = false;
  const client = createSaxoClient({ dataDir: root, env, fetchImpl: async () => new Response(malformed ? 'token=DO-NOT-DISCLOSE' : JSON.stringify({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 2, refresh_token_expires_in: 0 })) });
  const state = new URL(client.createAuthUrl()).searchParams.get('state');
  const before = Date.now(), connected = await client.completeOAuth({ code: 'fixture-code', state });
  assert(connected.expiresAt <= Date.now() + 2000);
  assert(connected.refreshExpiresAt >= before && connected.refreshExpiresAt <= Date.now());
  malformed = true;
  const retry = new URL(client.createAuthUrl()).searchParams.get('state');
  await assert.rejects(client.completeOAuth({ code: 'fixture-code', state: retry }), error => /keine lesbare Sitzung/.test(error.message) && !error.message.includes('DO-NOT-DISCLOSE'));
});

test('an OAuth response arriving after disconnect cannot restore a removed session', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iva-saxo-disconnect-')); t.after(() => rm(root, { recursive: true, force: true }));
  const entered = gate(), release = gate(); t.after(() => release.resolve());
  const env = { SAXO_APP_KEY: 'key', SAXO_APP_SECRET: 'secret', SAXO_REDIRECT_URI: 'https://iva.example.org/oauth/saxo/callback', SAXO_TOKEN_KEY: 'a-private-encryption-key-at-least-32-characters' };
  const client = createSaxoClient({ dataDir: root, env, fetchImpl: async () => { entered.resolve(); await release.promise; return new Response(JSON.stringify({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 1200, refresh_token_expires_in: 2400 })); } });
  const state = new URL(client.createAuthUrl()).searchParams.get('state');
  const pending = client.completeOAuth({ code: 'fixture-code', state }); await entered.promise;
  await client.disconnect(); release.resolve();
  await assert.rejects(pending, /zwischenzeitlich getrennt/);
  assert.equal((await client.status()).authorized, false);
  await assert.rejects(stat(path.join(root, 'saxo-sim-oauth.enc.json')), error => error.code === 'ENOENT');
});
