import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { withFundingFileLock } from './funding-intake-state.mjs';
import { FUNDING_REQUIRED_FIELDS, missingFundingRequiredFields } from './funding-required-fields.mjs';
import { hasStoredKfwCustomerCredentials } from './funding-kfw-credentials.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = value => typeof value === 'string' ? value.trim() : '';
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function defaultFundingCaseReviewFile() {
  return path.join(process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper'), 'funding-case-reviews.json');
}

export function fundingFileSourceState(file = {}) {
  return { id: String(file.id || ''), name: file.name || null, size: Number(file.size || 0), mimeType: file.mimeType || null,
    updatedAt: file.updatedAt || null, createdAt: file.createdAt || null };
}

export function fundingCaseSourceState(snapshot = {}) {
  return {
    version: 1, dealId: String(snapshot.dealId || ''), stage: snapshot.stage || null,
    customerPersonId: snapshot.customerPersonId || null, customerName: snapshot.customerName || null,
    orderNumber: snapshot.orderNumber || null, incomeBonusRequested: snapshot.incomeBonusRequested ?? null,
    location: snapshot.location || null, vpPersonId: snapshot.vpPersonId || null, vpName: snapshot.vpName || null, vpEmail: snapshot.vpEmail || null,
    requiredFields: FUNDING_REQUIRED_FIELDS.map(({ key }) => [key, snapshot[key] ?? null, snapshot.requiredFieldSources?.[key] ?? null]),
    files: (snapshot.fileRecords || []).map(fundingFileSourceState).sort((a, b) => a.id.localeCompare(b.id)),
    // The content digest catches edits/deletions which a latest timestamp or count cannot prove unchanged.
    notesFingerprint: snapshot.fundingHandoffNotesFingerprint || null,
    noteCount: snapshot.noteCount ?? null, latestNoteAt: snapshot.latestNoteAt || null,
    kfwAccountConfirmedByCredentials: snapshot.kfwAccountConfirmedByCredentials === true,
    kfwCredentialEvidenceNoteIds: [...(snapshot.kfwCredentialEvidenceNoteIds || [])].map(String).sort(),
    kfwCredentialInvalidationNoteIds: [...(snapshot.kfwCredentialInvalidationNoteIds || [])].map(String).sort(),
  };
}

export function fundingDocumentReviewFingerprint(snapshot = {}) {
  return hash(fundingCaseSourceState(snapshot));
}

export async function loadFundingCaseReviews(file = defaultFundingCaseReviewFile()) {
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    if (state.version !== 1 || !state.deals || typeof state.deals !== 'object' || Array.isArray(state.deals)) throw new Error('Der gespeicherte Förder-Prüfstand ist ungültig.');
    return state;
  } catch (error) { if (error.code !== 'ENOENT') throw error; return { version: 1, deals: {} }; }
}

function sameIdentity(previous, current) {
  return previous && ['dealId', 'customerPersonId', 'customerName', 'orderNumber'].every(key => previous[key] === current[key]);
}

function reusableFileEvidence(record, sourceState) {
  if (!sameIdentity(record?.sourceState, sourceState)) return [];
  return (record.files || []).filter(proof => sourceState.files.some(file => file.id === proof.fileId && hash(file) === proof.sourceFingerprint));
}

