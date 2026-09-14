import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWebsiteService } from '../websites/service.js';

const files = content => [{ path: 'index.html', encoding: 'utf8', content }];
const built = source => ({ html: source[0].content, status: 'ready', errors: [], warnings: [] });
const denied = action => Object.assign(new Error(`Berechtigung verweigert: ${action}`), { status: 403 });
const github = { repository: 'owner/private-site', url: 'https://github.com/owner/private-site', branch: 'main', commitSha: 'a'.repeat(40), private: true };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'iva-project-access-service-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const projects = [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }];
  const counters = { generate: 0, compile: 0, import: 0, connector: 0, export: 0, publish: 0 };
  const service = createWebsiteService({
    dataDir,
    getProject: async id => projects.find(project => project.id === id), listProjects: async () => projects,
    env: { IVA_PROJECT_CONNECTIONS_KEY: Buffer.alloc(32, 7).toString('base64'), IVA_WEBSITE_HOST_ORIGIN: 'https://websites.example.org', IVA_CORE_ORIGIN: 'https://iva.example.org', IVA_WEBSITE_PUBLISH_KEY: 'fixture-key' },
    generate: async input => { counters.generate++; return { summary: input.answerOnly ? 'So funktioniert Website Studio.' : 'Website geändert.', files: input.answerOnly ? [] : files('<h1>Changed</h1>'), model: { key: 'fixture:model' } }; },
    compile: async source => { counters.compile++; return built(source); },
    importUrl: async () => { counters.import++; return { files: files('<h1>Imported</h1>'), source: { type: 'url', url: 'https://example.org' } }; },
    githubFactory: () => { counters.connector++; return {
      exportRepository: async () => { counters.export++; return { github, created: true, files: 1 }; },
      importRepository: async () => { counters.import++; return { github, files: files('<h1>Private</h1>') }; },
    }; },
    fetchImpl: async url => { counters.publish++; return { ok: true, headers: new Headers({ 'x-iva-revision': new URL(url).searchParams.get('iva-version') }) }; },
    ...overrides,
  });
  const site = await service.create({ projectId: 'alpha', name: 'Customer website' });
  const initial = await service.store.saveRevision('alpha', site.id, { files: files('<h1>Original</h1>') });
  return { service, site, initial: initial.revision, counters };
}
async function chatResult(f, message, authorizeOperation, extra = {}) {
  await f.service.chat('alpha', f.site.id, { message, ...extra }, { authorizeOperation });
  return f.service.waitForJob('alpha', f.site.id);
}
function unchanged(result, f) {
  assert.equal(result.draftRevisionId, f.initial.id);
  assert.equal(result.publishedRevisionId, null);
  assert.equal(result.revisions.length, 1);
  assert.equal(result.github, null);
}

test('chat cannot bypass publication role with a combined edit or an input-supplied authorization function', async t => {
  const f = await fixture(t);
  const operations = [];
  const result = await chatResult(f, 'Ändere den Header und veröffentliche die Website', action => {
    operations.push(action);
    if (action === 'publish') throw denied(action);
  }, { authorizeOperation: () => true });
  assert.equal(result.job.status, 'failed');
  assert.match(result.job.error, /Berechtigung/);
  unchanged(result, f);
  assert.equal(f.counters.generate, 0);
  assert.equal(f.counters.compile, 0);
  assert.equal(f.counters.publish, 0);
  assert.deepEqual(operations, ['publish']);
});

test('denied GitHub chat export never resolves owner credentials or edits the draft', async t => {
  const f = await fixture(t);
  const result = await chatResult(f, 'Ändere den Header und sichere die Website bei GitHub', action => action !== 'github');
  assert.equal(result.job.status, 'failed');
  unchanged(result, f);
  assert.equal(f.counters.connector, 0);
  assert.equal(f.counters.export, 0);
  assert.equal(f.counters.generate, 0);
});

