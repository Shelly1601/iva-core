import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { estimateUsageEUR } from '../core/router.js';
import { normalizeMediaReference, readMediaEvidence, readSocialFeed } from '../integrations/media-evidence.js';

const IG = 'https://www.instagram.com/reel/Dckq7WmNdCJ/';
const TT = 'https://www.tiktok.com/@example/video/1234567890123456789';
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const VIDEO = 'https://cdn.example.com/video.mp4?signature=signed-cdn-value';
const env = { APIFY_TOKEN: 'fixture-apify-secret', GEMINI_API_KEY: 'fixture-google-secret' };
const mp4 = (size = 64) => { const bytes = Buffer.alloc(size); bytes.writeUInt32BE(24, 0); bytes.write('ftypisom', 4); return bytes; };
const json = (value, extra = {}) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' }, ...extra });
const observed = (overrides = {}) => ({ mediaAccessible: true, visualObserved: true, audioObserved: true, durationSeconds: 60, summary: 'Ein Werkzeug wird im Video vorgestellt.', transcript: [{ startSeconds: 1, endSeconds: 3, text: 'Hier zeige ich ein Werkzeug.' }], visualObservations: [{ startSeconds: 1, endSeconds: 3, text: 'Eine Person zeigt einen Bildschirm.' }], audioObservations: [{ startSeconds: 1, endSeconds: 3, text: 'Eine Stimme spricht.' }], claims: [{ startSeconds: 1, endSeconds: 3, basis: 'spoken', text: 'Die Quelle bezeichnet das Gezeigte als Werkzeug.' }], warnings: [], gaps: [], ...overrides });
const gemini = (value = observed(), extra = {}) => json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 200, thoughtsTokenCount: 50 }, ...extra });
const igItem = (extra = {}) => ({ url: IG, caption: 'CAPTION_CANARY – ein Beitragstext.', ownerUsername: 'example', timestamp: '2026-09-14T08:00:00Z', videoDuration: 60, likesCount: 10, commentsCount: 2, videoViewCount: 100, videoUrl: VIDEO, ...extra });
const ttItem = (extra = {}) => ({ webVideoUrl: TT, text: 'TikTok-Beitrag', authorMeta: { name: 'example', privateAccount: false }, createTimeISO: '2026-09-14T08:00:00Z', videoMeta: { duration: 60 }, playCount: 321, diggCount: 12, commentCount: 3, mediaUrls: [VIDEO], ...extra });

function fixtures({ rows = [igItem()], analysis = observed(), downloads = {}, lookupImpl, fetchImpl, countTokens = async () => json({ totalTokens: 1234 }), extra = {} } = {}) {
  const providerCalls = [], publicCalls = [], budgetCalls = [], usageCalls = [], dnsCalls = [], reserveCalls = [], releaseCalls = [];
  const options = {
    env,
    now: () => Date.parse('2026-09-14T12:00:00Z'),
    checkBudgetImpl: async value => { budgetCalls.push(value); },
    reserveBudgetImpl: async (routed, estimate) => { reserveCalls.push({ routed, estimate }); return () => releaseCalls.push(routed); },
    recordUsageImpl: async (...args) => { usageCalls.push(args); },
    lookupImpl: lookupImpl || (async (...args) => { dnsCalls.push(args); return [{ address: '93.184.216.34', family: 4 }]; }),
    fetchImpl: async (url, init) => {
      providerCalls.push({ url, init });
      if (url.includes(':countTokens')) return countTokens(url, init);
      if (fetchImpl) return fetchImpl(url, init);
      if (url.startsWith('https://api.apify.com/')) return json(rows);
      if (url.includes(':generateContent')) return gemini(analysis);
      throw new Error('Unexpected fixture provider route');
    },
    requestImpl: (url, config, callback) => {
      publicCalls.push({ url: String(url), config });
      const request = new EventEmitter();
      request.destroy = () => {};
      request.end = () => queueMicrotask(() => {
        const value = downloads[String(url)] || { bytes: mp4(), mimeType: 'video/mp4' };
        const bytes = value.bytes || Buffer.alloc(0);
        const response = Readable.from([bytes]);
        response.statusCode = value.status || 200;
        response.headers = { 'content-type': value.mimeType || 'video/mp4', 'content-length': String(bytes.length), ...value.headers };
        callback(response);
      });
      return request;
    },
    ...extra,
  };
  return { options, providerCalls, publicCalls, budgetCalls, usageCalls, dnsCalls, reserveCalls, releaseCalls };
}