export function assessFundingCaseReview(snapshot, record, { now = Date.now(), changedByMail = false } = {}) {
  const sourceState = fundingCaseSourceState(snapshot), fingerprint = hash(sourceState);
  const sourceUnavailable = !Array.isArray(snapshot.fileRecords) || !/^[0-9a-f]{64}$/.test(sourceState.notesFingerprint || '');
  const sourceChanged = !!record && (record.fingerprint !== fingerprint || sourceUnavailable);
  const due = !!record?.nextReviewAt && Date.parse(record.nextReviewAt) <= now;
  const previousEvidence = reusableFileEvidence(record, sourceState);
  const reusableDocumentEvidence = previousEvidence.filter(item => item.status === 'reviewed');
  const sourceReviewRequired = !record || sourceChanged || sourceUnavailable || changedByMail;
  const missingStoredKfwCredentials = !hasStoredKfwCustomerCredentials(snapshot);
  const credentialReviewRequired = record?.completeness === 'complete' && missingStoredKfwCredentials;
  const documentIdsRequiringReview = sourceState.files.filter(file => !previousEvidence.some(proof => proof.fileId === file.id)).map(file => file.id);
  return {
    caseReviewRequired: sourceReviewRequired || due || credentialReviewRequired,
    missingStoredKfwCredentials,
    sourceReviewRequired,
    sourceChanged,
    sourceUnavailable,
    changedByMail,
    due,
    reviewStatus: !record ? 'not_reviewed' : sourceChanged || changedByMail ? 'changed' : due ? 'due' : credentialReviewRequired ? 'credentials_missing' : 'reviewed_unchanged',
    recordedReviewStatus: record?.reviewStatus || null,
    reviewedAt: record?.checkedAt || null,
    reviewCompleteness: credentialReviewRequired ? 'incomplete' : record?.completeness || null,
    // Open points remain visible even when their source has not changed.
    openPoints: record?.openPoints || [],
    nextReviewAt: record?.nextReviewAt || null,
    documentIdsRequiringReview,
    reusableDocumentEvidence,
    blockedDocumentEvidence: previousEvidence.filter(item => item.status === 'blocked'),
    contentFingerprint: fingerprint,
  };
}

function validCheckedAt(value, now) {
  return timestamp(value) && Date.parse(value) <= now + 60_000;
}

function normalizeEvidence(review, sourceState, previous, now) {
  if (!Array.isArray(review.files)) throw new Error('Die Datei-Prüfbelege fehlen.');
  const files = new Map(reusableFileEvidence(previous, sourceState).map(proof => [proof.fileId, proof]));
  const supplied = new Set();
  for (const proof of review.files) {
    const fileId = String(proof?.fileId || ''), source = sourceState.files.find(file => file.id === fileId);
    if (!source || supplied.has(fileId) || !text(proof.evidenceRef) || !validCheckedAt(proof.checkedAt, now)) throw new Error('Ein Datei-Prüfbeleg ist nicht eindeutig auf die aktuelle Dealdatei zurückzuführen.');
    supplied.add(fileId);
    if (proof.status === 'reviewed' && proof.readable === true && proof.identityVerified === true) {
      files.set(fileId, { fileId, status: 'reviewed', sourceFingerprint: hash(source), checkedAt: proof.checkedAt,
        evidenceRef: text(proof.evidenceRef), readable: true, identityVerified: true });
    } else if (proof.status === 'blocked' && text(proof.reason) && text(proof.nextAction)) {
      files.set(fileId, { fileId, status: 'blocked', sourceFingerprint: hash(source), checkedAt: proof.checkedAt,
        evidenceRef: text(proof.evidenceRef), reason: text(proof.reason), nextAction: text(proof.nextAction) });
    } else throw new Error('Die Datei ist weder inhaltlich und auf Identität geprüft noch mit einem konkreten Hindernis dokumentiert.');
  }
  if (sourceState.files.some(file => !files.has(file.id))) throw new Error('Für mindestens eine aktuelle Dealdatei fehlt ein belegter Prüfstand.');
  return [...files.values()].sort((a, b) => a.fileId.localeCompare(b.fileId));
}

