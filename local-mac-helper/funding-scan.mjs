import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { collectPipedriveFundingDealIds, readPipedriveFundingDealsViaApi } from './chrome-pipedrive.mjs';

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

function summarizeSnapshot(snapshot) {
  const recognizedDocuments = snapshot.documents.filter(document => document.confidence >= 0.9 && document.type !== 'unknown');
  const presentDocumentIds = [...new Set(recognizedDocuments.map(document => document.type))];
  if (snapshot.kfwAccountConfirmedByCredentials && !presentDocumentIds.includes('kfw_account_confirmation')) {
    presentDocumentIds.push('kfw_account_confirmation');
  }
  const missingBaseDocumentIds = FUNDING_BASE_REQUIRED_DOCUMENTS.filter(id => !presentDocumentIds.includes(id));
  const unknownFiles = snapshot.documents.filter(document => document.type === 'unknown').map(document => document.fileName);
  return {
    dealId: snapshot.dealId,
    dealTitle: snapshot.dealTitle || null,
    customerName: snapshot.customerName,
    stage: snapshot.stage,
    location: snapshot.location,
    orderNumber: snapshot.orderNumber,
    vpName: snapshot.vpName,
    vpEmail: snapshot.vpEmail,
    files: snapshot.files,
    noteCount: snapshot.noteCount || 0,
    latestNoteAt: snapshot.latestNoteAt || null,
    latestExternalNote: snapshot.latestExternalNote || null,
    kfwAccountConfirmedByCredentials: snapshot.kfwAccountConfirmedByCredentials === true,
    kfwCredentialEvidenceNoteIds: snapshot.kfwCredentialEvidenceNoteIds || [],
    kfwCredentialInvalidationNoteIds: snapshot.kfwCredentialInvalidationNoteIds || [],
    ivaFundingRequestNotes: snapshot.ivaFundingRequestNotes || [],
    presentDocumentIds,
    missingBaseDocumentIds,
    unknownFiles,
    incomeBonusRequested: snapshot.incomeBonusRequested ?? null,
    reviewRequired: unknownFiles.length > 0 || snapshot.incomeBonusRequested == null,
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

export async function scanPipedriveFundingBoard({ batchSize = 100, persist = true, onProgress } = {}) {
  const startedAt = new Date().toISOString();
  const board = await collectPipedriveFundingDealIds();
  const entries = Object.entries(board.stages);
  const dealIds = entries.flatMap(([, deals]) => deals.map(deal => deal.id));
  const result = await readPipedriveFundingDealsViaApi({ dealIds, batchSize, onProgress });
  if (result.read !== dealIds.length || result.failed) {
    throw new Error(`Förderprüfung unvollständig: ${result.read}/${dealIds.length} Deals gelesen, ${result.failed} Fehler. Der letzte vollständige Stand wird nicht überschrieben.`);
  }
  const cases = result.snapshots.map(summarizeSnapshot);
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
