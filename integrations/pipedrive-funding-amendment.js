import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withFundingFileLock } from '../local-mac-helper/funding-intake-state.mjs';
import { buildFundingCalculationNote } from '../local-mac-helper/funding-workflows.mjs';
import { fundingHandoffError, fundingHandoffStage, fundingHandoffSnapshotFingerprint,
  validateFundingHandoffReview, FUNDING_HANDOFF_REVIEW_MAX_AGE_MS } from '../local-mac-helper/funding-handoff-policy.mjs';
import { FUNDING_RULES_VERSION } from '../workspaces/energy-calculations.js';

const id = value => String(value ?? '').trim();
const digest = value => createHash('sha256').update(String(value)).digest('hex');
const sameText = (a, b) => id(a).replace(/\s+/g, ' ') === id(b).replace(/\s+/g, ' ');
const fail = (code, message) => { throw fundingHandoffError(`AMENDMENT_${code}`, message); };

async function load(file) {
  let stat;
  try { stat = await fs.lstat(file); } catch { fail('LEDGER', 'Der eigene abgeschlossene Förderübergabebeleg fehlt.'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 50_000_000) fail('LEDGER', 'Der Förderübergabebeleg ist nicht sicher lesbar.');
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  if (state.version !== 1 || !state.deals || Array.isArray(state.deals)) fail('LEDGER', 'Der Förderübergabebeleg ist ungültig.');
  return state;
}

async function save(file, state) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}

function checkedNote(note, dealId, noteId) {
  if (!note || id(note.noteId) !== noteId || id(note.dealId) !== dealId || typeof note.content !== 'string' || typeof note.text !== 'string')
    fail('NOTE_IDENTITY', 'Die ursprüngliche Fördernotiz gehört nicht eindeutig zum bestätigten Deal.');
  return note;
}

function checkedCalculation(result, proof, now) {
  const calculatedAt = Date.parse(result?.calculatedAt || '');
  if (!Number.isFinite(calculatedAt) || calculatedAt > now + 60_000 || now - calculatedAt > FUNDING_HANDOFF_REVIEW_MAX_AGE_MS
    || result?.rulesVersion !== FUNDING_RULES_VERSION || result?.calculationReady !== true || result?.canUseForFundingNote !== true || result?.isProjection === true)
    fail('CALCULATION', 'Die korrigierte Förderberechnung ist nicht aktuell und freigegeben.');
  if (typeof result.incomeBonusRequested !== 'boolean' || result.incomeBonusRequested !== proof.incomeBonusRequested)
    fail('INCOME_BONUS', 'Neue Berechnung und geprüfter Einkommensbonus-Wunsch widersprechen sich.');
  return buildFundingCalculationNote({ result });
}

function response(record, amendment, alreadyPresent = false) {
  return { dealId: record.dealId, handoffId: record.id, noteId: record.noteId, amendmentId: amendment.id,
    requestId: amendment.requestId, verified: amendment.status === 'completed', updated: amendment.updateAttemptedAt != null,
    alreadyPresent, completedAt: amendment.completedAt || null, stageChanged: false, noteCreated: false };
}

/**
 * Update only the amount note owned by an already completed handoff.
 * readNote({dealId,noteId}) must return {dealId,noteId,content,text}; text is decoded visible text.
 * updateExistingNote must reread/check expectedContentSha256 immediately before the exact PUT.
 * It must never POST/create, transition, or log raw notes; writeAttempted:false means no PUT occurred.
 */
