import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  FUNDING_DOCUMENTS,
  FUNDING_PRIMARY_RECIPIENT_EMAIL,
  FUNDING_SENDER_EMAIL,
  FUNDING_SIGNATURE,
  buildFundingCaseReference,
  extractEmailAddress,
  firstNameFromContactName,
  renderFundingMissingDocumentsEmail,
  renderFundingSignatureHtml,
  renderFundingSignaturePlain,
  resolveFundingRecipients,
  withFundingSender,
} from '../local-mac-helper/funding.mjs';
import { buildDeleteDraftsAppleScript, buildDraftAppleScript, normalizeDraftPayload } from '../local-mac-helper/outlook.mjs';
import {
  FUNDING_BATCH_MODE,
  FUNDING_ROLLBACK_CONFIRMATION,
  FundingBatchService,
  attachFundingDraftMarker,
  buildFundingDraftMarker,
  createMemoryFundingStateStore,
} from '../local-mac-helper/funding-batches.mjs';
import {
  PIPEDRIVE_FUNDING_CONFIG,
  FUNDING_DOCUMENT_STATE,
  buildFundingStageChecklist,
  decideFundingDealAction,
  resolveFundingStage,
  validatePipedriveFundingSnapshot,
} from '../local-mac-helper/pipedrive-funding.mjs';
import {
  FUNDING_HANDOFF_RECIPIENT,
  buildFundingHandoffWhatsApp,
  normalizeWhatsAppPhone,
} from '../local-mac-helper/whatsapp-mac.mjs';
import {
  buildPipedriveFieldProposals,
  classifyFundingDocumentName,
  parseFundingDocumentPages,
} from '../local-mac-helper/funding-document-extractor.mjs';
import {
  PIPEDRIVE_FILE_POLICY,
  applyPipedriveFundingFieldUpdates,
  assertPipedriveFileActionAllowed,
} from '../local-mac-helper/chrome-pipedrive.mjs';
import { cleanupFundingWorkingCopy, stageFundingWorkingCopy } from '../local-mac-helper/local-working-files.mjs';

