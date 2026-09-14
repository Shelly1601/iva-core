import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWebsiteZip, readWebsiteZip } from '../websites/archive.js';
import { generateWebsite, parseWebsiteGeneration, classifyWebsiteMessage } from '../websites/generate.js';

const htmlFile = content => [{ path: 'index.html', encoding: 'utf8', content }];
const compiled = files => ({ html: files.find(file => file.path === 'index.html').content, status: 'ready', errors: [], warnings: [] });
async function fixture(t, overrides = {}) {
  const { createWebsiteService } = await import('../websites/service.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'iva-website-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projects = [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }];
  const config = {
    dataDir: root, getProject: async id => projects.find(project => project.id === id) || null, listProjects: async () => projects,
    env: { IVA_PROJECT_CONNECTIONS_KEY: Buffer.alloc(32, 9).toString('base64'), IVA_WEBSITE_HOST_ORIGIN: 'https://websites.example.org', IVA_CORE_ORIGIN: 'https://iva.example.org', IVA_WEBSITE_PUBLISH_KEY: 'fixture-publish-key' },
    compile: async files => compiled(files),
    generate: async ({ message }) => ({ summary: message, files: htmlFile('<h1>Generated</h1>'), model: { key: 'fixture:model', provider: 'fixture', modelId: 'model' } }),
    importUrl: async () => ({ files: htmlFile('<h1>Imported</h1>'), source: { type: 'url', url: 'https://example.org/' }, warnings: [] }),
    referenceReader: async url => ({ url, title: 'Reference', text: 'Design reference' }),
    fetchImpl: async () => ({ ok: true, headers: new Headers() }), dnsCname: async () => [], ...overrides,
  };
  return { root, config, service: createWebsiteService(config), createWebsiteService };
}
async function createSite(service, projectId = 'alpha') { return service.create({ projectId, name: 'Test website' }); }
async function within(promise, ms = 1500) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Test-Zeitlimit überschritten')), ms); })]); } finally { clearTimeout(timer); } }
async function eventually(read, predicate) { const deadline = Date.now() + 1500; while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Erwarteter Zustand ist nicht eingetreten.'); }

test('information questions mentioning publication, GitHub and import never cause website side effects', async t => {
  const generated = [];
  let compiles = 0, imports = 0, exports = 0, requests = 0, references = 0;
  const { service } = await fixture(t, {
    generate: async input => { generated.push(input); return { summary: 'Im Website Studio findest du dafür die passenden Schaltflächen.', files: htmlFile('<h1>Unrequested model edit</h1>') }; },
    compile: async files => { compiles++; return compiled(files); },
    importUrl: async () => { imports++; throw new Error('Unexpected import'); },
    referenceReader: async () => { references++; throw new Error('Unexpected reference'); },
    githubFactory: () => { exports++; throw new Error('Unexpected GitHub access'); },
    fetchImpl: async () => { requests++; throw new Error('Unexpected publication'); },
  });
  const site = await createSite(service);
  const first = await service.store.saveRevision('alpha', site.id, { files: htmlFile('<h1>Existing draft</h1>') });
  for (const message of ['Wie veröffentliche ich die Website?', 'Welche Schritte brauche ich, um die Website bei GitHub zu sichern?', 'Wie importiere ich meine Website https://example.org/?']) {
    await service.chat('alpha', site.id, { message, baseRevisionId: first.revision.id });
    const done = await service.waitForJob('alpha', site.id);
    assert.equal(done.job.status, 'completed');
    assert.equal(done.draftRevisionId, first.revision.id);
    assert.equal(done.publishedRevisionId, null);
    assert.equal(done.revisions.length, 1);
  }
  assert.equal(generated.length, 3); assert(generated.every(input => input.answerOnly === true));
  assert.deepEqual([compiles, imports, exports, requests, references], [0, 0, 0, 0, 0]);
  assert.equal(classifyWebsiteMessage('Was bedeutet Veröffentlichen? Erstelle anschließend eine Website.').answerOnly, true);
  assert.equal(classifyWebsiteMessage('Veröffentliche die Website').answerOnly, false);
});

test('answer-only generation answers the first question without requiring or creating source files', async t => {
  let sawAnswerPrompt = false;
  const answer = { summary: 'Du kannst eine Website importieren oder IVA deine erste Idee beschreiben.', files: [], answerOnly: true };
  const { service } = await fixture(t, { generate: input => generateWebsite({
    ...input, env: { ANTHROPIC_API_KEY: 'fixture' },
    choose: key => ({ key, provider: 'anthropic', modelId: 'claude-sonnet-4-6', model: {} }),
    check: async () => {}, reserve: async () => () => {}, record: async () => {},
    generate: async options => { sawAnswerPrompt = options.system.includes('Erzeuge und ändere keine Dateien'); return { text: JSON.stringify(answer), usage: { promptTokens: 1, completionTokens: 1 } }; },
  }) });
  const site = await createSite(service);
  await service.chat('alpha', site.id, { message: 'Was kann ich hier als Erstes machen?', baseRevisionId: null });
  const done = await service.waitForJob('alpha', site.id);
  assert.equal(done.job.status, 'completed'); assert.equal(done.draftRevisionId, null); assert.equal(done.revisions.length, 0);
  assert.equal(done.messages.at(-1).content, answer.summary); assert.equal(sawAnswerPrompt, true);
  assert.throws(() => parseWebsiteGeneration(JSON.stringify(answer)), /Quelldateien/);
  assert.throws(() => parseWebsiteGeneration(JSON.stringify({ ...answer, files: htmlFile('<h1>Must not edit</h1>') }), [], { answerOnly: true }), /ohne Website-Änderungen/);
});

test('website job completes with actual source revision while project boundaries and active locks remain enforced', async t => {
  let resolveGeneration;
  const barrier = new Promise(resolve => { resolveGeneration = resolve; });
  t.after(() => resolveGeneration());
  const { service } = await fixture(t, { generate: async () => { await barrier; return { summary: 'Built', files: htmlFile('<h1>New version</h1>'), model: { key: 'fixture:model' } }; } });
  const site = await createSite(service);
  assert.equal((await service.preview('alpha', site.id)).status, 'empty');
  const accepted = await service.chat('alpha', site.id, { message: 'Erstelle eine Website', baseRevisionId: null });
  assert.equal(accepted.status, 'queued');
  const running = await service.site('alpha', site.id);
  assert.equal(running.job.id, accepted.jobId);
  assert.ok(['queued', 'running'].includes(running.job.status));
  await assert.rejects(service.chat('alpha', site.id, { message: 'Noch eine Änderung' }), error => error.status === 409);
  await assert.rejects(service.preview('beta', site.id), error => error.status === 404);
  resolveGeneration();
  const done = await service.waitForJob('alpha', site.id);
  assert.equal(done.job.status, 'completed');
  assert.equal(done.job.executionVerified, true);
  assert.equal(done.job.revisionId, done.draftRevisionId);
  assert.match((await service.preview('alpha', site.id)).html, /New version/);
  assert.deepEqual(done.messages.map(item => item.role), ['user', 'assistant']);
});

test('failed builds keep the saved draft and report failure after one repair attempt', async t => {
  let generations = 0;
  const { service } = await fixture(t, {
    generate: async () => { generations += 1; return { summary: 'Invalid', files: htmlFile('<h1>Broken</h1>') }; },
    compile: async () => { throw new Error('Syntaxfehler im Website-Code'); },
  });
  const site = await createSite(service);
  const initial = await service.store.saveRevision('alpha', site.id, { files: htmlFile('<h1>Original</h1>') });
  await service.chat('alpha', site.id, { message: 'Ändere das Design', baseRevisionId: initial.revision.id });
  const result = await service.waitForJob('alpha', site.id);
  assert.equal(generations, 2);
  assert.equal(result.job.status, 'failed');
  assert.equal(result.draftRevisionId, initial.revision.id);
  assert.equal(result.revisions.length, 1);
  assert.equal((await service.preview('alpha', site.id)).status, 'failed');
});

test('stale edits fail and a persisted running job becomes failed after service restart', async t => {
  const { service, createWebsiteService, config } = await fixture(t);
  const site = await createSite(service);
  const first = await service.store.saveRevision('alpha', site.id, { files: htmlFile('Original') });
  await assert.rejects(service.chat('alpha', site.id, { message: 'Ändere das Design', baseRevisionId: null }), error => error.status === 409);
  await service.store.updateSite('alpha', site.id, { job: { id: 'stale-job', type: 'chat', status: 'running' } });
  const restarted = createWebsiteService(config);
  const inspected = await restarted.site('alpha', site.id);
  assert.equal(inspected.job.status, 'failed');
  assert.equal(inspected.draftRevisionId, first.revision.id);
  assert.match(inspected.job.error, /neu gestartet/);
});

test('ZIP import/export and revision restore preserve history and reject stale rollback requests', async t => {
  const { service } = await fixture(t);
  const site = await createSite(service);
  const first = await service.importZip('alpha', site.id, createWebsiteZip(htmlFile('<h1>First</h1>')));
  assert.match(readWebsiteZip(await service.exportZip('alpha', site.id))[0].content, /First/);
  const second = await service.importZip('alpha', site.id, createWebsiteZip(htmlFile('<h1>Second</h1>')));
  await assert.rejects(service.restore('alpha', site.id, { revisionId: first.revision.id, baseRevisionId: first.revision.id }), error => error.status === 409);
  const restored = await service.restore('alpha', site.id, { revisionId: first.revision.id, baseRevisionId: second.revision.id });
  assert.notEqual(restored.revision.id, first.revision.id);
  assert.equal(restored.site.revisions.length, 3);
  assert.match(restored.revision.files[0].content, /First/);
  await assert.rejects(service.restore('beta', site.id, { revisionId: first.revision.id }), error => error.status === 404);
});

test('GitHub import preserves metadata and repeated private export pins the previous repository head', async t => {
  const exports = [];
  const github = { repository: 'owner/private-site', url: 'https://github.com/owner/private-site', branch: 'main', commitSha: 'a'.repeat(40), private: true };
  const { service } = await fixture(t, { githubFactory: () => ({
    importRepository: async () => ({ files: htmlFile('<h1>GitHub</h1>'), github, warnings: [], omitted: [] }),
    exportRepository: async input => { exports.push(input); return { github: { ...github, commitSha: 'b'.repeat(40) }, files: input.files.length, created: exports.length === 1 }; },
  }) });
  const site = await createSite(service);
  const imported = await service.importSite('alpha', site.id, { kind: 'github', repository: github.url });
  assert.equal((await service.site('alpha', site.id)).github.commitSha, github.commitSha);
  assert.match(imported.revision.files[0].content, /GitHub/);
  await service.exportGitHub('alpha', site.id);
  await service.exportGitHub('alpha', site.id);
  assert.equal(exports[0].private, true);
  assert.equal(exports[1].repository, github.repository);
  assert.equal(exports[1].expectedHead, 'b'.repeat(40));
});

test('publish verifies the public host, isolates artifact access, and rolls back on verification failure', async t => {
  let verifiedRevision = '';
  const { service } = await fixture(t, { fetchImpl: async () => ({ ok: true, headers: new Headers({ 'x-iva-revision': verifiedRevision }) }) });
  const site = await createSite(service);
  const first = await service.store.saveRevision('alpha', site.id, { files: htmlFile('<h1>Published original</h1>') });
  verifiedRevision = first.revision.id;
  const publication = await service.publish('alpha', site.id, {});
  assert.equal(publication.revisionId, first.revision.id);
  assert.ok(publication.verifiedAt);
  await assert.rejects(service.publishedArtifact({ siteId: site.id }, 'wrong-key'), error => error.status === 401);
  assert.match((await service.publishedArtifact({ siteId: site.id }, 'fixture-publish-key')).html, /Published original/);
  const second = await service.store.saveRevision('alpha', site.id, { baseRevisionId: first.revision.id, files: htmlFile('<h1>New draft</h1>') });
  assert.notEqual(second.revision.id, verifiedRevision);
  await assert.rejects(service.publish('alpha', site.id, {}), error => error.status === 502);
  const current = await service.site('alpha', site.id);
  assert.equal(current.publishedRevisionId, first.revision.id);
  assert.equal(current.draftRevisionId, second.revision.id);
  assert.match((await service.publishedArtifact({ siteId: site.id }, 'fixture-publish-key')).html, /Published original/);
});

test('a matching CNAME alone does not falsely mark a domain active', async t => {
  const { service } = await fixture(t, { dnsCname: async () => ['websites.example.org.'] });
  const site = await createSite(service);
  const domain = await service.domains('alpha', site.id, 'www.example.org');
  assert.equal(domain.status, 'needs_hosting_setup');
  assert.equal(domain.target, 'websites.example.org');
  await assert.rejects(service.domains('alpha', site.id, 'https://example.org'), error => error.status === 400);
});

test('GitHub credentials are verified and encrypted without returning or persisting plaintext tokens', async t => {
  const token = 'test_github_credential_123456789';
  const { service, root } = await fixture(t, { fetchImpl: async () => ({ ok: true, json: async () => ({ login: 'fixture-owner' }) }) });
  const result = await service.connections.save({ githubToken: token });
  assert.equal(result.login, 'fixture-owner');
  assert.equal(result.status, 'verified');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
  assert.doesNotMatch(await readFile(path.join(root, 'website-connections.json'), 'utf8'), new RegExp(token));
  assert.equal((await service.connections.resolveEnv()).GITHUB_TOKEN, token);
});

test('an import cannot overwrite an intervening edit from another service instance', async t => {
  let release;
  let importedStarted;
  const started = new Promise(resolve => { importedStarted = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const { service } = await fixture(t, { importUrl: async () => { importedStarted(); await pending; return { files: htmlFile('<h1>Imported</h1>'), source: { type: 'url' } }; } });
  const site = await createSite(service);
  const first = await service.store.saveRevision('alpha', site.id, { files: htmlFile('<h1>First</h1>') });
  const importing = service.importSite('alpha', site.id, { kind: 'url', url: 'https://example.org/' });
  await started;
  const changed = await service.store.saveRevision('alpha', site.id, { baseRevisionId: first.revision.id, files: htmlFile('<h1>Intervening edit</h1>') });
  release();
  await assert.rejects(importing, error => error.status === 409);
  assert.equal((await service.site('alpha', site.id)).draftRevisionId, changed.revision.id);
});

test('combined edit and publish request publishes the requested new revision rather than the previous draft', async t => {
  let runtime, siteId;
  let generations = 0;
  const { service } = await fixture(t, {
    generate: async () => { generations += 1; return { summary: 'Farbe geändert', files: htmlFile('<h1 style="color:green">New color</h1>'), model: { key: 'fixture:model' } }; },
    fetchImpl: async () => ({ ok: true, headers: new Headers({ 'x-iva-revision': (await runtime.site('alpha', siteId)).publishedRevisionId }) }),
  });
  runtime = service;
  const site = await createSite(service); siteId = site.id;
  const first = await service.store.saveRevision('alpha', site.id, { files: htmlFile('<h1>Old color</h1>') });
  await service.chat('alpha', site.id, { message: 'Ändere die Farbe zu Grün und veröffentliche die Website', baseRevisionId: first.revision.id });
  const done = await service.waitForJob('alpha', site.id);
  assert.equal(done.job.status, 'completed');
  assert.equal(generations, 1);
  assert.notEqual(done.publishedRevisionId, first.revision.id);
  assert.match((await service.publishedArtifact({ siteId }, 'fixture-publish-key')).html, /New color/);
});

test('a ZIP with one enclosing export folder imports as a runnable website root', async t => {
  const { service } = await fixture(t);
  const site = await createSite(service);
  const zip = createWebsiteZip([{ path: 'website-export/index.html', content: '<h1>Wrapped export</h1>', encoding: 'utf8' }, { path: 'website-export/src/app.js', content: 'window.started=true;', encoding: 'utf8' }]);
  const imported = await service.importZip('alpha', site.id, zip);
  assert.ok(imported.revision.files.some(file => file.path === 'index.html'));
  assert.ok(imported.revision.files.some(file => file.path === 'src/app.js'));
  assert.equal((await service.preview('alpha', site.id)).status, 'ready');
});

test('a timed-out generator releases the website slot and its late result cannot replace a subsequent draft', async t => {
  let release, signal;
  let calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const { service } = await fixture(t, { jobTimeoutMs: 100, generate: async ({ abortSignal }) => {
    calls += 1;
    if (calls === 1) { signal = abortSignal; await pending; return { summary: 'Too late', files: htmlFile('Old late result') }; }
    return { summary: 'Current result', files: htmlFile('Current result'), model: { key: 'fixture:model' } };
  } });
  const site = await createSite(service);
  const original = await service.store.saveRevision('alpha', site.id, { files: htmlFile('Original') });
  await service.chat('alpha', site.id, { message: 'Ändere das Design' });
  const timedOut = await within(service.waitForJob('alpha', site.id));
  assert.equal(timedOut.job.status, 'failed');
  assert.match(timedOut.job.error, /Zeitlimit/);
  assert.equal(signal.aborted, true);
  assert.equal(timedOut.draftRevisionId, original.revision.id);
  await service.chat('alpha', site.id, { message: 'Erstelle den nächsten Entwurf' });
  const next = await within(service.waitForJob('alpha', site.id));
  assert.equal(next.job.status, 'completed');
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  const final = await service.site('alpha', site.id);
  assert.equal(final.draftRevisionId, next.draftRevisionId);
  assert.equal(final.revisions.length, 2);
  assert.equal((await service.revision('alpha', site.id)).files[0].content, 'Current result');
});

test('a timed-out import cannot save its late source files', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { service } = await fixture(t, { jobTimeoutMs: 100, importUrl: async () => { await pending; return { files: htmlFile('Late import'), source: { type: 'url' } }; } });
  const site = await createSite(service);
  await service.chat('alpha', site.id, { message: 'Importiere meine Website https://example.org/' });
  const timedOut = await within(service.waitForJob('alpha', site.id));
  assert.equal(timedOut.job.status, 'failed');
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await service.site('alpha', site.id)).draftRevisionId, null);
});

