import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAILBOX = 'foerderung@heat-hero.com';
const queues = new Map();
const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);
export const FUNDING_BACKFILL_SINCE = '2026-08-01';
export async function withFundingFileLock(file, action, { timeoutMs = 5000 } = {}) {
  const lock = `${path.resolve(file)}.lock`, owner = { pid: process.pid, nonce: randomUUID() }, until = Date.now() + timeoutMs;
  const dead = owner => { if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return false; try { process.kill(owner.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
  const readOwner = () => readFile(path.join(lock, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null);
  const oldEmpty = async owner => !owner && Date.now() - (await stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs > 10000;
  await mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 }); const handle = await open(path.join(lock, 'owner.json'), 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); } finally { await handle.close(); } break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await readOwner();
      if (dead(previous) || await oldEmpty(previous)) {
        const recovery = `${lock}.recovery`;
        try {
          await mkdir(recovery, { mode: 0o700 });
          try { const current = await readOwner(); if (dead(current) || await oldEmpty(current)) { const abandoned = `${lock}.abandoned-${randomUUID()}`; try { await rename(lock, abandoned); await rm(abandoned, { recursive: true, force: true }); } catch (moveError) { if (moveError.code !== 'ENOENT') throw moveError; } } }
          finally { await rm(recovery, { recursive: true, force: true }); }
        } catch (recoveryError) { if (!['EEXIST', 'ENOENT'].includes(recoveryError.code)) throw recoveryError; }
      }
      if (Date.now() >= until) throw Object.assign(new Error('Der Förder-Mailzustand wird gerade aktualisiert; dieselbe offene Aktion später fortsetzen.'), { code: 'FUNDING_INTAKE_BUSY' });
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try { return await action(); } finally { if ((await readOwner())?.nonce === owner.nonce) await rm(lock, { recursive: true, force: true }); }
}
export function fundingIntakeMessageFingerprint(messageId) {
  const id = clean(messageId, 1200);
  if (!id || id.length >= 1200 || /[\r\n\0]/.test(id)) throw new Error('Eine stabile Outlook-Nachrichten-ID fehlt.');
  return createHash('sha256').update(`${MAILBOX}\0${id}`).digest('hex');
}
export function validateFundingIntakeReceipt(input = {}) {
  const messageId = clean(input.messageId, 1200);
  const messageFingerprint = fundingIntakeMessageFingerprint(messageId);
  if (input.messageFingerprint && input.messageFingerprint !== messageFingerprint) throw new Error('Der Mailbeleg gehört nicht zu dieser Outlook-Nachrichten-ID.');
  const dealId = clean(input.dealId, 40);
  if (!/^\d+$/.test(dealId) || input.identityVerified !== true || input.sourceReadComplete !== true || input.ambiguous === true) throw new Error('Die Fördermail wurde noch nicht vollständig gelesen und eindeutig dem Deal zugeordnet.');
  const expectedAttachmentCount = input.expectedAttachmentCount;
  if (!Number.isSafeInteger(expectedAttachmentCount) || expectedAttachmentCount < 0 || expectedAttachmentCount > 200) throw new Error('Die vollständige Anlagenzahl der Fördermail fehlt.');
  const uploadedFiles = (Array.isArray(input.uploadedFiles) ? input.uploadedFiles : []).map(file => ({
    id: clean(file.id || file.fileId, 100), filename: clean(file.filename || file.fileName, 240), dealId: clean(file.dealId, 40), verified: file.verified === true,
  }));
  if (uploadedFiles.some(file => !file.id || !file.filename || !/\.pdf$/i.test(file.filename) || file.dealId !== dealId || !file.verified)
    || expectedAttachmentCount > 0 && (!uploadedFiles.length || input.attachmentProcessingVerified !== true)
    || new Set(uploadedFiles.map(file => file.id)).size !== uploadedFiles.length) throw new Error('Die aufbereiteten Anlagen wurden noch nicht vollständig im richtigen Deal rückgelesen.');
  const textRelevant = input.textRelevant === true;
  const note = input.note ? { id: clean(input.note.id || input.note.noteId, 100), dealId: clean(input.note.dealId, 40), verified: input.note.verified === true } : null;
  if (textRelevant && (!note?.id || note.dealId !== dealId || !note.verified)) throw new Error('Die Informationsnotiz aus der Fördermail wurde noch nicht im richtigen Deal rückgelesen.');
  if (!expectedAttachmentCount && !textRelevant) throw new Error('Ohne belegte Unterlagen oder relevante Information gilt eine Fördermail nicht als bearbeitet.');
  const verifiedAt = clean(input.verifiedAt, 80);
  if (!Number.isFinite(Date.parse(verifiedAt)) || Date.parse(verifiedAt) > Date.now() + 60000) throw new Error('Der Rücklesezeitpunkt der Fördermail fehlt.');
  return { messageId, messageFingerprint, dealId, identityVerified: true, sourceReadComplete: true, expectedAttachmentCount,
    attachmentProcessingVerified: expectedAttachmentCount === 0 || input.attachmentProcessingVerified === true,
    uploadedFiles, textRelevant, note, verifiedAt };
}

export function createFundingIntakeStore({ filePath = path.join(process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper'), 'funding-intake.json'), now = Date.now } = {}) {
  const file = path.resolve(filePath);
  const empty = () => ({ version: 1, backfill: { since: FUNDING_BACKFILL_SINCE, status: 'not_started', cursor: null, checkpoint: null }, incremental: { cursor: null, checkpoint: null, complete: false }, messages: [] });
  async function load() {
    try { const body = await readFile(file, 'utf8'); if (Buffer.byteLength(body) > 10 * 1024 * 1024) throw new Error('Der Förder-Mailzustand ist zu groß.'); const value = JSON.parse(body); if (value.version !== 1 || !Array.isArray(value.messages) || !value.backfill || !value.incremental) throw new Error('Der Förder-Mailzustand ist ungültig.'); return value; }
    catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
  }
  async function mutate(action) {
    let result;
    const next = (queues.get(file) || Promise.resolve()).catch(() => {}).then(() => withFundingFileLock(file, async () => {
      const state = await load(); result = await action(state);
      const body = JSON.stringify(state, null, 2); if (Buffer.byteLength(body) > 10 * 1024 * 1024) throw new Error('Der Förder-Mailzustand ist voll; offene Nachrichten bleiben erhalten.');
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { const handle = await open(temporary, 'wx', 0o600); try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); } await rename(temporary, file); } finally { await unlink(temporary).catch(() => {}); }
    }));
    queues.set(file, next); await next; return result;
  }
  function selectRun(state, requestedMode) {
    if (state.backfill.status === 'running' || requestedMode === 'initial-backfill') return { mode: 'initial-backfill', since: state.backfill.since, cursor: state.backfill.status === 'completed' ? null : state.backfill.cursor, scanComplete: ['scanned', 'completed'].includes(state.backfill.status), checkpoint: state.backfill.checkpoint };
    if (!state.incremental.checkpoint && !state.backfill.checkpoint) throw Object.assign(new Error('Der einmalige Förder-Rücklauf muss vor dem täglichen Delta-Abruf gestartet werden.'), { code: 'FUNDING_INITIAL_BACKFILL_REQUIRED' });
    return { mode: 'incremental', since: null, cursor: state.incremental.cursor || state.incremental.checkpoint || state.backfill.checkpoint, scanComplete: false };
  }
  function finishBackfill(state) {
    if (state.backfill.status === 'scanned' && !state.messages.some(item => item.backfill && item.status !== 'completed')) { state.backfill.status = 'completed'; state.backfill.completedAt = new Date(now()).toISOString(); }
  }
  return {
    async begin({ mode = 'incremental', since } = {}) {
      if (!['incremental', 'initial-backfill'].includes(mode) || since && (mode !== 'initial-backfill' || since !== FUNDING_BACKFILL_SINCE)) throw new Error('Ungültiger Förder-Mailzeitraum.');
      return mutate(state => {
        if (mode === 'initial-backfill' && state.backfill.status === 'not_started') { state.backfill.status = 'running'; state.backfill.startedAt = new Date(now()).toISOString(); }
        const run = selectRun(state, mode);
        if (run.mode === 'incremental' && !state.incremental.cursor) {
          state.incremental.complete = false; state.incremental.scannedAt = null;
          state.incremental.runId = randomUUID(); state.incremental.startedAt = new Date(now()).toISOString();
        }
        return { ...run, runId: run.mode === 'incremental' ? state.incremental.runId : 'initial-backfill', pending: state.messages.filter(item => item.status !== 'completed') };
      });
    },
    async recordPage(page, { mode, expectedCursor = null } = {}) {
      if (!['incremental', 'initial-backfill'].includes(mode) || page?.coverageVerified !== true || page?.source !== 'outlook-native' || !Array.isArray(page.messages) || page.messages.length > 500 || typeof page.complete !== 'boolean') throw new Error('Die vollständige native Outlook-Seite ist nicht belegt.');
      for (const cursor of [page.nextCursor, page.checkpoint]) if (cursor != null && (typeof cursor !== 'string' || cursor.length > 8000 || /[\r\n\0]/.test(cursor))) throw new Error('Ungültiger Outlook-Lesecursor.');
      if (page.complete && (!page.checkpoint || page.nextCursor)) throw new Error('Ein vollständig gelesener Snapshot benötigt einen eindeutigen Abschluss-Checkpoint.');
      if (!page.complete && !page.nextCursor) throw new Error('Ein unvollständiger Mailabruf benötigt einen Fortsetzungscursor.');
      return mutate(state => {
        const run = selectRun(state, mode);
        if (run.mode !== mode || run.scanComplete || (run.cursor || null) !== expectedCursor) throw new Error('Der Mailcursor wurde bereits fortgesetzt; zuerst den gespeicherten Stand lesen.');
        const discovered = [];
        for (const raw of page.messages) {
          const messageId = clean(raw.messageId, 1200), fingerprint = fundingIntakeMessageFingerprint(messageId);
          const receivedAt = clean(raw.receivedAt, 80);
          if (!Number.isFinite(Date.parse(receivedAt))) throw new Error('Der Empfangszeitpunkt einer Fördermail fehlt.');
          if (mode === 'initial-backfill' && Date.parse(receivedAt) < Date.parse(`${FUNDING_BACKFILL_SINCE}T00:00:00+02:00`)) continue;
          let item = state.messages.find(entry => entry.fingerprint === fingerprint);
          if (!item) { item = { messageId, fingerprint, receivedAt, hasAttachments: raw.hasAttachments === true, status: 'pending', backfill: mode === 'initial-backfill', discoveredAt: new Date(now()).toISOString() }; state.messages.push(item); }
          if (item.status !== 'completed') discovered.push({ ...item, description: typeof raw.description === 'string' ? raw.description.slice(0, 5000) : '' });
        }
        const target = mode === 'initial-backfill' ? state.backfill : state.incremental;
        target.cursor = page.nextCursor || null;
        if (page.checkpoint) target.checkpoint = page.checkpoint;
        if (page.complete) { if (mode === 'initial-backfill') target.status = 'scanned'; else target.complete = true; target.scannedAt = new Date(now()).toISOString(); }
        finishBackfill(state);
        return { messages: discovered, nextCursor: target.cursor, scanComplete: page.complete, backfillStatus: state.backfill.status, pendingCount: state.messages.filter(item => item.status !== 'completed').length };
      });
    },
    async completeMessage(input) {
      const receipt = validateFundingIntakeReceipt(input);
      if (input.moveVerified !== true) throw new Error('Die Fördermail wurde noch nicht im Ordner Fertig rückgelesen.');
      return mutate(state => {
        const item = state.messages.find(entry => entry.fingerprint === receipt.messageFingerprint);
        if (!item) throw new Error('Die Nachricht fehlt im dauerhaften Förder-Maileingang.');
        if (item.status === 'completed') { if (item.receipt?.dealId !== receipt.dealId) throw new Error('Die Fördermail darf keinem anderen Deal zugeordnet werden.'); return { alreadyCompleted: true, fingerprint: item.fingerprint }; }
        if (item.hasAttachments && receipt.expectedAttachmentCount === 0) throw new Error('Die Anlagen dieser Fördermail sind noch nicht verarbeitet.');
        Object.assign(item, { status: 'completed', completedAt: new Date(now()).toISOString(), receipt }); finishBackfill(state);
        return { alreadyCompleted: false, fingerprint: item.fingerprint, backfillStatus: state.backfill.status };
      });
    },
    async status() { const state = await load(); return { ...state, pending: state.messages.filter(item => item.status !== 'completed') }; },
  };
}