export async function recordFundingCaseReview({ snapshot, review } = {}, { file = defaultFundingCaseReviewFile(), now = Date.now() } = {}) {
  const sourceState = fundingCaseSourceState(snapshot), fingerprint = hash(sourceState);
  if (!/^\d+$/.test(sourceState.dealId) || !Array.isArray(snapshot?.fileRecords)
    || sourceState.files.some(item => !/^\d+$/.test(item.id) || !item.name) || new Set(sourceState.files.map(item => item.id)).size !== sourceState.files.length)
    throw new Error('Dem Förder-Prüfstand fehlt ein eindeutiger Deal- und Dateiquellstand.');
  if (review?.snapshotFingerprint !== fingerprint || review.identityVerified !== true || review.sourceNotesChecked !== true || review.requiredFieldsChecked !== true
    || !/^[0-9a-f]{64}$/.test(sourceState.notesFingerprint || '') || review.sourceNotesFingerprint !== sourceState.notesFingerprint || !validCheckedAt(review.checkedAt, now))
    throw new Error('Der Förder-Prüfstand ist nicht durch die aktuellen Quellen, Notizen, Pflichtfelder und Identitätsprüfung belegt.');
  const mail = review.mailEvidence;
  if (mail?.checked !== true || !validCheckedAt(mail.checkedAt, now) || !text(mail.evidenceRef) || !Array.isArray(mail.messageIds)
    || mail.messageIds.some(id => !text(id) || id.length > 1200 || /[\r\n\0]/.test(id)) || new Set(mail.messageIds).size !== mail.messageIds.length)
    throw new Error('Die Prüfung der zugeordneten Mails benötigt einen nachvollziehbaren Quellenbeleg.');
  if (!['reviewed', 'waiting_external'].includes(review.reviewStatus) || !['complete', 'incomplete', 'undetermined'].includes(review.completeness)
    || !Array.isArray(review.openPoints) || review.openPoints.some(point => !text(point?.id) || !text(point.reason) || !text(point.nextAction)))
    throw new Error('Prüfstatus, fachliche Vollständigkeit und offene Punkte müssen getrennt dokumentiert sein.');
  if (review.nextReviewAt != null && !timestamp(review.nextReviewAt)) throw new Error('Der nächste fällige Schritt benötigt einen gültigen Zeitpunkt.');
  const missingRequiredFields = missingFundingRequiredFields(snapshot);
  if (review.completeness === 'complete' && (missingRequiredFields.length || review.openPoints.length)) throw new Error('Ein Fall mit fehlenden Pflichtfeldern oder offenen Punkten darf nicht als vollständig gespeichert werden.');
  if (review.completeness === 'complete' && !hasStoredKfwCustomerCredentials(snapshot)) throw new Error('Für Vollständigkeit fehlt das im zugehörigen Deal gespeicherte und rückgelesene KfW-Kundenzugangspaar.');
  if ((review.reviewStatus === 'waiting_external' || missingRequiredFields.length) && !review.openPoints.length) throw new Error('Ein wartender oder unvollständiger Fall benötigt Hindernis und nächste Aktion.');
  return withFundingFileLock(file, async () => {
    const state = await loadFundingCaseReviews(file);
    const files = normalizeEvidence(review, sourceState, state.deals[sourceState.dealId], now);
    if (files.some(item => item.status === 'blocked') && (review.completeness === 'complete' || !review.openPoints.length)) throw new Error('Eine blockierte Datei muss als offener Punkt erhalten bleiben.');
    const record = { dealId: sourceState.dealId, fingerprint, sourceState, checkedAt: review.checkedAt, recordedAt: new Date(now).toISOString(),
      reviewStatus: review.reviewStatus, completeness: review.completeness, missingRequiredFields, files,
      mailEvidence: { checked: true, checkedAt: mail.checkedAt, messageIds: mail.messageIds, evidenceRef: text(mail.evidenceRef) },
      openPoints: review.openPoints.map(point => ({ id: text(point.id), reason: text(point.reason), nextAction: text(point.nextAction) })),
      nextReviewAt: review.nextReviewAt || null };
    state.deals[sourceState.dealId] = record;
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 }); await rename(temporary, file); }
    finally { await unlink(temporary).catch(() => {}); }
    return { dealId: sourceState.dealId, fingerprint, reviewStatus: record.reviewStatus, completeness: record.completeness,
      openPoints: record.openPoints, recorded: true, handoffVerified: false };
  });
}
