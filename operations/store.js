import fs from 'fs/promises';
import crypto from 'crypto';
import { mergePlanbarSchedulingProgress, planbarSchedulingSummary } from './customer-scheduling.js';

const DATA_DIR = process.env.DATA_DIR || '/data';
const STORE_FILE = `${DATA_DIR}/operations.json`;
const RETENTION_MS = 120 * 24 * 60 * 60 * 1000;
let writeQueue = Promise.resolve();

function emptyStore() {
  return { version: 1, runs: [], approvals: [], audit: [] };
}

function clean(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function safePreview(value) {
  return clean(value, 260)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[E-Mail]')
    .replace(/\bDE\d{20}\b/gi, '[IBAN]')
    .replace(/\+?[0-9][0-9\s()/.-]{7,}/g, candidate => ((candidate.match(/\d/g) || []).length >= 8 ? '[Telefon]' : candidate));
}

function safeTimestamp(value, fallback = '') {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function normalizedRunStatus(value) {
  const status = clean(value, 40).toLowerCase();
  return ['queued', 'running', 'completed', 'failed', 'blocked', 'stopped', 'timed_out', 'incomplete'].includes(status)
    ? status
    : 'running';
}

function sessionHash(value) {
  return value ? crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12) : '';
}

async function load() {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE_FILE, 'utf8'));
    const now = Date.now();
    return {
      ...emptyStore(),
      ...parsed,
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      approvals: Array.isArray(parsed.approvals) ? parsed.approvals.map(item => ({
        ...item,
        status: item.status === 'pending' && item.expiresAt && Date.parse(item.expiresAt) < now ? 'expired' : item.status,
      })) : [],
      audit: Array.isArray(parsed.audit) ? parsed.audit : [],
    };
  } catch {
    return emptyStore();
  }
}

async function save(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(store, null, 2), { mode: 0o600 });
  await fs.rename(temporary, STORE_FILE);
}

async function mutate(fn) {
  let result;
  const job = writeQueue.catch(() => {}).then(async () => {
    const store = await load();
    result = await fn(store);
    const cutoff = Date.now() - RETENTION_MS;
    store.runs = store.runs.filter(item => Date.parse(item.createdAt || 0) >= cutoff).slice(-2000);
    store.approvals = store.approvals.filter(item => item.status === 'pending' || Date.parse(item.updatedAt || item.createdAt || 0) >= cutoff).slice(-1500);
    store.audit = store.audit.filter(item => Date.parse(item.createdAt || 0) >= cutoff).slice(-4000);
    await save(store);
  });
  writeQueue = job.catch(() => {});
  await job;
  return result;
}

export async function beginAgentRun(input = {}) {
  return mutate(store => {
    const now = new Date().toISOString();
    const item = {
      id: crypto.randomUUID(),
      agentId: clean(input.agentId || 'iva-standard', 100),
      agentName: clean(input.agentName || 'IVA', 160),
      routeReason: clean(input.routeReason || 'standard', 160),
      channel: clean(input.channel || 'chat', 80),
      session: sessionHash(input.sessionId),
      requestPreview: safePreview(input.requestPreview),
      status: 'running',
      tools: [],
      durationMs: null,
      createdAt: now,
      updatedAt: now,
    };
    store.runs.push(item);
    return structuredClone(item);
  });
}

export async function finishAgentRun(id, input = {}) {
  return mutate(store => {
    const item = store.runs.find(run => run.id === id);
    if (!item) return null;
    item.status = ['completed', 'failed', 'stopped'].includes(input.status) ? input.status : 'completed';
    item.tools = [...new Set((input.tools || []).map(value => clean(value, 120)).filter(Boolean))].slice(0, 30);
    item.durationMs = Number.isFinite(Number(input.durationMs)) ? Math.max(0, Math.round(Number(input.durationMs))) : null;
    item.resultPreview = safePreview(input.resultPreview);
    item.error = item.status === 'failed' ? safePreview(input.error || 'Unbekannter Fehler') : '';
    item.updatedAt = new Date().toISOString();
    return structuredClone(item);
  });
}

