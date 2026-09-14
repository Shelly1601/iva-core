import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstagramConnector, normalizeInstagramReference } from '../integrations/instagram.js';
import { instagramSkill, instagramSkillMeta } from '../skills/instagram.js';

const now = () => new Date('2026-09-14T12:00:00.000Z');
const metaEnv = { INSTAGRAM_AUTH_MODE: 'facebook', INSTAGRAM_ACCOUNT_ID: '1789001', META_GRAPH_VERSION: 'v24.0', META_ACCESS_TOKEN: 'test-secret-meta' };
const verifiedPage = { data: [{ id: '555', instagram_business_account: { id: '1789001', username: 'own_account' } }] };
const media = { id: '1790001', caption: 'Eigener Beitrag', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://www.instagram.com/reel/Own123/?access_token=secret', timestamp: '2026-09-14T08:00:00Z', like_count: 4, comments_count: 1 };
function transport(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), ...options, body: options.body ? JSON.parse(options.body) : undefined });
    const next = responses.shift();
    assert.ok(next !== undefined, 'Unexpected network request');
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(url, options);
    return new Response(JSON.stringify(next), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

test('strict Instagram-only references keep exact reel shortcode and drop tracking/secrets', () => {
  assert.deepEqual(normalizeInstagramReference('https://www.instagram.com/reel/Dckq7WmNdCJ/?stkn=private'), { kind: 'reel', shortcode: 'Dckq7WmNdCJ', url: 'https://www.instagram.com/reel/Dckq7WmNdCJ/' });
  assert.equal(normalizeInstagramReference('@Own_Account').url, 'https://www.instagram.com/own_account/');
  for (const reference of ['http://instagram.com/reel/ABC123/', 'https://instagram.com.evil.test/reel/ABC123/', 'https://instagram.com@evil.test/reel/ABC123/', 'https://u:p@instagram.com/reel/ABC123/', 'https://instagram.com:4318/reel/ABC123/', 'https://instagram.com/direct/inbox/', 'https://instagram.com/stories/private/123/', 'https://instagram.com/p/%2e%2e/', 'https://instagram.com/explore/tags/tag/', 'https://instagram.com\\@evil.test/', 'https://localhost/reel/ABC123/', 'reel']) assert.equal(normalizeInstagramReference(reference), null, reference);
});

test('missing credentials produce concrete missing_connection results without a request', async () => {
  const { fetchImpl, calls } = transport([]);
  const connector = createInstagramConnector({ env: {}, fetchImpl, now });
  assert.equal(connector.getInstagramConnectionStatus().publicReferences.status, 'missing_connection');
  assert.equal((await connector.readInstagramReference({ reference: '@own_account' })).code, 'missing_connection');
  const result = await connector.listOwnInstagramMedia();
  assert.equal(result.code, 'missing_connection');
  assert.ok(result.missing.includes('META_ACCESS_TOKEN'));
  assert.ok(result.missing.includes('INSTAGRAM_AUTH_MODE (facebook oder instagram)'));
  assert.equal((await connector.readOwnInstagramComments({ mediaId: media.id })).code, 'missing_connection');
  assert.equal(calls.length, 0);
});

test('configured status never pretends OAuth is connected and exposes no credentials', () => {
  const connector = createInstagramConnector({ env: { ...metaEnv, APIFY_TOKEN: 'test-secret-apify' } });
  const status = connector.getInstagramConnectionStatus();
  assert.equal(status.publicReferences.status, 'configured');
  assert.equal(status.professionalAccount.status, 'configured');
  assert.equal(status.professionalAccount.verified, false);
  assert.equal(status.publishing.status, 'unsupported');
  assert.equal(status.messaging.status, 'unsupported');
  assert.ok(!JSON.stringify(status).includes('test-secret'));
});

test('public reel read keeps URL, requests one bounded result and uses header auth', async () => {
  const { fetchImpl, calls } = transport([[{ id: 'abc', url: 'https://www.instagram.com/reel/Dckq7WmNdCJ/?token=test-secret-apify', caption: 'Caption, keine Transkription', type: 'Video', ownerUsername: 'someone', likesCount: 12, commentsCount: 3, videoViewCount: 1000, videoUrl: 'https://cdn.example/video.mp4', transcription: 'not trusted' }]]);
  const result = await createInstagramConnector({ env: { APIFY_TOKEN: 'test-secret-apify' }, fetchImpl, now }).readInstagramReference({ reference: 'https://www.instagram.com/reel/Dckq7WmNdCJ/?stkn=tracking', limit: 12 });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const request = calls[0];
  assert.deepEqual(request.body.directUrls, ['https://www.instagram.com/reel/Dckq7WmNdCJ/']);
  assert.equal(request.body.resultsType, 'reels');
  assert.equal(request.body.resultsLimit, 1);
  assert.equal(request.headers.Authorization, 'Bearer test-secret-apify');
  assert.equal(request.redirect, 'error');
  assert.equal(new URL(request.url).searchParams.get('token'), null);
  assert.equal(new URL(request.url).searchParams.get('maxTotalChargeUsd'), '0.10');
  assert.ok(Number(new URL(request.url).searchParams.get('timeout')) <= 60);
  assert.equal(result.items[0].evidence.fetchedAt, now().toISOString());
  assert.equal(result.transcript.available, false);
  assert.equal(result.items[0].transcription, undefined);
  assert.equal(result.items[0].videoUrl, undefined);
  assert.ok(!JSON.stringify(result).includes('test-secret'));
  assert.ok(!JSON.stringify(result).includes('tracking'));
});

test('profile bounds, private/mismatched-source filters and caption redaction', async () => {
  const post = (n, overrides = {}) => ({ id: String(n), ownerUsername: 'own_account', url: `https://www.instagram.com/p/ABC${n}/`, caption: 'Hello', ...overrides });
  const { fetchImpl, calls } = transport([[post(0, { isPrivate: true }), post(1, { ownerUsername: 'foreign' }), post(2, { url: 'https://evil.test/p/ABC/' }), post(3, { caption: 'test-secret-apify https://test.invalid?access_token=url-secret' }), ...Array.from({ length: 20 }, (_, n) => post(n + 10, { caption: 'x'.repeat(5000) }))]]);
  const result = await createInstagramConnector({ env: { APIFY_TOKEN: 'test-secret-apify' }, fetchImpl, now }).readInstagramReference({ reference: '@own_account', limit: 1000 });
  assert.equal(result.count, 12);
  assert.equal(result.limited, true);
  assert.equal(result.items[0].id, '3');
  assert.ok(!result.items[0].caption.includes('test-secret-apify'));
  assert.ok(!result.items[0].caption.includes('url-secret'));
  assert.equal(result.items[1].caption.length, 3000);
  assert.equal(result.items[1].captionTruncated, true);
  assert.equal(calls[0].body.resultsLimit, 12);
});

test('wrong exact reel and private results are not reported as observed content', async () => {
  const { fetchImpl } = transport([[{ url: 'https://www.instagram.com/reel/Other123/', caption: 'Wrong content' }, { url: 'https://www.instagram.com/reel/Exact123/', isPrivate: true, caption: 'Private content' }]]);
  const result = await createInstagramConnector({ env: { APIFY_TOKEN: 'test-secret' }, fetchImpl, now }).readInstagramReference({ reference: 'https://www.instagram.com/reel/Exact123/' });
  assert.equal(result.code, 'no_public_data');
  assert.ok(!JSON.stringify(result).includes('Private content'));
});

test('provider error bodies and thrown URL/query-token errors never escape', async () => {
  const env = { APIFY_TOKEN: 'secret-token' };
  for (const response of [() => new Response('https://api.apify.com?token=secret-token&access_token=another-secret', { status: 401 }), new Error('fetch https://api.apify.com/?token=secret-token'), { error: { message: 'Bearer secret-token https://example.test/?token=other-secret' } }]) {
    const { fetchImpl } = transport([response]);
    const result = await createInstagramConnector({ env, fetchImpl, now }).readInstagramReference({ reference: '@own_account' });
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes('secret'));
    assert.ok(!JSON.stringify(result).includes('https://'));
  }
});

