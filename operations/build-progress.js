const BUILD_PHASES = Object.freeze([
  Object.freeze({ id: 'planning', label: 'Planung', progress: 10 }),
  Object.freeze({ id: 'implementing', label: 'Umsetzung', progress: 30 }),
  Object.freeze({ id: 'testing', label: 'Tests', progress: 50 }),
  Object.freeze({ id: 'committing', label: 'Commit', progress: 65 }),
  Object.freeze({ id: 'pushing', label: 'Push', progress: 75 }),
  Object.freeze({ id: 'deploying', label: 'Railway-Deploy', progress: 88 }),
  Object.freeze({ id: 'live_verification', label: 'Live-Prüfung', progress: 96 }),
  Object.freeze({ id: 'completed', label: 'Fertig', progress: 100 }),
]);

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'blocked', 'timed_out', 'incomplete']);
const ACTIVE_TASK_STATUSES = new Set(['queued', 'running']);

function clean(value, max = 2000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function byNewest(a, b) {
  return String(b.updatedAt || b.completedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.completedAt || a.createdAt || ''));
}

function phaseIndex(phase) {
  return BUILD_PHASES.findIndex(item => item.id === phase);
}

function progressForPhase(phase, fallback = 0) {
  return BUILD_PHASES.find(item => item.id === phase)?.progress ?? fallback;
}

function buildSteps(phase, status) {
  const currentIndex = phaseIndex(phase);
  return BUILD_PHASES.map((item, index) => ({
    ...item,
    state: status === 'completed' || index < currentIndex
      ? 'completed'
      : index === currentIndex
        ? (status === 'blocked' || status === 'failed' || status === 'timed_out' || status === 'incomplete' ? 'blocked' : 'current')
        : 'pending',
  }));
}

function latestStatusCommand(commands, jobId) {
  return commands
    .filter(command => command.action === 'codex.task.status' && command.payload?.jobId === jobId)
    .sort(byNewest)[0] || null;
}

function taskFromRequest(request, commands) {
  const start = commands
    .filter(command => command.action === 'codex.task.start')
    .filter(command => command.id === request.commandId || command.payload?.requestId === request.id)
    .sort(byNewest)[0] || null;
  const jobId = clean(request.jobId || start?.result?.jobId, 100);
  const statusCommand = jobId ? latestStatusCommand(commands, jobId) : null;
  const local = statusCommand?.status === 'completed' && statusCommand.result ? statusCommand.result : null;

  let status = 'queued';
  let phase = 'planning';
  let progress = 5;
  let detail = 'Auftrag ist erfasst und wartet auf die Übergabe an den iMac.';
  let blocker = '';
  let updatedAt = request.updatedAt || request.createdAt;

  if (start?.status === 'queued') {
    progress = 8;
    detail = 'Übergabe an den iMac ist eingereiht.';
    updatedAt = start.createdAt || updatedAt;
  } else if (start?.status === 'running') {
    status = 'running';
    progress = 9;
    detail = 'Der iMac nimmt den Bauauftrag gerade an.';
    updatedAt = start.startedAt || updatedAt;
  } else if (['failed', 'expired'].includes(start?.status)) {
    status = 'blocked';
    phase = 'planning';
    progress = 8;
    blocker = clean(start.error || (start.status === 'expired' ? 'Die Übergabe an den iMac ist abgelaufen.' : 'Die Übergabe an den iMac ist fehlgeschlagen.'), 1000);
    detail = blocker;
    updatedAt = start.completedAt || updatedAt;
  } else if (jobId) {
    status = 'running';
    progress = 10;
    detail = 'Codex hat den Auftrag angenommen.';
    updatedAt = start?.completedAt || updatedAt;
  }

  if (local) {
    const localStatus = clean(local.status, 40) || 'running';
    phase = clean(local.phase, 60) || (localStatus === 'completed' ? 'completed' : phase);
    progress = Math.max(0, Math.min(100, Number(local.progress) || progressForPhase(phase, progress)));
    updatedAt = local.updatedAt || local.completedAt || local.startedAt || updatedAt;
    detail = clean(local.detail || local.resultPreview || detail, 1800);
    if (TERMINAL_TASK_STATUSES.has(localStatus)) status = localStatus === 'completed' ? 'completed' : 'blocked';
    else if (ACTIVE_TASK_STATUSES.has(localStatus)) status = localStatus;
    if (localStatus === 'failed' || localStatus === 'blocked' || localStatus === 'timed_out' || localStatus === 'incomplete') {
      blocker = clean(local.error || local.detail || local.resultPreview || `Codex-Status: ${localStatus}`, 1000);
    }
  } else if (statusCommand?.status === 'failed' || statusCommand?.status === 'expired') {
    detail = 'Die letzte Statusabfrage ist fehlgeschlagen; der Auftrag selbst kann weiterhin laufen.';
  }

  if (status === 'completed') {
    phase = 'completed';
    progress = 100;
    detail = clean(local?.resultPreview || local?.detail || 'Umsetzung, Tests, Deployment und Live-Prüfung sind abgeschlossen.', 1800);
  }

  const resultText = clean(local?.resultPreview || local?.detail, 4000);
  const gitCommit = resultText.match(/(?:commit|git(?:-stand)?)[^0-9a-f]{0,20}([0-9a-f]{7,40})/i)?.[1] || '';
  const liveUrl = resultText.match(/https:\/\/[^\s)\]}>,]+/i)?.[0] || '';
  return {
    id: request.id,
    requestId: request.id,
    commandId: start?.id || request.commandId || '',
    jobId,
    title: clean(request.title || 'IVA-Bauauftrag', 180),
    description: clean(request.desiredOutcome || request.description, 1200),
    status,
    phase,
    phaseLabel: BUILD_PHASES.find(item => item.id === phase)?.label || 'Wartet',
    progress,
    detail,
    blocker,
    steps: buildSteps(phase, status),
    createdAt: request.createdAt,
    updatedAt,
    completedAt: local?.completedAt || '',
    resultPreview: clean(local?.resultPreview, 1800),
    gitCommit,
    liveUrl,
    livePath: liveUrl,
    liveStatus: status === 'completed' ? 'live' : '',
  };
}

