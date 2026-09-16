import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createKnowledgeResearchService } from '../knowledge/research-service.js';
import { researchHash } from '../knowledge/research-executor.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-knowledge-research-'));
const sourceText = 'Solarenergie bietet vielfältige Anwendungen für Gebäude und Unternehmen. Öffentlich zugängliche Fachinformationen erläutern technische Grundlagen, wirtschaftliche Rahmenbedingungen, geeignete Dachflächen und sinnvolle Planungsschritte. Fachleute prüfen den Energiebedarf, vergleichen konkrete Angebote, dokumentieren Annahmen und berücksichtigen regionale Unterschiede. Die sorgfältige Auswertung verschiedener Quellen hilft bei der Auswahl und zeigt offene Fragen auf. Verlässliche Aussagen benötigen nachvollziehbare Belege und einen aktuellen Prüfzeitpunkt.';
const quote = 'Solarenergie bietet vielfältige Anwendungen für Gebäude und Unternehmen.';
function fixture(options = {}) {
  let clock = Date.parse('2026-09-16T08:00:00Z'), calls = { search: 0, read: 0, model: 0, create: 0, update: 0 }, entries = new Map();
  const file = path.join(root, randomUUID(), 'research.json');
  const knowledge = {
    async list({ query }) { return [...entries.values()].filter(row => row.notes.includes(query)); },
    async get(id) { return structuredClone(entries.get(id) || null); },
    async create(input) { calls.create++; const row = { id: randomUUID(), ...structuredClone(input), status: 'ready' }; entries.set(row.id, row); return structuredClone(row); },
    async update(id, input, opts) {
      calls.update++; const old = entries.get(id);
      if (researchHash(old.content) !== opts.expectedContentHash) throw Object.assign(new Error('Manuelle Änderung'), { code: 'KNOWLEDGE_RESEARCH_CONFLICT', status: 409 });
      const row = { ...old, ...structuredClone(input) }; entries.set(id, row); return structuredClone(row);
    },
  };
  const deps = { file, env: {}, now: () => clock, knowledge,
    async search() { calls.search++; return [{ url: 'https://www.example.com/solar', title: 'Solarenergie' }]; },
    async read(url) { calls.read++; return { url, title: 'Solarenergie', text: sourceText }; },
    async synthesize() { calls.model++; return { title: 'Solarenergie verstehen', findings: [{ text: 'Solarenergie kann für unterschiedliche Anwendungen in Gebäuden und Unternehmen genutzt werden.', sourceId: 'S1', quote }] }; },
    ...options,
  };
  return { file, deps, calls, entries, knowledge, service: createKnowledgeResearchService(deps), time(value) { clock = Date.parse(value); } };
}
async function done(f, plan) { await f.service.tick(); return (await f.service.list()).find(row => row.id === plan.id); }

test('once is durable before ACK, requestId retries and run double-click do not duplicate', async () => {
  const f = fixture(), requestId = randomUUID();
  const plan = await f.service.create({ topic: 'Solarenergie', requestId });
  assert.equal(plan.latestRun.status, 'queued'); assert.equal(f.calls.search, 0);
  assert.equal(JSON.parse(await fs.readFile(f.file)).plans[0].latestRun.id, plan.latestRun.id);
  assert.equal((await f.service.create({ topic: 'Solarenergie', requestId })).id, plan.id);
  await assert.rejects(f.service.create({ topic: 'Anderes Thema', requestId }), { status: 409 });
  assert.equal((await f.service.runNow(plan.id)).latestRun.id, plan.latestRun.id);
  const result = await done(f, plan);
  assert.equal(result.latestRun.status, 'succeeded'); assert.equal(f.entries.size, 1); assert.equal(f.calls.model, 1);
  const entry = f.entries.get(result.knowledgeEntryId);
  assert.equal(entry.sourceOwner, 'public-reference'); assert.match(entry.content, /https:\/\/www.example.com\/solar/);
  assert.ok(!JSON.stringify(result).includes(sourceText));
  assert.ok(!String(await fs.readFile(f.file)).includes(sourceText));
});

test('unchanged sources skip model and KB write; changed source preserves bounded versions', async () => {
  const f = fixture(), plan = await f.service.create({ topic: 'Solarenergie' });
  await done(f, plan); await f.service.runNow(plan.id);
  let current = await done(f, plan);
  assert.equal(current.latestRun.status, 'unchanged'); assert.equal(f.calls.model, 1); assert.equal(f.calls.update, 0); assert.equal(current.versions.length, 1);
  f.deps.read = async url => ({ url, title: 'Solarenergie', text: sourceText + ' Ergänzung: Veränderte Rahmenbedingungen können die Bewertung beeinflussen.' });
  f.service = createKnowledgeResearchService(f.deps); await f.service.runNow(plan.id); current = await done(f, plan);
  assert.equal(current.latestRun.status, 'succeeded'); assert.equal(f.calls.model, 2); assert.equal(f.calls.update, 1);
  assert.equal(f.entries.size, 1); assert.equal(current.versions.length, 2);
});