test('customer GitHub imports cannot read private repositories using the owner connection', async t => {
  const f = await fixture(t);
  const result = await chatResult(f, 'Importiere meine Website https://github.com/owner/private-site', action => action !== 'github');
  assert.equal(result.job.status, 'failed');
  unchanged(result, f);
  assert.equal(f.counters.connector, 0);
  assert.equal(f.counters.import, 0);
});

test('denied edit blocks URL import before any network request', async t => {
  const f = await fixture(t);
  const result = await chatResult(f, 'Importiere meine Website https://example.org/', action => action !== 'edit');
  assert.equal(result.job.status, 'failed');
  unchanged(result, f);
  assert.equal(f.counters.import, 0);
});

test('build permission is checked before the model is invoked', async t => {
  const f = await fixture(t);
  const result = await chatResult(f, 'Ändere die Farbe', action => action !== 'build');
  assert.equal(result.job.status, 'failed');
  unchanged(result, f);
  assert.equal(f.counters.generate, 0);
});

test('revoking edit during generation prevents the eventual model result from saving', async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  let editable = true;
  const f = await fixture(t, { generate: async () => { entered.resolve(); await release.promise; return { summary: 'Late result', files: files('<h1>Late</h1>') }; } });
  await f.service.chat('alpha', f.site.id, { message: 'Ändere das Design' }, { authorizeOperation: action => action !== 'edit' || editable });
  await entered.promise;
  editable = false;
  release.resolve();
  const result = await f.service.waitForJob('alpha', f.site.id);
  assert.equal(result.job.status, 'failed');
  unchanged(result, f);
});

test('revoking edit during a URL import prevents the downloaded files from saving', async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  let editable = true;
  const f = await fixture(t, { importUrl: async () => { entered.resolve(); await release.promise; return { files: files('<h1>Late import</h1>') }; } });
  await f.service.chat('alpha', f.site.id, { message: 'Importiere meine Website https://example.org/' }, { authorizeOperation: action => action !== 'edit' || editable });
  await entered.promise;
  editable = false;
  release.resolve();
  const result = await f.service.waitForJob('alpha', f.site.id);
  assert.equal(result.job.status, 'failed');
  unchanged(result, f);
});

test('read-only questions need read permission and cannot become build, GitHub, or publish operations', async t => {
  const f = await fixture(t);
  const seen = [];
  const result = await chatResult(f, 'Wie veröffentliche ich die Website und sichere sie bei GitHub?', (action, context) => {
    seen.push(action);
    assert.equal(context.projectId, 'alpha');
    assert.equal(context.siteId, f.site.id);
    assert.match(context.jobId, /^[a-f0-9-]{36}$/);
    return action === 'read';
  });
  assert.equal(result.job.status, 'completed');
  unchanged(result, f);
  assert.equal(f.counters.generate, 1);
  assert.deepEqual(seen, ['read', 'read']);
  assert.equal(f.counters.connector + f.counters.compile + f.counters.publish, 0);
});

test('read access revoked during an answer prevents disclosing the late generated answer', async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  let readable = true;
  const f = await fixture(t, { generate: async () => { entered.resolve(); await release.promise; return { summary: 'Sensitive late answer' }; } });
  await f.service.chat('alpha', f.site.id, { message: 'Wie funktioniert diese Website?' }, { authorizeOperation: action => action === 'read' && readable });
  await entered.promise;
  readable = false;
  release.resolve();
  const result = await f.service.waitForJob('alpha', f.site.id);
  assert.equal(result.job.status, 'failed');
  assert(!result.messages.some(message => message.content.includes('Sensitive late answer')));
});

test('publication is authorized again after compilation, before switching the public revision', async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  let publishable = true;
  const f = await fixture(t, { compile: async source => { entered.resolve(); await release.promise; return built(source); } });
  await f.service.chat('alpha', f.site.id, { message: 'Veröffentliche die Website' }, { authorizeOperation: action => action !== 'publish' || publishable });
  await entered.promise;
  publishable = false;
  release.resolve();
  const result = await f.service.waitForJob('alpha', f.site.id);
  assert.equal(result.job.status, 'failed');
  unchanged(result, f);
  assert.equal(f.counters.publish, 0);
});

