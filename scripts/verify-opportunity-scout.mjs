import test from 'node:test';
import assert from 'node:assert/strict';
import { compareOpportunityEvidence, createOpportunityScout, scrapeInstagramHashtags } from '../opportunities/scout.js';

const settings = () => ({ weeklyEnabled: true, cadence: 'daily', weeklyDay: 'monday', weeklyTime: '08:30', seedAccounts: [], tiktokAccounts: [], hashtags: [], keywords: [], includeCurated: false, maxSourcesPerRun: 80, topIdeasPerPitch: 5 });
const post = (platform, name, index = 0) => ({ url: platform === 'instagram' ? `https://www.instagram.com/reel/${name}${index}/` : `https://www.tiktok.com/@${name}/video/${1000 + index}`, account: name, caption: `Öffentliche Aussage von ${name}.`, views: null, likes: 0, comments: null, type: 'Video', timestamp: '2026-09-14T05:00:00Z' });
const idea = (refs = [1]) => ({ title: 'Prüfbare Testidee', summary: 'Vorschlag aus Quellen, keine bestätigte Nachfrage.', firstValidation: 'Drei Gespräche; bei null Interesse stoppen.', risks: 'Abhängigkeit von einer Plattform; Export testen.', sourceRefs: refs, ratings: { evidenceQuality: 10, demandEvidence: 10, automationFit: 5 } });
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(patch = {}, overrides = {}) {
  const data = { settings: { ...settings(), ...patch }, watched: [], runs: [], ideas: [], calls: [], analyses: [], medias: [] }; let clock = Date.UTC(2026, 8, 14, 8);
  const store = {
    getOpportunitySettings: async () => structuredClone(data.settings), listOpportunityWatchSources: async () => structuredClone(data.watched), listOpportunityRuns: async ({ limit }) => data.runs.slice().reverse().slice(0, limit).map(row => structuredClone(row)),
    createOpportunityRun: async input => { const run = { id: `run${data.runs.length}`, ...input, startedAt: new Date(clock++).toISOString(), status: 'running' }; data.runs.push(run); return { ...run }; },
    updateOpportunityRun: async (id, patch) => Object.assign(data.runs.find(row => row.id === id), structuredClone(patch)),
    upsertOpportunity: async input => { const item = { id: `idea${data.ideas.length}`, ...structuredClone(input) }; data.ideas.push(item); return item; },
    updateOpportunity: async (id, patch) => Object.assign(data.ideas.find(item => item.id === id), structuredClone(patch)), opportunityRadarCounts: async () => ({ runs: data.runs.length }),
  };
  const dependencies = { store, env: { APIFY_TOKEN: 'fixture-secret-token', TAVILY_API_KEY: 'fixture-search-key' }, now: () => clock,
    instagram: async (account, limit) => { data.calls.push(['instagram', account, limit]); return Array.from({ length: limit }, (_, i) => post('instagram', account, i)); },
    readSocialFeed: async input => { data.calls.push(['tiktok', input.accounts[0] || input.keywords[0], input.limit]); return { posts: Array.from({ length: input.limit }, (_, i) => post('tiktok', input.accounts[0] || 'search', i)), warnings: ['Caption only.'] }; },
    hashtags: async (tags, options) => { data.calls.push(['hashtag', tags[0], options.resultsLimit]); return [post('instagram', tags[0])]; },
    search: async query => { data.calls.push(['search', query]); return [{ url: 'https://evidence.example/' + encodeURIComponent(query), title: query, text: 'Tatsächlich übergebener Suchauszug zum Produkt.', snippet: 'Snippet' }]; },
    read: async url => ({ finalUrl: url, title: 'Originalseite', text: 'Tatsächlich gelesener Seitentext.' }),
    readMediaEvidence: async url => { data.medias.push(url); return { status: 'analyzed', text: 'Sichtbarer Produktablauf.', transcript: '0–2s: Tatsächlich gehörter Satz.', coverage: { visual: true, audio: true, transcript: true, caption: true }, claims: [{ text: 'Behauptung der Quelle.' }], gaps: ['Keine lückenlose Erfassung.'], provider: 'fixture-video' }; },
    analyze: async evidence => { data.analyses.push(structuredClone(evidence)); return { ideas: [idea()], discardedSignals: [] }; }, ...overrides };
  return { scout: createOpportunityScout(dependencies), data, dependencies };
}

