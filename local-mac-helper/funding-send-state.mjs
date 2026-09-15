import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateFundingSendEnvelope } from './funding.mjs';
import { withFundingFileLock } from './funding-intake-state.mjs';

const STATES = new Set(['prepared', 'submitted_unverified', 'sent_verified']);
const queues = new Map();
const MAX_BYTES = 10 * 1024 * 1024;
const plain = value => String(value ?? '').replace(/\r\n?/g, '\n').trim();
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const addresses = rows => (Array.isArray(rows) ? rows : []).map(value => String(value).trim().toLowerCase()).sort();
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function id(value, max = 1200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) throw fail('FUNDING_SEND_IDENTITY', 'Die dauerhafte Identität des Fördervorgangs fehlt.');
  return value.trim();
}
function instant(value, now, { maxAge = Infinity } = {}) {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > now + 60000 || now - time > maxAge) throw fail('FUNDING_SEND_TIME', 'Der überprüfte Zeitpunkt fehlt oder ist nicht mehr aktuell.');
  return new Date(time).toISOString();
}
export function fundingSendIntentId({ type = 'missing-documents', input = {} } = {}) {
  if (!['missing-documents', 'no-response'].includes(type) || !/^[1-9]\d*$/.test(String(input.dealId || '')) || typeof input.dealId === 'number' && !Number.isSafeInteger(input.dealId)) throw fail('FUNDING_SEND_IDENTITY', 'Förder-Mailtyp oder eindeutige Deal-ID fehlt.');
  const documentSet = [...new Set((Array.isArray(input.missingDocumentIds) ? input.missingDocumentIds : []).map(item => id(item, 100)))].sort();
  if (type === 'missing-documents' && !documentSet.length) throw fail('FUNDING_SEND_IDENTITY', 'Die konkret angeforderten Unterlagen fehlen.');
  // Attempt IDs never create a fresh send permission. An escalation remains
  // unique for the actual original Outlook message, even if the document set changes.
  const source = type === 'no-response' ? id(input.originalMessageId) : documentSet;
  return 'funding-send-' + hash([type, String(input.dealId), source]);
}
async function nativeVerify(input) {
  const { verifyFundingSentMessage } = await import('./outlook-ui-mailbox.mjs');
  return verifyFundingSentMessage(input);
}

