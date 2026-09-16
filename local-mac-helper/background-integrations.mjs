import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, lstat, writeFile } from 'node:fs/promises';
import { classifyFundingDocumentName } from './funding-document-extractor.mjs';
import { validateKfwCustomerCredentials } from './funding-kfw-credentials.mjs';
import { assertImacExecutionHost, imacDeviceAgentMetadata } from './device-agent.mjs';

const execFileAsync = promisify(execFile);
const DEVICE_ID = 'macmini-nadine';
const KEYCHAIN_SERVICE = 'de.iva.device-agent';
const DEFAULT_SERVER_URL = 'https://iva-core-production.up.railway.app';
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const DATA_ROOT = process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper');

function serverUrl() {
  const url = new URL(String(process.env.IVA_DEVICE_SERVER_URL || DEFAULT_SERVER_URL));
  if (url.protocol !== 'https:') throw new Error('Der IVA-Hintergrundkanal benötigt HTTPS.');
  return url.origin;
}

async function token() {
  assertImacExecutionHost();
  const { stdout } = await execFileAsync('/usr/bin/security', ['find-generic-password', '-a', DEVICE_ID, '-s', KEYCHAIN_SERVICE, '-w'], { timeout: 10_000 });
  const value = String(stdout || '').trim();
  if (value.length < 32) throw new Error('Das Mac Mini-Gerätetoken fehlt im macOS-Schlüsselbund.');
  return value;
}

