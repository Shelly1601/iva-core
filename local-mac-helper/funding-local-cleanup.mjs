import os from 'node:os';
import path from 'node:path';
import { access, realpath, rm } from 'node:fs/promises';
import { loadFundingReview, saveFundingReview } from './funding-review-queue.mjs';

function dataRoot() {
  return process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper');
}

function incomingRoot() {
  return path.join(dataRoot(), 'incoming');
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export async function recordFundingReviewCompletion(messageFingerprint, evidence = {}) {
  const review = await loadFundingReview(messageFingerprint);
  const uploadedFiles = Array.isArray(evidence.pipedriveUpload?.files) ? evidence.pipedriveUpload.files.map(String).filter(Boolean) : [];
  const pipedriveUploadVerified = evidence.pipedriveUpload?.verified === true && uploadedFiles.length > 0;
  const outboundChannel = ['email', 'whatsapp'].includes(evidence.outbound?.channel) ? evidence.outbound.channel : null;
  const outboundVerified = Boolean(outboundChannel && evidence.outbound?.verified === true);
  if (!pipedriveUploadVerified) throw new Error('Lokale Bereinigung gesperrt: Pipedrive-Upload ist nicht vollständig verifiziert.');
  if (!outboundVerified) throw new Error('Lokale Bereinigung gesperrt: Weder E-Mail- noch WhatsApp-Ausgang ist verifiziert.');
  if (evidence.pendingManualReview === true) throw new Error('Lokale Bereinigung gesperrt: Der Förderfall besitzt noch eine manuelle Prüfung.');

  const completion = {
    completedAt: new Date().toISOString(),
    pipedriveUploadVerified: true,
    pipedriveDealId: String(evidence.pipedriveUpload?.dealId || review.dealId || ''),
    uploadedFiles,
    outboundVerified: true,
    outboundChannel,
    outboundReference: String(evidence.outbound?.reference || '').slice(0, 240) || null,
    pendingManualReview: false,
  };
  if (!completion.pipedriveDealId || completion.pipedriveDealId !== String(review.dealId || '')) {
    throw new Error('Lokale Bereinigung gesperrt: Verifizierte Pipedrive-Deal-ID stimmt nicht mit dem Förderfall überein.');
  }
  return saveFundingReview({ ...review, completion, localCleanup: { status: 'pending' } });
}

export async function cleanupCompletedFundingReview(messageFingerprint) {
  const review = await loadFundingReview(messageFingerprint);
  const completion = review.completion || {};
  if (completion.pipedriveUploadVerified !== true || completion.outboundVerified !== true || completion.pendingManualReview !== false) {
    throw new Error('Lokale Bereinigung gesperrt: Förderfall ist noch nicht vollständig verifiziert abgeschlossen.');
  }
  if (!Array.isArray(completion.uploadedFiles) || !completion.uploadedFiles.length) {
    throw new Error('Lokale Bereinigung gesperrt: Verifizierte Pipedrive-Dateiliste fehlt.');
  }
  const configuredDirectory = path.resolve(String(review.downloaded?.directory || ''));
  const expectedDirectory = path.join(incomingRoot(), String(review.messageFingerprint));
  if (configuredDirectory !== expectedDirectory) {
    throw new Error('Lokale Bereinigung gesperrt: Förder-Arbeitsordner stimmt nicht mit dem Nachrichten-Fingerprint überein.');
  }
  const root = await realpath(incomingRoot());
  const directory = await realpath(configuredDirectory);
  if (!isInside(root, directory)) throw new Error('Lokale Bereinigung gesperrt: Ziel liegt außerhalb von IVAs Förder-Arbeitsordner.');

  await rm(directory, { recursive: true, force: false });
  await access(directory).then(
    () => { throw new Error('Lokale Bereinigung konnte nicht verifiziert werden.'); },
    error => { if (error?.code !== 'ENOENT') throw error; },
  );
  const updated = await saveFundingReview({
    ...review,
    downloaded: { ...review.downloaded, directory: null, localCopiesAvailable: false },
    localCleanup: {
      status: 'complete',
      completedAt: new Date().toISOString(),
      deletedScope: 'managed_local_funding_copies_only',
      emailDeleted: false,
      pipedriveFileDeleted: false,
    },
  });
  return {
    messageFingerprint: review.messageFingerprint,
    dealId: review.dealId,
    localFilesDeleted: true,
    deletedScope: updated.localCleanup.deletedScope,
    emailDeleted: false,
    pipedriveFileDeleted: false,
  };
}

export function fundingLocalCleanupPolicy() {
  return Object.freeze({
    managedRoot: incomingRoot(),
    requiresVerifiedPipedriveUpload: true,
    requiresVerifiedOutbound: true,
    requiresNoPendingManualReview: true,
    deletesEmail: false,
    deletesPipedriveFiles: false,
    deletesOnlyManagedLocalCopies: true,
  });
}
