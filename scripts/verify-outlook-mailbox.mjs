import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFundingMailboxReadScript, createOutlookMailboxMessageReader, createOutlookMailboxReader, parseFundingMailboxMetadata } from '../local-mac-helper/outlook-mailbox.mjs';

const seconds = value => Math.floor(Date.parse(value) / 1000);
const native = (rows, accountId = '7', folderId = '9') => ['IVA_MAILBOX_V1\t' + accountId + '\t' + folderId + '\t' + rows.length, ...rows.map(([id, time, attachments = 0, sender = 'kunde@example.test', subject = 'Unterlagen Testkunde']) => [id, time, attachments, sender, subject, 'IVA_END'].join('\t'))].join('\n');
function fixture(rows = []) {
  const state = { rows, clock: Date.parse('2026-09-15T23:00:00Z'), requests: [], accountId: '7', folderId: '9', hostChecks: 0 };
  const dependencies = { assertHost: async () => { state.hostChecks += 1; }, now: () => state.clock, execute: async script => {
    state.requests.push(script);
    const start = Number(script.match(/set lowerBound to localNow \+ \((\d+) - unixNow\)/)[1]);
    const end = Number(script.match(/set upperBound to localNow \+ \((\d+) - unixNow\)/)[1]);
    const id = script.match(/whose id is (\d+)/)?.[1];
    return native(state.rows.filter(row => id ? String(row[0]) === id : row[1] >= start && row[1] <= end), state.accountId, state.folderId);
  } };
  return { state, reader: createOutlookMailboxReader(dependencies), message: createOutlookMailboxMessageReader(dependencies) };
}

test('native pagination uses received time and stable IDs, retaining ties across pages', async () => {
  const time = seconds('2026-09-15T12:00:00Z');
  const f = fixture([['2', time, 0], ['10', time, 1], ['1', time - 5, 0]]);
  const first = await f.reader({ since: '2026-08-01', mode: 'initial-backfill', limit: 1 });
  assert.equal(first.complete, false); assert.equal(first.coverageVerified, true); assert.equal(first.messages[0].messageId, 'outlook:7:10');
  const second = await f.reader({ since: '2026-08-01', mode: 'initial-backfill', limit: 1, cursor: first.nextCursor });
  assert.equal(second.messages[0].messageId, 'outlook:7:2');
  const last = await f.reader({ since: '2026-08-01', mode: 'initial-backfill', limit: 1, cursor: second.nextCursor });
  assert.equal(last.messages[0].messageId, 'outlook:7:1'); assert.equal(last.complete, true); assert.equal(last.nextCursor, null); assert(last.checkpoint);
  assert.equal(first.messages[0].hasAttachments, true); assert.match(first.messages[0].description, /Betreff: Unterlagen Testkunde/);
  const decoded = Buffer.from(first.nextCursor, 'base64url').toString();
  assert(!decoded.includes('Testkunde')); assert(!decoded.includes('kunde@example.test'));
});

test('new arrivals do not shift an active page; checkpoint starts the next incremental range', async () => {
  const f = fixture([['1', seconds('2026-08-01T00:00:00Z')], ['2', seconds('2026-09-14T12:00:00Z')]]);
  const first = await f.reader({ since: '2026-08-01', mode: 'initial-backfill', limit: 1 });
  const snapshotEnd = seconds(first.coverage.until);
  f.state.clock += 10000; f.state.rows.push(['3', snapshotEnd + 2]);
  const end = await f.reader({ cursor: first.nextCursor, mode: 'initial-backfill', limit: 1 });
  assert.deepEqual(end.messages.map(row => row.messageId), ['outlook:7:1']); assert.equal(end.complete, true);
  const next = await f.reader({ cursor: end.checkpoint, mode: 'incremental' });
  assert.deepEqual(next.messages.map(row => row.messageId), ['outlook:7:3']); assert.equal(next.coverage.since, first.coverage.until);
  assert(!f.state.requests.at(-1).includes(String(seconds('2026-07-31T22:00:00Z'))));
  assert(next.limitations.some(value => /Alt-Mails/.test(value)));
});

test('an empty accessible mailbox is complete, unavailable native accounts are never an empty success', async () => {
  const f = fixture(); const page = await f.reader({ since: '2026-08-01', mode: 'initial-backfill' });
  assert.equal(page.complete, true); assert.equal(page.messages.length, 0);
  const unavailable = createOutlookMailboxReader({ assertHost: () => {}, execute: async () => { throw new Error('IVA_OUTLOOK_ACCOUNT_UNAVAILABLE native secret message'); } });
  await assert.rejects(unavailable({ since: '2026-08-01' }), error => error.code === 'OUTLOOK_NATIVE_MAILBOX_UNAVAILABLE' && error.complete === false && error.coverageVerified === false && !error.message.includes('secret'));
});

