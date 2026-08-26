import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { buildDeterministicTmbPrefill, mergeTmbPrefillPreservingExisting, prepareTmbPrefill } from '../workspaces/tmb-prefill.js';

const customerWorkspace = {
  id: 'customer-workspace-1',
  mode: 'kunde',
  customer: { name: 'Mara Muster', email: 'mara@example.test' },
  data: {
    crm: { project: 'HeatHero', sourceId: 'lead-1' },
    meetings: [{
      source: 'plaud', externalId: 'plaud-aufnahme-1', occurredAt: '2026-08-26T14:00:00.000Z',
      internalSummary: 'Gebäudetyp: Einfamilienhaus\nBaujahr: 1998\nVorlauftemperatur: 55\nPV-Anlage vorhanden: ja',
      consent: { granted: true, method: 'mündlich' },
    }],
  },
  notes: [{ text: 'Gewünschter Außenstandort: Nordseite neben Garage\nJahresverbrauch: 22000 kWh', source: 'crm:HeatHero' }],
};

const crmLead = {
  leadquelle: 'WattFox',
  beheizte_flaeche: '165',
  energietraeger: 'Gas',
  heizungshersteller: 'Mustertherm',
};

const deterministic = buildDeterministicTmbPrefill({ customerWorkspace, crmLead });
assert.equal(deterministic.data.schemaVersion, 'iva-tmb-1.0');
assert.equal(deterministic.data.assessment.leadSource, 'WattFox');
assert.equal(deterministic.data.building.type, 'Einfamilienhaus');
assert.equal(deterministic.data.building.year, '1998');
assert.equal(deterministic.data.building.heatedArea, '165');
assert.equal(deterministic.data.existingHeating.energySource, 'Gas');
assert.equal(deterministic.data.existingHeating.manufacturer, 'Mustertherm');
assert.equal(deterministic.data.existingHeating.flowTemperature, '55');
assert.equal(deterministic.data.existingHeating.annualConsumption, '22000');
assert.equal(deterministic.data.heatPump.desiredPosition, 'Nordseite neben Garage');
assert.equal(deterministic.data.pv.present, true);
assert.equal(deterministic.data.existingHeating.installationYear, undefined, 'allgemeines Gebäudebaujahr darf nicht als Heizungsbaujahr übernommen werden');
assert.ok(deterministic.fields.every(field => field.evidence && field.source), 'jede automatische Übernahme braucht Herkunft und Beleg');

const prepared = await prepareTmbPrefill({ customerWorkspace, crmLead }, { useAi: false });
assert.equal(prepared.visit.plaud.recordingId, 'plaud-aufnahme-1');
assert.equal(prepared.visit.consent.granted, true);
assert.equal(prepared.summary.sources.some(source => source.kind === 'CRM'), true);
assert.equal(prepared.summary.sources.some(source => source.kind === 'PLAUD'), true);
assert.equal(prepared.data.prefill.sourceWorkspaceId, customerWorkspace.id);

const merged = mergeTmbPrefillPreservingExisting({
  schemaVersion: 'iva-tmb-1.0',
  building: { year: '2001', heatedArea: '' },
  existingHeating: { energySource: '' },
  declaration: { reviewed: false },
}, prepared.data);
assert.equal(merged.building.year, '2001', 'manuelle Werte dürfen beim erneuten Vorbelegen nicht überschrieben werden');
assert.equal(merged.building.heatedArea, '165');
assert.equal(merged.existingHeating.energySource, 'Gas');

const customerHtml = await fs.readFile(new URL('../public/customers.html', import.meta.url), 'utf8');
const customerJs = await fs.readFile(new URL('../public/customers.js', import.meta.url), 'utf8');
const workspaceHtml = await fs.readFile(new URL('../public/workspace.html', import.meta.url), 'utf8');
const workspaceJs = await fs.readFile(new URL('../public/workspace.js', import.meta.url), 'utf8');
const serverJs = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');

assert.match(customerJs, /class="record-sections"/);
assert.match(customerJs, /id="tmbAssistantBtn"/);
assert.match(customerJs, /\/tmb\/prepare/);
assert.match(customerHtml, /\.record-section/);
assert.match(workspaceHtml, /id="tmbAssistantCard"/);
assert.match(workspaceHtml, /Der geführte Dialog ändert nur die Erfassung/);
assert.match(workspaceJs, /schemaVersion: 'iva-tmb-1\.0'/);
assert.match(workspaceJs, /Geprüft speichern & freigeben/);
assert.match(serverJs, /\/api\/workspaces\/:id\/tmb\/prepare/);

console.log(`PASS TMB-Assistent: ${prepared.summary.appliedCount} belegte CRM-/PLAUD-Werte, Dialog, Prüfschritt und unverändertes IVA-TMB-1.0-Format`);