test('late GitHub completion keeps the verified repository and blocks duplicate exports while uncertain', async t => {
  let release;
  let exportCount = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const github = { repository: 'owner/completed-late', url: 'https://github.com/owner/completed-late', branch: 'main', commitSha: 'c'.repeat(40), private: true };
  const { service } = await fixture(t, { jobTimeoutMs: 100, githubFactory: () => ({ exportRepository: async () => { exportCount += 1; await pending; return { github }; } }) });
  const site = await createSite(service);
  await service.store.saveRevision('alpha', site.id, { files: htmlFile('Original') });
  await service.chat('alpha', site.id, { message: 'Sichere die Website bei GitHub' });
  assert.equal((await within(service.waitForJob('alpha', site.id))).job.status, 'failed');
  await assert.rejects(service.exportGitHub('alpha', site.id), error => error.status === 409);
  release();
  const late = await eventually(() => service.site('alpha', site.id), value => value.github?.status === 'exported');
  assert.equal(late.github.repository, github.repository);
  assert.equal(exportCount, 1);
  assert.equal(late.job.status, 'failed');
});

test('a compiler failure status cannot be saved or called a completed build', async t => {
  const { service } = await fixture(t, { compile: async () => ({ status: 'failed', html: '', errors: ['Compile failed'] }) });
  const site = await createSite(service);
  await service.chat('alpha', site.id, { message: 'Erstelle eine Website' });
  const done = await service.waitForJob('alpha', site.id);
  assert.equal(done.job.status, 'failed');
  assert.equal(done.draftRevisionId, null);
});

