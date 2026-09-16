import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMicrosoftFundingMail, MICROSOFT_FUNDING_LOGIN, MICROSOFT_FUNDING_MAILBOX, MICROSOFT_FUNDING_SCOPES } from '../integrations/microsoft-funding-mail.js';

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-graph-funding-test-'));
after(() => fs.rm(ROOT, { recursive: true, force: true }));
const BASE = '/v1.0/users/foerderung%40heat-hero.com';
const INBOX = 'Inbox-Immutable', DONE = 'Done-Immutable';
const RFC = '<funding-fixture@example.test>';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const clone = value => JSON.parse(JSON.stringify(value));
const ATTACHMENT_MODIFIED = '2026-08-15T11:59:00.000Z';
function fixtureSourceHash() {
  const row = mail();
  return crypto.createHash('sha256').update(JSON.stringify({ messageId: RFC, immutableId: row.id, sender: ['kunde@example.test'], recipients: [MICROSOFT_FUNDING_MAILBOX], cc: [], subject: row.subject, body: row.body.content, bodyType: 'text/plain', attachments: [{ attachmentId: 'Attachment-1', name: 'Nachweis.pdf', size: Buffer.byteLength('%PDF-fixture'), contentType: 'application/pdf', type: '#microsoft.graph.fileAttachment', lastModifiedDateTime: ATTACHMENT_MODIFIED }] })).digest('hex');
}
function mail(overrides = {}) {
  return { id: 'Message-Immutable', internetMessageId: RFC, parentFolderId: INBOX, receivedDateTime: '2026-08-15T12:00:00.000Z', sentDateTime: '2026-08-15T11:59:00.000Z', subject: 'Unterlagen Testkunde', from: { emailAddress: { address: 'kunde@example.test' } }, toRecipients: [{ emailAddress: { address: MICROSOFT_FUNDING_MAILBOX } }], ccRecipients: [], hasAttachments: true, body: { contentType: 'text', content: 'Vollständige vertrauliche Förderinformation.' }, ...overrides };
}
function receipt(messageId = RFC, overrides = {}) {
  return { messageId, source: 'microsoft-graph', sourceHash: fixtureSourceHash(), dealId: '1234', identityVerified: true, sourceReadComplete: true, expectedAttachmentCount: 1, attachmentProcessingVerified: true,
    uploadedFiles: [{ id: 'File-1', filename: 'Testkunde_Meldebescheinigung.pdf', dealId: '1234', verified: true }], textRelevant: true, note: { id: 'Note-1', dealId: '1234', verified: true }, verifiedAt: new Date(Date.now() - 1000).toISOString(), ...overrides };
}
let serial = 0;
async function fixture(overrides = {}) {
  const dataDir = path.join(ROOT, String(++serial));
  const env = { MICROSOFT_FUNDING_TENANT_ID: '12345678-1234-1234-1234-123456789abc', MICROSOFT_FUNDING_CLIENT_ID: 'abcdef12-1234-1234-1234-123456789abc', MICROSOFT_FUNDING_CLIENT_SECRET: 'fixture-client-secret-not-for-output', MICROSOFT_FUNDING_TOKEN_KEY: 'fixture-key-with-at-least-32-random-bytes-abcdef', MICROSOFT_FUNDING_REDIRECT_URI: 'https://iva.example.test/oauth/microsoft-funding/callback', ...overrides.env };
  const state = {
    now: Date.parse('2026-09-16T12:00:00Z'), calls: [], tokenCalls: [], moveCalls: 0, actor: { id: 'Actor-1', mail: MICROSOFT_FUNDING_LOGIN, userPrincipalName: MICROSOFT_FUNDING_LOGIN }, inbox: { id: INBOX, parentFolderId: 'Root' },
    folders: [{ id: DONE, displayName: 'Fertig', parentFolderId: INBOX }], messages: [mail()],
    attachments: [{ id: 'Attachment-1', name: 'Nachweis.pdf', size: 11, contentType: 'application/pdf', isInline: false, lastModifiedDateTime: ATTACHMENT_MODIFIED, '@odata.type': '#microsoft.graph.fileAttachment' }], attachmentBytes: Buffer.from('%PDF-fixture'), attachmentContentBytes: Buffer.from('%PDF-fixture'),
    deltaPages: [], override: null, moveFailure: null,
  };
  state.attachments[0].size = state.attachmentBytes.length;
  const fetch = async (input, options) => {
    const url = new URL(input), body = options.body ? String(options.body) : undefined;
    state.calls.push({ url: url.href, method: options.method, headers: options.headers, body });
    assert.equal(options.redirect, 'error'); assert(options.signal instanceof AbortSignal);
    if (state.override) { const response = await state.override(url, options); if (response !== undefined) return response; }
    if (url.hostname === 'login.microsoftonline.com') {
      const parameters = new URLSearchParams(body); state.tokenCalls.push(parameters);
      const refresh = parameters.get('grant_type') === 'refresh_token';
      return json({ access_token: refresh ? 'rotated-access-fixture' : 'access-fixture', refresh_token: refresh ? `rotated-refresh-${state.tokenCalls.length}` : 'refresh-fixture', token_type: 'Bearer', expires_in: 3600, scope: MICROSOFT_FUNDING_SCOPES.join(' ') });
    }
    assert.equal(url.origin, 'https://graph.microsoft.com');
    assert.match(options.headers.Prefer, /IdType="ImmutableId"/);
    if (url.pathname === '/v1.0/me') return json(state.actor);
    assert(url.pathname.startsWith(BASE + '/'), 'every data call is scoped to the funding mailbox');
    if (url.pathname === BASE + '/mailFolders/inbox') return json(state.inbox);
    if (url.pathname === `${BASE}/mailFolders/${INBOX}/childFolders`) return json({ value: state.folders });
    if (url.pathname === `${BASE}/mailFolders/${INBOX}/messages/delta`) {
      const response = state.deltaPages.shift();
      return json(response || { value: [], '@odata.deltaLink': `https://graph.microsoft.com${BASE}/mailFolders/${INBOX}/messages/delta?$deltatoken=last` });
    }
    if (url.pathname === `${BASE}/messages`) {
      const match = url.searchParams.get('$filter').match(/^internetMessageId eq '(.*)'$/);
      assert(match); const id = match[1].replace(/''/g, "'");
      return json({ value: state.messages.filter(x => x.internetMessageId === id) });
    }
    if (/\/attachments$/.test(url.pathname)) return json({ value: state.attachments });
    if (/\/attachments\/[^/]+$/.test(url.pathname)) return json({ id: 'Attachment-1', contentBytes: state.attachmentContentBytes.toString('base64') });
    if (/\/attachments\/[^/]+\/\$value$/.test(url.pathname)) return new Response(state.attachmentBytes, { headers: { 'Content-Type': 'application/pdf' } });
    if (/\/move$/.test(url.pathname)) {
      state.moveCalls++;
      assert.deepEqual(JSON.parse(body), { destinationId: DONE });
      assert.equal(options.method, 'POST');
      if (state.moveFailure === 'before') throw new Error('PRIVATE transport diagnostic');
      state.messages[0].parentFolderId = DONE;
      if (state.moveFailure === 'after') throw new Error('PRIVATE transport diagnostic');
      return json(state.messages[0], 201);
    }
    throw new Error('Unexpected mock request');
  };
  const service = createMicrosoftFundingMail({ env, fetch, now: () => state.now, dataDir });
  const connect = async () => {
    const url = new URL(await service.createAuthUrl());
    return service.completeOAuth({ code: 'fixture-code', state: url.searchParams.get('state') });
  };
  return { service, state, env, dataDir, connect, fetch };
}
const moveInput = proof => ({ messageId: RFC, destinationFolder: 'Fertig', receipt: proof });
const rejected = code => error => error.code === `MICROSOFT_FUNDING_${code}`;

