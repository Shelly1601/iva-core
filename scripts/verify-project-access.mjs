import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectAccessStore, PROJECT_MODULES } from '../access/store.js';

const PASSWORD = 'correct horse battery fixture';
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-project-access-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let current = Date.parse('2026-09-14T12:00:00.000Z');
  const projects = new Map([['alpha', { id: 'alpha', name: 'Alpha' }], ['beta', { id: 'beta', name: 'Beta' }]]);
  const options = { dataDir: directory, getProject: async id => projects.get(id) || null, env: {}, now: () => current };
  const store = createProjectAccessStore(options);
  const enable = (projectId = 'alpha', settings = {}) => store.configure(projectId, { modules: ['websites'], externalEnabled: true, externalRole: 'editor', ...settings });
  const invite = async (projectId = 'alpha', address = 'client@example.com', role) => store.createInvite(projectId, { email: address, role });
  const join = async (projectId = 'alpha', address = 'client@example.com', role) => store.acceptInvite({ token: (await invite(projectId, address, role)).token, password: PASSWORD });
  return { directory, file: path.join(directory, 'project-access', 'access.json'), projects, store, options, enable, invite, join, advance: ms => { current += ms; }, setTime: value => { current = Date.parse(value); } };
}

test('existing projects default to internal modules with all external access disabled', async t => {
  const f = await fixture(t);
  const config = await f.store.getProjectAccess('alpha');
  assert.deepEqual(config.modules, PROJECT_MODULES.map(module => module.id));
  assert.equal(config.externalEnabled, false);
  assert.equal(config.externalRole, 'editor');
  assert.equal(config.dailyBuildLimit, 10);
  assert.deepEqual(PROJECT_MODULES.filter(module => module.externalAvailable).map(module => module.id), ['websites']);
  await assert.rejects(f.invite(), { status: 403 });
  await assert.rejects(f.store.getProjectAccess('../outside'), { status: 400 });
  await assert.rejects(f.store.getProjectAccess('missing'), { status: 404 });
});

test('admin configuration validates modules, role, Boolean state and the 1–50 quota range', async t => {
  const f = await fixture(t);
  for (const input of [{ modules: ['not-a-module'] }, { modules: 'websites' }, { externalEnabled: 'true' }, { externalRole: 'admin' }, { dailyBuildLimit: 0 }, { dailyBuildLimit: 51 }, { dailyBuildLimit: 1.5 }]) await assert.rejects(f.store.configure('alpha', input), { status: 400 });
  const configured = await f.enable('alpha', { modules: ['websites', 'websites', 'crm'], dailyBuildLimit: 50 });
  assert.deepEqual(configured.modules, ['websites', 'crm']);
  assert.equal(configured.dailyBuildLimit, 50);
  assert.equal((await f.store.getProjectAccess('beta')).externalEnabled, false);
});

test('invite and session tokens are hashed; password is scrypt-derived and never returned', async t => {
  const f = await fixture(t);
  await f.enable();
  const invitation = await f.invite();
  assert.match(invitation.token, /^[A-Za-z0-9_-]{43}$/);
  let stored = await fs.readFile(f.file, 'utf8');
  assert.equal(stored.includes(invitation.token), false);
  const result = await f.store.acceptInvite({ token: invitation.token, password: PASSWORD });
  stored = await fs.readFile(f.file, 'utf8');
  assert.equal(stored.includes(PASSWORD), false);
  assert.equal(stored.includes(result.sessionToken), false);
  const user = JSON.parse(stored).users[0];
  assert.match(user.salt, /^[a-f0-9]{32}$/);
  assert.match(user.passwordHash, /^[a-f0-9]{64}$/);
  const session = await f.store.session(result.sessionToken);
  const admin = await f.store.getProjectAccess('alpha');
  assert.equal(/passwordHash|salt|tokenHash|sessionToken/.test(JSON.stringify({ session, admin })), false);
  assert.equal(admin.members[0].email, 'client@example.com');
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
});

test('invitations are one-use and replay fails, including simultaneous acceptance', async t => {
  const f = await fixture(t);
  await f.enable();
  const invitation = await f.invite();
  const results = await Promise.allSettled([1, 2].map(() => f.store.acceptInvite({ token: invitation.token, password: PASSWORD })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'PROJECT_INVITE_INVALID');
  assert.equal((await f.store.getProjectAccess('alpha')).pendingInvites.length, 0);
});

test('expired invitations and invalid passwords are rejected without creating an account', async t => {
  const f = await fixture(t);
  await f.enable();
  const invitation = await f.invite();
  for (const invalid of ['too short', 'x'.repeat(129), 'pass\0word with null']) await assert.rejects(f.store.acceptInvite({ token: invitation.token, password: invalid }), { status: 400 });
  f.advance(24 * 3600_000);
  await assert.rejects(f.store.acceptInvite({ token: invitation.token, password: PASSWORD }), { code: 'PROJECT_INVITE_INVALID' });
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).users.length, 0);
});

