import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createGitHubWebsiteConnector, inspectGitHubWebsiteReference, validateGitHubWebsiteFiles } from '../websites/github.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const TOKEN = 'test-token-never-persisted';
const source = { path: 'index.html', content: '<h1>IVA Website</h1>', encoding: 'utf8' };
const hash = bytes => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const repo = { full_name: 'nadine/site', default_branch: 'main', private: true, owner: { login: 'nadine' } };
function fixture(overrides = {}) {
  const calls = [];
  let head = A;
  const fetchImpl = async (url, options) => {
    const route = new URL(url).pathname + new URL(url).search;
    const method = options.method;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ route, method, body, options });
    if (overrides.handle) {
      const custom = await overrides.handle({ route, method, body, calls, getHead: () => head, setHead: value => { head = value; } });
      if (custom) return custom;
    }
    if (route === '/user') return reply({ login: 'nadine' });
    if (route === '/user/repos' && method === 'POST') return reply(repo, 201);
    if (route === '/repos/nadine/site') return reply(repo);
    if (route === '/repos/nadine/site/contents/README.md' && method === 'PUT') return reply({ commit: { sha: A } }, 201);
    if (route === '/repos/nadine/site/git/ref/heads/main') return reply({ object: { type: 'commit', sha: head } });
    if (route === `/repos/nadine/site/git/commits/${A}`) return reply({ sha: A, tree: { sha: B } });
    if (route === '/repos/nadine/site/git/blobs' && method === 'POST') return reply({ sha: hash(Buffer.from(body.content, 'base64')) }, 201);
    if (route === '/repos/nadine/site/git/trees' && method === 'POST') return reply({ sha: C }, 201);
    if (route === '/repos/nadine/site/git/commits' && method === 'POST') return reply({ sha: D }, 201);
    if (route === '/repos/nadine/site/git/refs/heads/main' && method === 'PATCH') { head = body.sha; return reply({ object: { type: 'commit', sha: head } }); }
    throw new Error(`Unexpected mock request: ${method} ${route}`);
  };
  return { calls, connector: createGitHubWebsiteConnector({ env: { GITHUB_TOKEN: TOKEN }, fetchImpl }) };
}

test('status only reports configured; validation performs no network calls', () => {
  const connector = createGitHubWebsiteConnector({ env: { GH_TOKEN: TOKEN }, fetchImpl: () => { throw new Error('network not allowed'); } });
  assert.equal(connector.status().configured, true);
  assert.equal(connector.status().verified, false);
  assert.equal(connector.inspectReference('https://github.com/nadine/site.git').repository, 'nadine/site');
  assert.equal(connector.inspectReference('https://github.com/nadine/site/tree/main').ref, 'main');
  assert.equal(createGitHubWebsiteConnector({ env: {} }).status().publicImportAvailable, true);
});

test('repository validation rejects credentials, alternate hosts, URL query and ambiguous paths', () => {
  for (const value of ['https://github.com.evil.test/nadine/site', 'https://user:secret@github.com/nadine/site', 'http://github.com/nadine/site', 'https://github.com/nadine/site?token=secret', 'https://github.com/nadine/site/tree/feature/nested', 'https://github.com/nadine/site/blob/main/index.html', 'https://github.com/%6eadine/site', 'https://github.com/nadine/site#readme', 'git@github.com:nadine/site.git']) {
    assert.throws(() => inspectGitHubWebsiteReference(value), undefined, value);
  }
});

test('file validation rejects secrets paths, traversal, duplicates and malformed binary', () => {
  for (const path of ['../index.html', '/index.html', 'assets/../index.html', 'C:\\index.html', '.env', '.env.example', 'config/.env.local', 'node_modules/a.js', '.git/config', 'keys/server.pem', '.npmrc']) {
    assert.throws(() => validateGitHubWebsiteFiles([{ ...source, path }]), undefined, path);
  }
  assert.throws(() => validateGitHubWebsiteFiles([source, { ...source, path: 'INDEX.html' }]), { code: 'GITHUB_DUPLICATE_PATH' });
  assert.throws(() => validateGitHubWebsiteFiles([{ path: 'a.png', content: 'not!base64', encoding: 'base64' }]), { code: 'GITHUB_INVALID_FILE' });
  assert.throws(() => validateGitHubWebsiteFiles(Array.from({ length: 501 }, (_, i) => ({ ...source, path: `${i}.html` }))), { code: 'GITHUB_FILE_LIMIT' });
});