test('missing or invalid own app config is not ready and causes no network request', async () => {
  const f = await fixture({ env: { MICROSOFT_FUNDING_CLIENT_SECRET: '' } });
  const status = await f.service.status(); assert.equal(status.ready, false); assert.equal(status.authorized, false); assert.equal(status.configured, false);
  assert(status.missing.includes('MICROSOFT_FUNDING_CLIENT_SECRET')); assert.equal(f.state.calls.length, 0);
  await assert.rejects(f.service.createAuthUrl(), rejected('CONFIG_REQUIRED'));
  f.env.MICROSOFT_FUNDING_CLIENT_SECRET = 'fixture'; f.env.MICROSOFT_FUNDING_TENANT_ID = 'common';
  assert.equal((await f.service.status()).configured, false);
});

test('own app alone stays not ready; PKCE authorization binds exact login, shared mailbox and scopes', async () => {
  const f = await fixture();
  assert.equal((await f.service.status()).ready, false);
  const url = new URL(await f.service.createAuthUrl());
  assert.equal(url.origin, 'https://login.microsoftonline.com');
  assert.equal(url.searchParams.get('scope'), 'offline_access User.Read Mail.ReadWrite.Shared');
  assert.equal(url.searchParams.get('login_hint'), MICROSOFT_FUNDING_LOGIN);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('response_type'), 'code');
  const result = await f.service.completeOAuth({ code: 'fixture-code', state: url.searchParams.get('state') });
  assert.equal(result.probe.mailboxVerified, true); assert.equal(result.sendsMail, false);
  const verifier = f.state.tokenCalls[0].get('code_verifier');
  assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), url.searchParams.get('code_challenge'));
  const status = await f.service.status(); assert.equal(status.ready, true); assert.equal(status.requiresUnlockedScreen, false);
  for (const name of await fs.readdir(f.dataDir)) {
    const raw = await fs.readFile(path.join(f.dataDir, name), 'utf8');
    assert.doesNotMatch(raw, /access-fixture|refresh-fixture|fixture-client-secret|code_verifier|n\.sell@|foerderung@/);
    assert.equal((await fs.stat(path.join(f.dataDir, name))).mode & 0o777, 0o600);
  }
});

