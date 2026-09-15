import { buildPlanbarSchedulingFollowup, planbarSchedulingKey, planbarSchedulingSummary } from './customer-scheduling.js';

// A technical interruption is an open repair task. Classification never grants
// permission to repeat a write; the worker must first read back the target.
export function classifyPlanbarSchedulingFailure(run = {}) {
  if (['stopped', 'cancelled', 'canceled'].includes(run.status)) return 'cancelled';
  const text = [run.error, run.resultPreview, run.detail].filter(Boolean).join(' ').slice(0, 6000);
  if (/captcha|kontosperre|account (?:locked|suspended)|(?:zugang|berechtigung|freigabe|approval).{0,70}(?:verweigert|abgelehnt|nicht vorhanden|nicht verfügbar|denied|required)|(?:passwort|zugangsdaten).{0,70}(?:ungültig|abgelehnt|nicht vorhanden)|kein(?:e|en|er)?\s+(?:passender?\s+)?(?:zugang|zugangsdaten|schlüsselbund[- ]eintrag).{0,60}(?:vorhanden|verfügbar)/i.test(text)) return 'external';
  if (/identität.{0,70}(?:mehrdeutig|unklar|widerspr)|(?:kunde|objekt).{0,60}(?:nicht eindeutig|mehrere passende|mehrdeutig)|keine.{0,60}(?:zulässige|freie).{0,40}(?:ressource|kapazität)|kein zulässiger ENTER-Blocker|(?:quellen|unterlagen|auftragsnummer).{0,60}(?:widerspr|mehrdeutig)/i.test(text)) return 'business';
  if (['recovering', 'repair_pending', 'recovery_pending'].includes(run.phase) || run.status === 'timed_out'
    || /timeout|timed out|ETIMEDOUT|ECONN|EAGAIN|ENOTFOUND|socket|net::|browser|tab\b|fenster|display|applescript|osascript|reload|neu geladen|sitzung|login|verbindung|steuerung|worker|prozess|unterbrochen|nicht gestartet|startfehler|speicher(?:n|ergebnis).{0,30}unklar/i.test(text)) return 'recoverable_technical';
  return '';
}

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
  if (progress?.reservation?.verified) {
    const followup = buildPlanbarSchedulingFollowup({ ...request, jobId: run?.jobId || command?.result?.jobId || '' }, progress);
    return { ...base, status: progress.status, schedulingSummary: planbarSchedulingSummary(progress), schedulingFollowup: followup };
  }
  if (run && !(run.status === 'queued' && command)) {
    const stopped = ['failed', 'blocked', 'timed_out', 'incomplete', 'completed'].includes(run.status);
    const failureKind = classifyPlanbarSchedulingFailure(run);
    if ((stopped || ['recovering', 'repair_pending', 'recovery_pending'].includes(run.phase)) && failureKind === 'recoverable_technical') return {
      ...base, status: 'retrying', failureKind, recoveryRequired: true, requiresTargetReadback: true,
      schedulingSummary: run.phase === 'recovering' || run.nextAttemptAt
        ? 'Technische Fortsetzung ist vorgemerkt. Vor jeder weiteren Buchung wird der bestehende Planbar-Zustand rückgelesen. Noch kein Slot bestätigt.'
        : 'Technische Nachprüfung bleibt offen. Zuerst den Planbar-Zustand rücklesen, dann gezielt fortsetzen. Noch kein Slot bestätigt.',
    };
    return { ...base, status: stopped ? (run.status === 'completed' ? 'incomplete' : run.status) : run.status,
      schedulingSummary: stopped
        ? `Noch kein Slot bestätigt. ${run.error || run.resultPreview || run.detail || 'Der Lauf hat keinen Reservierungsnachweis geliefert.'}`
        : `Terminierung läuft auf dem Mac Mini. ${run.detail || 'Planbar-Slot wird geprüft und gesichert.'}` };
  }
  if (command?.status === 'queued') return { ...base, status: command.retryAt ? 'retrying' : 'queued', schedulingSummary: command.retryAt
    ? 'Der Start wird automatisch erneut versucht. Noch kein Slot bestätigt.'
    : 'Automatisch an den Mac Mini übergeben; startet, sobald der Mac Mini frei und verbunden ist. Noch kein Slot bestätigt.' };
  if (command && ['running', 'completed'].includes(command.status)) return { ...base, status: 'starting', schedulingSummary: 'Der Mac Mini startet den Workflow. Noch kein Reservierungsnachweis vorhanden.' };
  if (command && classifyPlanbarSchedulingFailure(command) === 'recoverable_technical') return { ...base, status: 'retrying', failureKind: 'recoverable_technical', recoveryRequired: true, requiresTargetReadback: true,
    schedulingSummary: 'Technische Nachprüfung bleibt offen. Vor einem erneuten Start wird der vorhandene Planbar-Zustand geprüft. Noch kein Slot bestätigt.' };
  if (command) return { ...base, status: command.status, schedulingSummary: `Terminierung nicht bestätigt (${command.status === 'failed' ? 'Start fehlgeschlagen' : command.status === 'expired' ? 'Auftrag abgelaufen' : 'Auftrag gestoppt'}). ${command.error || 'Kein Slot-Nachweis vorhanden.'}` };
  if (request.dispatchPending) return { ...base, status: 'retrying', schedulingSummary: 'Automatische Übergabe wird erneut versucht. Noch kein Slot bestätigt.' };
  return { ...base, status: 'not_started', schedulingSummary: 'Kein gestarteter Mac Mini-Workflow und kein gesicherter Slot nachgewiesen.' };
}