test('replacing an invite invalidates the previous token and role cannot exceed project cap', async t => {
  const f = await fixture(t);
  await f.enable();
  await assert.rejects(f.invite('alpha', 'client@example.com', 'publisher'), { code: 'PROJECT_ROLE_CAP' });
  const first = await f.invite();
  const second = await f.invite();
  await assert.rejects(f.store.acceptInvite({ token: first.token, password: PASSWORD }), { code: 'PROJECT_INVITE_INVALID' });
  const result = await f.store.acceptInvite({ token: second.token, password: PASSWORD });
  assert.equal(result.projects[0].role, 'editor');
});

test('an existing email account must use its existing password when accepting another project', async t => {
  const f = await fixture(t);
  await f.enable(); await f.enable('beta');
  const original = await f.join();
  const invitation = await f.invite('beta', 'CLIENT@example.com');
  await assert.rejects(f.store.acceptInvite({ token: invitation.token, password: 'different password cannot reset account' }), { code: 'PROJECT_LOGIN_FAILED' });
  const joined = await f.store.acceptInvite({ token: invitation.token, password: PASSWORD });
  assert.equal(joined.user.id, original.user.id);
  assert.deepEqual(joined.projects.map(project => project.projectId).sort(), ['alpha', 'beta']);
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).users.length, 1);
});

test('login verifies credentials and logout revokes only the supplied session', async t => {
  const f = await fixture(t);
  await f.enable();
  const initial = await f.join();
  for (const input of [{ email: 'client@example.com', password: 'wrong but sufficiently long password' }, { email: 'unknown@example.com', password: PASSWORD }]) await assert.rejects(f.store.login(input), { code: 'PROJECT_LOGIN_FAILED' });
  const second = await f.store.login({ email: 'CLIENT@EXAMPLE.COM', password: PASSWORD });
  assert.equal(second.user.id, initial.user.id);
  await f.store.logout(initial.sessionToken);
  await assert.rejects(f.store.session(initial.sessionToken), { status: 401 });
  assert.equal((await f.store.session(second.sessionToken)).user.id, second.user.id);
  assert.deepEqual(await f.store.logout('invalid'), { loggedOut: true });
});

test('session expires at eight hours and is invalid in another isolated store', async t => {
  const f = await fixture(t);
  await f.enable();
  const account = await f.join();
  const other = await fixture(t);
  await assert.rejects(other.store.session(account.sessionToken), { status: 401 });
  f.advance(8 * 3600_000 - 1);
  assert.equal((await f.store.session(account.sessionToken)).projects.length, 1);
  f.advance(1);
  await assert.rejects(f.store.session(account.sessionToken), { status: 401 });
});

test('project and module isolation reject unknown tenants and unavailable external capabilities', async t => {
  const f = await fixture(t);
  await f.enable('alpha', { modules: PROJECT_MODULES.map(module => module.id) });
  const account = await f.join();
  assert.deepEqual(account.projects[0].modules, ['websites']);
  await assert.rejects(f.store.requireAccess(account.sessionToken, 'beta', { module: 'websites', action: 'read' }), { code: 'PROJECT_ACCESS_DENIED' });
  await assert.rejects(f.store.requireAccess(account.sessionToken, 'alpha', { module: 'crm', action: 'read' }), { code: 'PROJECT_ACCESS_DENIED' });
  await assert.rejects(f.store.requireAccess(account.sessionToken, 'alpha', { module: 'websites', action: 'admin' }), { code: 'PROJECT_ACTION_DENIED' });
  f.projects.delete('alpha');
  assert.deepEqual((await f.store.session(account.sessionToken)).projects, []);
});

test('viewer/editor/publisher actions and project-wide cap are enforced on every request', async t => {
  const f = await fixture(t);
  await f.enable('alpha', { externalRole: 'publisher' });
  const publisher = await f.join('alpha', 'publisher@example.com', 'publisher');
  const editor = await f.join('alpha', 'editor@example.com', 'editor');
  const viewer = await f.join('alpha', 'viewer@example.com', 'viewer');
  for (const action of ['read', 'edit', 'build', 'export', 'publish']) await f.store.requireAccess(publisher.sessionToken, 'alpha', { action });
  for (const action of ['read', 'edit', 'build', 'export']) await f.store.requireAccess(editor.sessionToken, 'alpha', { action });
  await assert.rejects(f.store.requireAccess(editor.sessionToken, 'alpha', { action: 'publish' }), { status: 403 });
  await f.store.requireAccess(viewer.sessionToken, 'alpha', { action: 'read' });
  for (const action of ['edit', 'build', 'export', 'publish']) await assert.rejects(f.store.requireAccess(viewer.sessionToken, 'alpha', { action }), { status: 403 });
  await f.store.configure('alpha', { externalRole: 'viewer' });
  assert.equal((await f.store.session(publisher.sessionToken)).projects[0].role, 'viewer');
  await assert.rejects(f.store.requireAccess(publisher.sessionToken, 'alpha', { action: 'edit' }), { status: 403 });
});

