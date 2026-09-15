import { IVA_IMAC_DEVICE_ID } from './store.js';

export const FUNDING_RUNTIME_MARKER = 'funding-5am-runtime-2026-08-27-v4';
export const FUNDING_RUNTIME_REQUIRED_ACTION = 'funding.legacy-monitor.suspend';
export const FUNDING_RUNTIME_MAX_UPDATE_ATTEMPTS = 10;
export const FUNDING_DAILY_SEQUENCE_WORKFLOW = 'funding-daily-sequence';

const TERMINAL_FAILURES = new Set(['failed', 'expired', 'canceled']);

function active(command) {
  return ['queued', 'running'].includes(command?.status);
}

function successfulSuspension(command) {
  return command?.status === 'completed'
    && command?.result?.suspended === true
    && command?.result?.loaded === false
    && command?.result?.plistRetained === true;
}

export function fundingRuntimeUpdatePrompt() {
  return `Aktualisiere ausschließlich die lokale IVA-Gerätelaufzeit auf diesem Mac Mini aus dem bereits veröffentlichten zentralen IVA-Core.
Arbeitsordner: /Users/macmini/Documents/Codex/IVA/iva-core
Führe node local-mac-helper/install-central-runtime.mjs aus. Das Paket wird über den attestierten Gerätekanal bezogen und vor Aktivierung geprüft. Bestätige danach zwei fortlaufende Heartbeats sowie funding.legacy-monitor.suspend in der Aktionsliste.
Kein Förderlauf, keine Fachsystemaktion und keine Nachricht. Keine Quelländerung, kein Commit und kein Deployment. Aktive lokale Workflows nicht unterbrechen.`;
}

export async function reconcileFundingImacRuntime({
  getStatus,
  enqueue,
  listCommands,
} = {}) {
  if (typeof getStatus !== 'function' || typeof enqueue !== 'function' || typeof listCommands !== 'function') {
    throw new Error('Für den Mac Mini-Laufzeitabgleich fehlen interne Abhängigkeiten.');
  }
  const status = await getStatus(IVA_IMAC_DEVICE_ID);
  if (status?.attested !== true || status?.online !== true) {
    return { status: 'waiting_for_imac', detail: 'Der attestierte Mac Mini ist noch nicht online.' };
  }
  const allowed = new Set(Array.isArray(status.allowedActions) ? status.allowedActions : []);
  const commands = await listCommands({ deviceId: IVA_IMAC_DEVICE_ID, limit: 100 });
  if (!allowed.has(FUNDING_RUNTIME_REQUIRED_ACTION)) {
    if (!allowed.has('codex.task.start')) {
      return { status: 'blocked', detail: 'Die alte Mac Mini-Laufzeit kann den sicheren Aktualisierungsauftrag nicht annehmen.' };
    }
    const failedUpdates = commands.filter(command => command.action === 'codex.task.start'
      && command.payload?.requestId === FUNDING_RUNTIME_MARKER
      && command.status === 'failed');
    if (failedUpdates.length >= FUNDING_RUNTIME_MAX_UPDATE_ATTEMPTS) {
      return {
        status: 'blocked_icloud_materialization',
        attempts: failedUpdates.length,
        detail: failedUpdates[0]?.error || 'Die Mac Mini-iCloud-Dateien konnten wiederholt nicht materialisiert werden.',
      };
    }
    const command = await enqueue({
      deviceId: IVA_IMAC_DEVICE_ID,
      action: 'codex.task.start',
      payload: {
        title: 'Mac Mini-Laufzeit für den Förderlauf aktualisieren',
        requestId: FUNDING_RUNTIME_MARKER,
        mode: 'operational',
        prompt: fundingRuntimeUpdatePrompt(),
        acceptanceCriteria: [
          'Die lokale Mac-Mini-Laufzeit stammt aus dem geprüften zentralen IVA-Core.',
          'Zwei fortlaufende Railway-Heartbeats bestätigen den neu gestarteten Agenten.',
          'Die Aktionsliste enthält funding.legacy-monitor.suspend.',
          'Kein Förderlauf und keine externe Kommunikation wurden ausgelöst.',
        ],
      },
      requestedBy: 'funding-runtime-reconciler',
      requestText: `[${FUNDING_RUNTIME_MARKER}] Lokale Mac Mini-Laufzeit ohne Fachaktionen aktualisieren`,
    });
    return { status: 'runtime_update_queued', commandId: command.id };
  }

  const suspension = commands.find(command => command.action === FUNDING_RUNTIME_REQUIRED_ACTION
    && String(command.requestText || '').includes(FUNDING_RUNTIME_MARKER));
  if (successfulSuspension(suspension)) {
    // Runtime maintenance never starts business work. The automation scheduler
    // owns the dated backfill and daily incremental slot with stable job IDs.
    return { status: 'ready', runtimeCurrent: true, legacyMonitorSuspended: true,
      commandId: suspension.id, result: suspension.result };
  }
  if (active(suspension)) {
    return { status: 'legacy_monitor_suspending', commandId: suspension.id };
  }
  const command = await enqueue({
    deviceId: IVA_IMAC_DEVICE_ID,
    action: FUNDING_RUNTIME_REQUIRED_ACTION,
    requestedBy: 'funding-runtime-reconciler',
    requestText: `[${FUNDING_RUNTIME_MARKER}] Alten 30-Minuten-Fördermonitor anhalten; Plist behalten`,
  });
  return {
    status: TERMINAL_FAILURES.has(suspension?.status) ? 'legacy_monitor_retry_queued' : 'legacy_monitor_suspend_queued',
    commandId: command.id,
  };
}

export function summarizeFundingRuntimeCommands(commands = []) {
  const relevant = (Array.isArray(commands) ? commands : [])
    .filter(command => command.action === FUNDING_RUNTIME_REQUIRED_ACTION
      || (command.action === 'codex.task.start' && command.payload?.requestId === FUNDING_RUNTIME_MARKER)
      || (command.action === 'project.workflow.run'
        && command.payload?.workflowId === FUNDING_DAILY_SEQUENCE_WORKFLOW
        && String(command.requestText || '').includes(FUNDING_RUNTIME_MARKER)));
  const summarize = command => command ? {
    id: command.id,
    action: command.action,
    status: command.status,
    createdAt: command.createdAt,
    startedAt: command.startedAt || null,
    completedAt: command.completedAt || null,
    attempts: command.attempts,
    jobId: command.result?.jobId || null,
    suspended: command.result?.suspended === true,
    loaded: typeof command.result?.loaded === 'boolean' ? command.result.loaded : null,
    plistRetained: command.result?.plistRetained === true,
    error: command.error || null,
  } : null;
  return {
    runtimeUpdate: summarize(relevant.find(command => command.action === 'codex.task.start')),
    legacyMonitorSuspension: summarize(relevant.find(command => command.action === FUNDING_RUNTIME_REQUIRED_ACTION
      && String(command.requestText || '').includes(FUNDING_RUNTIME_MARKER))),
    fundingCatchup: summarize(relevant.find(command => command.action === 'project.workflow.run'
      && command.payload?.workflowId === FUNDING_DAILY_SEQUENCE_WORKFLOW)),
  };
}
