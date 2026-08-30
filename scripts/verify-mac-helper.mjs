import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  FUNDING_DOCUMENTS,
  FUNDING_ESCALATION_DELAY_DAYS,
  FUNDING_ESCALATION_RECIPIENTS,
  FUNDING_PRIMARY_RECIPIENT_EMAIL,
  FUNDING_SUPERVISORS,
  FUNDING_SENDER_EMAIL,
  FUNDING_SIGNATURE,
  buildFundingCaseReference,
  extractEmailAddress,
  firstNameFromContactName,
  renderFundingMissingDocumentsEmail,
  renderFundingMinorChildrenQuestionEmail,
  renderFundingNoResponseEscalationDraft,
  renderFundingSignatureHtml,
  renderFundingSignaturePlain,
  resolveFundingRecipients,
  resolveFundingNoResponseEscalationRecipient,
  resolveFundingSupervisor,
  withFundingSender,
} from '../local-mac-helper/funding.mjs';
import {
  FUNDING_WORKFLOW_NAMES,
  FUNDING_WORKFLOW_ORDER,
  FUNDING_WORKFLOW_POLICY,
  assertFundingWorkflowOrder,
  buildFundingCalculationNote,
  buildFundingSheetRow,
  isImacFundingHost,
  resolveFundingSheetColumns,
} from '../local-mac-helper/funding-workflows.mjs';
import { matchDirectSalesPartner } from '../local-mac-helper/direct-sales-roster.mjs';
import { buildDeleteDraftsAppleScript, buildDraftAppleScript, buildForwardDraftAppleScript, buildVerifiedSendAppleScript, normalizeDraftPayload } from '../local-mac-helper/outlook.mjs';
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
  assessExistingFundingDealFile,
  buildPipedriveFieldProposals,
  classifyFundingDocumentName,
  parseFundingDocumentPages,
} from '../local-mac-helper/funding-document-extractor.mjs';
import {
  IVA_PIPEDRIVE_NOTE_SIGNATURE,
  PIPEDRIVE_FILE_POLICY,
  activatePipedriveDealTab,
  applyPipedriveFundingFieldUpdates,
  assertPipedriveFileActionAllowed,
  renderPipedriveFundingInformationNote,
  resolvePipedriveFundingStageTransition,
} from '../local-mac-helper/chrome-pipedrive.mjs';
import { cleanupFundingWorkingCopy, stageFundingWorkingCopy } from '../local-mac-helper/local-working-files.mjs';
import { fundingMessageFingerprint, normalizeFundingMonitorState } from '../local-mac-helper/funding-monitor-state.mjs';
import { assessRegistrationCertificateDate, fundingDocumentPipelinePolicy } from '../local-mac-helper/funding-document-pipeline.mjs';
import { loadFundingReview, saveFundingReview } from '../local-mac-helper/funding-review-queue.mjs';
import { cleanupCompletedFundingReview, fundingLocalCleanupPolicy, recordFundingReviewCompletion } from '../local-mac-helper/funding-local-cleanup.mjs';
import { FUNDING_DONE_FOLDER, validateFundingMailCompletion } from '../local-mac-helper/funding-mail-completion.mjs';

