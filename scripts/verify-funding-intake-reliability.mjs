import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFundingIntakeStore, fundingIntakeMessageFingerprint, validateFundingIntakeReceipt } from '../local-mac-helper/funding-intake-state.mjs';
import { completeFundingMail, validateFundingMailCompletion } from '../local-mac-helper/funding-mail-completion.mjs';
import { assessRegistrationCertificateDate } from '../local-mac-helper/funding-document-pipeline.mjs';
import { buildFundingStageChecklist } from '../local-mac-helper/pipedrive-funding.mjs';
import { correlateFundingMessages, incomeBonusEvidence } from '../local-mac-helper/funding-mail-scan.mjs';
import { resolveFundingRecipients, resolveFundingNoResponseEscalationRecipient, renderFundingMissingDocumentsEmail, validateFundingSendEnvelope } from '../local-mac-helper/funding.mjs';
import { FUNDING_WORKFLOW_POLICY, buildFundingCalculationNote } from '../local-mac-helper/funding-workflows.mjs';
import { cleanupCompletedFundingReview, recordFundingReviewCompletion } from '../local-mac-helper/funding-local-cleanup.mjs';
import { saveFundingReview } from '../local-mac-helper/funding-review-queue.mjs';
import { detectNewFundingMessages } from '../local-mac-helper/funding-monitor-state.mjs';
import { scanPipedriveFundingBoard, recordFundingDocumentReview } from '../local-mac-helper/funding-scan.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'iva-funding-intake-test-'));
process.env.IVA_MAC_HELPER_DATA_DIR = directory;
after(() => rm(directory, { recursive: true, force: true }));
let serial = 0;
const freshStore = () => createFundingIntakeStore({ filePath: path.join(directory, `intake-${++serial}.json`) });
const message = (id = 'outlook:fixture:1') => ({ messageId: id, receivedAt: '2026-08-15T12:00:00Z', description: 'Betreff: Fixture, Nachrichtenvorschau: SECRET-NOT-TO-STORE', hasAttachments: true });
const page = (messages, extra = {}) => ({ messages, source: 'outlook-native', coverageVerified: true, complete: true, nextCursor: null, checkpoint: 'fixture-checkpoint', ...extra });
const receipt = (id = message().messageId) => ({ messageId: id, dealId: '12345', identityVerified: true, sourceReadComplete: true, expectedAttachmentCount: 2, attachmentProcessingVerified: true,
  uploadedFiles: [{ id: '99', filename: 'Personalausweis.pdf', dealId: '12345', verified: true }], textRelevant: true, note: { id: '31', dealId: '12345', verified: true }, verifiedAt: new Date(Date.now() - 1000).toISOString() });

test('old legible registration certificates have no maximum age', () => {
  assert.equal(assessRegistrationCertificateDate('Ausgestellt am 25.04.2023', new Date('2026-09-15T12:00:00Z')).status, 'valid');
  assert.equal(assessRegistrationCertificateDate('Ausgestellt am 25.04.2030', new Date('2026-09-15T12:00:00Z')).status, 'invalid');
});

test('only an explicit income bonus request adds tax documents; a preview cannot infer it', () => {
  for (const incomeBonusRequested of [undefined, null, false]) {
    const check = buildFundingStageChecklist('Förderung beantragen', { incomeBonusRequested });
    assert.equal(check.openQuestions.length, 0);
    assert.equal(check.requiredDocuments.some(item => item.id.startsWith('tax_')), false);
  }
  assert.equal(buildFundingStageChecklist('Förderung beantragen', { incomeBonusRequested: true }).requiredDocuments.filter(item => item.id.startsWith('tax_')).length, 2);
  assert.equal(incomeBonusEvidence('Steuerbescheid 2023 anbei'), null);
  assert.equal(incomeBonusEvidence('Einkommensbonus beantragt'), true);
  assert.equal(incomeBonusEvidence('Keinen Einkommensbonus beantragt'), false);
});