function operationalSteps(status) {
  const terminal = status === 'completed';
  const blocked = status === 'blocked';
  return [
    { id: 'queued', label: 'Eingereiht', progress: 10, state: 'completed' },
    { id: 'accepted', label: 'Angenommen', progress: 30, state: 'completed' },
    { id: 'running', label: 'Ausführung', progress: 70, state: terminal ? 'completed' : blocked ? 'blocked' : 'current' },
    { id: 'completed', label: 'Ergebnis geprüft', progress: 100, state: terminal ? 'completed' : 'pending' },
  ];
}

function taskFromOperationalRun(run = {}) {
  const rawStatus = clean(run.status, 50);
  const terminalFailure = ['failed', 'blocked', 'timed_out', 'incomplete', 'stopped'].includes(rawStatus);
  const status = rawStatus === 'completed' ? 'completed' : terminalFailure ? 'blocked' : rawStatus === 'queued' ? 'queued' : 'running';
  const build = run.channel === 'codex-build';
  const phase = build
    ? (BUILD_PHASES.some(item => item.id === run.phase) ? run.phase : status === 'completed' ? 'completed' : 'implementing')
    : (status === 'completed' ? 'completed' : clean(run.phase, 60) || 'running');
  const progress = status === 'completed'
    ? 100
    : Math.max(0, Math.min(99, Number(run.progress) || (status === 'queued' ? 5 : build ? progressForPhase(phase, 30) : 70)));
  const detail = clean(run.resultPreview || run.requestPreview || (status === 'queued' ? 'Der Auftrag wartet auf die lokale Ausführung.' : 'Der Auftrag läuft.'), 1800);
  return {
    id: run.id, requestId: '', commandId: '', jobId: clean(run.jobId, 100),
    title: clean(run.taskTitle || run.agentName || 'IVA-Hintergrundauftrag', 180),
    description: clean(run.requestPreview, 1200), status, phase,
    phaseLabel: build ? BUILD_PHASES.find(item => item.id === phase)?.label || 'Umsetzung' : status === 'completed' ? 'Ergebnis geprüft' : status === 'queued' ? 'Eingereiht' : 'Befehl läuft',
    progress, detail, blocker: terminalFailure ? clean(run.error || detail, 1000) : '',
    steps: build ? buildSteps(phase, status) : operationalSteps(status),
    createdAt: run.createdAt || run.startedAt, updatedAt: run.updatedAt || run.completedAt || run.createdAt,
    completedAt: run.completedAt || '', resultPreview: clean(run.resultPreview, 1800),
    gitCommit: '', liveUrl: '', livePath: '', liveStatus: status === 'completed' && build ? 'live' : '',
    source: clean(run.source, 120), workflowId: clean(run.workflowId, 140),
  };
}

