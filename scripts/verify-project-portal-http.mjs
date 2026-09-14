import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerPortalRoutes, registerProjectAccessAdminRoutes } from '../access/routes.js';
import { createWebsiteService } from '../websites/service.js';

const origin = 'https://iva.example.org';
const base = '/api/portal/website-studio';
const tokens = { viewer: 'v'.repeat(48), editor: 'e'.repeat(48), publisher: 'p'.repeat(48) };
const files = content => [{ path: 'index.html', content, encoding: 'utf8' }];
const fail = (message, status) => Object.assign(new Error(message), { status });
const cookie = role => `iva_portal_session=${tokens[role]}`;
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t, overrides = {}, { realAccess = false } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'iva-portal-http-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const state = { moduleEnabled: true, memberEnabled: true, roleOverride: null, quotas: 0, modelCalls: 0, imports: 0, githubCalls: 0, publishes: 0, coreCalls: 0 };
  const projects = [{ id: 'alpha', name: 'Customer project' }, { id: 'beta', name: 'Unrelated project' }];
  const roleFor = token => Object.entries(tokens).find(([, value]) => value === token)?.[0];
  const grantFor = role => ({ projectId: 'alpha', name: projects[0].name, role: state.roleOverride || role, modules: state.moduleEnabled ? ['websites'] : [], dailyBuildLimit: 5 });
  let access = {
    login: async ({ email, password }) => {
      const role = email?.split('@')[0];
      if (!tokens[role] || password !== 'Fixture password 123!') throw fail('Bitte Zugang prüfen.', 401);
      return { sessionToken: tokens[role], user: { id: role, email }, projects: [grantFor(role)] };
    },
    acceptInvite: async ({ token }) => {
      if (token !== 'fixture-invite') throw fail('Einladung ungültig.', 401);
      return { sessionToken: tokens.editor, user: { id: 'editor', email: 'editor@example.org' }, projects: [grantFor('editor')] };
    },
    session: async token => {
      const role = roleFor(token);
      return role ? { user: { id: role, email: `${role}@example.org` }, projects: state.memberEnabled ? [grantFor(role)] : [] } : null;
    },
    logout: async () => {},
    requireAccess: async (token, projectId, { module, action }) => {
      const role = roleFor(token);
      if (!role) throw fail('Bitte anmelden.', 401);
      if (!state.memberEnabled || projectId !== 'alpha' || !state.moduleEnabled || module !== 'websites') throw fail('Projekt nicht freigegeben.', 403);
      const current = state.roleOverride || role;
      if (!['read', 'edit', 'build', 'export', 'publish'].includes(action)) throw fail('Admin-Bereich.', 403);
      if (action !== 'read' && current === 'viewer' || action === 'publish' && current !== 'publisher') throw fail('Rolle erlaubt diese Aktion nicht.', 403);
      return { ...grantFor(role), userId: role };
    },
    consumeBuildQuota: async (token, projectId) => { await access.requireAccess(token, projectId, { module: 'websites', action: 'build' }); state.quotas++; },
    getProjectAccess: async projectId => ({ projectId, modules: state.moduleEnabled ? ['websites'] : [] }),
  };
  if (realAccess) {
    const { createProjectAccessStore } = await import('../access/store.js');
    access = createProjectAccessStore({ dataDir, getProject: async id => projects.find(project => project.id === id), env: {} });
    await access.configure('alpha', { modules: ['websites'], externalEnabled: true, externalRole: 'publisher', dailyBuildLimit: 5 });
  }
  const websites = createWebsiteService({
    dataDir, getProject: async id => projects.find(project => project.id === id), listProjects: async () => projects,
    authorizeProject: projectId => state.moduleEnabled || projectId === 'beta',
    env: { IVA_PROJECT_CONNECTIONS_KEY: Buffer.alloc(32, 8).toString('base64'), IVA_WEBSITE_HOST_ORIGIN: 'https://websites.example.org', IVA_CORE_ORIGIN: origin, IVA_WEBSITE_PUBLISH_KEY: 'fixture-key' },
    compile: async source => ({ html: source[0].content, status: 'ready', errors: [], warnings: [] }),
    generate: async input => { state.modelCalls++; return { summary: input.answerOnly ? 'Eine Antwort.' : 'Website angepasst.', files: input.answerOnly ? [] : files('<h1>Changed</h1>'), model: { key: 'fixture:model' } }; },
    importUrl: async () => { state.imports++; return { files: files('<h1>Imported</h1>'), source: { type: 'url', url: 'https://example.org' } }; },
    githubFactory: () => { state.githubCalls++; throw new Error('Unexpected global GitHub connection'); },
    fetchImpl: async url => { state.publishes++; return { ok: true, headers: new Headers({ 'x-iva-revision': new URL(url).searchParams.get('iva-version') }) }; },
    ...overrides,
  });
  const alpha = await websites.create({ projectId: 'alpha', name: 'Customer website' });
  const beta = await websites.create({ projectId: 'beta', name: 'Unrelated website' });
  const revision = (await websites.store.saveRevision('alpha', alpha.id, { files: files('<h1>Original</h1>') })).revision;
  await websites.store.saveRevision('beta', beta.id, { files: files('<h1>Other project</h1>') });
  await websites.store.updateSite('alpha', alpha.id, { github: { repository: 'owner/private-site', url: 'https://github.com/owner/private-site', private: true, status: 'imported' }, domain: { hostname: 'customer.example.org', status: 'needs_hosting_setup' } });
  const app = express();
  registerPortalRoutes(app, { access, websites, coreOrigin: origin, env: {} });
  app.use((req, res, next) => req.headers.authorization === 'Bearer admin-fixture-token' ? next() : res.status(401).json({ error: 'Admin access required' }));
  app.use(express.json());
  registerProjectAccessAdminRoutes(app, { access, coreOrigin: origin });
  app.all('/api/chat', (_req, res) => { state.coreCalls++; res.json({ ok: true }); });
  let server;
  await new Promise((resolve, reject) => { server = app.listen(0, '127.0.0.1', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const address = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, { role, method = 'GET', body, headers = {}, omitOrigin = false, raw } = {}) => {
    const requestHeaders = new Headers(headers);
    if (role) requestHeaders.set('cookie', cookie(role));
    if (!omitOrigin && !['GET', 'HEAD'].includes(method)) requestHeaders.set('origin', origin);
    if (body !== undefined) requestHeaders.set('content-type', 'application/json');
    const response = await fetch(address + route, { method, headers: requestHeaders, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await response.text();
    let value; try { value = JSON.parse(text); } catch { value = text; }
    return { status: response.status, headers: response.headers, body: value };
  };
  const route = (suffix = '', projectId = 'alpha', siteId = alpha.id) => `${base}/sites/${siteId}${suffix}?projectId=${projectId}`;
  return { state, access, websites, alpha, beta, revision, request, route };
}

test('login and invite acceptance issue an HttpOnly Secure same-site cookie without returning session tokens', async t => {
  const f = await fixture(t);
  for (const [route, body] of [
    ['/login', { email: 'editor@example.org', password: 'Fixture password 123!' }],
    ['/accept', { token: 'fixture-invite', password: 'Fixture password 123!' }],
  ]) {
    const response = await f.request('/api/portal' + route, { method: 'POST', body });
    assert.equal(response.status, 200);
    const setCookie = response.headers.get('set-cookie');
    assert.match(setCookie, /iva_portal_session=[A-Za-z0-9_-]+/);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api/portal', 'Max-Age=28800']) assert(setCookie.includes(flag));
    assert.equal(response.body.sessionToken, undefined);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const logout = await f.request('/api/portal/logout', { role: 'editor', method: 'POST' });
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
});

test('customer routes reject absent sessions and admin bearer credentials cannot bypass customer scope', async t => {
  const f = await fixture(t);
  for (const route of ['/api/portal/session', `${base}/sites?projectId=alpha`, f.route()]) {
    assert.equal((await f.request(route)).status, 401);
    assert.equal((await f.request(route, { headers: { authorization: 'Bearer admin-fixture-token' } })).status, 401);
  }
  assert.equal((await f.request(f.route('', 'beta', f.beta.id), { role: 'editor', headers: { authorization: 'Bearer admin-fixture-token' } })).status, 403);
});

test('mutations reject missing or foreign Origin and cross-site requests', async t => {
  const f = await fixture(t);
  for (const headers of [{}, { origin: 'https://attacker.example.org' }, { origin, 'sec-fetch-site': 'cross-site' }]) {
    const response = await f.request(`${base}/sites`, { role: 'editor', method: 'POST', body: { projectId: 'alpha', name: 'Forbidden' }, headers, omitOrigin: true });
    assert.equal(response.status, 403);
  }
  assert.equal((await f.request(`${base}/sites?projectId=alpha`, { role: 'editor', method: 'POST', body: { projectId: 'beta', name: 'Conflicting scope' } })).status, 403);
  assert.equal((await f.websites.list('alpha')).length, 1);
});

test('project and site binding applies to list, detail, preview, source and status', async t => {
  const f = await fixture(t);
  for (const route of [`${base}/sites?projectId=beta`, `${base}/status?projectId=beta`, f.route('', 'beta', f.beta.id), f.route('/preview', 'beta', f.beta.id)]) {
    assert.equal((await f.request(route, { role: 'editor' })).status, 403);
  }
  for (const suffix of ['', '/preview', '/export', `/revisions/${f.revision.id}`]) {
    assert.equal((await f.request(f.route(suffix, 'alpha', f.beta.id), { role: 'editor' })).status, 404);
  }
  const projects = await f.request(`${base}/projects`, { role: 'editor' });
  assert.deepEqual(projects.body, [{ id: 'alpha', name: 'Customer project' }]);
});

test('viewer can inspect previews but cannot chat, create, edit, export or publish', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(f.route(), { role: 'viewer' })).status, 200);
  assert.equal((await f.request(f.route('/preview'), { role: 'viewer' })).status, 200);
  assert.equal((await f.request(f.route('/export'), { role: 'viewer' })).status, 403);
  assert.equal((await f.request(f.route(`/revisions/${f.revision.id}`), { role: 'viewer' })).status, 403);
  for (const [suffix, body] of [['/chat', { message: 'Wie funktioniert die Website?' }], ['/import', { kind: 'url', url: 'https://example.org' }], ['/restore', { revisionId: f.revision.id }], ['/publish', {}]]) {
    assert.equal((await f.request(f.route(suffix), { role: 'viewer', method: 'POST', body })).status, 403);
  }
  assert.equal((await f.request(`${base}/sites`, { role: 'viewer', method: 'POST', body: { projectId: 'alpha', name: 'Denied' } })).status, 403);
  assert.equal(f.state.modelCalls + f.state.imports + f.state.publishes + f.state.quotas, 0);
});

test('editors can import and export their project, while only publishers can publish', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(f.route('/publish'), { role: 'editor', method: 'POST', body: {} })).status, 403);
  const imported = await f.request(f.route('/import'), { role: 'editor', method: 'POST', body: { kind: 'url', url: 'https://example.org' } });
  assert.equal(imported.status, 200);
  const exported = await f.request(f.route('/export'), { role: 'editor' });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-type'), /application\/zip/);
  const published = await f.request(f.route('/publish'), { role: 'publisher', method: 'POST', body: {} });
  assert.equal(published.status, 200);
  assert.equal(published.body.status, 'published');
  assert.equal(f.state.publishes, 1);
});