test('every explicit Instagram and TikTok account receives a fair share of the operation budget', async () => {
  const ig = Array.from({ length: 7 }, (_, i) => 'ig' + i), tt = Array.from({ length: 6 }, (_, i) => 'tt' + i);
  const f = fixture({ seedAccounts: ig, tiktokAccounts: tt, maxSourcesPerRun: 20 });
  const result = await f.scout.run({ maxVideosPerRun: 4 });
  assert.equal(f.data.calls.length, 13);
  assert.deepEqual(new Set(f.data.calls.map(row => row[1])), new Set([...ig, ...tt]));
  assert.equal(result.run.sourceCount, 20);
  assert.equal(result.run.sourceCoverage.filter(row => row.status === 'read').length, 13);
  assert.equal(result.run.mediaCoverage.selected, 4);
  assert.equal(result.run.mediaCoverage.notSelected, 16);
  assert.equal(result.run.mediaCoverage.complete, false);
  assert.equal(f.data.analyses[0][0].metrics.views, null);
  assert.equal(f.data.analyses[0][0].metrics.likes, 0);
  assert.equal(f.data.analyses[0][0].metrics.comments, null);
  assert(!f.data.calls.some(row => row[1] === 'iamformed'));
  assert.equal((await f.scout.status()).weekly.telegram, false);
});

test('small per-operation budgets rotate deferred accounts from stored run coverage, without a daily quota', async () => {
  const f = fixture({ seedAccounts: ['a', 'b', 'c', 'd'], maxSourcesPerRun: 2 });
  await f.scout.run({ maxVideosPerRun: 0 }); await f.scout.run({ maxVideosPerRun: 0 });
  assert.deepEqual(f.data.calls.map(row => row[1]), ['a', 'b', 'c', 'd']);
  assert.equal(f.data.runs[0].sourceCoverage.filter(row => row.status === 'deferred').length, 2);
  assert.equal(f.data.runs.length, 2);
});

test('selected video accounts rotate across scans and missing visual/audio coverage remains explicit', async () => {
  const f = fixture({ seedAccounts: ['a', 'b', 'c'], maxSourcesPerRun: 3 }, { readMediaEvidence: async () => ({ status: 'metadata_only', coverage: { caption: true, visual: false, audio: false }, text: 'Caption only.', gaps: ['Kein Video abgerufen.'] }) });
  await f.scout.run({ maxVideosPerRun: 1 }); await f.scout.run({ maxVideosPerRun: 1 });
  assert.equal(f.data.runs[0].evidence.find(row => row.mediaStatus === 'metadata_only').account, 'a');
  assert.equal(f.data.runs[1].evidence.find(row => row.mediaStatus === 'metadata_only').account, 'b');
  assert.equal(f.data.runs[0].mediaCoverage.visual, 0);
  assert.equal(f.data.ideas[0].ratings.evidenceQuality, 3);
  assert.match(f.data.ideas[0].evidenceLimits, /nur als Metadaten/);
});

test('keywords gather TikTok and genuine web evidence; explicit websites are read and failures reported', async () => {
  const f = fixture({ keywords: ['digitale Vorlagen'], maxSourcesPerRun: 10 });
  f.data.watched = [{ type: 'website', name: 'Produkt', url: 'https://product.example/docs' }];
  const result = await f.scout.run({ maxVideosPerRun: 0 });
  assert(f.data.calls.some(row => row[0] === 'search'));
  assert(f.data.calls.some(row => row[0] === 'tiktok'));
  assert(result.run.evidence.some(row => row.contentBasis === 'page-read' && row.coverage.page));
  assert(result.run.evidence.some(row => row.contentBasis === 'search-extract' && row.coverage.page));
});