test('recipient routes use real VP CC and exact known supervisor mapping', () => {
  const data = { customerName: 'Fixture Kunde', customerEmail: 'kunde@example.com', vpName: 'Fixture VP', vpEmail: 'vp@example.com' };
  assert.deepEqual(resolveFundingRecipients(data).cc, ['vp@example.com']);
  assert.throws(() => resolveFundingRecipients({ ...data, cc: ['k.bolz@heat-hero.com'] }), /stimmt nicht/);
  assert.throws(() => resolveFundingRecipients({ customerEmail: data.customerEmail, cc: ['vp@example.com'] }), /stimmt nicht/);
  assert.equal(resolveFundingNoResponseEscalationRecipient({ salesStructure: 'EKD' }).email, 'k.bolz@heat-hero.com');
  assert.equal(resolveFundingNoResponseEscalationRecipient({ salesStructure: 'Direktvertrieb' }).email, 'n.zielinski@heat-hero.com');
  for (const salesStructure of ['SolLiving', 'SolHeat']) assert.equal(resolveFundingNoResponseEscalationRecipient({ salesStructure }).email, 'p.germer@heat-hero.com');
  assert.throws(() => resolveFundingNoResponseEscalationRecipient({ vpEmail: 'unknown@example.com' }), /nicht eindeutig/);
});

test('a ready send needs exact template plus customer, VP and source readback proof', () => {
  const input = { customerName: 'Fixture Kunde', customerEmail: 'kunde@example.com', vpEmail: 'vp@example.com', orderNumber: 'HH-12345', missingDocumentIds: ['identity_card'] };
  const rendered = renderFundingMissingDocumentsEmail(input);
  const prepared = { from: 'foerderung@heat-hero.com', ...rendered.recipients, subject: rendered.subject, body: rendered.body };
  const evidence = { sourceReviewComplete: true, identityVerified: true, pipedriveFilesReadbackVerified: true, pipedriveNotesReadbackVerified: true, customerAddressVerified: true, partnerAddressVerified: true };
  assert.equal(validateFundingSendEnvelope({ input, prepared, evidence }).requiresSentReadback, true);
  assert.throws(() => validateFundingSendEnvelope({ input, prepared: { ...prepared, cc: ['k.bolz@heat-hero.com'] }, evidence }), /stimmt nicht/);
  assert.throws(() => validateFundingSendEnvelope({ input, prepared, evidence: { ...evidence, partnerAddressVerified: false } }), /eindeutig belegt/);
  assert.equal(FUNDING_WORKFLOW_POLICY.noteSuffix, '(Notiz von Nadine)');
  assert.throws(() => buildFundingCalculationNote({ result: { noteSummary: 'Förderhöhe noch offen.', estimatedGrant: null } }), /noch nicht vollständig/);
  assert.match(buildFundingCalculationNote({ result: { canUseForFundingNote: true, eligibleCosts: 30000, estimatedGrant: 9000, noteSummary: '9.000 Euro Förderung.' } }), /^9.000 Euro Förderung\.[\s\S]*\(Notiz von Nadine\)$/);
});

test('mail correlation does not confuse number substrings or a surname-only hint with a customer', () => {
  const cases = [{ dealId: '1', customerName: 'Anna Muster', orderNumber: '1234' }, { dealId: '2', customerName: 'Bert Beispiel', orderNumber: '91234' }];
  assert.equal(correlateFundingMessages(cases, ['Betreff: Unterlagen 91234']).get('1').length, 0);
  assert.equal(correlateFundingMessages(cases, ['Betreff: Muster']).get('1').length, 0);
  assert.equal(correlateFundingMessages(cases, ['Betreff: Anna Muster']).get('1').length, 1);
});

