import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCustomerCareMailExecutor, validateCustomerCareEnvelope, validateCustomerCareSentProof } from '../local-mac-helper/customer-care-mail.mjs';
const exec = promisify(execFile), NOW = Date.parse('2026-09-15T10:00:00.000Z');
const hash = value => createHash('sha256').update(value).digest('hex');
const payload = { outboxId: 'outbox-test', projectId: 'project-test' };
const envelope = { ...payload, from: 'adviser@example.test', to: ['customer@example.test'], subject: 'Ihr Jahres-Check-up', body: 'Hallo Alex,\n\nIhre Fragen: https://example.test/checkup/unique\n\nViele Grüße' };
const proofFor = value => ({ verified: true, messageId: '<proof@example.test>', folder: 'Gesendet', sender: value.from, subject: value.subject, recipients: [...value.to], cc: [], bcc: [], attachments: [], bodyType: 'text/plain', bodyHash: hash(value.body), sentAt: '2026-09-15T10:00:01.000Z', checkedAt: '2026-09-15T10:00:02.000Z' });
const journalFile = dir => path.join(dir, 'customer-care-delivery', hash(JSON.stringify([payload.projectId, payload.outboxId])) + '.json');
async function fixture(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-customer-mail-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = { get: 0, prepare: 0, send: 0, verify: 0 };
  const options = { dataDir: dir, now: () => NOW + 5000,
    getEnvelope: async () => { calls.get++; return envelope; }, prepare: async () => { calls.prepare++; },
    send: async () => { calls.send++; }, verify: async input => { calls.verify++; return proofFor(input); }, ...overrides };
  return { dir, calls, options, run: createCustomerCareMailExecutor(options) };
}

