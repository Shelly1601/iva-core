import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { renderFundingMissingDocumentsEmail, withFundingSender } from './funding.mjs';
import { createOutlookDraft, diagnoseOutlook, normalizeDraftPayload } from './outlook.mjs';
import { applyPipedriveFundingFieldUpdates, diagnosePipedriveChrome, readPipedriveFundingDeal } from './chrome-pipedrive.mjs';
import { decideFundingDealAction, validatePipedriveFundingSnapshot } from './pipedrive-funding.mjs';
import { diagnoseWhatsAppMac } from './whatsapp-mac.mjs';
import { analyzeFundingPdf, buildPipedriveFieldProposals } from './funding-document-extractor.mjs';

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

async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); }
  catch { return { version: 1, drafts: {} }; }
}

async function saveState(state) {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function audit(event) {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const safe = { ts: new Date().toISOString(), ...event };
  await appendFile(AUDIT_FILE, JSON.stringify(safe) + '\n', { mode: 0o600 });
}

function fingerprint(draft) {
  return createHash('sha256').update(JSON.stringify({
    subject: draft.subject,
    body: draft.body,
    html: draft.html,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    attachments: draft.attachments,
    from: draft.from,
  })).digest('hex');
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

export function createMacHelperServer() {
  if (TOKEN.length < 32) throw new Error('IVA_MAC_HELPER_TOKEN fehlt oder ist kürzer als 32 Zeichen.');
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, service: 'iva-mac-helper', sendEnabled: false });
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      if (req.method === 'GET' && url.pathname === '/v1/doctor') return json(res, 200, {
        outlook: await diagnoseOutlook(),
        pipedrive: await diagnosePipedriveChrome(),
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
        const analysis = await analyzeFundingPdf(input.pdfPath);
        const fieldProposals = input.snapshot ? buildPipedriveFieldProposals(input.snapshot, analysis) : null;
        return json(res, 200, { analysis, fieldProposals, action: 'analysis-only', mutated: false, sent: false });
      }
      if (req.method === 'POST' && url.pathname === '/v1/funding/pipedrive/fields/apply') {
        const input = await body(req);
        if (input.confirmApply !== true) return json(res, 409, { error: 'confirmApply=true fehlt.', mutated: false, sent: false });
        const snapshot = await readPipedriveFundingDeal({ dealId: input.dealId });
        validatePipedriveFundingSnapshot(snapshot);
        const analysis = await analyzeFundingPdf(input.pdfPath);
        const fieldProposals = buildPipedriveFieldProposals(snapshot, analysis);
        const result = await applyPipedriveFundingFieldUpdates({
          dealId: input.dealId,
          fieldProposals,
          confirmApply: true,
        });
        await audit({
          category: 'pipedrive-field-maintenance',
          action: 'apply-empty-fields',
          dealId: String(input.dealId),
          results: result.results.map(item => ({ targetField: item.targetField, status: item.status, verified: Boolean(item.verified) })),
        });
        return json(res, result.fullyVerified ? 200 : 207, { result, fieldProposals, sent: false });
      }
      if (req.method === 'POST' && url.pathname === '/v1/funding/drafts/preview') {
        const input = await body(req);
        const draft = fundingDraft(input);
        return json(res, 200, { draft, fingerprint: fingerprint(draft), action: 'preview-only', sent: false });
      }
      if (req.method === 'POST' && url.pathname === '/v1/funding/drafts') {
        const input = await body(req);
        if (input.confirmCreateDraft !== true) return json(res, 409, { error: 'confirmCreateDraft=true fehlt.', sent: false });
        const draft = fundingDraft(input);
        const id = fingerprint(draft);
        const state = await loadState();
        if (state.drafts?.[id]?.created) return json(res, 200, { duplicate: true, id, previous: state.drafts[id], sent: false });
        const result = await createOutlookDraft(draft);
        state.drafts ||= {};
        state.drafts[id] = { created: true, createdAt: new Date().toISOString(), subject: draft.subject, sent: false };
        await saveState(state);
        await audit({ category: 'outlook-draft', action: 'created', id, subject: draft.subject, attachmentCount: draft.attachments.length, sent: false });
        return json(res, 201, { id, duplicate: false, result });
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