test('backfill pages persist cursor and pending IDs atomically and survive restart', async () => {
  const filePath = path.join(directory, 'restart.json');
  let store = createFundingIntakeStore({ filePath });
  assert.equal((await store.begin({ mode: 'initial-backfill', since: '2026-08-01' })).cursor, null);
  await store.recordPage(page([message()], { complete: false, nextCursor: 'fixture-page-2', checkpoint: null }), { mode: 'initial-backfill', expectedCursor: null });
  store = createFundingIntakeStore({ filePath });
  const restarted = await store.begin({ mode: 'incremental' });
  assert.equal(restarted.mode, 'initial-backfill', 'daily run resumes unfinished backfill instead of scanning from scratch');
  assert.equal(restarted.cursor, 'fixture-page-2');
  assert.equal(restarted.pending.length, 1);
  await store.recordPage(page([message()]), { mode: 'initial-backfill', expectedCursor: 'fixture-page-2' });
  assert.equal((await store.status()).backfill.status, 'scanned');
  assert.equal((await store.status()).pending.length, 1);
  assert.doesNotMatch(await readFile(filePath, 'utf8'), /SECRET-NOT-TO-STORE|Nachrichtenvorschau/);
  assert.equal((await store.begin({ mode: 'initial-backfill' })).scanComplete, true);
});

test('completion requires upload and note readback plus verified folder move, then never scans Aug1 again', async () => {
  const store = freshStore();
  await store.begin({ mode: 'initial-backfill', since: '2026-08-01' });
  await store.recordPage(page([message()]), { mode: 'initial-backfill' });
  for (const override of [{ sourceReadComplete: false }, { identityVerified: false }, { uploadedFiles: [] }, { uploadedFiles: [{ id: '2', filename: 'Ausweis.pdf', dealId: '999', verified: true }] }, { note: { id: '1', dealId: '999', verified: true } }]) assert.throws(() => validateFundingIntakeReceipt({ ...receipt(), ...override }));
  await assert.rejects(store.completeMessage(receipt()), /Fertig/);
  await store.completeMessage({ ...receipt(), moveVerified: true });
  const duplicate = await store.begin({ mode: 'initial-backfill', since: '2026-08-01' });
  assert.equal(duplicate.mode, 'initial-backfill'); assert.equal(duplicate.scanComplete, true); assert.equal(duplicate.cursor, null);
  const next = await store.begin({ mode: 'incremental' });
  assert.equal(next.mode, 'incremental');
  assert.equal(next.since, null);
  assert.equal(next.cursor, 'fixture-checkpoint');
  assert.equal(next.pending.length, 0);
  await store.recordPage(page([message()], { checkpoint: 'fixture-next-checkpoint' }), { mode: 'incremental', expectedCursor: next.cursor });
  assert.equal((await store.status()).pending.length, 0, 'inclusive boundary message is not reprocessed');
});

test('unverified partial UI pages never advance cursor or falsely complete a backfill', async () => {
  const store = freshStore(); await store.begin({ mode: 'initial-backfill' });
  await assert.rejects(store.recordPage({ ...page([message()]), coverageVerified: false }, { mode: 'initial-backfill' }), /nicht belegt/);
  await assert.rejects(store.recordPage(page([message()], { complete: false, nextCursor: null }), { mode: 'initial-backfill' }), /Fortsetzungscursor/);
  assert.equal((await store.status()).messages.length, 0);
  assert.equal((await store.status()).backfill.status, 'running');
});

test('uncertain move is read back on retry and never blindly performed twice', async () => {
  const store = freshStore(); await store.begin({ mode: 'initial-backfill' }); await store.recordPage(page([message()]), { mode: 'initial-backfill' });
  let state = { completed: [], pendingMoves: [] }, calls = 0, saveCalls = 0;
  const deps = { intakeStore: store, resolveIdentity: async value => ({ ...value, description: 'Betreff: Fixture', identityVerified: true }), load: async () => structuredClone(state), save: async next => { if (++saveCalls === 2) throw new Error('fixture lost receipt save'); state = structuredClone(next); }, moveMessage: async () => { calls++; return { verifiedInDestination: true }; }, verifyMove: async () => ({ verifiedInDestination: true }) };
  const input = { receipt: receipt(), messageDescription: 'Betreff: Fixture' };
  assert.equal(validateFundingMailCompletion(input).messageFingerprint, fundingIntakeMessageFingerprint(message().messageId));
  await assert.rejects(completeFundingMail(input, deps), /fixture lost/);
  assert.equal((await store.status()).pending.length, 1);
  await completeFundingMail(input, deps);
  await completeFundingMail(input, deps);
  assert.equal(calls, 1);
  assert.equal((await store.status()).pending.length, 0);
});

