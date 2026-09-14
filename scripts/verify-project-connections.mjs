import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createProjectConnectionStore } from '../projects/connections.js';

const input = { label: 'Projektkanal', handle: '@project_account', accountId: '1789001', authMode: 'instagram', graphVersion: 'v24.0', token: 'private-project-token-12345' };
async function setup(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-project-connections-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const env = { IVA_PROJECT_CONNECTIONS_KEY: randomBytes(32).toString('base64'), ...overrides };
  const options = { dataDir, env, getProject: async id => id.startsWith('project-') ? { id } : null };
  return { dataDir, env, options, store: createProjectConnectionStore(options), filename: path.join(dataDir, 'project-connections.json') };
}

test('projects begin disconnected and global account credentials never fill a project', async t => {
  const { store } = await setup(t, { APIFY_TOKEN: 'shared-compute', META_ACCESS_TOKEN: 'global-meta', INSTAGRAM_ACCESS_TOKEN: 'global-instagram', INSTAGRAM_ACCOUNT_ID: '999', INSTAGRAM_AUTH_MODE: 'facebook', META_GRAPH_VERSION: 'v24.0', OTHER_SECRET: 'never' });
  assert.deepEqual(await store.list('project-a'), { items: [], encryptionReady: true, providers: [{ id: 'instagram', label: 'Instagram' }] });
  assert.deepEqual(await store.resolveEnv('project-a'), { APIFY_TOKEN: 'shared-compute' });
});

test('stored tokens are authenticated ciphertext and public metadata never contains credentials', async t => {
  const { store, filename, env } = await setup(t);
  const saved = await store.save('project-a', 'instagram', input);
  assert.equal(saved.status, 'configured');
  assert.equal(saved.verifiedAt, null);
  assert.equal(saved.lastCheck, null);
  assert.equal(saved.handle, 'project_account');
  assert.equal(saved.hasToken, true);
  const raw = await fs.readFile(filename, 'utf8');
  assert.ok(!raw.includes(input.token));
  assert.ok(!raw.includes(env.IVA_PROJECT_CONNECTIONS_KEY));
  assert.equal(JSON.parse(raw).connections[0].credentials.algorithm, 'aes-256-gcm');
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(saved).includes(input.token));
  assert.ok(!JSON.stringify(await store.list('project-a')).includes(input.token));
  assert.deepEqual(await store.resolveEnv('project-a'), { INSTAGRAM_AUTH_MODE: 'instagram', INSTAGRAM_ACCOUNT_ID: input.accountId, META_GRAPH_VERSION: input.graphVersion, INSTAGRAM_ACCESS_TOKEN: input.token });
});

test('project credentials remain separate including after factory recreation', async t => {
  const { store, options } = await setup(t);
  await store.save('project-a', 'instagram', input);
  await store.save('project-b', 'instagram', { ...input, authMode: 'facebook', accountId: '1789002', token: 'private-other-project-token' });
  const restarted = createProjectConnectionStore(options);
  const envA = await restarted.resolveEnv('project-a');
  const envB = await restarted.resolveEnv('project-b');
  assert.equal(envA.INSTAGRAM_ACCESS_TOKEN, input.token);
  assert.equal(envB.META_ACCESS_TOKEN, 'private-other-project-token');
  assert.equal(envB.INSTAGRAM_ACCESS_TOKEN, undefined);
  assert.equal(envA.META_ACCESS_TOKEN, undefined);
  assert.equal((await restarted.list('project-a')).items.length, 1);
});

test('all methods reject nonexistent and malformed projects with scrubbed errors', async t => {
  const { store } = await setup(t);
  for (const projectId of ['missing', '../project-a', '', '__proto__']) {
    for (const invoke of [() => store.list(projectId), () => store.save(projectId, 'instagram', input), () => store.resolveEnv(projectId), () => store.recordVerification(projectId, 'instagram', { ok: true, expectedRevision: 'x' }), () => store.remove(projectId, 'instagram')]) {
      await assert.rejects(invoke, error => ['project_not_found', 'invalid_project'].includes(error.code) && !error.message.includes(input.token));
    }
  }
  await assert.rejects(() => store.save('project-a', '__proto__', input), { code: 'unsupported_provider' });
});

