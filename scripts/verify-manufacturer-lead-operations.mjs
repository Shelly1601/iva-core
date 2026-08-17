import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import {
  buildManufacturerOperationsReport,
  classifyManufacturerLeadAddress,
  getManufacturerLeadReadiness,
  loadManufacturerLeadConfig,
  loadManufacturerLeadState,
  recordManufacturerOperation,
  validateManufacturerLeadConfig,
} from '../local-mac-helper/manufacturer-lead-operations.mjs';

const base = await loadManufacturerLeadConfig();
assert.equal(getManufacturerLeadReadiness(base).ready, false);
assert.ok(getManufacturerLeadReadiness(base).blockers.some(item => item.includes('Annahmegebiete')));

const configured = structuredClone(base);
configured.territories.acceptedPostalCodePrefixes = ['10', '14'];
configured.territories.acceptedPostalCodes = ['20095'];
configured.territories.acceptedCities = ['Potsdam'];
configured.territories.excludedPostalCodes = ['10115'];
configured.territories.outsideAreaAction = 'reject';
validateManufacturerLeadConfig(configured);

assert.equal(classifyManufacturerLeadAddress('Musterstraße 1, 10999 Berlin', configured).decision, 'accept');
assert.equal(classifyManufacturerLeadAddress('Musterstraße 1, 20095 Hamburg', configured).decision, 'accept');
assert.equal(classifyManufacturerLeadAddress('Musterstraße 1, Potsdam', configured).decision, 'accept');
assert.equal(classifyManufacturerLeadAddress('Musterstraße 1, 10115 Berlin', configured).decision, 'reject');
assert.equal(classifyManufacturerLeadAddress('Musterstraße ohne Ort', configured).decision, 'manual');

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'iva-manufacturer-leads-'));
const statePath = path.join(temporaryDirectory, 'state.json');
const lead = {
  type: 'manufacturerLead',
  timestamp: '2026-08-12T19:05:00.000Z',
  source: 'panasonic',
  externalId: 'P-123',
  customerName: 'Testkunde',
  address: 'Musterstraße 1, 10999 Berlin',
  receivedAt: '2026-08-12T18:00:00.000Z',
  decision: 'accept',
  portalAction: 'accepted',
  crmStatus: 'created',
  salespersonAssigned: false,
};
assert.equal((await recordManufacturerOperation(lead, { statePath })).recorded, true);
assert.equal((await recordManufacturerOperation(lead, { statePath })).duplicate, true);
await recordManufacturerOperation({
  type: 'wattfoxMessage',
  timestamp: '2026-08-12T19:10:00.000Z',
  folder: 'Posteingang/Lisa Wattfox/Regler',
  messageId: 'W-123',
  subject: 'Bestätigung des Widerrufs',
  receivedAt: '2026-08-12T17:00:00.000Z',
  customerReference: 'K-9',
  outcome: 'Bestätigt',
  requiresFollowUp: false,
}, { statePath });

const state = await loadManufacturerLeadState(statePath);
const report = buildManufacturerOperationsReport(state, { endDate: '2026-08-12', days: 1 });
assert.equal(report.leads.total, 1);
assert.equal(report.leads.missingSalesperson, 1);
assert.equal(report.wattfox.total, 1);
assert.equal(JSON.parse(await readFile(statePath, 'utf8')).version, 1);

console.log('Hersteller-Lead-/Wattfox-Basis erfolgreich verifiziert.');