test('GitHub permission revoked while resolving credentials prevents the remote write', async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  let exportable = true, exports = 0;
  const f = await fixture(t, { githubFactory: async () => {
    entered.resolve(); await release.promise;
    return { exportRepository: async () => { exports++; return { github }; } };
  } });
  await f.service.chat('alpha', f.site.id, { message: 'Sichere die Website bei GitHub' }, { authorizeOperation: action => action !== 'github' || exportable });
  await entered.promise;
  exportable = false;
  release.resolve();
  const result = await f.service.waitForJob('alpha', f.site.id);
  assert.equal(result.job.status, 'failed');
  unchanged(result, f);
  assert.equal(exports, 0);
});

test('GitHub permission is rechecked after recording the pending operation and directly before the write', async t => {
  const f = await fixture(t);
  let checkedPending = false;
  const result = await chatResult(f, 'Sichere die Website bei GitHub', async action => {
    if (action !== 'github') return true;
    const current = await f.service.store.get('alpha', f.site.id);
    if (current.github?.status === 'exporting') { checkedPending = true; return false; }
    return true;
  });
  assert.equal(result.job.status, 'failed');
  unchanged(result, f);
  assert.equal(checkedPending, true);
  assert.equal(f.counters.connector, 1);
  assert.equal(f.counters.export, 0);
});

test('publication verification rolls back to the previous public revision if access is revoked', async t => {
  let publishable = true, revokeAtResponse = false;
  const f = await fixture(t, { fetchImpl: async url => {
    if (revokeAtResponse) publishable = false;
    return { ok: true, headers: new Headers({ 'x-iva-revision': new URL(url).searchParams.get('iva-version') }) };
  } });
  await f.service.publish('alpha', f.site.id);
  const previous = await f.service.site('alpha', f.site.id);
  const next = await f.service.store.saveRevision('alpha', f.site.id, { baseRevisionId: f.initial.id, files: files('<h1>Second</h1>') });
  revokeAtResponse = true;
  const result = await chatResult(f, 'Veröffentliche die Website', action => action !== 'publish' || publishable);
  assert.equal(result.job.status, 'failed');
  assert.equal(result.draftRevisionId, next.revision.id);
  assert.equal(result.publishedRevisionId, f.initial.id);
  assert.deepEqual(result.publication, previous.publication);
});

test('a repair model call requires a fresh build authorization', async t => {
  let buildable = true, generations = 0;
  const f = await fixture(t, {
    generate: async () => { generations++; return { summary: 'Invalid build', files: files('<h1>Invalid</h1>') }; },
    compile: async () => { buildable = false; throw new Error('Compile failed'); },
  });
  const result = await chatResult(f, 'Ändere die Farbe', action => action !== 'build' || buildable);
  assert.equal(result.job.status, 'failed');
  unchanged(result, f);
  assert.equal(generations, 1);
});

test('project module restriction applies to create, list and site, including revocation during generation', async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  let enabled = true;
  const f = await fixture(t, {
    authorizeProject: projectId => enabled && projectId === 'alpha',
    generate: async () => { entered.resolve(); await release.promise; return { summary: 'Late disabled module result', files: files('<h1>Late</h1>') }; },
  });
  await assert.rejects(f.service.create({ projectId: 'beta', name: 'Forbidden' }), error => error.status === 403);
  await assert.rejects(f.service.list('beta'), error => error.status === 403);
  assert.deepEqual((await f.service.listProjects()).map(project => project.id), ['alpha']);
  await f.service.chat('alpha', f.site.id, { message: 'Ändere das Design' });
  await entered.promise;
  enabled = false;
  release.resolve();
  await assert.rejects(f.service.waitForJob('alpha', f.site.id), error => error.status === 403);
  await assert.rejects(f.service.site('alpha', f.site.id), error => error.status === 403);
  await assert.rejects(f.service.list('alpha'), error => error.status === 403);
  assert.deepEqual(await f.service.listProjects(), []);
  const result = await f.service.store.get('alpha', f.site.id);
  assert.equal(result.job.status, 'failed');
  unchanged(result, f);
});