test('recurring schedules wait for slot, coalesce missed slots and tick runs at most one plan', async () => {
  const f = fixture();
  const a = await f.service.create({ topic: 'Solarenergie', schedule: { frequency: 'daily', time: '09:00' } });
  const b = await f.service.create({ topic: 'Solarenergie zwei', schedule: { frequency: 'weekly', weekday: 4, time: '09:00' } });
  assert.equal(a.latestRun, null); assert.equal(a.nextRunAt, '2026-09-17T07:00:00.000Z');
  assert.deepEqual(await f.service.tick(), { worked: false });
  f.time('2026-09-25T12:00:00Z'); await f.service.tick();
  const rows = await f.service.list(); assert.equal(rows.filter(p => p.latestRun?.status === 'succeeded').length, 1);
  assert.equal(rows.filter(p => p.latestRun?.status === 'queued').length, 1);
  assert.equal(rows.find(p => p.id === a.id).nextRunAt, '2026-09-26T07:00:00.000Z');
  assert.equal(rows.find(p => p.id === b.id).nextRunAt, '2026-10-01T07:00:00.000Z');
});

test('pause cancels queued run, resume/criteria edits do not silently rerun once', async () => {
  const f = fixture(), plan = await f.service.create({ topic: 'Solarenergie' });
  await f.service.update(plan.id, { enabled: false });
  assert.deepEqual(await f.service.tick(), { worked: false });
  await assert.rejects(f.service.runNow(plan.id), { status: 409 });
  await f.service.update(plan.id, { enabled: true }); assert.deepEqual(await f.service.tick(), { worked: false });
  await f.service.runNow(plan.id); const completed = await done(f, plan);
  const edited = await f.service.update(plan.id, { topic: 'Neue Solarenergie' });
  assert.equal(edited.latestRun.id, completed.latestRun.id); assert.equal(edited.knowledgeEntryId, completed.knowledgeEntryId);
  assert.deepEqual(await f.service.tick(), { worked: false });
});

test('pause during source read stops publication even when injected reader ignores abort', async () => {
  let release, entered;
  const started = new Promise(r => { entered = r; }), blocked = new Promise(r => { release = r; });
  const f = fixture({ read: async url => { entered(); await blocked; return { url, title: 'Solarenergie', text: sourceText }; } });
  const plan = await f.service.create({ topic: 'Solarenergie' }), running = f.service.tick();
  await started; await f.service.update(plan.id, { enabled: false }); release();
  await running; await new Promise(r => setTimeout(r, 10));
  assert.equal(f.entries.size, 0); assert.equal((await f.service.list())[0].latestRun.status, 'canceled');
});

test('concurrent ticks claim once and restart sees durable queued run', async () => {
  const f = fixture(), plan = await f.service.create({ topic: 'Solarenergie' });
  const other = createKnowledgeResearchService(f.deps);
  const results = await Promise.all([f.service.tick(), other.tick()]);
  assert.equal(results.filter(r => r.worked).length, 1); assert.equal(f.calls.model, 1);
  assert.equal((await other.list())[0].id, plan.id);
});

test('unread snippets and ungrounded synthesis never create learned knowledge', async () => {
  for (const options of [
    { read: async url => ({ url, title: 'Login', text: 'Suchsnippet mit angeblichem Wissen.' }) },
    { synthesize: async () => ({ findings: [{ text: 'Erfundene fachliche Aussage ohne Beleg.', sourceId: 'S1', quote: 'Dieser Beleg steht nicht in der Quelle.' }] }) },
  ]) {
    const f = fixture(options), plan = await f.service.create({ topic: 'Solarenergie' });
    const current = await done(f, plan); assert.equal(current.latestRun.status, 'failed'); assert.equal(f.entries.size, 0);
    assert.deepEqual(await f.service.tick(), { worked: false });
  }
});

test('domain, redirected domain, keyword and excluded-term filters apply to actual contents', async () => {
  for (const input of [ { domains: ['other.example.com'] }, { keywords: ['Windkraft'] }, { excludeTerms: ['Energiebedarf'] } ]) {
    const f = fixture(), plan = await f.service.create({ topic: 'Solarenergie', ...input });
    assert.equal((await done(f, plan)).latestRun.status, 'failed'); assert.equal(f.entries.size, 0);
  }
  const f = fixture({ read: async () => ({ url: 'https://other.example.com/x', title: 'Solarenergie', text: sourceText }) });
  const plan = await f.service.create({ topic: 'Solarenergie', domains: ['example.net'] });
  assert.equal((await done(f, plan)).latestRun.status, 'failed');
});

test('missing providers report failure without retries or false learning', async () => {
  const f = fixture({ search: undefined, synthesize: undefined }), plan = await f.service.create({ topic: 'Solarenergie' });
  assert.equal((await f.service.capabilities()).ready, false);
  assert.equal((await done(f, plan)).latestRun.status, 'failed'); assert.equal(f.entries.size, 0);
  assert.deepEqual(await f.service.tick(), { worked: false });
});

