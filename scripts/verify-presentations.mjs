import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
assert.equal(defaults.bundleMode, 'master');

const custom = normalizePresentationProfile({
  conceptId: 'custom',
  conceptName: 'Arbeitgeber-Kompass',
  audience: 'management',
  tone: 'management',
  designId: 'warm-premium',
  maxPages: 14,
  bundleMode: 'compact',
  uspNotes: '- Schnelle Einführung\n- Persönliche Begleitung',
  welcomeSalutation: 'Sehr geehrte Frau Muster,',
  welcomeText: 'Ihre individuelle Einleitung.',
  closingText: 'Ihre gemeinsame Schlussseite.',
  signature: 'Herzliche Grüße\nNadine Sell',
});
assert.equal(custom.conceptName, 'Arbeitgeber-Kompass');
assert.equal(custom.maxPages, 14);
assert.equal(custom.bundleMode, 'compact');
assert.equal(custom.welcomeText, 'Ihre individuelle Einleitung.');
assert.equal(custom.signature, 'Herzliche Grüße\nNadine Sell');
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

const workspaceSource = await readFile(new URL('../public/workspace.js', import.meta.url), 'utf8');
assert.match(workspaceSource, /profile\.bundleMode === 'master'/);
assert.match(workspaceSource, /toc\.className = 'print-toc'/);
assert.match(workspaceSource, /letter\.className = 'print-letter'/);
assert.match(workspaceSource, /profile\.closingText \|\| profile\.cta/);
assert.match(workspaceSource, /schemaVersion: 'iva-advice-1\.2'/);

console.log('Presentation concepts, Master-PDF structure, source cards, USP copy and limits verified.');
