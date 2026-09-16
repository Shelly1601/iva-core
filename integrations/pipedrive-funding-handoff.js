import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { withFundingFileLock } from '../local-mac-helper/funding-intake-state.mjs';
import { buildFundingCalculationNote } from '../local-mac-helper/funding-workflows.mjs';
import { missingFundingRequiredFields } from '../local-mac-helper/funding-required-fields.mjs';
import { fundingHandoffError, fundingHandoffStage, fundingHandoffSnapshotFingerprint, validateFundingHandoffReview,
  FUNDING_HANDOFF_SOURCE, FUNDING_HANDOFF_TARGET } from '../local-mac-helper/funding-handoff-policy.mjs';
export { fundingHandoffSnapshotFingerprint, validateFundingHandoffReview } from '../local-mac-helper/funding-handoff-policy.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idOf = value => String(value ?? '').trim();

async function load(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 50_000_000) throw fundingHandoffError('LEDGER', 'Der gespeicherte Förderübergabe-Stand ist nicht sicher lesbar.');
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (data.version !== 1 || !data.deals || typeof data.deals !== 'object' || Array.isArray(data.deals)) throw fundingHandoffError('LEDGER', 'Der gespeicherte Förderübergabe-Stand ist ungültig.');
    return data;
  } catch (error) { if (error.code === 'ENOENT') return { version: 1, deals: {} }; throw error; }
}
async function save(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
function response(record, { stageChanged = false, alreadyPresent = false } = {}) {
  return { dealId: record.dealId, handoffId: record.id, stageChanged, stageVerified: Boolean(record.stageVerifiedAt), noteId: record.noteId || null,
    verified: record.status === 'completed', alreadyPresent, fromStageId: 19, toStageId: 18, completedAt: record.completedAt || null };
}
function assertSnapshot(snapshot, dealId) {
  if (idOf(snapshot?.dealId) !== dealId) throw fundingHandoffError('IDENTITY', 'Der frisch gelesene Deal stimmt nicht mit dem Übergabeauftrag überein.');
  if (snapshot.pipeline && !['Auftragsmachbarkeit', '1'].includes(String(snapshot.pipeline))) throw fundingHandoffError('PIPELINE', 'Der Deal gehört nicht zur Förderpipeline.');
  const missing = missingFundingRequiredFields(snapshot);
  if (missing.length) throw fundingHandoffError('REQUIRED_FIELDS', `Vor der Förderübergabe fehlen gespeicherte Pflichtangaben: ${missing.join(', ')}.`);
}

export async function listPendingFundingHandoffs({ file = path.join(process.env.DATA_DIR || '/data', 'pipedrive-funding-handoff.json') } = {}) {
  const state = await load(path.resolve(file));
  return Object.values(state.deals).filter(record => record.status !== 'completed').map(record => ({ dealId: record.dealId, handoffId: record.id,
    status: record.status, preparedAt: record.preparedAt, stageVerifiedAt: record.stageVerifiedAt || null, noteAttemptedAt: record.noteAttemptedAt || null,
    attempts: Number(record.attempts || 0), error: record.lastError || null }));
}

/** Only this durable handoff may publish an amount note after the verified 19 -> 18 transition. */
export async function completePipedriveFundingHandoff(input = {}, dependencies = {}) {
  const { readSnapshot, transition, writeNote } = dependencies;
  if (![readSnapshot, transition, writeNote].every(fn => typeof fn === 'function')) throw fundingHandoffError('DEPENDENCIES', 'Der geprüfte Förderübergabe-Kanal ist nicht vollständig verbunden.');
  if (input.confirmation !== 'Pipedrive schreiben') throw fundingHandoffError('CONFIRMATION', 'Die Pipedrive-Schreibbestätigung fehlt.');
  const dealId = idOf(input.dealId);
  if (!/^\d+$/.test(dealId)) throw fundingHandoffError('IDENTITY', 'Eine eindeutige Deal-ID fehlt.');
  const file = path.resolve(dependencies.file || path.join(process.env.DATA_DIR || '/data', 'pipedrive-funding-handoff.json'));
  const now = dependencies.now || Date.now, at = () => new Date(now()).toISOString();
  return withFundingFileLock(file, async () => {
    const state = await load(file);
    let record = state.deals[dealId], snapshot = await readSnapshot(dealId), stageChanged = false;
    assertSnapshot(snapshot, dealId);
    if (record?.status === 'completed') return response(record, { alreadyPresent: true });
    const stage = fundingHandoffStage(snapshot);
    if (!record && stage !== 19) throw fundingHandoffError('NO_TRANSITION_PROOF', 'Eine Förderhöhen-Notiz entsteht nur beim tatsächlichen Übergang aus „Auftrag eingereicht“ nach „Förderung beantragen“. Für diesen bereits vorgerückten Deal fehlt ein eigener Übergabebeleg.');
    if (!record) {
      const proof = validateFundingHandoffReview({ dealId, snapshot, documentReview: input.documentReview, now: now() });
      if ((input.result?.incomeBonusRequested === true) !== proof.incomeBonusRequested) throw fundingHandoffError('INCOME_BONUS', 'Berechnung und bestätigter Einkommensbonus-Wunsch stimmen nicht überein.');
      const text = buildFundingCalculationNote({ result: input.result });
      const review = input.documentReview;
      record = { id: randomUUID(), dealId, status: 'prepared', preparedAt: at(), proof, resultHash: hash(input.result), noteText: text, attempts: 0,
        documentReview: { dealId, checkedAt: proof.checkedAt, complete: true, sourceNotesChecked: true, incomeBonusRequested: proof.incomeBonusRequested,
          snapshotFingerprint: proof.fingerprint, files: review.files.map(item => ({ fileId: idOf(item.fileId), readable: true, identityVerified: true })),
          documentEvidence: Object.fromEntries(proof.requiredDocumentIds.map(type => [type, 'present_in_pipedrive'])) } };
      state.deals[dealId] = record;
      await save(file, state);
    }
    if (!['prepared', 'transition_attempted', 'stage_verified', 'note_attempted'].includes(record.status) || record.dealId !== dealId)
      throw fundingHandoffError('LEDGER', 'Der gespeicherte Übergabeschritt ist nicht eindeutig.');
    if (record.transitionRejected) throw fundingHandoffError('NO_TRANSITION_PROOF', 'Der Phasenwechsel wurde nicht durch diesen Übergabeauftrag ausgeführt. Keine Förderhöhen-Notiz geschrieben.');
    if (input.result !== undefined && hash(input.result) !== record.resultHash) throw fundingHandoffError('RESULT_CHANGED', 'Für diese begonnene Übergabe liegt bereits eine andere Förderberechnung vor. Die gespeicherte Übergabe zuerst prüfen.');
    if (fundingHandoffSnapshotFingerprint(snapshot) !== record.proof.fingerprint)
      throw fundingHandoffError('CHANGED_DOCUMENTS', 'Dateien oder Dealangaben haben sich während der Förderübergabe geändert. Keine Förderhöhen-Notiz geschrieben; bitte den offenen Übergabestand prüfen.');
    if (stage === 18 && record.status === 'prepared') throw fundingHandoffError('NO_TRANSITION_PROOF', 'Für die vorgefundene Zielphase wurde noch kein eigener Phasenwechsel versucht. Keine Förderhöhen-Notiz geschrieben.');
    if (stage !== 19 && stage !== 18) throw fundingHandoffError('UNEXPECTED_STAGE', 'Der Deal befindet sich nicht mehr in einer zulässigen Übergabephase.');
    if (stage === 19) {
      if (record.stageVerifiedAt) throw fundingHandoffError('STAGE_REVERSED', 'Der Deal wurde nach bestätigter Übergabe zurückgesetzt. Kein automatischer erneuter Phasenwechsel.');
      // A retry always re-reads stage and revalidates a fresh full document proof first.
      const resumedProof = validateFundingHandoffReview({ dealId, snapshot, documentReview: input.documentReview || record.documentReview, now: now() });
      if (resumedProof.incomeBonusRequested !== record.proof.incomeBonusRequested)
        throw fundingHandoffError('INCOME_BONUS', 'Der Einkommensbonus-Wunsch wurde gegenüber der begonnenen Berechnung korrigiert. Keine alte Berechnung mit einem anderen Unterlagenreview weitergeben.');
      record.status = 'transition_attempted'; record.transitionAttemptedAt = at(); record.attempts++;
      await save(file, state);
      let transitionResult, transitionError;
      try { transitionResult = await transition({ dealId, fromStage: FUNDING_HANDOFF_SOURCE, toStage: FUNDING_HANDOFF_TARGET, confirmation: input.confirmation }); }
      catch (error) { transitionError = error; }
      if (!transitionError && transitionResult?.changed !== true) {
        record.transitionRejected = true; record.lastError = 'Der Übergang wurde als unverändert gemeldet und ist kein eigener Phasenwechsel.'; await save(file, state);
        throw fundingHandoffError('NO_TRANSITION_PROOF', record.lastError);
      }
      snapshot = await readSnapshot(dealId); assertSnapshot(snapshot, dealId);
      if (fundingHandoffStage(snapshot) !== 18) {
        record.lastError = 'Der versuchte Phasenwechsel wurde noch nicht in der Zielphase bestätigt.'; await save(file, state);
        throw fundingHandoffError('TRANSITION_UNCONFIRMED', `${record.lastError} Vor einem weiteren Versuch wird der Deal erneut gelesen.`);
      }
      if (fundingHandoffSnapshotFingerprint(snapshot) !== record.proof.fingerprint) throw fundingHandoffError('CHANGED_DOCUMENTS', 'Während des Phasenwechsels haben sich Unterlagen oder Pflichtangaben geändert; die Förderhöhen-Notiz bleibt offen.');
      stageChanged = transitionResult?.changed === true;
      record.transitionProof = { attemptedAt: record.transitionAttemptedAt, readBackAt: at(), fromStageId: 19, toStageId: 18,
        acknowledgement: transitionError ? 'response-uncertain-readback-verified' : 'response-and-readback' };
    } else if (!record.transitionAttemptedAt) throw fundingHandoffError('NO_TRANSITION_PROOF', 'Der eigene persistierte Phasenwechselbeleg fehlt.');
    if (!record.stageVerifiedAt) {
      record.stageVerifiedAt = at(); record.status = 'stage_verified';
      record.transitionProof ||= { attemptedAt: record.transitionAttemptedAt, readBackAt: at(), fromStageId: 19, toStageId: 18, acknowledgement: 'restart-readback-verified' };
      delete record.lastError; await save(file, state);
    }
    // Persist the exact text before a note write. The injected official writer
    // must deduplicate that text and verify it by rereading, including retries.
    const reconcileOnly = Boolean(record.noteAttemptedAt);
    record.status = 'note_attempted'; record.noteAttemptedAt ||= at(); await save(file, state);
    let note;
    try { note = await writeNote({ dealId, text: record.noteText, confirmation: input.confirmation, reconcileOnly }); }
    catch (error) {
      if (!reconcileOnly && error.writeAttempted === false) {
        record.status = 'stage_verified'; delete record.noteAttemptedAt;
        record.lastError = 'Die Notiz konnte noch vor jedem Schreibversuch nicht vorbereitet werden. Derselbe bestätigte Übergabeauftrag darf die Notiz erneut versuchen.';
      } else record.lastError = 'Die Fördernotiz wurde noch nicht rückgelesen. Beim Fortsetzen ausschließlich dieselbe Notiz suchen; keinen weiteren Schreibversuch starten.';
      await save(file, state); throw fundingHandoffError('NOTE_UNCONFIRMED', record.lastError);
    }
    if (note?.verified !== true || !/^\d+$/.test(idOf(note.noteId))) {
      if (!reconcileOnly && note?.writeAttempted === false) { record.status = 'stage_verified'; delete record.noteAttemptedAt; }
      record.lastError = reconcileOnly ? 'Der frühere Notizversuch ist noch nicht sichtbar bestätigt. Es wird ausschließlich rückgelesen, nicht erneut geschrieben.' : 'Die Förderhöhen-Notiz wurde nach dem Speichern nicht eindeutig bestätigt.';
      await save(file, state); throw fundingHandoffError('NOTE_UNCONFIRMED', record.lastError);
    }
    record.noteId = idOf(note.noteId); record.status = 'completed'; record.completedAt = at(); delete record.lastError; await save(file, state);
    return response(record, { stageChanged, alreadyPresent: note.alreadyPresent === true });
  }, { timeoutMs: dependencies.lockTimeoutMs || 180000 });
}
