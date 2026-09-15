import test from 'node:test';
import assert from 'node:assert/strict';
import { runResearchJson, parseResearchJson } from '../integrations/research.js';
import { estimateUsageEUR } from '../core/router.js';

const CLAUDE = 'anthropic:claude-sonnet-4-6';
const GEMINI = 'google:gemini-3.6-flash';
const route = key => ({ key, task: 'marketing-intelligence', provider: key.split(':')[0], modelId: key.split(':')[1], model: { key } });
const usage = { promptTokens: 75, completionTokens: 15 };
const success = () => ({ text: '{"summary":"Aus echten Quellen abgeleitet"}', usage });
function setup(overrides = {}, options = {}) {
  const events = [], estimates = [], prompts = [], records = [], outstanding = new Set();
  let counter = 0;
  const dependencies = {
    choose: () => route(CLAUDE),
    chooseKey: key => route(key),
    check: async routed => { events.push(`check:${routed.key}`); assert.equal(outstanding.size, 0, 'prior attempt reservation must be released before next budget check'); },
    reserve: async (routed, estimate) => {
      events.push(`reserve:${routed.key}`); estimates.push(estimate); const token = ++counter; outstanding.add(token);
      return async () => { events.push(`release:${routed.key}`); assert.ok(outstanding.delete(token), 'reservation must release exactly once'); };
    },
    generate: async input => { events.push(`generate:${input.model.key}`); prompts.push(input.prompt); return success(); },
    record: async (routed, value) => { events.push(`record:${routed.key}`); records.push({ routed, usage: value }); },
    ...overrides,
  };
  const input = { system: 'Analysiere nur die gelieferten Quellen. Gib JSON zurück.', prompt: 'Die echte Quelle zeigt einen konkreten Mechanismus.', env: { ANTHROPIC_API_KEY: 'fixture', GEMINI_API_KEY: 'fixture' }, maxTokens: 700, ...options };
  return { events, estimates, prompts, records, outstanding, dependencies, input, run: () => runResearchJson(input, dependencies) };
}

test('one successful call reserves, accounts, and releases exactly once', async () => {
  const h = setup(); const result = await h.run();
  assert.equal(result.model, CLAUDE); assert.equal(result.data.summary, 'Aus echten Quellen abgeleitet'); assert.deepEqual(result.warnings, []);
  assert.deepEqual(h.events, [`check:${CLAUDE}`, `reserve:${CLAUDE}`, `generate:${CLAUDE}`, `record:${CLAUDE}`, `release:${CLAUDE}`]); assert.equal(h.outstanding.size, 0);
});

test('malformed JSON repair gets a fresh check and larger reservation for its real prompt', async () => {
  const h = setup(); const original = h.dependencies.generate; let calls = 0;
  h.dependencies.generate = async input => { await original(input); calls++; return calls === 1 ? { text: 'Kein JSON: ' + 'X'.repeat(900), usage } : success(); };
  const result = await h.run(); assert.equal(result.model, CLAUDE); assert.equal(h.records.length, 2);
  assert.deepEqual(h.events, [...Array(2)].flatMap(() => [`check:${CLAUDE}`, `reserve:${CLAUDE}`, `generate:${CLAUDE}`, `record:${CLAUDE}`, `release:${CLAUDE}`]));
  assert.equal(h.prompts[0], h.input.prompt); assert.ok(h.prompts[1].startsWith(h.input.prompt)); assert.match(h.prompts[1], /Deine vorige Antwort war kein gültiges JSON/);
  assert.ok(h.estimates[1] > h.estimates[0]);
  assert.equal(h.estimates[1], estimateUsageEUR(route(CLAUDE), { promptTokens: Math.ceil((h.prompts[1].length + h.input.system.length) / 3), completionTokens: h.input.maxTokens }));
  assert.equal(h.outstanding.size, 0);
});

test('repair cannot bypass a newly exhausted budget and does not fall back to another provider', async () => {
  const h = setup(); let checks = 0, calls = 0; const check = h.dependencies.check;
  h.dependencies.check = async routed => { await check(routed); if (++checks === 2) throw Object.assign(new Error('Private accounting detail'), { code: 'budget_exceeded' }); };
  h.dependencies.generate = async () => { calls++; return { text: 'invalid JSON', usage }; };
  await assert.rejects(h.run(), error => error.code === 'budget_exceeded' && !error.message.includes('Private accounting detail'));
  assert.equal(calls, 1); assert.equal(h.estimates.length, 1); assert.equal(h.records.length, 1); assert.equal(h.outstanding.size, 0); assert.ok(!h.events.some(e => e.includes(GEMINI)));
});

test('reservation rejection stops the call without manufacturing a release or fallback', async () => {
  let calls = 0;
  const h = setup({ reserve: async () => { throw Object.assign(new Error('No budget'), { code: 'budget_exceeded' }); }, generate: async () => { calls++; return success(); } });
  await assert.rejects(h.run(), { code: 'budget_exceeded' }); assert.equal(calls, 0); assert.ok(!h.events.some(e => e.startsWith('release:'))); assert.equal(h.records.length, 0); assert.ok(!h.events.some(e => e.includes(GEMINI)));
});