assert.equal(Object.keys(FUNDING_DOCUMENTS).length, 7);
assert.equal(FUNDING_SENDER_EMAIL, 'foerderung@heat-hero.com');
assert.equal(FUNDING_PRIMARY_RECIPIENT_EMAIL, 'p.germer@heat-hero.com');
assert.equal(FUNDING_SUPERVISORS.ekd.email, 'f.bolz@heat-hero.com');
assert.equal(FUNDING_SUPERVISORS.direct_sales.email, 'n.zielinski@heat-hero.com');
assert.equal(FUNDING_SIGNATURE.email, 'n.sell@heat-hero.com');
assert.equal(FUNDING_SIGNATURE.website, 'https://www.heat-hero.com');
assert.equal(FUNDING_ESCALATION_DELAY_DAYS, 7);
assert.equal(FUNDING_ESCALATION_RECIPIENTS.ekd.email, 'k.bolz@heat-hero.com');
const dewarmtePdfMail = { from: 'n.sell@heat-hero.com', to: ['kunde@example.com'], subject: 'DeWarmte Materialliste', body: 'Anbei die Materialliste.', attachments: ['/tmp/DeWarmte_Materialliste.pdf'] };
assert.throws(() => buildVerifiedSendAppleScript(dewarmtePdfMail), /XLSX-Anlagen/);
const verifiedPdfSend = buildVerifiedSendAppleScript(dewarmtePdfMail, { allowedExtensions: ['.pdf'], attachmentLabel: 'PDF' });
assert.match(verifiedPdfSend.script, /PDF-Anlagen/);
assert.match(verifiedPdfSend.script, /send draftMessage/);
assert.equal(verifiedPdfSend.message.from, 'n.sell@heat-hero.com');
const migratedMonitor = normalizeFundingMonitorState({ version: 1, mode: 'draft-review', emailSendEnabled: false, replyDraftsOnly: true });
assert.equal(migratedMonitor.mode, 'review-only');
assert.equal(migratedMonitor.migratedFromMode, 'draft-review');
assert.equal(normalizeFundingMonitorState({ mode: 'draft-review', emailSendEnabled: true, replyDraftsOnly: true }).mode, 'draft-review');
assert.equal(normalizeFundingMonitorState({ mode: 'draft-review', emailSendEnabled: false, replyDraftsOnly: false }).mode, 'draft-review');
assert.equal(withFundingSender({}).from, FUNDING_SENDER_EMAIL);
let activationAttempts = 0;
let activationWaits = 0;
const activation = await activatePipedriveDealTab('7479', {
  run: async () => { activationAttempts += 1; return activationAttempts >= 3 ? 'activated' : 'missing'; },
  waitFn: async () => { activationWaits += 1; },
  timeoutMs: 5_000,
});
assert.deepEqual(activation, { dealId: '7479', activated: true });
assert.equal(activationAttempts, 3);
assert.equal(activationWaits, 2);
assert.throws(() => withFundingSender({ from: 'privat@example.com' }), /ausschließlich/);
assert.equal(extractEmailAddress('holger@example.com (Büro)'), 'holger@example.com');
assert.equal(firstNameFromContactName('Herr Holger von Ameln'), 'Holger');
assert.equal(buildFundingCaseReference({ customerName: 'Max Mustermann', orderNumber: 'A-4711', location: 'Bremen' }).text, 'Max Mustermann - A-4711');
assert.equal(buildFundingCaseReference({ customerName: 'Max Mustermann', location: 'Bremen' }).text, 'Max Mustermann - Bremen');
assert.equal(buildFundingCaseReference({ customerName: 'Max Mustermann' }).text, 'Max Mustermann');
const namedRecipients = resolveFundingRecipients({ customerName: 'Max Mustermann', customerEmail: 'max@example.com', vpName: 'Holger von Ameln', vpEmail: 'holger@example.com (Büro)', directSalesRoster: { members: [] } });
assert.deepEqual(namedRecipients.to, ['max@example.com']);
assert.deepEqual(namedRecipients.cc, ['holger@example.com']);
assert.equal(namedRecipients.greeting, 'Guten Tag Max Mustermann,');
const directRoster = { members: ['Mirwais Barak', 'Anton Roschnow', 'Katrin Müller'] };
assert.equal(matchDirectSalesPartner({ vpName: 'Mirwais Barak', vpEmail: 'm.barak@ekd-solar.de' }, directRoster).memberName, 'Mirwais Barak');
assert.equal(matchDirectSalesPartner({ vpEmail: 'a.roschnow@sol-living.de' }, directRoster).memberName, 'Anton Roschnow');
assert.equal(resolveFundingSupervisor({ fundingRoute: 'direct_sales', vpEmail: 'm.barak@ekd-solar.de' }).email, 'n.zielinski@heat-hero.com');
assert.equal(resolveFundingSupervisor({ vpEmail: 'external@ekd-solar.de', directSalesRoster: { members: [] } }).email, 'f.bolz@heat-hero.com');
assert.equal(resolveFundingSupervisor({ vpEmail: 'external@example.com', directSalesRoster: { members: [] } }).email, 'p.germer@heat-hero.com');
const emailOnlyRecipients = resolveFundingRecipients({ customerName: 'Max Mustermann', customerEmail: 'max@example.com', vpName: 'vp@example.com', directSalesRoster: { members: [] } });
assert.deepEqual(emailOnlyRecipients.cc, ['vp@example.com']);
assert.equal(emailOnlyRecipients.greeting, 'Guten Tag Max Mustermann,');
assert.throws(() => resolveFundingRecipients({ customerName: 'Max Mustermann' }), /Kunden-E-Mail-Adresse/);
assert.throws(() => resolveFundingRecipients({ customerName: 'Max Mustermann', customerEmail: 'max@example.com', to: ['falsch@example.com'] }), /An-Feld/);
assert.throws(() => resolveFundingRecipients({ customerName: 'Max Mustermann', customerEmail: 'max@example.com', vpEmail: 'vp@example.com', cc: ['andere@example.com'] }), /stimmt nicht/);
const rendered = renderFundingMissingDocumentsEmail({
  customerName: 'Max Mustermann',
  customerEmail: 'max@example.com',
  orderNumber: 'A-4711',
  vpName: 'Maria',
  missingDocumentIds: ['signed_offer', 'identity_card'],
});
assert.equal(rendered.subject, 'Max Mustermann - A-4711 - fehlende Unterlagen');
assert.match(rendered.body, /^Guten Tag Max Mustermann,/);
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
assert.throws(() => renderFundingMissingDocumentsEmail({
  customerName: 'Erika Musterfrau', customerEmail: 'erika@example.com', location: 'Bremen', missingDocumentIds: ['signed_offer'],
}), /Auftragsnummer/);
const childQuestion = renderFundingMinorChildrenQuestionEmail({
  customerName: 'Max Mustermann', customerEmail: 'max@example.com', orderNumber: 'A-4711', vpEmail: 'vp@example.com',
});
assert.deepEqual(childQuestion.recipients.to, ['max@example.com']);
assert.deepEqual(childQuestion.recipients.cc, ['vp@example.com']);
assert.match(childQuestion.body, /Kind unter 18 Jahren/);
assert.equal(resolveFundingNoResponseEscalationRecipient({ salesStructure: 'EKD' }).email, 'k.bolz@heat-hero.com');
assert.equal(resolveFundingNoResponseEscalationRecipient({ vpEmail: 'anna@ekd-solar.de' }).email, 'k.bolz@heat-hero.com');
assert.equal(resolveFundingNoResponseEscalationRecipient({ vpEmail: 'anna@beispiel.de' }).email, 'p.germer@heat-hero.com');
const escalationDraft = renderFundingNoResponseEscalationDraft({
  dealId: '7479', customerName: 'Max Mustermann', customerEmail: 'max@example.com', vpEmail: 'vp@ekd-solar.de',
  orderNumber: 'A-4711', requestSentAt: '2026-08-01T08:00:00Z', originalSubject: 'Max Mustermann - A-4711 - fehlende Unterlagen', responses: [],
}, new Date('2026-08-08T08:00:01Z'));
assert.deepEqual(escalationDraft.to, ['k.bolz@heat-hero.com']);
assert.equal(escalationDraft.draftOnly, true);
assert.equal(escalationDraft.sent, false);
assert.match(escalationDraft.subject, /^WG:/);
const escalationForward = buildForwardDraftAppleScript(escalationDraft, new Date('2026-08-27T09:00:00+02:00'));
assert.match(escalationForward.script, /forward originalMessage to requestedRecipient opening window false/);
assert.match(escalationForward.script, /save forwardedMessage/);
assert.doesNotMatch(escalationForward.script, /send forwardedMessage/);
assert.equal(escalationForward.forward.to[0], 'k.bolz@heat-hero.com');
assert.equal(escalationForward.forward.originalSubject, 'Max Mustermann - A-4711 - fehlende Unterlagen');
assert.deepEqual(escalationForward.forward.sourceRecipients, ['max@example.com', 'vp@ekd-solar.de']);
assert.throws(() => renderFundingNoResponseEscalationDraft({
  dealId: '7479', customerName: 'Max Mustermann', customerEmail: 'max@example.com', vpEmail: 'vp@example.com',
  orderNumber: 'A-4711', requestSentAt: '2026-08-01T08:00:00Z', originalSubject: 'Fehlende Unterlagen',
  responses: [{ senderEmail: 'max@example.com', receivedAt: '2026-08-05T09:00:00Z' }],
}, new Date('2026-08-09T08:00:00Z')), /reagiert/);

