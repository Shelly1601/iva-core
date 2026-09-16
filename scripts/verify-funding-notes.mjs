import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFundingCalculationNote, isFundingCalculationNote } from '../local-mac-helper/funding-workflows.mjs';
import { calculateKfw458Funding } from '../workspaces/energy-calculations.js';

const efh = { canUseForFundingNote: true, units: 1, selfUsed: true, rate: 46,
  selfUsedUnitRate: 46, buildingBaseRate: 30, estimatedGrant: 12880, eligibleCosts: 28000,
  buildingBaseGrant: 8400, selfUsedUnitAdditionalGrant: 4480,
  bonuses: { base: 30, climateSpeed: 16, income: 0 }, incomeBonusRequested: false,
  rulesAsOf: '2026-07-21', calculationComplete: true };

test('funding amount content uses the handoff path while ordinary intake notes stay available', () => {
  for (const text of ['Voraussichtlich 46 % Förderung (12.880,00 €)', 'Zuschussbetrag offen', 'Förderhöhe noch nicht berechnet', '30 Prozent Grundförderung', '12.300 Euro Zuschuss', '<p>Voraussichtliche Förderung</p>']) assert.equal(isFundingCalculationNote(text), true, text);
  for (const text of ['Fehlende Unterlagen: Personalausweis', 'KfW-Konto erfolgreich geprüft', 'Einkommensbonus gewünscht; Steuerbescheid fehlt.', 'Förderung beantragen: Unterlagen in der E-Mail erhalten.']) assert.equal(isFundingCalculationNote(text), false, text);
});

test('legacy browser writers refuse amount notes and a direct funding handoff before any UI access', async () => {
  const { createPipedriveFundingInformationNote, transitionPipedriveFundingStage } = await import('../local-mac-helper/chrome-pipedrive.mjs');
  await assert.rejects(createPipedriveFundingInformationNote({ dealId: '123', heading: 'Voraussichtlich 30 % Förderung', details: ['Grundförderung'] }), /complete-pipedrive-funding-handoff/);
  await assert.rejects(transitionPipedriveFundingStage({ dealId: '123', fromStage: 'Auftrag eingereicht / Förderunterlagen einreichen', toStage: 'Förderung beantragt', confirmApply: true }), /complete-pipedrive-funding-handoff/);
});

test('EFH note leads with percentage, lists only concise components and omits private evidence', () => {
  const note = buildFundingCalculationNote({ result: efh, sources: ['secret-file-234, Seite 8', 'https://kfw.example/long-source'], status: 'GRÜN' });
  assert.match(note, /^Voraussichtlich 46 % Förderung \(12\.880,00 €\)/);
  assert.match(note, /Grundförderung 30 % · Klima 16 % · Einkommen nicht beantragt/);
  assert.doesNotMatch(note, /Regelstand|Quellen|secret-file|https:|Kind|Status:|Förderfähige Kosten/);
  assert.equal(note.split('\n').length, 3);
  assert.ok(note.endsWith('(Notiz von Nadine)'));
});

test('MFH note leads with amount and keeps whole-building base separate from personal bonus', () => {
  const note = buildFundingCalculationNote({ result: { ...efh, units: 2, eligibleCosts: 41000,
    estimatedGrant: 15580, buildingBaseGrant: 12300, selfUsedUnitAdditionalGrant: 3280 } });
  assert.match(note, /^Voraussichtlich 15\.580,00 € Förderung \(2 Wohneinheiten\)/);
  assert.match(note, /Grundförderung: 30 % = 12\.300,00 €/);
  assert.match(note, /Boni selbst genutzte Wohnung: Klima 16 % · Einkommen nicht beantragt = 3\.280,00 €/);
  assert.equal(note.split('\n').length, 4);
});

test('known base remains visible while requested income bonus and child details remain open', () => {
  const note = buildFundingCalculationNote({ result: { ...efh, units: 2, selfUsed: null,
    calculationComplete: false, estimatedGrant: 12330.38, buildingBaseGrant: 12330.38,
    selfUsedUnitAdditionalGrant: 0, incomeBonusRequested: true, eligibleMinorChild: null,
    bonuses: { base: 30, climateSpeed: null, income: null },
    bonusQuestions: ['Eigennutzung der Wohnung klären.', 'Steuerbescheide 2023 und 2024 fehlen.'] },
    openPoints: ['Antragsdatum fehlt.', 'BzA-förderfähige Kosten nicht belegt.'] });
  assert.match(note, /^Voraussichtlich 12\.330,38 € Förderung/);
  assert.match(note, /Klima offen · Einkommen offen/);
  assert.match(note, /Kind unter 18: offen/);
  assert.match(note, /Steuerbescheide 2023 und 2024 fehlen/);
  assert.doesNotMatch(note, /Antragsdatum|BzA|Einkommen nicht beantragt/);
  assert.ok(note.length < 600);
});

test('capped MFH note never adds uncapped bonus amounts to the base', () => {
  const note = buildFundingCalculationNote({ result: { ...efh, units: 2,
    estimatedGrant: 22550, eligibleCosts: 41000, buildingBaseGrant: 12300,
    selfUsedUnitAdditionalGrant: 10250, selfUsedUnitRate: 80,
    incomeBonusRequested: true, eligibleMinorChild: true,
    bonuses: { base: 30, climateSpeed: 16, income: 40 }, unitRateCapped: true, maximumUnitRate: 80 } });
  assert.match(note, /Klima 16 % · Einkommen 40 % = 10\.250,00 € \(insgesamt auf 80 % begrenzt\)/);
  assert.match(note, /Kind unter 18: berücksichtigt/);
  assert.doesNotMatch(note, /86 %|11\.480/);
});

test('unusable or null grant cannot become a zero-euro success note', () => {
  assert.throws(() => buildFundingCalculationNote({ result: { ...efh, estimatedGrant: null } }), /noch nicht vollständig/);
  assert.throws(() => buildFundingCalculationNote({ result: { ...efh, canUseForFundingNote: false } }), /noch nicht vollständig/);
});

test('actual calculator output flows into a short note without BzA or application-date gates', () => {
  const result = calculateKfw458Funding({ applicantType: 'private-owner', units: 2, selfUsed: true,
    buildingStructure: 'unpartitioned', offerGrossPrice: 41000, incomeBonusRequested: true,
    climateBonusEligible: true }, new Date('2026-09-16T12:00:00Z'));
  const note = buildFundingCalculationNote({ result, sources: result.sources });
  assert.match(note, /^Voraussichtlich 15\.580,00 € Förderung/);
  assert.match(note, /Einkommen offen/);
  assert.match(note, /Steuerbescheide 2023\/2024/);
  assert.doesNotMatch(note, /Antragsdatum|BzA|https:|Regelstand/);
  assert.ok(note.length < 600);
});

test('unknown allocation is not presented as a confirmed zero personal grant', () => {
  const result = calculateKfw458Funding({ applicantType: 'private-owner', units: 2, selfUsed: true,
    buildingStructure: 'weg', offerGrossPrice: 41000, incomeBonusRequested: false,
    climateBonusEligible: true }, new Date('2026-09-16T12:00:00Z'));
  const note = buildFundingCalculationNote({ result });
  assert.match(note, /^Voraussichtlich 12\.300,00 € Förderung/);
  assert.match(note, /noch nicht eingerechnet/);
  assert.match(note, /Miteigentumsanteil/);
  assert.doesNotMatch(note, /= 0,00 €/);
});