test('envelope is one exact plain-text recipient with safe full subject/body', () => {
  const actual = validateCustomerCareEnvelope(envelope, payload.outboxId, payload.projectId);
  assert.equal(actual.body, envelope.body);
  assert.deepEqual(actual.to, envelope.to);
  for (const patch of [{ projectId: 'other' }, { to: [...envelope.to, 'extra@example.test'] }, { cc: ['extra@example.test'] }, { bcc: 'not-an-array' }, { attachments: {} }, { html: '<b>Hi</b>' }, { subject: 'Hi\nBcc: evil@example.test' }, { body: 'Hello\0\n' }, { body: ' Hello' }, { body: 'a'.repeat(100001) }, { subject: 'a'.repeat(241) }, { from: 'legit@example.test,evil@example.test' }, { to: ['Name <person@example.test>'] }]) assert.throws(() => validateCustomerCareEnvelope({ ...envelope, ...patch }, payload.outboxId, payload.projectId));
});
test('attempt is durable before single send, actual MIME proof becomes reusable receipt', async t => {
  const f = await fixture(t);
  const options = { ...f.options, send: async () => {
    f.calls.send++;
    const saved = JSON.parse(await fs.readFile(journalFile(f.dir), 'utf8'));
    assert.equal(saved.status, 'attempted'); assert.ok(saved.notBefore && saved.notAfter);
    assert.equal((await fs.stat(journalFile(f.dir))).mode & 0o777, 0o600);
  } };
  const result = await createCustomerCareMailExecutor(options)(payload);
  assert.equal(result.receipt.status, 'sent'); assert.equal(result.receipt.from, envelope.from);
  assert.equal(result.receipt.messageId, '<proof@example.test>');
  assert.equal(f.calls.get, 3); assert.equal(f.calls.send, 1); assert.equal(f.calls.verify, 1);
  const again = await createCustomerCareMailExecutor({ ...options, getEnvelope: () => { throw Error('must not re-fetch'); }, send: () => { throw Error('must not resend'); }, verify: () => { throw Error('must not reread sent proof'); } })(payload);
  assert.deepEqual(again, result);
  assert.equal(JSON.parse(await fs.readFile(journalFile(f.dir), 'utf8')).envelope, undefined);
});
test('an ambiguous send is read back, never retried even if API eligibility later fails', async t => {
  let attempts = 0, verifies = 0;
  const f = await fixture(t, { send: async () => { attempts++; throw Object.assign(Error('AX timed out'), { code: 'UI_TIMEOUT' }); }, verify: async input => { verifies++; return verifies === 1 ? { verified: false } : proofFor(input); } });
  const first = await f.run(payload); assert.equal(first.receipt.status, 'uncertain'); assert.equal(first.receipt.retryReadbackOnly, true);
  const result = await createCustomerCareMailExecutor({ ...f.options, getEnvelope: () => { throw Error('attempted must not re-check or re-send'); } })(payload);
  assert.equal(result.receipt.status, 'sent'); assert.equal(attempts, 1); assert.equal(verifies, 2);
});
test('readback failure remains retryable with saved time window and no resend', async t => {
  let verifies = 0;
  const f = await fixture(t, { verify: async input => { if (++verifies === 1) throw Object.assign(Error('temporarily offline'), { code: 'OUTLOOK_OFFLINE' }); return proofFor(input); } });
  const first = await f.run(payload); assert.equal(first.receipt.status, 'uncertain'); assert.equal(first.receipt.errorCode, 'OUTLOOK_OFFLINE');
  const before = JSON.parse(await fs.readFile(journalFile(f.dir), 'utf8'));
  const result = await f.run(payload); const after = JSON.parse(await fs.readFile(journalFile(f.dir), 'utf8'));
  assert.equal(result.receipt.status, 'sent'); assert.equal(f.calls.send, 1); assert.equal(before.notBefore, after.notBefore); assert.equal(before.notAfter, after.notAfter);
});
test('interruption during preparation reuses preparing state and cannot count as sent', async t => {
  let preparation = 0;
  const f = await fixture(t, { prepare: async (_envelope, options) => {
    if (++preparation === 1) { assert.equal(options.resuming, false); throw Error('process stopped before send'); }
    assert.equal(options.resuming, true);
  } });
  await assert.rejects(f.run(payload), /process stopped/);
  assert.equal(f.calls.send, 0); assert.equal(JSON.parse(await fs.readFile(journalFile(f.dir), 'utf8')).status, 'preparing');
  assert.equal((await f.run(payload)).receipt.status, 'sent'); assert.equal(f.calls.send, 1);
});
test('eligibility revoked before or after compose cancels without any send', async t => {
  for (const cancelAt of [1, 2, 3]) {
    let get = 0;
    const f = await fixture(t, { getEnvelope: async () => { if (++get === cancelAt) throw Object.assign(Error('rules revoked'), { code: 'CUSTOMER_CARE_NOT_ELIGIBLE' }); return envelope; } });
    assert.equal((await f.run(payload)).receipt.status, 'canceled'); assert.equal(f.calls.send, 0);
    assert.equal((await f.run(payload)).receipt.status, 'canceled'); assert.equal(get, cancelAt);
  }
});
test('template changed after compose cannot use previously reviewed content', async t => {
  let get = 0;
  const f = await fixture(t, { getEnvelope: async () => ++get < 3 ? envelope : { ...envelope, body: 'Changed text' } });
  await assert.rejects(f.run(payload), error => error.code === 'CUSTOMER_CARE_MAIL_TEMPLATE_CHANGED');
  assert.equal(f.calls.send, 0);
});
test('parallel executors claim same outbox once; contention does not bypass persisted state', async t => {
  let release, entered;
  const reached = new Promise(resolve => entered = resolve), held = new Promise(resolve => release = resolve);
  const f = await fixture(t, { prepare: async () => { entered(); await held; } });
  const first = f.run(payload); await reached;
  await assert.rejects(createCustomerCareMailExecutor(f.options)(payload), error => error.code === 'CUSTOMER_CARE_MAIL_BUSY');
  release(); assert.equal((await first).receipt.status, 'sent'); assert.equal(f.calls.send, 1);
});
test('corrupt journal and changed envelope are never treated as a new send', async t => {
  const f = await fixture(t, { verify: async () => ({ verified: false }) });
  await f.run(payload);
  const file = journalFile(f.dir), saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.envelope.body = 'Tampered'; await fs.writeFile(file, JSON.stringify(saved));
  await assert.rejects(f.run(payload), error => error.code === 'CUSTOMER_CARE_MAIL_JOURNAL_INVALID');
  await fs.writeFile(file, '{broken');
  await assert.rejects(f.run(payload), error => error.code === 'CUSTOMER_CARE_MAIL_JOURNAL_INVALID');
  assert.equal(f.calls.send, 1);
});
test('MIME success requires exactly sender, all recipient sets, full body, no attachments and valid dates', () => {
  const normalized = validateCustomerCareEnvelope(envelope, payload.outboxId, payload.projectId);
  const record = { envelope: normalized, notBefore: '2026-09-15T10:00:00.000Z', notAfter: '2026-09-15T10:10:00.000Z' };
  const good = proofFor(normalized);
  assert.equal(validateCustomerCareSentProof(good, record, NOW + 5000), true);
  for (const patch of [{ verified: false }, { messageId: 'unstable-row-id' }, { sender: 'evil@example.test' }, { subject: 'Other' }, { recipients: [...envelope.to, 'extra@example.test'] }, { recipients: [...envelope.to, ...envelope.to] }, { cc: ['extra@example.test'] }, { bcc: ['extra@example.test'] }, { cc: undefined }, { attachments: [{ name: 'file.pdf' }] }, { bodyType: 'text/html' }, { bodyHash: hash('Prefix only') }, { folder: 'Entwürfe' }, { sentAt: '2026-02-30T10:00:00.000Z' }, { sentAt: '2026-09-15T09:59:59.000Z' }, { sentAt: '2026-09-15T10:11:00.000Z' }, { checkedAt: 'not-a-date' }, { checkedAt: '2026-09-16T10:00:00.000Z' }]) assert.equal(validateCustomerCareSentProof({ ...good, ...patch }, record, NOW + 5000), false, JSON.stringify(patch));
});
test('a caller-provided verified flag cannot override failed original MIME evidence', async t => {
  const f = await fixture(t, { verify: async () => ({ verified: true, messageId: '<wrong@example.test>', sender: envelope.from, recipients: envelope.to }) });
  const result = await f.run({ ...payload, verified: true, receipt: { status: 'sent' } });
  assert.equal(result.receipt.status, 'uncertain'); assert.equal(f.calls.send, 1);
});
test('invalid payloads and untrusted project IDs never reach Outlook', async t => {
  const f = await fixture(t);
  for (const invalid of [{ outboxId: '../../escape', projectId: payload.projectId }, { ...payload, projectId: '' }, { ...payload, projectId: {} }, null]) await assert.rejects(f.run(invalid));
  assert.equal(f.calls.prepare, 0); assert.equal(f.calls.send, 0);
});