export function createFundingSendStore({ filePath = path.join(process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library/Application Support/IVA Mac Helper'), 'funding-send-state.json'), now = Date.now, validate = validateFundingSendEnvelope, verifySent = nativeVerify, readSentById = nativeVerify } = {}) {
  const file = path.resolve(filePath), time = () => Number(now()), stamp = () => new Date(time()).toISOString();
  async function load() {
    try {
      const raw = await readFile(file, 'utf8'); if (Buffer.byteLength(raw) > MAX_BYTES) throw fail('FUNDING_SEND_STORE', 'Der Förder-Versandstatus ist zu groß.');
      const state = JSON.parse(raw);
      if (state.version !== 1 || !Array.isArray(state.intents) || state.intents.some(row => !/^funding-send-[a-f0-9]{64}$/.test(row.intentId) || !STATES.has(row.state))) throw fail('FUNDING_SEND_STORE', 'Der Förder-Versandstatus ist beschädigt; vorhandene Einträge bleiben unverändert.');
      return state;
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, intents: [] }; throw error; }
  }
  async function mutate(action) {
    let result;
    const operation = (queues.get(file) || Promise.resolve()).catch(() => {}).then(() => withFundingFileLock(file, async () => {
      const state = await load(); result = await action(state);
      const raw = JSON.stringify(state); if (Buffer.byteLength(raw) > MAX_BYTES) throw fail('FUNDING_SEND_STORE', 'Der Förder-Versandstatus ist voll; keine neue Sendefreigabe wurde erteilt.');
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = file + '.' + randomUUID() + '.tmp';
      try {
        const handle = await open(temporary, 'wx', 0o600); try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, file);
        const directory = await open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); }
      } finally { await unlink(temporary).catch(() => {}); }
    }));
    queues.set(file, operation); await operation; return structuredClone(result);
  }
  function select(state, intentId) { const row = state.intents.find(item => item.intentId === intentId); if (!row) throw fail('FUNDING_SEND_NOT_FOUND', 'Der dauerhafte Förder-Versandvorgang wurde nicht gefunden.'); return row; }
  function output(row, extra = {}) { return { intentId: row.intentId, state: row.state, envelopeHash: row.envelopeHash, maySend: false, alreadySent: row.state === 'sent_verified', requiresReadback: row.state === 'submitted_unverified', createdAt: row.createdAt, submittedAt: row.submittedAt || null, sentProof: row.sentProof || null, ...extra }; }
  async function validated(payload) {
    if (!payload || typeof payload !== 'object' || Buffer.byteLength(JSON.stringify(payload)) > 128 * 1024) throw fail('FUNDING_SEND_INPUT', 'Der konkrete Förderentwurf fehlt oder ist zu groß.');
    const intentId = fundingSendIntentId(payload);
    const reviewedAt = instant(payload.reviewedAt, time(), { maxAge: 5 * 60_000 });
    const prepared = payload.prepared || {};
    if (prepared.bcc !== undefined && (!Array.isArray(prepared.bcc) || prepared.bcc.length) || prepared.attachments !== undefined && !Array.isArray(prepared.attachments) || (payload.type || 'missing-documents') === 'missing-documents' && prepared.introduction !== undefined) throw fail('FUNDING_SEND_INPUT', 'Empfänger, Anlagen oder Inhalt des konkreten Förderentwurfs sind nicht eindeutig.');
    const checked = await validate({ type: payload.type || 'missing-documents', input: payload.input, prepared: payload.prepared, evidence: payload.evidence, now: new Date(time()) });
    if (checked?.verified !== true) throw fail('FUNDING_SEND_VALIDATION', 'Die vollständige Prüfung des Förderentwurfs ist nicht bestätigt.');
    if ((prepared.attachments || []).length) throw fail('FUNDING_SEND_ATTACHMENTS', 'Zusätzliche Anlagen benötigen eine gesondert geprüfte Versandvorlage.');
    const type = payload.type || 'missing-documents';
    const envelope = { from: checked.from, to: addresses(checked.to), cc: addresses(checked.cc), bcc: [], subject: checked.subject,
      body: plain(prepared.introduction || prepared.body), attachments: [],
      ...(type === 'no-response' ? { introduction: plain(prepared.introduction || prepared.body), originalMessageId: id(payload.input.originalMessageId) } : {}) };
    const searchSince = type === 'no-response' ? payload.input.requestSentAt : '2026-08-01T00:00:00+02:00';
    const searchNotBefore = instant(searchSince, time());
    return { intentId, type, dealId: String(payload.input.dealId), envelope, envelopeHash: hash(envelope), reviewedAt, searchNotBefore };
  }
  function prove(row, proof) {
    if (proof?.verified !== true || proof.folder !== 'Gesendet' || !proof.messageId || !proof.sentAt) throw fail('FUNDING_SEND_UNVERIFIED', 'Der Versand ist noch nicht durch eine konkrete Nachricht im Gesendet-Ordner belegt.');
    const sentAt = instant(proof.sentAt, time());
    const expected = row.envelope;
    if (Date.parse(sentAt) < Date.parse(row.searchNotBefore) || String(proof.sender || '').toLowerCase() !== expected.from.toLowerCase()
      || proof.subject !== expected.subject || !equal(addresses(proof.recipients),expected.to) || !Array.isArray(proof.cc) || !equal(addresses(proof.cc),expected.cc)
      || !Array.isArray(proof.bcc) || proof.bcc.length || !Array.isArray(proof.attachments) || proof.attachments.length
      || (expected.originalMessageId ? proof.originalMessageId !== expected.originalMessageId || proof.introductionHash !== hash(expected.introduction) : proof.bodyHash !== hash(expected.body))) throw fail('FUNDING_SEND_PROOF_MISMATCH', 'Die rückgelesene Nachricht passt nicht vollständig zu Absender, Empfängern, Inhalt und Vorgang.');
    const messageId = id(proof.messageId);
    row.state = 'sent_verified'; row.sentProof = { verified: true, folder: 'Gesendet', messageId, sentAt, checkedAt: stamp(), envelopeHash: row.envelopeHash };
    row.updatedAt = stamp(); return true;
  }
  async function lookup(row, { messageId = '' } = {}) {
    const input = { ...row.envelope, notBefore: row.searchNotBefore, notAfter: new Date(time() + 60000).toISOString(), ...(messageId ? { messageId: id(messageId) } : {}) };
    let proof;
    try { proof = await (messageId ? readSentById : verifySent)(input); }
    catch (error) { const causeCode = /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : 'OUTLOOK_READBACK_ERROR'; throw Object.assign(fail('FUNDING_SEND_READBACK_FAILED', 'Die Gesendet-Prüfung ist fehlgeschlagen (' + causeCode + '); vor einem Versand muss der tatsächliche Ausgang geklärt werden.'), { causeCode }); }
    if (proof?.verified === true) { if (messageId && proof.messageId !== messageId) throw fail('FUNDING_SEND_PROOF_MISMATCH', 'Die rückgelesene Outlook-Nachrichten-ID stimmt nicht überein.'); prove(row, proof); return 'sent'; }
    if (proof?.verified === false && proof.reason === 'not_found' && proof.searchComplete === true) {
      instant(proof.checkedAt, time(), { maxAge: 5 * 60_000 }); row.lastSearchAt = stamp(); return 'not_found';
    }
    throw fail('FUNDING_SEND_READBACK_INCOMPLETE', 'Die Gesendet-Suche ist nicht vollständig oder eindeutig; keine Sendefreigabe.');
  }
  async function prepareFundingSend(payload) {
    const checked = await validated(payload);
    return mutate(async state => {
      let row = state.intents.find(item => item.intentId === checked.intentId);
      if (row && row.envelopeHash !== checked.envelopeHash) throw fail('FUNDING_SEND_CONFLICT', 'Dieser Fördervorgang hat bereits einen anderen gespeicherten Entwurf; keine neue Sendefreigabe.');
      if (!row) { row = { ...checked, state: 'prepared', createdAt: stamp(), updatedAt: stamp() }; state.intents.push(row); }
      if (row.state === 'sent_verified') return output(row);
      await lookup(row);
      return output(row, { envelope: row.envelope, readyForPreSubmitReview: row.state === 'prepared' });
    });
  }
  async function markFundingSendSubmitted(intentId, payload) {
    // Full current source/recipient/template review is mandatory, not merely the
    // previous hash. This also reruns seven-day/response checks immediately before send.
    return mutate(async state => {
      const row = select(state,intentId);
      if (row.state !== 'prepared') return output(row);
      const checked = await validated(payload);
      if (checked.intentId !== intentId || checked.envelopeHash !== row.envelopeHash || payload.envelopeHash !== row.envelopeHash) throw fail('FUNDING_SEND_CONFLICT', 'Der aktuelle Entwurf stimmt nicht mit dem gespeicherten Versandvorgang überein.');
      if (row.state !== 'prepared') return output(row);
      if (await lookup(row) === 'sent') return output(row);
      row.state = 'submitted_unverified'; row.submittedAt = stamp(); row.updatedAt = stamp(); row.reviewedAt = checked.reviewedAt;
      return output(row, { maySend: true, envelope: row.envelope });
    });
  }
  async function completeFundingSend(intentId, { messageId = '' } = {}) {
    return mutate(async state => { const row = select(state,intentId); if (row.state === 'sent_verified') return output(row); await lookup(row,{messageId}); return output(row); });
  }
  async function reviewResumption(intentId) {
    return mutate(async state => { const row = select(state,intentId); if(row.state !== 'sent_verified') await lookup(row); return output(row, { readyForPreSubmitReview: row.state === 'prepared' }); });
  }
  return { prepareFundingSend, markFundingSendSubmitted, completeFundingSend, reviewResumption,
    async get(intentId) { return structuredClone(select(await load(),intentId)); }, async list() { return (await load()).intents.map(row=>output(row)); } };
}

let defaultStore;
const store = () => defaultStore ||= createFundingSendStore();
export const prepareFundingSend = (input, options) => (options ? createFundingSendStore(options) : store()).prepareFundingSend(input);
export const markFundingSendSubmitted = (intentId, input, options) => (options ? createFundingSendStore(options) : store()).markFundingSendSubmitted(intentId,input);
export const completeFundingSend = (intentId, input, options) => (options ? createFundingSendStore(options) : store()).completeFundingSend(intentId,input);
export const reviewFundingSendResumption = (intentId, options) => (options ? createFundingSendStore(options) : store()).reviewResumption(intentId);
