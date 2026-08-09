import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { loadFundingScan } from './funding-scan.mjs';
import { openOutlookAccountFolder, runMacUiBridge } from './macos-ui.mjs';

const FUNDING_MAILBOX = 'foerderung@heat-hero.com';

function fingerprint(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

export function defaultFundingMonitorStateFile() {
  return path.join(
    process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper'),
    'funding-monitor-state.json',
  );
}

async function saveState(state, filePath = defaultFundingMonitorStateFile()) {
  const absoluteFile = path.resolve(filePath);
  const temporary = `${absoluteFile}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(absoluteFile), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, absoluteFile);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return absoluteFile;
}

async function readFundingInboxDescriptions() {
  await openOutlookAccountFolder({ from: FUNDING_MAILBOX, folder: 'Posteingang' });
  const inbox = await runMacUiBridge(['find', 'AXCell'], { timeoutMs: 30000 });
  return (inbox.matches || [])
    .map(item => String(item.description || '').replace(/\s+/g, ' ').trim())
    .filter(description => /(?:Betreff:|Kein Betreff)/i.test(description));
}

export async function loadFundingMonitorState(filePath = defaultFundingMonitorStateFile()) {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
}

export async function initializeFundingMonitor({ fundingScan, persist = true } = {}) {
  const initializedAt = new Date().toISOString();
  const pipedrive = fundingScan || await loadFundingScan();
  const messageDescriptions = await readFundingInboxDescriptions();
  const cases = pipedrive.cases || pipedrive.snapshots || [];
  const completedDealIds = cases
    .filter(item => Array.isArray(item.missingBaseDocumentIds) && item.missingBaseDocumentIds.length === 0)
    .map(item => String(item.dealId));
  const state = {
    version: 1,
    mode: 'review-only',
    initializedAt,
    lastCheckedAt: initializedAt,
    intervalMinutes: 30,
    emailSendEnabled: false,
    replyDraftsOnly: true,
    processedMessageFingerprints: [...new Set(messageDescriptions.map(fingerprint))],
    baselineMessageCount: messageDescriptions.length,
    completedDealIdsAtBaseline: [...new Set(completedDealIds)],
    whatsappSentDealIds: [],
    replyDraftDealIds: [],
    lastRun: null,
  };
  const savedTo = persist ? await saveState(state) : null;
  return { ...state, savedTo };
}

export async function detectNewFundingMessages({ filePath = defaultFundingMonitorStateFile() } = {}) {
  const state = await loadFundingMonitorState(filePath);
  const processed = new Set(state.processedMessageFingerprints || []);
  const descriptions = await readFundingInboxDescriptions();
  const messages = descriptions
    .map(description => ({ fingerprint: fingerprint(description), description }))
    .filter(item => !processed.has(item.fingerprint));
  return {
    checkedAt: new Date().toISOString(),
    mode: state.mode,
    emailSendEnabled: state.emailSendEnabled === true,
    replyDraftsOnly: state.replyDraftsOnly !== false,
    inboxMessageCount: descriptions.length,
    newMessageCount: messages.length,
    messages,
    stateMutated: false,
  };
}

export async function acknowledgeFundingMessages(fingerprints, { filePath = defaultFundingMonitorStateFile() } = {}) {
  const values = [...new Set((Array.isArray(fingerprints) ? fingerprints : []).map(String))];
  if (!values.length || values.some(value => !/^[0-9a-f]{64}$/i.test(value))) {
    throw new Error('Zum Abschliessen eines Monitorlaufs fehlen gueltige Nachrichten-Fingerprints.');
  }
  const state = await loadFundingMonitorState(filePath);
  state.processedMessageFingerprints = [...new Set([...(state.processedMessageFingerprints || []), ...values])];
  state.lastCheckedAt = new Date().toISOString();
  state.lastRun = { acknowledgedAt: state.lastCheckedAt, messageCount: values.length };
  await saveState(state, filePath);
  return { acknowledged: values.length, lastCheckedAt: state.lastCheckedAt, stateMutated: true };
}

export async function recordFundingMonitorOutcome(input = {}, { filePath = defaultFundingMonitorStateFile() } = {}) {
  const dealId = String(input.dealId || '').replace(/\D/g, '');
  if (!dealId) throw new Error('Monitor-Ergebnis ohne gueltige Pipedrive-Deal-ID.');
  const fingerprintValue = String(input.messageFingerprint || '');
  if (fingerprintValue && !/^[0-9a-f]{64}$/i.test(fingerprintValue)) throw new Error('Ungueltiger Nachrichten-Fingerprint.');
  const state = await loadFundingMonitorState(filePath);
  if (input.replyDraftCreated === true) {
    state.replyDraftDealIds = [...new Set([...(state.replyDraftDealIds || []), dealId])];
  }
  if (input.whatsappSent === true) {
    state.whatsappSentDealIds = [...new Set([...(state.whatsappSentDealIds || []), dealId])];
  }
  if (fingerprintValue) {
    state.processedMessageFingerprints = [...new Set([...(state.processedMessageFingerprints || []), fingerprintValue])];
  }
  state.lastCheckedAt = new Date().toISOString();
  state.lastRun = {
    recordedAt: state.lastCheckedAt,
    dealId,
    messageFingerprint: fingerprintValue || null,
    replyDraftCreated: input.replyDraftCreated === true,
    whatsappSent: input.whatsappSent === true,
    status: String(input.status || '').slice(0, 120) || null,
  };
  await saveState(state, filePath);
  return { ...state.lastRun, stateMutated: true };
}
