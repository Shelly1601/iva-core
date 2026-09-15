import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createOpportunityScheduler, opportunityScheduleSlot } from '../opportunities/scheduler.js';

const daily = { weeklyEnabled: true, cadence: 'daily', weeklyDay: 'monday', weeklyTime: '08:30' };
async function fixture(t, patch = {}, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-opportunity-schedule-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let stamp = Date.parse('2026-09-14T06:31:00Z');
  const state = { settings: { ...daily, ...patch }, calls: [] };
  const dependencies = { dataDir, getSettings: async () => ({ ...state.settings }), now: () => stamp, autoStart: false, runScout: async (input, runtime) => { state.calls.push({ input, runtime }); return { run: { id: 'fixture-run', sourceCount: 8, ideaCount: 2 }, opportunities: [{}, {}] }; }, ...options };
  const scheduler = createOpportunityScheduler(dependencies); t.after(() => scheduler.close());
  return { scheduler, state, dependencies, dataDir, setTime: value => { stamp = Date.parse(value); } };
}

test('daily scans honor configured Berlin time, remain disabled when requested, and have no messaging', async t => {
  const f = await fixture(t); f.setTime('2026-09-14T06:29:00Z');
  assert.equal((await f.scheduler.tick()).status, 'not-due');
  assert.equal(f.state.calls.length, 0);
  f.setTime('2026-09-14T06:30:00Z');
  assert.equal((await f.scheduler.tick()).status, 'complete');
  assert.equal(f.state.calls[0].input.trigger, 'scheduled-daily');
  assert(f.state.calls[0].runtime.signal instanceof AbortSignal);
  assert.equal((await f.scheduler.status()).telegram, false);
  assert.equal((await f.scheduler.status()).manualScansLimited, false);
  f.state.settings.weeklyEnabled = false; f.setTime('2026-09-15T06:31:00Z');
  assert.equal((await f.scheduler.tick()).status, 'not-due');
  assert.equal(f.state.calls.length, 1);
});

test('exclusive persisted claims deduplicate restart and concurrent scheduler instances', async t => {
  const f = await fixture(t), other = createOpportunityScheduler(f.dependencies); t.after(() => other.close());
  const results = await Promise.all([f.scheduler.tick(), other.tick()]);
  assert.deepEqual(results.map(row => row.status).sort(), ['already-claimed', 'complete']);
  assert.equal(f.state.calls.length, 1);
  f.scheduler.close(); other.close();
  const restarted = createOpportunityScheduler(f.dependencies); t.after(() => restarted.close());
  assert.equal((await restarted.tick()).status, 'already-claimed');
  assert.equal(f.state.calls.length, 1);
  assert.equal((await restarted.status()).runs[0].runId, 'fixture-run');
  assert.equal((await fs.stat(path.join(f.dataDir, 'opportunity-schedule', '2026-09-14-daily.json'))).mode & 0o777, 0o600);
});

test('another local day creates a fresh schedule slot without limiting manual execution', async t => {
  const f = await fixture(t); await f.scheduler.tick();
  f.setTime('2026-09-15T06:31:00Z'); await f.scheduler.tick();
  assert.equal(f.state.calls.length, 2);
  assert.deepEqual((await f.scheduler.status()).runs.map(row => row.id), ['2026-09-15-daily', '2026-09-14-daily']);
});

test('weekly scans use the selected weekday and catch up once within that Berlin week', async t => {
  const f = await fixture(t, { cadence: 'weekly', weeklyDay: 'wednesday', weeklyTime: '10:15' });
  assert.equal((await f.scheduler.tick()).status, 'not-due');
  f.setTime('2026-09-16T08:14:00Z'); assert.equal((await f.scheduler.tick()).status, 'not-due');
  f.setTime('2026-09-17T08:16:00Z'); const result = await f.scheduler.tick();
  assert.equal(result.id, '2026-09-16-weekly');
  assert.equal(result.scheduledLocal, '2026-09-16 10:15');
  f.setTime('2026-09-18T08:16:00Z'); assert.equal((await f.scheduler.tick()).status, 'already-claimed');
  assert.equal(f.state.calls.length, 1);
});

