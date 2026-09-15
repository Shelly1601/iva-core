import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCreatorService } from '../creator/service.js';
import { createCreatorStore } from '../creator/store.js';
import { snapshotCreatorSources, normalizeExactSnippet, checkCreatorOriginality } from '../creator/sources.js';
import { exportCreatorProduct } from '../creator/export.js';
import { createCreatorLanding } from '../creator/landing.js';
import { createWebsiteService } from '../websites/service.js';

const plan = { positioning: 'Eigene Planung für ein konstruktives Jahresgespräch.', promise: 'Die Leser führen nach dem Training ein strukturiertes Gespräch.', approach: 'Zunächst formulieren sie ihr Ziel, prüfen dann eine konkrete Situation und planen anschließend kleine nächste Schritte.', learningObjectives: ['Ein realistisches Gesprächsziel formulieren'], differentiation: ['Eigene Fallstudie und praktische Reflexion'], limitations: ['Kein Ersatz für individuelle Beratung'], sourceIds: [] };
const paragraph = 'Beginne mit einer stillen Beobachtung deiner aktuellen Arbeitsweise. Schreibe zuerst einen konkreten Anlass auf und beschreibe, was sich daran erkennen lässt. Wähle anschließend eine kleine Veränderung, die sich in einem Gespräch verständlich erläutern lässt. Prüfe anhand einer Rückfrage, ob dein Gegenüber dieselbe Situation vor Augen hat. Halte das Ergebnis nachvollziehbar fest und trenne deine Annahmen von überprüften Aussagen. ';
function unit(input) { return { title: input.unit.title, content: paragraph.repeat(input.product.type === 'book' ? 5 : 3), examples: ['Fiktives Beispiel: Lea beobachtet zwei unklare Übergaben und vereinbart eine konkrete Rückfrage.'], exercises: ['Notiere eine Beobachtung, formuliere eine Rückfrage und prüfe, ob eine andere Person die Situation versteht.'], sourceIds: [], exactSnippetIds: [] }; }
const generator = async ({ stage, input }) => ({ data: stage === 'plan' ? plan : stage === 'outline' ? { outline: Array.from({ length: input.product.unitCount }, (_, i) => ({ title: `Eigene Einheit ${i + 1}`, objective: `Ein klares und umsetzbares Ergebnis für die Phase ${i + 1} erarbeiten.`, sourceIds: [] })) } : unit(input), model: 'fixture:verified', sourceUsage: [] });
async function fixture(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-creator-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const dependencies = { dataDir, getProject: async id => ['alpha', 'beta'].includes(id) ? { id, name: id } : null, getKnowledgeEntry: async id => ({ id, title: 'Synthetische Quelle', status: 'ready', content: 'Ein seltenes Quellenbeispiel enthält eine eigens erfundene Reihe unverwechselbarer Wörter für den Test unserer Übernahmeprüfung.', sourceOwner: 'own', url: 'https://example.org/source' }), getOpportunity: async id => ({ id, title: 'Radar-Idee', summary: 'Eine bewusst synthetische und nicht veröffentlichte Kursidee.', research: { sources: [{ id: 'R1', url: 'https://example.org/evidence', text: 'Ein tatsächlicher Testbeleg aus dem Radar.' }] } }), generate: generator, ...overrides };
  const service = createCreatorService(dependencies), scope = { projectId: 'alpha' };
  const product = await service.create(scope, { type: 'course', title: 'Eigener Gesprächskurs', brief: 'Eine eigene praktische Methode für nachvollziehbare Gespräche entwickeln.', audience: 'Selbstständige', unitCount: 4 });
  return { dataDir, dependencies, service, scope, product };
}
async function done(service, scope, job) { for (let i = 0; i < 400; i++) { const state = await service.getJob(scope, job.id); if (!['queued', 'running'].includes(state.status)) return state; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Fixture job did not finish'); }

test('creation is project bound and idempotent; unsafe identifiers and URLs fail', async t => {
  const { service, scope, product } = await fixture(t);
  await assert.rejects(service.get({ projectId: 'beta' }, product.id), { status: 404 });
  await assert.rejects(service.list({ projectId: '__proto__' }));
  const input = { type: 'book', title: 'Buch', brief: 'Ein eigenständiges Buch entwickeln.', unitCount: 4, idempotencyKey: 'retry-1' };
  const a = await service.create(scope, input), b = await service.create(scope, input); assert.equal(a.id, b.id);
  await assert.rejects(service.create(scope, { ...input, title: 'Anderes Buch' }), { status: 409 });
  await assert.rejects(service.update(scope, product.id, { salesLinks: [{ label: 'Test', url: 'https://user:secret@example.org/' }] }));
});

test('selected sources are immutable snapshots; default KB ownership is not rights proof', async t => {
  const { service, scope, product, dependencies } = await fixture(t);
  const result = await service.addSources(scope, product.id, { knowledgeIds: ['kb1'], opportunityIds: ['radar1'] });
  assert.equal(result.sources.length, 2); assert.equal(result.sources[0].rights.status, 'unconfirmed'); assert.equal(result.sources[0].id, 'S1');
  const job = await done(service, scope, await service.startJob(scope, product.id, { mode: 'outline' })); assert.equal(job.status, 'completed');
  const original = (await service.get(scope, product.id)).latestVersion;
  assert.match(original.sourceSnapshots[1].content, /research/); assert.match(original.sourceSnapshots[1].content, /R1/);
  await service.addSources(scope, product.id, { sourceRights: [{ sourceId: 'S1', usage: 'own', rightsConfirmed: true, rightsBasis: 'Eigene Testunterlagen selbst verfasst' }] });
  assert.equal((await service.get(scope, product.id)).sources[0].rights.status, 'user-confirmed');
  assert.equal((await service.get(scope, product.id)).latestVersion.sourceSnapshots[0].rights.status, 'unconfirmed');
  await assert.rejects(service.exportData(scope, product.id, { versionId: original.id }), { status: 409 });
  await assert.rejects(snapshotCreatorSources({ knowledgeIds: ['kb'] }, { ...dependencies, projectId: 'alpha', getKnowledgeEntry: async () => ({ status: 'ready', projectId: 'beta', content: paragraph }) }), { status: 404 });
});

test('quotation budget is per original source and exact location is required', async t => {
  const { service, scope, product } = await fixture(t);
  await service.addSources(scope, product.id, { knowledgeIds: ['kb1', 'kb2'] });
  const text = 'Ein seltenes Quellenbeispiel enthält eine eigens erfundene Reihe unverwechselbarer Wörter';
  const snippet = await service.addExactSnippet(scope, product.id, { sourceId: 'S1', text, usage: 'quotation', attribution: 'Testautor', locator: 'Absatz 1' }); assert.equal(snippet.wordCount, 10);
  const p = await service.get(scope, product.id); assert.equal(p.snippets.length, 1);
  const source = (await snapshotCreatorSources({ knowledgeIds: ['kb1'] }, { getKnowledgeEntry: async () => ({ status: 'ready', content: paragraph }) }))[0];
  assert.throws(() => normalizeExactSnippet({ sourceId: 'S1', text: paragraph, usage: 'licensed', rightsConfirmed: false, attribution: 'A', locator: 'B' }, [source]));
  assert.throws(() => normalizeExactSnippet({ sourceId: 'S1', text: 'Erfunden und nicht vorhanden', usage: 'quotation', attribution: 'A', locator: 'B' }, [source]));
  const short = { id: 'q', sourceId: 'S1', text, usage: 'quotation', attribution: 'Testautor', locator: 'Absatz 1' };
  assert.throws(() => checkCreatorOriginality([{ content: (`> ${text}\n> — Testautor (Absatz 1)\n`).repeat(3), exactSnippetIds: ['q'] }], [{ id: 'S1', type: 'knowledge', originalId: 'a', content: text }], [short]), /25 Wörter/);
});

test('full generation persists concept, outline, each complete unit and ready immutable export', async t => {
  const { service, scope, product } = await fixture(t);
  const first = await service.startJob(scope, product.id), same = await service.startJob(scope, product.id); assert.equal(first.id, same.id);
  const job = await done(service, scope, first); assert.equal(job.status, 'completed'); assert.equal(job.completedUnits, 4); assert.deepEqual(job.models, ['fixture:verified']);
  const p = await service.get(scope, product.id); assert.equal(p.status, 'ready'); assert.equal(p.versions.length, 7); assert.equal(p.latestVersion.stage, 'complete');
  const exported = await service.exportData(scope, product.id); assert.equal(exported.product.status, 'ready'); assert.equal(exported.version.units.length, 4);
  await assert.rejects(service.getJob({ projectId: 'beta' }, first.id), { status: 404 });
});

test('failed generation preserves prior unit and resume generates only missing units', async t => {
  let failed = false; const seen = [];
  const f = await fixture(t, { generate: async args => { if (args.stage === 'unit') { seen.push(args.input.unit.id); if (args.input.unit.id === 'unit-2' && !failed) { failed = true; throw new Error('secret-provider-token-DO-NOT-PERSIST'); } } return generator(args); } });
  const initial = await done(f.service, f.scope, await f.service.startJob(f.scope, f.product.id)); assert.equal(initial.status, 'failed'); assert.equal(initial.completedUnits, 1);
  assert.equal(JSON.stringify(await f.service.get(f.scope, f.product.id)).includes('secret-provider-token'), false);
  const resumed = await done(f.service, f.scope, await f.service.startJob(f.scope, f.product.id, { mode: 'resume' })); assert.equal(resumed.status, 'completed'); assert.equal(seen.filter(id => id === 'unit-1').length, 1);
});

test('cancellation ignores late provider results and can resume an outline', async t => {
  let release, reached; const ready = new Promise(resolve => reached = resolve);
  const f = await fixture(t, { generate: async args => { if (args.stage === 'unit') { reached(); await new Promise(resolve => release = resolve); } return generator(args); } });
  const job = await f.service.startJob(f.scope, f.product.id); await ready;
  await f.service.cancelJob(f.scope, job.id); release(); await new Promise(resolve => setTimeout(resolve, 30));
  const result = await f.service.getJob(f.scope, job.id); assert.equal(result.status, 'interrupted'); assert.equal(result.completedUnits, 0);
  assert.equal((await f.service.get(f.scope, f.product.id)).latestVersion.stage, 'outline');
});

test('timeout returns interrupted without waiting for a provider that ignores abort', async t => {
  const f = await fixture(t, { timeoutMs: 20, generate: async () => new Promise(() => {}) });
  const result = await done(f.service, f.scope, await f.service.startJob(f.scope, f.product.id)); assert.equal(result.status, 'interrupted');
});

test('source overlap never becomes a saved unit or complete product', async t => {
  const f = await fixture(t, { getKnowledgeEntry: async () => ({ status: 'ready', content: paragraph }), generate: generator });
  await f.service.addSources(f.scope, f.product.id, { knowledgeIds: ['source'] });
  const result = await done(f.service, f.scope, await f.service.startJob(f.scope, f.product.id)); assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'CREATOR_SOURCE_OVERLAP'); assert.equal(result.completedUnits, 0);
});

test('manual edits are new complete versions and stale saves are rejected', async t => {
  const f = await fixture(t); await done(f.service, f.scope, await f.service.startJob(f.scope, f.product.id));
  const before = (await f.service.get(f.scope, f.product.id)).latestVersion, units = structuredClone(before.units); units[0].content += '\n\nEin zusätzlicher eigener Reflexionsschritt.';
  await f.service.update(f.scope, f.product.id, { baseVersionId: before.id, units });
  const after = (await f.service.get(f.scope, f.product.id)).latestVersion; assert.notEqual(after.id, before.id); assert.equal(after.edited, true);
  assert.equal((await f.service.exportData(f.scope, f.product.id, { versionId: before.id })).version.units[0].content, before.units[0].content);
  await assert.rejects(f.service.update(f.scope, f.product.id, { baseVersionId: before.id, units }), { status: 409 });
});

test('crashed persisted jobs become interrupted with honest checkpoint', async t => {
  const f = await fixture(t), store = createCreatorStore(f.dependencies);
  await store.mutate('alpha', state => { state.jobs.push({ id: 'dead-job', projectId: 'alpha', productId: f.product.id, status: 'running', ownerPid: 99999999, createdAt: new Date().toISOString(), completedUnits: 0 }); state.products[0].status = 'generating'; });
  assert.equal((await f.service.getJob(f.scope, 'dead-job')).status, 'interrupted'); assert.equal((await f.service.get(f.scope, f.product.id)).status, 'incomplete');
});

test('store refuses symlink data file and source counts are bounded', async t => {
  const f = await fixture(t); const target = path.join(f.dataDir, 'outside.json'), file = path.join(f.dataDir, 'creator', 'beta.json'); await fs.writeFile(target, '{}'); await fs.symlink(target, file);
  await assert.rejects(f.service.list({ projectId: 'beta' }), { status: 503 });
  await assert.rejects(f.service.addSources(f.scope, f.product.id, { knowledgeIds: Array.from({ length: 13 }, (_, i) => `source${i}`) }));
});

test('approved exact snippets are included once despite a model omitting them', async t => {
  const f = await fixture(t); await f.service.addSources(f.scope, f.product.id, { knowledgeIds: ['own-source'] });
  const snippet = await f.service.addExactSnippet(f.scope, f.product.id, { sourceId: 'S1', text: 'Ein seltenes Quellenbeispiel enthält eine eigens erfundene Reihe unverwechselbarer Wörter', usage: 'quotation', attribution: 'Synthetischer Testautor', locator: 'Absatz 1' });
  const job = await done(f.service, f.scope, await f.service.startJob(f.scope, f.product.id)); assert.equal(job.status, 'completed');
  const exported = await f.service.exportData(f.scope, f.product.id), units = exported.version.units;
  assert.equal(units.filter(u => u.exactSnippetIds.includes(snippet.id)).length, 1); assert.equal(units.map(u => u.content).join('\n').split(snippet.text).length - 1, 1);
  const edited = structuredClone(units); edited[0].content = paragraph.repeat(3); edited[0].exactSnippetIds = [];
  await assert.rejects(f.service.update(f.scope, f.product.id, { baseVersionId: exported.version.id, units: edited }), { code: 'CREATOR_SNIPPET_MISSING' });
});

test('sales links alone preserve ready content in a new immutable version', async t => {
  const f = await fixture(t); await done(f.service, f.scope, await f.service.startJob(f.scope, f.product.id));
  const before = await f.service.exportData(f.scope, f.product.id);
  await f.service.update(f.scope, f.product.id, { salesLinks: [{ label: 'Shop', url: 'https://example.org/shop' }] });
  const after = await f.service.exportData(f.scope, f.product.id); assert.equal(after.product.status, 'ready'); assert.notEqual(after.version.id, before.version.id); assert.deepEqual(after.version.units, before.version.units); assert.equal(after.product.salesLinks[0].url, 'https://example.org/shop');
  assert.deepEqual((await f.service.exportData(f.scope, f.product.id, { versionId: before.version.id })).product.salesLinks, []);
});

test('invalid schema receives one concrete repair and then completes', async t => {
  let attempts = 0, feedback = '';
  const f = await fixture(t, { generate: async args => { if (args.stage === 'outline') { attempts++; if (attempts === 1) return { data: { outline: [] }, model: 'fixture:verified' }; feedback = args.input.instruction; } return generator(args); } });
  const job = await done(f.service, f.scope, await f.service.startJob(f.scope, f.product.id)); assert.equal(job.status, 'completed'); assert.equal(attempts, 2); assert.equal(job.repairAttempts, 1); assert.match(feedback, /genau 4 vollständige Einheiten/);
});

test('resume before the first checkpoint retries only the first unfinished stage', async t => {
  let failure = true;
  const f = await fixture(t, { generate: async args => { if (failure) { failure = false; throw new Error('offline'); } return generator(args); } });
  assert.equal((await done(f.service, f.scope, await f.service.startJob(f.scope, f.product.id))).status, 'failed');
  assert.equal((await done(f.service, f.scope, await f.service.startJob(f.scope, f.product.id, { mode: 'resume' }))).status, 'completed');
});

test('independent process transactions retain each product without lost updates', async t => {
  const f = await fixture(t), moduleUrl = new URL('../creator/store.js', import.meta.url).href;
  const script = `import {createCreatorStore} from ${JSON.stringify(moduleUrl)}; const s=createCreatorStore({dataDir:process.argv[1],getProject:async id=>({id})}); await s.mutate('alpha', state=>{state.products.push({id:process.argv[2],versions:[]});});`;
  await Promise.all(Array.from({ length: 4 }, (_, i) => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, f.dataDir, `parallel-${i}`], { timeout: 10000 })));
  const state = await createCreatorStore(f.dependencies).read('alpha'); assert.equal(state.products.length, 5);
});