test('failed provider releases before fallback and fallback receives the original source prompt', async () => {
  const h = setup(); const generate = h.dependencies.generate;
  h.dependencies.generate = async input => { await generate(input); if (input.model.key === CLAUDE) throw new Error('provider secret should never appear'); return success(); };
  const result = await h.run(); assert.equal(result.model, GEMINI); assert.equal(result.warnings.length, 1); assert.ok(!JSON.stringify(result).includes('provider secret'));
  assert.deepEqual(h.prompts, [h.input.prompt, h.input.prompt]);
  assert.ok(h.events.indexOf(`release:${CLAUDE}`) < h.events.indexOf(`check:${GEMINI}`)); assert.equal(h.records.length, 1); assert.equal(h.outstanding.size, 0);
});

test('two malformed replies exhaust one provider then start fallback with fresh budget', async () => {
  const h = setup(); const generate = h.dependencies.generate;
  h.dependencies.generate = async input => { await generate(input); return input.model.key === CLAUDE ? { text: 'invalid', usage } : success(); };
  const result = await h.run(); assert.equal(result.model, GEMINI); assert.equal(h.estimates.length, 3); assert.equal(h.records.length, 3); assert.equal(h.prompts.at(-1), h.input.prompt); assert.equal(h.outstanding.size, 0);
});

test('an already canceled operation starts no paid call or reservation', async () => {
  const controller = new AbortController(); controller.abort(); const h = setup({}, { signal: controller.signal });
  await assert.rejects(h.run(), { name: 'AbortError' }); assert.equal(h.estimates.length, 0); assert.equal(h.prompts.length, 0); assert.equal(h.records.length, 0);
});

test('cancellation during budget check prevents reservation and generation', async () => {
  const controller = new AbortController(); const h = setup({ check: async () => controller.abort() }, { signal: controller.signal });
  await assert.rejects(h.run(), { name: 'AbortError' }); assert.equal(h.estimates.length, 0); assert.equal(h.prompts.length, 0); assert.equal(h.outstanding.size, 0);
});

test('cancellation immediately after reserving releases the reservation without dispatch', async () => {
  const controller = new AbortController(); const h = setup({}, { signal: controller.signal }); const reserve = h.dependencies.reserve;
  h.dependencies.reserve = async (...args) => { const release = await reserve(...args); controller.abort(); return release; };
  await assert.rejects(h.run(), { name: 'AbortError' }); assert.equal(h.estimates.length, 1); assert.equal(h.prompts.length, 0); assert.equal(h.outstanding.size, 0); assert.equal(h.events.filter(x => x.startsWith('release:')).length, 1);
});

test('cancellation from progress callback releases before any model dispatch', async () => {
  const controller = new AbortController(); const h = setup({}, { signal: controller.signal, onProgress: async event => { if (event.phase === 'analysis') controller.abort(); } });
  await assert.rejects(h.run(), { name: 'AbortError' }); assert.equal(h.prompts.length, 0); assert.equal(h.outstanding.size, 0);
});

test('cancellation while provider fails stops fallback and frees its reservation', async () => {
  const controller = new AbortController(); const h = setup({}, { signal: controller.signal }); const generate = h.dependencies.generate;
  h.dependencies.generate = async input => { await generate(input); controller.abort(); throw new Error('upstream canceled'); };
  await assert.rejects(h.run(), { name: 'AbortError' }); assert.equal(h.prompts.length, 1); assert.equal(h.records.length, 0); assert.equal(h.outstanding.size, 0); assert.ok(!h.events.some(e => e.includes(GEMINI)));
});

test('a completed call still accounts for usage when cancellation arrived with its response', async () => {
  const controller = new AbortController(); const h = setup({}, { signal: controller.signal }); const generate = h.dependencies.generate;
  h.dependencies.generate = async input => { const result = await generate(input); controller.abort(); return result; };
  await assert.rejects(h.run(), { name: 'AbortError' }); assert.equal(h.records.length, 1); assert.deepEqual(h.records[0].usage, usage); assert.equal(h.outstanding.size, 0); assert.equal(h.prompts.length, 1);
});

test('cancellation during provider-change notification prevents the fallback call', async () => {
  const controller = new AbortController(); const h = setup({ generate: async () => { throw new Error('provider unavailable'); } }, { signal: controller.signal, onProgress: async event => { if (event.phase === 'provider-unavailable') controller.abort(); } });
  await assert.rejects(h.run(), { name: 'AbortError' }); assert.equal(h.estimates.length, 1); assert.equal(h.outstanding.size, 0); assert.ok(!h.events.some(e => e.includes(GEMINI)));
});

test('parse helper accepts fenced JSON and rejects incomplete documents', () => {
  assert.deepEqual(parseResearchJson('```json\n{"ok":true}\n```'), { ok: true }); assert.deepEqual(parseResearchJson('Ein Ergebnis: {"ok":true}'), { ok: true }); assert.throws(() => parseResearchJson('{"broken":'));
});
