import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFundingIntakeStore, recordFundingMailWaitingReview, resumeFundingWaitingMessages, validateFundingMailWaitingReview } from '../local-mac-helper/funding-intake-state.mjs';
import { detectNewFundingMessages } from '../local-mac-helper/funding-monitor-state.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'iva-funding-mail-waiting-'));
after(() => rm(directory, { recursive: true, force: true }));
let serial = 0;
const message = (messageId = 'outlook:fixture:waiting', extra = {}) => ({ messageId, receivedAt: '2026-09-15T10:00:00Z', description: 'Betreff: Fixture, Nachrichtenvorschau: CONTENT-MUST-NOT-BE-STORED', hasAttachments: true, ...extra });
const page = (messages, checkpoint = 'checkpoint-next') => ({ source: 'outlook-native', coverageVerified: true, complete: true, nextCursor: null, checkpoint, messages });
const review = (extra = {}) => ({ messageId: message().messageId, dealId: '123', identityVerified: true, sourceReadComplete: true, attachmentReviewComplete: true,
  reviewComplete: true, technicalWorkPending: false, sideEffectsVerified: true, sourceHash: 'a'.repeat(64), reviewFingerprint: 'b'.repeat(64),
  openPoints: ['Ausstehende externe Rückmeldung'], nextAction: 'Neue Antwort dem vorhandenen Prüfstand zuordnen.', verifiedAt: new Date(Date.now() - 1000).toISOString(), ...extra });
async function setup({ now, messages = [message()] } = {}) {
  const filePath = path.join(directory, `intake-${++serial}.json`), intakeStore = createFundingIntakeStore({ filePath, ...(now ? { now } : {}) });
  await intakeStore.begin({ mode: 'initial-backfill' });
  await intakeStore.recordPage(page(messages, 'baseline-checkpoint'), { mode: 'initial-backfill' });
  return { filePath, intakeStore };
}
const detect = (intakeStore, options = {}) => detectNewFundingMessages({ intakeStore, filePath: path.join(directory, 'absent-monitor.json'), readPage: async () => page([]), ...options });

test('verified waiting mail stays pending but is not reopened on unchanged daily pages or restart', async () => {
  const { intakeStore, filePath } = await setup();
  await recordFundingMailWaitingReview(review(), { intakeStore });
  const restarted = createFundingIntakeStore({ filePath });
  let readCalls = 0;
  for (let index = 0; index < 2; index++) {
    const result = await detect(restarted, { readPage: async () => page([message(undefined, { sourceHash: 'a'.repeat(64) })], `next-${index}`), readMessage: async () => { readCalls++; throw new Error('must not reopen unchanged waiting mail'); } });
    assert.equal(result.messages.length, 0); assert.equal(result.deferredMessageCount, 1); assert.equal(result.pendingReadErrors.length, 0);
  }
  const saved = await restarted.status();
  assert.equal(readCalls, 0); assert.equal(saved.pending.length, 1); assert.equal(saved.actionablePending.length, 0);
  assert.equal(saved.messages[0].status, 'waiting'); assert.equal(saved.backfill.status, 'scanned');
  assert.doesNotMatch(await readFile(filePath, 'utf8'), /CONTENT-MUST-NOT-BE-STORED|Nachrichtenvorschau/);
});

test('new unrelated mail is processed while waiting mail is deferred and cursor advances', async () => {
  const { intakeStore } = await setup(); await intakeStore.recordWaitingReview(review());
  const fresh = message('outlook:fixture:new'); let readCalls = 0;
  const result = await detect(intakeStore, { readPage: async () => page([fresh], 'fresh-checkpoint'), readMessage: async () => { readCalls++; throw new Error('must not reopen'); } });
  assert.deepEqual(result.messages.map(item => item.messageId), [fresh.messageId]); assert.equal(readCalls, 0);
  assert.equal(result.deferredMessageCount, 1); assert.equal((await intakeStore.status()).incremental.checkpoint, 'fresh-checkpoint');
  assert.equal((await intakeStore.status()).pending.length, 2);
});

test('unreviewed pending and interrupted work are still read and cannot be hidden by weak waiting proof', async () => {
  const { intakeStore } = await setup();
  for (const override of [{ reviewComplete: false }, { sourceReadComplete: false }, { attachmentReviewComplete: false }, { identityVerified: false }, { technicalWorkPending: true }, { sideEffectsVerified: false }, { sourceHash: '' }, { reviewFingerprint: '' }, { openPoints: [] }, { nextAction: '' }]) {
    assert.throws(() => validateFundingMailWaitingReview(review(override)));
  }
  let readCalls = 0;
  const result = await detect(intakeStore, { readMessage: async () => { readCalls++; return message(); } });
  assert.equal(readCalls, 1); assert.equal(result.messages.length, 1); assert.equal(result.deferredMessageCount, 0);
});

