import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(os.tmpdir(), 'iva-read-concurrency-'));
process.env.DATA_DIR = directory;
after(() => rm(directory, { recursive: true, force: true }));
const { readPipedriveFundingDealsViaApi } = await import('../local-mac-helper/background-integrations.mjs');
const store = await import('../automations/store.js');
const { createAutomationOrchestrator, isDue } = await import('../automations/orchestrator.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('production funding reads use six workers, steal next case and preserve input ordering', async () => {
  let active = 0, maximum = 0, releaseSlow;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  const progress = [], visited = [];
  const result = await readPipedriveFundingDealsViaApi({ dealIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 3], onProgress: value => progress.push(value.processed) }, {
    readDeal: async ({ dealId }) => {
      visited.push(dealId); active++; maximum = Math.max(maximum, active);
      try {
        if (dealId === '1') await slow;
        else await delay(5);
        if (dealId === '8') releaseSlow();
        if (dealId === '3' || dealId === '10') throw new Error(`isolated-${dealId}`);
        return { dealId };
      } finally { active--; }
    },
  });
  assert.equal(maximum, 6); assert.equal(active, 0); assert.equal(visited.length, 12);
  assert.deepEqual(result.snapshots.map(item => item.dealId), ['1', '2', '4', '5', '6', '7', '8', '9', '11', '12']);
  assert.deepEqual(result.errors.map(item => item.dealId), ['3', '10']);
  assert.deepEqual(progress, Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal(result.readOnly, true); assert.equal(result.mutated, false);
});

test('production catch-up runs four workflows concurrently, isolates errors and deduplicates reruns', async () => {
  const now = new Date('2026-10-01T21:59:00Z');
  const due = store.AUTOMATION_DEFINITIONS.filter(definition => isDue(definition, now));
  for (const definition of due) await store.setAutomationEnabled(definition.id, true);
  let active = 0, maximum = 0, calls = 0, unblock;
  const barrier = new Promise(resolve => { unblock = resolve; });
  const handlers = Object.fromEntries(due.map((definition, index) => [definition.id, async () => {
    active++; calls++; maximum = Math.max(maximum, active);
    try {
      if (calls === 4) unblock();
      await barrier; await delay(5);
      if (index === 4) throw new Error('isolated fixture failure');
      return { summary: `complete-${definition.id}` };
    } finally { active--; }
  }]));
  const orchestrator = createAutomationOrchestrator(handlers);
  const result = await orchestrator.runDueAutomations(now);
  assert.equal(maximum, 4); assert.equal(active, 0); assert.equal(calls, due.length);
  assert.deepEqual(result.map(item => item.automationId), due.map(item => item.id));
  assert.equal(result[4].error, 'isolated fixture failure');
  assert.ok(result.every((item, index) => index === 4 || item.run.status === 'completed'));
  const successfulIds = result.filter(item => !item.error).map(item => item.automationId);
  const before = calls;
  const repeat = await orchestrator.runDueAutomations(now);
  assert.ok(repeat.filter(item => successfulIds.includes(item.automationId)).every(item => item.reason === 'duplicate'));
  assert.equal(calls - before, 1); // Only the existing failed slot may retry.
});
