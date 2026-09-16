import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyFundingDocumentName, assessExistingFundingDealFile } from '../local-mac-helper/funding-document-extractor.mjs';
import { buildFundingStageChecklist, decideFundingDealAction } from '../local-mac-helper/pipedrive-funding.mjs';
import { scanPipedriveFundingBoard } from '../local-mac-helper/funding-scan.mjs';
import { scanFundingMailbox } from '../local-mac-helper/funding-mail-scan.mjs';
import { renderFundingMissingDocumentsEmail } from '../local-mac-helper/funding.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'iva-funding-application-test-'));
process.env.IVA_MAC_HELPER_DATA_DIR = directory;
after(() => rm(directory, { recursive: true, force: true }));
const stage = 'Auftrag eingereicht / Förderunterlagen einreichen';
const evidence = Object.fromEntries(['signed_offer', 'identity_card', 'registration_certificate', 'land_register_notification', 'kfw_account_confirmation'].map(type => [type, 'present_in_pipedrive']));
const snapshot = { dealId: '123', customerName: 'Fixture Kunde', stage, orderNumber: 'HH-AB-123', customerEmail: 'fixture@example.test', phoneNumber: '0123456789', plant: 'Testanlage' };

test('notification remains a distinct application document even when its filename also mentions Grundbuch', () => {
  for (const name of ['Eintragungsbekanntmachung.pdf', 'Grundbuch-Eintragungsbekanntmachung.pdf', 'Eintragungs-Bekanntmachung.pdf']) {
    assert.equal(classifyFundingDocumentName(name).type, 'land_register_notification');
    assert.equal(assessExistingFundingDealFile({ fileName: name, contentAnalysis: { type: 'land_register_notification', textLayer: 'present' } }).compliant, true);
  }
  assert.equal(classifyFundingDocumentName('Grundbuchauszug.pdf').type, 'land_register');
});

test('application can advance with notification; absent, unverified and email-only evidence do not advance', () => {
  const decision = decideFundingDealAction(stage, { documentEvidence: evidence, snapshot });
  assert.equal(decision.moveAllowed, true);
  assert.equal(decision.requiredDocuments.some(item => item.id === 'land_register'), false);
  assert.deepEqual(decision.payoutOutstandingDocumentIds, ['land_register']);
  for (const status of ['missing', 'ambiguous', 'invalid', 'available_in_email']) {
    assert.equal(decideFundingDealAction(stage, { documentEvidence: { ...evidence, land_register_notification: status }, snapshot }).moveAllowed, false);
  }
  const both = decideFundingDealAction(stage, { documentEvidence: { ...evidence, land_register: 'present_in_pipedrive' }, snapshot });
  assert.deepEqual(both.payoutOutstandingDocumentIds, []);
  assert.equal(both.requiredDocuments.some(item => item.id === 'land_register'), true);
});

test('only explicit positive income request adds tax years and application checklist includes every source', () => {
  for (const incomeBonusRequested of [undefined, null, false, true]) {
    const checklist = buildFundingStageChecklist(stage, { incomeBonusRequested });
    assert.equal(checklist.requiredDocuments.filter(item => item.id.startsWith('tax_')).length, incomeBonusRequested === true ? 2 : 0);
    assert.match(checklist.scanSources.join(' '), /TMB/);
    assert.match(checklist.scanSources.join(' '), /Notizen/);
    assert.match(checklist.scanSources.join(' '), /E-Mails/);
  }
});

test('board and mailbox scans preserve notification evidence without pretending payout completeness', async () => {
  const files = ['Unterschriebenes Angebot.pdf', 'Personalausweis.pdf', 'Meldebescheinigung.pdf', 'Grundbuch-Eintragungsbekanntmachung.pdf', 'KfW-Konto.pdf'];
  const source = { ...snapshot, files, documents: files.map(classifyFundingDocumentName), fileRecords: files.map((name, i) => ({ id: String(i + 1), name, size: 100 })) };
  const report = await scanPipedriveFundingBoard({ persist: false,
    collectBoard: async () => ({ stages: { [stage]: [{ id: '123' }] } }),
    readDeals: async () => ({ requested: 1, read: 1, failed: 0, errors: [], snapshots: [source] }) });
  for (const result of [report, await scanFundingMailbox({ fundingScan: report, persist: false,
    detectMessages: async () => ({ messages: [], scanComplete: true, coverageVerified: true }) })]) {
    const item = result.cases[0];
    assert.deepEqual(item.missingBaseDocumentIds, []);
    assert.equal(item.requiredDocumentIds.includes('land_register_notification'), true);
    assert.equal(item.presentDocumentIds.includes('land_register'), false);
    assert.deepEqual(item.payoutOutstandingDocumentIds, ['land_register']);
    assert.equal(item.documentContentReviewRequired, true, 'filename inventory does not replace the full source review');
  }
});

test('missing application ownership request names the accepted alternative', () => {
  const mail = renderFundingMissingDocumentsEmail({ customerName: 'Fixture Kunde', customerEmail: 'fixture@example.test', vpEmail: 'vp@example.test', orderNumber: 'HH-AB-123', missingDocumentIds: ['land_register'] });
  assert.match(mail.body, /oder eindeutige Eintragungsbekanntmachung/);
});