test('import pins a commit and validates each blob; binary assets survive and secret files are excluded', async () => {
  const binary = Buffer.from([0, 255, 1, 2]);
  const text = Buffer.from(source.content);
  const entries = [
    { path: source.path, type: 'blob', mode: '100644', sha: hash(text), size: text.length },
    { path: 'assets/model.glb', type: 'blob', mode: '100644', sha: hash(binary), size: binary.length },
    { path: '.env', type: 'blob', mode: '100644', sha: A, size: 30 },
    { path: 'link', type: 'blob', mode: '120000', sha: B, size: 10 },
  ];
  const calls = [];
  const connector = createGitHubWebsiteConnector({ env: {}, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const route = new URL(url).pathname + new URL(url).search;
    if (route === '/repos/nadine/site') return reply(repo);
    if (route === '/repos/nadine/site/commits/main') return reply({ sha: A, commit: { tree: { sha: B } } });
    if (route === `/repos/nadine/site/git/trees/${B}?recursive=1`) return reply({ sha: B, truncated: false, tree: entries });
    const bytes = route.endsWith(hash(text)) ? text : route.endsWith(hash(binary)) ? binary : null;
    if (!bytes) throw new Error('Unexpected blob');
    return reply({ sha: hash(bytes), encoding: 'base64', content: bytes.toString('base64') });
  } });
  const result = await connector.importRepository({ repository: 'nadine/site' });
  assert.equal(result.github.commitSha, A);
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].content, source.content);
  assert.equal(result.files[1].encoding, 'base64');
  assert.deepEqual(Buffer.from(result.files[1].content, 'base64'), binary);
  assert.deepEqual(result.omitted.map(item => item.path), ['.env', 'link']);
  assert.equal(calls.some(call => 'Authorization' in call.options.headers), false);
  assert.equal(calls.every(call => call.options.redirect === 'error'), true);
});

test('import rejects truncated trees before requesting any blobs', async () => {
  const paths = [];
  const connector = createGitHubWebsiteConnector({ env: {}, fetchImpl: async url => {
    paths.push(url);
    if (url.endsWith('/site')) return reply(repo);
    if (url.endsWith('/commits/main')) return reply({ sha: A, commit: { tree: { sha: B } } });
    return reply({ truncated: true, tree: [] });
  } });
  await assert.rejects(connector.importRepository({ repository: 'nadine/site' }), { code: 'GITHUB_TREE_INCOMPLETE' });
  assert.equal(paths.some(path => path.includes('/blobs/')), false);
});

test('import rejects altered data even if the response advertises the expected blob hash', async () => {
  const original = Buffer.from('safe');
  const connector = createGitHubWebsiteConnector({ env: {}, fetchImpl: async url => {
    if (url.endsWith('/site')) return reply(repo);
    if (url.endsWith('/commits/main')) return reply({ sha: A, commit: { tree: { sha: B } } });
    if (url.includes('/git/trees/')) return reply({ tree: [{ path: 'index.html', type: 'blob', mode: '100644', sha: hash(original), size: original.length }] });
    return reply({ sha: hash(original), encoding: 'base64', content: Buffer.from('evil').toString('base64') });
  } });
  await assert.rejects(connector.importRepository({ repository: 'nadine/site' }), { code: 'GITHUB_BLOB_MISMATCH' });
});