test('portal output omits owner connection and domain management metadata, including mutation results', async t => {
  const f = await fixture(t);
  const detail = (await f.request(f.route(), { role: 'editor' })).body;
  const list = (await f.request(`${base}/sites?projectId=alpha`, { role: 'editor' })).body;
  const imported = (await f.request(f.route('/import'), { role: 'editor', method: 'POST', body: { kind: 'url', url: 'https://example.org' } })).body;
  for (const site of [detail, list[0], imported.site]) {
    assert(!site.github);
    assert(!site.domain);
    assert(!JSON.stringify(site).includes('owner/private-site'));
  }
});

test('repository, domain, connection and unrelated core endpoints are unavailable to customer sessions', async t => {
  const f = await fixture(t);
  for (const route of [`${base}/connections`, `${base}/connections/github`, f.route('/github'), f.route('/domain'), '/api/portal/api/chat', '/api/portal/projects/alpha/access']) {
    assert.equal((await f.request(route, { role: 'editor', method: 'POST', body: {} })).status, 404);
  }
  assert.equal((await f.request(f.route('/import'), { role: 'editor', method: 'POST', body: { kind: 'github', repository: 'owner/private-site' } })).status, 403);
  assert.equal((await f.request('/api/chat', { role: 'editor', method: 'POST', body: {} })).status, 401);
  assert.equal((await f.request('/api/projects/alpha/access', { role: 'editor' })).status, 401);
  assert.equal(f.state.githubCalls + f.state.coreCalls, 0);
});