test('managed temporary copies can be removed after upload readback without sending anything', async () => {
  const fingerprint = 'c'.repeat(64), incoming = path.join(directory, 'incoming', fingerprint);
  await mkdir(incoming, { recursive: true }); await writeFile(path.join(incoming, 'Ausweis.pdf'), 'fixture-only');
  await saveFundingReview({ messageFingerprint: fingerprint, dealId: '12345', downloaded: { directory: incoming } });
  await recordFundingReviewCompletion(fingerprint, { pipedriveUpload: { verified: true, dealId: '12345', files: ['Ausweis.pdf'] }, pendingManualReview: false });
  const result = await cleanupCompletedFundingReview(fingerprint);
  assert.equal(result.localFilesDeleted, true); assert.equal(result.emailDeleted, false); assert.equal(result.pipedriveFileDeleted, false);
  assert.equal((await cleanupCompletedFundingReview(fingerprint)).alreadyCompleted, true);
});

test('independent CLI processes complete different IDs without losing receipts', async () => {
  const filePath = path.join(directory, 'multi-process.json'), store = createFundingIntakeStore({ filePath });
  const messages = Array.from({ length: 5 }, (_, index) => message(`outlook:fixture:parallel-${index}`));
  await store.begin({ mode: 'initial-backfill' }); await store.recordPage(page(messages), { mode: 'initial-backfill' });
  const moduleUrl = new URL('../local-mac-helper/funding-intake-state.mjs', import.meta.url).href;
  await Promise.all(messages.map(item => promisify(execFile)(process.execPath, ['--input-type=module', '-e', `import {createFundingIntakeStore} from ${JSON.stringify(moduleUrl)}; await createFundingIntakeStore({filePath:${JSON.stringify(filePath)}}).completeMessage(${JSON.stringify({ ...receipt(item.messageId), moveVerified: true })});`], { timeout: 10000 })));
  const result = await store.status(); assert.equal(result.pending.length, 0); assert.equal(result.messages.length, 5); assert.equal(result.backfill.status, 'completed');
});

test('daily deal scan ignores offer history and skips PDF rereads only after verified review', async () => {
  const snapshot = { dealId: '100', stage: 'Förderung beantragen', customerName: 'Fixture', customerPersonId: '77', orderNumber: 'HH-AB-1234', documents: [{ type: 'identity_card', confidence: 1, fileName: 'Ausweis.pdf' }], files: ['Ausweis.pdf'], fileRecords: [{ id: '55', name: 'Ausweis.pdf', size: 100 }], noteCount: 1, latestNoteAt: '2026-09-01T10:00:00Z' };
  let requested;
  const dependencies = { persist: false, collectBoard: async () => ({ stages: { 'Angebot veröffentlicht': [{ id: '9999' }], 'Förderung beantragen': [{ id: '100' }], 'Auftrag eingereicht / Förderunterlagen einreichen': [] } }), readDeals: async ({ dealIds }) => { requested = dealIds; return { read: 1, failed: 0, requested: 1, errors: [], snapshots: [structuredClone(snapshot)] }; } };
  assert.equal((await scanPipedriveFundingBoard(dependencies)).cases[0].documentContentReviewRequired, true);
  assert.deepEqual(requested, ['100']);
  await recordFundingDocumentReview({ snapshot, review: { complete: true, sourceNotesChecked: true, files: [{ fileId: '55', readable: true, identityVerified: true }] } });
  assert.equal((await scanPipedriveFundingBoard(dependencies)).cases[0].documentContentReviewRequired, false);
  snapshot.fileRecords[0].id = '56';
  assert.equal((await scanPipedriveFundingBoard(dependencies)).cases[0].documentContentReviewRequired, true);
});