test('partial source errors cannot invent observations or expose credentials', async () => {
  const f = fixture({ seedAccounts: ['good', 'broken'], maxSourcesPerRun: 2 }, { instagram: async account => { if (account === 'broken') throw new Error('fixture-secret-token Bearer credential token=hidden'); return [post('instagram', account)]; } });
  const result = await f.scout.run({ maxVideosPerRun: 0 });
  assert.equal(result.run.sourceCount, 1);
  assert.equal(result.run.sourceCoverage.find(row => row.account === 'broken').status, 'failed');
  assert(!JSON.stringify(result).includes('fixture-secret-token'));
  assert(!JSON.stringify(result).includes('token=hidden'));
  assert.equal(result.run.evidence[0].coverage.visual, false);
});

test('unconfigured Social does not block a usable explicit web source', async () => {
  const f = fixture({ seedAccounts: ['missing'], maxSourcesPerRun: 10 }, { env: {}, instagram: null, hashtags: null, readSocialFeed: null, search: null });
  f.data.watched = [{ type: 'website', url: 'https://product.example/' }];
  const result = await f.scout.run({ maxVideosPerRun: 0 });
  assert.equal(result.run.sourceCoverage.find(row => row.account === 'missing').status, 'unconfigured');
  assert.equal(result.run.sourceCount, 1);
  assert.equal((await f.scout.status()).ready, true);
  assert.equal((await f.scout.status()).partial, true);
});

test('invalid source references never silently become source 1', async () => {
  const f = fixture({ seedAccounts: ['a'] }, { analyze: async () => ({ ideas: [idea([0, -1, 999, '1'])] }) });
  const result = await f.scout.run({ maxVideosPerRun: 0 });
  assert.equal(result.opportunities.length, 0);
  assert.match(result.warnings[0].error, /Quellenreferenz/);
});

test('arrays, booleans and blank strings are not fabricated zero engagement measurements', async () => {
  const f = fixture({ seedAccounts: ['a'], maxSourcesPerRun: 1 }, { instagram: async () => [{ ...post('instagram', 'a'), likes: false, views: ' ', comments: [], commentsCount: 7 }] });
  const result = await f.scout.run({ maxVideosPerRun: 0 });
  assert.deepEqual(result.run.evidence[0].metrics, { views: null, likes: null, comments: 7 });
});

test('concurrent callers share a scan; abort stops later analysis and opportunity writes', async () => {
  const entered = gate(), release = gate(), controller = new AbortController();
  const f = fixture({ seedAccounts: ['a'] }, { instagram: async () => { entered.resolve(); await release.promise; return [post('instagram', 'a')]; } });
  const one = f.scout.run({}, { signal: controller.signal }), two = f.scout.run();
  await entered.promise; controller.abort(new Error('caller abort'));
  await assert.rejects(one, error => error.code === 'SCOUT_ABORTED');
  await assert.rejects(two, error => error.code === 'SCOUT_ABORTED');
  release.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.data.runs.length, 1);
  assert.equal(f.data.runs[0].status, 'interrupted');
  assert.equal(f.data.ideas.length, 0);
  assert.equal(f.data.analyses.length, 0);
});

test('Instagram hashtag calls bound output and keep credentials out of URLs', async () => {
  let call;
  const rows = await scrapeInstagramHashtags(['a', 'b', 'c', 'd'], { resultsLimit: 80, env: { APIFY_TOKEN: 'private-fixture' }, fetchImpl: async (url, options) => { call = { url: String(url), options }; return new Response(JSON.stringify([post('instagram', 'a')])); } });
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(call.options.body).resultsLimit, 20);
  assert.equal(new URL(call.url).searchParams.get('limit'), '80');
  assert(!call.url.includes('private-fixture'));
  assert.equal(call.options.headers.Authorization, 'Bearer private-fixture');
  assert.equal(call.options.redirect, 'error');
});