// Lokale Codex-/iMac-Läufe melden ihren echten Zustand über einen stabilen
// externen Schlüssel. Dadurch wird derselbe Lauf vom Start bis zum Ergebnis
// aktualisiert, statt bei jedem Meilenstein als neuer Chatlauf aufzutauchen.
export async function upsertExternalAgentRun(input = {}) {
  const externalKey = clean(input.externalKey, 180);
  if (!externalKey) throw new Error('Für einen externen Lauf fehlt der stabile Schlüssel.');
  return mutate(store => {
    const now = new Date().toISOString();
    const existing = store.runs.find(run => run.externalKey === externalKey);
    if (existing?.schedulingKey && Date.parse(input.updatedAt) < Date.parse(existing.updatedAt)) {
      // Der Geräteabgleich darf einen neueren Abschluss nicht mit einem alten
      // Zwischenstand überschreiben. Einen verspäteten ERSTEN Slotbeleg behalten.
      if (!existing.planbarProgress?.reservation?.verified && input.planbarProgress?.reservation?.verified) {
        const reserved = mergePlanbarSchedulingProgress(null, { ...input.planbarProgress, status: 'reserved' });
        existing.planbarProgress = mergePlanbarSchedulingProgress(reserved, input.planbarProgress);
        existing.resultPreview = safePreview(planbarSchedulingSummary(existing.planbarProgress));
      }
      return structuredClone(existing);
    }
    const item = existing || {
      id: crypto.randomUUID(),
      externalKey,
      createdAt: safeTimestamp(input.startedAt || input.createdAt, now),
      tools: [],
      durationMs: null,
    };
    const status = normalizedRunStatus(input.status);
    const startedAt = safeTimestamp(input.startedAt, item.startedAt || item.createdAt);
    const completedAt = ['completed', 'failed', 'blocked', 'stopped', 'timed_out', 'incomplete'].includes(status)
      ? safeTimestamp(input.completedAt || input.updatedAt, now)
      : '';
    Object.assign(item, {
      agentId: clean(input.agentId || item.agentId || 'iva-operations', 100),
      agentName: clean(input.agentName || input.taskTitle || item.agentName || 'IVA-Hintergrundlauf', 180),
      taskTitle: safePreview(input.taskTitle || input.agentName || item.taskTitle || item.agentName),
      routeReason: clean(input.routeReason || item.routeReason || 'background-operation', 180),
      channel: clean(input.channel || item.channel || 'background', 80),
      source: clean(input.source || item.source || 'IVA-Hintergrund', 120),
      jobId: clean(input.jobId || item.jobId, 100),
      projectId: clean(input.projectId || item.projectId, 100),
      workflowId: clean(input.workflowId || item.workflowId, 140),
      schedulingKey: /^[a-f0-9]{64}$/.test(input.schedulingKey || '') ? input.schedulingKey : (item.schedulingKey || ''),
      requestPreview: safePreview(input.requestPreview || input.taskTitle || item.requestPreview),
      resultPreview: safePreview(input.resultPreview || input.detail || item.resultPreview),
      error: ['failed', 'blocked', 'timed_out', 'incomplete'].includes(status)
        ? safePreview(input.error || input.detail || item.error || 'Lauf nicht erfolgreich abgeschlossen.')
        : '',
      status,
      phase: clean(input.phase || item.phase, 80),
      progress: Math.max(0, Math.min(100, Number(input.progress ?? item.progress) || 0)),
      tools: [...new Set([...(item.tools || []), ...(Array.isArray(input.tools) ? input.tools : [])]
        .map(value => clean(value, 120)).filter(Boolean))].slice(0, 30),
      proofs: (Array.isArray(input.proofs) ? input.proofs : (item.proofs || []))
        .map(value => safePreview(value)).filter(Boolean).slice(0, 12),
      startedAt,
      completedAt,
      updatedAt: safeTimestamp(input.updatedAt, now),
    });
    if (input.planbarProgress) {
      const baseline = item.planbarProgress || mergePlanbarSchedulingProgress(null, { ...input.planbarProgress, status: 'reserved' });
      item.planbarProgress = mergePlanbarSchedulingProgress(baseline, input.planbarProgress);
    }
    if (item.planbarProgress?.reservation?.verified) {
      item.resultPreview = safePreview(planbarSchedulingSummary(item.planbarProgress));
      if (item.planbarProgress.status !== 'completed' && item.status === 'completed') item.status = 'incomplete';
    }
    item.durationMs = completedAt
      ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt || item.createdAt))
      : null;
    if (!existing) store.runs.push(item);
    return structuredClone(item);
  });
}

