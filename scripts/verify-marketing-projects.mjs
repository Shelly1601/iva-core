import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectMarketingStore, publicMarketingUrl } from '../marketing/project-store.js';
import { createProjectMarketingService } from '../marketing/project-service.js';
import { collectProjectResearch, normalizeMarketingEvidence } from '../marketing/project-research.js';
import { parseMarketingGeneration, generateProjectMarketing } from '../marketing/project-generation.js';
import { createHiggsfieldClient, verifyHiggsfieldConnection } from '../marketing/higgsfield.js';

const project = async id => ['alpha', 'beta'].includes(id) ? { id, name: id === 'alpha' ? 'Marke Alpha' : 'Marke Beta' } : null;
const brand = { name: 'Marke Alpha', offer: 'Solaranlagen für Eigenheime', audience: 'Eigentümer im Raum Hamburg', industry: 'Solar', region: 'Hamburg', colors: ['#AABBCC'] };
const source = { id: 'real-source', url: 'https://example.com/', status: 'read', text: 'Eine gelesene Quelle mit Positionierung und hilfreichen Antworten auf reale Fragen.', posts: [], type: 'website' };
async function fixture(t, extra = {}) { const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-marketing-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true })); const store = createProjectMarketingStore({ dataDir, getProject: project }); const service = createProjectMarketingService({ dataDir, getProject: project, listProjects: async () => [await project('alpha'), await project('beta')], env: {}, ...extra }); return { store, service, dataDir }; }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const credentials = { HF_API_KEY_ID: 'sample-id', HF_API_KEY_SECRET: 'sample-secret' };
const id = '12345678-1234-4321-8123-123456789abc';