test('disabling access, disabling module and member revocation take effect in existing sessions', async t => {
  const f = await fixture(t);
  await f.enable();
  const account = await f.join();
  await f.store.configure('alpha', { externalEnabled: false });
  assert.deepEqual((await f.store.session(account.sessionToken)).projects, []);
  await f.enable();
  await f.store.configure('alpha', { modules: ['crm'] });
  assert.deepEqual((await f.store.session(account.sessionToken)).projects, []);
  await f.enable();
  const pending = await f.invite();
  await f.store.revokeProjectAccess('alpha', account.user.id);
  await assert.rejects(f.store.requireAccess(account.sessionToken, 'alpha'), { status: 403 });
  await assert.rejects(f.store.acceptInvite({ token: pending.token, password: PASSWORD }), { code: 'PROJECT_INVITE_INVALID' });
});

test('build quota remains exact under concurrent calls and shared store instances', async t => {
  const f = await fixture(t);
  await f.enable('alpha', { dailyBuildLimit: 3 });
  const account = await f.join();
  const another = createProjectAccessStore(f.options);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => (index % 2 ? another : f.store).consumeBuildQuota(account.sessionToken, 'alpha')));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 3);
  assert.equal(results.filter(result => result.status === 'rejected').every(result => result.reason.status === 429), true);
  assert.deepEqual(results.filter(result => result.status === 'fulfilled').map(result => result.value.used).sort(), [1, 2, 3]);
});

test('quota is separated by user and project, resets next day, and viewer cannot consume builds', async t => {
  const f = await fixture(t);
  f.setTime('2026-09-14T23:59:00Z');
  await f.enable('alpha', { dailyBuildLimit: 1 }); await f.enable('beta', { dailyBuildLimit: 1 });
  const first = await f.join();
  await f.join('beta');
  const second = await f.join('alpha', 'second@example.com');
  const viewer = await f.join('alpha', 'viewer@example.com', 'viewer');
  await f.store.consumeBuildQuota(first.sessionToken, 'alpha');
  await f.store.consumeBuildQuota(first.sessionToken, 'beta');
  await f.store.consumeBuildQuota(second.sessionToken, 'alpha');
  await assert.rejects(f.store.consumeBuildQuota(viewer.sessionToken, 'alpha'), { status: 403 });
  await assert.rejects(f.store.consumeBuildQuota(first.sessionToken, 'alpha'), { status: 429 });
  f.advance(2 * 60_000);
  assert.equal((await f.store.consumeBuildQuota(first.sessionToken, 'alpha')).used, 1);
});

test('symlink stores and oversized persisted JSON fail closed', async t => {
  const f = await fixture(t);
  await f.store.configure('alpha', { modules: ['websites'] });
  const outside = path.join(f.directory, 'outside.json');
  await fs.writeFile(outside, JSON.stringify({ unchanged: true }));
  await fs.rm(f.file);
  await fs.symlink(outside, f.file);
  await assert.rejects(f.store.getProjectAccess('alpha'), { status: 500 });
  await assert.rejects(f.enable(), { status: 500 });
  assert.deepEqual(JSON.parse(await fs.readFile(outside, 'utf8')), { unchanged: true });
  await fs.rm(f.file);
  await fs.writeFile(f.file, ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(f.store.getProjectAccess('alpha'), { status: 500 });
});

test('pending invite metadata contains no redeemable token or token hash', async t => {
  const f = await fixture(t);
  await f.enable();
  const invitation = await f.invite();
  const settings = await f.store.getProjectAccess('alpha');
  assert.equal(settings.pendingInvites.length, 1);
  assert.equal(settings.pendingInvites[0].email, 'client@example.com');
  assert.equal(JSON.stringify(settings).includes(invitation.token), false);
  assert.equal(JSON.stringify(settings).includes('tokenHash'), false);
  await f.store.configure('alpha', { externalEnabled: false });
  await assert.rejects(f.store.acceptInvite({ token: invitation.token, password: PASSWORD }), { status: 403 });
});
