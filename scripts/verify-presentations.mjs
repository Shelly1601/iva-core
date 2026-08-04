import assert from 'node:assert/strict';
import {
  PRESENTATION_CONCEPTS,
  normalizePresentationProfile,
  presentationConcept,
  presentationCopy,
  presentationDesign,
  presentationEvidence,
} from '../public/presentation-concepts.js';

const defaults = normalizePresentationProfile();
assert.equal(defaults.conceptId, 'iva-premium');
assert.equal(defaults.designId, 'executive-blue');
assert.equal(defaults.maxPages, 6);

const custom = normalizePresentationProfile({
  conceptId: 'custom',
  conceptName: 'Arbeitgeber-Kompass',
  audience: 'management',
  tone: 'management',
  designId: 'warm-premium',
  maxPages: 4,
  uspNotes: '- Schnelle Einführung\n- Persönliche Begleitung',
});
assert.equal(custom.conceptName, 'Arbeitgeber-Kompass');
assert.equal(custom.maxPages, 4);
assert.deepEqual(presentationCopy('corporate-benefits', custom).usps, ['Schnelle Einführung', 'Persönliche Begleitung']);

assert.equal(presentationConcept('goto').ready, false);
assert.equal(PRESENTATION_CONCEPTS.length, 3);
assert.equal(presentationDesign('iva-night').label, 'IVA Night Premium');

for (const moduleId of ['financial-holistic', 'retirement-planning', 'depot-comparison', 'property-calculator', 'gkv-comparison', 'energy-tariff-comparison', 'energy-planning']) {
  assert.ok(presentationCopy(moduleId).usps.length >= 4, `${moduleId}: USPs fehlen`);
  assert.ok(presentationEvidence([moduleId], 4).length >= 1, `${moduleId}: Quellenkarte fehlt`);
}

const evidence = presentationEvidence(['retirement-planning', 'property-calculator'], 10);
assert.ok(evidence.every(item => /^https:\/\//.test(item.url)));
assert.ok(evidence.every(item => item.publisher && item.scope));

console.log('Presentation concepts, source cards, USP copy and limits verified.');