assert.equal(Object.keys(FUNDING_DOCUMENTS).length, 7);
assert.equal(FUNDING_SENDER_EMAIL, 'foerderung@heat-hero.com');
assert.equal(FUNDING_PRIMARY_RECIPIENT_EMAIL, 'p.germer@heat-hero.com');
assert.equal(FUNDING_SIGNATURE.email, 'n.sell@heat-hero.com');
assert.equal(FUNDING_SIGNATURE.website, 'https://www.heat-hero.com');
assert.equal(withFundingSender({}).from, FUNDING_SENDER_EMAIL);
assert.throws(() => withFundingSender({ from: 'privat@example.com' }), /ausschließlich/);
assert.equal(extractEmailAddress('holger@example.com (Büro)'), 'holger@example.com');
assert.equal(firstNameFromContactName('Herr Holger von Ameln'), 'Holger');
assert.equal(buildFundingCaseReference({ customerName: 'Max Mustermann', orderNumber: 'A-4711', location: 'Bremen' }).text, 'Max Mustermann - A-4711');
assert.equal(buildFundingCaseReference({ customerName: 'Max Mustermann', location: 'Bremen' }).text, 'Max Mustermann - Bremen');
assert.equal(buildFundingCaseReference({ customerName: 'Max Mustermann' }).text, 'Max Mustermann');
const namedRecipients = resolveFundingRecipients({ vpName: 'Holger von Ameln', vpEmail: 'holger@example.com (Büro)' });
assert.deepEqual(namedRecipients.to, ['p.germer@heat-hero.com']);
assert.deepEqual(namedRecipients.cc, ['holger@example.com']);
assert.equal(namedRecipients.greeting, 'Hallo Patrick, hallo Holger,');
const emailOnlyRecipients = resolveFundingRecipients({ vpName: 'vp@example.com' });
assert.deepEqual(emailOnlyRecipients.cc, ['vp@example.com']);
assert.equal(emailOnlyRecipients.greeting, 'Hallo Patrick,');
assert.throws(() => resolveFundingRecipients({ to: ['falsch@example.com'] }), /An-Feld ausschließlich/);
assert.throws(() => resolveFundingRecipients({ vpEmail: 'vp@example.com', cc: ['andere@example.com'] }), /stimmt nicht/);
const rendered = renderFundingMissingDocumentsEmail({
  customerName: 'Max Mustermann',
  orderNumber: 'A-4711',
  vpName: 'Maria',
  missingDocumentIds: ['signed_offer', 'identity_card'],
});
assert.equal(rendered.subject, 'Max Mustermann - A-4711 - fehlende Unterlagen');
assert.match(rendered.body, /^Hallo Patrick, hallo Maria,/);
assert.match(rendered.body, /Unterschriebenes Angebot/);
assert.match(rendered.body, /Personalausweis/);
assert.deepEqual(rendered.missingDocuments.map(item => item.id), ['signed_offer', 'identity_card']);
assert.doesNotMatch(rendered.body, /Zugangsdaten/);
assert.match(rendered.html, /<p>/);
assert.match(rendered.html, /<ul>/);
assert.match(rendered.html, /<li>Unterschriebenes Angebot<\/li>/);
assert.match(renderFundingSignaturePlain(), /Nadine Sell - Sales Operations Manager/);
assert.match(renderFundingSignatureHtml(), /data:image\/png;base64,/);
assert.match(rendered.html, /https:\/\/www\.heat-hero\.com/);
assert.doesNotMatch(rendered.html, /hornetsecurity|trendmicro/i);
assert.equal((rendered.body.match(/Nadine Sell - Sales Operations Manager/g) || []).length, 1);
assert.equal((rendered.html.match(/Nadine Sell - Sales Operations Manager/g) || []).length, 1);
const renderedWithoutOrder = renderFundingMissingDocumentsEmail({
  customerName: 'Erika Musterfrau',
  location: 'Bremen',
  missingDocumentIds: ['signed_offer'],
});
assert.equal(renderedWithoutOrder.subject, 'Erika Musterfrau - Bremen - fehlende Unterlagen');
assert.match(renderedWithoutOrder.body, /Ort: Bremen/);
assert.doesNotMatch(renderedWithoutOrder.body, /Angebots-\/Auftragsnummer:/);
const renderedNameOnly = renderFundingMissingDocumentsEmail({
  customerName: 'Erika Musterfrau',
  missingDocumentIds: ['signed_offer'],
});
assert.equal(renderedNameOnly.subject, 'Erika Musterfrau - fehlende Unterlagen');