test('stale running work is interrupted on restart, never automatically repeats paid calls', async () => {
  const f = fixture(), plan = await f.service.create({ topic: 'Solarenergie' });
  const state = JSON.parse(await fs.readFile(f.file));
  Object.assign(state.plans[0].latestRun, { status: 'running', ownerPid: 99999999, leaseId: randomUUID(), deadlineAt: '2026-01-01T00:00:00Z' });
  await fs.writeFile(f.file, JSON.stringify(state));
  assert.deepEqual(await f.service.tick(), { worked: false });
  assert.equal((await f.service.list())[0].latestRun.status, 'interrupted'); assert.equal(f.calls.search, 0);
  await f.service.runNow(plan.id); assert.equal((await done(f, plan)).latestRun.status, 'succeeded');
});

test('uncertain KB write uses marker recovery, never duplicate model calls or entries', async () => {
  const f = fixture(), original = f.knowledge.create;
  f.knowledge.create = async input => { await original(input); throw new Error('response lost'); };
  const plan = await f.service.create({ topic: 'Solarenergie' });
  assert.equal((await done(f, plan)).latestRun.status, 'interrupted'); assert.equal(f.entries.size, 1);
  await f.service.runNow(plan.id); assert.equal((await done(f, plan)).latestRun.status, 'succeeded');
  assert.equal(f.entries.size, 1); assert.equal(f.calls.model, 1); assert.equal(f.calls.create, 1);
});

test('restart after KB write before finalization only reads publication marker', async () => {
  const f = fixture(), original = f.knowledge.create;
  f.knowledge.create = async input => { await original(input); throw new Error('crash'); };
  const plan = await f.service.create({ topic: 'Solarenergie' }); await done(f, plan);
  const state = JSON.parse(await fs.readFile(f.file));
  Object.assign(state.plans[0].latestRun, { status: 'running', ownerPid: 99999999, deadlineAt: '2026-01-01T00:00:00Z' });
  await fs.writeFile(f.file, JSON.stringify(state));
  f.service = createKnowledgeResearchService(f.deps);
  assert.equal((await done(f, plan)).latestRun.status, 'succeeded'); assert.equal(f.calls.model, 1); assert.equal(f.calls.create, 1);
});

test('a late KB write cannot falsely report success after deadline', async () => {
  const f = fixture({ timeoutMs: 50 }), original = f.knowledge.create;
  f.knowledge.create = async input => { await new Promise(r => setTimeout(r, 100)); return original(input); };
  const plan = await f.service.create({ topic: 'Solarenergie' });
  const result = await done(f, plan);
  assert.equal(result.latestRun.status, 'interrupted'); assert.equal(result.knowledgeEntryId, null);
  assert.equal(f.entries.size, 1);
  await f.service.runNow(plan.id);
  assert.equal((await done(f, plan)).latestRun.status, 'succeeded');
  assert.equal(f.calls.create, 1); assert.equal(f.calls.model, 1);
});

test('an archived marker after an uncertain write is not recreated on retry', async () => {
  const f = fixture(), original = f.knowledge.create;
  f.knowledge.list = async ({ query, status }) => [...f.entries.values()].filter(row => row.notes.includes(query) && (status ? row.status === status : row.status !== 'archived'));
  f.knowledge.create = async input => { const row = await original(input); f.entries.get(row.id).status = 'archived'; throw new Error('write response lost'); };
  const plan = await f.service.create({ topic: 'Solarenergie' }); await done(f, plan);
  await f.service.runNow(plan.id);
  assert.equal((await done(f, plan)).latestRun.status, 'interrupted');
  assert.equal(f.entries.size, 1); assert.equal(f.calls.create, 1); assert.equal(f.calls.model, 1);
});

test('manual edits are preserved and corrupted research state is never silently reset', async () => {
  const f = fixture(), plan = await f.service.create({ topic: 'Solarenergie' });
  const first = await done(f, plan); f.entries.get(first.knowledgeEntryId).content = 'Manuell verfasster Inhalt';
  await f.service.runNow(plan.id); assert.equal((await done(f, plan)).latestRun.status, 'failed');
  assert.equal(f.entries.get(first.knowledgeEntryId).content, 'Manuell verfasster Inhalt');
  await fs.writeFile(f.file, '{defekt'); await assert.rejects(f.service.list());
  await assert.rejects(f.service.create({ topic: 'Neu' })); assert.equal(await fs.readFile(f.file, 'utf8'), '{defekt');
});

test('deadline bounds an ignoring source and late result cannot publish', async () => {
  const f = fixture({ timeoutMs: 30, read: async url => { await new Promise(r => setTimeout(r, 100)); return { url, title: 'Solarenergie', text: sourceText }; } });
  const plan = await f.service.create({ topic: 'Solarenergie' });
  assert.equal((await done(f, plan)).latestRun.status, 'failed');
  await new Promise(r => setTimeout(r, 120)); assert.equal(f.entries.size, 0);
});

test.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