test('automatic model selection falls back when the preferred provider cannot reserve its budget', async () => {
  const attempted = [];
  let released = 0;
  const result = await generateWebsite({
    message: 'Erstelle eine Website', site: { name: 'Fixture', description: '' }, env: { ANTHROPIC_API_KEY: 'fixture', GEMINI_API_KEY: 'fixture' },
    choose: key => ({ key, provider: key.split(':')[0], modelId: key.split(':')[1], model: { key } }), check: async () => {}, record: async () => {},
    reserve: async routed => { attempted.push(routed.key); if (routed.provider === 'anthropic') throw Object.assign(new Error('Budget'), { code: 'budget_exceeded' }); return () => { released += 1; }; },
    generate: async () => ({ text: JSON.stringify({ summary: 'Built', files: [{ path: 'index.html', content: '<h1>Built</h1>' }] }), usage: { promptTokens: 10, completionTokens: 10 } }),
  });
  assert.equal(attempted.length, 2);
  assert.equal(result.model.provider, 'google');
  assert.equal(released, 1);
});

test('a compiler returning after the job deadline cannot commit a revision', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { service } = await fixture(t, { jobTimeoutMs: 100, compile: async files => { await pending; return compiled(files); } });
  const site = await createSite(service);
  await service.chat('alpha', site.id, { message: 'Erstelle eine Website' });
  assert.equal((await within(service.waitForJob('alpha', site.id))).job.status, 'failed');
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await service.site('alpha', site.id)).draftRevisionId, null);
});

