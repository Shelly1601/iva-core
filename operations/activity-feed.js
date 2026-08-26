const TERMINAL_STATUSES = new Set(['completed', 'failed', 'blocked', 'stopped', 'timed_out', 'incomplete', 'skipped', 'sent-and-verified']);

function clean(value, max = 2000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safePreview(value, max = 2000) {
  return clean(value, max)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[E-Mail]')
    .replace(/\bDE\d{20}\b/gi, '[IBAN]')
    .replace(/\+?[0-9][0-9\s()/.-]{7,}/g, '[Telefon]');
}

function timestamp(...values) {
  return values.map(value => clean(value, 80)).find(Boolean) || '';
}

function statusOf(value) {
  const status = clean(value, 50).toLowerCase();
  if (status === 'sent-and-verified') return 'completed';
  if (['timed_out', 'incomplete'].includes(status)) return 'failed';
  return status || 'recorded';
}

function eventTime(item = {}) {
  return timestamp(item.updatedAt, item.completedAt, item.startedAt, item.createdAt, item.executedAt);
}

function newest(left, right) {
  return eventTime(right).localeCompare(eventTime(left));
}

function latestTaskStatus(commands, jobId) {
  if (!jobId) return null;
  return commands
    .filter(command => command.action === 'codex.task.status' && command.payload?.jobId === jobId)
    .sort(newest)[0] || null;
}

function automationEvent(run = {}) {
  return {
    id: `automation:${run.id}`,
    type: 'automation',
    name: clean(run.automationName || run.automationId, 220),
    source: 'Railway-Automation',
    status: statusOf(run.status),
    summary: clean(run.summary || run.error || 'Automationslauf protokolliert.'),
    error: clean(run.error, 1000),
    startedAt: run.startedAt || '',
    completedAt: run.completedAt || '',
    updatedAt: eventTime(run),
    durationMs: run.durationMs ?? null,
    automationId: clean(run.automationId, 140),
    trigger: clean(run.trigger, 80),
  };
}

function agentEvent(run = {}) {
  return {
    id: `agent:${run.id}`,
    key: run.jobId ? `job:${run.jobId}` : '',
    type: run.channel === 'codex-build' ? 'build' : run.channel === 'project-workflow' ? 'workflow' : 'agent',
    name: clean(run.taskTitle || run.agentName || 'IVA-Agent', 220),
    source: clean(run.source || (run.channel === 'chat' ? 'IVA-Chat' : 'IVA-Agent'), 140),
    status: statusOf(run.status),
    summary: clean(run.resultPreview || run.requestPreview || run.error || 'Agentenlauf protokolliert.'),
    error: clean(run.error, 1000),
    phase: clean(run.phase, 80),
    progress: Number.isFinite(Number(run.progress)) ? Number(run.progress) : null,
    startedAt: timestamp(run.startedAt, run.createdAt),
    completedAt: run.completedAt || '',
    updatedAt: eventTime(run),
    durationMs: run.durationMs ?? null,
    tools: Array.isArray(run.tools) ? run.tools.map(value => clean(value, 120)).filter(Boolean) : [],
    proofs: Array.isArray(run.proofs) ? run.proofs.map(value => clean(value, 300)).filter(Boolean) : [],
    jobId: clean(run.jobId, 100),
    projectId: clean(run.projectId, 100),
    workflowId: clean(run.workflowId, 140),
  };
}

const DEVICE_NAMES = Object.freeze({
  'computer.status': 'iMac-Status prüfen',
  'funding.monitor.status': 'Fördermonitor-Status prüfen',
  'funding.monitor.run': 'Fördermonitor ausführen',
  'funding.reviews.list': 'Förder-Prüfliste lesen',
  'planbar.search.refresh': 'Planbar-Terminindex aktualisieren',
  'planbar.customer.schedule': 'Kunden in Planbar terminieren',
  'project.workflow.run': 'Projekt-Workflow ausführen',
  'portal.credentials.status': 'Portalzugang prüfen',
  'portal.login': 'Portal-Anmeldung',
  'app.open': 'App auf dem iMac öffnen',
  'codex.task.start': 'IVA-Bauauftrag starten',
});

function commandEvent(command = {}, commands = []) {
  if (command.action === 'codex.task.status') return null;
  const jobId = clean(command.result?.jobId, 100);
  const statusCommand = latestTaskStatus(commands, jobId);
  const local = statusCommand?.status === 'completed' ? statusCommand.result : null;
  const name = clean(
    command.payload?.displayName || command.payload?.title || command.requestText || DEVICE_NAMES[command.action] || command.action,
    220,
  );
  const status = statusOf(local?.status || command.status);
  const detail = clean(
    local?.resultPreview || local?.detail || command.error ||
      (jobId && command.status === 'completed' ? 'Lokaler Auftrag wurde gestartet.' : DEVICE_NAMES[command.action]),
  );
  return {
    id: `command:${command.id}`,
    key: jobId ? `job:${jobId}` : '',
    type: command.action === 'codex.task.start' ? 'build' : command.action === 'project.workflow.run' ? 'workflow' : 'command',
    name,
    source: 'iMac-Befehl',
    status,
    summary: detail,
    error: clean(local?.error || command.error, 1000),
    phase: clean(local?.phase, 80),
    progress: Number.isFinite(Number(local?.progress)) ? Number(local.progress) : null,
    startedAt: timestamp(local?.startedAt, command.startedAt, command.createdAt),
    completedAt: TERMINAL_STATUSES.has(clean(local?.status, 50)) ? timestamp(local?.completedAt, statusCommand?.completedAt) : '',
    updatedAt: timestamp(local?.updatedAt, statusCommand?.completedAt, command.completedAt, command.startedAt, command.createdAt),
    durationMs: null,
    jobId,
    projectId: clean(command.payload?.projectId, 100),
    workflowId: clean(command.payload?.workflowId, 140),
    action: clean(command.action, 100),
  };
}

function protocolEvent(run = {}, project = {}) {
  const metrics = run.metrics && typeof run.metrics === 'object' ? run.metrics : {};
  const proofs = [
    metrics.scope,
    Number(metrics.attachmentCount) > 0 ? `${metrics.attachmentCount} Anhänge` : '',
    metrics.sentFolderVerified === true ? 'Im Gesendet-Ordner verifiziert' : '',
  ].map(value => clean(value, 300)).filter(Boolean);
  return {
    id: `protocol:${project.id || 'project'}:${run.runId || run.id}`,
    key: metrics.jobId ? `job:${metrics.jobId}` : '',
    type: 'workflow',
    name: clean(run.workflowName || run.name || run.workflowId || run.automationId, 220),
    source: `${clean(project.name || project.id || 'Projekt', 120)} · Projektprotokoll`,
    status: statusOf(run.status || run.outcome),
    summary: clean(run.summary || run.details || 'Projektlauf protokolliert.'),
    error: clean(run.error, 1000),
    startedAt: timestamp(run.startedAt, run.executedAt),
    completedAt: timestamp(run.completedAt, run.executedAt),
    updatedAt: timestamp(run.completedAt, run.executedAt, run.startedAt),
    durationMs: null,
    proofs,
    jobId: clean(metrics.jobId, 100),
    projectId: clean(project.id, 100),
    workflowId: clean(run.workflowId || run.automationId, 140),
  };
}

function legacyProjectEvents(project = {}) {
  return (Array.isArray(project.runLog) ? project.runLog : []).map(run => protocolEvent({
    ...run,
    runId: run.id,
    workflowId: run.automationId,
    workflowName: project.automations?.find(item => item.id === run.automationId)?.name || run.automationId,
    startedAt: run.executedAt,
    completedAt: run.executedAt,
    metrics: {
      scope: run.scope,
      attachmentCount: run.attachmentCount,
      customerCount: run.customerCount,
      sentFolderVerified: run.status === 'sent-and-verified',
    },
  }, project));
}

function mergeEvents(events) {
  const merged = new Map();
  for (const event of events.filter(Boolean).sort(newest)) {
    const key = event.key || event.id;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, event);
      continue;
    }
    const protocolFirst = /Projektprotokoll/.test(event.source) ? event : /Projektprotokoll/.test(existing.source) ? existing : existing;
    const other = protocolFirst === event ? existing : event;
    merged.set(key, {
      ...other,
      ...protocolFirst,
      phase: protocolFirst.phase || other.phase,
      progress: protocolFirst.progress ?? other.progress,
      startedAt: timestamp(other.startedAt, protocolFirst.startedAt),
      completedAt: timestamp(protocolFirst.completedAt, other.completedAt),
      updatedAt: timestamp(protocolFirst.updatedAt, other.updatedAt),
      jobId: protocolFirst.jobId || other.jobId,
      proofs: [...new Set([...(protocolFirst.proofs || []), ...(other.proofs || [])])],
    });
  }
  return [...merged.values()].sort(newest);
}

