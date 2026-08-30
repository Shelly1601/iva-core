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
import { createProjectWorkflowAutomationHandler } from '../automations/imac-workflow.js';
import { startProjectWorkflowTask } from '../local-mac-helper/codex-tasks.mjs';

const base = await loadManufacturerLeadConfig();
assert.equal(getManufacturerLeadReadiness(base).ready, false);
assert.equal(base.enabled, true);
assert.ok(getManufacturerLeadReadiness(base).blockers.some(item => item.includes('Annahmegebiete')));
assert.deepEqual(base.scope.manufacturerLeads, ['bosch']);
assert.equal(base.scope.panasonicWorkflowId, 'panasonic-promatch-lead-import');

await assert.rejects(
  () => recordManufacturerOperation({
    type: 'manufacturerLead', source: 'bosch', externalId: 'unsafe-1', address: '10999 Berlin',
    portalAction: 'accepted', crmStatus: 'created',
  }, { statePath: path.join(os.tmpdir(), 'must-not-be-written.json'), config: base }),
  /Sicherheits-Readiness fehlt/,
);

const configured = structuredClone(base);
configured.territories.acceptedPostalCodePrefixes = ['10', '14'];
configured.territories.acceptedPostalCodes = ['20095'];
configured.territories.acceptedCities = ['Potsdam'];
configured.territories.excludedPostalCodes = ['10115'];
configured.territories.outsideAreaAction = 'reject';
configured.mode = 'live';
for (const key of Object.keys(configured.activation)) configured.activation[key] = true;
validateManufacturerLeadConfig(configured);
assert.equal(getManufacturerLeadReadiness(configured).ready, true);

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
assert.equal((await recordManufacturerOperation(lead, { statePath, config: configured })).recorded, true);
assert.equal((await recordManufacturerOperation(lead, { statePath, config: configured })).duplicate, true);
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
}, { statePath, config: configured });

await Promise.all(Array.from({ length: 20 }, (_, index) => recordManufacturerOperation({
  type: 'wattfoxMessage',
  timestamp: '2026-08-12T19:11:00.000Z',
  folder: 'Posteingang/Lisa Wattfox/Regler',
  messageId: `W-concurrent-${index}`,
  subject: 'Bestätigung des Widerrufs',
  receivedAt: '2026-08-12T17:00:00.000Z',
  outcome: 'Nur gelesen',
}, { statePath, config: configured })));

const state = await loadManufacturerLeadState(statePath);
const report = buildManufacturerOperationsReport(state, { endDate: '2026-08-12', days: 1 });
assert.equal(report.leads.total, 1);
assert.equal(report.leads.missingSalesperson, 1);
assert.equal(report.wattfox.total, 21);
assert.equal(state.wattfoxMessages.length, 21);
assert.equal(JSON.parse(await readFile(statePath, 'utf8')).version, 1);

let queuedPayload;
const commands = new Map();
const handler = createProjectWorkflowAutomationHandler({
  projectId: 'heat-hero', workflowId: 'manufacturer-leads-wattfox', displayName: 'Bosch-Herstellerleads und Wattfox',
  requiredAllowedActions: ['project.workflow.run', 'codex.task.status'],
  getProject: async () => ({ automations: [{ id: 'manufacturer-leads-wattfox', enabled: true }] }),
  deviceAgentStatus: async () => ({ online: true, dispatchReady: true, allowedActions: ['project.workflow.run', 'codex.task.status'] }),
  enqueueDeviceCommand: async input => {
    queuedPayload = input.payload;
    const command = { id: `command-${commands.size + 1}`, status: 'queued' };
    commands.set(command.id, command);
    return command;
  },
  deviceCommandStatus: async id => commands.get(id),
});
const slotKey = 'manufacturer-leads-wattfox:daily:2026-08-30';
const queued = await handler({ slotKey, attempt: 1, previousResult: {} });
assert.equal(queued.status, 'waiting');
assert.equal(queuedPayload.runMode, 'automatic');
assert.equal(queuedPayload.requestId, slotKey);
assert.equal(queuedPayload.automationSlotKey, slotKey);
commands.set(queued.commandId, { id: queued.commandId, status: 'completed', result: { jobId: 'manufacturer-job' } });
const running = await handler({ slotKey, attempt: 1, previousResult: queued });
assert.equal(running.status, 'waiting');
commands.set(running.statusCommandId, { id: running.statusCommandId, status: 'completed', result: { status: 'completed', resultPreview: 'Keine unsichere Schreibaktion.' } });
const completed = await handler({ slotKey, attempt: 1, previousResult: running });
assert.equal(completed.summary, 'Keine unsichere Schreibaktion.');

let taskInput;
await startProjectWorkflowTask({
  workflowId: 'manufacturer-leads-wattfox', requestId: 'manufacturer-test-request', runMode: 'manual',
  startTask: async input => { taskInput = input; return { jobId: 'manufacturer-test-job' }; },
});
assert.match(taskInput.prompt, /Panasonic ist ein getrennt aktiver 10-Uhr-Workflow/);
assert.match(taskInput.prompt, /Wattfox ausschließlich lesen/);
assert.equal(taskInput.workflowId, 'manufacturer-leads-wattfox');

console.log('Hersteller-Lead-/Wattfox-Basis erfolgreich verifiziert.');
