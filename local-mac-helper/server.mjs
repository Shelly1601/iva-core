import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { renderFundingMissingDocumentsEmail, withFundingSender } from './funding.mjs';
import { createOutlookDraft, deleteOutlookDrafts, diagnoseOutlook, normalizeDraftPayload } from './outlook.mjs';
import { applyPipedriveFundingFieldUpdates, backgroundIntegrationStatus, readPipedriveFundingDeal } from './background-integrations.mjs';
import { decideFundingDealAction, validatePipedriveFundingSnapshot } from './pipedrive-funding.mjs';
import { diagnoseWhatsAppMac } from './whatsapp-mac.mjs';
import { analyzeFundingPdf, buildPipedriveFieldProposals } from './funding-document-extractor.mjs';
import { cleanupFundingWorkingCopy, stageFundingWorkingCopy } from './local-working-files.mjs';
import {
  FUNDING_ROLLBACK_CONFIRMATION,
  FundingBatchService,
  createJsonFundingStateStore,
  fundingDraftFingerprint,
} from './funding-batches.mjs';

const HOST = '127.0.0.1';
const PORT = Math.min(65535, Math.max(1024, Number(process.env.IVA_MAC_HELPER_PORT) || 4317));
const DATA_DIR = process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');
const TOKEN = String(process.env.IVA_MAC_HELPER_TOKEN || '');

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

function authorized(req) {
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!TOKEN || TOKEN.length < 32 || supplied.length !== TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(TOKEN));
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1024 * 1024) throw new Error('Anfrage ist größer als 1 MB.');
  }
  return raw ? JSON.parse(raw) : {};
}

const stateStore = createJsonFundingStateStore(STATE_FILE);

async function audit(event) {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const safe = { ts: new Date().toISOString(), ...event };
  await appendFile(AUDIT_FILE, JSON.stringify(safe) + '\n', { mode: 0o600 });
}

function fundingDraft(input) {
  const fundingInput = withFundingSender(input);
  const rendered = renderFundingMissingDocumentsEmail(fundingInput);
  return normalizeDraftPayload({
    subject: rendered.subject,
    body: rendered.body,
    html: rendered.html,
    to: rendered.recipients.to,
    cc: rendered.recipients.cc,
    bcc: fundingInput.bcc,
    from: fundingInput.from,
    attachments: fundingInput.attachments,
  });
}

const fundingBatchService = new FundingBatchService({
  store: stateStore,
  renderDraft: fundingDraft,
  createDraft: createOutlookDraft,
  deleteDrafts: deleteOutlookDrafts,
  audit,
});