test('OAuth state is one-use under simultaneous callbacks and expired state makes no token call', async () => {
  const f = await fixture(), url = new URL(await f.service.createAuthUrl()), input = { code: 'fixture-code', state: url.searchParams.get('state') };
  const results = await Promise.allSettled([f.service.completeOAuth(input), f.service.completeOAuth(input)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); assert.equal(f.state.tokenCalls.length, 1);
  await assert.rejects(f.service.completeOAuth(input), rejected('OAUTH_STATE'));
  const expired = new URL(await f.service.createAuthUrl()); f.state.now += 11 * 60_000;
  await assert.rejects(f.service.completeOAuth({ code: 'fixture-code', state: expired.searchParams.get('state') }), rejected('OAUTH_STATE'));
  assert.equal(f.state.tokenCalls.length, 1);
});

test('wrong signed-in principal never connects even with mailbox access and a spoofed mail alias', async () => {
  const f = await fixture(); f.state.actor.userPrincipalName = 'other@heat-hero.com';
  await assert.rejects(f.connect(), rejected('LOGIN_MISMATCH'));
  assert.equal((await f.service.status()).ready, false);
  assert.equal(f.state.calls.some(x => x.url.includes('/mailFolders/')), false);
});

test('refresh token, shared mail permission, and real inbox probe are all required', async () => {
  for (const alteration of ['no-refresh', 'no-shared', 'send']) {
    const f = await fixture();
    f.state.override = url => url.hostname === 'login.microsoftonline.com' ? json({ access_token: 'access-fixture', ...(alteration !== 'no-refresh' ? { refresh_token: 'refresh-fixture' } : {}), token_type: 'Bearer', expires_in: 3600,
      scope: alteration === 'no-shared' ? 'offline_access User.Read Mail.ReadWrite' : 'offline_access User.Read Mail.ReadWrite.Shared' + (alteration === 'send' ? ' Mail.Send' : '') }) : undefined;
    await assert.rejects(f.connect()); assert.equal((await f.service.status()).ready, false);
  }
  const f = await fixture(); f.state.override = url => url.pathname.endsWith('/mailFolders/inbox') ? json({ error: { message: 'PRIVATE account information' } }, 403) : undefined;
  await assert.rejects(f.connect(), error => error.code === 'MICROSOFT_FUNDING_ACCESS_REQUIRED' && !error.message.includes('PRIVATE'));
  assert.equal((await f.service.status()).ready, false);
});

test('refresh is serialized, rotates stored refresh token and revalidates the principal and mailbox', async () => {
  const f = await fixture(); await f.connect(); f.state.now += 3600_000;
  const statuses = await Promise.all(Array.from({ length: 4 }, () => f.service.status({ probe: true })));
  assert(statuses.every(x => x.ready)); assert.equal(f.state.tokenCalls.filter(x => x.get('grant_type') === 'refresh_token').length, 1);
  assert.equal(f.state.tokenCalls.at(-1).get('refresh_token'), 'refresh-fixture');
  f.state.now += 3600_000; await f.service.status({ probe: true });
  assert.equal(f.state.tokenCalls.at(-1).get('refresh_token'), 'rotated-refresh-2');
  const fresh = createMicrosoftFundingMail({ env: f.env, fetch: f.fetch, now: () => f.state.now, dataDir: f.dataDir });
  assert.equal((await fresh.status()).ready, true);
  f.env.MICROSOFT_FUNDING_CLIENT_ID = 'bbbbbbbb-1234-1234-1234-123456789abc';
  assert.equal((await fresh.status()).ready, false);
});

test('failed probe after refresh keeps rotated token but clears ready until a successful retry', async () => {
  const f = await fixture(); await f.connect(); f.state.now += 3600_000;
  f.state.override = url => url.pathname.endsWith('/mailFolders/inbox') ? json({}, 503) : undefined;
  assert.equal((await f.service.status({ probe: true })).ready, false);
  assert.equal((await f.service.status()).ready, false);
  f.state.override = null;
  assert.equal((await f.service.status({ probe: true })).ready, true);
  assert.equal(f.state.tokenCalls.filter(x => x.get('grant_type') === 'refresh_token').length, 1);
});

test('initial delta paging uses encrypted cursor and continues daily from the saved checkpoint', async () => {
  const f = await fixture(); await f.connect();
  f.state.deltaPages.push({ value: [mail()], '@odata.nextLink': `https://graph.microsoft.com${BASE}/mailFolders/${INBOX}/messages/delta?$skiptoken=second` },
    { value: [{ id: 'Removed-1', '@removed': { reason: 'deleted' } }], '@odata.deltaLink': `https://graph.microsoft.com${BASE}/mailFolders/${INBOX}/messages/delta?$deltatoken=checkpoint` },
    { value: [mail({ id: 'Late-2', internetMessageId: '<late-old@example.test>', receivedDateTime: '2026-08-02T00:00:00Z' })], '@odata.deltaLink': `https://graph.microsoft.com${BASE}/mailFolders/${INBOX}/messages/delta?$deltatoken=next` });
  const one = await f.service.readPage({ mode: 'initial-backfill', since: '2026-08-01', limit: 1 });
  assert.equal(one.complete, false); assert.equal(one.messages[0].messageId, RFC); assert.equal(one.messages[0].identityVerified, true); assert.equal(one.source, 'microsoft-graph');
  assert.match(one.nextCursor, /^msgraph:/); assert(!Buffer.from(one.nextCursor.slice(8), 'base64url').toString().includes('second'));
  const two = await f.service.readPage({ mode: 'initial-backfill', cursor: one.nextCursor });
  assert.equal(two.complete, true); assert.deepEqual(two.messages, []); assert.deepEqual(two.removedImmutableIds, ['Removed-1']); assert(two.checkpoint);
  const three = await f.service.readPage({ mode: 'incremental', cursor: two.checkpoint });
  assert.equal(three.messages[0].messageId, '<late-old@example.test>');
  const calls = f.state.calls.filter(x => x.url.includes('/messages/delta'));
  assert(calls[0].url.includes('receivedDateTime')); assert(calls[1].url.endsWith('?$skiptoken=second')); assert(calls[2].url.endsWith('?$deltatoken=checkpoint'));
  assert(f.state.calls.filter(x => x.method === 'POST').every(x => x.url.includes('/token')));
});

test('bad mode, mailbox, range and forged or foreign cursors fail instead of resetting scan', async () => {
  const f = await fixture(); await f.connect();
  for (const input of [{}, { mode: 'initial-backfill', since: '2026-08-02' }, { mode: 'initial-backfill', since: '2026-08-01', from: MICROSOFT_FUNDING_LOGIN }, { folder: 'constructor', since: '2026-08-01', mode: 'initial-backfill' }]) await assert.rejects(f.service.readPage(input));
  for (const cursor of ['native:old', 'msgraph:bad']) await assert.rejects(f.service.readPage({ mode: 'incremental', cursor }), rejected('CURSOR_INVALID'));
  const first = await f.service.readPage({ mode: 'initial-backfill', since: '2026-08-01' });
  await assert.rejects(f.service.readPage({ mode: 'initial-backfill', cursor: first.checkpoint }), rejected('CURSOR_INVALID'));
  f.state.inbox.id = 'Other-Inbox';
  await assert.rejects(f.service.readPage({ mode: 'incremental', cursor: first.checkpoint }), rejected('MAILBOX_CHANGED'));
});

test('pagination never follows external hosts, another mailbox, another endpoint or incomplete pages', async () => {
  for (const link of ['https://evil.example.test/steal', `https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=x`, `https://graph.microsoft.com${BASE}/messages?$skiptoken=x`, `https://graph.microsoft.com${BASE}/mailFolders/${INBOX}/messages/delta#bad`]) {
    const f = await fixture(); await f.connect(); f.state.deltaPages = [{ value: [], '@odata.nextLink': link }];
    await assert.rejects(f.service.readPage({ mode: 'initial-backfill', since: '2026-08-01' }), rejected('CONTINUATION_DENIED'));
    assert.equal(f.state.calls.some(x => x.url === link), false);
  }
  const f = await fixture(); await f.connect(); f.state.deltaPages = [{ value: [] }];
  await assert.rejects(f.service.readPage({ mode: 'initial-backfill', since: '2026-08-01' }), rejected('PAGE_INCOMPLETE'));
});

test('read returns complete body and paginated attachment metadata without changing read flags', async () => {
  const f = await fixture(); await f.connect();
  f.state.override = url => /\/attachments$/.test(url.pathname) ? json(url.searchParams.has('$skiptoken')
    ? { value: [{ ...f.state.attachments[0], id: 'Attachment-2', name: 'zweite.pdf' }] }
    : { value: f.state.attachments, '@odata.nextLink': `https://graph.microsoft.com${url.pathname}?$skiptoken=second` }) : undefined;
  const result = await f.service.readMessage({ messageId: RFC });
  assert.equal(result.sourceReadComplete, true); assert.equal(result.attachmentsComplete, true); assert.equal(result.attachments.length, 2);
  assert.equal(result.body, f.state.messages[0].body.content); assert.equal(result.bodyType, 'text/plain'); assert.equal(result.identityVerified, true);
  assert.equal(result.messageId, RFC); assert.equal(result.immutableId, 'Message-Immutable');
  assert(f.state.calls.filter(x => x.url.startsWith('https://graph.')).every(x => x.method === 'GET'));
  const saved = await fs.readFile(path.join(f.dataDir, 'microsoft-funding-identities.enc.json'), 'utf8');
  assert(!saved.includes(result.body)); assert(!saved.includes(RFC));
});

test('duplicate RFC IDs, inconsistent mapping, missing body and incomplete attachment paging stop processing', async () => {
  const f = await fixture(); await f.connect(); f.state.messages.push(mail({ id: 'Duplicate-2' }));
  await assert.rejects(f.service.readMessage({ messageId: RFC }), rejected('DUPLICATE_MESSAGE_ID'));
  f.state.messages.pop(); await f.service.readMessage({ messageId: RFC }); f.state.messages[0].id = 'Changed-2';
  await assert.rejects(f.service.readMessage({ messageId: RFC }), rejected('DUPLICATE_MESSAGE_ID'));
  const g = await fixture(); await g.connect(); delete g.state.messages[0].body;
  await assert.rejects(g.service.readMessage({ messageId: RFC }), rejected('BODY_INCOMPLETE'));
  g.state.messages[0].body = mail().body;
  g.state.override = url => /\/attachments$/.test(url.pathname) ? json({ value: g.state.attachments, '@odata.nextLink': `https://graph.microsoft.com${url.pathname}?$skiptoken=same` }) : undefined;
  await assert.rejects(g.service.readMessage({ messageId: RFC }), rejected('PAGINATION_INVALID'));
});

test('exact destination is the single Fertig child under Inbox; misplaced, missing and duplicated folders fail', async () => {
  const f = await fixture(); await f.connect(); f.state.messages[0].parentFolderId = DONE;
  assert.equal((await f.service.resolveIdentity({ folder: 'Fertig', messageId: RFC })).identityVerified, true);
  assert.equal((await f.service.resolveIdentity({ folder: 'Posteingang', messageId: RFC })).notFound, true);
  for (const folders of [[], [{ id: DONE, displayName: 'Fertig', parentFolderId: 'Elsewhere' }], [f.state.folders[0], { id: 'Done-2', displayName: 'fertig', parentFolderId: INBOX }]]) {
    f.state.folders = folders; await assert.rejects(f.service.resolveIdentity({ folder: 'Fertig', messageId: RFC }), rejected('DONE_FOLDER_REQUIRED'));
  }
});

test('download returns exact verified bytes/hash and safe filename; never trusts attachment id alone', async () => {
  const f = await fixture(); await f.connect(); f.state.attachments[0].name = '../../subdir\\Nachweis.pdf';
  const result = await f.service.downloadAttachment({ messageId: RFC, attachmentId: 'Attachment-1' });
  assert(result.buffer.equals(f.state.attachmentBytes)); assert.equal(result.filename, 'Nachweis.pdf'); assert.equal(result.size, f.state.attachmentBytes.length);
  assert.equal(result.sha256, crypto.createHash('sha256').update(f.state.attachmentBytes).digest('hex')); assert.equal(result.verified, true); assert.equal(result.messageMutated, false);
  await assert.rejects(f.service.downloadAttachment({ messageId: RFC, attachmentId: 'Other-Attachment' }), rejected('ATTACHMENT_UNSUPPORTED'));
  f.state.attachmentBytes = Buffer.from('short');
  await assert.rejects(f.service.downloadAttachment({ messageId: RFC, attachmentId: 'Attachment-1' }), rejected('ATTACHMENT_SIZE_MISMATCH'));
});

test('unsupported nested/reference attachment and altered message stay open', async () => {
  const f = await fixture(); await f.connect(); f.state.attachments[0]['@odata.type'] = '#microsoft.graph.itemAttachment';
  const info = await f.service.readMessage({ messageId: RFC }); assert.equal(info.attachments[0].supported, false);
  await assert.rejects(f.service.downloadAttachment({ messageId: RFC, attachmentId: 'Attachment-1' }), rejected('ATTACHMENT_UNSUPPORTED'));
  f.state.attachments[0]['@odata.type'] = '#microsoft.graph.fileAttachment';
  f.state.override = url => { if (/\/\$value$/.test(url.pathname)) { f.state.messages[0].body.content = 'Geändert während Download'; return new Response(f.state.attachmentBytes); } };
  await assert.rejects(f.service.downloadAttachment({ messageId: RFC, attachmentId: 'Attachment-1' }), rejected('SOURCE_CHANGED'));
});

test('move requires complete receipt, correct source identity, full original read and exact attachment count', async () => {
  const f = await fixture(); await f.connect();
  await assert.rejects(f.service.moveMessage({ messageId: RFC, destinationFolder: 'Fertig' }), rejected('RECEIPT_REQUIRED'));
  await assert.rejects(f.service.moveMessage({ ...moveInput(receipt()), destinationFolder: 'Trash' }), rejected('DESTINATION_DENIED'));
  await assert.rejects(f.service.moveMessage(moveInput(receipt('<other@example.test>'))), rejected('RECEIPT_MISMATCH'));
  await assert.rejects(f.service.moveMessage(moveInput(receipt())), rejected('SOURCE_READ_REQUIRED'));
  await f.service.readMessage({ messageId: RFC });
  await assert.rejects(f.service.moveMessage(moveInput(receipt(RFC, { expectedAttachmentCount: 2 }))), rejected('SOURCE_READ_REQUIRED'));
  await assert.rejects(f.service.moveMessage(moveInput(receipt(RFC, { uploadedFiles: [] }))), rejected('RECEIPT_REQUIRED'));
  assert.equal(f.state.moveCalls, 0);
});

test('move reads back original identity in target and is idempotent after process restart', async () => {
  const f = await fixture(); await f.connect(); await f.service.readMessage({ messageId: RFC }); const input = moveInput(receipt());
  const first = await f.service.moveMessage(input); assert.equal(first.moved, true); assert.equal(first.verifiedInDestination, true); assert.equal(f.state.moveCalls, 1);
  const restarted = createMicrosoftFundingMail({ env: f.env, fetch: f.fetch, now: () => f.state.now, dataDir: f.dataDir });
  const again = await restarted.moveMessage(input); assert.equal(again.moved, false); assert.equal(again.verifiedInDestination, true); assert.equal(f.state.moveCalls, 1);
  await assert.rejects(restarted.moveMessage(moveInput(receipt(RFC, { dealId: '5678', uploadedFiles: [{ id: 'Other', filename: 'andere.pdf', dealId: '5678', verified: true }], note: { id: 'Other', dealId: '5678', verified: true } }))), rejected('RECEIPT_MISMATCH'));
  const lastPost = f.state.calls.findLastIndex(x => x.method === 'POST' && x.url.endsWith('/move'));
  assert(f.state.calls.slice(lastPost + 1).some(x => x.url.includes('/messages?')));
});

test('lost move response resumes by target readback and never repeats the POST', async () => {
  const f = await fixture(); await f.connect(); await f.service.readMessage({ messageId: RFC }); const input = moveInput(receipt()); f.state.moveFailure = 'after';
  await assert.rejects(f.service.moveMessage(input), error => error.code === 'MICROSOFT_FUNDING_NETWORK' && !error.message.includes('PRIVATE'));
  f.state.moveFailure = null;
  const resumed = await f.service.moveMessage(input); assert.equal(resumed.verifiedInDestination, true); assert.equal(resumed.moved, false); assert.equal(f.state.moveCalls, 1);
});

test('uncertain attempted move still in Inbox is not blindly repeated; existing target is not self-proved', async () => {
  const f = await fixture(); await f.connect(); await f.service.readMessage({ messageId: RFC }); const input = moveInput(receipt()); f.state.moveFailure = 'before';
  await assert.rejects(f.service.moveMessage(input), rejected('NETWORK')); f.state.moveFailure = null;
  await assert.rejects(f.service.moveMessage(input), rejected('MOVE_UNCERTAIN')); assert.equal(f.state.moveCalls, 1);
  const g = await fixture(); await g.connect(); g.state.messages[0].parentFolderId = DONE;
  await assert.rejects(g.service.moveMessage(moveInput(receipt())), rejected('MOVE_PROOF_REQUIRED')); assert.equal(g.state.moveCalls, 0);
});

test('source changes after read and external return of completed mail to Inbox never remutates', async () => {
  const f = await fixture(); await f.connect(); await f.service.readMessage({ messageId: RFC }); f.state.messages[0].body.content = 'Neuer Inhalt';
  await assert.rejects(f.service.moveMessage(moveInput(receipt())), rejected('SOURCE_READ_REQUIRED'));
  const reviewed = await f.service.readMessage({ messageId: RFC }); const input = moveInput(receipt(RFC, { sourceHash: reviewed.sourceHash })); await f.service.moveMessage(input);
  f.state.messages[0].parentFolderId = INBOX;
  await assert.rejects(f.service.moveMessage(input), rejected('SOURCE_CHANGED')); assert.equal(f.state.moveCalls, 1);
});

test('error payload, redirect and oversized response cannot leak credentials or mark an empty success', async () => {
  const f = await fixture(); await f.connect();
  f.state.override = url => url.pathname.endsWith('/messages/delta') ? json({ error: { message: 'refresh-fixture PRIVATE account' } }, 401) : undefined;
  await assert.rejects(f.service.readPage({ mode: 'initial-backfill', since: '2026-08-01' }), error => error.code === 'MICROSOFT_FUNDING_ACCESS_REQUIRED' && !/PRIVATE|refresh-fixture/.test(error.message) && error.complete === false);
  f.state.override = url => url.pathname.endsWith('/messages/delta') ? new Response('{}', { headers: { 'content-length': String(100 * 1024 * 1024) } }) : undefined;
  await assert.rejects(f.service.readPage({ mode: 'initial-backfill', since: '2026-08-01' }), rejected('RESPONSE_LIMIT'));
});

test('store size overhead is accepted only when raw and explicit file content are byte-identical', async () => {
  const f = await fixture(); await f.connect(); f.state.attachments[0].size += 1024;
  const result = await f.service.downloadAttachment({ messageId: RFC, attachmentId: 'Attachment-1' });
  assert.equal(result.size, f.state.attachmentBytes.length); assert.equal(result.reportedSize, f.state.attachments[0].size); assert.equal(result.verified, true);
  assert(f.state.calls.some(x => x.url.includes('?$select=id,contentBytes')));
  f.state.attachmentContentBytes = Buffer.from('different-data');
  await assert.rejects(f.service.downloadAttachment({ messageId: RFC, attachmentId: 'Attachment-1' }), rejected('ATTACHMENT_SIZE_MISMATCH'));
});

test('base64 fallback above the normal JSON response limit still verifies a bounded large file', async () => {
  const f = await fixture(); await f.connect();
  f.state.attachmentBytes = Buffer.alloc(10 * 1024 * 1024, 65); f.state.attachmentContentBytes = f.state.attachmentBytes;
  f.state.attachments[0].size = f.state.attachmentBytes.length + 768;
  const result = await f.service.downloadAttachment({ messageId: RFC, attachmentId: 'Attachment-1' });
  assert.equal(result.size, 10 * 1024 * 1024); assert.equal(result.verified, true); assert(result.buffer.equals(f.state.attachmentBytes));
});

test('receipt source version cannot be replaced by rereading changed content with same attachment count', async () => {
  const f = await fixture(); await f.connect(); const first = await f.service.readMessage({ messageId: RFC });
  const originalReceipt = receipt(RFC, { sourceHash: first.sourceHash });
  f.state.messages[0].body.content = 'Andere Förderinformation bei gleicher Anlagenzahl';
  await f.service.readMessage({ messageId: RFC });
  await assert.rejects(f.service.moveMessage(moveInput(originalReceipt)), rejected('SOURCE_READ_REQUIRED'));
  assert.equal(f.state.moveCalls, 0);
});

test('completed replay checks exact original receipt and current source hash in Fertig', async () => {
  const f = await fixture(); await f.connect(); await f.service.readMessage({ messageId: RFC }); const proof = receipt(); await f.service.moveMessage(moveInput(proof));
  await assert.rejects(f.service.moveMessage(moveInput({ ...proof, note: { ...proof.note, id: 'Other-Note' } })), rejected('RECEIPT_CHANGED'));
  f.state.messages[0].body.content = 'Nach Abschluss verändert';
  await assert.rejects(f.service.moveMessage(moveInput(proof)), rejected('SOURCE_CHANGED')); assert.equal(f.state.moveCalls, 1);
});

test('definitive 401 and 429 move rejection permits a verified retry, respecting Retry-After', async () => {
  for (const code of [401, 429]) {
    const f = await fixture(); await f.connect(); await f.service.readMessage({ messageId: RFC }); const proof = receipt();
    let rejectedCount = 0;
    f.state.override = url => url.pathname.endsWith('/move') ? (rejectedCount++, new Response('{}', { status: code, headers: { 'retry-after': code === 429 ? '5' : '0' } })) : undefined;
    await assert.rejects(f.service.moveMessage(moveInput(proof)), error => error.httpStatus === code && error.definitivelyRejected === true);
    f.state.override = null;
    if (code === 429) { await assert.rejects(f.service.moveMessage(moveInput(proof)), rejected('THROTTLED')); f.state.now += 5000; }
    const result = await f.service.moveMessage(moveInput(proof));
    assert.equal(result.verifiedInDestination, true); assert.equal(f.state.moveCalls, 1); assert.equal(rejectedCount, 1);
  }
});

test('unfiltered initial metadata sync handles over 5,000 rows, excludes old mail and resumes daily without history', async () => {
  const f = await fixture(); await f.connect();
  let counter = 0, pageNumber = 0;
  // Deliberately omit RFC IDs and body from old messages; neither is needed.
  const rows = count => Array.from({ length: count }, () => ({ id: `Old-${++counter}`, parentFolderId: INBOX, receivedDateTime: '2025-01-01T10:00:00Z' }));
  const link = () => `https://graph.microsoft.com${BASE}/mailFolders/${INBOX}/messages/delta?$skiptoken=limit-${++pageNumber}`;
  f.state.deltaPages = [...Array.from({ length: 10 }, () => ({ value: rows(500), '@odata.nextLink': link() })), { value: [mail()], '@odata.deltaLink': `https://graph.microsoft.com${BASE}/mailFolders/${INBOX}/messages/delta?$deltatoken=complete-unfiltered` }];
  let page = await f.service.readPage({ mode: 'initial-backfill', since: '2026-08-01' });
  assert.deepEqual(page.messages, []); assert.equal(page.complete, false);
  const restarted = createMicrosoftFundingMail({ env: f.env, fetch: f.fetch, now: () => f.state.now, dataDir: f.dataDir });
  for (let index = 1; index < 10; index++) {
    page = await restarted.readPage({ mode: 'initial-backfill', cursor: page.nextCursor });
    assert.deepEqual(page.messages, []); assert.equal(page.complete, false);
  }
  assert.equal(page.coverage.roundRows, 5000); assert.equal(page.checkpoint, null);
  const completed = await restarted.readPage({ mode: 'initial-backfill', cursor: page.nextCursor });
  assert.equal(completed.complete, true); assert.equal(completed.coverage.roundRows, 5001); assert.equal(completed.messages[0].messageId, RFC);
  f.state.deltaPages = [{ value: [mail({ id: 'Daily-New', internetMessageId: '<daily-new@example.test>' })], '@odata.deltaLink': `https://graph.microsoft.com${BASE}/mailFolders/${INBOX}/messages/delta?$deltatoken=daily` }];
  const daily = await restarted.readPage({ mode: 'incremental', cursor: completed.checkpoint });
  assert.equal(daily.complete, true); assert.equal(daily.coverage.roundRows, 1);
  const calls = f.state.calls.filter(x => x.url.includes('/messages/delta'));
  assert(calls.every(x => !new URL(x.url).searchParams.has('$filter')));
  assert(!new URL(calls[0].url).searchParams.get('$select').split(',').includes('body'));
  assert(calls.at(-1).url.endsWith('?$deltatoken=complete-unfiltered'));
  assert.equal(f.state.calls.some(x => /\/messages\?|\/attachments/.test(x.url)), false);
});

test('old encrypted filtered-delta cursor cannot be reused as unfiltered coverage', async () => {
  const f = await fixture(); await f.connect();
  const binding = crypto.createHash('sha256').update(JSON.stringify([f.env.MICROSOFT_FUNDING_TENANT_ID, f.env.MICROSOFT_FUNDING_CLIENT_ID, f.env.MICROSOFT_FUNDING_REDIRECT_URI, MICROSOFT_FUNDING_LOGIN, MICROSOFT_FUNDING_MAILBOX])).digest('hex');
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(f.env.MICROSOFT_FUNDING_TOKEN_KEY).digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ version: 2, kind: 'checkpoint', binding, mailbox: MICROSOFT_FUNDING_MAILBOX, inboxId: INBOX, since: '2026-07-31T22:00:00.000Z', roundRows: 100, link: `https://graph.microsoft.com${BASE}/mailFolders/${INBOX}/messages/delta?$deltatoken=old-filter` })), cipher.final()]);
  const cursor = 'msgraph:' + Buffer.from(JSON.stringify({ version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') })).toString('base64url');
  await assert.rejects(f.service.readPage({ mode: 'incremental', cursor }), rejected('CURSOR_INVALID'));
  assert.equal(f.state.calls.some(x => x.url.includes('/messages/delta')), false);
});

test('reconcile-only mode confirms only an existing completed move and never creates a POST', async () => {
  const f = await fixture(); await f.connect(); await f.service.readMessage({ messageId: RFC }); const input = moveInput(receipt());
  await assert.rejects(f.service.moveMessage({ ...input, reconcileOnly: true }), rejected('MOVE_RECONCILE_ONLY'));
  assert.equal(f.state.moveCalls, 0);
  await f.service.moveMessage(input);
  const replay = await f.service.moveMessage({ ...input, reconcileOnly: true });
  assert.equal(replay.verifiedInDestination, true); assert.equal(replay.moved, false); assert.equal(f.state.moveCalls, 1);
  f.state.messages[0].parentFolderId = INBOX;
  await assert.rejects(f.service.moveMessage({ ...input, reconcileOnly: true }), rejected('SOURCE_CHANGED')); assert.equal(f.state.moveCalls, 1);
});