const observation = (name, metrics, retrievedAt = '2026-09-15T08:00:00.000Z') => ({
  url: `https://www.instagram.com/reel/${name}/`, metrics,
  timestamp: '2020-01-01T00:00:00.000Z', retrievedAt,
});

test('snapshot comparison distinguishes first observation, unchanged and actual measured growth', () => {
  const yesterday = '2026-09-14T08:00:00.000Z';
  const previous = [{ id: 'yesterday', evidence: [observation('growing', { views: 100, likes: 0, comments: 3 }, yesterday), observation('steady', { views: 80, likes: 4, comments: 0 }, yesterday)] }];
  const evidence = [observation('growing', { views: 125, likes: 2, comments: 3 }), observation('steady', { views: 80, likes: 4, comments: 0 }), observation('first-seen', { views: 100000, likes: 30, comments: null })];
  const unchangedInput = structuredClone({ previous, evidence });
  const [growing, steady, fresh] = compareOpportunityEvidence(evidence, previous);
  assert.equal(growing.trend.status, 'changed');
  assert.deepEqual(growing.trend.delta, { views: 25, likes: 2, comments: 0 });
  assert.deepEqual(growing.trend.changedMetrics, ['views', 'likes']);
  assert.equal(growing.trend.observationIntervalSeconds, 86400);
  assert.equal(growing.trend.previousObservedAt, yesterday);
  assert.equal(growing.trend.baselineRunId, 'yesterday');
  assert.equal(growing.trend.timeStatus, 'ordered');
  assert.equal(steady.trend.status, 'seen');
  assert.deepEqual(steady.trend.delta, { views: 0, likes: 0, comments: 0 });
  assert.equal(steady.trend.comparable, true);
  assert.equal(fresh.trend.status, 'new');
  assert.equal(fresh.trend.comparable, false);
  assert.equal(fresh.trend.baselineRunId, null);
  assert.equal(fresh.trend.observationIntervalSeconds, null);
  assert.deepEqual(fresh.trend.delta, { views: null, likes: null, comments: null });
  assert.deepEqual({ previous, evidence }, unchangedInput);
});

test('unknown values and counter decreases do not invent growth or coerce stored non-numbers', () => {
  const oldTime = '2026-09-14T08:00:00.000Z';
  const prior = [{ id: 'old', evidence: [observation('unknown', { views: null, likes: '20', comments: false }, oldTime), observation('reset', { views: 100, likes: 10, comments: 2 }, oldTime), observation('missing', { views: 40, likes: 2, comments: 3 }, oldTime)] }];
  const [unknown, reset, missing] = compareOpportunityEvidence([observation('unknown', { views: 900, likes: 25, comments: 1 }), observation('reset', { views: 4, likes: 12, comments: 2 }), observation('missing', { views: null, likes: [], comments: NaN })], prior);
  assert.equal(unknown.trend.status, 'seen');
  assert.equal(unknown.trend.comparable, false);
  assert.deepEqual(unknown.trend.delta, { views: null, likes: null, comments: null });
  assert.deepEqual(unknown.trend.previousMetrics, { views: null, likes: null, comments: null });
  assert.equal(reset.trend.status, 'changed');
  assert.deepEqual(reset.trend.delta, { views: null, likes: 2, comments: 0 });
  assert.equal(reset.trend.metricStatus.views, 'decreased-or-reset');
  assert.deepEqual(reset.trend.changedMetrics, ['views', 'likes']);
  assert.equal(missing.trend.status, 'seen');
  assert.equal(missing.trend.comparable, false);
  assert.deepEqual(missing.trend.delta, { views: null, likes: null, comments: null });
});

