const DELIVERY_MODES = new Set(['download', 'email-draft', 'email-send']);

function clean(value, max = 500) {
  return String(value || '').replace(/\u0000/g, '').trim().slice(0, max);
}

function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (/^(?:127|0|10|169\.254)\./.test(host) || /^192\.168\./.test(host)) return true;
  const match = host.match(/^172\.(\d{1,3})\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
}

export function validateDewarmteLinkPdfInput(input = {}) {
  const source = clean(input.sourceUrl, 2000);
  let parsed;
  try { parsed = new URL(source); }
  catch { throw new Error('Bitte einen vollständigen gültigen Link zum Installationsplan einfügen.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || isPrivateHostname(parsed.hostname)) {
    throw new Error('Der Installationsplan muss über einen öffentlichen HTTPS-Link ohne eingebettete Zugangsdaten erreichbar sein.');
  }
  const deliveryMode = DELIVERY_MODES.has(input.deliveryMode) ? input.deliveryMode : 'download';
  const recipientEmail = clean(input.recipientEmail, 320).toLowerCase();
  if (deliveryMode !== 'download' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
    throw new Error('Für Mailentwurf oder Versand wird eine gültige Empfängeradresse benötigt.');
  }
  parsed.hash = '';
  const supplementaryText = clean(input.supplementaryText, 8000);
  const supplementaryPdfId = clean(input.supplementaryPdfId, 100);
  const supplementaryPdfName = clean(input.supplementaryPdfName, 240);
  if (supplementaryPdfId && !/^[a-f0-9-]{36}$/i.test(supplementaryPdfId)) {
    throw new Error('Die zusätzliche PDF konnte dem Auftrag nicht sicher zugeordnet werden.');
  }
  return {
    sourceUrl: parsed.toString(),
    deliveryMode,
    recipientEmail: deliveryMode === 'download' ? '' : recipientEmail,
    supplementaryText,
    supplementaryPdfId,
    supplementaryPdfName: supplementaryPdfId ? (supplementaryPdfName || 'Zusatzinformation.pdf') : '',
  };
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'blocked', 'timed_out', 'incomplete']);

function workflowPhase(status, phase, deliveryMode, hasFile) {
  if (status === 'completed') return deliveryMode === 'email-send' ? 'PDF gespeichert und Versand verifiziert' : 'PDF ist zum Download bereit';
  if (status === 'failed') return 'Auftrag fehlgeschlagen';
  if (status === 'blocked' || status === 'incomplete') return 'Prüfung oder Eingabe erforderlich';
  if (status === 'timed_out') return 'Zeitüberschreitung – Prüfung erforderlich';
  if (hasFile) return deliveryMode === 'email-send' ? 'PDF gespeichert · Mailstatus wird geprüft' : 'PDF ist in der Projektakte gespeichert';
  return ({
    queued: 'Auftrag angenommen · wartet auf den iMac',
    running: 'Installationsplan wird lesend geöffnet',
    planning: 'Quelle und Auftragsdaten werden geprüft',
    implementing: 'Material wird zugeordnet und PDF erstellt',
    testing: 'PDF wird gerendert und visuell geprüft',
    committing: 'Ergebnis wird für die Ablage vorbereitet',
    pushing: 'Ergebnis wird an IVA übergeben',
    deploying: 'PDF wird in der Projektakte gespeichert',
    live_verification: deliveryMode === 'email-send' ? 'Ablage und Mailversand werden geprüft' : 'Ablage und Download werden geprüft',
  })[phase] || 'Auftrag wird bearbeitet';
}

function workflowProgress(status, phase, reportedProgress, hasFile) {
  if (status === 'completed') return 100;
  const numeric = Number(reportedProgress);
  if (Number.isFinite(numeric) && numeric > 0) return Math.max(1, Math.min(99, Math.round(numeric)));
  if (hasFile) return 94;
  if (TERMINAL_STATUSES.has(status)) return 5;
  return ({ queued: 5, running: 12, planning: 18, implementing: 42, testing: 68, committing: 76, pushing: 82, deploying: 90, live_verification: 96 })[phase] || 8;
}

export function summarizeDewarmteLinkPdfJobs(commands = [], files = [], runs = [], agentRuns = []) {
  const statusByJobId = new Map();
  for (const command of commands) {
    if (command?.action !== 'codex.task.status' || !command.payload?.jobId || command.status !== 'completed') continue;
    const previous = statusByJobId.get(command.payload.jobId);
    if (!previous || String(command.completedAt || command.createdAt).localeCompare(String(previous.completedAt || previous.createdAt)) > 0) {
      statusByJobId.set(command.payload.jobId, command);
    }
  }
  return commands
    .filter(command => command?.action === 'project.workflow.run'
      && command.payload?.projectId === 'dewarmte'
      && command.payload?.workflowId === 'dewarmte-link-to-material-pdf')
    .map(command => {
      const jobId = clean(command.result?.jobId, 100);
      const statusCommand = statusByJobId.get(jobId);
      const run = runs.find(item => item?.workflowId === 'dewarmte-link-to-material-pdf' && item?.metrics?.jobId === jobId) || null;
      const agentRun = agentRuns.find(item => item?.projectId === 'dewarmte'
        && item?.workflowId === 'dewarmte-link-to-material-pdf'
        && item?.jobId === jobId) || null;
      const file = files
        .filter(item => item.jobId === jobId)
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0] || null;
      const local = statusCommand?.result || {};
      const commandFallbackStatus = command.status === 'completed' ? (jobId ? 'running' : 'queued') : command.status;
      const reportedStatus = clean(agentRun?.status || run?.status || local.status || command.result?.status || commandFallbackStatus, 50) || 'queued';
      const missingResult = reportedStatus === 'completed' && !file;
      const status = missingResult ? 'incomplete' : reportedStatus;
      const needsAttention = ['failed', 'blocked', 'timed_out', 'incomplete'].includes(status);
      const reportedDetail = clean(agentRun?.error || agentRun?.resultPreview || run?.error || run?.summary || local.resultPreview || local.detail || command.error, 700);
      const rawPhase = clean(agentRun?.phase || run?.metrics?.phase || local.phase || reportedStatus, 80) || 'queued';
      const deliveryMode = clean(command.payload?.deliveryMode, 30) || 'download';
      return {
        id: command.id,
        jobId,
        status,
        progress: workflowProgress(status, rawPhase, agentRun?.progress ?? run?.metrics?.progress ?? local.progress, Boolean(file)),
        phase: workflowPhase(status, rawPhase, deliveryMode, Boolean(file)),
        active: !TERMINAL_STATUSES.has(status),
        detail: file
          ? `PDF ist fertig und liegt in der DeWarmte-Projektakte.${needsAttention && reportedDetail ? ` Weitere Aktion nötig: ${reportedDetail}` : ''}`
          : (missingResult ? 'Der Lauf meldet Abschluss, aber in der Projektakte fehlt die Ergebnis-PDF.' : (reportedDetail || 'Auftrag wartet auf den iMac.')),
        deliveryMode,
        recipientEmail: clean(command.payload?.recipientEmail, 320),
        createdAt: clean(command.createdAt, 80),
        updatedAt: clean(agentRun?.updatedAt || run?.completedAt || local.updatedAt || statusCommand?.completedAt || command.completedAt || command.startedAt || command.createdAt, 80),
        file: file ? { id: file.id, name: file.name, bytes: file.bytes, createdAt: file.createdAt } : null,
      };
    })
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .slice(0, 30);
}

export const DEWARMTE_DELIVERY_MODES = Object.freeze([...DELIVERY_MODES]);