test('real engine versions export in all formats and build a private-source-free Studio landing', async t => {
  const f = await fixture(t);
  await f.service.addSources(f.scope, f.product.id, { knowledgeIds: ['reference'] });
  const snippet = await f.service.addExactSnippet(f.scope, f.product.id, { sourceId: 'S1', text: 'Ein seltenes Quellenbeispiel enthält eine eigens erfundene Reihe unverwechselbarer Wörter', usage: 'quotation', attribution: 'Synthetischer Autor', locator: 'Absatz 1' });
  assert.equal((await done(f.service, f.scope, await f.service.startJob(f.scope, f.product.id))).status, 'completed');
  await f.service.update(f.scope, f.product.id, { salesLinks: [{ label: 'Kursangebot', url: 'https://example.org/kurs' }] });
  const data = await f.service.exportData(f.scope, f.product.id);
  for (const format of ['md', 'pdf', 'zip']) {
    const artifact = await exportCreatorProduct({ ...data, format }); assert.ok(artifact.buffer.length > 1000); assert.ok(artifact.filename.endsWith(`.${format}`));
    if (format === 'md') { assert.match(artifact.buffer.toString(), /Synthetischer Autor/); assert.ok(artifact.buffer.toString().includes(snippet.text)); assert.ok(!artifact.buffer.toString().includes('für den Test unserer Übernahmeprüfung')); }
    if (format === 'pdf') assert.equal(artifact.buffer.subarray(0, 5).toString(), '%PDF-');
    if (format === 'zip') assert.equal(artifact.buffer.subarray(0, 2).toString(), 'PK');
  }
  const websites = createWebsiteService({ dataDir: f.dataDir, getProject: f.dependencies.getProject, listProjects: async () => [{ id: 'alpha', name: 'Alpha' }], env: {} });
  const landing = createCreatorLanding({ service: f.service, websiteService: websites });
  const result = await landing(f.scope, f.product.id), preview = await websites.preview('alpha', result.site.id);
  assert.equal(preview.status, 'ready'); assert.equal(result.published, false); assert.match(preview.html, /https:\/\/example.org\/kurs/); assert.ok(!preview.html.includes(snippet.text)); assert.ok(!preview.html.includes('für den Test unserer Übernahmeprüfung')); assert.match(preview.html, /Eigene Einheit 4/);
  assert.equal((await landing(f.scope, f.product.id)).site.id, result.site.id);
});
