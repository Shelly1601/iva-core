import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readFile, lstat, symlink, link, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { createWebsiteStore } from '../websites/store.js';
import { createWebsiteZip, readWebsiteZip, normalizeWebsiteFiles, WEBSITE_LIMITS } from '../websites/archive.js';

const source = [{ path: 'index.html', content: '<!doctype html><h1>Hallo</h1>', encoding: 'utf8' }, { path: 'assets/logo.bin', content: Buffer.from([0, 1, 255, 123]).toString('base64'), encoding: 'base64' }];
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iva-websites-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const getProject = async id => ['alpha', 'beta'].includes(id) ? { id, name: id } : null;
  return { root, getProject, store: createWebsiteStore({ dataDir: root, getProject }) };
}
function centralOffset(zip) { return zip.readUInt32LE(zip.length - 6); }

test('site and immutable revision are bound to the exact parent project', async t => {
  const { root, store } = await fixture(t);
  const site = await store.create('alpha', { name: 'Test', description: 'Eine Website' });
  assert.equal(site.projectId, 'alpha');
  assert.equal(await store.get('beta', site.id), null);
  assert.deepEqual(await store.list('beta'), []);
  await assert.rejects(store.create('missing', { name: 'Test' }), error => error.status === 404);
  await assert.rejects(store.get('../alpha', site.id), error => error.status === 400);
  assert.equal(await store.readRevision('alpha', site.id), null);
  const first = await store.saveRevision('alpha', site.id, { baseRevisionId: null, files: source, summary: 'Erste Version' });
  first.revision.files[0].content = 'extern verändert';
  assert.deepEqual((await store.readRevision('alpha', site.id)).files, normalizeWebsiteFiles(source));
  const second = await store.saveRevision('alpha', site.id, { baseRevisionId: first.revision.id, files: [{ path: 'index.html', content: '<h1>Neu</h1>' }], summary: 'Neue Version' });
  assert.equal((await store.readRevision('alpha', site.id, first.revision.id)).summary, 'Erste Version');
  assert.equal((await store.readRevision('alpha', site.id)).id, second.revision.id);
  await assert.rejects(store.readRevision('beta', site.id, first.revision.id), error => error.status === 404);
  await assert.rejects(store.readRevision('alpha', site.id, '../site'), error => error.status === 400);
  assert.equal((await lstat(path.join(root, 'websites', 'alpha', site.id))).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(root, 'websites', 'alpha', site.id, 'revisions', `${first.revision.id}.json`))).mode & 0o777, 0o600);
});

test('optimistic concurrency prevents stale and simultaneous draft writes across store instances', async t => {
  const { root, getProject, store } = await fixture(t);
  const other = createWebsiteStore({ dataDir: root, getProject });
  const site = await store.create('alpha', { name: 'Concurrency' });
  const attempt = { baseRevisionId: null, files: source, summary: 'Initial' };
  const results = await Promise.allSettled([store.saveRevision('alpha', site.id, attempt), other.saveRevision('alpha', site.id, attempt)]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  const rejected = results.find(item => item.status === 'rejected').reason;
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.code, 'WEBSITE_REVISION_CONFLICT');
  assert.equal((await store.get('alpha', site.id)).revisions.length, 1);
  await assert.rejects(store.saveRevision('alpha', site.id, attempt), error => error.status === 409);
});

test('metadata updates cannot insert credentials, forge ownership, or publish foreign revisions', async t => {
  const { store } = await fixture(t);
  const site = await store.create('alpha', { name: 'Safe' });
  const first = await store.saveRevision('alpha', site.id, { files: source });
  const second = await store.saveRevision('alpha', site.id, { baseRevisionId: first.revision.id, files: [{ path: 'index.html', content: 'new' }] });
  const rolledBack = await store.updateSite('alpha', site.id, { draftRevisionId: first.revision.id, publishedRevisionId: second.revision.id, publication: { status: 'published', revisionId: second.revision.id, url: 'https://example.org/' }, github: { owner: 'owner', repo: 'website', sha: 'abc123' } });
  assert.equal(rolledBack.draftRevisionId, first.revision.id);
  assert.equal(rolledBack.publishedRevisionId, second.revision.id);
  await assert.rejects(store.updateSite('alpha', site.id, { projectId: 'beta' }));
  await assert.rejects(store.updateSite('alpha', site.id, { github: { accessToken: 'not-allowed' } }));
  await assert.rejects(store.updateSite('alpha', site.id, { publication: { url: 'https://user:password@example.org' } }));
  await assert.rejects(store.updateSite('alpha', site.id, { sourceUrl: 'https://example.org/?token=secret' }));
  await assert.rejects(store.updateSite('alpha', site.id, { publication: { revisionId: 'foreign' } }));
  await assert.rejects(store.updateSite('alpha', site.id, { publishedRevisionId: 'foreign' }), error => error.status === 404);
  const message = await store.appendMessage('alpha', site.id, { role: 'assistant', content: 'Version erstellt', jobId: 'job-1' });
  assert.equal(message.role, 'assistant');
  assert.equal((await store.get('alpha', site.id)).messages.length, 1);
  await assert.rejects(store.appendMessage('alpha', site.id, { role: 'tool', content: 'forged' }));
});