assert.equal(PIPEDRIVE_FUNDING_CONFIG.pipeline, 'Auftragsmachbarkeit');
assert.equal(resolveFundingStage('Antrag eingereicht / Förderunterlagen einreichen').key, 'documents');
const documentsChecklist = buildFundingStageChecklist('Antrag eingereicht / Förderunterlagen einreichen', { incomeBonusRequested: true });
assert.equal(documentsChecklist.requiredDocuments.length, 7);
assert.equal(documentsChecklist.canCreateFinalDraftAutomatically, true);
const requestedChecklist = buildFundingStageChecklist('Förderung beantragt', { incomeBonusRequested: false });
assert.equal(requestedChecklist.stayInStage, true);
assert.equal(requestedChecklist.canCreateFinalDraftAutomatically, true);
const allBaseDocuments = Object.fromEntries([
  'signed_offer',
  'identity_card',
  'registration_certificate',
  'land_register',
  'kfw_account_confirmation',
].map(id => [id, FUNDING_DOCUMENT_STATE.presentInPipedrive]));
const moveDecision = decideFundingDealAction('Antrag eingereicht / Förderunterlagen einreichen', {
  incomeBonusRequested: false,
  documentEvidence: allBaseDocuments,
});
assert.equal(moveDecision.action, 'move_to_funding_requested');
assert.equal(moveDecision.moveAllowed, true);
assert.equal(moveDecision.targetStage, 'Förderung beantragt');
const uploadDecision = decideFundingDealAction('Antrag eingereicht / Förderunterlagen einreichen', {
  incomeBonusRequested: false,
  documentEvidence: { ...allBaseDocuments, identity_card: FUNDING_DOCUMENT_STATE.availableInEmail },
});
assert.equal(uploadDecision.action, 'upload_email_documents_then_recheck');
assert.equal(uploadDecision.moveAllowed, false);
const lockedDecision = decideFundingDealAction('Förderung beantragt', {
  incomeBonusRequested: false,
  documentEvidence: allBaseDocuments,
});
assert.equal(lockedDecision.action, 'keep_in_funding_requested');
assert.equal(lockedDecision.moveAllowed, false);
assert.equal(lockedDecision.stageLocked, true);
assert.equal(FUNDING_HANDOFF_RECIPIENT, 'Viktoria Lambel');
assert.equal(normalizeWhatsAppPhone('0151 23456789'), '+4915123456789');
assert.throws(() => buildFundingHandoffWhatsApp({
  customerName: 'Max Mustermann', orderNumber: 'A-4711', phone: '0151 23456789', decision: moveDecision,
}), /Verschiebung/);
const handoff = buildFundingHandoffWhatsApp({
  customerName: 'Max Mustermann',
  orderNumber: 'A-4711',
  phone: '0151 23456789',
  decision: moveDecision,
  stageTransitionVerified: true,
});
assert.equal(handoff.recipientName, 'Viktoria Lambel');
assert.equal(handoff.text, 'Max Mustermann - A-4711 ist fertig');
assert.match(handoff.url, /^whatsapp:\/\/send\?phone=4915123456789&text=/);
assert.equal(handoff.sent, false);
const lockedHandoff = buildFundingHandoffWhatsApp({
  customerName: 'Max Mustermann', orderNumber: 'A-4711', phone: '0151 23456789', decision: lockedDecision,
});
assert.equal(lockedHandoff.ready, true);
const fallbackHandoff = buildFundingHandoffWhatsApp({
  customerName: 'Erika Musterfrau', location: 'Bremen', phone: '0151 23456789', decision: lockedDecision,
});
assert.equal(fallbackHandoff.text, 'Erika Musterfrau - Bremen ist fertig');
assert.throws(() => buildFundingHandoffWhatsApp({
  customerName: 'Max Mustermann', orderNumber: 'A-4711', phone: '0151 23456789', decision: uploadDecision,
}), /noch nicht vollständig/);
assert.throws(() => validatePipedriveFundingSnapshot({ pipeline: 'Falsch', stage: 'Förderung beantragt' }), /Falsche/);
assert.equal(validatePipedriveFundingSnapshot({
  pipeline: 'Auftragsmachbarkeit',
  stage: 'Förderung beantragt',
  customerName: 'Max Mustermann',
  orderNumber: 'A-4711',
}).stage, 'Förderung beantragt');
assert.equal(validatePipedriveFundingSnapshot({
  pipeline: 'Auftragsmachbarkeit',
  stage: 'Förderung beantragt',
  customerName: 'Erika Musterfrau',
}).customerName, 'Erika Musterfrau');
assert.equal(PIPEDRIVE_FILE_POLICY.delete, false);
assert.equal(assertPipedriveFileActionAllowed('download'), true);
assert.throws(() => assertPipedriveFileActionAllowed('delete'), /unter keinen Umständen gelöscht/);