test('baseline selection uses the latest actual observation of the same URL instead of run or publication order', () => {
  const runs = [
    { id: 'started-later', startedAt: '2026-09-14T09:00:00Z', evidence: [observation('same', { views: 10 }, '2026-09-14T09:10:00Z')] },
    { id: 'slow-started-earlier', startedAt: '2026-09-14T08:00:00Z', evidence: [observation('same', { views: 20 }, '2026-09-14T09:30:00Z'), observation('other', { views: 99999 }, '2026-09-14T10:00:00Z')] },
    { id: 'unknown-time', evidence: [observation('same', { views: 999 }, null)] },
  ];
  const [row] = compareOpportunityEvidence([observation('same', { views: 22 }, '2026-09-14T09:31:30Z')], runs);
  assert.equal(row.trend.baselineRunId, 'slow-started-earlier');
  assert.equal(row.trend.delta.views, 2);
  assert.equal(row.trend.observationIntervalSeconds, 90);
  assert.equal(row.trend.previousMetrics.views, 20);
});

test('missing observation timestamps stay unknown and out-of-order snapshots produce no directional change', () => {
  const prior = [{ id: 'previous', evidence: [observation('missing-time', { views: 10 }, null), observation('backwards', { views: 10 }, '2026-09-15T09:00:00Z'), observation('same-time', { views: 10 })] }];
  const [missing, backwards, simultaneous] = compareOpportunityEvidence([observation('missing-time', { views: 12 }), observation('backwards', { views: 12 }), observation('same-time', { views: 12 })], prior);
  assert.equal(missing.trend.delta.views, 2);
  assert.equal(missing.trend.observationIntervalSeconds, null);
  assert.equal(missing.trend.previousObservedAt, null);
  assert.equal(missing.trend.timeStatus, 'unknown');
  for (const row of [backwards, simultaneous]) {
    assert.equal(row.trend.status, 'seen');
    assert.equal(row.trend.comparable, false);
    assert.equal(row.trend.observationIntervalSeconds, null);
    assert.equal(row.trend.delta.views, null);
    assert.equal(row.trend.metricStatus.views, 'invalid-observation-order');
  }
});

test('later scans compare persisted snapshots and provide measured trends to analysis and run summary', async () => {
  let fetches = 0;
  const f = fixture({ seedAccounts: ['a'], maxSourcesPerRun: 4 }, { instagram: async () => {
    const later = fetches++ > 0;
    const rows = [['growth', later ? 125 : 100], ['unknown', null], ['reset', later ? 10 : 30], ...(later ? [['new', 5]] : [])];
    return rows.map(([name, views]) => ({ ...post('instagram', name), views, likes: null, comments: null }));
  } });
  const first = await f.scout.run({ maxVideosPerRun: 0 });
  const firstSnapshot = structuredClone(first.run.evidence);
  const second = await f.scout.run({ maxVideosPerRun: 0 });
  assert.equal(first.run.trends.new, 3);
  assert.equal(first.run.trends.changed, 0);
  assert.deepEqual(Object.fromEntries(['new', 'seen', 'changed', 'comparable', 'increased', 'decreasedOrReset'].map(key => [key, second.run.trends[key]])), { new: 1, seen: 1, changed: 2, comparable: 2, increased: 1, decreasedOrReset: 1 });
  const growth = second.run.evidence.find(row => row.account === 'growth');
  assert.equal(growth.trend.baselineRunId, first.run.id);
  assert.equal(growth.trend.delta.views, 25);
  assert.equal(growth.trend.observationIntervalSeconds, 0.001);
  assert.deepEqual(f.data.analyses[1].map(row => row.trend), second.run.evidence.map(row => row.trend));
  assert.deepEqual(first.run.evidence, firstSnapshot);
  assert.equal(f.data.runs.length, 2);
});
