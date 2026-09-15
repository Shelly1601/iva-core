import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createCreatorContext } from '../creator/context.js';
import { createCreatorLanding, creatorLandingFiles } from '../creator/landing.js';
import { registerCreatorRoutes } from '../creator/routes.js';
import { creatorSkill } from '../creator/tools.js';
import { createWebsiteService } from '../websites/service.js';
import { createProjectAccessStore, PROJECT_MODULES } from '../access/store.js';

const projects = [{ id: 'p1', name: 'Projekt Eins' }, { id: 'p2', name: 'Projekt Zwei' }];
const getProject = async id => projects.find(row => row.id === id);
await test('Creator ist ein internes Projektmodul mit expliziter Projektfreigabe', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-creator-access-'));
  try {
    assert.equal(PROJECT_MODULES.find(row => row.id === 'creator').externalAvailable, false);
    const access = createProjectAccessStore({ dataDir: dir, getProject });
    await access.configure('p2', { modules: ['websites'] });
    const directory = createCreatorContext({ listProjects: async () => projects, access, listKnowledgeEntries: async () => [{ id: 's1', title: 'Eigene Methode', content: 'private original source', notes: 'private notes', sourceOwner: 'own' }, { id: 's2', projectId: 'p2', title: 'Anderes Projekt' }], listOpportunities: async () => [{ id: 'o1', title: 'Idee' }, { id: 'o2', projectId: 'p2', title: 'Fremde Idee' }], listOpportunityLinkChecks: async () => [{ id: 'l1', assessment: { headline: 'Linkidee', summary: 'Nur ein Prüfbericht', evidence: ['Beleg'] }, research: { sources: [{ id: 'R1', url: 'https://example.test/evidence' }] } }], getOpportunity: async () => null, env: {} });
    const result = await directory.context('p1');
    assert.deepEqual(result.projects.map(p => p.id), ['p1']);
    assert.deepEqual(result.knowledge.map(p => p.id), ['s1']);
    assert.deepEqual(result.opportunities.map(p => p.id), ['o1', 'l1']);
    assert.equal(result.readiness.find(row => row.id === 'model').status, 'missing');
    assert.doesNotMatch(JSON.stringify(result), /private original|private notes|sourceOwner/);
    await assert.rejects(() => directory.context('p2'), { status: 403 });
    assert.equal((await directory.resolveOpportunity('l1')).research.sources[0].id, 'R1');
    const configuration = await access.getProjectAccess('p1');
    await access.configure('p1', { ...configuration, externalEnabled: true });
    const invite = await access.createInvite('p1', { email: 'test@example.test', role: 'editor' });
    const session = await access.acceptInvite({ token: invite.token, password: 'Long-Test-Password-42' });
    assert.equal(session.projects[0].modules.includes('creator'), false);
    await assert.rejects(() => access.requireAccess(session.sessionToken, 'p1', { module: 'creator', action: 'read' }), { status: 403 });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

await test('Creator HTTP wahrt Owner-Zugang, Projekt und Auftragsendpunkte', async () => {
  const app = express(); app.use(express.json());
  app.use('/api', (q, r, next) => q.headers.authorization === 'Bearer fixture' ? next() : r.status(401).json({ error: 'unauthorized' }));
  const calls = [];
  const fake = async (scope, ...args) => { if (scope.projectId !== 'p1') throw Object.assign(new Error('Kein Zugriff'), { status: 403 }); calls.push({ scope, args }); return { id: 'product1', status: 'draft' }; };
  registerCreatorRoutes(app, { service: { list: async scope => [await fake(scope)], create: fake, get: fake, update: fake, addSources: fake, addExactSnippet: fake, startJob: fake, getJob: fake, cancelJob: fake }, context: async projectId => ({ projectId }), landing: fake });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const request = async (url, body, auth = true, method) => { const response = await fetch('http://127.0.0.1:' + server.address().port + url, { method: method || (body ? 'POST' : 'GET'), headers: { ...(auth ? { Authorization: 'Bearer fixture' } : { Cookie: 'iva_portal_session=external' }), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json(), cache: response.headers.get('cache-control') }; };
  try {
    assert.equal((await request('/api/creator/context?projectId=p1', null, false)).status, 401);
    assert.equal((await request('/api/creator/product1/export?projectId=p1', null, false)).status, 401);
    assert.equal((await request('/api/creator?projectId=p1')).data.products.length, 1);
    assert.equal((await request('/api/creator?projectId=p2')).status, 403);
    assert.equal((await request('/api/creator')).status, 400);
    assert.equal((await request('/api/creator?projectId=p1', { projectId: 'p2' })).status, 400);
    assert.equal((await request('/api/creator/jobs/j1?projectId=p1')).status, 200);
    assert.equal((await request('/api/creator/jobs/j1/cancel?projectId=p1', {})).status, 200);
    assert.equal((await request('/api/creator/product1/jobs?projectId=p1', { mode: 'resume' })).status, 202);
    assert.equal((await request('/api/creator/product1?projectId=p1')).cache, 'no-store');
    assert.equal(calls.at(-2).args[1].mode, 'resume');
  } finally { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
});

await test('Verkaufsseite baut echte Revision, wahrt Quellenprivatsphäre und bearbeitete Fassungen', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-creator-landing-'));
  try {
    const websiteService = createWebsiteService({ dataDir: dir, getProject, listProjects: async () => projects, env: {} });
    const product = { id: 'product1', status: 'ready', title: '<script>unsafe</script> Neues Wissen', type: 'course', brief: 'Eigener didaktischer Kurs.', audience: 'Kleine Teams', salesLinks: [{ label: 'Angebot', url: 'https://example.test/kurs' }, { label: 'Unsicher', url: 'javascript:alert(1)' }] };
    const version = { id: 'version1', stage: 'complete', sources: [{ content: 'Do not expose source text' }], plan: { learningOutcomes: ['Eigene Methode üben'] }, units: [{ title: 'Start', content: 'Do not expose full paid lesson', objective: 'Klarer Einstieg', exercises: ['Eigene Übung'] }] };
    const landing = createCreatorLanding({ service: { exportData: async () => ({ product, version }) }, websiteService });
    const [a, b] = await Promise.all([landing({ projectId: 'p1' }, 'product1'), landing({ projectId: 'p1' }, 'product1')]);
    assert.equal(a.site.id, b.site.id); assert.equal(a.published, false);
    const preview = await websiteService.preview('p1', a.site.id);
    assert.equal(preview.status, 'ready');
    assert.match(preview.html, /Eigene Methode/); assert.match(preview.html, /https:\/\/example.test\/kurs/);
    assert.doesNotMatch(preview.html, /Do not expose|javascript:|<script>unsafe/);
    await websiteService.store.saveRevision('p1', a.site.id, { baseRevisionId: a.site.draftRevisionId, files: [{ path: 'index.html', content: '<!doctype html><p>Eigene Gestaltung</p>' }], summary: 'Eigene Änderung' });
    assert.equal((await landing({ projectId: 'p1' }, 'product1')).site.id, a.site.id);
    assert.match((await websiteService.preview('p1', a.site.id)).html, /Eigene Gestaltung/);
    assert.equal((await websiteService.list('p1')).length, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

await test('IVA-Chat bindet Creator fest an das aktive Projekt', async () => {
  let received;
  const skill = creatorSkill({ projectId: 'p1', service: { get: async scope => { received = scope; return { sources: [{ content: 'very private text', title: 'Quelle' }] }; } }, context: async () => ({}), landing: async () => ({}) });
  const result = await skill.getDigitalProduct.execute({ productId: 'product1', projectId: 'p2' });
  assert.equal(received.projectId, 'p1'); assert.equal(result.sources[0].content, undefined);
  assert.equal(skill.runDigitalProductTask.projectId, 'p1');
  const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(source.indexOf('registerCreatorRoutes(app,') > source.indexOf("app.use('/api',"));
  assert.match(source, /getProject:requireCreatorProject/);
});