assert.equal(PIPEDRIVE_FUNDING_CONFIG.pipeline, 'Auftragsmachbarkeit');
assert.equal(resolveFundingStage('Angebot veröffentlicht').key, 'offerPublished');
const offerChecklist = buildFundingStageChecklist('Angebot veröffentlicht');
assert.deepEqual(offerChecklist.requiredDocuments.map(item => item.id), ['signed_offer']);
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
const offerMoveDecision = decideFundingDealAction('Angebot veröffentlicht', {
  documentEvidence: { signed_offer: FUNDING_DOCUMENT_STATE.presentInPipedrive },
});
assert.equal(offerMoveDecision.action, 'move_to_documents');
assert.equal(offerMoveDecision.targetStage, 'Antrag eingereicht / Förderunterlagen einreichen');
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
assert.equal(handoff.text, 'Max Mustermann A-4711 fertig');
assert.match(handoff.url, /^whatsapp:\/\/send\?phone=4915123456789&text=/);
assert.equal(handoff.sent, false);
const lockedHandoff = buildFundingHandoffWhatsApp({
  customerName: 'Max Mustermann', orderNumber: 'A-4711', phone: '0151 23456789', decision: lockedDecision,
});
assert.equal(lockedHandoff.ready, true);
assert.throws(() => buildFundingHandoffWhatsApp({
  customerName: 'Erika Musterfrau', location: 'Bremen', phone: '0151 23456789', decision: lockedDecision,
}), /Auftragsnummer fehlt/);
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
assert.deepEqual(assessExistingFundingDealFile({
  fileName: 'Personalausweis Vorder- und Rueckseite - A-4711.pdf',
  contentAnalysis: { document: { type: 'identity_card' }, textLayer: 'readable', ocr: { failedPages: [] } },
  render: { visuallyRenderable: true },
}), {
  fileName: 'Personalausweis Vorder- und Rueckseite - A-4711.pdf',
  type: 'identity_card', isPdf: true, namingCompliant: true, contentChecked: true, contentMatches: true, readable: true,
  compliant: true, action: 'keep', reasons: [], deleteOriginalFromPipedrive: false, deleteManagedLocalCopyAfterVerifiedUpload: false,
});
const malformedExistingFile = assessExistingFundingDealFile({ fileName: 'Perso.jpg' });
assert.equal(malformedExistingFile.action, 'download_correct_reupload');
assert.equal(malformedExistingFile.deleteOriginalFromPipedrive, false);
assert.equal(malformedExistingFile.deleteManagedLocalCopyAfterVerifiedUpload, true);
const genericallyNamedExistingFile = assessExistingFundingDealFile({
  fileName: 'Scan 001.pdf',
  contentAnalysis: { document: { type: 'land_register' }, textLayer: 'native', ocr: { failedPages: [] } },
  render: { visuallyRenderable: true },
});
assert.equal(genericallyNamedExistingFile.type, 'land_register');
assert.equal(genericallyNamedExistingFile.action, 'download_correct_reupload');
assert.deepEqual(genericallyNamedExistingFile.reasons, ['label_not_compliant']);
assert.equal(assertPipedriveFileActionAllowed('download'), true);
assert.throws(() => assertPipedriveFileActionAllowed('delete'), /unter keinen Umständen gelöscht/);
const kfwInformationNote = renderPipedriveFundingInformationNote({
  heading: '✅ KfW-Konto erfolgreich geprüft',
  details: [
    { label: 'E-Mail-Adresse', value: 'kunde@example.com' },
    { label: 'Status', value: 'Login funktioniert; anschließend abgemeldet' },
  ],
});
assert.match(kfwInformationNote.content, /E-Mail-Adresse/);
assert.match(kfwInformationNote.content, /Login funktioniert/);
assert.match(kfwInformationNote.content, /\(Notiz von Nadine via KI\)<\/p>$/);
assert.equal(IVA_PIPEDRIVE_NOTE_SIGNATURE, '(Notiz von Nadine via KI)');
assert.deepEqual(resolvePipedriveFundingStageTransition({
  fromStage: 'Auftrag eingereicht / Förderunterlagen einreichen',
  toStage: 'Förderung beantragen',
}), {
  fromKey: 'documents',
  toKey: 'fundingRequested',
  fromLabel: 'Antrag eingereicht / Förderunterlagen einreichen',
  toLabel: 'Förderung beantragt',
  fromAliases: PIPEDRIVE_FUNDING_CONFIG.stages.documents.aliases,
  toAliases: PIPEDRIVE_FUNDING_CONFIG.stages.fundingRequested.aliases,
});
assert.throws(() => resolvePipedriveFundingStageTransition({
  fromStage: 'Angebot veröffentlicht',
  toStage: 'Förderung beantragen',
}), /Nicht freigegebener/);
assert.doesNotMatch(kfwInformationNote.content, /<p>\(Notiz von Nadine\)<\/p>$/);
assert.doesNotMatch(kfwInformationNote.content, /IVA-(?:FUNDING|KFW)-/);
assert.throws(() => renderPipedriveFundingInformationNote({
  heading: 'KfW-Kontobestätigung',
  details: [{ label: 'Passwort', value: 'NurEinTest123!' }, { label: 'Status', value: 'geprüft' }],
}), /niemals in einer Pipedrive-Notiz/);
assert.throws(() => renderPipedriveFundingInformationNote({
  heading: 'KfW-Kontobestätigung',
  details: [{ label: 'E-Mail-Adresse', value: 'kunde@example.com' }],
}), /Login-Prüfstatus/);
const stableMailDescription = 'Unterhaltung, 2 Mitteilungen, Absender: Max Beispiel, Betreff: Förderunterlagen A-4711, Neueste Nachricht: 09.08.26, Hat Dateien, Nachrichtenvorschau: Anbei die Unterlagen';
const changedMailPreview = 'Unterhaltung, 2 Mitteilungen, Absender: Max Beispiel, Betreff: Förderunterlagen A-4711, Geantwortet Neueste Nachricht: 09.08.26, Hat Dateien, Nachrichtenvorschau: Andere dynamische Vorschau';
assert.equal(fundingMessageFingerprint(stableMailDescription), fundingMessageFingerprint(changedMailPreview));
assert.notEqual(fundingMessageFingerprint(stableMailDescription), fundingMessageFingerprint(stableMailDescription.replace('2 Mitteilungen', '3 Mitteilungen')));
assert.equal(assessRegistrationCertificateDate('Hamburg, den 25.07.2026', new Date('2026-08-10T12:00:00Z')).status, 'valid');
assert.equal(assessRegistrationCertificateDate('Ausgestellt am 25.04.2023', new Date('2026-08-10T12:00:00Z')).status, 'invalid');
assert.equal(assessRegistrationCertificateDate('Kein Datum lesbar', new Date('2026-08-10T12:00:00Z')).status, 'manual_review');
assert.equal(fundingDocumentPipelinePolicy().identityFrontBackCombined, true);
assert.equal(fundingDocumentPipelinePolicy().differentDocumentTypesRemainSeparate, true);
assert.deepEqual(FUNDING_WORKFLOW_ORDER, ['completeness', 'amount', 'approval']);
assert.equal(FUNDING_WORKFLOW_NAMES.completeness, 'Förderung 1 – Vollständigkeit & Unterlagen');
assert.equal(FUNDING_WORKFLOW_POLICY.executionHost, 'imac-nadine');
assert.equal(FUNDING_WORKFLOW_POLICY.emailMode, 'draft-only');
assert.equal(FUNDING_WORKFLOW_POLICY.deletePipedrive, false);
assert.equal(FUNDING_WORKFLOW_POLICY.deleteManagedLocalCopiesAfterVerifiedReplacement, true);
assert.equal(FUNDING_WORKFLOW_POLICY.emptyWholeUserTrash, false);
assert.equal(FUNDING_WORKFLOW_POLICY.noteSuffix, '(Notiz von Nadine via KI)');
assert.equal(FUNDING_WORKFLOW_POLICY.processedMailFolder, 'fertig');
assert.equal(assertFundingWorkflowOrder(), true);
assert.throws(() => assertFundingWorkflowOrder(['amount', 'completeness', 'approval']), /Reihenfolge/);
assert.equal(isImacFundingHost('iMac-von-Nadine.local'), true);
assert.equal(isImacFundingHost('MacBook-Air-von-Nadine.local'), false);
assert.deepEqual(buildFundingSheetRow({ customerName: 'Max Mustermann', date: '2026-08-26T12:00:00+02:00' }), {
  Kundename: 'Max Mustermann', Datum: '26.08.2026', Bemerkung: '',
});
assert.deepEqual(resolveFundingSheetColumns(['✓', 'Kundename', 'Datum', 'Bemerkung']), {
  customerName: 1, date: 2, remark: 3,
  headers: { customerName: 'Kundename', date: 'Datum', remark: 'Bemerkung' },
});
assert.deepEqual(resolveFundingSheetColumns(['✓', 'Kundename', 'Bemerkung', 'Datum']), {
  customerName: 1, date: 3, remark: 2,
  headers: { customerName: 'Kundename', date: 'Datum', remark: 'Bemerkung' },
});
assert.equal(resolveFundingSheetColumns(['Name', 'Datum', 'Bemerkung']).customerName, 0);
assert.throws(() => resolveFundingSheetColumns(['✓', 'Kundename', 'Bemerkung']), /Spalte „Datum“ fehlt/);
const mfhNote = buildFundingCalculationNote({
  result: { units: 2, estimatedGrant: 15_580, eligibleCosts: 41_000, noteSummary: '15.580,00 € - 30 % Gesamtgebäude / 46 % selbst genutzte WE', rulesAsOf: '2026-07-21', status: 'precheck-positive' },
  sources: ['KfW-Merkblatt 07/2026'],
});
assert.match(mfhNote, /^15\.580,00 €/);
assert.match(mfhNote, /\(Notiz von Nadine via KI\)$/);
assert.equal(FUNDING_DONE_FOLDER, 'fertig');
assert.deepEqual(validateFundingMailCompletion({
  messageFingerprint: 'mail-123',
  messageDescription: stableMailDescription,
  dealId: '7479',
  uploadedFileNames: ['Personalausweis.pdf'],
  pipedriveFilesVerified: true,
  textRelevant: true,
  pipedriveTextVerified: true,
}), {
  messageFingerprint: 'mail-123',
  messageDescription: stableMailDescription,
  dealId: '7479',
  uploadedFileNames: ['Personalausweis.pdf'],
  textRelevant: true,
  pipedriveFilesVerified: true,
  pipedriveTextVerified: true,
});
assert.throws(() => validateFundingMailCompletion({
  messageFingerprint: 'mail-124', messageDescription: stableMailDescription, dealId: '7479', pipedriveFilesVerified: false,
}), /noch nicht vollständig verifiziert/);
assert.throws(() => validateFundingMailCompletion({
  messageFingerprint: 'mail-125', messageDescription: stableMailDescription, dealId: '7479', pipedriveFilesVerified: true, textRelevant: true,
}), /Mailtext/);

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
  `Kundendaten\nAuftragsnummer: HH-AN-7-26-10926\nKundennummer: KD-8821\nTelefonnummer: +49 174 1234567\nE-Mail: kunde@example.com\nSol-HEAT Wärmepumpenpaket 16kW - PANASONIC M-Serie T-CAP WH-WXG16ME8`,
], { sourceFile: 'Unterschriebenes Angebot.pdf' });
assert.equal(documentAnalysis.fields.orderNumber.value, 'HH-AN-7-26-10926');
assert.equal(documentAnalysis.fields.customerNumber.value, 'KD-8821');
assert.equal(documentAnalysis.fields.phoneNumber.value, '+49 174 1234567');
assert.equal(documentAnalysis.fields.customerEmail.value, 'kunde@example.com');
assert.equal(documentAnalysis.fields.plant.value, 'Panasonic 16 kW');
assert.equal(documentAnalysis.fields.plant.model, 'WH-WXG16ME8');
assert.equal(documentAnalysis.fields.orderNumber.page, 1);
const fieldProposals = buildPipedriveFieldProposals({
  dealId: '399', customerName: 'Erika Musterfrau', orderNumber: null, customerNumber: 'KD-8821', phoneNumber: '0421 123456',
}, documentAnalysis);
assert.equal(fieldProposals.proposals.find(item => item.field === 'orderNumber').action, 'propose_fill');
assert.equal(fieldProposals.proposals.find(item => item.field === 'customerNumber').action, 'already_equal');
assert.equal(fieldProposals.proposals.find(item => item.field === 'phoneNumber').action, 'conflict');
assert.equal(fieldProposals.proposals.find(item => item.field === 'customerEmail').action, 'propose_fill');
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
assert.throws(() => renderFundingMissingDocumentsEmail({ customerName: 'Test', customerEmail: 'test@example.com', orderNumber: '1', missingDocumentIds: [] }), /keine Unterlagen/);
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
  { customerName: 'Fall Eins', customerEmail: 'fall.eins@example.com', orderNumber: 'HH-1', missingDocumentIds: ['signed_offer'] },
  { customerName: 'Fall Zwei', customerEmail: 'fall.zwei@example.com', orderNumber: 'HH-2', missingDocumentIds: ['identity_card'] },
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
  { customerName: 'Doppelt', customerEmail: 'doppelt@example.com', orderNumber: 'HH-3', missingDocumentIds: ['signed_offer'] },
  { customerName: 'Doppelt', customerEmail: 'doppelt@example.com', orderNumber: 'HH-3', missingDocumentIds: ['identity_card'] },
]), /Betreff.*mehrfach/);