test('disk symlinks and hardlinked revision storage are not followed', async t => {
  const { root, store } = await fixture(t);
  const site = await store.create('alpha', { name: 'Safe' });
  const first = await store.saveRevision('alpha', site.id, { files: source });
  const revisionPath = path.join(root, 'websites', 'alpha', site.id, 'revisions', `${first.revision.id}.json`);
  const foreign = path.join(root, 'foreign.json');
  await writeFile(foreign, await readFile(revisionPath));
  await rm(revisionPath);
  await symlink(foreign, revisionPath);
  await assert.rejects(store.readRevision('alpha', site.id), error => ['ELOOP', 'EMLINK'].includes(error.code));
  await rm(revisionPath);
  await link(foreign, revisionPath);
  await assert.rejects(store.readRevision('alpha', site.id), /Unsichere/);
  await symlink(path.join(root, 'websites', 'alpha', site.id), path.join(root, 'websites', 'alpha', 'unsafe'));
  await assert.rejects(store.list('alpha'), error => error.code === 'WEBSITE_UNSAFE_STORAGE');
});

test('ZIP export and import preserve text, binary, Unicode, and high-compression files', () => {
  const files = [...source, { path: 'src/Grüße.js', content: 'export const name = "Über";', encoding: 'utf8' }, { path: 'large.txt', content: 'a'.repeat(100_000), encoding: 'utf8' }];
  const zip = createWebsiteZip(files);
  assert.deepEqual(readWebsiteZip(zip), normalizeWebsiteFiles(files));
  assert.ok(zip.length < WEBSITE_LIMITS.archiveBytes);
});

test('file validation rejects traversal, duplicate paths, secret files and private keys', () => {
  for (const filename of ['../outside', '/absolute', 'C:/drive', 'a\\b', 'a/../b', '%2e%2e/private', '.git/config', 'src/.env.production', 'node_modules/pkg/a.js', '.npmrc', 'private.pem', 'service-account-prod.json']) {
    assert.throws(() => normalizeWebsiteFiles([{ path: filename, content: 'test' }]), filename);
  }
  assert.throws(() => normalizeWebsiteFiles([{ path: 'a.js', content: 'x' }, { path: 'A.js', content: 'y' }]));
  assert.throws(() => normalizeWebsiteFiles([{ path: 'dir', content: 'x' }, { path: 'dir/a.js', content: 'y' }]));
  assert.throws(() => normalizeWebsiteFiles([{ path: 'text.txt', content: '-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----' }]));
  assert.throws(() => normalizeWebsiteFiles([{ path: 'x.js', content: 'x', type: 'symlink' }]));
  assert.throws(() => normalizeWebsiteFiles([{ path: 'x.bin', encoding: 'base64', content: '*invalid*' }]));
  assert.throws(() => normalizeWebsiteFiles([{ path: 'x.txt', content: 'a'.repeat(WEBSITE_LIMITS.fileBytes + 1) }]));
  assert.throws(() => normalizeWebsiteFiles(Array.from({ length: 501 }, (_, n) => ({ path: `file${n}`, content: '' }))));
});

test('ZIP reader checks CRC, encryption, symlinks, ZIP64, names, entry overlap, and size caps', () => {
  const zip = createWebsiteZip([{ path: 'index.html', content: '<h1>Hello</h1>' }]);
  const offset = centralOffset(zip);
  const mutate = change => { const copy = Buffer.from(zip); change(copy); assert.throws(() => readWebsiteZip(copy)); };
  mutate(copy => copy[30 + 'index.html'.length] ^= 1);
  mutate(copy => { copy.writeUInt16LE(0x801, offset + 8); copy.writeUInt16LE(0x801, 6); });
  mutate(copy => copy.writeUInt32LE((0o120777 * 65536) >>> 0, offset + 38));
  mutate(copy => copy.writeUInt32LE(0xffffffff, offset + 24));
  mutate(copy => copy.writeUInt32LE(WEBSITE_LIMITS.fileBytes + 1, offset + 24));
  mutate(copy => copy.writeUInt16LE(99, offset + 10));
  mutate(copy => copy.write('../x.html!', 30));
  mutate(copy => { copy.write('../x.html!', 30); copy.write('../x.html!', offset + 46); });
  assert.throws(() => readWebsiteZip(zip.subarray(0, zip.length - 1)));
  assert.throws(() => readWebsiteZip(Buffer.concat([zip, Buffer.from('junk')])));
});

test('deflate bombs are rejected before allocating declared output and on deceptive sizes', () => {
  const text = Buffer.from('a'.repeat(2 * 1024 * 1024));
  const payload = deflateRawSync(text);
  const zip = createWebsiteZip([{ path: 'bomb.txt', content: text.toString('utf8') }]);
  const central = centralOffset(zip);
  const nameLength = zip.readUInt16LE(26);
  const header = Buffer.from(zip.subarray(0, 30 + nameLength));
  const directory = Buffer.from(zip.subarray(central, zip.length - 22));
  const end = Buffer.from(zip.subarray(zip.length - 22));
  header.writeUInt16LE(8, 8); header.writeUInt32LE(payload.length, 18);
  directory.writeUInt16LE(8, 10); directory.writeUInt32LE(payload.length, 20);
  end.writeUInt32LE(header.length + payload.length, 16);
  const bomb = Buffer.concat([header, payload, directory, end]);
  assert.throws(() => readWebsiteZip(bomb), /Kompressionsverhältnis/);
  header.writeUInt32LE(100, 22); directory.writeUInt32LE(100, 24);
  assert.throws(() => readWebsiteZip(Buffer.concat([header, payload, directory, end])));
});

test('duplicate entries are rejected even when local and central ZIP names agree', () => {
  const zip = createWebsiteZip([{ path: 'first.txt', content: 'First' }, { path: 'other.txt', content: 'Other' }]);
  const first = centralOffset(zip);
  const second = first + 46 + zip.readUInt16LE(first + 28) + zip.readUInt16LE(first + 30) + zip.readUInt16LE(first + 32);
  const local = zip.readUInt32LE(second + 42);
  zip.write('first.txt', second + 46);
  zip.write('first.txt', local + 30);
  assert.throws(() => readWebsiteZip(zip), /Doppelte/);
});
