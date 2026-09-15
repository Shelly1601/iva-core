import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { collectPipedriveFundingDealIds, readPipedriveFundingDealsViaApi } from './background-integrations.mjs';
import { withFundingFileLock } from './funding-intake-state.mjs';

export const FUNDING_BASE_REQUIRED_DOCUMENTS = Object.freeze([
  'signed_offer',
  'identity_card',
  'registration_certificate',
  'land_register',
  'kfw_account_confirmation',
]);

export function defaultFundingScanFile() {
  return path.join(
    process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper'),
    'funding-scan.json',
  );
}

export function fundingDocumentReviewFingerprint(snapshot = {}) {
  return createHash('sha256').update(JSON.stringify([
    snapshot.dealId, snapshot.stage, snapshot.orderNumber, snapshot.customerPersonId, snapshot.incomeBonusRequested,
    (snapshot.fileRecords || []).map(item => [String(item.id), item.name, Number(item.size), item.updatedAt || null]).sort((a, b) => a[0].localeCompare(b[0])),
    snapshot.noteCount, snapshot.latestNoteAt, snapshot.kfwAccountConfirmedByCredentials,
  ])).digest('hex');
}
function reviewCacheFile() { return path.join(path.dirname(defaultFundingScanFile()), 'funding-document-review-cache.json'); }
async function loadReviewCache(file = reviewCacheFile()) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; return { version: 1, deals: {} }; } }
export async function recordFundingDocumentReview({ snapshot, review } = {}, { file = reviewCacheFile() } = {}) {
  if (!/^\d+$/.test(String(snapshot?.dealId || '')) || !Array.isArray(snapshot.fileRecords) || review?.complete !== true || review?.sourceNotesChecked !== true) throw new Error('Der vollständige Förder-Dokumentreview ist nicht belegt.');
  const checked = Array.isArray(review.files) ? review.files : [];
  if (snapshot.fileRecords.some(file => !checked.some(item => String(item.fileId) === String(file.id) && item.readable === true && item.identityVerified === true))) throw new Error('Mindestens eine Dealdatei wurde noch nicht inhaltlich und auf Identität geprüft.');
  return withFundingFileLock(file, async () => {
    const cache = await loadReviewCache(file), fingerprint = fundingDocumentReviewFingerprint(snapshot);
    cache.deals[String(snapshot.dealId)] = { fingerprint, verifiedAt: new Date().toISOString(), fileIds: snapshot.fileRecords.map(item => String(item.id)) };
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(cache, null, 2), { mode: 0o600 }); await rename(temporary, file); } finally { await unlink(temporary).catch(() => {}); }
    return { dealId: String(snapshot.dealId), fingerprint, verified: true };
  });
}

function summarizeSnapshot(snapshot, reviewCache = {}) {
  const recognizedDocuments = snapshot.documents.filter(document => document.confidence >= 0.9 && document.type !== 'unknown');
  const presentDocumentIds = [...new Set(recognizedDocuments.map(document => document.type))];
  if (snapshot.kfwAccountConfirmedByCredentials && !presentDocumentIds.includes('kfw_account_confirmation')) {
    presentDocumentIds.push('kfw_account_confirmation');
  }
  const requiredDocumentIds = snapshot.stage === 'Angebot veröffentlicht'
    ? ['signed_offer']
    : [
        ...FUNDING_BASE_REQUIRED_DOCUMENTS,
        ...(snapshot.incomeBonusRequested === true ? ['tax_assessment_2023', 'tax_assessment_2024'] : []),
      ];
  const missingBaseDocumentIds = requiredDocumentIds.filter(id => !presentDocumentIds.includes(id));
  const unknownFiles = snapshot.documents.filter(document => document.type === 'unknown').map(document => document.fileName);
  return {
    dealId: snapshot.dealId,
    dealTitle: snapshot.dealTitle || null,
    customerName: snapshot.customerName,
    customerEmail: snapshot.customerEmail || null,
    stage: snapshot.stage,
    location: snapshot.location,
    orderNumber: snapshot.orderNumber,
    phoneNumber: snapshot.phoneNumber || null,
    plant: snapshot.plant || null,
    vpName: snapshot.vpName,
    vpEmail: snapshot.vpEmail,
    files: snapshot.files,
    fileRecords: snapshot.fileRecords || [],
    contentFingerprint: fundingDocumentReviewFingerprint(snapshot),
    documentContentReviewRequired: !Array.isArray(snapshot.fileRecords) || reviewCache[snapshot.dealId]?.fingerprint !== fundingDocumentReviewFingerprint(snapshot),
    noteCount: snapshot.noteCount || 0,
    latestNoteAt: snapshot.latestNoteAt || null,
    latestExternalNote: snapshot.latestExternalNote || null,
    kfwAccountConfirmedByCredentials: snapshot.kfwAccountConfirmedByCredentials === true,
    kfwCredentialEvidenceNoteIds: snapshot.kfwCredentialEvidenceNoteIds || [],
    kfwCredentialInvalidationNoteIds: snapshot.kfwCredentialInvalidationNoteIds || [],
    ivaFundingRequestNotes: snapshot.ivaFundingRequestNotes || [],
    presentDocumentIds,
    requiredDocumentIds,
    missingBaseDocumentIds,
    unknownFiles,
    incomeBonusRequested: snapshot.incomeBonusRequested ?? null,
    reviewRequired: unknownFiles.length > 0,
  };
}