test('new export creates a private repository and initializes main before atomic non-force update', async () => {
  const { connector, calls } = fixture();
  const result = await connector.exportRepository({ name: 'site', description: 'Website', private: true, files: [source] });
  assert.deepEqual(result.github, { repository: 'nadine/site', url: 'https://github.com/nadine/site', branch: 'main', commitSha: D, private: true });
  assert.equal(result.created, true);
  assert.equal(calls[0].route, '/user');
  const create = calls.find(call => call.route === '/user/repos');
  assert.equal(create.body.private, true);
  assert.equal(create.body.auto_init, false);
  assert.equal(calls.find(call => call.route.endsWith('/contents/README.md')).body.branch, 'main');
  assert.equal(calls.find(call => call.route.endsWith('/git/trees')).body.base_tree, B);
  assert.deepEqual(calls.find(call => call.method === 'PATCH').body, { sha: D, force: false });
  assert.equal(calls.every(call => !call.route.includes(TOKEN)), true);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('existing export requires expected head and updates without creating a repo', async () => {
  const { connector, calls } = fixture();
  await assert.rejects(connector.exportRepository({ repository: 'nadine/site', private: true, files: [source] }), { code: 'GITHUB_EXPECTED_HEAD_REQUIRED' });
  const result = await connector.exportRepository({ repository: 'nadine/site', expectedHead: A, private: true, files: [source] });
  assert.equal(result.created, false);
  assert.equal(calls.some(call => call.route === '/user/repos'), false);
  assert.equal(calls.some(call => call.route.includes('/contents/')), false);
});

test('stale head prevents every write', async () => {
  const { connector, calls } = fixture();
  await assert.rejects(connector.exportRepository({ repository: 'nadine/site', expectedHead: D, private: true, files: [source] }), { code: 'GITHUB_HEAD_CHANGED' });
  assert.equal(calls.some(call => call.method !== 'GET'), false);
});

test('concurrent remote edit is detected immediately before branch mutation', async () => {
  let headReads = 0;
  const { connector, calls } = fixture({ handle({ route }) {
    if (route.endsWith('/git/ref/heads/main') && ++headReads === 2) return reply({ object: { type: 'commit', sha: C } });
  } });
  await assert.rejects(connector.exportRepository({ repository: 'nadine/site', expectedHead: A, private: true, files: [source] }), { code: 'GITHUB_HEAD_CHANGED' });
  assert.equal(calls.some(call => call.method === 'PATCH'), false);
});

test('export rejects public repos, another owner, and token accidentally included in file content', async () => {
  const { connector, calls } = fixture();
  await assert.rejects(connector.exportRepository({ name: 'site', private: false, files: [source] }), { code: 'GITHUB_PRIVATE_REQUIRED' });
  await assert.rejects(connector.exportRepository({ repository: 'other/site', expectedHead: A, private: true, files: [source] }), { code: 'GITHUB_OWNER_MISMATCH' });
  await assert.rejects(connector.exportRepository({ name: 'site', private: true, files: [{ ...source, content: TOKEN }] }), { code: 'GITHUB_SECRET_IN_FILE' });
  assert.equal(calls.some(call => call.method !== 'GET'), false);
  const publicFixture = fixture({ handle({ route }) { if (route === '/repos/nadine/site') return reply({ ...repo, private: false }); } });
  await assert.rejects(publicFixture.connector.exportRepository({ repository: 'nadine/site', expectedHead: A, private: true, files: [source] }), { code: 'GITHUB_REPOSITORY_MISMATCH' });
  assert.equal(publicFixture.calls.some(call => call.method !== 'GET'), false);
});

test('API redirects are not followed and raw response bodies do not enter errors', async () => {
  const redirect = createGitHubWebsiteConnector({ env: { GITHUB_TOKEN: TOKEN }, fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'error');
    return reply({ message: TOKEN }, 302);
  } });
  await assert.rejects(redirect.importRepository({ repository: 'nadine/site' }), error => error.code === 'GITHUB_REDIRECT_BLOCKED' && !error.message.includes(TOKEN));
  const denied = createGitHubWebsiteConnector({ env: { GITHUB_TOKEN: TOKEN }, fetchImpl: async () => reply({ message: TOKEN }, 403) });
  await assert.rejects(denied.importRepository({ repository: 'nadine/site' }), error => error.code === 'GITHUB_PERMISSION' && !JSON.stringify(error).includes(TOKEN));
});

test('request times out even if fetch implementation does not honor AbortSignal', async () => {
  const connector = createGitHubWebsiteConnector({ env: {}, timeoutMs: 5, fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(connector.importRepository({ repository: 'nadine/site' }), { code: 'GITHUB_TIMEOUT' });
});

test('failed initialization exposes safe recovery metadata and never silently retries create', async () => {
  const { connector, calls } = fixture({ handle({ route }) {
    if (route.endsWith('/contents/README.md')) return reply({ message: TOKEN }, 403);
  } });
  await assert.rejects(connector.exportRepository({ name: 'site', private: true, files: [source] }), error => {
    assert.equal(error.github.created, true);
    assert.equal(error.github.repository, 'nadine/site');
    assert.equal(error.github.status, 'incomplete');
    assert.equal(JSON.stringify(error).includes(TOKEN), false);
    return error.code === 'GITHUB_PERMISSION';
  });
  assert.equal(calls.filter(call => call.route === '/user/repos').length, 1);
});

test('export completion requires readback, not merely a successful PATCH', async () => {
  const { connector } = fixture({ handle({ method }) { if (method === 'PATCH') return reply({ object: { sha: D } }); } });
  await assert.rejects(connector.exportRepository({ repository: 'nadine/site', expectedHead: A, private: true, files: [source] }), { code: 'GITHUB_VERIFICATION_FAILED' });
});