test('normalizes only individual social videos and removes sharing credentials', () => {
  assert.equal(normalizeMediaReference('https://instagram.com/reel/Dckq7WmNdCJ/?stkn=abc').url, IG);
  assert.equal(normalizeMediaReference('https://youtu.be/dQw4w9WgXcQ?si=token').url, YT);
  assert.equal(normalizeMediaReference('https://www.youtube.com/shorts/dQw4w9WgXcQ').url, YT);
  assert.equal(normalizeMediaReference(TT + '?token=secret').url, TT);
  assert.equal(normalizeMediaReference('https://vm.tiktok.com/abcdef/').platform, 'tiktok');
  for (const input of ['http://example.com/a.mp4', 'https://user:pass@example.com/a', 'https://localhost/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://example.com:444/a', 'https://instagram.com/example', 'https://youtube.com/watch?v=no', 'https://www.tiktok.com/@example']) assert.throws(() => normalizeMediaReference(input));
});

test('actual Instagram bytes reach Gemini, while caption and credentials never enter video input', async () => {
  const f = fixtures();
  const result = await readMediaEvidence(IG, f.options);
  assert.equal(result.status, 'analyzed');
  assert.deepEqual(result.coverage, { caption: true, transcript: true, visual: true, audio: true });
  assert.equal(result.media.sha256, createHash('sha256').update(mp4()).digest('hex'));
  assert.equal(result.media.verifiedDownload, true);
  assert.equal(result.coverageDetails.basis, 'inline_video_bytes');
  assert.equal(result.coverageDetails.complete, false);
  assert.deepEqual(result.metrics, { views: 100, likes: 10, comments: 2 });
  assert.equal(result.claims[0].status, 'source_claim_not_independently_verified');
  assert.ok(result.claims[0].evidenceIds.every(id => result.evidence.some(row => row.id === id && row.kind === 'transcript')));
  const model = f.providerCalls.find(row => row.url.includes(':generateContent'));
  assert.equal(JSON.parse(model.init.body).contents[0].parts[0].inlineData.data, mp4().toString('base64'));
  assert.ok(!model.init.body.includes('CAPTION_CANARY'));
  assert.equal(model.init.headers['x-goog-api-key'], env.GEMINI_API_KEY);
  assert.equal(model.init.redirect, 'error');
  assert.equal(f.publicCalls[0].url, VIDEO);
  assert.equal(f.publicCalls[0].config.headers.Authorization, undefined);
  assert.equal(f.publicCalls[0].config.headers.Cookie, undefined);
  assert.equal(f.publicCalls[0].config.agent, false);
  await new Promise((resolve, reject) => f.publicCalls[0].config.lookup('cdn.example.com', { all: true }, (error, addresses) => { try { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]); resolve(); } catch (failure) { reject(failure); } }));
  assert.equal(f.budgetCalls.length, 1);
  assert.deepEqual(f.usageCalls[0][1], { promptTokens: 100, completionTokens: 250 });
  assert.ok(!JSON.stringify(result).includes('signed-cdn-value'));
  assert.ok(f.providerCalls.every(row => !row.url.includes(env.APIFY_TOKEN) && !row.url.includes(env.GEMINI_API_KEY)));
});

test('metadata remains explicitly caption-only without Gemini credentials', async () => {
  const f = fixtures({ extra: { env: { APIFY_TOKEN: env.APIFY_TOKEN } } });
  const result = await readMediaEvidence(IG, f.options);
  assert.equal(result.status, 'metadata_only');
  assert.deepEqual(result.coverage, { caption: true, transcript: false, visual: false, audio: false });
  assert.match(result.text, /kein Videotranskript/);
  assert.equal(result.transcript, ''); assert.deepEqual(result.claims, []);
  assert.equal(result.errorCode, 'MEDIA_GEMINI_MISSING');
  assert.equal(f.providerCalls.length, 1);
});