export async function saveFundingScan(report, filePath = defaultFundingScanFile()) {
  const absoluteFile = path.resolve(filePath);
  const directory = path.dirname(absoluteFile);
  const temporary = `${absoluteFile}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify(report, null, 2), { mode: 0o600 });
    await rename(temporary, absoluteFile);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return absoluteFile;
}

export async function loadFundingScan(filePath = defaultFundingScanFile()) {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
}

export async function scanPipedriveFundingBoard({ batchSize = 100, persist = true, onProgress, pendingDealIds = [], collectBoard = collectPipedriveFundingDealIds, readDeals = readPipedriveFundingDealsViaApi } = {}) {
  const startedAt = new Date().toISOString();
  const board = await collectBoard();
  const entries = Object.entries(board.stages).filter(([name]) => ['auftrag eingereicht / förderunterlagen einreichen', 'antrag eingereicht / förderunterlagen einreichen', 'förderung beantragen', 'förderung beantragt'].includes(name.toLocaleLowerCase('de-DE')));
  if (!Array.isArray(pendingDealIds) || pendingDealIds.length > 200 || pendingDealIds.some(id => !/^\d+$/.test(String(id)))) throw new Error('Offene Förder-Deal-IDs sind nicht eindeutig oder zu umfangreich.');
  const dealIds = [...new Set([...entries.flatMap(([, deals]) => deals.map(deal => String(deal.id))), ...pendingDealIds.map(String)])];
  const result = dealIds.length ? await readDeals({ dealIds, batchSize, onProgress }) : { read: 0, failed: 0, requested: 0, errors: [], snapshots: [] };
  if (result.read !== dealIds.length || result.failed) {
    throw new Error(`Förderprüfung unvollständig: ${result.read}/${dealIds.length} Deals gelesen, ${result.failed} Fehler. Der letzte vollständige Stand wird nicht überschrieben.`);
  }
  const reviewCache = await loadReviewCache();
  const cases = result.snapshots.map(snapshot => summarizeSnapshot(snapshot, reviewCache.deals));
  const report = {
    version: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    source: 'pipedrive-live-board',
    readOnly: true,
    pipedriveMutated: false,
    boardCounts: Object.fromEntries(entries.map(([stage, deals]) => [stage, deals.length])),
    requested: result.requested,
    read: result.read,
    failed: result.failed,
    errors: result.errors,
    summary: {
      casesWithMissingBaseDocuments: cases.filter(item => item.missingBaseDocumentIds.length > 0).length,
      casesWithAllBaseDocumentsByFileName: cases.filter(item => item.missingBaseDocumentIds.length === 0).length,
      casesRequiringReview: cases.filter(item => item.reviewRequired).length,
    },
    cases,
  };
  const savedTo = persist ? await saveFundingScan(report) : null;
  return { ...report, savedTo };
}