export async function amendPipedriveFundingHandoff(input = {}, dependencies = {}) {
  const { readSnapshot, readNote, updateExistingNote } = dependencies;
  if (![readSnapshot, readNote, updateExistingNote].every(fn => typeof fn === 'function')) fail('DEPENDENCIES', 'Der begrenzte Fördernotiz-Korrekturweg ist nicht verbunden.');
  if (input.confirmation !== 'Pipedrive schreiben') fail('CONFIRMATION', 'Die Schreibbestätigung für die Notizkorrektur fehlt.');
  const dealId = id(input.dealId), noteId = id(input.noteId), handoffId = id(input.handoffId), requestId = id(input.requestId);
  if (!/^\d+$/.test(dealId) || !/^\d+$/.test(noteId) || !handoffId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(requestId))
    fail('IDENTITY', 'Deal, eigener Handoff, ursprüngliche Notiz und stabile Vorgangskennung sind erforderlich.');
  const file = path.resolve(dependencies.file || path.join(process.env.DATA_DIR || '/data', 'pipedrive-funding-handoff.json'));
  const now = dependencies.now || Date.now, at = () => new Date(now()).toISOString();
  return withFundingFileLock(file, async () => {
    const state = await load(file), record = state.deals[dealId];
    if (!record || record.status !== 'completed' || id(record.dealId) !== dealId || id(record.id) !== handoffId
      || id(record.noteId) !== noteId || !record.stageVerifiedAt || !record.completedAt || !record.noteText || !record.proof?.fingerprint)
      fail('OWNERSHIP', 'Nur die eigene Notiz einer nachgewiesen abgeschlossenen Förderübergabe darf korrigiert werden.');
    const snapshot = await readSnapshot(dealId);
    if (id(snapshot?.dealId) !== dealId || fundingHandoffStage(snapshot) !== 18) fail('STAGE', 'Die bestätigte Beantragungsphase oder Dealidentität hat sich geändert.');
    const fingerprint = fundingHandoffSnapshotFingerprint(snapshot);
    let note = checkedNote(await readNote({ dealId, noteId }), dealId, noteId);
    record.amendments ||= [];
    if (!Array.isArray(record.amendments)) fail('LEDGER', 'Die Korrekturhistorie ist ungültig.');
    let amendment = record.amendments.find(item => item.requestId === requestId);
    if (amendment?.status === 'completed') {
      if (record.currentAmendmentId !== amendment.id || !sameText(note.text, amendment.noteText)) fail('NOTE_CHANGED', 'Diese Korrektur wurde inzwischen durch eine weitere Änderung überholt.');
      return response(record, amendment, true);
    }
    if (record.amendments.some(item => item.status !== 'completed' && item !== amendment)) fail('PENDING', 'Zuerst den bereits offenen Korrekturversuch anhand seiner Kennung abschließen.');
    if (amendment && !['prepared', 'update_attempted'].includes(amendment.status)) fail('LEDGER', 'Der gespeicherte Korrekturversuch ist ungültig.');
    if (amendment && fingerprint !== amendment.proof.fingerprint) fail('SOURCE_CHANGED', 'Quellen haben sich seit dem Korrekturversuch erneut geändert; keine erneute Änderung ausführen.');

    if (amendment?.status === 'update_attempted') {
      // An uncertain PUT can only be reconciled. Even unchanged old text does not authorize another PUT.
      if (!sameText(note.text, amendment.noteText)) fail('UNCONFIRMED', 'Der frühere Änderungsversuch ist nicht rückgelesen; ausschließlich weiter rücklesen, nicht erneut schreiben.');
    } else {
      const proof = validateFundingHandoffReview({ dealId, snapshot, documentReview: input.documentReview, now: now() });
      const noteText = checkedCalculation(input.result, proof, now());
      const previousText = record.currentNoteText || record.noteText;
      if (!sameText(note.text, previousText)) fail('NOTE_CHANGED', 'Der aktuelle Notiztext entspricht nicht mehr der eigenen zuletzt bestätigten Fassung.');
      if (!/^[a-f0-9]{64}$/.test(id(input.expectedContentSha256)) || digest(note.content) !== input.expectedContentSha256)
        fail('NOTE_CHANGED', 'Der erwartete Originalinhalt der Notiz wurde nicht bestätigt.');
      if (amendment) {
        if (!sameText(amendment.noteText, noteText) || amendment.expectedContentSha256 !== input.expectedContentSha256)
          fail('RESULT_CHANGED', 'Ein vorbereiteter Korrekturversuch darf nicht durch eine andere Berechnung ersetzt werden.');
      } else {
        if (fingerprint === (record.currentProof?.fingerprint || record.proof.fingerprint)) fail('NO_SOURCE_CHANGE', 'Ohne neue relevante Quellen ist keine erneute Fördernotiz-Korrektur erforderlich.');
        amendment = { id: randomUUID(), requestId, status: 'prepared', preparedAt: at(), proof, noteText,
          previousNoteText: previousText, expectedContentSha256: input.expectedContentSha256,
          resultHash: digest(JSON.stringify(input.result)), previousResultHash: record.currentResultHash || record.resultHash };
        record.amendments.push(amendment);
        await save(file, state);
      }
      if (!sameText(note.text, amendment.noteText)) {
        amendment.status = 'update_attempted'; amendment.updateAttemptedAt = at();
        await save(file, state);
        try {
          await updateExistingNote({ dealId, noteId, text: amendment.noteText, expectedContentSha256: amendment.expectedContentSha256,
            expectedText: amendment.previousNoteText, requestId, confirmation: input.confirmation });
        } catch (error) {
          if (error?.writeAttempted === false) {
            amendment.status = 'prepared'; delete amendment.updateAttemptedAt;
            await save(file, state);
            fail('NOT_ATTEMPTED', 'Die Notizkorrektur wurde vor dem Schreibversuch angehalten; denselben Vorgang mit frischem Prüfbeleg fortsetzen.');
          }
          // Do not persist transport errors or raw note contents; immediately try a safe readback.
        }
        note = checkedNote(await readNote({ dealId, noteId }), dealId, noteId);
        if (!sameText(note.text, amendment.noteText)) fail('UNCONFIRMED', 'Die versuchte Notizkorrektur wurde nicht rückgelesen; kein weiterer Schreibversuch.');
      }
    }
    const after = await readSnapshot(dealId);
    if (id(after?.dealId) !== dealId || fundingHandoffStage(after) !== 18 || fundingHandoffSnapshotFingerprint(after) !== amendment.proof.fingerprint)
      fail('SOURCE_CHANGED', 'Quellen oder Phase haben sich während der Korrektur geändert; Abschluss gezielt abgleichen.');
    amendment.status = 'completed'; amendment.completedAt = at();
    record.currentAmendmentId = amendment.id; record.currentNoteText = amendment.noteText;
    record.currentProof = amendment.proof; record.currentResultHash = amendment.resultHash;
    await save(file, state);
    return response(record, amendment);
  }, { timeoutMs: dependencies.lockTimeoutMs || 180000 });
}
