import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMarketingWebsite, isMeaningfulMarketingText } from '../marketing/web-extract.js';
import { collectProjectResearch, normalizeMarketingEvidence, marketingSourceType } from '../marketing/project-research.js';
import { createWebsiteUrlImporter } from '../websites/import-url.js';

const URL = 'https://www.goalsandconcepts.de/';
const TEXT = 'Goals & Concepts begleitet Unternehmen mit individueller Beratung, klarer Positionierung und konkreten Konzepten für ihre nächsten Schritte.';
const env = { TAVILY_API_KEY: 'tvly-fixture-secret' };
const json = (value, extra = {}) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' }, ...extra });
const profile = { name: 'Goals & Concepts', offer: 'Beratung', audience: 'Unternehmen' };
function fixture(options = {}) {
  const calls = [], lookups = [];
  const dependencies = { env, lookupImpl: async (...args) => { lookups.push(args); return [{ address: '93.184.216.34', family: 4 }]; }, fetchImpl: async (url, init) => { calls.push({ url, init }); return json({ results: [{ url: URL, raw_content: TEXT }], failed_results: [] }); }, ...options };
  return { calls, lookups, dependencies, extract: (url, extra = {}) => extractMarketingWebsite(url, { ...dependencies, ...extra }) };
}

test('real requested website extraction follows the official endpoint and safe request shape', async () => {
  const f = fixture(); const result = await f.extract(URL);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, 'https://api.tavily.com/extract'); assert.equal(f.calls[0].init.headers.Authorization, 'Bearer tvly-fixture-secret'); assert.equal(f.calls[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { urls: [URL], extract_depth: 'advanced', format: 'text', timeout: 30 });
  assert.ok(!f.calls[0].url.includes(env.TAVILY_API_KEY)); assert.ok(!f.calls[0].init.body.includes(env.TAVILY_API_KEY)); assert.deepEqual(f.lookups[0], ['www.goalsandconcepts.de', { all: true, verbatim: true }]);
  assert.equal(result.text, TEXT); assert.equal(result.provider, 'tavily-extract'); assert.deepEqual(result.modalities, ['text']); assert.ok(Date.parse(result.fetchedAt)); assert.match(result.limitations[0], /nicht geprüft/);
});

test('failed direct read uses extraction of Goals & Concepts and records genuine extracted evidence', async () => {
  const f = fixture();
  const result = await collectProjectResearch({ profile, urls: [URL], env, readWebsite: async () => { throw new Error('compressed body'); }, extractWebsite: (url, extra) => f.extract(url, extra) });
  assert.equal(result.coverage.read, 1); assert.equal(result.sources[0].url, URL); assert.equal(result.sources[0].text, TEXT); assert.equal(result.sources[0].provider, 'tavily-extract'); assert.ok(Date.parse(result.sources[0].fetchedAt)); assert.equal(f.calls.length, 1);
});

test('JavaScript shell with too little text also triggers actual extraction', async () => {
  const f = fixture(); const result = await collectProjectResearch({ profile, urls: [URL], env, readWebsite: async () => ({ text: 'Enable JavaScript' }), extractWebsite: (url, extra) => f.extract(url, extra) });
  assert.equal(result.coverage.read, 1); assert.equal(f.calls.length, 1); assert.equal(result.sources[0].text, TEXT);
});

test('readable direct sources do not trigger an extra provider request', async () => {
  const f = fixture(); const result = await collectProjectResearch({ profile, urls: [URL], env, readWebsite: async () => ({ text: TEXT }), extractWebsite: f.extract });
  assert.equal(result.coverage.read, 1); assert.equal(f.calls.length, 0);
});

test('LinkedIn uses the same bounded fallback without claiming profile or video coverage', async () => {
  const linkedin = 'https://www.linkedin.com/company/goalsandconcepts/';
  const f = fixture({ fetchImpl: async () => json({ results: [{ url: linkedin, raw_content: TEXT }] }) });
  const result = await collectProjectResearch({ profile, urls: [linkedin], env, readWebsite: async () => { throw new Error('not accessible directly'); }, extractWebsite: (url, extra) => f.extract(url, extra) });
  assert.equal(result.coverage.read, 1); assert.equal(result.sources[0].type, 'linkedin'); assert.equal(result.sources[0].posts.length, 0); assert.deepEqual(result.sources[0].modalities, ['text']); assert.match(result.sources[0].limitations.join(' '), /Keine gelesene Post-Caption-Stichprobe/);
});