async function request(pathname, { method = 'GET', body, binary = false, timeoutMs = 30_000 } = {}) {
  assertImacExecutionHost();
  const agent = imacDeviceAgentMetadata();
  const rawBody = Buffer.isBuffer(body);
  const response = await fetch(`${serverUrl()}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${await token()}`,
      'X-IVA-Agent-Host': agent.hostname,
      'X-IVA-Agent-Hardware-Model': agent.hardwareModel,
      'X-IVA-Agent-Fingerprint': agent.hardwareFingerprint,
      'X-IVA-Agent-Local-Workspace': String(agent.localWorkspace),
      'X-IVA-Agent-Ui-Busy': String(agent.uiBusy),
      'X-IVA-Agent-Protocol': String(agent.protocolVersion),
      'X-IVA-Agent-Release': agent.release,
      'X-IVA-Agent-Revision': agent.runtimeRevision,
      'X-IVA-Agent-Workspace': agent.workspace,
      'X-IVA-Agent-ICloud': String(agent.iCloudAuthoritative),
      ...(rawBody ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: rawBody ? body : body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (binary) {
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(`IVA-Hintergrundkanal HTTP ${response.status}: ${String(payload?.error || response.statusText).slice(0, 400)}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_FILE_BYTES) throw new Error('Hintergrunddownload ist leer oder größer als 50 MB.');
    return { buffer, contentType: String(response.headers.get('content-type') || ''), disposition: String(response.headers.get('content-disposition') || ''),
      verified: response.headers.get('x-iva-verified') === 'true', sha256: response.headers.get('x-iva-content-sha256'),
      size: response.headers.get('x-iva-attachment-size'), sourceHash: response.headers.get('x-iva-source-hash') };
  }
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw new Error(`IVA-Hintergrundkanal HTTP ${response.status}: ${String(payload?.error || text || response.statusText).slice(0, 400)}`);
  return payload;
}

function safeName(value, fallback) {
  const original = path.basename(String(value || fallback || 'download')).normalize('NFKC');
  const extension = path.extname(original).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
  const stem = path.basename(original, path.extname(original)).replace(/[^a-z0-9äöüß._ -]+/gi, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${stem || fallback || 'download'}${extension}`;
}

export async function backgroundIntegrationStatus() {
  return request(`/device-agent/${DEVICE_ID}/background/status`);
}

/** Shared-mailbox access stays on the authenticated device channel; Graph tokens never reach this Mac helper. */
export function createMicrosoftFundingMailTransport({ requestImpl = request, now = Date.now, statusTtlMs = 60000 } = {}) {
  const base = `/device-agent/${DEVICE_ID}/background/funding-mail`;
  const cache = new Map();
  async function status({ probe = false, refresh = false } = {}) {
    const key = probe ? 'probe' : 'configuration', previous = cache.get(key);
    if (!refresh && previous && previous.expiresAt > now()) return previous.promise;
    const promise = Promise.resolve().then(() => requestImpl(`${base}/status${probe ? '?probe=1' : ''}`));
    const entry = { expiresAt: now() + statusTtlMs, promise }; cache.set(key, entry);
    // Keep a short failure cache as well: do not multiply failing probes per message.
    promise.catch(() => { if (cache.get(key) === entry) entry.expiresAt = now() + Math.min(statusTtlMs, 15000); });
    return promise;
  }
  const post = (action, body) => requestImpl(`${base}/${action}`, { method: 'POST', body, timeoutMs: 60000 });
  return { status,
    readPage: input => post('page', input), readMessage: input => post('message', input), resolveIdentity: input => post('resolve', input),
    moveMessage: input => post('move', input),
    async downloadAttachment(input) {
      const downloaded = await requestImpl(`${base}/attachment`, { method: 'POST', body: input, binary: true, timeoutMs: 60000 });
      const buffer = downloaded.buffer;
      if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_FILE_BYTES) throw new Error('Der verifizierte Fördermail-Anhang ist leer oder zu groß.');
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      if (downloaded.verified !== true || Number(downloaded.size) !== buffer.length || downloaded.sha256 !== sha256 || !/^[0-9a-f]{64}$/i.test(downloaded.sourceHash || ''))
        throw new Error('Der binäre M365-Anhang stimmt nicht mit seinem verifizierten Serverbeleg überein.');
      let filename = 'anlage';
      const encoded = downloaded.disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      if (encoded) { try { filename = decodeURIComponent(encoded); } catch { throw new Error('Der Fördermail-Anhang enthält einen ungültigen Dateinamen.'); } }
      return { buffer, filename: safeName(filename, 'anlage'), contentType: downloaded.contentType || 'application/octet-stream', size: buffer.length,
        sha256, sourceHash: downloaded.sourceHash, verified: true, messageId: input.messageId, attachmentId: input.attachmentId, source: 'microsoft-graph' };
    },
  };
}
const microsoftFundingTransport = createMicrosoftFundingMailTransport();
export const microsoftFundingMailStatus = input => microsoftFundingTransport.status(input);
export const readMicrosoftFundingPage = input => microsoftFundingTransport.readPage(input);
export const readMicrosoftFundingMessage = input => microsoftFundingTransport.readMessage(input);
export const resolveMicrosoftFundingIdentity = input => microsoftFundingTransport.resolveIdentity(input);
export const moveMicrosoftFundingMessage = input => microsoftFundingTransport.moveMessage(input);
export const downloadMicrosoftFundingAttachment = input => microsoftFundingTransport.downloadAttachment(input);

export async function downloadMicrosoftFundingAttachments({ from = 'foerderung@heat-hero.com', folder = 'Posteingang', messageId, directory } = {}, {
  readMessage = readMicrosoftFundingMessage, downloadAttachment = downloadMicrosoftFundingAttachment,
} = {}) {
  const message = await readMessage({ from, folder, messageId });
  if (message?.source !== 'microsoft-graph' || message.identityVerified !== true || message.messageId !== messageId
    || message.sourceReadComplete !== true || message.attachmentsComplete !== true || !/^[0-9a-f]{64}$/i.test(message.sourceHash || '') || !Array.isArray(message.attachments))
    throw new Error('Die Originalmail und ihre vollständige Anlagenliste wurden nicht über M365 bestätigt.');
  const attachments = message.attachments;
  if (attachments.length > 200) throw new Error('Diese Fördermail enthält zu viele Anlagen für einen sicheren Einzellauf.');
  const root = path.join(process.env.IVA_MAC_HELPER_DATA_DIR || DATA_ROOT, 'tmp', 'funding-mail-downloads');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = directory ? path.resolve(directory) : await mkdtemp(path.join(root, 'mail-'));
  await mkdir(target, { recursive: true, mode: 0o700 });
  const files = []; let totalBytes = 0;
  for (const [index, attachment] of attachments.entries()) {
    const attachmentId = String(attachment.attachmentId || attachment.id || '');
    if (!attachmentId) throw new Error('Mindestens einer Anlage fehlt die verifizierte M365-Kennung.');
    if (attachment.supported !== true) throw new Error('Mindestens eine Fördermail-Anlage benötigt eine gesonderte unterstützte Aufbereitung. Es wird keine vollständige Verarbeitung behauptet.');
    const file = await downloadAttachment({ from, folder, messageId, attachmentId });
    if (!Buffer.isBuffer(file.buffer) || !file.buffer.length || file.buffer.length > MAX_FILE_BYTES) throw new Error('Eine Fördermail-Anlage wurde nicht vollständig heruntergeladen.');
    if (file.verified !== true || Number(file.size) !== file.buffer.length || file.sha256 !== createHash('sha256').update(file.buffer).digest('hex') || file.sourceHash !== message.sourceHash)
      throw new Error('Der Anhang passt nicht zum gelesenen Originalstand der M365-Nachricht.');
    totalBytes += file.buffer.length;
    if (totalBytes > 100 * 1024 * 1024) throw new Error('Die Fördermail überschreitet die zulässige Gesamtgröße von 100 MB.');
    const fileName = `${String(index + 1).padStart(3, '0')}-${safeName(attachment.name || file.filename, 'anlage')}`;
    const filePath = path.join(target, fileName);
    try { await writeFile(filePath, file.buffer, { mode: 0o600, flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await lstat(filePath);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== file.buffer.length || createHash('sha256').update(await readFile(filePath)).digest('hex') !== createHash('sha256').update(file.buffer).digest('hex'))
        throw new Error('Eine vorhandene lokale Arbeitskopie passt nicht zur frisch gelesenen Anlage und wird nicht überschrieben.');
    }
    files.push({ attachmentId, fileName, filePath, size: file.buffer.length, sha256: createHash('sha256').update(file.buffer).digest('hex'), contentType: file.contentType || attachment.contentType || '' });
  }
  const confirmed = await readMessage({ from, folder, messageId });
  if (confirmed?.messageId !== messageId || confirmed.source !== 'microsoft-graph' || confirmed.identityVerified !== true || confirmed.sourceReadComplete !== true
    || confirmed.attachmentsComplete !== true || confirmed.sourceHash !== message.sourceHash)
    throw new Error('Die Originalmail hat sich während des Anlagendownloads geändert. Keine vollständige Ablage bestätigt; den neuen Nachrichtenstand erneut prüfen.');
  return { messageId, source: 'microsoft-graph', sourceHash: message.sourceHash, immutableId: message.immutableId || null, sourceReadComplete: true,
    attachmentsComplete: true, identityVerified: true, directory: target, files, expectedCount: attachments.length,
    downloadedCount: files.length, verified: true, complete: true, readOnlySource: true };
}

export async function collectPipedriveFundingDealIds() {
  return request(`/device-agent/${DEVICE_ID}/background/pipedrive/funding-board`);
}

export async function readPipedriveFundingDeal({ dealId } = {}) {
  const id = String(dealId || '').replace(/\D/g, '');
  if (!id) throw new Error('Für die Pipedrive-Prüfung fehlt eine gültige Deal-ID.');
  const snapshot = await request(`/device-agent/${DEVICE_ID}/background/pipedrive/deals/${id}`, { timeoutMs: 60_000 });
  return { ...snapshot, documents: (snapshot.files || []).map(classifyFundingDocumentName), source: 'iva-core-pipedrive-api' };
}

export async function listPipedriveDealsByStageName(stageName) {
  const name = String(stageName || '').replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('Pipedrive-Phase fehlt.');
  return request(`/device-agent/${DEVICE_ID}/background/pipedrive/stages/${encodeURIComponent(name)}`, { timeoutMs: 60_000 });
}

export async function applyPipedriveFundingFieldUpdates({ dealId, fieldProposals, confirmApply = false } = {}) {
  if (confirmApply !== true) throw new Error('Pipedrive-Felder wurden nicht geändert: confirmApply=true fehlt.');
  const updates = (Array.isArray(fieldProposals?.proposals) ? fieldProposals.proposals : [])
    .filter(item => item?.action === 'propose_fill' && Number.isInteger(item.evidence?.page) && Number(item.evidence?.confidence) >= 0.9 && String(item.evidence?.sourceFile || '').toLowerCase().endsWith('.pdf'))
    .map(item => ({ field: String(item.targetField || '').trim(), value: String(item.proposedValue || '').trim().slice(0, 500) }))
    .filter(item => item.field && item.value);
  if (!updates.length) return { dealId: String(dealId), results: [], mutated: false, reason: 'Keine sicher befüllbaren leeren Felder.' };
  return request(`/device-agent/${DEVICE_ID}/background/pipedrive/deals/${String(dealId).replace(/\D/g, '')}/fields`, { method: 'PATCH', body: { updates }, timeoutMs: 60_000 });
}

export async function transitionPipedriveFundingStage({ dealId, fromStage, toStage, confirmApply = false } = {}) {
  if (confirmApply !== true) throw new Error('Pipedrive-Phase wurde nicht geändert: confirmApply=true fehlt.');
  const id = String(dealId || '').replace(/\D/g, '');
  return request(`/device-agent/${DEVICE_ID}/background/pipedrive/deals/${id}/funding-transition`, { method: 'POST', body: { fromStage, toStage }, timeoutMs: 60_000 });
}

export async function completePipedriveFundingHandoff({ dealId, documentReview, result, confirmApply = false } = {}) {
  if (confirmApply !== true) throw new Error('Die Förderübergabe wurde nicht ausgeführt: confirmApply=true fehlt.');
  const id = String(dealId || '');
  if (!/^\d+$/.test(id)) throw new Error('Für die Förderübergabe fehlt eine gültige Deal-ID.');
  return request(`/device-agent/${DEVICE_ID}/background/pipedrive/deals/${id}/funding-handoff`, {
    method: 'POST', body: { documentReview, result }, timeoutMs: 90_000,
  });
}

export async function writePipedriveKfwCustomerCredentials({ dealId, kfwCredentials, confirmApply = false, reconcileOnly = false } = {}, { requestImpl = request } = {}) {
  if (confirmApply !== true) throw new Error('KfW-Kundenzugang nicht gespeichert: confirmApply=true fehlt.');
  const credentials = validateKfwCustomerCredentials(kfwCredentials, dealId);
  try {
    const receipt = await requestImpl(`/device-agent/${DEVICE_ID}/background/pipedrive/deals/${credentials.dealId}/kfw-credentials`, {
      method: 'POST', body: { kfwCredentials: credentials, reconcileOnly }, timeoutMs: 60_000,
    });
    const noteId = /^\d+$/.test(String(receipt?.noteId || '')) ? String(receipt.noteId) : null;
    if (receipt?.verified === true && !noteId) throw new Error('invalid_receipt');
    return { dealId: credentials.dealId, noteId, created: receipt?.created === true,
      alreadyPresent: receipt?.alreadyPresent === true, verified: receipt?.verified === true, writeAttempted: receipt?.writeAttempted === true,
      source: 'iva-core-pipedrive-api' };
  } catch { throw new Error('KfW-Kundenzugang konnte nicht bestätigt werden; vorhandene Notiz vor einem erneuten Schreiben abgleichen.'); }
}

export async function amendPipedriveFundingHandoff({ dealId, handoffId, noteId, requestId, expectedContentSha256, documentReview, result, confirmApply = false } = {}, { requestImpl = request } = {}) {
  if (confirmApply !== true) throw new Error('Die Fördernotiz wurde nicht korrigiert: confirmApply=true fehlt.');
  if (!/^\d+$/.test(String(dealId || '')) || !/^\d+$/.test(String(noteId || ''))) throw new Error('Die eindeutige Deal- oder Fördernotiz-ID fehlt.');
  try {
    return await requestImpl(`/device-agent/${DEVICE_ID}/background/pipedrive/deals/${dealId}/funding-handoff/note`, {
      method: 'PATCH', body: { handoffId, noteId, requestId, expectedContentSha256, documentReview, result }, timeoutMs: 90_000,
    });
  } catch { throw new Error('Die Fördernotiz-Korrektur ist noch nicht bestätigt; denselben Vorgang anhand seiner Kennung rücklesen.'); }
}

export async function listPipedriveFundingHandoffs() {
  return request(`/device-agent/${DEVICE_ID}/background/pipedrive/funding-handoffs`);
}

export async function markPipedriveFundingDealWon({ dealId, approvalFileName, approvalEvidence, confirmApply = false } = {}) {
  if (confirmApply !== true) throw new Error('Der Deal wurde nicht auf „Gewonnen“ gesetzt: confirmApply=true fehlt.');
  const id = String(dealId || '').replace(/\D/g, '');
  return request(`/device-agent/${DEVICE_ID}/background/pipedrive/deals/${id}/won`, { method: 'POST', body: { approvalFileName, approvalEvidence }, timeoutMs: 90_000 });
}

export async function readPipedriveFundingDealsViaApi({ dealIds, onProgress } = {}) {
  const ids = [...new Set((Array.isArray(dealIds) ? dealIds : []).map(value => String(value).replace(/\D/g, '')).filter(Boolean))];
  if (!ids.length) throw new Error('Für den Förder-Prüflauf fehlen Deal-IDs.');
  const snapshots = [];
  const errors = [];
  for (const [index, dealId] of ids.entries()) {
    try { snapshots.push(await readPipedriveFundingDeal({ dealId })); }
    catch (error) { errors.push({ dealId, error: String(error?.message || error).slice(0, 500) }); }
    if (typeof onProgress === 'function') onProgress({ processed: index + 1, total: ids.length });
  }
  return { requested: ids.length, read: snapshots.length, failed: errors.length, snapshots, errors, readOnly: true, mutated: false, source: 'iva-core-pipedrive-api' };
}

export async function downloadPipedriveDealFiles({ dealId, fileIds = [] } = {}, {
  readSnapshot = readPipedriveFundingDeal,
  downloadFile = (id, fileId) => request(`/device-agent/${DEVICE_ID}/background/pipedrive/deals/${id}/files/${encodeURIComponent(fileId)}`, { binary: true, timeoutMs: 60_000 }),
} = {}) {
  const id = String(dealId || '').replace(/\D/g, '');
  if (!id) throw new Error('Für den Pipedrive-Dateidownload fehlt eine gültige Deal-ID.');
  const snapshot = await readSnapshot({ dealId: id });
  const requested = new Set((Array.isArray(fileIds) ? fileIds : []).map(value => String(value).replace(/\D/g, '')).filter(Boolean));
  const records = Array.isArray(snapshot.fileRecords) ? snapshot.fileRecords : [];
  const selected = requested.size ? records.filter(file => requested.has(String(file.id))) : records;
  if (requested.size && selected.length !== requested.size) throw new Error('Mindestens eine angeforderte Pipedrive-Datei gehört nicht zu diesem Deal.');
  if (!selected.length) return { dealId: id, directory: null, files: [], downloadedCount: 0, complete: true, readOnlySource: true, deletedFromPipedrive: false, source: 'iva-core-pipedrive-api' };
  if (selected.length > 100) throw new Error('Pro Deal dürfen höchstens 100 Dateien in einem Lauf heruntergeladen werden.');
  const root = path.join(DATA_ROOT, 'tmp', 'funding-downloads');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(root, `${id}-`));
  const files = [];
  const failedFiles = [];
  for (const file of selected) {
    try {
      const download = await downloadFile(id, file.id);
      // Different Pipedrive records may have identical display names. Keep
      // every record separate on disk so a complete deal review loses no file.
      const fileName = `${file.id}-${safeName(file.name, 'document')}`;
      const filePath = path.join(directory, fileName);
      await writeFile(filePath, download.buffer, { mode: 0o600, flag: 'wx' });
      files.push({ id: String(file.id), originalName: file.name, fileName, filePath, size: download.buffer.length, contentType: download.contentType || file.mimeType || '' });
    } catch (error) {
      failedFiles.push({ id: String(file.id), originalName: file.name, error: String(error?.message || error).slice(0, 300) });
    }
  }
  if (!files.length && failedFiles.length) await rm(directory, { recursive: true, force: true });
  return { dealId: id, directory: files.length ? directory : null, files, failedFiles, downloadedCount: files.length, failedCount: failedFiles.length, complete: failedFiles.length === 0, readOnlySource: true, deletedFromPipedrive: false, source: 'iva-core-pipedrive-api' };
}

export async function uploadPipedriveDealFiles({ dealId, directory } = {}) {
  const id = String(dealId || '').replace(/\D/g, '');
  const absoluteDirectory = path.resolve(String(directory || ''));
  if (!id) throw new Error('Für den Pipedrive-Dateiupload fehlt eine gültige Deal-ID.');
  const directoryInfo = await stat(absoluteDirectory);
  if (!directoryInfo.isDirectory()) throw new Error('Der Pipedrive-Uploadpfad ist kein Ordner.');
  const names = (await readdir(absoluteDirectory)).filter(name => !name.startsWith('.')).sort();
  if (!names.length || names.length > 100) throw new Error('Der Pipedrive-Uploadordner muss 1 bis 100 Dateien enthalten.');
  const results = [];
  for (const fileName of names) {
    const filePath = path.join(absoluteDirectory, fileName);
    const info = await stat(filePath);
    if (!info.isFile() || info.size < 1 || info.size > MAX_FILE_BYTES) throw new Error(`${fileName}: ungültige Dateigröße.`);
    const result = await request(`/device-agent/${DEVICE_ID}/background/pipedrive/deals/${id}/files?name=${encodeURIComponent(fileName)}`, { method: 'POST', body: await readFile(filePath), timeoutMs: 90_000 });
    results.push({ fileName, status: result.alreadyPresent ? 'already_present' : 'uploaded', uploaded: result.uploaded === true,
      verified: result.verified === true && result.contentVerified === true && Boolean(result.fileId),
      contentVerified: result.contentVerified === true, fileId: result.fileId || null, size: result.size ?? null, sha256: result.sha256 || null });
  }
  return { dealId: id, results, uploadedCount: results.filter(item => item.uploaded).length, fullyVerified: results.every(item => item.verified), deletedFromPipedrive: false, source: 'iva-core-pipedrive-api' };
}

export async function listAirtableInstallationQueue({ maxRecords = 500 } = {}) {
  const safeMax = Math.max(1, Math.min(2000, Number(maxRecords) || 500));
  return request(`/device-agent/${DEVICE_ID}/background/airtable/installation-queue?maxRecords=${safeMax}`, { timeoutMs: 60_000 });
}

export async function getAirtableWorkflowRecord(recordId) {
  const id = String(recordId || '').trim();
  if (!/^rec[a-zA-Z0-9]+$/.test(id)) throw new Error('Ungültige Airtable-Record-ID.');
  return request(`/device-agent/${DEVICE_ID}/background/airtable/records/${encodeURIComponent(id)}`);
}

export async function downloadAirtableCorrectedOffer({ recordId, attachmentId } = {}) {
  const record = String(recordId || '').trim();
  const attachment = String(attachmentId || '').trim();
  if (!/^rec[a-zA-Z0-9]+$/.test(record) || !/^att[a-zA-Z0-9]+$/.test(attachment)) throw new Error('Ungültige Airtable-Record- oder Anhangs-ID.');
  const download = await request(`/device-agent/${DEVICE_ID}/background/airtable/records/${encodeURIComponent(record)}/corrected-offer/${encodeURIComponent(attachment)}`, { binary: true, timeoutMs: 60_000 });
  const root = path.join(DATA_ROOT, 'tmp', 'airtable-downloads');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(root, `${record}-`));
  const fileName = safeName(download.disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1] ? decodeURIComponent(download.disposition.match(/filename\*=UTF-8''([^;]+)/i)[1]) : 'angebot-korrigiert.pdf', 'angebot-korrigiert');
  const filePath = path.join(directory, fileName);
  await writeFile(filePath, download.buffer, { mode: 0o600, flag: 'wx' });
  return { recordId: record, attachmentId: attachment, directory, fileName, filePath, size: download.buffer.length, contentType: download.contentType, readOnlySource: true, source: 'iva-core-airtable-api' };
}
