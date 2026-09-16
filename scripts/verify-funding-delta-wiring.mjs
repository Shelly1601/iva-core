import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runFundingMonitorOnce, processFundingMonitorMessage } from '../local-mac-helper/funding-monitor-runner.mjs';
import { scanFundingMailbox } from '../local-mac-helper/funding-mail-scan.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'iva-funding-delta-wiring-'));
process.env.IVA_MAC_HELPER_DATA_DIR = directory;
after(() => rm(directory, { recursive: true, force: true }));
const fixtureCase = { dealId: '123', customerName: 'Fixture Kunde', orderNumber: 'HH-AB-1234', stage: 'Auftrag eingereicht / Förderunterlagen einreichen', files: [],
  caseReviewRequired: false, sourceReviewRequired: false, reviewRequired: false, reviewStatus: 'reviewed_unchanged', documentContentReviewRequired: false };

test('monitor forwards verified changed deal IDs without inferring an association from a preview', async () => {
  let scanned;
  await runFundingMonitorOnce({}, {
    loadState: async () => ({ mode: 'review-only', emailSendEnabled: false, replyDraftsOnly: true }),
    checkStatus: async () => ({ ready: true }),
    detectMessages: async () => ({ source: 'outlook-native', newMessageCount: 1, changedDealIds: ['123'],
      messages: [{ messageId: '<new@example.test>', description: 'Betreff: Other Kunde HH-AB-9999' }] }),
    scanBoard: async input => { scanned = input; return { read: 1, cases: [fixtureCase] }; },
    processMessage: async () => ({ acknowledged: true }), auditLog: async () => {},
  });
  assert.deepEqual(scanned, { persist: true, changedDealIds: ['123'] });
});

test('mail scan reopens a known case on verified text-only mail and preserves unchanged PDF evidence', async () => {
  const report = await scanFundingMailbox({ persist: false, fundingScan: { cases: [fixtureCase] },
    detectMessages: async () => ({ changedDealIds: ['123'], messages: [{ messageId: '<known@example.test>', dealId: '123', description: 'Betreff: Neue Information ohne Kundennamen' }] }) });
  assert.deepEqual(report.changedDealIds, ['123']);
  assert.equal(report.cases[0].caseReviewRequired, true);
  assert.equal(report.cases[0].mailReviewRequired, true);
  assert.equal(report.cases[0].changedByMail, true);
  assert.equal(report.cases[0].documentContentReviewRequired, false);
});

test('a preview-only text match requests identity review but cannot become a verified deal change', async () => {
  const report = await scanFundingMailbox({ persist: false, fundingScan: { cases: [fixtureCase] },
    detectMessages: async () => ({ changedDealIds: [], messages: [{ messageId: '<unknown@example.test>', description: 'Betreff: Fixture Kunde, Keine Anlagen' }] }) });
  const result = report.cases[0];
  assert.deepEqual(report.changedDealIds, []);
  assert.equal(result.changedByMail, false);
  assert.equal(result.mailIdentityReviewRequired, true);
  assert.equal(result.caseReviewRequired, true);
  assert.equal(result.reviewStatus, 'mail_identity_review_required');
  assert.equal(result.documentContentReviewRequired, false);
});

test('changed source of an existing message queues one targeted review while keeping previous evidence', async () => {
  const fingerprint = 'c'.repeat(64), oldHash = 'a'.repeat(64), newHash = 'b'.repeat(64);
  let stored = { messageFingerprint: fingerprint, dealId: '123', sourceHash: oldHash, status: 'mail_text_review_required',
    updatedAt: new Date(Date.now() - 60000).toISOString(), documents: { outputs: [{ filename: 'Previously-verified.pdf' }] } };
  let writes = 0, downloads = 0;
  const dependencies = { reviewExists: async () => true, loadReview: async () => stored, saveReview: async value => { writes++; stored = value; }, acknowledge: async () => {},
    downloadUiAttachments: async () => { downloads++; }, downloadGraphAttachments: async () => { downloads++; } };
  const message = { fingerprint, sourceHash: newHash, resume: { reason: 'source_changed', evidenceFingerprint: newHash, at: new Date().toISOString() } };
  assert.equal((await processFundingMonitorMessage(message, { cases: [] }, dependencies)).status, 'targeted_review_required');
  assert.equal(stored.sourceHash, oldHash, 'the new source was not falsely marked as already inspected');
  assert.equal(stored.pendingReview.sourceHash, newHash);
  assert.equal(stored.documents.outputs[0].filename, 'Previously-verified.pdf');
  assert.equal((await processFundingMonitorMessage(message, { cases: [] }, dependencies)).status, 'already_queued');
  assert.equal(writes, 1); assert.equal(downloads, 0);
});

test('unchanged existing source is not requeued without a new verified resume event', async () => {
  const fingerprint = 'd'.repeat(64), sourceHash = 'a'.repeat(64);
  let writes = 0;
  const oldAt = new Date(Date.now() - 60000).toISOString();
  const dependencies = { reviewExists: async () => true, loadReview: async () => ({ messageFingerprint: fingerprint, sourceHash, updatedAt: oldAt }),
    saveReview: async () => { writes++; }, acknowledge: async () => {} };
  assert.equal((await processFundingMonitorMessage({ fingerprint, sourceHash }, { cases: [] }, dependencies)).status, 'already_queued');
  assert.equal(writes, 0);
  const resumed = { fingerprint, sourceHash, resume: { reason: 'blocker_resolved', evidenceFingerprint: 'e'.repeat(64), at: new Date().toISOString() } };
  assert.equal((await processFundingMonitorMessage(resumed, { cases: [] }, dependencies)).status, 'targeted_review_required');
  assert.equal(writes, 1);
});