test('DST fall-back cannot duplicate the repeated local time and spring gap runs at the first valid later minute', async t => {
  const f = await fixture(t, { weeklyTime: '02:30' });
  f.setTime('2026-10-25T00:31:00Z'); assert.equal((await f.scheduler.tick()).status, 'complete');
  f.setTime('2026-10-25T01:31:00Z'); assert.equal((await f.scheduler.tick()).status, 'already-claimed');
  assert.equal(f.state.calls.length, 1);
  assert.equal(opportunityScheduleSlot({ ...daily, weeklyTime: '02:30' }, Date.parse('2026-03-29T00:59:00Z')), null);
  const spring = opportunityScheduleSlot({ ...daily, weeklyTime: '02:30' }, Date.parse('2026-03-29T01:00:00Z'));
  assert.equal(spring.id, '2026-03-29-daily');
});

test('failed provider scans persist safe failure and do not auto-retry the same paid schedule', async t => {
  const f = await fixture(t, {}, { runScout: async () => { throw Object.assign(new Error('token=SECRET-DO-NOT-LOG'), { runId: 'failed-run' }); } });
  const result = await f.scheduler.tick();
  assert.equal(result.status, 'failed'); assert.equal(result.runId, 'failed-run');
  assert(!JSON.stringify(result).includes('SECRET-DO-NOT-LOG'));
  assert.equal((await f.scheduler.tick()).status, 'already-claimed');
  assert.equal((await f.scheduler.status()).runs[0].status, 'failed');
});

test('timeout aborts the scan and late completion cannot overwrite the interrupted record', async t => {
  let signal;
  const f = await fixture(t, {}, { timeoutMs: 10, runScout: async (_input, runtime) => { signal = runtime.signal; await new Promise(resolve => setTimeout(resolve, 40)); return { run: { id: 'too-late' } }; } });
  assert.equal((await f.scheduler.tick()).status, 'interrupted');
  assert.equal(signal.aborted, true);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await f.scheduler.status()).runs[0].status, 'interrupted');
  assert.equal((await f.scheduler.status()).runs[0].runId, null);
});

test('settings revoked between claim and dispatch prevent a scan', async t => {
  let reads = 0, calls = 0;
  const f = await fixture(t, {}, { getSettings: async () => ({ ...daily, weeklyEnabled: ++reads === 1 }), runScout: async () => { calls++; } });
  assert.equal((await f.scheduler.tick()).status, 'skipped');
  assert.equal(calls, 0);
});

test('damaged or symlinked state is rejected instead of deleting claims or duplicating work', async t => {
  const f = await fixture(t); await f.scheduler.tick();
  const file = path.join(f.dataDir, 'opportunity-schedule', '2026-09-14-daily.json');
  const original = await fs.readFile(file, 'utf8'), target = path.join(f.dataDir, 'other.json');
  await fs.writeFile(target, original); await fs.rm(file); await fs.symlink(target, file);
  await assert.rejects(f.scheduler.status(), error => error.code === 'ELOOP');
  assert.equal((await f.scheduler.tick()).status, 'already-claimed');
  assert.equal(f.state.calls.length, 1);
  await fs.rm(file); await fs.writeFile(file, '{bad');
  await assert.rejects(f.scheduler.status());
  assert.equal((await f.scheduler.tick()).status, 'already-claimed');
  assert.equal(f.state.calls.length, 1);
});

test('unfinished prior-process records remain deduplicated and become visibly interrupted after their deadline', async t => {
  const f = await fixture(t); await f.scheduler.tick();
  const file = path.join(f.dataDir, 'opportunity-schedule', '2026-09-14-daily.json');
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...record, owner: 'prior-process', status: 'running', deadlineAt: '2026-09-14T06:00:00Z', completedAt: null }));
  assert.equal((await f.scheduler.status()).runs[0].status, 'interrupted');
  assert.equal((await f.scheduler.tick()).status, 'already-claimed');
  assert.equal(f.state.calls.length, 1);
});
