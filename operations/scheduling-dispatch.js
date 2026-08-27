import { planbarSchedulingKey, planbarSchedulingSummary } from './customer-scheduling.js';

// Queue-/Prozess-Erfolg ist kein Terminbeleg. Historische Aufträge werden nur gelesen.
export function schedulingRequestStatus(request, runs = [], commands = []) {
  const key = planbarSchedulingKey(request);
  const command = commands.find(item => item.id === request.commandId || item.payload?.requestId === request.id)
    || commands.filter(item => item.action === 'planbar.customer.schedule'
      && planbarSchedulingKey(item.payload) === key
      && Date.parse(item.createdAt) >= Date.parse(request.createdAt) - 2000)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  const matches = runs.filter(run => run.schedulingKey === key || (command?.result?.jobId && run.jobId === command.result.jobId));
  const run = matches.find(item => item.planbarProgress?.reservation?.verified)
    || matches.find(item => command?.result?.jobId && item.jobId === command.result.jobId)
    || matches.find(item => !command || Date.parse(item.startedAt || item.createdAt) >= Date.parse(command.createdAt) - 2000);
  const progress = run?.planbarProgress || command?.result?.planbarProgress;
  const base = { ...request, commandId: command?.id || request.commandId || '', dispatchStatus: command?.status || '', planbarProgress: progress || null };
  if (progress?.reservation?.verified) return { ...base, status: progress.status, schedulingSummary: planbarSchedulingSummary(progress) };
  if (run && !(run.status === 'queued' && command)) {
    const stopped = ['failed', 'blocked', 'timed_out', 'incomplete', 'completed'].includes(run.status);
    return { ...base, status: stopped ? (run.status === 'completed' ? 'incomplete' : run.status) : run.status,
      schedulingSummary: stopped
        ? `Noch kein Slot bestätigt. ${run.error || run.resultPreview || run.detail || 'Der Lauf hat keinen Reservierungsnachweis geliefert.'}`
        : `Terminierung läuft auf dem iMac. ${run.detail || 'Planbar-Slot wird geprüft und gesichert.'}` };
  }
  if (command?.status === 'queued') return { ...base, status: command.retryAt ? 'retrying' : 'queued', schedulingSummary: command.retryAt
    ? 'Der Start wird automatisch erneut versucht. Noch kein Slot bestätigt.'
    : 'Automatisch an den iMac übergeben; startet, sobald der iMac frei und verbunden ist. Noch kein Slot bestätigt.' };
  if (command && ['running', 'completed'].includes(command.status)) return { ...base, status: 'starting', schedulingSummary: 'Der iMac startet den Workflow. Noch kein Reservierungsnachweis vorhanden.' };
  if (command) return { ...base, status: command.status, schedulingSummary: `Terminierung nicht bestätigt (${command.status === 'failed' ? 'Start fehlgeschlagen' : command.status === 'expired' ? 'Auftrag abgelaufen' : 'Auftrag gestoppt'}). ${command.error || 'Kein Slot-Nachweis vorhanden.'}` };
  if (request.dispatchPending) return { ...base, status: 'retrying', schedulingSummary: 'Automatische Übergabe wird erneut versucht. Noch kein Slot bestätigt.' };
  return { ...base, status: 'not_started', schedulingSummary: 'Kein gestarteter iMac-Workflow und kein gesicherter Slot nachgewiesen.' };
}