test('a changed Originalmail hash resumes only that waiting mail', async () => {
  const other = message('outlook:fixture:other');
  const { intakeStore } = await setup({ messages: [message(), other] });
  await intakeStore.recordWaitingReview(review()); await intakeStore.recordWaitingReview(review({ messageId: other.messageId, dealId: '999' }));
  const result = await detect(intakeStore, { readPage: async () => page([message(undefined, { sourceHash: 'c'.repeat(64) })]), readMessage: async () => { throw new Error('page supplied current source'); } });
  assert.deepEqual(result.messages.map(item => item.messageId), [message().messageId]);
  assert.equal(result.messages[0].resume.reason, 'source_changed'); assert.equal(result.deferredMessageCount, 1);
  await assert.rejects(intakeStore.recordWaitingReview(review()), /geändert/);
});

test('verified dependency or blocker change resumes targeted mail and keeps the old review evidence', async () => {
  const { intakeStore } = await setup(); await intakeStore.recordWaitingReview(review());
  await assert.rejects(resumeFundingWaitingMessages({ dealId: '123', reason: 'source_changed', evidenceFingerprint: 'c'.repeat(64) }, { intakeStore }), /Änderungsbeleg/);
  const resumed = await resumeFundingWaitingMessages({ dealId: '123', reason: 'blocker_resolved', evidenceFingerprint: 'c'.repeat(64), verified: true }, { intakeStore });
  assert.equal(resumed.resumedCount, 1);
  await assert.rejects(intakeStore.recordWaitingReview(review()), /erneut verifiziert/);
  let calls = 0; const result = await detect(intakeStore, { readMessage: async () => { calls++; return message(); } });
  assert.equal(calls, 1); assert.equal(result.messages[0].waitingReview.reviewFingerprint, 'b'.repeat(64));
  assert.deepEqual(result.changedDealIds, ['123']);
});

test('only a genuinely due saved step resumes waiting work; daily checks do not invent a deadline', async () => {
  let timestamp = Date.now(); const { intakeStore } = await setup({ now: () => timestamp });
  await intakeStore.recordWaitingReview(review({ nextActionAt: new Date(timestamp + 60000).toISOString() }));
  await assert.rejects(intakeStore.resumeWaitingMessages({ messageId: message().messageId, reason: 'due_step', evidenceFingerprint: 'b'.repeat(64), verified: true }), /noch nicht fällig/);
  let calls = 0;
  assert.equal((await detect(intakeStore, { readMessage: async () => { calls++; return message(); } })).messages.length, 0);
  timestamp += 61000;
  const result = await detect(intakeStore, { readMessage: async () => { calls++; return message(); } });
  assert.equal(calls, 1); assert.equal(result.messages[0].resume.reason, 'due_step');
});

test('new mail with a verified matching deal wakes the waiting case without losing either ID', async () => {
  const { intakeStore } = await setup(); await intakeStore.recordWaitingReview(review());
  const fresh = message('outlook:fixture:related', { dealId: '123', dealIdentityVerified: true });
  let calls = 0;
  const result = await detect(intakeStore, { readPage: async () => page([fresh]), readMessage: async () => { calls++; return message(); } });
  assert.equal(calls, 1); assert.deepEqual(new Set(result.messages.map(item => item.messageId)), new Set([fresh.messageId, message().messageId]));
  assert.deepEqual(result.changedDealIds, ['123']); assert.equal(result.deferredMessageCount, 0);
});

test('a guessed deal association cannot wake an unrelated waiting mail or trigger a deal change', async () => {
  const { intakeStore } = await setup(); await intakeStore.recordWaitingReview(review());
  const result = await detect(intakeStore, { readPage: async () => page([message('outlook:fixture:unverified', { dealId: '123' })]), readMessage: async () => { throw new Error('must not reopen'); } });
  assert.equal(result.messages.length, 1); assert.equal(result.deferredMessageCount, 1); assert.deepEqual(result.changedDealIds, []);
});

test('completion still requires verified move and remains deduplicated', async () => {
  const { intakeStore } = await setup({ messages: [message(undefined, { hasAttachments: false })] });
  await intakeStore.recordWaitingReview(review());
  const completion = { messageId: message().messageId, dealId: '123', identityVerified: true, sourceReadComplete: true, expectedAttachmentCount: 0,
    textRelevant: true, note: { id: '1', dealId: '123', verified: true }, verifiedAt: review().verifiedAt };
  await assert.rejects(intakeStore.completeMessage(completion), /Fertig/);
  await intakeStore.completeMessage({ ...completion, moveVerified: true });
  await assert.rejects(intakeStore.recordWaitingReview(review()), /abgeschlossene/);
  const result = await detect(intakeStore, { readPage: async () => page([message()]), readMessage: async () => { throw new Error('must not reopen completed mail'); } });
  assert.equal(result.messages.length, 0); assert.equal((await intakeStore.status()).pending.length, 0);
});