test('chat operation callback blocks editor publish and all customer GitHub requests before content changes', async t => {
  const f = await fixture(t);
  for (const message of ['Ändere den Header und veröffentliche die Website', 'Ändere den Header und sichere die Website bei GitHub']) {
    const response = await f.request(f.route('/chat'), { role: 'editor', method: 'POST', body: { message, authorizeOperation: true, action: 'read' } });
    assert.equal(response.status, 202);
    const done = await f.websites.waitForJob('alpha', f.alpha.id);
    assert.equal(done.job.status, 'failed');
    assert.equal(done.draftRevisionId, f.revision.id);
    assert.equal(done.publishedRevisionId, null);
  }
  assert.equal(f.state.modelCalls + f.state.githubCalls + f.state.publishes + f.state.quotas, 0);
});

test('chat quota is consumed once per accepted model job, including repeated authorization checks', async t => {
  const f = await fixture(t);
  const response = await f.request(f.route('/chat'), { role: 'editor', method: 'POST', body: { message: 'Ändere die Farbe' } });
  assert.equal(response.status, 202);
  const done = await f.websites.waitForJob('alpha', f.alpha.id);
  assert.equal(done.job.status, 'completed');
  assert.equal(f.state.quotas, 1);
  assert.equal(f.state.modelCalls, 1);
  const wrongSite = await f.request(f.route('/chat', 'alpha', f.beta.id), { role: 'editor', method: 'POST', body: { message: 'Ändere die Farbe' } });
  assert.equal(wrongSite.status, 404);
  assert.equal(f.state.quotas, 1);
});

