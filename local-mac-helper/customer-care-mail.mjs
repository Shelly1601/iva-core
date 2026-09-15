import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeDraftPayload } from './outlook.mjs';
import { runMacUiBridge, selectExactOutlookComposeSender, fillVerifiedOutlookCompose } from './macos-ui.mjs';
import { verifyFundingSentMessage } from './outlook-ui-mailbox.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, code = 'CUSTOMER_CARE_MAIL_INVALID') => Object.assign(new Error(message), { code });
const emailPattern = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}$/i;
const normalizedBody = value => value.replace(/\r\n/g, '\n').trim();
const emptyList = value => value === undefined || Array.isArray(value) && value.length === 0;
const identity = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,180}$/.test(value);
const envelopeHash = envelope => hash(JSON.stringify(envelope));

function timestamp(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m || Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59) return null;
  const day = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== `${m[1]}-${m[2]}-${m[3]}`) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

export function validateCustomerCareEnvelope(value, outboxId, projectId) {
  if (!identity(outboxId) || !identity(projectId) || !value || value.outboxId !== outboxId || value.projectId !== projectId) throw fail('Der Versandauftrag stimmt nicht mit der Kundenbetreuung überein.');
  if (value.html || !emptyList(value.attachments) || !emptyList(value.cc) || !emptyList(value.bcc) || !Array.isArray(value.to) || value.to.length !== 1) throw fail('Kundenbetreuung benötigt genau einen Empfänger ohne Cc, Bcc oder Anlagen.');
  if (typeof value.body !== 'string' || typeof value.subject !== 'string' || !emailPattern.test(value.from) || typeof value.from !== 'string' || !emailPattern.test(value.to[0]) || typeof value.to[0] !== 'string') throw fail('Vorlage, Absender oder Empfänger sind ungültig.');
  if (/[\0\r\n]/.test(value.subject) || /\0|\r(?!\n)/.test(value.body) || value.body !== value.body.trim() || value.subject !== value.subject.trim()) throw fail('Die Versandvorlage enthält ungültige Steuerzeichen oder nicht normalisierte Ränder.');
  const envelope = normalizeDraftPayload(value);
  if (envelope.body !== value.body || envelope.subject !== value.subject) throw fail('Die Versandvorlage wurde unzulässig gekürzt oder verändert.');
  return { ...envelope, body: normalizedBody(envelope.body), outboxId, projectId };
}

async function temporaryEnvelope(envelope, operation) {
  const dir = path.join(os.homedir(), 'Library/Application Support/IVA Mac Helper/tmp');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, randomUUID() + '.json');
  try {
    await fs.writeFile(file, JSON.stringify(envelope), { mode: 0o600, flag: 'wx' });
    return await operation(file);
  } finally { await fs.rm(file, { force: true }); }
}

async function compose(envelope, { resuming = false } = {}) {
  if (resuming) {
    try {
      const existing = await temporaryEnvelope(envelope, file => runMacUiBridge(['verify-text-compose', file], { timeoutMs: 30000 }));
      if (existing?.verified === true) return existing;
    } catch (error) {
      // Only a definite compose mismatch permits creating a new, unsent draft.
      if (!String(error.message).includes('CUSTOMER_CARE_COMPOSE_MISMATCH')) throw error;
    }
  }
  await runMacUiBridge(['new-message'], { timeoutMs: 30000 });
  await selectExactOutlookComposeSender(envelope.from);
  await runMacUiBridge(['replace-text-app-and-confirm', 'AXTextField', 'toTextField', envelope.to[0]], { timeoutMs: 30000 });
  await fillVerifiedOutlookCompose(envelope);
  return temporaryEnvelope(envelope, file => runMacUiBridge(['verify-text-compose', file], { timeoutMs: 30000 }));
}
const submit = envelope => temporaryEnvelope(envelope, file => runMacUiBridge(['send-verified-text-compose', file], { timeoutMs: 60000 }));