test('profiles and records cannot cross projects; unknown ids fail', async t => {
  const { store } = await fixture(t); await store.saveProfile('alpha', brand); const row = await store.add('alpha', 'research', { result: { summary: 'Nur Alpha' } });
  assert.equal((await store.snapshot('alpha')).profile.offer, brand.offer); assert.equal((await store.snapshot('beta')).profile.offer, '');
  await assert.rejects(store.get('beta', 'research', row.id), { status: 404 }); await assert.rejects(store.snapshot('../alpha')); await assert.rejects(store.snapshot('missing'), { status: 404 });
});
test('concurrent profile/record writes retain all updates', async t => {
  const { store } = await fixture(t); await Promise.all([store.saveProfile('alpha', brand), ...Array.from({ length: 8 }, (_, i) => store.add('alpha', 'research', { title: String(i) })), store.saveProfile('beta', { offer: 'Ein anderes Angebot' })]);
  assert.equal((await store.snapshot('alpha')).research.length, 8); assert.equal((await store.snapshot('beta')).profile.offer, 'Ein anderes Angebot');
});
test('profile URL, brand color, and logo upload validation rejects unsafe input', async t => {
  const { store } = await fixture(t);
  for (const url of ['http://example.com', 'https://localhost/', 'https://127.0.0.1/', 'https://u:p@example.com', 'https://example.com?token=secret']) assert.throws(() => publicMarketingUrl(url));
  await assert.rejects(store.saveProfile('alpha', { colors: ['red; background:url(x)'] })); await assert.rejects(store.saveProfile('alpha', { instagram: 'https://example.com/profile' }));
  await assert.rejects(store.saveLogo('alpha', Buffer.from('<svg onload="evil()">'), 'image/png'));
  const bytes = Buffer.from([137,80,78,71,13,10,26,10,0]); await store.saveLogo('alpha', bytes, 'image/png'); assert.equal((await store.snapshot('alpha')).profile.logo.mime, 'image/png'); assert.equal((await store.snapshot('beta')).profile.logo, null);
});
test('search snippets never become read source evidence when fetch fails', async () => {
  const result = await collectProjectResearch({ profile: brand, automatic: true, env: {}, search: async () => [{ url: 'https://example.com/', title: 'A claim', snippet: 'This is not read evidence.' }], readWebsite: async () => { throw new Error('blocked'); } });
  assert.equal(result.coverage.read, 0); assert.equal(result.sources[0].text, ''); assert.equal(result.sources[0].status, 'unavailable');
});
test('direct references work without paid search and retain observed timestamps', async () => {
  let searches = 0;
  const result = await collectProjectResearch({ profile: brand, urls: ['https://example.com/'], automatic: false, search: async () => searches++, readWebsite: async () => ({ text: source.text, title: 'Actual page' }) });
  assert.equal(searches, 0); assert.equal(result.coverage.read, 1); assert.equal(result.sources[0].title, 'Actual page'); assert.ok(Date.parse(result.sources[0].observedAt));
});
test('Instagram profile statistics preserve unknown metrics and source captions', async () => {
  const result = await collectProjectResearch({ profile: brand, urls: ['https://www.instagram.com/example/'], env: { APIFY_TOKEN: 'configured' }, readInstagram: async () => [{ url: 'https://www.instagram.com/p/ABCdef123/', caption: 'Eine ausführliche hilfreiche Antwort auf die häufigsten Fragen rund um ein neues Solardach.', likesCount: 0, commentsCount: undefined, type: 'Video' }] });
  assert.equal(result.coverage.socialPosts, 1); assert.equal(result.sources[0].posts[0].likes, 0); assert.equal(result.sources[0].posts[0].comments, null); assert.deepEqual(result.sources[0].modalities, ['text']);
});
test('caption-only media stays explicit and never claims video or audio coverage', () => {
  const item = normalizeMarketingEvidence({ status: 'metadata_only', text: source.text, caption: source.text, coverage: { caption: true, transcript: false, visual: false, audio: false }, visualObservations: ['invented'] }, 'https://www.instagram.com/reel/ABCDE/');
  assert.equal(item.status, 'read'); assert.deepEqual(item.modalities, ['text']); assert.deepEqual(item.visualObservations, []); assert.equal(item.posts.length, 0);
});
test('generated patterns with invented source identifiers are removed', () => {
  const parsed = parseMarketingGeneration(JSON.stringify({ summary: 'Analyse', patterns: [{ title: 'Belegt', observation: 'Fakt', sourceIds: ['real-source'], application: 'Eigene Idee' }, { title: 'Erfunden', observation: 'fake', sourceIds: ['invented'] }], ideas: [{ title: 'Eigene Idee', sourceIds: ['invented'] }] }), [source], 'research');
  assert.equal(parsed.patterns.length, 1); assert.deepEqual(parsed.ideas[0].sourceIds, []); assert.equal(parsed.ideas[0].status, 'hypothesis');
});
test('no readable research sources means no model call and no pretend analysis', async t => {
  let calls = 0;
  const { service } = await fixture(t, { collect: async () => ({ sources: [{ ...source, status: 'unavailable' }], coverage: { read: 0 } }), generate: async () => { calls++; } });
  await service.saveProfile('alpha', brand); await service.startJob('alpha', 'research', { urls: [source.url] }); await service.waitForIdle('alpha');
  assert.equal(calls, 0); assert.equal((await service.snapshot('alpha')).research[0].status, 'unavailable');
});
test('content from another project analysis is denied before model invocation', async t => {
  let calls = 0;
  const { service, store } = await fixture(t, { generate: async () => { calls++; } });
  await service.saveProfile('beta', { ...brand, name: 'Beta' }); const reference = await store.add('alpha', 'research', { status: 'complete', evidence: { sources: [source] } });
  await service.startJob('beta', 'content', { researchId: reference.id }); await service.waitForIdle('beta');
  assert.equal(calls, 0); assert.equal((await service.snapshot('beta')).drafts[0].status, 'failed'); assert.equal((await service.snapshot('alpha')).drafts.length, 0);
});
test('a running job captures the correct profile and rejects duplicate project work', async t => {
  let finish; const gate = new Promise(resolve => finish = resolve); let supplied;
  const { service } = await fixture(t, { collect: async () => { await gate; return { sources: [source], coverage: { read: 1 } }; }, generate: async input => { supplied = input; return { summary: 'Real result', patterns: [], model: { label: 'Fixture' } }; } });
  await service.saveProfile('alpha', brand); await service.startJob('alpha', 'research', { urls: [source.url] });
  await assert.rejects(service.startJob('alpha', 'research', {}), { status: 409 }); await service.saveProfile('alpha', { offer: 'A changed offering after the job started' }); finish(); await service.waitForIdle('alpha');
  assert.equal(supplied.profile.offer, brand.offer); assert.equal(supplied.profile.name, 'Marke Alpha'); assert.equal((await service.snapshot('beta')).research.length, 0);
});
test('content generation uses quality-first routing and records actual reported usage', async () => {
  const chosen = [], recorded = [];
  const result = await generateProjectMarketing({ kind: 'content', profile: brand, env: { ANTHROPIC_API_KEY: 'fixture', GEMINI_API_KEY: 'fixture' }, choose: key => { chosen.push(key); return { key, model: {}, provider: 'anthropic', modelId: 'fixture' }; }, check: async () => {}, reserve: async () => () => {}, record: async (...args) => recorded.push(args), generate: async () => ({ text: JSON.stringify({ summary: 'Entwurf', items: [{ title: 'Solardach', script: 'Konkretes Skript' }] }), usage: { promptTokens: 100, completionTokens: 100 } }) });
  assert.match(chosen[0], /^anthropic:/); assert.equal(recorded.length, 1); assert.equal(result.items[0].status, 'draft');
});
test('Higgsfield prepare uses only exact verified OpenAPI endpoint and string duration', () => {
  const client = createHiggsfieldClient(); const p = client.prepare({ prompt: 'Eine ruhige hochwertige Videoszene.', model: 'veo-3.1', duration: 8 });
  assert.equal(p.endpoint, '/veo3.1'); assert.deepEqual(p.payload, { prompt: 'Eine ruhige hochwertige Videoszene.', duration: '8', resolution: '1080', aspect_ratio: '9:16', generate_audio: true });
  assert.throws(() => client.prepare({ model: '../../secret', prompt: 'Eine lange Videoszene' })); assert.throws(() => client.prepare({ model: 'veo-3.1-image', prompt: 'Eine lange Videoszene' }));
});
test('connection verification calls estimate only, keeps secret in header, never generates', async () => {
  const seen = []; const result = await verifyHiggsfieldConnection(credentials, { fetchImpl: async (url, init) => { seen.push({ url, init }); return json({ credits: '5.000', usd: '0.40' }); } });
  assert.equal(result.ok, true); assert.equal(seen.length, 1); assert.equal(seen[0].url, 'https://api.higgsfield.ai/estimate/veo3.1'); assert.equal(seen[0].init.headers.Authorization, 'Key sample-id:sample-secret'); assert.equal(seen[0].init.redirect, 'error'); assert.ok(!JSON.stringify(result).includes('sample-secret'));
});
test('unusable estimates and provider errors do not expose payloads or secrets', async () => {
  for (const reply of [json({ usd: 4 }), json({ credits: '-1', usd: 'NaN' }), json({ error: 'sample-secret' }, 403)]) {
    const client = createHiggsfieldClient({ fetchImpl: async () => reply }); await assert.rejects(client.estimate(client.prepare({ prompt: 'Eine hochwertige Filmszene' }), credentials), e => !e.message.includes('sample-secret'));
  }
});
test('status is fetched only from fixed origin and validates request ownership', async () => {
  const seen = []; const client = createHiggsfieldClient({ fetchImpl: async url => { seen.push(url); return json({ request_id: id, status: 'completed', video: { url: 'https://media.example.com/result.mp4' }, status_url: 'https://attacker.com' }); } });
  const result = await client.status(id, credentials); assert.equal(seen[0], `https://api.higgsfield.ai/requests/${id}/status`); assert.equal(result.videoUrl, 'https://media.example.com/result.mp4'); assert.ok(!('status_url' in result)); await assert.rejects(client.status('https://attacker.com', credentials));
});
test('completed without a real HTTPS video URL is rejected', async () => {
  const client = createHiggsfieldClient({ fetchImpl: async () => json({ request_id: id, status: 'completed', video: { url: 'javascript:alert(1)' } }) }); await assert.rejects(client.status(id, credentials), { code: 'HIGGSFIELD_OUTPUT_MISSING' });
});
function videoProvider() {
  const stats = { submitted: 0, price: '0.40', failSubmit: false };
  const provider = { prepare: createHiggsfieldClient().prepare, estimate: async () => ({ credits: '5', usd: stats.price }), submit: async () => { stats.submitted++; if (stats.failSubmit) throw new Error('connection lost'); return { requestId: id, status: 'queued', videoUrl: null }; }, status: async () => ({ requestId: id, status: 'completed', videoUrl: 'https://media.example.com/video.mp4' }) };
  return { provider, stats };
}
test('video quote cannot be submitted from another project or without exact cost confirmation', async t => {
  const { provider, stats } = videoProvider(); const { service } = await fixture(t, { higgsfield: provider, providers: { status: async () => [], resolveEnv: async () => credentials } }); await service.saveProfile('alpha', brand);
  const quote = await service.quoteVideo('alpha', { prompt: 'Eine genaue Videoanweisung', model: 'veo-3.1' }); await assert.rejects(service.submitVideo('beta', { quoteId: quote.id, confirmCost: true }), { status: 404 }); await assert.rejects(service.submitVideo('alpha', { quoteId: quote.id })); assert.equal(stats.submitted, 0);
});
test('a quote is submitted at most once, including concurrent clicks', async t => {
  const { provider, stats } = videoProvider(); const { service } = await fixture(t, { higgsfield: provider, providers: { status: async () => [], resolveEnv: async () => credentials } }); await service.saveProfile('alpha', brand);
  const quote = await service.quoteVideo('alpha', { prompt: 'Eine genaue Videoanweisung', model: 'veo-3.1' }); const results = await Promise.allSettled([service.submitVideo('alpha', { quoteId: quote.id, confirmCost: true }), service.submitVideo('alpha', { quoteId: quote.id, confirmCost: true })]); assert.equal(stats.submitted, 1); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
});
test('price increase blocks video generation and preserves explicit review', async t => {
  const { provider, stats } = videoProvider(); const { service } = await fixture(t, { higgsfield: provider, providers: { status: async () => [], resolveEnv: async () => credentials } }); await service.saveProfile('alpha', brand);
  const quote = await service.quoteVideo('alpha', { prompt: 'Eine genaue Videoanweisung', model: 'veo-3.1' }); stats.price = '0.99'; await assert.rejects(service.submitVideo('alpha', { quoteId: quote.id, confirmCost: true }), { code: 'MARKETING_PRICE_CHANGED' }); assert.equal(stats.submitted, 0);
});
test('an uncertain paid request is never retried or reported as successful', async t => {
  const { provider, stats } = videoProvider(); stats.failSubmit = true; const { service } = await fixture(t, { higgsfield: provider, providers: { status: async () => [], resolveEnv: async () => credentials } }); await service.saveProfile('alpha', brand);
  const quote = await service.quoteVideo('alpha', { prompt: 'Eine genaue Videoanweisung', model: 'veo-3.1' }); await assert.rejects(service.submitVideo('alpha', { quoteId: quote.id, confirmCost: true })); await assert.rejects(service.submitVideo('alpha', { quoteId: quote.id, confirmCost: true })); assert.equal(stats.submitted, 1); assert.equal((await service.snapshot('alpha')).videos[0].status, 'submission_uncertain');
});