test('module and membership changes take effect for the same existing customer session', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(f.route(), { role: 'editor' })).status, 200);
  f.state.moduleEnabled = false;
  for (const route of [f.route(), `${base}/sites?projectId=alpha`, `${base}/status?projectId=alpha`]) assert.equal((await f.request(route, { role: 'editor' })).status, 403);
  assert.deepEqual((await f.request(`${base}/projects`, { role: 'editor' })).body, []);
  f.state.moduleEnabled = true;
  f.state.memberEnabled = false;
  assert.equal((await f.request(f.route(), { role: 'editor' })).status, 403);
});

test('direct URL import rechecks the customer role before storing a late download', async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = await fixture(t, { importUrl: async () => { entered.resolve(); await release.promise; return { files: files('<h1>Late import</h1>') }; } });
  const pending = f.request(f.route('/import'), { role: 'editor', method: 'POST', body: { kind: 'url', url: 'https://example.org' } });
  await entered.promise;
  f.state.roleOverride = 'viewer';
  release.resolve();
  assert.equal((await pending).status, 403);
  assert.equal((await f.websites.store.get('alpha', f.alpha.id)).draftRevisionId, f.revision.id);
});

test('direct publication rechecks the publisher role after compilation before exposing a revision', async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = await fixture(t, { compile: async source => { entered.resolve(); await release.promise; return { html: source[0].content, status: 'ready', errors: [], warnings: [] }; } });
  const pending = f.request(f.route('/publish'), { role: 'publisher', method: 'POST', body: {} });
  await entered.promise;
  f.state.roleOverride = 'editor';
  release.resolve();
  assert.equal((await pending).status, 403);
  assert.equal((await f.websites.store.get('alpha', f.alpha.id)).publishedRevisionId, null);
  assert.equal(f.state.publishes, 0);
});

test('real access store supports admin invitation, customer login and immediate revocation over HTTP', async t => {
  const f = await fixture(t, {}, { realAccess: true });
  const admin = { authorization: 'Bearer admin-fixture-token' };
  const invited = await f.request('/api/projects/alpha/access/invites', { method: 'POST', headers: admin, body: { email: 'customer@example.org', role: 'editor' } });
  assert.equal(invited.status, 201);
  const token = new URLSearchParams(new URL(invited.body.inviteUrl).hash.slice(1)).get('invite');
  assert(token);
  const password = 'A secure customer password 123!';
  const accepted = await f.request('/api/portal/accept', { method: 'POST', body: { token, password } });
  assert.equal(accepted.status, 200);
  const sessionCookie = accepted.headers.get('set-cookie').split(';')[0];
  const headers = { cookie: sessionCookie };
  assert.equal((await f.request(f.route(), { headers })).status, 200);
  assert.equal((await f.request(f.route('', 'beta', f.beta.id), { headers })).status, 403);
  assert.equal((await f.request(f.route('/publish'), { headers, method: 'POST', body: {} })).status, 403);
  const reused = await f.request('/api/portal/accept', { method: 'POST', body: { token, password } });
  assert(reused.status >= 400 && reused.status < 500);
  const login = await f.request('/api/portal/login', { method: 'POST', body: { email: 'customer@example.org', password } });
  assert.equal(login.status, 200);
  assert.equal(login.body.sessionToken, undefined);
  const revoked = await f.request(`/api/projects/alpha/access/members/${accepted.body.user.id}`, { method: 'DELETE', headers: admin });
  assert.equal(revoked.status, 200);
  assert.equal((await f.request(f.route(), { headers })).status, 403);
  assert.deepEqual((await f.request(`${base}/projects`, { headers })).body, []);
});
