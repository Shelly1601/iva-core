import {
  createForecastDeliveryLedger,
  deliverValidatedPlanbarForecast,
  PLANBAR_FORECAST_SENDER,
  PLANBAR_FORECAST_RECIPIENT,
} from './planbar-forecast-mail.mjs';
import { assertImacExecutionHost } from './imac-host-guard.mjs';
import { withImacExecutionLock } from './ui-execution-lock.mjs';
import { withMacWakeGuard } from './mac-wake-guard.mjs';
import { readMacSessionLockStatus } from './mac-session-lock.mjs';

// This executor deliberately claims only the implemented capability. A new
// forecast still needs a checked-in XLSX builder and the required render review.
// It must never obtain that capability by silently launching a model session.
export function nativeWorkflowCapabilities() {
  return {
    version: 1,
    codexFallback: false,
    workflows: {
      'planbar-weekly-export': {
        resumeExistingDelivery: true,
        createNewDelivery: false,
        missing: ['verified-xlsx-builder-and-render-review'],
      },
    },
  };
}

function blocked(code, detail, extra = {}) {
  return { executor: 'native', status: 'blocked', completed: false, sent: false,
    phase: 'capability', errorCode: code, detail, codexFallback: false, ...extra };
}

function identity(input) {
  const runMode = input.runMode || 'manual';
  if (!['manual', 'automatic'].includes(runMode)) throw new Error('identity');
  const key = runMode === 'automatic' ? input.automationSlotKey : input.requestId;
  if (typeof key !== 'string' || !key.trim() || key !== key.trim()
    || key.length > 180 || /[\u0000-\u001f\u007f]/u.test(key)) throw new Error('identity');
  if (runMode === 'manual' && input.automationSlotKey) throw new Error('identity');
  return { runMode, automationSlotKey: runMode === 'automatic' ? key : '',
    deliveryRunKey: runMode === 'manual' ? key : '', canonicalKey: `${runMode}:${key}` };
}

const equalNames = (left, right) => Array.isArray(left) && Array.isArray(right)
  && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

function validateReceipt(receipt, context) {
  if (!receipt || receipt.deliveryRunKey !== context.canonicalKey
    || receipt.runMode !== context.runMode
    || (receipt.automationSlotKey || '') !== context.automationSlotKey
    || receipt.sender !== PLANBAR_FORECAST_SENDER || receipt.recipient !== PLANBAR_FORECAST_RECIPIENT
    || !['submission_started', 'submission_uncertain', 'submitted_unverified', 'sent_verified'].includes(receipt.status)) throw new Error('receipt');
  const period = /^KW (\d{1,2})-(\d{1,2}) \/ (\d{4})$/.exec(receipt.period || '');
  if (!period || +period[1] < 1 || +period[2] > 53 || +period[2] - +period[1] !== 9
    || receipt.subject !== `Planbar-Listen ${receipt.period}`) throw new Error('receipt');
  const names = receipt.attachments;
  const suffix = `_KW${period[1]}-${period[2]}_${period[3]}.xlsx`;
  if (!Array.isArray(names) || names.length < 2 || new Set(names).size !== names.length
    || names.filter(name => name === `Planbar_Gesamtliste${suffix}`).length !== 1
    || names.some(name => typeof name !== 'string' || !/^Planbar_[A-Za-z0-9ÄÖÜäöüß_-]+_KW\d{1,2}-\d{1,2}_\d{4}\.xlsx$/.test(name) || !name.endsWith(suffix))
    || names.some(name => !/^[a-f0-9]{64}$/i.test(receipt.attachmentHashes?.[name] || ''))) throw new Error('receipt');
  const start = Date.parse(receipt.verificationNotBefore || '');
  const end = Date.parse(receipt.verificationNotAfter || '');
  const collected = Date.parse(receipt.sourceCollectedAt || '');
  const rechecked = Date.parse(receipt.planbarRecheckedAt || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 10 * 60_000
    || !Number.isFinite(Date.parse(receipt.createdAt || ''))
    || receipt.planbarExactMatch !== true
    || !Number.isFinite(collected) || !Number.isFinite(rechecked)
    || collected > rechecked || rechecked > start || start - collected > 15 * 60_000
    || start - rechecked > 2 * 60_000) throw new Error('receipt');
  return receipt;
}

function verifiedReceipt(receipt) {
  const proof = receipt.sentFolder;
  return receipt.status === 'sent_verified' && receipt.sentFolderVerified === true
    && proof?.verified === true && proof.folder === 'Gesendet'
    && proof.subject === receipt.subject && proof.sender === receipt.sender
    && equalNames(proof.recipients, [receipt.recipient])
    && equalNames(proof.attachments, receipt.attachments);
}

function completed(receipt, resumed) {
  const workflowProof = {
    runMode: receipt.runMode, automationSlotKey: receipt.automationSlotKey || '',
    deliveryRunKey: receipt.runMode === 'manual' ? receipt.deliveryRunKey.slice('manual:'.length) : receipt.deliveryRunKey,
    canonicalDeliveryRunKey: receipt.deliveryRunKey,
    sentFolderVerified: true, period: receipt.period, subject: receipt.subject,
    attachmentCount: receipt.attachments.length, sentAt: receipt.sentAt || receipt.createdAt,
  };
  return { executor: 'native', supported: true, status: 'completed', completed: true,
    workflowOutcome: 'completed', phase: 'completed', sent: true, ...workflowProof,
    workflowProof, resumed, codexFallback: false,
    detail: 'Planbar-Forecast ist für genau diesen Auftrag im Outlook-Ordner Gesendet belegt.' };
}