test('metadata is editable without a key but new tokens need exactly 32 base64-encoded bytes', async t => {
  const { options } = await setup(t);
  for (const key of [undefined, 'not-a-key', randomBytes(31).toString('base64'), randomBytes(33).toString('base64'), randomBytes(32).toString('hex')]) {
    const store = createProjectConnectionStore({ ...options, env: { IVA_PROJECT_CONNECTIONS_KEY: key, META_ACCESS_TOKEN: 'fallback-is-forbidden' } });
    const saved = await store.save('project-a', 'instagram', { handle: 'later_account' });
    assert.equal(saved.configured, false);
    assert.equal((await store.list('project-a')).encryptionReady, false);
    await assert.rejects(() => store.save('project-a', 'instagram', input), error => error.code === 'encryption_unavailable' && !error.message.includes(input.token));
  }
});

test('missing/wrong keys keep stored tokens locked without leaking tokens in exceptions', async t => {
  const { store, options } = await setup(t);
  await store.save('project-a', 'instagram', input);
  for (const env of [{}, { IVA_PROJECT_CONNECTIONS_KEY: randomBytes(32).toString('base64') }]) {
    const locked = createProjectConnectionStore({ ...options, env });
    const saved = await locked.save('project-a', 'instagram', { label: 'Metadata still editable' });
    assert.equal(saved.hasToken, true);
    assert.equal(saved.configured, false);
    assert.equal(saved.status, 'encryption_unavailable');
    await assert.rejects(() => locked.resolveEnv('project-a'), error => ['encryption_unavailable', 'decryption_failed'].includes(error.code) && !error.message.includes(input.token));
  }
  assert.equal((await store.resolveEnv('project-a')).INSTAGRAM_ACCESS_TOKEN, input.token);
});

test('absent/empty tokens preserve the same account; account/mode changes clear credentials', async t => {
  const { store } = await setup(t);
  await store.save('project-a', 'instagram', input);
  await store.save('project-a', 'instagram', { label: 'Changed' });
  await store.save('project-a', 'instagram', { token: '' });
  assert.equal((await store.resolveEnv('project-a')).INSTAGRAM_ACCESS_TOKEN, input.token);
  let saved = await store.save('project-a', 'instagram', { accountId: '1789002' });
  assert.equal(saved.hasToken, false);
  assert.equal(saved.configured, false);
  await store.save('project-a', 'instagram', input);
  saved = await store.save('project-a', 'instagram', { authMode: 'facebook' });
  assert.equal(saved.hasToken, false);
  assert.equal((await store.resolveEnv('project-a')).META_ACCESS_TOKEN, undefined);
});

test('verification needs a complete connection, is explicit, and clears on any save', async t => {
  const { store } = await setup(t);
  let item = await store.save('project-a', 'instagram', { handle: 'later' });
  await assert.rejects(() => store.recordVerification('project-a', 'instagram', { ok: true, expectedRevision: item.revision }), { code: 'connection_incomplete' });
  item = await store.save('project-a', 'instagram', input);
  await assert.rejects(() => store.recordVerification('project-a', 'instagram', { ok: true }), { code: 'invalid_verification' });
  let verified = await store.recordVerification('project-a', 'instagram', { ok: true, expectedRevision: item.revision });
  assert.equal(verified.status, 'verified');
  assert.ok(verified.verifiedAt);
  verified = await store.recordVerification('project-a', 'instagram', { ok: false, expectedRevision: item.revision, error: input.token });
  assert.equal(verified.status, 'verification_failed');
  assert.equal(verified.verifiedAt, null);
  assert.ok(!JSON.stringify(verified).includes(input.token));
  item = await store.save('project-a', 'instagram', { label: 'Renamed' });
  assert.equal(item.lastCheck, null);
  assert.equal(item.status, 'configured');
});

test('stale verification never marks a changed credential as verified', async t => {
  const { store } = await setup(t);
  const old = await store.save('project-a', 'instagram', input);
  const changed = await store.save('project-a', 'instagram', { token: 'new-access-token' });
  assert.notEqual(old.revision, changed.revision);
  assert.deepEqual(await store.recordVerification('project-a', 'instagram', { ok: true, expectedRevision: old.revision }), { ok: false, code: 'stale_revision' });
  assert.equal((await store.list('project-a')).items[0].status, 'configured');
});