export function createMacHelperServer() {
  if (TOKEN.length < 32) throw new Error('IVA_MAC_HELPER_TOKEN fehlt oder ist kürzer als 32 Zeichen.');
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, {
        ok: true,
        service: 'iva-mac-helper',
        mode: 'outlook-drafts-only',
        sendEnabled: false,
        pipedriveDeleteEnabled: false,
        pipedriveStageMoveEnabled: false,
        batchRollbackEnabled: true,
        rollbackConfirmation: FUNDING_ROLLBACK_CONFIRMATION,
      });
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      if (req.method === 'DELETE' && url.pathname.startsWith('/v1/pipedrive/')) {
        return json(res, 405, {
          error: 'Pipedrive-Dateien dürfen unter keinen Umständen gelöscht werden.',
          localCleanupOnly: true,
          mutated: false,
          sent: false,
        });
      }
      if (req.method === 'GET' && url.pathname === '/v1/doctor') return json(res, 200, {
        outlook: await diagnoseOutlook(),
        backgroundIntegrations: await backgroundIntegrationStatus(),
        whatsapp: await diagnoseWhatsAppMac(),
      });
      const pipedriveDealMatch = url.pathname.match(/^\/v1\/pipedrive\/deals\/(\d+)\/funding-snapshot$/);
      if (req.method === 'GET' && pipedriveDealMatch) {
        return json(res, 200, await readPipedriveFundingDeal({ dealId: pipedriveDealMatch[1] }));
      }
      if (req.method === 'POST' && url.pathname === '/v1/funding/pipedrive/decision') {
        const input = await body(req);
        const snapshot = validatePipedriveFundingSnapshot(input);
        const decision = decideFundingDealAction(snapshot.stage, {
          incomeBonusRequested: input.incomeBonusRequested,
          documentEvidence: input.documentEvidence,
        });
        return json(res, 200, { snapshot, decision, action: 'decision-only', mutated: false, sent: false });
      }
      if (req.method === 'POST' && url.pathname === '/v1/funding/documents/analyze') {
        const input = await body(req);
        let workingCopy = null;
        let cleanup = { localWorkingCopyDeleted: false, pipedriveFileDeleted: false };
        try {
          workingCopy = await stageFundingWorkingCopy(input.pdfPath, {
            dealId: input.dealId || input.snapshot?.dealId,
            consumeDownloadedCopy: input.deleteLocalCopyAfterUse === true,
          });
          const analysis = await analyzeFundingPdf(workingCopy.workingPath);
          const fieldProposals = input.snapshot ? buildPipedriveFieldProposals(input.snapshot, analysis) : null;
          cleanup = await cleanupFundingWorkingCopy(workingCopy);
          analysis.absolutePath = null;
          return json(res, 200, { analysis, fieldProposals, cleanup, action: 'analysis-only', mutated: false, sent: false });
        } finally {
          if (workingCopy && cleanup.localWorkingCopyDeleted !== true) await cleanupFundingWorkingCopy(workingCopy).catch(() => {});
        }
      }
      if (req.method === 'POST' && url.pathname === '/v1/funding/pipedrive/fields/apply') {
        const input = await body(req);
        if (input.confirmApply !== true) return json(res, 409, { error: 'confirmApply=true fehlt.', mutated: false, sent: false });
        const snapshot = await readPipedriveFundingDeal({ dealId: input.dealId });
        validatePipedriveFundingSnapshot(snapshot);
        let workingCopy = null;
        let cleanup = { localWorkingCopyDeleted: false, pipedriveFileDeleted: false };
        let analysis;
        let fieldProposals;
        let result;
        try {
          workingCopy = await stageFundingWorkingCopy(input.pdfPath, {
            dealId: input.dealId,
            consumeDownloadedCopy: input.deleteLocalCopyAfterUse === true,
          });
          analysis = await analyzeFundingPdf(workingCopy.workingPath);
          fieldProposals = buildPipedriveFieldProposals(snapshot, analysis);
          result = await applyPipedriveFundingFieldUpdates({
            dealId: input.dealId,
            fieldProposals,
            confirmApply: true,
          });
          cleanup = await cleanupFundingWorkingCopy(workingCopy);
          analysis.absolutePath = null;
        } finally {
          if (workingCopy && cleanup.localWorkingCopyDeleted !== true) await cleanupFundingWorkingCopy(workingCopy).catch(() => {});
        }
        await audit({
          category: 'pipedrive-field-maintenance',
          action: 'apply-empty-fields',
          dealId: String(input.dealId),
          results: result.results.map(item => ({ targetField: item.targetField, status: item.status, verified: Boolean(item.verified) })),
        });
        return json(res, result.fullyVerified ? 200 : 207, { result, fieldProposals, cleanup, sent: false });
      }
      if (req.method === 'POST' && url.pathname === '/v1/funding/drafts/preview') {
        const input = await body(req);
        const draft = fundingDraft(input);
        return json(res, 200, { draft, fingerprint: fundingDraftFingerprint(draft), action: 'preview-only', sent: false });
      }
      if (req.method === 'POST' && url.pathname === '/v1/funding/drafts') {
        const input = await body(req);
        if (input.confirmCreateDraft !== true) return json(res, 409, { error: 'confirmCreateDraft=true fehlt.', sent: false });
        const result = await fundingBatchService.create([input]);
        return json(res, result.complete ? 201 : 207, result);
      }
      if (req.method === 'POST' && url.pathname === '/v1/funding/batches/preview') {
        const input = await body(req);
        return json(res, 200, { batch: fundingBatchService.preview(input.cases), action: 'preview-only', sent: false, pipedriveMutated: false });
      }
      if (req.method === 'POST' && url.pathname === '/v1/funding/batches') {
        const input = await body(req);
        if (input.confirmCreateDraftBatch !== true) {
          return json(res, 409, { error: 'confirmCreateDraftBatch=true fehlt.', sent: false, pipedriveMutated: false });
        }
        const result = await fundingBatchService.create(input.cases);
        return json(res, result.complete ? 201 : 207, result);
      }
      if (req.method === 'GET' && url.pathname === '/v1/funding/batches') {
        return json(res, 200, { batches: await fundingBatchService.list(), sent: false, pipedriveMutated: false });
      }
      const fundingBatchGetMatch = url.pathname.match(/^\/v1\/funding\/batches\/([0-9a-f-]{36})$/i);
      if (req.method === 'GET' && fundingBatchGetMatch) {
        const batch = await fundingBatchService.get(fundingBatchGetMatch[1]);
        return batch ? json(res, 200, { batch, sent: false, pipedriveMutated: false }) : json(res, 404, { error: 'Förder-Prüflauf nicht gefunden.' });
      }
      const fundingRollbackMatch = url.pathname.match(/^\/v1\/funding\/batches\/(last|[0-9a-f-]{36})\/rollback$/i);
      if (req.method === 'POST' && fundingRollbackMatch) {
        const input = await body(req);
        const result = await fundingBatchService.rollback(fundingRollbackMatch[1].toLowerCase(), input.confirmation);
        return json(res, result.batch.status === 'partial_rollback' ? 207 : 200, result);
      }
      return json(res, 404, { error: 'not found' });
    } catch (error) {
      await audit({ category: 'helper-error', action: 'request-failed', error: error.message }).catch(() => {});
      return json(res, 400, { error: error.message, sent: false });
    }
  });
}

export function startMacHelperServer() {
  const server = createMacHelperServer();
  server.listen(PORT, HOST, () => {
    process.stdout.write(`IVA Mac Helper läuft lokal auf http://${HOST}:${PORT}\n`);
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) startMacHelperServer();