export async function listAgentRuns({ limit = 80, status = '', agentId = '' } = {}) {
  const store = await load();
  return store.runs
    .filter(item => !status || item.status === status)
    .filter(item => !agentId || item.agentId === agentId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 80)));
}

export async function createApproval(input = {}) {
  return mutate(store => {
    const now = new Date().toISOString();
    const externalKey = clean(input.externalKey, 200);
    const existing = externalKey && store.approvals.find(item => item.externalKey === externalKey && item.status === 'pending');
    const item = existing || { id: crypto.randomUUID(), createdAt: now };
    Object.assign(item, {
      type: clean(input.type || 'action', 100),
      title: clean(input.title || 'Freigabe erforderlich', 220),
      summary: safePreview(input.summary),
      agentId: clean(input.agentId || 'iva-standard', 100),
      externalKey,
      confirmationPhrase: clean(input.confirmationPhrase, 220),
      status: 'pending',
      expiresAt: clean(input.expiresAt, 80),
      updatedAt: now,
    });
    if (!existing) store.approvals.push(item);
    return structuredClone(item);
  });
}

export async function resolveApprovalByExternalKey(externalKey, input = {}) {
  return mutate(store => {
    const item = [...store.approvals].reverse().find(approval => approval.externalKey === clean(externalKey, 200) && approval.status === 'pending');
    if (!item) return null;
    item.status = ['approved', 'rejected', 'expired', 'failed'].includes(input.status) ? input.status : 'approved';
    item.result = safePreview(input.result);
    item.updatedAt = new Date().toISOString();
    return structuredClone(item);
  });
}

export async function listApprovals({ limit = 100, status = '' } = {}) {
  const store = await load();
  return store.approvals
    .filter(item => !status || item.status === status)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
}

export async function recordAudit(input = {}) {
  return mutate(store => {
    const item = {
      id: crypto.randomUUID(),
      category: clean(input.category || 'system', 100),
      action: clean(input.action || 'event', 160),
      status: clean(input.status || 'recorded', 80),
      actor: clean(input.actor || 'iva', 100),
      target: safePreview(input.target),
      detail: safePreview(input.detail),
      createdAt: new Date().toISOString(),
    };
    store.audit.push(item);
    return structuredClone(item);
  });
}

export async function listAudit({ limit = 100, category = '' } = {}) {
  const store = await load();
  return store.audit
    .filter(item => !category || item.category === category)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
}

export async function operationsSummary() {
  const store = await load();
  const today = new Date().toISOString().slice(0, 10);
  return {
    runs: {
      active: store.runs.filter(item => item.status === 'running').length,
      today: store.runs.filter(item => String(item.createdAt).startsWith(today)).length,
      failed: store.runs.filter(item => item.status === 'failed' && String(item.createdAt).startsWith(today)).length,
      failedTotal: store.runs.filter(item => item.status === 'failed').length,
    },
    approvals: {
      pending: store.approvals.filter(item => item.status === 'pending').length,
      total: store.approvals.length,
    },
    auditEvents: store.audit.length,
  };
}