test('native text-compose validator accepts exact snapshot and rejects mismatches offline', { skip: process.platform !== 'darwin', timeout: 60000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-native-text-compose-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const binary = path.join(dir, 'iva-ax-fixture'), source = new URL('../local-mac-helper/macos/iva-ax.swift', import.meta.url).pathname;
  await exec('/usr/bin/swiftc', ['-sdk', '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk', source, '-o', binary], { timeout: 50000 });
  const expected = path.join(dir, 'expected.json'), snapshot = path.join(dir, 'snapshot.json');
  await fs.writeFile(expected, JSON.stringify(envelope));
  const good = { from: envelope.from, subject: envelope.subject, body: envelope.body + '\n', to: envelope.to, cc: [], bcc: [], attachmentCount: 0, unclassifiedRecipientCount: 0, composeCount: 1, bodyCount: 1, sendButtonCount: 1 };
  const check = async patch => { await fs.writeFile(snapshot, JSON.stringify({ ...good, ...patch })); return exec(binary, ['validate-text-compose-snapshot', expected, snapshot], { timeout: 5000 }); };
  assert.equal(JSON.parse((await check({})).stdout).verified, true);
  for (const patch of [{ from: 'bad' + envelope.from }, { subject: envelope.subject + ' ' }, { body: envelope.body + '\nUnreviewed footer' }, { body: 'Partial body' }, { to: [...envelope.to, 'extra@example.test'] }, { to: [] }, { cc: [envelope.to[0]] }, { bcc: [envelope.to[0]] }, { attachmentCount: 1 }, { unclassifiedRecipientCount: 1 }, { composeCount: 2 }, { bodyCount: 2 }, { sendButtonCount: 2 }]) await assert.rejects(check(patch), error => /CUSTOMER_CARE_COMPOSE_MISMATCH/.test(error.stdout));
  const native = await fs.readFile(source, 'utf8');
  const sendCommand = native.slice(native.indexOf('if command == "send-verified-text-compose"'), native.indexOf('if command == "send-verified-compose"'));
  assert.equal((sendCommand.match(/AXUIElementPerformAction/g) || []).length, 1);
  assert.doesNotMatch(sendCommand, /try click|commandShortcut/);
});