test('missing Apify produces unavailable, never invented post contents', async () => {
  const f = fixtures({ extra: { env: {} } });
  const result = await readMediaEvidence(IG, f.options);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.errorCode, 'MEDIA_APIFY_MISSING');
  assert.equal(result.text, ''); assert.deepEqual(result.evidence, []);
  assert.equal(f.providerCalls.length, 0);
});

test('wrong or private posts are rejected before download', async () => {
  for (const row of [igItem({ url: 'https://www.instagram.com/reel/Other123/' }), igItem({ isPrivate: true }), igItem({ error: 'not found' })]) {
    const f = fixtures({ rows: [row] }); const result = await readMediaEvidence(IG, f.options);
    assert.equal(result.errorCode, 'MEDIA_NO_MATCH'); assert.equal(result.coverage.caption, false); assert.equal(f.publicCalls.length, 0);
  }
});

test('YouTube uses the official video file input without website text or Apify', async () => {
  const f = fixtures(); const result = await readMediaEvidence(YT, f.options);
  assert.equal(result.status, 'analyzed'); assert.equal(result.provider, 'gemini');
  assert.equal(result.coverage.caption, false); assert.equal(result.coverageDetails.basis, 'youtube_video_input');
  assert.deepEqual(JSON.parse(f.providerCalls[0].init.body).contents[0].parts[0], { fileData: { mimeType: 'video/mp4', fileUri: YT } });
  assert.equal(f.publicCalls.length, 0); assert.equal(f.providerCalls.length, 2);
});

test('an unavailable YouTube video does not produce analysis claims', async () => {
  const f = fixtures({ analysis: observed({ mediaAccessible: false }) }); const result = await readMediaEvidence(YT, f.options);
  assert.equal(result.status, 'unavailable'); assert.equal(result.errorCode, 'MEDIA_UNOBSERVED');
  assert.deepEqual(result.claims, []); assert.deepEqual(result.evidence, []);
});

test('model channel booleans alone do not establish coverage', async () => {
  const f = fixtures({ analysis: observed({ transcript: [], visualObservations: [{ startSeconds: -1, endSeconds: 3, text: 'Invalid.' }], audioObservations: [{ startSeconds: 0, endSeconds: 1000, text: 'Invalid.' }] }) });
  const result = await readMediaEvidence(YT, f.options);
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.coverage, { caption: false, transcript: false, visual: false, audio: false });
  assert.equal(result.summary, ''); assert.deepEqual(result.claims, []);
});

test('music cannot support spoken claims and unsupported temporal claims are removed', async () => {
  const f = fixtures({ analysis: observed({ transcript: [], audioObservations: [{ startSeconds: 0, endSeconds: 3, text: 'Musik.' }], claims: [{ startSeconds: 1, endSeconds: 2, basis: 'spoken', text: 'Spoken invention.' }, { startSeconds: 1, endSeconds: 2, basis: 'mixed', text: 'Mixed invention.' }, { startSeconds: 50, endSeconds: 55, basis: 'visual', text: 'Unobserved moment.' }, { startSeconds: 1, endSeconds: 2, basis: 'visual', text: 'Eine Person ist zu sehen.' }] }) });
  const result = await readMediaEvidence(YT, f.options);
  assert.equal(result.coverage.audio, true); assert.equal(result.coverage.transcript, false);
  assert.equal(result.claims.length, 1); assert.equal(result.claims[0].basis, 'visual');
});

