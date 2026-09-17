import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createModelBudget, normalizeModelUsage, priceModelUsage } from '../core/model-budget.js';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-model-budget-'));
const pricing = { eurPerMTokIn: 1, eurPerMTokOut: 2 };
const routed = { key: 'test:model', task: 'test', safetyLevel: 'liability' };
let sequence = 0;
function fixture(options = {}) {
  const file = options.file || path.join(temporary, String(++sequence), 'model-usage.json');
  return { file, budget: createModelBudget({ file, pricingFor: () => pricing, ...options }) };
}

test('30 EUR maximum and 24 EUR warning; a stale larger setting never raises approval', () => {
  assert.deepEqual(fixture().budget.limits, { monthly: 30, warnAt: 24 });
  assert.deepEqual(fixture({ monthlyLimitEUR: 100, warnAtEUR: 70 }).budget.limits, { monthly: 30, warnAt: 24 });
  assert.deepEqual(fixture({ monthlyLimitEUR: 5 }).budget.limits, { monthly: 5, warnAt: 5 });
  assert.throws(() => fixture({ monthlyLimitEUR: NaN }), { code: 'budget_config_invalid' });
});

test('both SDK usage shapes are accounted; missing, negative and invalid tokens are never free', () => {
  assert.deepEqual(normalizeModelUsage({ promptTokens: 12, completionTokens: 5 }), { inputTokens: 12, outputTokens: 5 });
  assert.deepEqual(normalizeModelUsage({ inputTokens: 12, outputTokens: 5 }), { inputTokens: 12, outputTokens: 5 });
  assert.equal(priceModelUsage({ inputTokens: 12, outputTokens: 5 }, pricing).eur, 0.000022);
  for (const usage of [null, {}, { promptTokens: NaN, completionTokens: 2 }, { inputTokens: 3, outputTokens: -1 }, { inputTokens: '3', outputTokens: 1 }]) {
    assert.throws(() => normalizeModelUsage(usage), { code: 'budget_usage_unknown' });
  }
  assert.throws(() => priceModelUsage({ inputTokens: 1, outputTokens: 1 }), { code: 'budget_pricing_unknown' });
});