test('partial, duplicated, malformed and out-of-range metadata never advance coverage', async () => {
  const valid = native([['1', seconds('2026-09-15T12:00:00Z')]]);
  for (const value of [valid.replace('\t1\n', '\t2\n'), valid + '\n' + valid.split('\n')[1], valid.replace('IVA_END', ''), 'not-metadata']) assert.throws(() => parseFundingMailboxMetadata(value), error => error.coverageVerified === false);
  const reader = createOutlookMailboxReader({ assertHost: () => {}, execute: async () => native([['1', 1]]) });
  await assert.rejects(reader({ since: '2026-08-01' }), error => error.code === 'OUTLOOK_MAILBOX_INVALID_DATA');
});

test('account identity, cursor scope and original active-page range cannot silently change', async () => {
  const f = fixture([['1', seconds('2026-09-15T12:00:00Z')], ['2', seconds('2026-09-15T11:00:00Z')]]);
  const page = await f.reader({ since: '2026-08-01', limit: 1 });
  await assert.rejects(f.reader({ cursor: page.nextCursor, since: '2026-08-02' }), error => error.code === 'OUTLOOK_MAILBOX_BAD_CURSOR');
  f.state.accountId = '8';
  await assert.rejects(f.reader({ cursor: page.nextCursor }), error => error.code === 'OUTLOOK_MAILBOX_IDENTITY_CHANGED');
  await assert.rejects(f.reader({ from: 'other@example.test', since: '2026-08-01' }), error => error.code === 'OUTLOOK_MAILBOX_SCOPE_DENIED');
  await assert.rejects(f.reader({ cursor: 'malformed' }), error => error.code === 'OUTLOOK_MAILBOX_BAD_CURSOR');
});

test('initial scan requires a date and oversized batches or future ranges do not invoke Outlook', async () => {
  const f = fixture();
  for (const input of [{}, { since: '2026-08-01', limit: 999 }, { since: '2100-01-01' }, { since: '2026-02-31' }]) await assert.rejects(f.reader(input));
  assert.equal(f.state.requests.length, 0); assert.equal(f.state.hostChecks, 0);
});

test('Berlin date boundaries include August midnight and the correct DST transition midnight', async () => {
  const f = fixture();
  const summer = await f.reader({ since: '2026-08-01' }); assert.equal(summer.coverage.since, '2026-07-31T22:00:00.000Z');
  const spring = await f.reader({ since: '2026-03-29' }); assert.equal(spring.coverage.since, '2026-03-28T23:00:00.000Z');
  f.state.clock = Date.parse('2026-10-26T12:00:00Z');
  const autumn = await f.reader({ since: '2026-10-25' }); assert.equal(autumn.coverage.since, '2026-10-24T22:00:00.000Z');
});

test('pending native IDs can be reread directly after checkpoint advancement without rescanning August', async () => {
  const f = fixture([['99', seconds('2026-08-02T12:00:00Z'), 2, 'absender@example.test', 'Förderunterlagen Testkunde']]);
  const message = await f.message({ messageId: 'outlook:7:99' });
  assert.equal(message.messageId, 'outlook:7:99'); assert.equal(message.hasAttachments, true); assert.match(message.description, /Betreff: Förderunterlagen Testkunde/);
  assert.match(f.state.requests[0], /whose id is 99/); assert.doesNotMatch(f.state.requests[0], /whose time received/);
  await assert.rejects(f.message({ messageId: 'outlook:8:99' }), error => error.code === 'OUTLOOK_MAILBOX_IDENTITY_CHANGED');
  await assert.rejects(f.message({ messageId: 'outlook:7:100' }), error => error.code === 'OUTLOOK_MAILBOX_MESSAGE_NOT_FOUND');
});

test('native script reads metadata without activating, selecting, syncing, fetching bodies or changing read flags', () => {
  const script = buildFundingMailboxReadScript({ since: 1, until: 2 });
  assert.match(script, /every exchange account/); assert.match(script, /id of candidateMessage/); assert.match(script, /time received/);
  assert.doesNotMatch(script, /\b(?:activate|select|open|send|sync)\b|set is read|plain text content|content of|password|user name/i);
  assert.throws(() => buildFundingMailboxReadScript({ since: 1, until: 2, nativeId: '1 then send' }));
});
