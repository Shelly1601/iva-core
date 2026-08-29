import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { loadFundingScan } from './funding-scan.mjs';
import { openOutlookAccountFolder, runMacUiBridge } from './macos-ui.mjs';

const FUNDING_MAILBOX = 'foerderung@heat-hero.com';
const execFileAsync = promisify(execFile);

export async function fundingMonitorBackgroundReadiness({ minimumIdleSeconds = 300 } = {}) {
  const threshold = Math.max(60, Math.min(3600, Number(minimumIdleSeconds) || 300));
  if (process.platform !== 'darwin') return { canRunUiAutomation: false, reason: 'unsupported_platform', minimumIdleSeconds: threshold };
  try {
    const { stdout } = await execFileAsync('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const nanoseconds = Number(String(stdout).match(/"HIDIdleTime"\s*=\s*(\d+)/)?.[1] || 0);
    const idleSeconds = Math.floor(nanoseconds / 1_000_000_000);
    return {
      canRunUiAutomation: idleSeconds >= threshold,
      idleSeconds,
      minimumIdleSeconds: threshold,
      reason: idleSeconds >= threshold ? 'mac_idle' : 'user_active',
    };
  } catch (error) {
    return { canRunUiAutomation: false, reason: 'idle_state_unavailable', minimumIdleSeconds: threshold, error: String(error?.message || error).slice(0, 240) };
  }
}

function stableMessageIdentity(value) {
  const description = String(value || '').replace(/\s+/g, ' ').trim();
  const sender = description.match(/Absender:\s*(.*?),\s*Betreff:/i)?.[1]?.trim() || '';
  const subject = description.match(/Betreff:\s*(.*?)(?:,\s*(?:Geantwortet\s+)?(?:Neueste Nachricht:\s*)?\d{2}\.\d{2}\.\d{2}|,\s*(?:Heute|Gestern)\b|,\s+Hat Dateien|,\s+Nachrichtenvorschau:)/i)?.[1]?.trim() || '';
  const date = description.match(/(?:Neueste Nachricht:\s*)?(\d{2}\.\d{2}\.\d{2})/i)?.[1] || '';
  const conversationCount = description.match(/Unterhaltung,\s*(\d+)\s+Mitteilungen/i)?.[1] || '1';
  const identity = [sender, subject, date, conversationCount]
    .map(part => part.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim())
    .join('|');
  return identity.replace(/\|/g, '') ? identity : description;
}

export function fundingMessageFingerprint(value) {
  return createHash('sha256').update(stableMessageIdentity(value)).digest('hex');
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
  const state = JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
  const normalized = normalizeFundingMonitorState(state);
  if (normalized !== state) await saveState(normalized, filePath);
  return normalized;
}

export function normalizeFundingMonitorState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Ungültiger Fördermonitor-Zustand.');
  if (state.mode !== 'draft-review') return state;
  if (state.emailSendEnabled === true || state.replyDraftsOnly === false) return state;
  return {
    ...state,
    version: Math.max(2, Number(state.version) || 0),
    mode: 'review-only',
    migratedFromMode: 'draft-review',
    migratedAt: new Date().toISOString(),
  };
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
    version: 2,
    mode: 'review-only',
    initializedAt,
    lastCheckedAt: initializedAt,
    intervalMinutes: 30,
    emailSendEnabled: false,
    replyDraftsOnly: true,
    initialFullScanPending: true,
    processedMessageFingerprints: [],
    baselineMessageCount: messageDescriptions.length,
    completedDealIdsAtBaseline: [],
    whatsappSentDealIds: [],
    replyDraftDealIds: [],
    escalationDraftKeys: [],
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
    .map(description => ({ fingerprint: fundingMessageFingerprint(description), description }))
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
  state.initialFullScanPending = false;
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
  const escalationKey = String(input.escalationDraftKey || '').trim().slice(0, 500);
  if (input.escalationDraftCreated === true) {
    if (!escalationKey) throw new Error('Eskalationsentwurf ohne Deduplizierungskennung.');
    state.escalationDraftKeys = [...new Set([...(state.escalationDraftKeys || []), escalationKey])];
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
    escalationDraftCreated: input.escalationDraftCreated === true,
    escalationDraftKey: escalationKey || null,
    status: String(input.status || '').slice(0, 120) || null,
  };
  await saveState(state, filePath);
  return { ...state.lastRun, stateMutated: true };
}