test('independent instances atomically reserve concurrent calls and never exempt liability', async () => {
  const { file, budget } = fixture({ monthlyLimitEUR: 1 });
  const other = fixture({ file, monthlyLimitEUR: 1 }).budget;
  const results = await Promise.allSettled([budget.reserve(routed, 0.4), other.reserve(routed, 0.4), budget.reserve(routed, 0.4)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'budget_exceeded');
  const state = await other.currentSpend();
  assert.equal(state.reservedEUR, 0.8);
  assert.equal(state.totalEUR, 0);
  const id = results.find(result => result.status === 'fulfilled').value;
  await budget.release(id);
  await other.release(id);
  assert.equal((await budget.currentSpend()).reservedEUR, 0.4);
});

test('separate Node processes share the same reservation balance', async () => {
  const { file, budget } = fixture({ monthlyLimitEUR: 1 });
  const moduleUrl = new URL('../core/model-budget.js', import.meta.url).href;
  const script = `import { createModelBudget } from ${JSON.stringify(moduleUrl)}; const budget = createModelBudget({file:process.argv[1],monthlyLimitEUR:1,pricingFor:()=>({eurPerMTokIn:1,eurPerMTokOut:2})}); try {await budget.reserve({key:'test:model',task:'test'},.4);process.stdout.write('reserved')} catch(e) {process.stdout.write(e.code)}`;
  const run = promisify(execFile);
  const results = await Promise.all(Array.from({ length: 3 }, () => run(process.execPath, ['--input-type=module', '-e', script, file])));
  assert.equal(results.filter(result => result.stdout === 'reserved').length, 2);
  assert.equal(results.filter(result => result.stdout === 'budget_exceeded').length, 1);
  assert.equal((await budget.currentSpend()).reservedEUR, 0.8);
});

test('reservation survives restart and month rollover; exact limit may be reserved', async () => {
  const first = fixture({ monthlyLimitEUR: 1, now: () => new Date('2026-09-30T23:59:00Z') });
  await first.budget.reserve(routed, 1);
  const restarted = fixture({ file: first.file, monthlyLimitEUR: 1, now: () => new Date('2026-10-01T00:00:00Z') }).budget;
  assert.equal((await restarted.currentSpend()).reservedEUR, 1);
  await assert.rejects(restarted.reserve(routed, 0.001), { code: 'budget_exceeded' });
});

test('settlement is durable and idempotent, and charges against the reservation month', async () => {
  let date = new Date('2026-09-30T23:59:00Z');
  const { budget } = fixture({ now: () => date });
  const id = await budget.reserve(routed, 1);
  await budget.markDispatched(id);
  date = new Date('2026-10-01T00:01:00Z');
  await budget.settle(id, { inputTokens: 100000, outputTokens: 50000 });
  await budget.settle(id, { inputTokens: 100000, outputTokens: 50000 });
  await budget.release(id);
  assert.equal((await budget.currentSpend('2026-09')).totalEUR, 0.2);
  assert.equal((await budget.currentSpend('2026-09')).byModel[routed.key].calls, 1);
  assert.equal((await budget.currentSpend()).reservedEUR, 0);
});

test('network uncertainty retains its full bound while preserving known unused balance', async () => {
  const { file, budget } = fixture({ monthlyLimitEUR: 1 });
  const id = await budget.reserve(routed, 0.7);
  await budget.markDispatched(id);
  await assert.rejects(budget.release(id), { code: 'budget_usage_unknown' });
  const restarted = fixture({ file, monthlyLimitEUR: 1 }).budget;
  const state = await restarted.currentSpend();
  assert.equal(state.reservedEUR, 0.7);
  assert.equal(state.unresolved, false);
  await restarted.reserve(routed, 0.3);
  await assert.rejects(restarted.reserve(routed, 0.001), { code: 'budget_exceeded' });
  await restarted.settle(id, { promptTokens: 100000, completionTokens: 0 });
  assert.equal((await restarted.currentSpend()).totalEUR, 0.1);
});

test('invalid completed usage blocks new calls until actual usage reconciles it', async () => {
  const { budget } = fixture();
  const id = await budget.reserve(routed, 1);
  await budget.markDispatched(id);
  await assert.rejects(budget.settle(id, {}), { code: 'budget_usage_unknown' });
  await assert.rejects(budget.release(id), { code: 'budget_usage_unknown' });
  await assert.rejects(budget.reserve(routed, 0.001), { code: 'budget_unreconciled' });
  await budget.settle(id, { inputTokens: 1000, outputTokens: 2000 });
  assert.equal((await budget.currentSpend()).totalEUR, 0.005);
  await budget.check();
});

test('a provider overrun is charged and blocks further dispatch', async () => {
  const { budget } = fixture();
  const id = await budget.reserve(routed, 0.001);
  await budget.markDispatched(id);
  await assert.rejects(budget.settle(id, { inputTokens: 10000, outputTokens: 0 }), { code: 'budget_bound_exceeded' });
  assert.equal((await budget.currentSpend()).totalEUR, 0.01);
  await assert.rejects(budget.check(), { code: 'budget_unreconciled' });
});

test('a verified unsent dispatch can be released; it cannot later claim settlement', async () => {
  const { budget } = fixture();
  const id = await budget.reserve(routed, 1);
  await budget.markDispatched(id);
  await budget.release(id, { confirmedNotSent: true });
  assert.equal((await budget.currentSpend()).reservedEUR, 0);
  await assert.rejects(budget.settle(id, { inputTokens: 1, outputTokens: 1 }), { code: 'budget_reservation_invalid' });
});

test('corrupt ledger and missing initialized ledger are not interpreted as zero spend', async () => {
  const { file, budget } = fixture();
  await budget.reserve(routed, 0.1);
  await fs.writeFile(file, '{invalid');
  await assert.rejects(budget.currentSpend(), { code: 'budget_storage_invalid' });
  await assert.rejects(budget.reserve(routed, 0.1), { code: 'budget_storage_invalid' });
  await fs.unlink(file);
  await assert.rejects(fixture({ file }).budget.currentSpend(), { code: 'budget_storage_invalid' });
});

test('invalid numeric ledger cannot bypass the cap through NaN or overflow', async () => {
  const { file, budget } = fixture();
  await budget.check();
  await fs.writeFile(file, JSON.stringify({ months: { '2026-09': { byModel: { a: { tokensIn: 1, tokensOut: 1, calls: 1, eur: 1e300 } }, byTask: {} } } }));
  await assert.rejects(budget.reserve(routed, 1), { code: 'budget_storage_invalid' });
});

test('legacy totals are retained and explicitly identified as unverified history', async () => {
  const { file, budget } = fixture({ now: () => new Date('2026-09-17T12:00:00Z') });
  await fs.mkdir(path.dirname(file), { recursive: true });
  const usage = { tokensIn: 1000, tokensOut: 200, calls: 1, eur: 0.3 };
  await fs.writeFile(file, JSON.stringify({ months: { '2026-09': { byModel: { 'test:model': usage }, byTask: { test: usage } } } }));
  const state = await budget.currentSpend();
  assert.equal(state.totalEUR, 0.3);
  assert.equal(state.accounting.legacyTotalsUnverified, true);
  await budget.reserve(routed, 1);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).accounting.legacyTotalsUnverified, true);
});