export function validateCustomerCareSentProof(proof, record, checkedNow = Date.now()) {
  const envelope = record.envelope;
  const before = timestamp(record.notBefore), after = timestamp(record.notAfter), sentAt = timestamp(proof?.sentAt), checkedAt = timestamp(proof?.checkedAt);
  if (!envelope || before === null || after === null || sentAt === null || checkedAt === null || after < before || after - before > 11 * 60_000 || sentAt < before || sentAt > after || checkedAt < sentAt || checkedAt > checkedNow + 60_000) return false;
  return proof?.verified === true && /^<[^\s<>]{1,500}@[^\s<>]{1,250}>$/.test(String(proof.messageId || ''))
    && proof.folder === 'Gesendet' && proof.sender === envelope.from && proof.subject === envelope.subject
    && Array.isArray(proof.recipients) && proof.recipients.length === 1 && proof.recipients[0] === envelope.to[0]
    && Array.isArray(proof.cc) && proof.cc.length === 0 && Array.isArray(proof.bcc) && proof.bcc.length === 0
    && Array.isArray(proof.attachments) && proof.attachments.length === 0 && proof.bodyType === 'text/plain'
    && proof.bodyHash === hash(normalizedBody(envelope.body));
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeRecord(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`, handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  try { await fs.rename(temporary, file); await syncDirectory(path.dirname(file)); }
  finally { await fs.rm(temporary, { force: true }); }
}
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
async function acquire(file) {
  const lock = file + '.lock', token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      try { await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { mode: 0o600, flag: 'wx' }); }
      catch (error) { await fs.rm(lock, { recursive: true, force: true }); throw error; }
      return async () => {
        const owner = await fs.readFile(path.join(lock, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null);
        if (owner?.token === token) await fs.rm(lock, { recursive: true, force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await fs.readFile(path.join(lock, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null);
      const info = await fs.stat(lock).catch(() => null);
      if (owner && !processAlive(owner.pid) || !owner && info && Date.now() - info.mtimeMs > 60_000) {
        const stale = `${lock}.stale-${token}`;
        try { await fs.rename(lock, stale); await fs.rm(stale, { recursive: true, force: true }); continue; }
        catch (renameError) { if (renameError.code === 'ENOENT') continue; throw renameError; }
      }
      throw fail('Dieser Kundenbetreuungs-Versand wird bereits geprüft.', 'CUSTOMER_CARE_MAIL_BUSY');
    }
  }
  throw fail('Die Versand-Sperre konnte nicht übernommen werden.', 'CUSTOMER_CARE_MAIL_BUSY');
}

export function createCustomerCareMailExecutor({ dataDir = process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library/Application Support/IVA Mac Helper'), getEnvelope, prepare = compose, send = submit, verify = verifyFundingSentMessage, now = Date.now } = {}) {
  const root = path.join(dataDir, 'customer-care-delivery');
  const currentTime = () => { const value = Number(now()); if (!Number.isFinite(value)) throw fail('Die lokale Uhrzeit ist ungültig.'); return value; };
  return async payload => {
    if (!identity(payload?.outboxId) || !identity(payload?.projectId)) throw fail('Ungültige Kundenbetreuungs-ID.');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, hash(JSON.stringify([payload.projectId, payload.outboxId])) + '.json');
    const release = await acquire(file);
    try {
      let record;
      try { record = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw fail('Das Versandjournal ist beschädigt; es wird nicht neu gesendet.', 'CUSTOMER_CARE_MAIL_JOURNAL_INVALID'); }
      if (record && (record.version !== 1 || record.projectId !== payload.projectId || record.outboxId !== payload.outboxId || !['prepared', 'preparing', 'attempted', 'sent', 'canceled'].includes(record.status))) throw fail('Das Versandjournal passt nicht zum Auftrag.', 'CUSTOMER_CARE_MAIL_JOURNAL_INVALID');
      if (record?.status === 'sent') {
        if (record.receipt?.status !== 'sent' || record.receipt?.verified !== true || record.receipt?.outboxId !== payload.outboxId || !record.receipt?.messageId) throw fail('Die gespeicherte Versandbestätigung ist unvollständig.', 'CUSTOMER_CARE_MAIL_JOURNAL_INVALID');
        return { receipt: record.receipt };
      }
      if (record?.status === 'canceled') return { receipt: record.receipt };
      const readFresh = async () => {
        try { return validateCustomerCareEnvelope(await getEnvelope(payload.outboxId), payload.outboxId, payload.projectId); }
        catch (error) {
          if (error.code !== 'CUSTOMER_CARE_NOT_ELIGIBLE') throw error;
          record = { version: 1, projectId: payload.projectId, outboxId: payload.outboxId, status: 'canceled', canceledAt: new Date(currentTime()).toISOString(), receipt: { status: 'canceled', outboxId: payload.outboxId, error: 'Versandregeln sind nicht mehr erfüllt.' } };
          await writeRecord(file, record);
          return null;
        }
      };
      if (!record) {
        const envelope = await readFresh();
        if (!envelope) return { receipt: record.receipt };
        record = { version: 1, projectId: payload.projectId, outboxId: payload.outboxId, status: 'prepared', envelope, envelopeHash: envelopeHash(envelope), createdAt: new Date(currentTime()).toISOString() };
        await writeRecord(file, record);
      }
      const validated = validateCustomerCareEnvelope(record.envelope, payload.outboxId, payload.projectId);
      if (record.envelopeHash !== envelopeHash(validated)) throw fail('Der gespeicherte Versandtext wurde verändert.', 'CUSTOMER_CARE_MAIL_JOURNAL_INVALID');
      if (record.status === 'prepared' || record.status === 'preparing') {
        const fresh = await readFresh();
        if (!fresh) return { receipt: record.receipt };
        if (envelopeHash(fresh) !== record.envelopeHash) throw fail('Die Vorlage wurde geändert; erneute Planung erforderlich.', 'CUSTOMER_CARE_MAIL_TEMPLATE_CHANGED');
        const resuming = record.status === 'preparing';
        record.status = 'preparing'; await writeRecord(file, record);
        await prepare(record.envelope, { resuming });
        // Rules can change while Outlook opens. Recheck immediately before the durable send intent.
        const ready = await readFresh();
        if (!ready) return { receipt: record.receipt };
        if (envelopeHash(ready) !== record.envelopeHash) throw fail('Die Vorlage wurde während der Vorbereitung geändert.', 'CUSTOMER_CARE_MAIL_TEMPLATE_CHANGED');
        const attemptedAt = currentTime();
        record.status = 'attempted'; record.attemptedAt = new Date(attemptedAt).toISOString();
        record.notBefore = new Date(attemptedAt - 5000).toISOString(); record.notAfter = new Date(attemptedAt + 10 * 60_000).toISOString();
        await writeRecord(file, record);
        try { await send(record.envelope); }
        catch (error) { record.sendErrorCode = String(error.code || 'OUTLOOK_SEND_UNCERTAIN').slice(0, 100); await writeRecord(file, record); }
      }
      if (timestamp(record.notBefore) === null || timestamp(record.notAfter) === null) throw fail('Das gespeicherte Versandzeitfenster ist ungültig.', 'CUSTOMER_CARE_MAIL_JOURNAL_INVALID');
      let proof;
      try { proof = await verify({ ...record.envelope, notBefore: record.notBefore, notAfter: record.notAfter }); }
      catch (error) {
        record.lastVerificationError = String(error.code || 'OUTLOOK_SENT_READ_FAILED').slice(0, 100); record.lastCheckedAt = new Date(currentTime()).toISOString(); await writeRecord(file, record);
        return { receipt: { status: 'uncertain', outboxId: payload.outboxId, retryReadbackOnly: true, errorCode: record.lastVerificationError, error: 'Der Versandversuch ist gespeichert. Die Prüfung der Originalmail wird ohne erneutes Senden fortgesetzt.' } };
      }
      if (!validateCustomerCareSentProof(proof, record, currentTime())) {
        record.lastCheckedAt = new Date(currentTime()).toISOString(); await writeRecord(file, record);
        return { receipt: { status: 'uncertain', outboxId: payload.outboxId, retryReadbackOnly: true, error: 'Die Originalmail im Gesendet-Ordner ist noch nicht vollständig und eindeutig bestätigt.' } };
      }
      record.receipt = { status: 'sent', verified: true, messageId: proof.messageId, recipient: record.envelope.to[0], sender: record.envelope.from, from: record.envelope.from, sentAt: proof.sentAt, checkedAt: proof.checkedAt, envelopeHash: record.envelopeHash, bodyHash: proof.bodyHash, provider: 'outlook-native', outboxId: payload.outboxId };
      record.status = 'sent'; delete record.envelope; await writeRecord(file, record);
      return { receipt: record.receipt };
    } finally { await release(); }
  };
}
