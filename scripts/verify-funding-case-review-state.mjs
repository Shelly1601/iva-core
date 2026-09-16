import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fundingDocumentReviewFingerprint, recordFundingCaseReview, scanPipedriveFundingBoard } from '../local-mac-helper/funding-scan.mjs';
import { assessFundingCaseReview, loadFundingCaseReviews } from '../local-mac-helper/funding-case-review-state.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'iva-funding-case-review-'));
process.env.IVA_MAC_HELPER_DATA_DIR = directory;
after(() => rm(directory, { recursive: true, force: true }));
const now = Date.now(), checkedAt = new Date(now - 1000).toISOString();
let serial = 0;
function fixture() {
  const snapshot = { dealId: String(++serial), stage: 'Auftrag eingereicht / Förderunterlagen einreichen', customerPersonId: '77', customerName: 'Fixture',
    orderNumber: 'HH-AB-1234', customerEmail: 'fixture@example.test', phoneNumber: null, plant: 'Fixture Anlage', noteCount: 1, latestNoteAt: checkedAt,
    fundingHandoffNotesFingerprint: 'a'.repeat(64), files: ['Ausweis.pdf'], documents: [{ type: 'identity_card', confidence: 1, fileName: 'Ausweis.pdf' }],
    fileRecords: [{ id: '55', name: 'Ausweis.pdf', size: 100, updatedAt: checkedAt }] };
  return { snapshot, review: {
    snapshotFingerprint: fundingDocumentReviewFingerprint(snapshot), reviewStatus: 'waiting_external', completeness: 'incomplete', checkedAt,
    identityVerified: true, sourceNotesChecked: true, sourceNotesFingerprint: snapshot.fundingHandoffNotesFingerprint, requiredFieldsChecked: true,
    mailEvidence: { checked: true, checkedAt, messageIds: ['<fixture@example.test>'], evidenceRef: 'fixture-mail-review.json' },
    files: [{ fileId: '55', status: 'reviewed', readable: true, identityVerified: true, checkedAt, evidenceRef: 'fixture-document-review.json' }],
    openPoints: [{ id: 'missing-phone', reason: 'Telefonnummer fehlt in den geprüften Quellen.', nextAction: 'Auf Kundenantwort mit Telefonnummer warten.' }], nextReviewAt: null,
  } };
}
async function saved(input) {
  await recordFundingCaseReview(input);
  return (await loadFundingCaseReviews()).deals[input.snapshot.dealId];
}
async function scan(snapshot, extra = {}) {
  return (await scanPipedriveFundingBoard({ persist: false, collectBoard: async () => ({ stages: { [snapshot.stage]: [{ id: snapshot.dealId }] } }),
    readDeals: async () => ({ requested: 1, read: 1, failed: 0, errors: [], snapshots: [snapshot] }), ...extra })).cases[0];
}

test('an unreviewed case stays visible; a checked incomplete case retains its blocker without daily PDF rereads', async () => {
  const input = fixture();
  assert.equal((await scan(input.snapshot)).reviewStatus, 'not_reviewed');
  assert.equal((await scan(input.snapshot)).documentContentReviewRequired, true);
  const receipt = await recordFundingCaseReview(input);
  assert.equal(receipt.handoffVerified, false);
  assert.equal(receipt.completeness, 'incomplete');
  const result = await scan(input.snapshot);
  assert.equal(result.requiredFieldsComplete, false);
  assert.equal(result.reviewStatus, 'reviewed_unchanged');
  assert.equal(result.documentContentReviewRequired, false);
  assert.equal(result.reviewRequired, false);
  assert.deepEqual(result.openPoints, input.review.openPoints);
});

test('changed note content is detected despite unchanged count/date, preserving unchanged file evidence', async () => {
  const input = fixture(), record = await saved(input);
  input.snapshot.fundingHandoffNotesFingerprint = 'b'.repeat(64);
  const result = assessFundingCaseReview(input.snapshot, record);
  assert.equal(result.sourceChanged, true);
  assert.equal(result.caseReviewRequired, true);
  assert.deepEqual(result.documentIdsRequiringReview, []);
  assert.equal(result.reusableDocumentEvidence.length, 1);
  input.review.snapshotFingerprint = fundingDocumentReviewFingerprint(input.snapshot);
  input.review.sourceNotesFingerprint = input.snapshot.fundingHandoffNotesFingerprint;
  input.review.files = [];
  await recordFundingCaseReview(input);
  assert.equal((await scan(input.snapshot)).reviewStatus, 'reviewed_unchanged');
});