test('writes from concurrent store instances retain every separate project', async t => {
  const { store, options } = await setup(t);
  const other = createProjectConnectionStore(options);
  await Promise.all(Array.from({ length: 24 }, (_, index) => (index % 2 ? store : other).save(`project-${index}`, 'instagram', { ...input, accountId: String(1789001 + index), token: `project-secret-${index}` })));
  for (let index = 0; index < 24; index++) assert.equal((await store.resolveEnv(`project-${index}`)).INSTAGRAM_ACCESS_TOKEN, `project-secret-${index}`);
});

test('ciphertext cannot be transplanted across project boundaries', async t => {
  const { store, filename } = await setup(t);
  await store.save('project-a', 'instagram', input);
  await store.save('project-b', 'instagram', { ...input, token: 'project-b-secret' });
  const data = JSON.parse(await fs.readFile(filename, 'utf8'));
  data.connections[1].credentials = data.connections[0].credentials;
  await fs.writeFile(filename, JSON.stringify(data));
  await assert.rejects(() => store.resolveEnv('project-b'), { code: 'decryption_failed' });
  assert.equal((await store.resolveEnv('project-a')).INSTAGRAM_ACCESS_TOKEN, input.token);
});

test('corrupt stores fail closed and errors never echo provider data or supplied secrets', async t => {
  const { store, filename } = await setup(t);
  await store.save('project-a', 'instagram', input);
  await assert.rejects(() => store.save('project-a', 'instagram', { graphVersion: input.token }), error => error.code === 'invalid_connection_input' && !error.message.includes(input.token));
  const result = await store.save('project-a', 'instagram', { label: input.token });
  assert.equal(result.label, '[redacted]');
  await fs.writeFile(filename, input.token);
  await assert.rejects(() => store.list('project-a'), error => error.code === 'connection_store_unavailable' && !error.message.includes(input.token));
  await assert.rejects(() => store.save('project-b', 'instagram', input), { code: 'connection_store_unavailable' });
  assert.equal(await fs.readFile(filename, 'utf8'), input.token);
});

test('explicit token clearing and disconnect affect only the selected project', async t => {
  const { store, filename } = await setup(t);
  await store.save('project-a', 'instagram', input);
  await store.save('project-b', 'instagram', input);
  const cleared = await store.save('project-a', 'instagram', { clearToken: true });
  assert.equal(cleared.hasToken, false);
  assert.equal(cleared.accountId, input.accountId);
  assert.equal((await store.resolveEnv('project-b')).INSTAGRAM_ACCESS_TOKEN, input.token);
  assert.deepEqual(await store.remove('project-a', 'instagram'), { ok: true, removed: true });
  assert.deepEqual((await store.list('project-a')).items, []);
  assert.deepEqual(await store.remove('project-a', 'instagram'), { ok: true, removed: false });
  assert.equal((await store.list('project-b')).items.length, 1);
  assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).connections.length, 1);
});

test('UI accessToken input and profile URLs normalize without retaining URL tracking', async t => {
  const { store } = await setup(t);
  const { token, ...metadata } = input;
  let saved = await store.save('project-a', 'instagram', { ...metadata, accessToken: token, handle: 'https://www.instagram.com/Project_Account/?stkn=tracking' });
  assert.equal(saved.handle, 'project_account');
  assert.equal((await store.resolveEnv('project-a')).INSTAGRAM_ACCESS_TOKEN, token);
  saved = await store.save('project-a', 'instagram', { accessToken: '' });
  assert.equal(saved.hasToken, true);
  await assert.rejects(() => store.save('project-a', 'instagram', { handle: 'https://www.instagram.com/reel/ABC123/' }), { code: 'invalid_connection_input' });
  await assert.rejects(() => store.save('project-a', 'instagram', { handle: 'https://example.com/profile/' }), { code: 'invalid_connection_input' });
  await assert.rejects(() => store.save('project-a', 'instagram', { token, accessToken: 'conflicting-token' }), { code: 'invalid_connection_input' });
});
