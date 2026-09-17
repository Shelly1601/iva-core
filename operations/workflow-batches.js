import crypto from 'node:crypto';
import path from 'node:path';
import { createWorkflowOrchestrator } from './workflow-orchestrator.js';
import { auditPlanbarDescription, normalizePlanbarSearchIndex } from './planbar-search.js';
import { getPipedriveFundingSnapshot, missingPipedriveFundingRequiredFields } from '../integrations/pipedrive.js';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const storeFile = name => path.join(process.env.DATA_DIR || '/data', `${name}-workflow-shards.json`);

// This scope is explicitly preflight, not a funding handoff or a document-content review.
// Snapshot contents (including customer-provided credentials) never enter the queue store.
export async function runFundingPreflightBatch({ id = crypto.randomUUID(), dealIds, receivedAt = Date.now(), file = storeFile('funding-preflight'), concurrency = 6 } = {}, { readSnapshot = getPipedriveFundingSnapshot, missingFields = missingPipedriveFundingRequiredFields } = {}) {
  if (!Array.isArray(dealIds) || !dealIds.length || dealIds.length > 10000 || dealIds.some(value => !/^\d+$/.test(String(value)))) throw new Error('Explicit valid funding deal IDs required (maximum 10000)');
  const ids = [...new Set(dealIds.map(String))];
  const engine = createWorkflowOrchestrator({ file, baseConcurrency: concurrency, maxConcurrency: concurrency + 1, handlers: {
    'funding-preflight': async ({ input }) => {
      const snapshot = await readSnapshot(input.dealId);
      if (String(snapshot?.dealId) !== input.dealId) throw new Error('Funding snapshot identity does not match requested deal');
      const missing = missingFields(snapshot);
      return { verified: true, evidence: { source: 'pipedrive-live-api', dealId: input.dealId, checkedAt: new Date().toISOString(), missingRequiredFields: missing, documentCount: Array.isArray(snapshot.fileRecords) ? snapshot.fileRecords.length : null, completeScope: 'required-field-preflight-only' } };
    },
  } });
  engine.enqueue({ id, kind: 'funding-required-field-preflight', lane: 'batch', receivedAt, shards: ids.map(dealId => ({ id: dealId, input: { dealId }, steps: [{ id: 'preflight', handler: 'funding-preflight', budgetMs: 10000 }] })) });
  const workflows = await engine.runUntilIdle();
  return workflows.find(workflow => workflow.id === id);
}

// The existing Planbar description validator remains authoritative. The persisted index
// fingerprint reuses only this narrow format audit, never a reservation/write readback.
export async function runPlanbarIndexAuditBatch({ id = crypto.randomUUID(), index, receivedAt = Date.now(), file = storeFile('planbar-index-audit'), concurrency = 6 } = {}) {
  const normalized = normalizePlanbarSearchIndex(index);
  if (!normalized.appointments.length) throw new Error('A nonempty Planbar index is required');
  const engine = createWorkflowOrchestrator({ file, baseConcurrency: concurrency, maxConcurrency: concurrency + 1, handlers: {
    'planbar-format-audit': async ({ input }) => ({ verified: true, evidence: { appointmentId: input.appointmentId, descriptionAudit: auditPlanbarDescription(input.description), completeScope: 'indexed-description-format-only' } }),
  } });
  engine.enqueue({ id, kind: 'planbar-index-description-audit', lane: 'batch', receivedAt, shards: normalized.appointments.map(appointment => ({ id: appointment.id, fingerprint: digest({ version: 1, description: appointment.description }), input: { appointmentId: appointment.id, description: appointment.description }, steps: [{ id: 'description-format', handler: 'planbar-format-audit', budgetMs: 500 }] })) });
  return (await engine.runUntilIdle()).find(workflow => workflow.id === id);
}