test('a new or changed file requires its own proof while unchanged file proofs survive', async () => {
  const input = fixture(), record = await saved(input);
  input.snapshot.fileRecords.push({ id: '56', name: 'TMB.pdf', size: 300, updatedAt: checkedAt });
  assert.deepEqual(assessFundingCaseReview(input.snapshot, record).documentIdsRequiringReview, ['56']);
  input.review.snapshotFingerprint = fundingDocumentReviewFingerprint(input.snapshot);
  input.review.files = [];
  await assert.rejects(recordFundingCaseReview(input), /Dealdatei fehlt/);
  input.snapshot.fileRecords.pop();
  input.snapshot.fileRecords[0].updatedAt = new Date(now).toISOString();
  assert.deepEqual(assessFundingCaseReview(input.snapshot, record).documentIdsRequiringReview, ['55']);
});

test('identity changes invalidate document identity evidence', async () => {
  const input = fixture(), record = await saved(input);
  input.snapshot.customerPersonId = '88';
  assert.equal(assessFundingCaseReview(input.snapshot, record).reusableDocumentEvidence.length, 0);
  assert.deepEqual(assessFundingCaseReview(input.snapshot, record).documentIdsRequiringReview, ['55']);
});

test('new mail and a genuinely due action reopen a case without forcing unchanged PDF rereads', async () => {
  const input = fixture();
  input.review.nextReviewAt = new Date(now + 60_000).toISOString();
  const record = await saved(input);
  assert.equal(assessFundingCaseReview(input.snapshot, record, { now }).caseReviewRequired, false);
  assert.equal(assessFundingCaseReview(input.snapshot, record, { now: now + 60_001 }).reviewStatus, 'due');
  const result = await scan(input.snapshot, { changedDealIds: [input.snapshot.dealId] });
  assert.equal(result.changedByMail, true);
  assert.equal(result.reviewRequired, true);
  assert.equal(result.documentContentReviewRequired, false);
});

test('a recorded unreadable source remains blocked, not complete or newly unread every day', async () => {
  const input = fixture();
  input.review.files = [{ fileId: '55', status: 'blocked', checkedAt, evidenceRef: 'fixture-read-error.json', reason: 'Datei unlesbar.', nextAction: 'Neue Kopie anfordern.' }];
  const record = await saved(input);
  const assessment = assessFundingCaseReview(input.snapshot, record);
  assert.equal(assessment.caseReviewRequired, false);
  assert.equal(assessment.blockedDocumentEvidence.length, 1);
  input.review.completeness = 'complete';
  await assert.rejects(recordFundingCaseReview(input), /vollständig/);
});

test('unsupported completion, missing source review, stale fingerprint and mismatched file proof cannot enter the baseline', async () => {
  for (const alter of [
    input => { input.review.snapshotFingerprint = '0'.repeat(64); },
    input => { input.review.sourceNotesFingerprint = '0'.repeat(64); },
    input => { input.review.mailEvidence.checked = false; },
    input => { input.review.files[0].fileId = '99'; },
    input => { input.review.files[0].evidenceRef = ''; },
    input => { input.review.openPoints = []; },
    input => { input.review.completeness = 'complete'; },
  ]) {
    const input = fixture(); alter(input);
    await assert.rejects(recordFundingCaseReview(input));
    assert.equal((await loadFundingCaseReviews()).deals[input.snapshot.dealId], undefined);
  }
});

test('stored state contains separate source, review and completeness and no raw source bodies', async () => {
  const input = fixture(); input.snapshot.body = 'RAW PRIVATE BODY';
  const record = await saved(input);
  assert.equal(record.reviewStatus, 'waiting_external');
  assert.equal(record.completeness, 'incomplete');
  assert.equal(record.sourceState.notesFingerprint, input.snapshot.fundingHandoffNotesFingerprint);
  assert.doesNotMatch(await readFile(path.join(directory, 'funding-case-reviews.json'), 'utf8'), /RAW PRIVATE BODY/);
});
