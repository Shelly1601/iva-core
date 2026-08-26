import { IVA_IMAC_DEVICE_ID } from './store.js';

export const FUNDING_RUNTIME_MARKER = 'funding-5am-runtime-2026-08-27-v1';
export const FUNDING_RUNTIME_REQUIRED_ACTION = 'funding.legacy-monitor.suspend';

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
  return `Aktualisiere ausschließlich die lokale IVA-Gerätelaufzeit auf diesem iMac aus dem bereits synchronisierten autoritativen iCloud-Workspace.

Arbeitsordner: /Users/nadine/Library/Mobile Documents/com~apple~CloudDocs/IVA-Assistent/iva-core

1. Prüfe, dass der Hostname ein iMac ist und dass genau dieser iCloud-Arbeitsordner aktiv ist.
2. Prüfe mit node --check die Dateien local-mac-helper/device-agent.mjs, local-mac-helper/device-agent-runner.mjs, local-mac-helper/device-agent-launchd.mjs und local-mac-helper/codex-tasks.mjs.
3. Führe genau einmal aus: node local-mac-helper/cli.mjs install-imac-device-agent --commit
4. Verifiziere das ausgegebene Installationsergebnis: zwei fortlaufende Railway-Heartbeats, Laufzeitmodus local und die Aktionsliste enthält funding.legacy-monitor.suspend.

Dies ist nur eine lokale Laufzeitaktualisierung. Ändere keinen Quellcode, erstelle keinen Commit, pushe und deploye nichts. Starte keinen Förderlauf. Öffne oder verändere weder Pipedrive noch Outlook, WhatsApp oder Google Sheets. Versende nichts. Melde nur das verifizierte Ergebnis oder den konkreten technischen Fehler.`;
}

export async function reconcileFundingImacRuntime({
  getStatus,
  enqueue,
  listCommands,
} = {}) {
  if (typeof getStatus !== 'function' || typeof enqueue !== 'function' || typeof listCommands !== 'function') {
    throw new Error('Für den iMac-Laufzeitabgleich fehlen interne Abhängigkeiten.');
  }
  const status = await getStatus(IVA_IMAC_DEVICE_ID);
  if (status?.attested !== true || status?.online !== true) {
    return { status: 'waiting_for_imac', detail: 'Der attestierte iMac ist noch nicht online.' };
  }
  const allowed = new Set(Array.isArray(status.allowedActions) ? status.allowedActions : []);
  if (!allowed.has(FUNDING_RUNTIME_REQUIRED_ACTION)) {
    if (!allowed.has('codex.task.start')) {
      return { status: 'blocked', detail: 'Die alte iMac-Laufzeit kann den sicheren Aktualisierungsauftrag nicht annehmen.' };
    }
    const command = await enqueue({
      deviceId: IVA_IMAC_DEVICE_ID,
      action: 'codex.task.start',
      payload: {
        title: 'iMac-Laufzeit für den Förderlauf aktualisieren',
        requestId: FUNDING_RUNTIME_MARKER,
        mode: 'operational',
        prompt: fundingRuntimeUpdatePrompt(),
        acceptanceCriteria: [
          'Die lokale iMac-Laufzeit stammt aus dem autoritativen IVA-iCloud-Workspace.',
          'Zwei fortlaufende Railway-Heartbeats bestätigen den neu gestarteten Agenten.',
          'Die Aktionsliste enthält funding.legacy-monitor.suspend.',
          'Kein Förderlauf und keine externe Kommunikation wurden ausgelöst.',
        ],
      },
      requestedBy: 'funding-runtime-reconciler',
      requestText: `[${FUNDING_RUNTIME_MARKER}] Lokale iMac-Laufzeit ohne Fachaktionen aktualisieren`,
    });
    return { status: 'runtime_update_queued', commandId: command.id };
  }

  const commands = await listCommands({ deviceId: IVA_IMAC_DEVICE_ID, limit: 100 });
  const suspension = commands.find(command => command.action === FUNDING_RUNTIME_REQUIRED_ACTION
    && String(command.requestText || '').includes(FUNDING_RUNTIME_MARKER));
  if (successfulSuspension(suspension)) {
    return {
      status: 'ready',
      runtimeCurrent: true,
      legacyMonitorSuspended: true,
      commandId: suspension.id,
      result: suspension.result,
    };
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
      || (command.action === 'codex.task.start' && command.payload?.requestId === FUNDING_RUNTIME_MARKER));
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
  };
}