test('truncated or malformed Gemini output is never accepted as analysis', async () => {
  for (const output of [gemini(observed(), { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{}' }] } }] }), json({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] })]) {
    const f = fixtures({ fetchImpl: async () => output }); const result = await readMediaEvidence(YT, f.options);
    assert.equal(result.status, 'unavailable'); assert.deepEqual(result.claims, []);
  }
});

test('public HTML discovers a relative video and keeps website metadata separate', async () => {
  const page = 'https://example.com/demo'; const video = 'https://example.com/media/demo.mp4';
  const f = fixtures({ downloads: { [page]: { bytes: Buffer.from('<html><title>Demo</title><meta name="description" content="WEB_CAPTION_CANARY"><video src="/media/demo.mp4"></video></html>'), mimeType: 'text/html' } } });
  const result = await readMediaEvidence(page, f.options);
  assert.equal(result.title, 'Demo'); assert.equal(result.status, 'analyzed'); assert.equal(result.provider, 'public_https+gemini');
  assert.equal(f.publicCalls[1].url, video); assert.ok(!f.providerCalls[0].init.body.includes('WEB_CAPTION_CANARY'));
});

test('a download labeled video but containing HTML is rejected', async () => {
  const f = fixtures({ downloads: { [VIDEO]: { bytes: Buffer.from('<html>login required</html>'), mimeType: 'video/mp4' } } });
  const result = await readMediaEvidence(IG, f.options);
  assert.equal(result.status, 'metadata_only'); assert.equal(result.errorCode, 'MEDIA_FORMAT_UNSUPPORTED'); assert.equal(f.providerCalls.length, 1);
});

test('DNS private and mixed public/private answers are blocked before connection', async () => {
  for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }], [{ address: '::ffff:192.168.1.1', family: 6 }]]) {
    const f = fixtures({ lookupImpl: async () => addresses }); const result = await readMediaEvidence('https://example.com/video.mp4', f.options);
    assert.equal(result.errorCode, 'MEDIA_PRIVATE_NETWORK'); assert.equal(f.publicCalls.length, 0); assert.equal(f.providerCalls.length, 0);
  }
});

test('each public redirect target is revalidated and private redirects are blocked', async () => {
  const source = 'https://example.com/video.mp4';
  const f = fixtures({ downloads: { [source]: { status: 302, headers: { location: 'https://127.0.0.1/private' } } } });
  const result = await readMediaEvidence(source, f.options);
  assert.equal(result.errorCode, 'MEDIA_UNSAFE_URL'); assert.equal(f.publicCalls.length, 1); assert.equal(f.providerCalls.length, 0);
});

test('redirect loops, compressed downloads and oversized files have finite bounds', async () => {
  const source = 'https://example.com/video.mp4';
  for (const [value, code, requests] of [[{ status: 302, headers: { location: source } }, 'MEDIA_REDIRECT_LIMIT', 4], [{ headers: { 'content-encoding': 'gzip' } }, 'MEDIA_ENCODING', 1], [{ headers: { 'content-length': String(65 * 1024 * 1024) } }, 'MEDIA_SIZE_LIMIT', 1]]) {
    const f = fixtures({ downloads: { [source]: value } }); const result = await readMediaEvidence(source, f.options);
    assert.equal(result.errorCode, code); assert.equal(f.publicCalls.length, requests); assert.equal(f.providerCalls.length, 0);
  }
});