test('empty extraction and search snippets never become readable content', async () => {
  for (const row of [{ url: URL, raw_content: '' }, { url: URL, raw_content: 'Short', content: TEXT, snippet: TEXT }, { url: URL, snippet: TEXT }]) {
    const f = fixture({ fetchImpl: async () => json({ results: [row] }) });
    const result = await collectProjectResearch({ profile, urls: [URL], env, readWebsite: async () => { throw new Error('direct failed'); }, extractWebsite: (url, extra) => f.extract(url, extra) });
    assert.equal(result.coverage.read, 0); assert.equal(result.sources[0].status, 'unavailable'); assert.equal(result.sources[0].text, '');
  }
});

test('missing credentials never attempts the external fallback', async () => {
  let fallback = 0;
  const result = await collectProjectResearch({ profile, urls: [URL], env: {}, readWebsite: async () => { throw new Error('direct failed'); }, extractWebsite: async () => { fallback++; } });
  assert.equal(result.coverage.read, 0); assert.equal(fallback, 0);
  const f = fixture({ env: {} }); await assert.rejects(f.extract(URL), { code: 'MARKETING_EXTRACT_MISSING' }); assert.equal(f.calls.length, 0); assert.equal(f.lookups.length, 0);
});

test('unsafe URLs and private or mixed DNS answers never reach Tavily', async () => {
  for (const url of ['http://www.goalsandconcepts.de/', 'https://localhost/', 'https://127.0.0.1/', 'https://user:password@www.goalsandconcepts.de/', URL + '?access_token=secret']) { const f = fixture(); await assert.rejects(f.extract(url)); assert.equal(f.calls.length, 0); }
  for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }], [{ address: '::1', family: 6 }]]) { const f = fixture({ lookupImpl: async () => addresses }); await assert.rejects(f.extract(URL), { code: 'MARKETING_EXTRACT_PRIVATE' }); assert.equal(f.calls.length, 0); }
});

test('a different result URL cannot silently replace the requested company', async () => {
  for (const other of ['https://example.com/', 'https://www.goalsandconcepts.de/unrequested', 'https://goalsandconcepts.de/']) {
    const f = fixture({ fetchImpl: async () => json({ results: [{ url: other, raw_content: TEXT }] }) }); await assert.rejects(f.extract(URL), { code: 'MARKETING_EXTRACT_EMPTY' });
  }
});

test('provider redirects, reflected secrets and oversized replies are rejected safely', async () => {
  for (const reply of [new Response('', { status: 302, headers: { location: 'https://evil.example/' } }), json({ error: env.TAVILY_API_KEY }, { status: 403 }), json({ results: [{ url: URL, raw_content: 'x'.repeat(2 * 1024 * 1024) }] })]) {
    const f = fixture({ fetchImpl: async () => reply }); await assert.rejects(f.extract(URL), error => !error.message.includes(env.TAVILY_API_KEY));
  }
  const f = fixture({ fetchImpl: async () => json({ results: [{ url: URL, raw_content: TEXT + ' ' + env.TAVILY_API_KEY }] }) }); const result = await f.extract(URL); assert.ok(!JSON.stringify(result).includes(env.TAVILY_API_KEY));
});

test('DNS and provider hangs respect operation timeout and never produce evidence', async () => {
  for (const override of [{ lookupImpl: async () => new Promise(() => {}) }, { fetchImpl: async () => new Promise(() => {}) }]) {
    const f = fixture({ timeoutMs: 10, ...override }); const start = Date.now(); await assert.rejects(f.extract(URL), { code: 'MARKETING_EXTRACT_ABORTED' }); assert.ok(Date.now() - start < 1000);
  }
});

test('already canceled extraction sends no request and no DNS lookup', async () => {
  const f = fixture({ signal: AbortSignal.abort() }); await assert.rejects(f.extract(URL), { code: 'MARKETING_EXTRACT_ABORTED' }); assert.equal(f.calls.length, 0); assert.equal(f.lookups.length, 0);
});

