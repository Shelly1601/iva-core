import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWebsiteHostHandler } from '../website-host/server.mjs';

const env = { IVA_CORE_ORIGIN: 'https://iva-core.example.test', IVA_WEBSITE_PUBLISH_KEY: 'test-publish-capability-0123456789abcdef', RAILWAY_PUBLIC_DOMAIN: 'iva-websites.example.test' };
const html = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"><h1>Published only</h1>';
const payload = (siteId = 'site-1', body = html) => ({ html: body, siteId, revisionId: 'revision-1', artifactHash: createHash('sha256').update(body).digest('hex') });
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const calls = [];
let clock = 1000;
let upstream = async url => response(payload(new URL(url).searchParams.get('siteId') || 'custom-site'));
const host = createWebsiteHostHandler({ env, now: () => clock, fetchImpl: async (url, options) => { calls.push({ url, options }); return upstream(url, options); } });

function result() { return { statusCode: 0, headers: {}, destroyed: false, writableEnded: false, setHeader(name, value) { this.headers[name.toLowerCase()] = String(value); }, end(bytes) { this.body = bytes ? Buffer.from(bytes).toString('utf8') : ''; this.writableEnded = true; } }; }
async function request(handler = host, { path = '/s/site-1/', method = 'GET', hostname = env.RAILWAY_PUBLIC_DOMAIN, headers = {} } = {}) { const res = result(); await handler.handle({ method, url: path, headers: { host: hostname, ...headers } }, res); return res; }

const health = await request(host, { path: '/health', hostname: '' });
assert.equal(health.statusCode, 200); assert.deepEqual(JSON.parse(health.body), { ok: true }); assert.equal(calls.length, 0);
const published = await request();
assert.equal(published.statusCode, 200); assert.equal(published.body, html); assert.equal(published.headers['x-robots-tag'], 'noindex, nofollow'); assert.equal(published.headers['referrer-policy'], 'no-referrer'); assert.equal(published.headers['x-content-type-options'], 'nosniff');
assert.equal(published.headers['x-iva-revision'], 'revision-1');
assert.equal(calls.length, 1); assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.headers.Authorization, `Bearer ${env.IVA_WEBSITE_PUBLISH_KEY}`); assert(calls[0].options.signal instanceof AbortSignal); assert.equal(calls[0].url, 'https://iva-core.example.test/_website-published?siteId=site-1'); assert(!JSON.stringify(published).includes(env.IVA_WEBSITE_PUBLISH_KEY));
const spa = await request(host, { path: '/s/site-1/about/team?ignored=value' }); assert.equal(spa.body, html); assert.equal(calls.length, 1);
const head = await request(host, { method: 'HEAD' }); assert.equal(head.statusCode, 200); assert.equal(head.body, ''); assert.equal(head.headers['content-length'], String(Buffer.byteLength(html)));
const unchanged = await request(host, { headers: { 'if-none-match': `W/${published.headers.etag}` } }); assert.equal(unchanged.statusCode, 304); assert.equal(unchanged.body, '');
assert.equal((await request(host, { method: 'POST' })).statusCode, 405); assert.equal((await request(host, { path: '/' })).statusCode, 404); assert.equal((await request(host, { path: '/api/projects' })).statusCode, 404); assert.equal((await request(host, { path: '//evil.test/' })).statusCode, 400);
const domain = await request(host, { path: '/about', hostname: 'WWW.Customer.test:443', headers: { 'x-forwarded-host': 'attack.test' } });
assert.equal(domain.statusCode, 200); assert.equal(domain.headers['x-robots-tag'], undefined); assert.equal(calls.at(-1).url, 'https://iva-core.example.test/_website-published?hostname=www.customer.test');
for (const invalid of ['user@evil.test', 'bad.test/path', 'bad.test:65536', 'bad..test', 'bad-.test', '127.0.0.1', '[::1]', ' bad.test']) assert.equal((await request(host, { hostname: invalid })).statusCode, 400);
const spoofed = await request(host, { path: '/s/site-1/', hostname: 'another.customer.test', headers: { 'x-forwarded-host': env.RAILWAY_PUBLIC_DOMAIN } }); assert.equal(spoofed.statusCode, 200); assert.equal(calls.at(-1).url, 'https://iva-core.example.test/_website-published?hostname=another.customer.test');

