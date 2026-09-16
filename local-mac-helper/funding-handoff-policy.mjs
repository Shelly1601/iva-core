import { createHash } from 'node:crypto';
import { missingFundingRequiredFields } from './funding-required-fields.mjs';

export const FUNDING_HANDOFF_SOURCE = 'Auftrag eingereicht / Förderunterlagen einreichen';
export const FUNDING_HANDOFF_TARGET = 'Förderung beantragen';
export const FUNDING_HANDOFF_REVIEW_MAX_AGE_MS = 30 * 60_000;
const requiredDocuments = ['signed_offer', 'identity_card', 'registration_certificate', 'land_register', 'kfw_account_confirmation'];
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
export const fundingHandoffError = (code, message) => Object.assign(new Error(message), { code: `FUNDING_HANDOFF_${code}`, status: 409 });

export function fundingHandoffStage(snapshot = {}) {
  const label = clean(snapshot.stage).toLocaleLowerCase('de-DE');
  if (/^(?:auftrag|antrag) eingereicht \/ förderunterlagen(?: einreichen)?$/.test(label)) return 19;
  if (['förderung beantragen', 'förderung beantragt'].includes(label)) return 18;
  return null;
}

/** Stage and our own newly added note do not invalidate an otherwise identical handoff. */
export function fundingHandoffSnapshotFingerprint(snapshot = {}) {
  const files = (Array.isArray(snapshot.fileRecords) ? snapshot.fileRecords : []).map(file => [clean(file.id), clean(file.name), Number(file.size), file.updatedAt || null])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return createHash('sha256').update(JSON.stringify({ dealId: clean(snapshot.dealId), personId: clean(snapshot.customerPersonId),
    orderNumber: clean(snapshot.orderNumber), customerEmail: clean(snapshot.customerEmail), phoneNumber: clean(snapshot.phoneNumber), plant: clean(snapshot.plant),
    incomeBonusRequested: snapshot.incomeBonusRequested ?? null, requiredFieldSources: snapshot.requiredFieldSources || null,
    fundingHandoffNotesFingerprint: snapshot.fundingHandoffNotesFingerprint ?? null,
    kfwAccountConfirmedByCredentials: snapshot.kfwAccountConfirmedByCredentials === true, files })).digest('hex');
}

export function validateFundingHandoffReview({ dealId, snapshot, documentReview, now = Date.now() } = {}) {
  const id = clean(dealId), review = documentReview;
  if (!/^\d+$/.test(id) || clean(snapshot?.dealId) !== id || clean(review?.dealId) !== id) throw fundingHandoffError('IDENTITY', 'Unterlagenprüfung und Deal müssen eindeutig zusammengehören.');
  const timestamp = new Date(now).getTime(), checkedAt = Date.parse(review?.checkedAt || '');
  if (!Number.isFinite(timestamp) || !Number.isFinite(checkedAt) || checkedAt > timestamp + 60_000 || timestamp - checkedAt > FUNDING_HANDOFF_REVIEW_MAX_AGE_MS)
    throw fundingHandoffError('STALE_REVIEW', 'Die vollständige Unterlagenprüfung muss aus den letzten 30 Minuten stammen.');
  if (review.complete !== true || review.sourceNotesChecked !== true || typeof review.incomeBonusRequested !== 'boolean')
    throw fundingHandoffError('INCOMPLETE_REVIEW', 'Vollständigkeit, menschliche Notizen und ausdrücklicher Einkommensbonus-Wunsch sind noch nicht geprüft.');
  if (snapshot.incomeBonusRequested === true && review.incomeBonusRequested !== true)
    throw fundingHandoffError('INCOME_BONUS', 'Ein gespeicherter Einkommensbonus-Wunsch darf in der Unterlagenprüfung nicht übergangen werden.');
  const missing = missingFundingRequiredFields(snapshot);
  if (missing.length) throw fundingHandoffError('REQUIRED_FIELDS', `Vor der Förderübergabe fehlen gespeicherte Pflichtangaben: ${missing.join(', ')}.`);
  const files = snapshot.fileRecords, reviewed = review.files;
  if (!Array.isArray(files) || !files.length || files.some(file => !/^\d+$/.test(clean(file.id))) || !Array.isArray(reviewed)
    || reviewed.length !== files.length || new Set(reviewed.map(file => clean(file.fileId))).size !== reviewed.length
    || files.some(file => !reviewed.some(item => clean(item.fileId) === clean(file.id) && item.readable === true && item.identityVerified === true)))
    throw fundingHandoffError('UNREADABLE_DOCUMENTS', 'Alle aktuellen Dealdateien müssen vollständig gelesen, lesbar und eindeutig dem Kunden zugeordnet sein.');
  const required = [...requiredDocuments, ...(review.incomeBonusRequested ? ['tax_assessment_2023', 'tax_assessment_2024'] : [])];
  if (required.some(type => review.documentEvidence?.[type] !== 'present_in_pipedrive'))
    throw fundingHandoffError('MISSING_DOCUMENTS', 'Erforderliche Förderunterlagen fehlen oder sind noch nicht lesbar im Deal bestätigt. Vorher wird keine Förderhöhen-Notiz geschrieben.');
  const fingerprint = fundingHandoffSnapshotFingerprint(snapshot);
  if (review.snapshotFingerprint !== fingerprint) throw fundingHandoffError('CHANGED_DOCUMENTS', 'Dealangaben oder Dateien haben sich seit der Unterlagenprüfung geändert. Bitte erneut vollständig prüfen.');
  return { dealId: id, fingerprint, checkedAt: new Date(checkedAt).toISOString(), incomeBonusRequested: review.incomeBonusRequested,
    fileIds: files.map(file => clean(file.id)), requiredDocumentIds: required };
}