const shells = [
  { title: 'Goals & Concepts', text: 'You need to enable JavaScript to run this app. Please enable JavaScript and reload this website to continue.' },
  { title: 'Just a moment...', text: 'www.goalsandconcepts.de Verifying you are human. This may take a few seconds. Checking your browser before proceeding. Cloudflare Ray ID: abc123.' },
  { title: 'Sign in | LinkedIn', text: 'Sign in to LinkedIn. Stay updated on your professional world. Email or phone Password Forgot password? Sign in. New to LinkedIn? Join now. User agreement Privacy policy Cookie policy.' },
];
test('JavaScript, Cloudflare and login shells are rejected even when longer than sixty characters', async () => {
  for (const shell of shells) {
    assert.ok(shell.text.length >= 60); assert.equal(isMeaningfulMarketingText(shell.text, { title: shell.title }), false);
    const f = fixture({ fetchImpl: async () => json({ results: [{ url: URL, title: shell.title, raw_content: shell.text }] }) });
    await assert.rejects(f.extract(URL), { code: 'MARKETING_EXTRACT_EMPTY' });
    const normalized = normalizeMarketingEvidence(shell, URL); assert.equal(normalized.status, 'unavailable'); assert.equal(normalized.text, ''); assert.equal(normalized.coverage.text, false);
  }
});
test('a long direct shell triggers Tavily and an extraction shell remains unavailable', async () => {
  const success = fixture();
  const good = await collectProjectResearch({ profile, urls: [URL], env, readWebsite: async () => shells[0], extractWebsite: (url, extra) => success.extract(url, extra) });
  assert.equal(good.coverage.read, 1); assert.equal(success.calls.length, 1); assert.equal(good.sources[0].provider, 'tavily-extract');
  const failure = fixture({ fetchImpl: async () => json({ results: [{ url: URL, raw_content: shells[1].text, title: shells[1].title }] }) });
  const bad = await collectProjectResearch({ profile, urls: [URL], env, readWebsite: async () => shells[0], extractWebsite: (url, extra) => failure.extract(url, extra) });
  assert.equal(bad.coverage.read, 0); assert.equal(bad.sources[0].text, '');
});
test('substantive company text with a login footer remains readable without fallback', async () => {
  const text = TEXT + ' Kundenportal Login | Datenschutz | Kontakt';
  assert.equal(isMeaningfulMarketingText(text, { title: 'Goals & Concepts' }), true);
  const f = fixture(); const result = await collectProjectResearch({ profile, urls: [URL], env, readWebsite: async () => ({ title: 'Goals & Concepts', text }), extractWebsite: f.extract });
  assert.equal(result.coverage.read, 1); assert.equal(f.calls.length, 0);
});
test('URL-only posts preserve observed metrics but cannot create read content or green coverage', async () => {
  const instagram = 'https://www.instagram.com/goalsandconcepts/';
  const result = await collectProjectResearch({ profile, urls: [instagram], env: { APIFY_TOKEN: 'fixture' }, readInstagram: async () => [{ url: 'https://www.instagram.com/p/ABC123/', likesCount: 23, commentsCount: 0, videoViewCount: 2000 }] });
  const source = result.sources[0]; assert.equal(source.status, 'unavailable'); assert.equal(result.coverage.read, 0); assert.equal(result.coverage.socialPosts, 0); assert.equal(source.coverage.text, false); assert.equal(source.posts.length, 1); assert.equal(source.posts[0].likes, 23); assert.equal(source.posts[0].views, 2000); assert.deepEqual(source.modalities, []);
  const metadata = normalizeMarketingEvidence({ status: 'metadata_only', text: 'Profilmetadaten: Followers 12345. Views 5555. Account username example. Published yesterday.', metrics: { views: 5555 } }, instagram); assert.equal(metadata.status, 'unavailable'); assert.equal(metadata.metrics.views, 5555);
});
test('real captions and timestamped visual observations can establish source content', () => {
  const instagram = 'https://www.instagram.com/goalsandconcepts/';
  const caption = normalizeMarketingEvidence({ posts: [{ url: instagram, caption: 'Ein eigenes neues Angebot.' }] }, instagram); assert.equal(caption.status, 'read'); assert.equal(caption.coverage.text, true);
  const emptyVisual = normalizeMarketingEvidence({ coverage: { visual: true }, visualObservations: [] }, instagram); assert.equal(emptyVisual.status, 'unavailable');
  const visual = normalizeMarketingEvidence({ coverage: { visual: true }, visualObservations: [{ startSeconds: 1, endSeconds: 3, text: 'Ein Unternehmenslogo und ein erklärender Bildschirm sind sichtbar.' }] }, instagram); assert.equal(visual.status, 'read'); assert.equal(visual.coverage.text, false); assert.equal(visual.coverage.visual, true); assert.deepEqual(visual.modalities, ['video']);
});
test('real final URLs are preserved separately from requested URLs and unsafe addresses are excluded', async () => {
  const finalUrl = 'https://goalsandconcepts.de/beratung';
  const result = await collectProjectResearch({ profile, urls: [URL], env: {}, readWebsite: async () => ({ url: finalUrl, text: TEXT }) }); assert.equal(result.sources[0].url, URL); assert.equal(result.sources[0].finalUrl, finalUrl);
  const explicit = normalizeMarketingEvidence({ url: URL, finalUrl, text: TEXT }, URL); assert.equal(explicit.finalUrl, finalUrl);
  for (const unsafe of ['https://user:secret@goalsandconcepts.de/', 'https://127.0.0.1/', 'https://goalsandconcepts.de/?token=private', 'https://goalsandconcepts.de/' + 'x'.repeat(2100)]) { const source = normalizeMarketingEvidence({ finalUrl: unsafe, text: TEXT }, URL); assert.equal(source.finalUrl, null); assert.ok(!JSON.stringify(source).includes(unsafe)); }
});
test('TikTok, YouTube and direct video URLs route to the actual media reader instead of website extraction', async () => {
  const urls = ['https://www.tiktok.com/@example/video/123456789', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'https://cdn.example.com/video.mp4'];
  assert.deepEqual(urls.map(marketingSourceType), ['tiktok', 'youtube', 'youtube', 'video']);
  const calls = []; const result = await collectProjectResearch({ profile, urls, env, readWebsite: async () => { throw new Error('must not use the website reader'); }, extractWebsite: async () => { throw new Error('must not extract website text'); }, readMediaEvidence: async url => { calls.push(url); return { url, status: 'analyzed', text: TEXT, coverage: { visual: true }, visualObservations: [{ startSeconds: 0, endSeconds: 1, text: 'Der Bildschirm zeigt eine tatsächliche Beispielszene.' }] }; } });
  assert.deepEqual(calls, urls); assert.equal(result.coverage.read, urls.length); assert.ok(result.sources.every(source => source.coverage.visual));
});

