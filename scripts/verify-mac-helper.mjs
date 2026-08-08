import assert from 'node:assert/strict';
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
import { buildDraftAppleScript, normalizeDraftPayload } from '../local-mac-helper/outlook.mjs';
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
  parseFundingDocumentPages,
} from '../local-mac-helper/funding-document-extractor.mjs';
import { applyPipedriveFundingFieldUpdates } from '../local-mac-helper/chrome-pipedrive.mjs';

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

const documentAnalysis = parseFundingDocumentPages([
  `Kundendaten\nAuftragsnummer: HH-AN-7-26-10926\nKundennummer: KD-8821\nTelefonnummer: +49 174 1234567`,
], { sourceFile: 'Unterschriebenes Angebot.pdf' });
assert.equal(documentAnalysis.fields.orderNumber.value, 'HH-AN-7-26-10926');
assert.equal(documentAnalysis.fields.customerNumber.value, 'KD-8821');
assert.equal(documentAnalysis.fields.phoneNumber.value, '+49 174 1234567');
assert.equal(documentAnalysis.fields.orderNumber.page, 1);
const fieldProposals = buildPipedriveFieldProposals({
  dealId: '399', customerName: 'Erika Musterfrau', orderNumber: null, customerNumber: 'KD-8821', phoneNumber: '0421 123456',
}, documentAnalysis);
assert.equal(fieldProposals.proposals.find(item => item.field === 'orderNumber').action, 'propose_fill');
assert.equal(fieldProposals.proposals.find(item => item.field === 'customerNumber').action, 'already_equal');
assert.equal(fieldProposals.proposals.find(item => item.field === 'phoneNumber').action, 'conflict');
assert.equal(fieldProposals.mutated, false);
const ambiguousAnalysis = parseFundingDocumentPages([
  'Auftragsnummer: HH-AN-7-26-10926\nAuftragsnummer: HH-AN-7-26-10927',
], { sourceFile: 'Doppelt.pdf' });
assert.equal(ambiguousAnalysis.fields.orderNumber.status, 'ambiguous');
const scannedAnalysis = parseFundingDocumentPages([''], { sourceFile: 'Scan.pdf' });
assert.equal(scannedAnalysis.textLayer, 'ocr_required');
assert.equal(scannedAnalysis.fields.orderNumber.status, 'ocr_required');
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

console.log('PASS IVA Mac Helper: Pipedrive-Stufen, E-Mail-Empfänger, HEAT-HERO-Signatur und gesperrte WhatsApp-Übergabe.');