test('oversized responses are rejected and timeout aborts transport', async () => {
  const large = transport([[{ caption: 'x'.repeat(600_000) }]]);
  assert.equal((await createInstagramConnector({ env: { APIFY_TOKEN: 'x' }, fetchImpl: large.fetchImpl }).readInstagramReference({ reference: '@own_account' })).code, 'response_too_large');
  let aborted = false;
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true }));
  const result = await createInstagramConnector({ env: { APIFY_TOKEN: 'x' }, fetchImpl, timeoutMs: 10 }).readInstagramReference({ reference: '@own_account' });
  assert.equal(result.code, 'timeout');
  assert.equal(aborted, true);
});

test('Facebook account is verified before own media and all requests omit URL tokens', async () => {
  const { fetchImpl, calls } = transport([verifiedPage, { data: [media] }]);
  const result = await createInstagramConnector({ env: metaEnv, fetchImpl, now }).listOwnInstagramMedia({ limit: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.account.id, '1789001');
  assert.equal(new URL(calls[0].url).pathname, '/v24.0/me/accounts');
  assert.equal(new URL(calls[1].url).pathname, '/v24.0/1789001/media');
  for (const request of calls) {
    assert.equal(request.headers.Authorization, 'Bearer test-secret-meta');
    assert.ok(!request.url.includes('access_token'));
    assert.equal(request.redirect, 'error');
  }
  assert.equal(result.items[0].permalink, 'https://www.instagram.com/reel/Own123/');
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('Instagram login verifies /me identity and never silently falls back to Facebook', async () => {
  const env = { INSTAGRAM_AUTH_MODE: 'instagram', INSTAGRAM_ACCOUNT_ID: '1789001', META_GRAPH_VERSION: 'v24.0', INSTAGRAM_ACCESS_TOKEN: 'ig-only-token', META_ACCESS_TOKEN: 'wrong-token' };
  const { fetchImpl, calls } = transport([{ user_id: '1789001', username: 'own_account' }, { data: [media] }]);
  assert.equal((await createInstagramConnector({ env, fetchImpl, now }).listOwnInstagramMedia()).ok, true);
  assert.equal(new URL(calls[0].url).hostname, 'graph.instagram.com');
  assert.equal(new URL(calls[0].url).pathname, '/v24.0/me');
  assert.equal(calls[0].headers.Authorization, 'Bearer ig-only-token');
  const wrong = transport([{ user_id: '999', username: 'other' }]);
  assert.equal((await createInstagramConnector({ env, fetchImpl: wrong.fetchImpl }).listOwnInstagramMedia()).code, 'account_scope_mismatch');
  assert.equal(wrong.calls.length, 1);
});

test('foreign configured account is rejected before querying its media', async () => {
  const { fetchImpl, calls } = transport([{ data: [{ id: '55', instagram_business_account: { id: '999' } }] }]);
  const result = await createInstagramConnector({ env: metaEnv, fetchImpl }).listOwnInstagramMedia();
  assert.equal(result.code, 'account_scope_unverified');
  assert.equal(calls.length, 1);
});

test('comments require verified membership in own media and reject foreign media', async () => {
  const foreign = transport([verifiedPage, { data: [media] }]);
  const rejected = await createInstagramConnector({ env: metaEnv, fetchImpl: foreign.fetchImpl }).readOwnInstagramComments({ mediaId: '999' });
  assert.equal(rejected.code, 'media_scope_unverified');
  assert.equal(foreign.calls.length, 2);
  assert.ok(foreign.calls.every(call => !call.url.includes('/999')));
  const owned = transport([verifiedPage, { data: [media] }, { data: [{ id: '19001', text: 'Eine echte Frage', timestamp: '2026-09-14T10:00:00Z', like_count: 2 }] }]);
  const result = await createInstagramConnector({ env: metaEnv, fetchImpl: owned.fetchImpl, now }).readOwnInstagramComments({ mediaId: media.id });
  assert.equal(result.ok, true);
  assert.equal(result.items[0].text, 'Eine echte Frage');
  assert.equal(result.items[0].evidence.mediaId, media.id);
  assert.equal(new URL(owned.calls[2].url).pathname, `/v24.0/${media.id}/comments`);
  const invalid = transport([]);
  assert.equal((await createInstagramConnector({ env: metaEnv, fetchImpl: invalid.fetchImpl }).readOwnInstagramComments({ mediaId: '../me' })).code, 'invalid_media_id');
  assert.equal(invalid.calls.length, 0);
});

test('paging uses only cursor on fixed endpoint, caps pages and declares truncation', async () => {
  const page = n => ({ data: [{ ...media, id: String(1791000 + n) }], paging: { next: 'https://evil.test/exfiltrate?access_token=do-not-follow', cursors: { after: `CURSOR${n}` } } });
  const { fetchImpl, calls } = transport([verifiedPage, page(1), page(2), page(3)]);
  const result = await createInstagramConnector({ env: metaEnv, fetchImpl, now }).listOwnInstagramMedia({ limit: 50 });
  assert.equal(result.ok, true);
  assert.equal(result.count, 3);
  assert.equal(result.limited, true);
  assert.equal(calls.length, 4);
  assert.equal(new URL(calls[2].url).searchParams.get('after'), 'CURSOR1');
  assert.ok(calls.every(call => new URL(call.url).hostname === 'graph.facebook.com'));
  assert.ok(!JSON.stringify(result).includes('do-not-follow'));
});

test('separate injected project credentials remain separate', async () => {
  const envA = { ...metaEnv, INSTAGRAM_AUTH_MODE: 'instagram', INSTAGRAM_ACCESS_TOKEN: 'project-a', INSTAGRAM_ACCOUNT_ID: '11' };
  const envB = { ...metaEnv, INSTAGRAM_AUTH_MODE: 'instagram', INSTAGRAM_ACCESS_TOKEN: 'project-b', INSTAGRAM_ACCOUNT_ID: '22' };
  const a = transport([{ user_id: '11' }, { data: [] }]);
  const b = transport([{ user_id: '22' }, { data: [] }]);
  const results = await Promise.all([createInstagramConnector({ env: envA, fetchImpl: a.fetchImpl }).listOwnInstagramMedia(), createInstagramConnector({ env: envB, fetchImpl: b.fetchImpl }).listOwnInstagramMedia()]);
  assert.deepEqual(results.map(result => result.account.id), ['11', '22']);
  assert.ok(a.calls.every(call => call.headers.Authorization === 'Bearer project-a'));
  assert.ok(b.calls.every(call => call.headers.Authorization === 'Bearer project-b'));
  const empty = createInstagramConnector({ env: {}, fetchImpl: a.fetchImpl });
  assert.equal((await empty.listOwnInstagramMedia()).code, 'missing_connection');
});

test('skill tools call real adapter contracts and schemas expose only bounded read arguments', async () => {
  const { fetchImpl, calls } = transport([]);
  const skill = instagramSkill(createInstagramConnector({ env: {}, fetchImpl }));
  assert.deepEqual(Object.keys(skill), instagramSkillMeta.toolNames);
  assert.equal((await skill.listOwnInstagramMedia.execute({})).code, 'missing_connection');
  assert.equal((await skill.getInstagramConnectionStatus.execute({})).publicReferences.status, 'missing_connection');
  assert.equal(skill.readInstagramReference.parameters.safeParse({ reference: 'x', limit: 13 }).success, false);
  assert.equal(skill.readOwnInstagramComments.parameters.safeParse({ mediaId: '../me' }).success, false);
  assert.equal(calls.length, 0);
});