const cleanupTestRoot = await mkdtemp(path.join(os.tmpdir(), 'iva-funding-cleanup-'));
const previousDataRoot = process.env.IVA_MAC_HELPER_DATA_DIR;
try {
  process.env.IVA_MAC_HELPER_DATA_DIR = cleanupTestRoot;
  const fingerprint = 'a'.repeat(64);
  const incoming = path.join(cleanupTestRoot, 'incoming', fingerprint);
  await mkdir(incoming, { recursive: true });
  await writeFile(path.join(incoming, 'lokale-kopie.pdf'), '%PDF-1.4\nTest');
  await saveFundingReview({
    messageFingerprint: fingerprint,
    dealId: '8153',
    status: 'ready_for_pipedrive_upload_review',
    downloaded: { directory: incoming, verified: true },
  });
  await assert.rejects(cleanupCompletedFundingReview(fingerprint), /noch nicht vollständig/);
  await recordFundingReviewCompletion(fingerprint, {
    pipedriveUpload: { verified: true, dealId: '8153', files: ['lokale-kopie.pdf'] },
    outbound: { verified: true, channel: 'email', reference: 'mail-1' },
    pendingManualReview: false,
  });
  const cleaned = await cleanupCompletedFundingReview(fingerprint);
  assert.equal(cleaned.localFilesDeleted, true);
  assert.equal(cleaned.emailDeleted, false);
  assert.equal(cleaned.pipedriveFileDeleted, false);
  await assert.rejects(access(incoming));
  assert.equal((await loadFundingReview(fingerprint)).localCleanup.status, 'complete');
  assert.equal(fundingLocalCleanupPolicy().deletesOnlyManagedLocalCopies, true);
} finally {
  if (previousDataRoot == null) delete process.env.IVA_MAC_HELPER_DATA_DIR;
  else process.env.IVA_MAC_HELPER_DATA_DIR = previousDataRoot;
  await rm(cleanupTestRoot, { recursive: true, force: true });
}

const workflowWindowSource = await readFile(new URL('../local-mac-helper/workflow-window.mjs', import.meta.url), 'utf8');
assert.match(workflowWindowSource, /keepDisplayAwake:\s*true/);
assert.match(workflowWindowSource, /sleepDisplays:\s*true/);
assert.match(workflowWindowSource, /requestDisplaySleepAfterRun/);
assert.doesNotMatch(workflowWindowSource, /execFileAsync\('\/usr\/bin\/pmset'/);
assert.match(workflowWindowSource, /caffeinate', \['-dimsu'/);
assert.ok(workflowWindowSource.indexOf("spawn('/usr/bin/caffeinate'") < workflowWindowSource.indexOf('const task = spawn(options.command'));

console.log('PASS IVA Mac Helper: sichere Förder-Prüfläufe, Outlook-Entwürfe, Batch-Rückgängig und gesperrte Versand-/Pipedrive-Aktionen.');