export function buildControlActivityFeed({ agentRuns = [], automationRuns = [], deviceCommands = [], projects = [], protocolRuns = [] } = {}) {
  const protocolEvents = [];
  for (const project of projects) {
    protocolEvents.push(...legacyProjectEvents(project));
    protocolEvents.push(...protocolRuns
      .filter(item => !item.projectId || item.projectId === project.id)
      .map(item => protocolEvent(item, project)));
  }
  return mergeEvents([
    ...agentRuns.map(agentEvent),
    ...automationRuns.map(automationEvent),
    ...deviceCommands.map(command => commandEvent(command, deviceCommands)),
    ...protocolEvents,
  ]).slice(0, 200).map(event => ({
    ...event,
    summary: safePreview(event.summary),
    error: safePreview(event.error, 1000),
    proofs: (event.proofs || []).map(value => safePreview(value, 300)).filter(Boolean),
  }));
}

export function buildProjectWorkflowOverview(projects = [], activity = []) {
  const output = [];
  for (const project of projects) {
    for (const workflow of Array.isArray(project.automations) ? project.automations : []) {
      const recentRuns = activity
        .filter(event => event.workflowId === workflow.id && (!event.projectId || event.projectId === project.id))
        .sort(newest)
        .slice(0, 5);
      const lastRun = recentRuns[0] || null;
      const lastSuccessfulRun = recentRuns.find(event => event.status === 'completed') || null;
      output.push({
        ...workflow,
        projectId: project.id,
        projectName: project.name,
        lastRun,
        lastSuccessfulRun,
        recentRuns,
      });
    }
  }
  return output.sort((left, right) => {
    const activeDifference = Number(right.enabled === true) - Number(left.enabled === true);
    return activeDifference || String(left.name).localeCompare(String(right.name), 'de');
  });
}
