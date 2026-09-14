import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-brain-budget-'));
process.env.DATA_DIR = directory;
process.env.IVA_MONTHLY_BUDGET_EUR = '0.01';
const { chooseModelKey, currentSpendEUR, recordUsage, reserveModelBudget, checkBudget } = await import('../core/router.js');
const model = chooseModelKey('groq:openai/gpt-oss-120b');

test('concurrent accounting persists every completed call and excludes invalid token counts', async () => {
  await Promise.all(Array.from({ length: 30 }, () => recordUsage(model, { promptTokens: 100, completionTokens: 20 })));
  await recordUsage(model, { promptTokens: NaN, completionTokens: -100 });
  const spend = await currentSpendEUR();
  assert.equal(spend.byModel[model.key].tokensIn, 3000);
  assert.equal(spend.byModel[model.key].tokensOut, 600);
  assert.ok(Number.isFinite(spend.totalEUR));
  const disk = JSON.parse(await fs.readFile(path.join(directory, 'model-usage.json'), 'utf8'));
  assert.equal(disk.months[spend.monthKey].byModel[model.key].calls, 31);
});

test('concurrent budget reservations cannot all consume the same balance', async () => {
  const outcomes = await Promise.allSettled(Array.from({ length: 3 }, () => reserveModelBudget(model, 0.004)));
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 2);
  assert.equal(outcomes.filter(r => r.status === 'rejected').length, 1);
  for (const outcome of outcomes) if (outcome.status === 'fulfilled') { outcome.value(); outcome.value(); }
  const release = await reserveModelBudget(model, 0.008);
  release();
});

test('main budget still stops calls after completed usage reaches the limit', async () => {
  await recordUsage(model, { promptTokens: 1000000, completionTokens: 0 });
  await assert.rejects(checkBudget(model), { code: 'budget_exceeded' });
  await assert.rejects(reserveModelBudget(model, 0.0001), { code: 'budget_exceeded' });
});

test.after(() => fs.rm(directory, { recursive: true, force: true }));