async function resumeForecastReceipt(receipt, context) {
  // Reuse the established ambiguity checks and durable ledger. Even if the
  // receipt disappears concurrently, this call can never submit a new message.
  return deliverValidatedPlanbarForecast({ ...receipt, attachmentNames: receipt.attachments,
    manifest: { verification: { excludedResourceLeaks: 0 } } }, {
    runMode: context.runMode, automationSlotKey: context.automationSlotKey,
    deliveryRunKey: context.deliveryRunKey,
    send: async () => { throw new Error('NATIVE_FORECAST_RESUME_CANNOT_SEND'); },
    verifyCurrent: async () => { throw new Error('NATIVE_FORECAST_RESUME_RECEIPT_MISSING'); },
  });
}

/** Native dispatch boundary. Unsupported or incomplete capabilities stay open.
 * The only enabled business path is proof/readback of an existing forecast.
 * No initial send, Planbar scan, workbook creation or model call occurs here.
 */
export async function startNativeWorkflow(input = {}, {
  assertHost = assertImacExecutionHost,
  readReceipt = key => createForecastDeliveryLedger().read(key),
  resumeReceipt = resumeForecastReceipt,
  sessionStatus = readMacSessionLockStatus,
  withUiLock = withImacExecutionLock,
  withWakeGuard = withMacWakeGuard,
} = {}) {
  if (input.workflowId !== 'planbar-weekly-export') return blocked('NATIVE_WORKFLOW_UNSUPPORTED',
    'Für diesen Workflow ist noch kein vollständiger nativer Ausführer freigegeben.', { supported: false });
  let context;
  try { context = identity(input); }
  catch { return blocked('NATIVE_WORKFLOW_IDENTITY_REQUIRED', 'Der Forecast benötigt eine eindeutige, unveränderte Auftrags- oder Wochen-Slot-ID.', { supported: true }); }
  try { await assertHost(); }
  catch { return blocked('NATIVE_WORKFLOW_HOST_REQUIRED', 'Dieser Workflow benötigt den attestierten Mac Mini.', { supported: true }); }
  let receipt;
  try { receipt = await readReceipt(context.canonicalKey); }
  catch { return blocked('NATIVE_WORKFLOW_RECEIPT_UNREADABLE', 'Der dauerhafte Versandbeleg konnte nicht sicher gelesen werden.', { supported: true }); }
  if (!receipt) return blocked('NATIVE_FORECAST_BUILDER_UNAVAILABLE',
    'Für einen neuen Forecast fehlt der vollständig geprüfte native XLSX- und Render-Ablauf. Es wurde kein Codex-Auftrag gestartet.',
    { supported: true, missingCapabilities: ['verified-xlsx-builder-and-render-review'] });
  try { validateReceipt(receipt, context); }
  catch { return blocked('NATIVE_WORKFLOW_RECEIPT_INVALID', 'Der Versandbeleg bestätigt Identität, Anlagen und ursprüngliche Quellprüfung nicht vollständig.', { supported: true }); }
  if (verifiedReceipt(receipt)) return completed(receipt, false);
  // A claimed success with absent/mismatching evidence must not reach the
  // legacy sender's sent_verified short circuit and masquerade as a success.
  if (receipt.status === 'sent_verified') return blocked('NATIVE_WORKFLOW_PROOF_INVALID',
    'Der gespeicherte Abschluss besitzt keinen vollständigen passenden Gesendet-Nachweis.', { supported: true });
  try {
    if ((await sessionStatus())?.usable !== true) return blocked('NATIVE_WORKFLOW_SESSION_REQUIRED',
      'Die bestehende Outlook-Gesendet-Prüfung wartet auf die nutzbare Mac-Mini-Sitzung.', { supported: true, phase: 'waiting_session' });
    return await withUiLock(async () => {
      if ((await sessionStatus())?.usable !== true) return blocked('NATIVE_WORKFLOW_SESSION_REQUIRED',
        'Die bestehende Outlook-Gesendet-Prüfung wartet auf die nutzbare Mac-Mini-Sitzung.', { supported: true, phase: 'waiting_session' });
      await withWakeGuard(() => resumeReceipt(receipt, context), { maxSeconds: 90, sleepDisplays: false });
      // A successful return value alone is not an execution receipt.
      const saved = validateReceipt(await readReceipt(context.canonicalKey), context);
      if (!verifiedReceipt(saved)) return blocked('NATIVE_WORKFLOW_PROOF_PENDING',
        'Der ursprüngliche Versand ist noch nicht vollständig und dauerhaft im Gesendet-Ordner bestätigt.',
        { supported: true, phase: 'verification', retryReadbackOnly: true });
      return completed(saved, true);
    }, { timeoutMs: 20_000 });
  } catch {
    return blocked('NATIVE_WORKFLOW_PROOF_PENDING',
      'Die Gesendet-Prüfung des ursprünglichen Versandversuchs bleibt offen; derselbe Auftrag wird ausschließlich rückgelesen.',
      { supported: true, phase: 'verification', retryReadbackOnly: true });
  }
}