test('failed persistence aborts reservation; no success is returned from an in-memory cache', async () => {
  const { file, budget } = fixture();
  await budget.check();
  const originalRename = fs.rename;
  fs.rename = async () => { throw Object.assign(new Error('simulated failure'), { code: 'EIO' }); };
  try { await assert.rejects(budget.reserve(routed, 1), { code: 'budget_storage_unavailable' }); }
  finally { fs.rename = originalRename; }
  assert.equal((await fixture({ file }).budget.currentSpend()).reservedEUR, 0);
});

test('unwritable storage and an abandoned lock fail closed', async () => {
  const parent = path.join(temporary, 'not-a-directory');
  await fs.writeFile(parent, 'x');
  await assert.rejects(fixture({ file: path.join(parent, 'usage.json') }).budget.reserve(routed, 1), { code: 'budget_storage_unavailable' });
  const { file, budget } = fixture({ lockWaitMs: 20 });
  await fs.mkdir(`${file}.lock`, { recursive: true });
  await assert.rejects(budget.reserve(routed, 1), { code: 'budget_storage_locked' });
});

test('legacy recording preserves all concurrent usage and invalid usage creates a blocking discrepancy', async () => {
  const { budget } = fixture();
  await Promise.all(Array.from({ length: 30 }, () => budget.record(routed, { inputTokens: 100, outputTokens: 20 })));
  const state = await budget.currentSpend();
  assert.equal(state.byModel[routed.key].tokensIn, 3000);
  assert.equal(state.byModel[routed.key].tokensOut, 600);
  assert.equal(state.totalEUR, 0.0042);
  await assert.rejects(budget.record(routed, null), { code: 'budget_usage_unknown' });
  await assert.rejects(budget.check(), { code: 'budget_unreconciled' });
});

test('unknown prices do not fall back to another model; a changed price requires a new reservation', async () => {
  let active = pricing;
  const { budget } = fixture({ pricingFor: () => active });
  const id = await budget.reserve(routed, 1);
  active = { ...pricing, eurPerMTokIn: 3 };
  await assert.rejects(budget.markDispatched(id), { code: 'budget_pricing_changed' });
  await budget.release(id);
  active = null;
  await assert.rejects(budget.reserve(routed, 1), { code: 'budget_pricing_unknown' });
});

test('warning fires once after persisted accounting reaches the threshold', async () => {
  const warnings = [];
  const { file, budget } = fixture({ warnAtEUR: 0.005, onWarn: event => warnings.push(event) });
  await budget.record(routed, { inputTokens: 5000, outputTokens: 0 });
  await budget.record(routed, { inputTokens: 5000, outputTokens: 0 });
  assert.equal(warnings.length, 1);
  assert.ok(JSON.parse(await fs.readFile(file, 'utf8')).months[warnings[0].monthKey]._warnedAt);
});

test('router keeps model choices and avoids duplicate outer billing even after route spreading', async () => {
  const saved = process.env.DATA_DIR;
  process.env.DATA_DIR = path.join(temporary, 'router');
  let router;
  try { router = await import('../core/router.js?budget-integration-test'); }
  finally { if (saved == null) delete process.env.DATA_DIR; else process.env.DATA_DIR = saved; }
  const selected = router.chooseModelKey('groq:openai/gpt-oss-120b');
  const spread = { ...selected, task: 'brain-review' };
  assert.equal(selected.modelId, 'openai/gpt-oss-120b');
  assert.equal(selected.budgetEnforced, true);
  assert.equal(spread.budgetEnforced, undefined);
  // These callbacks belong to the old outer layer; the provider wrapper owns
  // its own usage. Even an absent outer usage cannot create a second charge.
  await router.recordUsage(spread, null);
  const release = await router.reserveModelBudget(spread, 1);
  await release();
  assert.equal((await router.currentSpendEUR()).totalEUR, 0);
  assert.equal((await router.currentSpendEUR()).reservedEUR, 0);
  assert.equal((await router.currentSpendEUR()).unresolved, false);
  assert.throws(() => router.modelPricing({ key: 'google:gemini-unverified' }), { code: 'budget_pricing_unknown' });
});

test.after(() => fs.rm(temporary, { recursive: true, force: true }));