test('an expired publication cannot roll back a newer verified publication when its response arrives late', async t => {
  let runtime, siteId, release;
  let fetchCount = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const { service } = await fixture(t, { jobTimeoutMs: 100, fetchImpl: async () => {
    fetchCount += 1;
    const revisionId = (await runtime.site('alpha', siteId)).publishedRevisionId;
    if (fetchCount === 2) await pending;
    return { ok: true, headers: new Headers({ 'x-iva-revision': revisionId }) };
  } });
  runtime = service;
  const site = await createSite(service); siteId = site.id;
  const first = await service.store.saveRevision('alpha', site.id, { files: htmlFile('First') });
  await service.publish('alpha', site.id, {});
  const second = await service.store.saveRevision('alpha', site.id, { baseRevisionId: first.revision.id, files: htmlFile('Second') });
  await service.chat('alpha', site.id, { message: 'Veröffentliche die gespeicherte Version' });
  assert.equal((await within(service.waitForJob('alpha', site.id))).job.status, 'failed');
  const third = await service.store.saveRevision('alpha', site.id, { baseRevisionId: second.revision.id, files: htmlFile('Third') });
  await service.publish('alpha', site.id, {});
  release();
  await new Promise(resolve => setTimeout(resolve, 30));
  const current = await service.site('alpha', site.id);
  assert.equal(current.publishedRevisionId, third.revision.id);
  assert.ok(current.publication.verifiedAt);
});