test('unreadable www website retries only the same path and query without www after both original readers', async () => {
  const original = URL + 'beratung?bereich=unternehmen';
  const apex = 'https://goalsandconcepts.de/beratung?bereich=unternehmen';
  const calls = [];
  const f = fixture({ fetchImpl: async (_url, init) => {
    const requested = JSON.parse(init.body).urls[0]; calls.push(['extract', requested]);
    return json(requested === apex ? { results: [{ url: apex, raw_content: TEXT }] } : { results: [], failed_results: [{ url: original, error: 'Failed to fetch url' }] });
  } });
  const result = await collectProjectResearch({ profile, urls: [original], env, readWebsite: async url => { calls.push(['direct', url]); throw new Error('compressed body'); }, extractWebsite: (url, extra) => f.extract(url, extra) });
  assert.deepEqual(calls, [['direct', original], ['extract', original], ['direct', apex], ['extract', apex]]);
  const source = result.sources[0]; assert.equal(source.url, original); assert.equal(source.finalUrl, apex); assert.equal(source.text, TEXT); assert.equal(source.provider, 'tavily-extract'); assert.equal(result.coverage.read, 1);
  assert.ok(source.limitations.includes(`Ursprüngliche www-Adresse nicht lesbar; Inhalt von ${apex} gelesen.`));
  assert.deepEqual(f.lookups.map(args => args[0]), ['www.goalsandconcepts.de', 'goalsandconcepts.de']);
});

test('empty or failed original reads can reach the apex directly without Tavily credentials', async () => {
  const apex = 'https://goalsandconcepts.de/';
  for (const original of [async () => ({ text: '' }), async () => { throw new Error('not readable'); }]) {
    const calls = [];
    const result = await collectProjectResearch({ profile, urls: [URL], env: {}, readWebsite: async url => { calls.push(url); return url === URL ? original() : { url, text: TEXT }; }, extractWebsite: async () => assert.fail('No credentials; no external provider') });
    assert.deepEqual(calls, [URL, apex]); assert.equal(result.coverage.read, 1); assert.equal(result.sources[0].finalUrl, apex); assert.equal(result.sources[0].provider, 'direct-https');
  }
});

