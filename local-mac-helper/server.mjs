import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { renderFundingMissingDocumentsEmail } from './funding.mjs';
import { createOutlookDraft, diagnoseOutlook, normalizeDraftPayload } from './outlook.mjs';

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
  const rendered = renderFundingMissingDocumentsEmail(input);
  return normalizeDraftPayload({
    subject: rendered.subject,
    body: rendered.body,
    html: rendered.html,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    from: input.from,
    attachments: input.attachments,
  });
}

export function createMacHelperServer() {
  if (TOKEN.length < 32) throw new Error('IVA_MAC_HELPER_TOKEN fehlt oder ist kürzer als 32 Zeichen.');
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, service: 'iva-mac-helper', sendEnabled: false });
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      if (req.method === 'GET' && url.pathname === '/v1/doctor') return json(res, 200, await diagnoseOutlook());
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
