import assert from 'node:assert/strict';
import {
  FUNDING_DOCUMENTS,
  FUNDING_PRIMARY_RECIPIENT_EMAIL,
  FUNDING_SENDER_EMAIL,
  FUNDING_SIGNATURE,
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
  buildFundingStageChecklist,
  resolveFundingStage,
  validatePipedriveFundingSnapshot,
} from '../local-mac-helper/pipedrive-funding.mjs';

assert.equal(Object.keys(FUNDING_DOCUMENTS).length, 7);
assert.equal(FUNDING_SENDER_EMAIL, 'foerderung@heat-hero.com');
assert.equal(FUNDING_PRIMARY_RECIPIENT_EMAIL, 'p.germer@heat-hero.com');
assert.equal(FUNDING_SIGNATURE.email, 'n.sell@heat-hero.com');
assert.equal(FUNDING_SIGNATURE.website, 'https://www.heat-hero.com');
assert.equal(withFundingSender({}).from, FUNDING_SENDER_EMAIL);
assert.throws(() => withFundingSender({ from: 'privat@example.com' }), /ausschließlich/);
assert.equal(extractEmailAddress('holger@example.com (Büro)'), 'holger@example.com');
assert.equal(firstNameFromContactName('Herr Holger von Ameln'), 'Holger');
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

assert.equal(PIPEDRIVE_FUNDING_CONFIG.pipeline, 'Auftragsmachbarkeit');
assert.equal(resolveFundingStage('Antrag eingereicht / Förderunterlagen einreichen').key, 'documents');
const documentsChecklist = buildFundingStageChecklist('Antrag eingereicht / Förderunterlagen einreichen', { incomeBonusRequested: true });
assert.equal(documentsChecklist.requiredDocuments.length, 7);
assert.equal(documentsChecklist.canCreateFinalDraftAutomatically, true);
const requestedChecklist = buildFundingStageChecklist('Förderung beantragt', { incomeBonusRequested: false });
assert.equal(requestedChecklist.unresolvedFinalCheck, true);
assert.equal(requestedChecklist.canCreateFinalDraftAutomatically, false);
assert.throws(() => validatePipedriveFundingSnapshot({ pipeline: 'Falsch', stage: 'Förderung beantragt' }), /Falsche/);
assert.equal(validatePipedriveFundingSnapshot({
  pipeline: 'Auftragsmachbarkeit',
  stage: 'Förderung beantragt',
  customerName: 'Max Mustermann',
  orderNumber: 'A-4711',
}).stage, 'Förderung beantragt');

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

console.log('PASS IVA Mac Helper: Pipedrive-Stufen, Patrick/VP-Empfängerlogik, HEAT-HERO-Signatur und Entwurfsgrenze.');