clock += 30001; await request(); assert.equal(calls.filter(call => call.url.endsWith('siteId=site-1')).length, 2);
upstream = async () => new Response('Sensitive backend token details', { status: 401 });
const unauthorized = await request(host, { path: '/s/unavailable/' }); assert.equal(unauthorized.statusCode, 503); assert(!unauthorized.body.includes('Sensitive')); assert.equal(unauthorized.headers['cache-control'], 'no-store');
upstream = async () => new Response('Not published', { status: 404 }); assert.equal((await request(host, { path: '/s/not-published/' })).statusCode, 404);
upstream = async () => response(payload('different-site')); assert.equal((await request(host, { path: '/s/mismatched/' })).statusCode, 502);
upstream = async () => response(payload('leaked-key', `<html>${env.IVA_WEBSITE_PUBLISH_KEY}</html>`)); const protectedKey = await request(host, { path: '/s/leaked-key/' }); assert.equal(protectedKey.statusCode, 502); assert(!protectedKey.body.includes(env.IVA_WEBSITE_PUBLISH_KEY));
upstream = async () => response({ ...payload(), artifactHash: 'invalid' }); assert.equal((await request(host, { path: '/s/bad-hash/' })).statusCode, 502);
upstream = async () => response({ ...payload('hash-mismatch'), artifactHash: 'a'.repeat(64) }); assert.equal((await request(host, { path: '/s/hash-mismatch/' })).statusCode, 502);
upstream = async () => new Response('{broken'); assert.equal((await request(host, { path: '/s/bad-json/' })).statusCode, 502);
upstream = async () => new Response('{}', { headers: { 'content-length': String(41 * 1024 * 1024) } }); assert.equal((await request(host, { path: '/s/declared-too-large/' })).statusCode, 502);
upstream = async () => response(payload('too-large', 'a'.repeat(20 * 1024 * 1024 + 1))); assert.equal((await request(host, { path: '/s/too-large/' })).statusCode, 502);

let smallCalls = 0;
const many = createWebsiteHostHandler({ env, now: () => clock, fetchImpl: async url => { smallCalls++; return response(payload(new URL(url).searchParams.get('siteId'))); } });
for (let i = 0; i < 101; i++) await request(many, { path: `/s/site-${i}/` });
assert.equal(many.cacheStats().entries, 100); await request(many, { path: '/s/site-0/' }); assert.equal(smallCalls, 102);
const mediumHtml = 'b'.repeat(18 * 1024 * 1024);
const bounded = createWebsiteHostHandler({ env, fetchImpl: async url => response(payload(new URL(url).searchParams.get('siteId'), mediumHtml)) });
for (let i = 0; i < 3; i++) await request(bounded, { path: `/s/medium-${i}/` }); assert(bounded.cacheStats().bytes <= 50 * 1024 * 1024); assert.equal(bounded.cacheStats().entries, 2);

const blockers = [];
const coalesced = createWebsiteHostHandler({ env, fetchImpl: url => new Promise(resolve => { blockers.push({ url, resolve }); }) });
const first = request(coalesced); const second = request(coalesced); await Promise.resolve(); assert.equal(blockers.length, 1); blockers[0].resolve(response(payload())); assert.equal((await first).body, html); assert.equal((await second).body, html); assert.equal(coalesced.cacheStats().inFlight, 0);
const capped = createWebsiteHostHandler({ env, fetchImpl: url => new Promise(resolve => blockers.push({ url, resolve })) });
const pending = []; for (let i = 0; i < 4; i++) pending.push(request(capped, { path: `/s/pending-${i}/` }));
assert.equal((await request(capped, { path: '/s/over-cap/' })).statusCode, 503); assert.equal(capped.cacheStats().inFlight, 4);
for (const blocked of blockers.slice(1)) blocked.resolve(response(payload(new URL(blocked.url).searchParams.get('siteId')))); await Promise.all(pending); assert.equal(capped.cacheStats().inFlight, 0);
const timeout = createWebsiteHostHandler({ env, timeoutMs: 10, fetchImpl: async () => new Promise(() => {}) }); const timed = await request(timeout); assert.equal(timed.statusCode, 504); assert.equal(timeout.cacheStats().inFlight, 0);
const bodyTimeout = createWebsiteHostHandler({ env, timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({ start() {} })) }); assert.equal((await request(bodyTimeout)).statusCode, 504);
let verificationCalls = 0;
const verifiedRevision = 'ec28a810-a974-41be-bb5a-9c45a14d5cb7';
const verifier = createWebsiteHostHandler({ env, fetchImpl: async () => { verificationCalls++; return response({ ...payload(), revisionId: verificationCalls > 1 ? verifiedRevision : 'revision-1' }); } });
await request(verifier); await request(verifier, { path: '/s/site-1/?iva-version=anything' }); assert.equal(verificationCalls, 1);
await request(verifier, { path: `/s/site-1/?iva-version=${verifiedRevision}`, method: 'HEAD' }); assert.equal(verificationCalls, 1);
const refreshed = await request(verifier, { path: `/s/site-1/?iva-version=${verifiedRevision}` }); assert.equal(refreshed.headers['x-iva-revision'], verifiedRevision); assert.equal(verificationCalls, 2);
await request(verifier, { path: `/s/site-1/?iva-version=${verifiedRevision}` }); assert.equal(verificationCalls, 2);
assert.throws(() => createWebsiteHostHandler({ env: { ...env, IVA_CORE_ORIGIN: `https://user:secret@${env.RAILWAY_PUBLIC_DOMAIN}` } }), /Origin/);
assert.throws(() => createWebsiteHostHandler({ env: { ...env, IVA_CORE_ORIGIN: `https://${env.RAILWAY_PUBLIC_DOMAIN}` } }), /getrennte Origins/);
assert.throws(() => createWebsiteHostHandler({ env: { ...env, IVA_WEBSITE_PUBLISH_KEY: '' } }), /PUBLISH_KEY/);
console.log('Website host: publication isolation, domain routing, opaque errors, fixed upstream, GET/HEAD, ETag, SPA paths, cache limits, response caps, coalescing, concurrency and deadlines passed.');
