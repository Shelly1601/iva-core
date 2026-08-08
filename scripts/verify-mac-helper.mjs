import assert from 'node:assert/strict';
import {
  FUNDING_DOCUMENTS,
  FUNDING_SENDER_EMAIL,
  renderFundingMissingDocumentsEmail,
  withFundingSender,
} from '../local-mac-helper/funding.mjs';
import { buildDraftAppleScript, normalizeDraftPayload } from '../local-mac-helper/outlook.mjs';

assert.equal(Object.keys(FUNDING_DOCUMENTS).length, 7);
assert.equal(FUNDING_SENDER_EMAIL, 'foerderung@heat-hero.com');
assert.equal(withFundingSender({}).from, FUNDING_SENDER_EMAIL);
assert.throws(() => withFundingSender({ from: 'privat@example.com' }), /ausschließlich/);
const rendered = renderFundingMissingDocumentsEmail({
  customerName: 'Max Mustermann',
  orderNumber: 'A-4711',
  vpName: 'Maria',
  missingDocumentIds: ['signed_offer', 'identity_card'],
});
assert.equal(rendered.subject, 'Max Mustermann - A-4711 - fehlende Unterlagen');
assert.match(rendered.body, /Hallo Patrick, hallo Maria,/);
assert.match(rendered.body, /Unterschriebenes Angebot/);
assert.match(rendered.body, /Personalausweis/);
assert.deepEqual(rendered.missingDocuments.map(item => item.id), ['signed_offer', 'identity_card']);
assert.doesNotMatch(rendered.body, /Zugangsdaten/);
assert.match(rendered.html, /<p>/);
assert.match(rendered.html, /<ul>/);
assert.match(rendered.html, /<li>Unterschriebenes Angebot<\/li>/);

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

console.log('PASS IVA Mac Helper: Fördervorlage, Validierung, Empfänger-Deduplizierung und Entwurfsgrenze.');