function releaseFallback(release = {}) {
  if (!release?.title) return null;
  const railwayDomain = clean(process.env.RAILWAY_PUBLIC_DOMAIN, 300);
  const liveUrl = railwayDomain ? `https://${railwayDomain}` : clean(release.liveUrl, 500);
  return {
    id: clean(release.id || 'current-release', 120),
    title: clean(release.title, 180),
    description: clean(release.summary, 1200),
    status: 'completed',
    phase: 'completed',
    phaseLabel: 'Fertig',
    progress: 100,
    detail: clean(release.detail || 'Auf der laufenden IVA-Version verfügbar.', 1800),
    blocker: '',
    steps: buildSteps('completed', 'completed'),
    createdAt: release.implementedAt,
    updatedAt: release.implementedAt,
    completedAt: release.implementedAt,
    gitCommit: clean(process.env.RAILWAY_GIT_COMMIT_SHA || release.gitCommit, 80),
    deploymentId: clean(process.env.RAILWAY_DEPLOYMENT_ID, 120),
    liveUrl,
    liveStatus: railwayDomain || process.env.RAILWAY_ENVIRONMENT ? 'live' : 'local',
    livePath: clean(release.livePath || '/control', 300),
  };
}

export function buildProgressSnapshot({ requests = [], commands = [], operationRuns = [], release = null } = {}) {
  const requestedTasks = (Array.isArray(requests) ? requests : [])
    .filter(request => !['rejected'].includes(request.status))
    .map(request => taskFromRequest(request, Array.isArray(commands) ? commands : []));
  const requestedJobIds = new Set(requestedTasks.map(task => task.jobId).filter(Boolean));
  const reportedTasks = (Array.isArray(operationRuns) ? operationRuns : [])
    .filter(run => ['codex-build', 'project-workflow'].includes(run.channel))
    .filter(run => !run.jobId || !requestedJobIds.has(run.jobId))
    .map(taskFromOperationalRun);
  const tasks = [...requestedTasks, ...reportedTasks].sort(byNewest);
  const active = tasks.filter(task => task.status === 'running');
  const queued = tasks.filter(task => task.status === 'queued');
  const blocked = tasks.filter(task => task.status === 'blocked');
  const completed = tasks.filter(task => task.status === 'completed');
  const fallback = releaseFallback(release);
  const latestImplementation = [completed[0], fallback].filter(Boolean).sort(byNewest)[0] || null;
  return {
    phases: BUILD_PHASES,
    active,
    queued,
    blocked,
    recent: completed.slice(0, 12),
    latestImplementation,
    counts: { active: active.length, queued: queued.length, blocked: blocked.length, completed: completed.length },
  };
}

export function buildJobsNeedingRefresh({ requests = [], commands = [], now = Date.now(), minAgeMs = 20_000, limit = 4 } = {}) {
  const jobs = [];
  const allCommands = Array.isArray(commands) ? commands : [];
  const origins = allCommands
    .filter(command => ['codex.task.start', 'project.workflow.run', 'planbar.customer.schedule'].includes(command.action))
    .filter(command => command.result?.jobId);
  const requestedByCommand = new Map((Array.isArray(requests) ? requests : []).map(request => [request.commandId, request]));
  for (const start of origins) {
    const request = requestedByCommand.get(start.id) || (Array.isArray(requests) ? requests : [])
      .find(item => start.payload?.requestId && item.id === start.payload.requestId) || {};
    const jobId = clean(request.jobId || start?.result?.jobId, 100);
    if (!jobId) continue;
    const latest = latestStatusCommand(allCommands, jobId);
    const localStatus = latest?.status === 'completed' ? latest.result?.status : '';
    if (TERMINAL_TASK_STATUSES.has(localStatus)) continue;
    if (latest && ['queued', 'running'].includes(latest.status)) continue;
    const lastAt = Date.parse(latest?.completedAt || latest?.createdAt || start?.completedAt || start?.createdAt || 0);
    if (Number.isFinite(lastAt) && now - lastAt < minAgeMs) continue;
    jobs.push({ jobId, requestId: request.id || '', title: clean(request.title || start.payload?.displayName || start.payload?.title || start.requestText || start.action, 180), originCommandId: start.id, workflowId: clean(start.payload?.workflowId, 140) });
    if (jobs.length >= limit) break;
  }
  return jobs;
}

export const CURRENT_BUILD_RELEASE = Object.freeze({
  id: 'self-learning-incident-memory-v1',
  title: 'Selbstlernendes Fehlergedächtnis für alle IVA-Läufe',
  summary: 'Technische Störungen werden lokal und zentral dedupliziert, sanitisiert, nach verifizierter Reparatur als Prävention wiederverwendet und im Kontrollzentrum verständlich angezeigt.',
  detail: 'IVA-Chat, iMac-/Codex-Aufträge, Projekt-Workflows und Railway-Automationen laden passende bewährte Reparaturen vor dem nächsten ähnlichen Lauf. Unklare Schreibaktionen bleiben gegen blinde Wiederholung geschützt.',
  implementedAt: '2026-09-02T08:35:00.000Z',
  livePath: '/control',
});

export { BUILD_PHASES };