test('provider redirects are rejected and never followed with credentials', async () => {
  const f = fixtures({ fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://evil.example/steal' } }) });
  const result = await readMediaEvidence(IG, f.options);
  assert.equal(result.errorCode, 'MEDIA_PROVIDER_REDIRECT'); assert.equal(f.providerCalls.length, 1);
  assert.equal(f.providerCalls[0].init.redirect, 'error'); assert.equal(f.publicCalls.length, 0);
});

test('provider failures keep actual metadata and redact reflected credentials', async () => {
  const f = fixtures({ rows: [igItem({ caption: `Actual caption ${env.APIFY_TOKEN} token=privatevalue`, videoUrl: undefined })] });
  const result = await readMediaEvidence(IG, f.options);
  assert.equal(result.status, 'metadata_only'); assert.ok(!JSON.stringify(result).includes(env.APIFY_TOKEN)); assert.ok(!JSON.stringify(result).includes('privatevalue'));
});

test('provider requests that ignore abort still finish within the global timeout', async () => {
  const f = fixtures({ fetchImpl: async () => new Promise(() => {}), extra: { timeoutMs: 10 } });
  const before = Date.now(); const result = await readMediaEvidence(YT, f.options);
  assert.equal(result.errorCode, 'MEDIA_TIMEOUT'); assert.ok(Date.now() - before < 1000);
});

test('pre-aborted requests make no provider call', async () => {
  const f = fixtures({ extra: { signal: AbortSignal.abort() } }); const result = await readMediaEvidence(YT, f.options);
  assert.equal(result.errorCode, 'MEDIA_TIMEOUT'); assert.equal(f.providerCalls.length, 0);
});

test('large media uses resumable Files upload, ACTIVE input and deletion', async () => {
  const bytes = mp4(13 * 1024 * 1024); const source = 'https://example.com/large.mp4';
  const f = fixtures({ downloads: { [source]: { bytes } }, fetchImpl: async (url, init) => {
    if (url.endsWith('/upload/v1beta/files')) return new Response('', { status: 200, headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=fixture-session' } });
    if (url.includes('upload_id=')) { assert.equal(init.headers['x-goog-api-key'], undefined); assert.equal(init.body.length, bytes.length); return json({ file: { name: 'files/fixture', uri: 'https://generativelanguage.googleapis.com/v1beta/files/fixture', state: 'ACTIVE' } }); }
    if (init.method === 'DELETE') return new Response('', { status: 200 });
    if (url.includes(':generateContent')) { assert.deepEqual(JSON.parse(init.body).contents[0].parts[0], { fileData: { mimeType: 'video/mp4', fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/fixture' } }); return gemini(); }
    throw new Error('Unexpected upload route');
  } });
  const result = await readMediaEvidence(source, f.options);
  assert.equal(result.status, 'analyzed'); assert.equal(result.coverageDetails.basis, 'processed_video_file');
  assert.equal(f.providerCalls.at(-1).init.method, 'DELETE'); assert.ok(!JSON.stringify(result).includes('fixture-session'));
});

test('off-host upload targets never receive bytes or API credentials', async () => {
  const source = 'https://example.com/large.mp4';
  const f = fixtures({ downloads: { [source]: { bytes: mp4(13 * 1024 * 1024) } }, fetchImpl: async () => new Response('', { status: 200, headers: { 'x-goog-upload-url': 'https://evil.example/upload/steal' } }) });
  const result = await readMediaEvidence(source, f.options);
  assert.equal(result.errorCode, 'MEDIA_UPLOAD_TARGET'); assert.equal(f.providerCalls.length, 1);
});

test('TikTok individual video requests download media, while slideshows stay metadata-only', async () => {
  const f = fixtures({ rows: [ttItem()] }); const result = await readMediaEvidence(TT, f.options);
  assert.equal(result.status, 'analyzed'); assert.equal(result.metrics.views, 321);
  assert.equal(JSON.parse(f.providerCalls[0].init.body).shouldDownloadVideos, true);
  const slideshow = fixtures({ rows: [ttItem({ isSlideshow: true })] }); const photo = await readMediaEvidence(TT, slideshow.options);
  assert.equal(photo.status, 'metadata_only'); assert.equal(slideshow.publicCalls.length, 0);
});

test('TikTok feeds use documented profiles, hashtags and search queries with metadata-only coverage', async () => {
  const f = fixtures({ rows: [ttItem(), ttItem(), ttItem({ webVideoUrl: 'https://www.tiktok.com/@private/video/999999999', authorMeta: { privateAccount: true } }), ttItem({ webVideoUrl: 'https://www.tiktok.com/@other/video/888888888', playCount: undefined, diggCount: false, commentCount: ' ' })] });
  const result = await readSocialFeed({ platform: 'tiktok', accounts: ['@example', 'example'], keywords: ['#energie', 'Website KI'], limit: 12 }, f.options);
  assert.equal(result.posts.length, 2); assert.deepEqual(result.coverage, { caption: true, transcript: false, visual: false, audio: false });
  assert.deepEqual(JSON.parse(f.providerCalls[0].init.body), { profiles: ['example'], profileScrapeSections: ['videos'], profileSorting: 'latest', hashtags: ['energie'], searchQueries: ['Website KI'], searchSection: '/video', resultsPerPage: 12, shouldDownloadVideos: false, shouldDownloadCovers: false, shouldDownloadSubtitles: false, scrapeRelatedVideos: false });
  assert.equal(result.posts[0].timestamp, '2026-09-14T08:00:00.000Z'); assert.equal(result.posts[1].views, null); assert.equal(result.posts[1].likes, null); assert.equal(result.posts[1].comments, null);
  assert.equal(f.publicCalls.length, 0); assert.equal(f.providerCalls.length, 1); assert.equal(f.budgetCalls.length, 0);
  assert.equal(f.providerCalls[0].init.headers.Authorization, `Bearer ${env.APIFY_TOKEN}`);
});

test('feed input validation and bounds avoid unconstrained actor runs', async () => {
  const f = fixtures({ rows: [] });
  assert.deepEqual((await readSocialFeed({ platform: 'tiktok' }, f.options)).posts, []); assert.equal(f.providerCalls.length, 0);
  await assert.rejects(readSocialFeed({ platform: 'instagram', accounts: ['example'] }, f.options), { code: 'MEDIA_FEED_PLATFORM' });
  await assert.rejects(readSocialFeed({ platform: 'tiktok', accounts: 'example' }, f.options), { code: 'MEDIA_FEED_INPUT' });
  await readSocialFeed({ platform: 'tiktok', accounts: Array.from({ length: 20 }, (_, n) => `account${n}`), limit: 9999 }, f.options);
  const body = JSON.parse(f.providerCalls[0].init.body); assert.equal(body.profiles.length, 10); assert.equal(body.resultsPerPage, 50);
  assert.equal(new URL(f.providerCalls[0].url).searchParams.get('maxItems'), '50');
});

test('counted video input and enforced output ceiling reserve before paid generation', async () => {
  const f = fixtures(); const result = await readMediaEvidence(IG, f.options);
  const count = f.providerCalls.find(row => row.url.includes(':countTokens'));
  const generation = f.providerCalls.find(row => row.url.includes(':generateContent'));
  assert.deepEqual(JSON.parse(count.init.body).contents, JSON.parse(generation.init.body).contents);
  assert.equal(JSON.parse(generation.init.body).generationConfig.maxOutputTokens, 12000);
  assert.equal(f.reserveCalls.length, 1); assert.equal(f.releaseCalls.length, 1);
  assert.equal(f.reserveCalls[0].estimate, estimateUsageEUR(f.reserveCalls[0].routed, { promptTokens: 1234, completionTokens: 12000 }));
  assert.equal(result.budget.countedPromptTokens, 1234); assert.equal(result.budget.maxOutputTokens, 12000);
  assert.equal(result.budget.basis, 'provider_token_count_and_router_price_estimate');
});

test('unavailable or malformed token counts preserve captions without generation or reservation', async () => {
  for (const reply of [json({}), json({ totalTokens: -1 }), json({ totalTokens: '1234' }), json({ totalTokens: 1.5 }), json({ totalTokens: Number.MAX_SAFE_INTEGER + 1 }), new Response('', { status: 503 })]) {
    const f = fixtures({ countTokens: async () => reply }); const result = await readMediaEvidence(IG, f.options);
    assert.equal(result.status, 'metadata_only'); assert.equal(result.coverage.caption, true); assert.equal(result.coverage.visual, false); assert.equal(result.coverage.audio, false);
    assert.ok(!f.providerCalls.some(row => row.url.includes(':generateContent'))); assert.equal(f.reserveCalls.length, 0); assert.equal(f.releaseCalls.length, 0); assert.equal(f.usageCalls.length, 0);
  }
});

test('token counting that ignores abort terminates without reserving or generating', async () => {
  const f = fixtures({ countTokens: async () => new Promise(() => {}), extra: { timeoutMs: 10 } });
  const before = Date.now(); const result = await readMediaEvidence(YT, f.options);
  assert.equal(result.errorCode, 'MEDIA_TIMEOUT'); assert.ok(Date.now() - before < 1000); assert.equal(f.providerCalls.length, 1); assert.equal(f.reserveCalls.length, 0); assert.equal(f.usageCalls.length, 0);
});

test('cancellation after budget check prevents reservation and generation', async () => {
  const controller = new AbortController(); const f = fixtures({ extra: { signal: controller.signal, checkBudgetImpl: async () => controller.abort() } });
  const result = await readMediaEvidence(YT, f.options);
  assert.equal(result.errorCode, 'MEDIA_TIMEOUT'); assert.equal(f.reserveCalls.length, 0); assert.equal(f.releaseCalls.length, 0); assert.equal(f.providerCalls.length, 1);
});

test('cancellation immediately after reservation releases once without paid call', async () => {
  const controller = new AbortController(); let reserved = 0, released = 0;
  const f = fixtures({ extra: { signal: controller.signal, reserveBudgetImpl: async () => { reserved++; controller.abort(); return () => released++; } } });
  const result = await readMediaEvidence(YT, f.options);
  assert.equal(result.errorCode, 'MEDIA_TIMEOUT'); assert.equal(reserved, 1); assert.equal(released, 1); assert.equal(f.providerCalls.length, 1); assert.equal(f.usageCalls.length, 0);
});

test('provider failure, malformed output and usage-booking failure all release reservations', async () => {
  for (const extra of [{ fetchImpl: async () => new Response('', { status: 500 }) }, { fetchImpl: async () => json({ candidates: [{ content: { parts: [{ text: 'invalid' }] } }] }) }, { extra: { recordUsageImpl: async () => { throw new Error('accounting failed'); } } }]) {
    const f = fixtures(extra); const result = await readMediaEvidence(YT, f.options);
    assert.equal(result.status, 'unavailable'); assert.equal(f.reserveCalls.length, 1); assert.equal(f.releaseCalls.length, 1);
  }
});

test('cancellation during paid request releases its reservation even if provider ignores abort', async () => {
  const f = fixtures({ fetchImpl: async () => new Promise(() => {}), extra: { timeoutMs: 10 } }); const result = await readMediaEvidence(YT, f.options);
  assert.equal(result.errorCode, 'MEDIA_TIMEOUT'); assert.equal(f.reserveCalls.length, 1); assert.equal(f.releaseCalls.length, 1); assert.equal(f.usageCalls.length, 0);
});

test('atomic reservations stop concurrent video analyses from spending the same available budget', async () => {
  let occupied = false, reserved = 0, released = 0, generations = 0;
  let finish, started; const gate = new Promise(resolve => finish = resolve); const running = new Promise(resolve => started = resolve);
  const reserveBudgetImpl = async () => { if (occupied) throw Object.assign(new Error('Budget in use'), { code: 'budget_exceeded' }); occupied = true; reserved++; return () => { assert.equal(occupied, true); occupied = false; released++; }; };
  const first = fixtures({ extra: { reserveBudgetImpl }, fetchImpl: async url => { if (url.includes(':generateContent')) { generations++; started(); await gate; return gemini(); } return json([igItem()]); } });
  const second = fixtures({ extra: { reserveBudgetImpl } });
  const pending = readMediaEvidence(IG, first.options); await running;
  const refused = await readMediaEvidence(IG, second.options);
  assert.equal(refused.status, 'metadata_only'); assert.equal(refused.errorCode, 'budget_exceeded'); assert.ok(!second.providerCalls.some(row => row.url.includes(':generateContent')));
  finish(); const result = await pending; assert.equal(result.status, 'analyzed'); assert.equal(generations, 1); assert.equal(reserved, 1); assert.equal(released, 1); assert.equal(occupied, false);
});

test('unpriced media model overrides cannot use a generic fallback rate for paid generation', async () => {
  const f = fixtures({ extra: { env: { ...env, IVA_MEDIA_GEMINI_MODEL: 'gemini-unpriced-new-model' } } }); const result = await readMediaEvidence(IG, f.options);
  assert.equal(result.errorCode, 'MEDIA_PRICING_UNKNOWN'); assert.equal(result.status, 'metadata_only'); assert.equal(f.reserveCalls.length, 0); assert.ok(!f.providerCalls.some(row => row.url.includes(':countTokens') || row.url.includes(':generateContent')));
});