const localCleanupTestRoot = await mkdtemp(path.join(os.tmpdir(), 'iva-funding-local-cleanup-'));
try {
  const downloadsRoot = path.join(localCleanupTestRoot, 'Downloads');
  const workingRoot = path.join(localCleanupTestRoot, 'managed');
  await mkdir(downloadsRoot, { recursive: true });
  const downloadedPdf = path.join(downloadsRoot, 'Angebot_unterschrieben.pdf');
  await writeFile(downloadedPdf, '%PDF-1.4\nTestkopie');
  const workingCopy = await stageFundingWorkingCopy(downloadedPdf, {
    dealId: '8153',
    consumeDownloadedCopy: true,
    downloadsRoot,
    workingRoot,
  });
  await assert.rejects(access(downloadedPdf));
  await access(workingCopy.workingPath);
  const cleanupResult = await cleanupFundingWorkingCopy(workingCopy, { workingRoot });
  assert.equal(cleanupResult.localWorkingCopyDeleted, true);
  assert.equal(cleanupResult.pipedriveFileDeleted, false);
  await assert.rejects(access(workingCopy.jobDirectory));
  const outsidePdf = path.join(localCleanupTestRoot, 'nicht-download.pdf');
  await writeFile(outsidePdf, '%PDF-1.4\nKein Download');
  await assert.rejects(
    stageFundingWorkingCopy(outsidePdf, {
      consumeDownloadedCopy: true,
      downloadsRoot,
      workingRoot,
    }),
    /ausschließlich.*Downloads-Ordner/,
  );
} finally {
  await rm(localCleanupTestRoot, { recursive: true, force: true });
}

const documentAnalysis = parseFundingDocumentPages([
  `Kundendaten\nAuftragsnummer: HH-AN-7-26-10926\nKundennummer: KD-8821\nTelefonnummer: +49 174 1234567\nSol-HEAT Wärmepumpenpaket 16kW - PANASONIC M-Serie T-CAP WH-WXG16ME8`,
], { sourceFile: 'Unterschriebenes Angebot.pdf' });
assert.equal(documentAnalysis.fields.orderNumber.value, 'HH-AN-7-26-10926');
assert.equal(documentAnalysis.fields.customerNumber.value, 'KD-8821');
assert.equal(documentAnalysis.fields.phoneNumber.value, '+49 174 1234567');
assert.equal(documentAnalysis.fields.plant.value, 'Panasonic 16 kW');
assert.equal(documentAnalysis.fields.plant.model, 'WH-WXG16ME8');
assert.equal(documentAnalysis.fields.orderNumber.page, 1);
const fieldProposals = buildPipedriveFieldProposals({
  dealId: '399', customerName: 'Erika Musterfrau', orderNumber: null, customerNumber: 'KD-8821', phoneNumber: '0421 123456',
}, documentAnalysis);
assert.equal(fieldProposals.proposals.find(item => item.field === 'orderNumber').action, 'propose_fill');
assert.equal(fieldProposals.proposals.find(item => item.field === 'customerNumber').action, 'already_equal');
assert.equal(fieldProposals.proposals.find(item => item.field === 'phoneNumber').action, 'conflict');
assert.equal(fieldProposals.proposals.find(item => item.field === 'plant').action, 'propose_fill');
assert.equal(fieldProposals.mutated, false);
const ambiguousAnalysis = parseFundingDocumentPages([
  'Auftragsnummer: HH-AN-7-26-10926\nAuftragsnummer: HH-AN-7-26-10927',
], { sourceFile: 'Doppelt.pdf' });
assert.equal(ambiguousAnalysis.fields.orderNumber.status, 'ambiguous');
const scannedAnalysis = parseFundingDocumentPages([''], { sourceFile: 'Scan.pdf' });
assert.equal(scannedAnalysis.textLayer, 'ocr_required');
assert.equal(scannedAnalysis.fields.orderNumber.status, 'ocr_required');
const ocrColumnAnalysis = parseFundingDocumentPages([
  'HH- Angebots-Nr. Michael Toleikis AN-7-26-11047 Ihre Kundennummer 17813 Telefonnummer +49 176 65393009 Tel. +49 421 40885180 Warmepumpenpaket 16kW - PANASONIC WH-WXG16ME8',
], { sourceFile: 'Angebot_unterschrieben.pdf' });
assert.equal(ocrColumnAnalysis.fields.orderNumber.value, 'HH-AN-7-26-11047');
assert.notEqual(ocrColumnAnalysis.fields.orderNumber.value, 'Michael');
assert.equal(ocrColumnAnalysis.fields.phoneNumber.value, '+49 176 65393009');
assert.equal(classifyFundingDocumentName('Angebot_unterschrieben.pdf').type, 'signed_offer');
assert.equal(classifyFundingDocumentName('Angebot WP unterschr. Hensche, Klaus.pdf').type, 'signed_offer');
assert.equal(classifyFundingDocumentName('MeldeBesch_Ratz.pdf').type, 'registration_certificate');
assert.equal(classifyFundingDocumentName('04339038_GBA_Lehrte.pdf').type, 'land_register');
assert.equal(classifyFundingDocumentName('THBMoreApp.pdf').type, 'technical_feasibility');
assert.equal(classifyFundingDocumentName('TMB Michael.pdf').type, 'technical_feasibility');
assert.equal(classifyFundingDocumentName('Registration.pdf').type, 'technical_feasibility');
await assert.rejects(
  applyPipedriveFundingFieldUpdates({ dealId: '399', fieldProposals, confirmApply: false }),
  /confirmApply=true/,
);
assert.equal((await applyPipedriveFundingFieldUpdates({
  dealId: '399', fieldProposals: { proposals: [] }, confirmApply: true,
})).mutated, false);

