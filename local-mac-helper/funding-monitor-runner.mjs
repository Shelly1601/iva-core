import { open, appendFile, mkdir, readdir, rmdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { correlateFundingMessages } from './funding-mail-scan.mjs';
import { prepareFundingAttachments } from './funding-document-pipeline.mjs';
import { fundingReviewExists, saveFundingReview } from './funding-review-queue.mjs';
import { scanPipedriveFundingBoard } from './funding-scan.mjs';
import {
  acknowledgeFundingMessages,
  detectNewFundingMessages,
  fundingMonitorBackgroundReadiness,
  loadFundingMonitorState,
} from './funding-monitor-state.mjs';
import { downloadOutlookMessageAttachments } from './macos-ui.mjs';
import { resolveFundingRecipients } from './funding.mjs';

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

async function processMessage(message, board) {
  const fingerprint = message.fingerprint;
  if (await fundingReviewExists(fingerprint)) {
    await acknowledgeFundingMessages([fingerprint]);
    return { fingerprint, status: 'already_queued', acknowledged: true };
  }
  const matched = matchingCaseForMessage(board, message.description);
  if (!matched.case) {
    await saveFundingReview({
      messageFingerprint: fingerprint,
      status: matched.matchCount ? 'ambiguous_case_match' : 'manual_case_match_required',
      matchCount: matched.matchCount,
      source: 'outlook-funding-inbox',
      pipedriveMutated: false,
    });
    await acknowledgeFundingMessages([fingerprint]);
    return { fingerprint, status: 'manual_case_match_required', acknowledged: true };
  }

  const snapshot = matched.case;
  const base = {
    messageFingerprint: fingerprint,
    dealId: String(snapshot.dealId),
    customerName: snapshot.customerName,
    orderNumber: snapshot.orderNumber || null,
    location: snapshot.location || null,
    stage: snapshot.stage,
    vpName: snapshot.vpName || null,
    vpEmail: snapshot.vpEmail || null,
    source: 'outlook-funding-inbox',
    pipedriveMutated: false,
  };
  if (!/hat dateien/i.test(message.description)) {
    await saveFundingReview({ ...base, status: 'mail_text_review_required', attachmentCount: 0 });
    await acknowledgeFundingMessages([fingerprint]);
    return { fingerprint, dealId: base.dealId, status: 'mail_text_review_required', acknowledged: true };
  }

  const directory = incomingDirectory(fingerprint);
  await ensureFreshIncomingDirectory(directory);
  const download = await downloadOutlookMessageAttachments(message.description, directory);
  const prepared = await prepareFundingAttachments({
    inputDirectory: directory,
    outputDirectory: path.join(directory, 'prepared'),
    customerName: snapshot.customerName,
    orderNumber: snapshot.orderNumber,
  });
  const recommendation = recommendedReviewStatus(snapshot, prepared);
  const recipients = resolveFundingRecipients(snapshot);
  await saveFundingReview({
    ...base,
    ...recommendation,
    recipients: { to: recipients.to, cc: recipients.cc, route: recipients.route, warnings: recipients.warnings },
    downloaded: { directory, expectedCount: download.expectedCount, downloadedCount: download.downloadedCount, verified: download.verified },
    documents: {
      outputs: prepared.outputs,
      manualReview: prepared.manualReview,
      allInputsClassified: prepared.allInputsClassified,
      allOutputsAutoUploadSafe: prepared.allOutputsAutoUploadSafe,
    },
  });
  await acknowledgeFundingMessages([fingerprint]);
  return { fingerprint, dealId: base.dealId, status: recommendation.status, acknowledged: true };
}

export async function runFundingMonitorOnce({ ignoreIdle = false } = {}) {
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
    const state = await loadFundingMonitorState();
    if (state.mode !== 'review-only' || state.emailSendEnabled === true || state.replyDraftsOnly === false) {
      throw new Error('Fördermonitor startet nur im gesperrten review-only-Modus ohne E-Mail-Versand.');
    }
    if (!ignoreIdle) {
      const readiness = await fundingMonitorBackgroundReadiness();
      if (!readiness.canRunUiAutomation) {
        await audit({ category: 'monitor-run', status: 'skipped_not_idle', readiness });
        return { status: 'skipped_not_idle', readiness, sent: false, pipedriveMutated: false };
      }
    }
    const detected = await detectNewFundingMessages();
    if (!detected.newMessageCount) {
      await audit({ category: 'monitor-run', status: 'no_new_mail', startedAt, completedAt: new Date().toISOString() });
      return { status: 'no_new_mail', newMessageCount: 0, sent: false, pipedriveMutated: false };
    }
    const board = await scanPipedriveFundingBoard({ persist: true });
    const results = [];
    for (const message of detected.messages) {
      try { results.push(await processMessage(message, board)); }
      catch (error) {
        results.push({ fingerprint: message.fingerprint, status: 'failed', error: String(error.message || error).slice(0, 500), acknowledged: false });
      }
    }
    const report = {
      status: results.some(item => item.status === 'failed') ? 'partial_failure' : 'review_queue_updated',
      startedAt,
      completedAt: new Date().toISOString(),
      newMessageCount: detected.newMessageCount,
      processed: results.filter(item => item.acknowledged).length,
      failed: results.filter(item => item.status === 'failed').length,
      results,
      sent: false,
      pipedriveMutated: false,
    };
    await audit({ category: 'monitor-run', ...report });
    return report;
  } finally {
    await lock?.close().catch(() => {});
    await unlink(monitorLockFile()).catch(() => {});
  }
}