test('failed apex is the final attempt and non-www addresses do not invent alternatives', async () => {
  for (const requested of [URL, 'https://goalsandconcepts.de/', 'https://shop.goalsandconcepts.de/']) {
    const calls = [];
    const result = await collectProjectResearch({ profile, urls: [requested], env, readWebsite: async url => { calls.push(['direct', url]); return shells[0]; }, extractWebsite: async url => { calls.push(['extract', url]); throw new Error('not readable'); } });
    assert.equal(result.coverage.read, 0); assert.equal(calls.length, requested === URL ? 4 : 2);
    assert.ok(calls.every(([, url]) => url === requested || requested === URL && url === 'https://goalsandconcepts.de/'));
  }
});

test('social and video www addresses never receive a host-alias attempt', async () => {
  const urls = ['https://www.linkedin.com/company/example/', 'https://www.instagram.com/example/', 'https://www.tiktok.com/@example/video/123', 'https://www.youtube.com/watch?v=123', 'https://www.example.com/clip.mp4'];
  const calls = [];
  const result = await collectProjectResearch({ profile, urls, env, readWebsite: async url => { calls.push(url); throw new Error('unavailable'); }, extractWebsite: async url => { calls.push(url); throw new Error('unavailable'); }, readMediaEvidence: async url => { calls.push(url); return { status: 'unavailable' }; } });
  assert.equal(result.coverage.read, 0); assert.deepEqual(calls, [urls[0], ...urls]);
});

test('credential-bearing and private URL aliases cannot reach a reader or bypass DNS checks', async () => {
  for (const unsafe of ['https://user:passw0rd@www.goalsandconcepts.de/', URL + '?password=passw0rd']) {
    await assert.rejects(collectProjectResearch({ profile, urls: [unsafe], env, readWebsite: async () => assert.fail('Unsafe address reached reader'), extractWebsite: async () => assert.fail('Unsafe address reached provider') }), { code: 'MARKETING_NO_REFERENCES' });
  }
  const literalCalls = [];
  await assert.rejects(collectProjectResearch({ profile, urls: ['https://www.127.0.0.1/'], env: {}, readWebsite: async url => { literalCalls.push(url); throw new Error('unavailable'); } }), { code: 'MARKETING_NO_REFERENCES' });
  assert.deepEqual(literalCalls, []);
  const dnsCalls = [], apiCalls = [];
  const lookupImpl = async host => { dnsCalls.push(host); return [{ address: '10.0.0.1', family: 4 }]; };
  const reader = createWebsiteUrlImporter({ lookupImpl, requestImpl: () => assert.fail('Private host reached direct HTTP') }).readWebsiteReference;
  const f = fixture({ lookupImpl, fetchImpl: async url => { apiCalls.push(url); assert.fail('Private host reached Tavily'); } });
  const result = await collectProjectResearch({ profile, urls: [URL], env, readWebsite: reader, extractWebsite: (url, extra) => f.extract(url, extra) });
  assert.equal(result.coverage.read, 0); assert.deepEqual(dnsCalls, ['www.goalsandconcepts.de', 'www.goalsandconcepts.de', 'goalsandconcepts.de', 'goalsandconcepts.de']); assert.deepEqual(apiCalls, []);
});

test('reader timeouts and aborts never trigger another extraction or host attempt', async () => {
  for (const stage of ['direct', 'extract']) {
    const calls = [];
    const result = await collectProjectResearch({ profile, urls: [URL], env, readWebsite: async url => { calls.push(['direct', url]); if (stage === 'direct') throw Object.assign(new Error('deadline'), { code: 'WEBSITE_IMPORT_ABORTED' }); return shells[0]; }, extractWebsite: async url => { calls.push(['extract', url]); throw Object.assign(new Error('deadline'), { code: 'MARKETING_EXTRACT_ABORTED' }); } });
    assert.equal(result.coverage.read, 0); assert.deepEqual(calls, stage === 'direct' ? [['direct', URL]] : [['direct', URL], ['extract', URL]]);
  }
  const controller = new AbortController(), calls = [];
  await assert.rejects(collectProjectResearch({ profile, urls: [URL], env, signal: controller.signal, readWebsite: async url => { calls.push(url); controller.abort(); return shells[0]; }, extractWebsite: async () => assert.fail('Canceled operation attempted extract') }), { name: 'AbortError' });
  assert.deepEqual(calls, [URL]);
});
