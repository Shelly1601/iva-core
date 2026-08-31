import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { classifyFundingDocumentName } from './funding-document-extractor.mjs';

const execFileAsync = promisify(execFile);
const DEVICE_ID = 'imac-nadine';
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
  const { stdout } = await execFileAsync('/usr/bin/security', ['find-generic-password', '-a', DEVICE_ID, '-s', KEYCHAIN_SERVICE, '-w'], { timeout: 10_000 });
  const value = String(stdout || '').trim();
  if (value.length < 32) throw new Error('Das iMac-Gerätetoken fehlt im macOS-Schlüsselbund.');
  return value;
}

async function request(pathname, { method = 'GET', body, binary = false, timeoutMs = 30_000 } = {}) {
  const rawBody = Buffer.isBuffer(body);
  const response = await fetch(`${serverUrl()}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(rawBody ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
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
    return { buffer, contentType: String(response.headers.get('content-type') || ''), disposition: String(response.headers.get('content-disposition') || '') };
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

export async function markPipedriveFundingDealWon({ dealId, approvalFileName, confirmApply = false } = {}) {
  if (confirmApply !== true) throw new Error('Der Deal wurde nicht auf „Gewonnen“ gesetzt: confirmApply=true fehlt.');
  const id = String(dealId || '').replace(/\D/g, '');
  return request(`/device-agent/${DEVICE_ID}/background/pipedrive/deals/${id}/won`, { method: 'POST', body: { approvalFileName }, timeoutMs: 90_000 });
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

export async function downloadPipedriveDealFiles({ dealId, fileIds = [] } = {}) {
  const id = String(dealId || '').replace(/\D/g, '');
  if (!id) throw new Error('Für den Pipedrive-Dateidownload fehlt eine gültige Deal-ID.');
  const snapshot = await readPipedriveFundingDeal({ dealId: id });
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
      const download = await request(`/device-agent/${DEVICE_ID}/background/pipedrive/deals/${id}/files/${encodeURIComponent(file.id)}`, { binary: true, timeoutMs: 60_000 });
      const fileName = safeName(file.name, `pipedrive-${file.id}`);
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
    results.push({ fileName, status: result.alreadyPresent ? 'already_present' : 'uploaded', uploaded: result.uploaded === true, verified: result.verified === true, fileId: result.fileId || null });
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