test('incremental never silently starts a full mailbox scan without a checkpoint', async () => {
  const store = freshStore();
  await assert.rejects(store.begin(), /einmalige Förder-Rücklauf/);
  await store.begin({mode: 'initial-backfill'});
  await assert.rejects(store.recordPage(page([], {checkpoint: null}), {mode:'initial-backfill'}), /Abschluss-Checkpoint/);
  assert.equal((await store.status()).backfill.status, 'running');
});

test('a matching UI description cannot complete a different Message-ID', async () => {
  const store = freshStore(); await store.begin({ mode: 'initial-backfill' }); await store.recordPage(page([message()]), { mode: 'initial-backfill' });
  let state = {completed: [], pendingMoves: []}, moves = 0;
  await assert.rejects(completeFundingMail({ receipt: receipt(), messageDescription: 'Betreff: Fixture' }, {
    intakeStore: store, load: async () => state, save: async next => {state=next;},
    resolveIdentity: async () => ({messageId: 'different-id', description: 'Betreff: Fixture', identityVerified: true}),
    moveMessage: async () => {moves++; return {verifiedInDestination: true};},
  }), /Message-ID/);
  assert.equal(moves, 0); assert.equal((await store.status()).pending.length, 1);
});

test('an unresolved old backfill mail does not starve new daily messages', async () => {
  const store = freshStore(); await store.begin({mode:'initial-backfill'});
  await store.recordPage(page([message()]), {mode:'initial-backfill'});
  assert.equal((await store.begin({mode:'initial-backfill'})).scanComplete, true);
  let run = await store.begin({mode:'incremental'});
  assert.equal(run.mode, 'incremental'); assert.equal(run.cursor, 'fixture-checkpoint'); assert.equal(run.pending.length, 1);
  await store.recordPage(page([message('outlook:fixture:new')], {checkpoint: 'new-checkpoint'}), {mode: 'incremental', expectedCursor:run.cursor});
  assert.equal((await store.status()).incremental.complete, true);
  const previousRunId = run.runId; run = await store.begin({mode:'incremental'});
  assert.equal(run.cursor, 'new-checkpoint'); assert.equal(run.pending.length, 2);
  assert.notEqual(run.runId, previousRunId);
  assert.equal((await store.status()).incremental.complete, false); assert.equal((await store.status()).incremental.scannedAt, null);
});

test('a temporarily unreadable old ID stays pending without stopping new mail discovery', async () => {
  const store = freshStore(); await store.begin({mode:'initial-backfill'});
  await store.recordPage(page([message()]), {mode:'initial-backfill'});
  const result = await detectNewFundingMessages({ intakeStore: store, filePath: path.join(directory, 'absent-monitor.json'),
    readPage: async () => page([message('outlook:fixture:new-readable')], {checkpoint:'latest-checkpoint'}),
    readMessage: async () => { throw new Error('fixture provider private content must not leak'); },
  });
  assert.equal(result.messages.length, 1); assert.equal(result.messages[0].messageId, 'outlook:fixture:new-readable');
  assert.equal(result.pendingReadErrors.length, 1); assert.equal((await store.status()).pending.length, 2);
  assert.equal(JSON.stringify(result).includes('private content'), false);
});

test('redelivering a completed one-time backfill performs no new mailbox page scan', async () => {
  const store=freshStore(); await store.begin({mode:'initial-backfill'});
  await store.recordPage(page([]), {mode:'initial-backfill'});
  let pageReads=0;
  const result=await detectNewFundingMessages({intakeStore:store,fundingRun:{mode:'initial-backfill',since:'2026-08-01'},filePath:path.join(directory,'missing-monitor-redelivery.json'),
    readPage:async()=>{pageReads++;throw new Error('must not scan');},readMessage:async()=>{throw new Error('no pending IDs');}});
  assert.equal(pageReads,0);assert.equal(result.scanComplete,true);assert.equal(result.fundingRun.mode,'initial-backfill');
});
