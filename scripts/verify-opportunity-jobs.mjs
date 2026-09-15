import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createOpportunityJobs } from '../opportunities/jobs.js';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function fixture(t, handlers, extra = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-opportunity-jobs-'));
  const jobs = createOpportunityJobs({ dataDir, handlers, env: {}, ...extra });
  t.after(async () => { await jobs.close().catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { jobs, dataDir };
}
async function until(jobs, id, statuses = ['completed', 'failed', 'interrupted']) {
  const end = Date.now() + 3000;
  while (Date.now() < end) { const job = await jobs.get(id); if (statuses.includes(job.status)) return job; await pause(2); }
  assert.fail('Fixture job did not reach expected state');
}

test('jobs persist queued/running/completed progress and return detached snapshots', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { jobs, dataDir } = await fixture(t, { check: async (input, { signal, onProgress }) => { assert.equal(signal.aborted, false); await onProgress({ phase: 'reading', message: 'Quelle wird gelesen.' }); await gate; return { confirmed: input.value }; } });
  const initial = await jobs.submit('check', { value: 42 });
  assert.equal(initial.status, 'queued'); assert.equal(initial.fingerprint, undefined);
  await until(jobs, initial.id, ['running']);
  const running = await jobs.get(initial.id); assert.ok(running.startedAt); assert.equal(running.finishedAt, null);
  release(); const done = await until(jobs, initial.id);
  assert.equal(done.status, 'completed'); assert.deepEqual(done.result, { confirmed: 42 }); assert.ok(done.finishedAt);
  done.result.confirmed = 'mutated'; assert.equal((await jobs.get(initial.id)).result.confirmed, 42);
  const filename = path.join(dataDir, 'opportunity-jobs', `${initial.id}.json`);
  const stored = JSON.parse(await fs.readFile(filename, 'utf8')); assert.equal(stored.status, 'completed'); assert.equal(stored.input, undefined);
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(path.dirname(filename))).filter(name => name.endsWith('.tmp')), []);
});

test('only two handlers run together and queued work starts when a slot is freed', async t => {
  const releases = [], starts = []; let running = 0, maximum = 0;
  const { jobs } = await fixture(t, { check: async input => { starts.push(input.index); running++; maximum = Math.max(maximum, running); await new Promise(resolve => releases.push(resolve)); running--; return input; } });
  const submitted = await Promise.all([1, 2, 3].map(index => jobs.submit('check', { index })));
  await until(jobs, submitted[1].id, ['running']); assert.equal(starts.length, 2); assert.equal((await jobs.get(submitted[2].id)).status, 'queued');
  releases[0](); await until(jobs, submitted[2].id, ['running']); assert.equal(starts.length, 3); assert.equal(maximum, 2);
  releases[1](); releases[2](); await Promise.all(submitted.map(job => until(jobs, job.id)));
});

test('active dedupe uses canonical inputs and stops deduping after completion', async t => {
  let release; let calls = 0;
  const { jobs } = await fixture(t, { check: async () => { calls++; await new Promise(resolve => { release = resolve; }); return 'ok'; } });
  const first = await jobs.submit('check', { url: 'https://example.com', nested: { a: 1, b: 2 } });
  const duplicate = await jobs.submit('check', { nested: { b: 2, a: 1 }, url: 'https://example.com' });
  assert.equal(first.id, duplicate.id); await until(jobs, first.id, ['running']); assert.equal(calls, 1);
  release(); await until(jobs, first.id);
  const again = await jobs.submit('check', { nested: { a: 1, b: 2 }, url: 'https://example.com' }); assert.notEqual(again.id, first.id);
  await until(jobs, again.id, ['running']); release(); await until(jobs, again.id);
});

test('input is copied before handler execution and never persisted as a request', async t => {
  const input = { nested: { value: 'original' }, transientPassword: 'request-only-secret' };
  const { jobs, dataDir } = await fixture(t, { check: async value => ({ nested: value.nested }) });
  const submitting = jobs.submit('check', input); input.nested.value = 'changed';
  const done = await until(jobs, (await submitting).id);
  assert.equal(done.result.nested.value, 'original');
  assert.ok(!(await fs.readFile(path.join(dataDir, 'opportunity-jobs', `${done.id}.json`), 'utf8')).includes('request-only-secret'));
});