const draft = normalizeDraftPayload({
  subject: rendered.subject,
  body: rendered.body,
  html: rendered.html,
  to: ['VP@example.com', 'vp@example.com'],
  from: 'foerderung@heat-hero.com',
});
assert.deepEqual(draft.to, ['vp@example.com']);
assert.equal(draft.from, 'foerderung@heat-hero.com');

const built = buildDraftAppleScript(draft);
assert.match(built.script, /make new outgoing message at targetDrafts/);
assert.match(built.script, /content:/);
assert.match(built.script, /senderAccount is missing value then error/);
assert.match(built.script, /make new to recipient/);
assert.doesNotMatch(built.script, /send draftMessage/);
assert.throws(() => renderFundingMissingDocumentsEmail({ customerName: 'Test', orderNumber: '1', missingDocumentIds: [] }), /keine Unterlagen/);
assert.throws(() => normalizeDraftPayload({ subject: 'Test', body: 'Text', to: ['falsch'] }), /ungültige E-Mail/);

const marker = buildFundingDraftMarker('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
const markedDraft = attachFundingDraftMarker(draft, marker);
assert.match(markedDraft.html, /IVA-FUNDING-DRAFT:11111111/);
assert.match(markedDraft.html, /display:none!important/);
const deleteScript = buildDeleteDraftsAppleScript({
  from: FUNDING_SENDER_EMAIL,
  entries: [{ marker, subject: draft.subject }],
});
assert.match(deleteScript.script, /targetDrafts to drafts of senderAccount/);
assert.match(deleteScript.script, /every outgoing message of targetDrafts/);
assert.match(deleteScript.script, /delete item 1 of matchesForMarker/);
assert.doesNotMatch(deleteScript.script, /sent items|inbox/i);

function fundingDraftForBatch(input) {
  const renderedEmail = renderFundingMissingDocumentsEmail(withFundingSender(input));
  return normalizeDraftPayload({
    subject: renderedEmail.subject,
    body: renderedEmail.body,
    html: renderedEmail.html,
    to: renderedEmail.recipients.to,
    cc: renderedEmail.recipients.cc,
    from: FUNDING_SENDER_EMAIL,
  });
}

const batchStore = createMemoryFundingStateStore();
const createdDrafts = [];
const deleteCalls = [];
const batchService = new FundingBatchService({
  store: batchStore,
  renderDraft: fundingDraftForBatch,
  createDraft: async createdDraft => {
    createdDrafts.push(createdDraft);
    return { created: true, channel: 'test', sent: false };
  },
  deleteDrafts: async input => {
    deleteCalls.push(input);
    return {
      deletedMarkers: input.entries.map(entry => entry.marker),
      missingMarkers: [],
      recoverableFromDeletedItems: true,
    };
  },
});
const batchCases = [
  { customerName: 'Fall Eins', orderNumber: 'HH-1', missingDocumentIds: ['signed_offer'] },
  { customerName: 'Fall Zwei', orderNumber: 'HH-2', missingDocumentIds: ['identity_card'] },
];
const previewBatch = batchService.preview(batchCases);
assert.equal(previewBatch.mode, FUNDING_BATCH_MODE);
assert.equal(previewBatch.sendEnabled, false);
assert.equal(previewBatch.pipedriveMutationEnabled, false);
assert.equal(createdDrafts.length, 0);
const createdBatchResult = await batchService.create(batchCases);
assert.equal(createdBatchResult.complete, true);
assert.equal(createdBatchResult.batch.status, 'created');
assert.equal(createdBatchResult.batch.summary.created, 2);
assert.equal(createdDrafts.length, 2);
assert.ok(createdDrafts.every(createdDraft => createdDraft.html.includes('IVA-FUNDING-DRAFT:')));
assert.ok(createdDrafts.every(createdDraft => createdDraft.from === FUNDING_SENDER_EMAIL));
await assert.rejects(batchService.rollback(createdBatchResult.batch.id, 'ja, bitte'), /exakt/);
assert.equal(deleteCalls.length, 0);
const rollbackResult = await batchService.rollback(createdBatchResult.batch.id, FUNDING_ROLLBACK_CONFIRMATION);
assert.equal(rollbackResult.batch.status, 'rolled_back');
assert.equal(rollbackResult.batch.rollback.deleted, 2);
assert.equal(deleteCalls.length, 1);
assert.equal(deleteCalls[0].from, FUNDING_SENDER_EMAIL);
assert.deepEqual(deleteCalls[0].entries.map(entry => entry.subject), [
  'Fall Eins - HH-1 - fehlende Unterlagen',
  'Fall Zwei - HH-2 - fehlende Unterlagen',
]);
const idempotentRollback = await batchService.rollback(createdBatchResult.batch.id, FUNDING_ROLLBACK_CONFIRMATION);
assert.equal(idempotentRollback.idempotent, true);
assert.equal(deleteCalls.length, 1);

const partialStore = createMemoryFundingStateStore();
let partialCreateCount = 0;
const partialDeleteCalls = [];
const partialService = new FundingBatchService({
  store: partialStore,
  renderDraft: fundingDraftForBatch,
  createDraft: async () => {
    partialCreateCount += 1;
    if (partialCreateCount === 2) throw new Error('Testfehler in Outlook');
    return { created: true, channel: 'test' };
  },
  deleteDrafts: async input => {
    partialDeleteCalls.push(input);
    return { deletedMarkers: input.entries.map(entry => entry.marker), recoverableFromDeletedItems: true };
  },
});
const partial = await partialService.create(batchCases);
assert.equal(partial.complete, false);
assert.equal(partial.batch.status, 'partial');
assert.equal(partial.batch.summary.created, 1);
assert.equal(partial.batch.summary.failed, 1);
const partialRollback = await partialService.rollback('last', FUNDING_ROLLBACK_CONFIRMATION);
assert.equal(partialRollback.batch.status, 'rolled_back');
assert.equal(partialDeleteCalls[0].entries.length, 1);
assert.throws(() => batchService.preview([
  { customerName: 'Doppelt', orderNumber: 'HH-3', missingDocumentIds: ['signed_offer'] },
  { customerName: 'Doppelt', orderNumber: 'HH-3', missingDocumentIds: ['identity_card'] },
]), /Betreff.*mehrfach/);

console.log('PASS IVA Mac Helper: sichere Förder-Prüfläufe, Outlook-Entwürfe, Batch-Rückgängig und gesperrte Versand-/Pipedrive-Aktionen.');
