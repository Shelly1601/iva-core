import { open, appendFile, mkdir, readdir, rmdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { correlateFundingMessages } from './funding-mail-scan.mjs';
import { prepareFundingAttachments } from './funding-document-pipeline.mjs';
import { fundingReviewExists, loadFundingReview, saveFundingReview } from './funding-review-queue.mjs';
import { scanPipedriveFundingBoard } from './funding-scan.mjs';
import {
  acknowledgeFundingMessages,
  detectNewFundingMessages,
  fundingMonitorBackgroundReadiness,
  loadFundingMonitorState,
} from './funding-monitor-state.mjs';
import { downloadOutlookMessageAttachments } from './macos-ui.mjs';
import { resolveFundingRecipients } from './funding.mjs';
import { microsoftFundingMailStatus, downloadMicrosoftFundingAttachments } from './background-integrations.mjs';

function dataRoot() {
  return process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper');
}

function monitorLockFile() {
  return path.join(dataRoot(), 'funding-monitor.lock');
}

function auditFile() {
  return path.join(dataRoot(), 'funding-monitor-audit.jsonl');
}

async function audit(value) {
  await mkdir(dataRoot(), { recursive: true, mode: 0o700 });
  await appendFile(auditFile(), `${JSON.stringify({ ts: new Date().toISOString(), ...value })}\n`, { mode: 0o600 });
}

function matchingCaseForMessage(board, description) {
  const correlated = correlateFundingMessages(board.cases || [], [description]);
  const matches = [];
  for (const item of board.cases || []) {
    if ((correlated.get(String(item.dealId)) || []).some(message => message.description === description)) matches.push(item);
  }
  return matches.length === 1 ? { case: matches[0], matchCount: 1 } : { case: null, matchCount: matches.length };
}

function incomingDirectory(fingerprint) {
  return path.join(dataRoot(), 'incoming', fingerprint);
}

async function ensureFreshIncomingDirectory(directory) {
  try {
    const entries = await readdir(directory);
    if (!entries.length) await rmdir(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function recommendedReviewStatus(caseSnapshot, prepared) {
  const safeTypes = new Set(prepared.outputs.filter(item => item.autoUploadSafe).map(item => item.type));
  const missingAfterSafeUploads = (caseSnapshot.missingBaseDocumentIds || []).filter(type => !safeTypes.has(type));
  if (prepared.manualReview.length || prepared.outputs.some(item => !item.autoUploadSafe)) return { status: 'manual_document_review', missingAfterSafeUploads };
  if (prepared.outputs.length) return { status: 'ready_for_pipedrive_upload_review', missingAfterSafeUploads };
  return { status: 'no_usable_funding_document', missingAfterSafeUploads };
}

export async function processFundingMonitorMessage(message, board, {
  reviewExists = fundingReviewExists, loadReview = loadFundingReview, acknowledge = acknowledgeFundingMessages, saveReview = saveFundingReview,
  downloadGraphAttachments = downloadMicrosoftFundingAttachments, downloadUiAttachments = downloadOutlookMessageAttachments,
  prepareAttachments = prepareFundingAttachments,
} = {}) {
  const fingerprint = message.fingerprint;
  if (await reviewExists(fingerprint)) {
    const previous = await loadReview(fingerprint);
    const currentHash = /^[0-9a-f]{64}$/.test(message.sourceHash || '') ? message.sourceHash : null;
    const sourceChanged = currentHash && currentHash !== (previous.pendingReview?.sourceHash || previous.sourceHash);
    const resume = message.resume;
    const resumeKey = resume && ['source_changed', 'new_related_message', 'blocker_resolved', 'due_step'].includes(resume.reason)
      && /^[0-9a-f]{64}$/.test(resume.evidenceFingerprint || '') && Number.isFinite(Date.parse(resume.at))
      ? `${resume.reason}:${resume.evidenceFingerprint}:${resume.at}` : null;
    const resumed = resumeKey && resumeKey !== previous.pendingReview?.resumeKey
      && Date.parse(resume.at) > Date.parse(previous.updatedAt || previous.createdAt || '1970-01-01');
    if (sourceChanged || resumed) {
      // Keep the old inspected source and its attachment/CRM evidence intact.
      // Queue only the changed source/dependency; never redownload into an old manifest.
      await saveReview({ ...previous, updatedAt: new Date().toISOString(), status: 'targeted_review_required',
        pendingReview: { reason: sourceChanged ? 'source_changed' : resume.reason, sourceHash: currentHash,
          resumeKey, queuedAt: new Date().toISOString(), priorStatus: previous.pendingReview?.priorStatus || previous.status } });
      await acknowledge([fingerprint]);
      return { fingerprint, dealId: previous.dealId || null, status: 'targeted_review_required', acknowledged: true };
    }
    await acknowledge([fingerprint]);
    return { fingerprint, status: 'already_queued', acknowledged: true };
  }
  const matched = matchingCaseForMessage(board, message.description);
  if (!matched.case) {
    await saveReview({
      messageFingerprint: fingerprint,
      status: matched.matchCount ? 'ambiguous_case_match' : 'manual_case_match_required',
      matchCount: matched.matchCount,
      source: 'outlook-funding-inbox',
      sourceHash: /^[0-9a-f]{64}$/.test(message.sourceHash || '') ? message.sourceHash : null,
      pipedriveMutated: false,
    });
    await acknowledge([fingerprint]);
    return { fingerprint, status: 'manual_case_match_required', acknowledged: true };
  }

  const snapshot = matched.case;
  const base = {
    messageFingerprint: fingerprint,
    dealId: String(snapshot.dealId),
    customerName: snapshot.customerName,
    customerEmail: snapshot.customerEmail || null,
    orderNumber: snapshot.orderNumber || null,
    location: snapshot.location || null,
    stage: snapshot.stage,
    vpName: snapshot.vpName || null,
    vpEmail: snapshot.vpEmail || null,
    source: message.source === 'microsoft-graph' ? 'microsoft-graph' : 'outlook-funding-inbox',
    pipedriveMutated: false,
    messageId: message.messageId || null,
    sourceHash: /^[0-9a-f]{64}$/.test(message.sourceHash || '') ? message.sourceHash : null,
  };
  const direct = message.source === 'microsoft-graph' && message.identityVerified === true && /^<[^<>\r\n\0]+>$/.test(String(message.messageId || ''));
  if (message.source === 'microsoft-graph' && !direct || message.messageId && !message.uiDescriptionVerified && !direct) {
    const status = message.source === 'microsoft-graph' ? 'graph_message_identity_pending' : 'native_message_ui_resolution_pending';
    await saveReview({ ...base, status, attachmentCount: null });
    await acknowledge([fingerprint]);
    return { fingerprint, dealId: base.dealId, status, acknowledged: true };
  }
  if (!direct && !/hat dateien/i.test(message.description)) {
    await saveReview({ ...base, status: 'mail_text_review_required', attachmentCount: 0 });
    await acknowledge([fingerprint]);
    return { fingerprint, dealId: base.dealId, status: 'mail_text_review_required', acknowledged: true };
  }

  const directory = incomingDirectory(fingerprint);
  await ensureFreshIncomingDirectory(directory);
  // Graph hasAttachments excludes inline attachments. Read the complete
  // message's attachment inventory before deciding that no files exist.
  const download = direct ? await downloadGraphAttachments({ messageId: message.messageId, directory })
    : await downloadUiAttachments(message.description, directory);
  if (direct && (download?.source !== 'microsoft-graph' || download.messageId !== message.messageId || download.identityVerified !== true || download.complete !== true || download.verified !== true))
    throw new Error('Die M365-Anlagen wurden noch nicht vollständig zur Originalmail verifiziert.');
  if (direct && download.expectedCount === 0) {
    await saveReview({ ...base, status: 'mail_text_review_required', attachmentCount: 0, sourceHash: download.sourceHash, sourceReadComplete: download.sourceReadComplete === true });
    await acknowledge([fingerprint]);
    return { fingerprint, dealId: base.dealId, status: 'mail_text_review_required', acknowledged: true };
  }
  const prepared = await prepareAttachments({
    inputDirectory: directory,
    outputDirectory: path.join(directory, 'prepared'),
    customerName: snapshot.customerName,
    orderNumber: snapshot.orderNumber,
  });
  const recommendation = recommendedReviewStatus(snapshot, prepared);
  const recipients = resolveFundingRecipients(snapshot);
  await saveReview({
    ...base,
    ...recommendation,
    ...(direct ? { sourceHash: download.sourceHash, immutableId: download.immutableId || null, sourceReadComplete: download.sourceReadComplete === true } : {}),
    recipients: { to: recipients.to, cc: recipients.cc, warnings: recipients.warnings },
    downloaded: { directory, expectedCount: download.expectedCount, downloadedCount: download.downloadedCount, verified: download.verified },
    documents: {
      outputs: prepared.outputs,
      manualReview: prepared.manualReview,
      allInputsClassified: prepared.allInputsClassified,
      allOutputsAutoUploadSafe: prepared.allOutputsAutoUploadSafe,
    },
  });
  await acknowledge([fingerprint]);
  return { fingerprint, dealId: base.dealId, status: recommendation.status, acknowledged: true };
}

export function isFundingTombstoneOnlyDelta(detected = {}) {
  return detected.source === 'microsoft-graph' && Number(detected.tombstoneCount) > 0 && !detected.newMessageCount;
}

export async function runFundingMonitorOnce({ ignoreIdle = false, fundingRun = { mode: 'incremental' } } = {}, {
  loadState = loadFundingMonitorState, checkStatus = microsoftFundingMailStatus, checkUiReadiness = fundingMonitorBackgroundReadiness,
  detectMessages = detectNewFundingMessages, scanBoard = scanPipedriveFundingBoard, processMessage = processFundingMonitorMessage, auditLog = audit,
} = {}) {
  let lock;
  try {
    await mkdir(dataRoot(), { recursive: true, mode: 0o700 });
    lock = await open(monitorLockFile(), 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') return { status: 'skipped_already_running', sent: false, pipedriveMutated: false };
    throw error;
  }
  const startedAt = new Date().toISOString();
  try {
    const state = await loadState();
    if (state.mode !== 'review-only' || state.emailSendEnabled === true || state.replyDraftsOnly === false) {
      throw new Error('Fördermonitor startet nur im gesperrten review-only-Modus ohne E-Mail-Versand.');
    }
    const direct = (await checkStatus({ probe: true })).ready === true;
    if (!ignoreIdle && !direct) {
      const readiness = await checkUiReadiness();
      if (!readiness.canRunUiAutomation) {
        await auditLog({ category: 'monitor-run', status: 'skipped_not_idle', readiness });
        return { status: 'skipped_not_idle', readiness, sent: false, pipedriveMutated: false };
      }
    }
    const detected = await detectMessages({ fundingRun });
    if (isFundingTombstoneOnlyDelta(detected)) {
      const result = { status: 'mail_delta_checked_no_new_mail', scanComplete: detected.scanComplete, tombstoneCount: detected.tombstoneCount,
        newMessageCount: 0, dealsChecked: 0, sent: false, pipedriveMutated: false };
      await auditLog({ category: 'monitor-run', ...result, startedAt, completedAt: new Date().toISOString() });
      return result;
    }
    const board = await scanBoard({ persist: true, changedDealIds: detected.changedDealIds || [] });
    if (!detected.newMessageCount) {
      const result = {
        status: detected.scanComplete ? 'open_deals_checked_no_new_mail' : 'mail_scan_continuation_pending',
        scanComplete: detected.scanComplete,
        newMessageCount: 0,
        dealsChecked: board.read,
        boardCounts: board.boardCounts,
        sent: false,
        pipedriveMutated: false,
      };
      await auditLog({ category: 'monitor-run', ...result, startedAt, completedAt: new Date().toISOString() });
      return result;
    }
    const results = [];
    for (const message of detected.messages) {
      try { results.push(await processMessage(message, board)); }
      catch (error) {
        results.push({ fingerprint: message.fingerprint, status: 'failed', error: String(error.message || error).slice(0, 500), acknowledged: false });
      }
    }
    const report = {
      status: results.some(item => item.status === 'failed') ? 'partial_failure' : 'review_queue_updated',
      scanComplete: detected.scanComplete,
      startedAt,
      completedAt: new Date().toISOString(),
      newMessageCount: detected.newMessageCount,
      processed: results.filter(item => item.acknowledged).length,
      failed: results.filter(item => item.status === 'failed').length,
      results,
      sent: false,
      pipedriveMutated: false,
    };
    await auditLog({ category: 'monitor-run', ...report });
    return report;
  } finally {
    await lock?.close().catch(() => {});
    await unlink(monitorLockFile()).catch(() => {});
  }
}