test('timeouts abort handlers and late resolution never changes failed status', async t => {
  let release, seenSignal;
  const { jobs } = await fixture(t, { check: async (_input, { signal, onProgress }) => { seenSignal = signal; await new Promise(resolve => { release = resolve; }); await onProgress({ phase: 'too-late', message: 'Must be ignored.' }); return { late: true }; } }, { timeoutMs: 15 });
  const job = await jobs.submit('check', {}); const timeout = await until(jobs, job.id);
  assert.equal(timeout.status, 'failed'); assert.equal(timeout.error.code, 'JOB_TIMEOUT'); assert.equal(seenSignal.aborted, true);
  release(); await pause(10); const later = await jobs.get(job.id);
  assert.equal(later.status, 'failed'); assert.equal(later.phase, 'failed'); assert.equal(later.result, null);
});

test('raw handler errors cannot leak tokens, stack traces or request data', async t => {
  const { jobs, dataDir } = await fixture(t, { check: async () => { throw new Error('Bearer leaked-secret: password=private; https://provider.example?key=abc stacktrace'); } });
  const done = await until(jobs, (await jobs.submit('check')).id);
  assert.equal(done.error.code, 'JOB_FAILED'); assert.ok(!JSON.stringify(done).includes('leaked-secret')); assert.equal(done.error.stack, undefined);
  assert.ok(!(await fs.readFile(path.join(dataDir, 'opportunity-jobs', `${done.id}.json`), 'utf8')).includes('provider.example'));
});

test('successful results and progress redact known credentials and sensitive fields', async t => {
  const secret = 'fixture-private-api-secret';
  const { jobs, dataDir } = await fixture(t, { check: async (_input, { onProgress }) => { await onProgress({ phase: 'reading', message: `Provider ${secret}` }); return { token: 'token-value', nested: { apiKey: 'key-value', text: `Actual text ${secret} Bearer encodedToken url?access_token=private` } }; } }, { env: { APIFY_TOKEN: secret } });
  const done = await until(jobs, (await jobs.submit('check')).id);
  for (const value of [secret, 'token-value', 'key-value', 'encodedToken', 'access_token=private']) assert.ok(!JSON.stringify(done).includes(value));
  assert.ok(!(await fs.readFile(path.join(dataDir, 'opportunity-jobs', `${done.id}.json`), 'utf8')).includes(secret));
});

test('bounded queue rejects excess work with 429 while accepting active duplicates', async t => {
  const { jobs } = await fixture(t, { check: async () => new Promise(() => {}) });
  const outcomes = await Promise.allSettled(Array.from({ length: 30 }, (_, index) => jobs.submit('check', { index })));
  const accepted = outcomes.filter(row => row.status === 'fulfilled').map(row => row.value);
  const rejected = outcomes.filter(row => row.status === 'rejected').map(row => row.reason);
  assert.ok(accepted.length <= 22); assert.ok(rejected.length > 0); assert.ok(rejected.every(error => error.status === 429 && error.code === 'JOB_QUEUE_FULL'));
  assert.equal((await jobs.submit('check', { index: 0 })).id, accepted[0].id);
});

test('restart marks running and queued jobs interrupted while retaining completed jobs', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-opportunity-restart-')); const directory = path.join(dataDir, 'opportunity-jobs'); await fs.mkdir(directory);
  const ids = {};
  for (const status of ['running', 'queued', 'completed']) { const id = randomUUID(); ids[status] = id; await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({ id, kind: 'check', status, submittedAt: '2026-09-14T00:00:00Z', startedAt: status === 'queued' ? null : '2026-09-14T00:00:01Z', result: status === 'completed' ? { ok: true } : null }), { mode: 0o600 }); }
  let calls = 0; const jobs = createOpportunityJobs({ dataDir, handlers: { check: async () => { calls++; } }, env: {} });
  t.after(async () => { await jobs.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  for (const old of ['running', 'queued']) { const job = await jobs.get(ids[old]); assert.equal(job.status, 'interrupted'); assert.equal(job.error.code, 'JOB_INTERRUPTED'); assert.ok(job.finishedAt); }
  assert.equal((await jobs.get(ids.completed)).status, 'completed'); assert.equal(calls, 0); assert.equal((await jobs.list()).length, 3);
});