test('interrupted jobs recover honestly after service restart', async t => {
  const { store, service } = await fixture(t);
  await store.add('alpha', 'research', { status: 'running' }); await store.add('alpha', 'videos', { status: 'submitting' });
  const state = await service.snapshot('alpha'); assert.equal(state.research[0].status, 'failed'); assert.equal(state.videos[0].status, 'submission_uncertain'); assert.equal(state.activeJob, null);
});
test('server project authorization is rechecked for every tool operation', async t => {
  let allowed = true; const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-marketing-auth-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const service = createProjectMarketingService({ dataDir, getProject: async p => { if (!allowed) throw Object.assign(new Error('Module disabled'), { code: 'DISABLED', status: 403 }); return project(p); }, env: {} });
  await service.saveProfile('alpha', brand); allowed = false; await assert.rejects(service.snapshot('alpha'), { status: 403 }); await assert.rejects(service.saveProfile('alpha', { offer: 'Unauthorized' }), { status: 403 });
});
test('route handlers preserve scope guards and do not expose thrown private payloads', async () => {
  const { registerProjectMarketingRoutes } = await import('../marketing/project-routes.js');
  const routes = []; const app = { get: (path, ...handlers) => routes.push({ path, method: 'GET', handlers }), post: (path, ...handlers) => routes.push({ path, method: 'POST', handlers }) };
  let snapshots = 0;
  registerProjectMarketingRoutes(app, { service: { snapshot: async () => { snapshots++; return {}; } }, authorizeProject: async () => { throw Object.assign(new Error('private secret'), { status: 403 }); } });
  const target = routes.find(r => r.path === '/api/marketing/projects/:projectId'); const response = { statusCode: 200, set() { return this; }, status(n) { this.statusCode = n; return this; }, json(value) { this.value = value; } };
  await target.handlers.at(-1)({ params: { projectId: 'alpha' } }, response); assert.equal(snapshots, 0); assert.equal(response.statusCode, 403); assert.ok(!JSON.stringify(response.value).includes('private secret'));
});

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
test('queued marketing writes recheck module access inside the shared storage queue', async t => {
  let allowed = true, enteredSecond = false;
  const getProject = async p => { if (p === 'alpha' && !allowed) throw Object.assign(new Error('Module disabled'), { code: 'DISABLED', status: 403 }); return project(p); };
  const { service, dataDir } = await fixture(t, { getProject });
  await service.saveProfile('alpha', brand);
  const other = createProjectMarketingStore({ dataDir, getProject });
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const blocker = service.store.mutate('beta', async state => { entered.resolve(); await release.promise; state.profile = { name: 'Beta' }; return true; });
  await entered.promise;
  const queued = other.mutate('alpha', state => { enteredSecond = true; state.profile.offer = 'Not authorized'; return true; });
  await new Promise(resolve => setImmediate(resolve)); allowed = false; release.resolve();
  await blocker; await assert.rejects(queued, { status: 403 });
  assert.equal(enteredSecond, false);
  allowed = true; assert.equal((await service.snapshot('alpha')).profile.offer, brand.offer);
});
test('module revocation during generation saves a terminal status but no new content', async t => {
  let allowed = true;
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const { service } = await fixture(t, { getProject: async p => { if (!allowed) throw Object.assign(new Error('Module disabled'), { code: 'DISABLED', status: 403 }); return project(p); }, generate: async () => { entered.resolve(); await release.promise; return { summary: 'Unauthorized late result', items: [{ title: 'Late' }] }; } });
  await service.saveProfile('alpha', brand); await service.startJob('alpha', 'content', {}); await entered.promise;
  allowed = false; release.resolve(); await service.waitForIdle('alpha');
  allowed = true; const snapshot = await service.snapshot('alpha');
  assert.equal(snapshot.drafts[0].status, 'failed'); assert.equal(snapshot.drafts[0].result, undefined); assert.equal(snapshot.activeJob, null);
});
test('revocation after claiming a video cancels locally before the paid provider POST', async t => {
  let allowed = true, resolutions = 0;
  const { provider, stats } = videoProvider();
  const { service } = await fixture(t, { higgsfield: provider, getProject: async p => { if (!allowed) throw Object.assign(new Error('Module disabled'), { code: 'DISABLED', status: 403 }); return project(p); }, providers: { status: async () => [], resolveEnv: async () => { if (++resolutions === 3) allowed = false; return credentials; } } });
  await service.saveProfile('alpha', brand); const quote = await service.quoteVideo('alpha', { prompt: 'Eine genaue Videoanweisung', model: 'veo-3.1' });
  await assert.rejects(service.submitVideo('alpha', { quoteId: quote.id, confirmCost: true }), { status: 403 });
  assert.equal(stats.submitted, 0); allowed = true;
  assert.equal((await service.snapshot('alpha')).videos[0].status, 'canceled');
});
test('credential changes invalidate the confirmed price even after the local quote claim', async t => {
  let resolutions = 0;
  const { provider, stats } = videoProvider();
  const { service } = await fixture(t, { higgsfield: provider, providers: { status: async () => [], resolveEnv: async () => ++resolutions >= 3 ? { ...credentials, HF_API_KEY_SECRET: 'a-different-account' } : credentials } });
  await service.saveProfile('alpha', brand); const quote = await service.quoteVideo('alpha', { prompt: 'Eine genaue Videoanweisung', model: 'veo-3.1' });
  assert(!JSON.stringify(quote).includes('connectionFingerprint'));
  await assert.rejects(service.submitVideo('alpha', { quoteId: quote.id, confirmCost: true }), { code: 'MARKETING_CONNECTION_CHANGED' });
  assert.equal(stats.submitted, 0); assert.equal((await service.snapshot('alpha')).videos[0].status, 'canceled');
});
test('revocation after a paid request preserves its confirmed receipt without declaring it uncertain', async t => {
  let allowed = true;
  const { provider, stats } = videoProvider(); const submit = provider.submit;
  provider.submit = async (...args) => { const result = await submit(...args); allowed = false; return result; };
  const { service } = await fixture(t, { higgsfield: provider, getProject: async p => { if (!allowed) throw Object.assign(new Error('Module disabled'), { code: 'DISABLED', status: 403 }); return project(p); }, providers: { status: async () => [], resolveEnv: async () => credentials } });
  await service.saveProfile('alpha', brand); const quote = await service.quoteVideo('alpha', { prompt: 'Eine genaue Videoanweisung', model: 'veo-3.1' });
  await assert.rejects(service.submitVideo('alpha', { quoteId: quote.id, confirmCost: true }), { status: 403 });
  allowed = true; const video = (await service.snapshot('alpha')).videos[0];
  assert.equal(stats.submitted, 1); assert.equal(video.requestId, id); assert.equal(video.status, 'queued');
  await assert.rejects(service.submitVideo('alpha', { quoteId: quote.id, confirmCost: true }), { code: 'MARKETING_ALREADY_SUBMITTED' });
});
test('internal lifecycle settlement cannot create records or change content', async t => {
  const { store } = await fixture(t); await store.saveProfile('alpha', brand); const row = await store.add('alpha', 'drafts', { status: 'running' });
  await store.settle('alpha', 'drafts', row.id, { status: 'failed', result: { summary: 'must be ignored' }, message: 'Ended' });
  assert.equal((await store.get('alpha', 'drafts', row.id)).result, undefined);
  await assert.rejects(store.settle('alpha', 'profile', row.id, { status: 'failed' }));
  await assert.rejects(store.settle('missing', 'drafts', row.id, { status: 'failed' }));
});
test('revocation during source collection prevents a later paid model invocation', async t => {
  let allowed = true, modelCalls = 0;
  const { service } = await fixture(t, { getProject: async p => { if (!allowed) throw Object.assign(new Error('Module disabled'), { code: 'DISABLED', status: 403 }); return project(p); }, collect: async () => { allowed = false; return { sources: [source], coverage: { read: 1 } }; }, generate: async () => { modelCalls++; return { summary: 'Never generated' }; } });
  await service.saveProfile('alpha', brand); await service.startJob('alpha', 'research', {}); await service.waitForIdle('alpha');
  assert.equal(modelCalls, 0); allowed = true;
  assert.equal((await service.snapshot('alpha')).research[0].status, 'failed');
});
