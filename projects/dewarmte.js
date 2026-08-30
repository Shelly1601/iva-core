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

export function summarizeDewarmteLinkPdfJobs(commands = [], files = [], runs = []) {
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
      const file = files.find(item => item.jobId === jobId) || null;
      const local = statusCommand?.result || {};
      const reportedStatus = clean(run?.status || local.status || command.result?.status || command.status, 50) || 'queued';
      const needsAttention = ['failed', 'blocked', 'timed_out', 'incomplete'].includes(reportedStatus);
      const reportedDetail = clean(run?.error || run?.summary || local.resultPreview || local.detail || command.error, 700);
      return {
        id: command.id,
        jobId,
        status: file && !needsAttention ? 'completed' : reportedStatus,
        detail: file
          ? `PDF ist fertig und liegt in der DeWarmte-Projektakte.${needsAttention && reportedDetail ? ` Weitere Aktion nötig: ${reportedDetail}` : ''}`
          : (reportedDetail || 'Auftrag wartet auf den iMac.'),
        deliveryMode: clean(command.payload?.deliveryMode, 30) || 'download',
        recipientEmail: clean(command.payload?.recipientEmail, 320),
        createdAt: clean(command.createdAt, 80),
        updatedAt: clean(local.updatedAt || statusCommand?.completedAt || command.completedAt || command.startedAt || command.createdAt, 80),
        file: file ? { id: file.id, name: file.name, bytes: file.bytes, createdAt: file.createdAt } : null,
      };
    })
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .slice(0, 30);
}

export const DEWARMTE_DELIVERY_MODES = Object.freeze([...DELIVERY_MODES]);