test('shutdown interrupts running and queued jobs and stops new submissions', async t => {
  const signals = [];
  const { jobs } = await fixture(t, { check: async (_input, { signal }) => { signals.push(signal); return new Promise(() => {}); } });
  const all = await Promise.all([1, 2, 3].map(id => jobs.submit('check', { id })));
  await until(jobs, all[1].id, ['running']); await jobs.close();
  assert.ok(signals.every(signal => signal.aborted));
  for (const row of all) assert.equal((await jobs.get(row.id)).status, 'interrupted');
  await assert.rejects(jobs.submit('check', { again: true }), { code: 'JOB_STOPPED', status: 503 });
});

test('invalid kinds, unsafe IDs and oversized inputs do not invoke handlers', async t => {
  let calls = 0; const { jobs } = await fixture(t, { check: async () => { calls++; } });
  await assert.rejects(jobs.submit('constructor'), { code: 'JOB_KIND' }); await assert.rejects(jobs.submit('../check'), { code: 'JOB_KIND' });
  await assert.rejects(jobs.get('../../secret'), { code: 'JOB_ID' });
  await assert.rejects(jobs.submit('check', { value: 'x'.repeat(300 * 1024) }), { code: 'JOB_INPUT' });
  const cyclic = {}; cyclic.self = cyclic; await assert.rejects(jobs.submit('check', cyclic), { code: 'JOB_INPUT' });
  assert.equal(await jobs.get(randomUUID()), null); assert.equal(calls, 0);
});

test('oversized results become a bounded failed job', async t => {
  const { jobs, dataDir } = await fixture(t, { check: async () => ({ text: 'x'.repeat(3 * 1024 * 1024) }) });
  const done = await until(jobs, (await jobs.submit('check')).id);
  assert.equal(done.status, 'failed'); assert.equal(done.error.code, 'JOB_RESULT_LIMIT'); assert.equal(done.result, undefined);
  assert.ok((await fs.stat(path.join(dataDir, 'opportunity-jobs', `${done.id}.json`))).size < 3000);
});

test('retention is limited to 100 files and prunes old completed jobs', async t => {
  const { jobs, dataDir } = await fixture(t, { check: async input => input });
  const ids = [];
  for (let index = 0; index < 104; index++) { const job = await jobs.submit('check', { index }); ids.push(job.id); await until(jobs, job.id); }
  assert.equal((await jobs.list()).length, 100); assert.equal((await fs.readdir(path.join(dataDir, 'opportunity-jobs'))).length, 100);
  assert.equal(await jobs.get(ids[0]), null); assert.equal((await jobs.get(ids.at(-1))).status, 'completed');
});

test('retention limits total JSON storage to ten MiB', async t => {
  const { jobs, dataDir } = await fixture(t, { check: async () => ({ text: 'x'.repeat(1900 * 1024) }) });
  for (let index = 0; index < 7; index++) await until(jobs, (await jobs.submit('check', { index })).id);
  const filenames = await fs.readdir(path.join(dataDir, 'opportunity-jobs'));
  let total = 0; for (const name of filenames) total += (await fs.stat(path.join(dataDir, 'opportunity-jobs', name))).size;
  assert.ok(total <= 10 * 1024 * 1024); assert.ok(filenames.length < 7);
});

test('symlinked job files are rejected without reading or changing their target', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-opportunity-symlink-')); const directory = path.join(dataDir, 'opportunity-jobs'); await fs.mkdir(directory);
  const target = path.join(dataDir, 'target.txt'); await fs.writeFile(target, 'private target'); await fs.symlink(target, path.join(directory, `${randomUUID()}.json`));
  const jobs = createOpportunityJobs({ dataDir, handlers: {}, env: {} });
  t.after(async () => { await fs.rm(dataDir, { recursive: true, force: true }); });
  await assert.rejects(jobs.list(), { code: 'JOB_STORAGE' }); assert.equal(await fs.readFile(target, 'utf8'), 'private target');
});
