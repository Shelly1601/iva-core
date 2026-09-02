import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || '/data';
const STORE_FILE = path.join(DATA_DIR, 'incident-memory.json');
const MAX_INCIDENTS = 1200;
const MAX_EVENTS = 4000;
let transactionQueue = Promise.resolve();

function emptyStore() {
  return { version: 1, incidents: [], preventionEvents: [], recoveredCorruptions: 0, lastCorruptionAt: '' };
}

function clean(value, max = 1000) {
  return String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function sanitizeIncidentText(value, max = 1000) {
  return clean(value, max * 2)
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [SECRET]')
    .replace(/((?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|password|passwort|kennwort|secret|otp|einmalcode|authorization)\s*["']?\s*[:=]\s*["']?)[^\s,"'};]+/gi, '$1[SECRET]')
    .replace(/\b(?:sk|rk|pk|ghp|github_pat|xox[baprs])-[-_A-Za-z0-9]{12,}\b/g, '[SECRET]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[SECRET_OR_HASH]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[E-MAIL]')
    .replace(/\bDE\d{20}\b/gi, '[IBAN]')
    .replace(/\+?[0-9][0-9\s()/.-]{7,}/g, candidate => ((candidate.match(/\d/g) || []).length >= 8 ? '[TELEFON]' : candidate))
    .replace(/(?:\/(?:Users|home|var|tmp|private|data)\b[\w .~@+\-/]*)/g, '[PFAD]')
    .replace(/([?&](?:token|key|secret|code|signature|auth)=)[^&#\s]+/gi, '$1[SECRET]')
    .slice(0, max);
}

function normalizedKey(value, max = 140) {
  return clean(value, max).toLowerCase().replace(/[^a-z0-9äöüß._:-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function normalizeIncidentSignature(value) {
  return sanitizeIncidentText(value, 800)
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hash>')
    .replace(/\b\d{4}-\d{2}-\d{2}[t ][0-9:.+z-]+\b/gi, '<time>')
    .replace(/(?:\/[\w .~@+-]+){2,}/g, '<path>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function incidentFingerprint(input = {}) {
  const signature = normalizeIncidentSignature(input.error || input.signal || input.summary || 'unknown-error');
  const scope = [input.system, input.workflowId, input.action, input.step]
    .map(value => normalizedKey(value)).filter(Boolean).join('|') || 'global';
  return crypto.createHash('sha256').update(`${scope}|${signature}`).digest('hex').slice(0, 24);
}

function normalizeStore(parsed) {
  return {
    ...emptyStore(),
    ...(parsed && typeof parsed === 'object' ? parsed : {}),
    version: 1,
    incidents: Array.isArray(parsed?.incidents) ? parsed.incidents : [],
    preventionEvents: Array.isArray(parsed?.preventionEvents) ? parsed.preventionEvents : [],
  };
}

async function loadStore() {
  try {
    return normalizeStore(JSON.parse(await fs.readFile(STORE_FILE, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyStore();
    return { ...emptyStore(), recoveredCorruptions: 1, lastCorruptionAt: new Date().toISOString() };
  }
}

async function saveStore(store) {
  await fs.mkdir(path.dirname(STORE_FILE), { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const compact = {
    ...normalizeStore(store),
    incidents: store.incidents
      .sort((a, b) => String(a.lastSeenAt).localeCompare(String(b.lastSeenAt)))
      .slice(-MAX_INCIDENTS),
    preventionEvents: store.preventionEvents
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .slice(-MAX_EVENTS),
  };
  try {
    await fs.writeFile(temporary, `${JSON.stringify(compact, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, STORE_FILE);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

function transact(work) {
  const job = transactionQueue.catch(() => {}).then(async () => {
    const store = await loadStore();
    const result = await work(store);
    await saveStore(store);
    return result;
  });
  transactionQueue = job.catch(() => {});
  return job;
}

function normalizedContext(input = {}) {
  return {
    system: normalizedKey(input.system || 'iva-core'),
    workflowId: normalizedKey(input.workflowId),
    action: normalizedKey(input.action),
    step: normalizedKey(input.step),
    runId: clean(input.runId, 120),
    source: clean(input.source || 'iva', 120),
  };
}

export async function recordIncident(input = {}) {
  const context = normalizedContext(input);
  const error = sanitizeIncidentText(input.error || input.signal || input.summary || 'Unbekannte technische Störung', 1000);
  const fingerprint = incidentFingerprint({ ...context, error });
  return transact(store => {
    const now = new Date().toISOString();
    const existing = store.incidents.find(item => item.fingerprint === fingerprint);
    const item = existing || {
      id: crypto.randomUUID(),
      fingerprint,
      firstSeenAt: now,
      occurrences: 0,
      preventionUses: 0,
      preventedCount: 0,
      history: [],
    };
    const remedy = sanitizeIncidentText(input.remedy, 1200);
    const evidence = sanitizeIncidentText(input.evidence, 1000);
    const requestedResolved = input.status === 'resolved' || input.resolved === true;
    const verifiedResolution = requestedResolved && Boolean(remedy && evidence);
    const alreadySeenInRun = Boolean(context.runId && (item.history || []).some(entry => entry.runId === context.runId));
    Object.assign(item, {
      ...context,
      error,
      signature: normalizeIncidentSignature(error),
      cause: sanitizeIncidentText(input.cause, 1000) || item.cause || '',
      remedy: remedy || item.remedy || '',
      prevention: sanitizeIncidentText(input.prevention, 1200) || (verifiedResolution ? remedy : item.prevention || ''),
      evidence: evidence || item.evidence || '',
      status: verifiedResolution ? 'resolved' : (item.status === 'resolved' && !requestedResolved ? 'open' : item.status || 'open'),
      safeToAutoApply: verifiedResolution && input.safeToAutoApply === true,
      severity: ['low', 'medium', 'high', 'critical'].includes(input.severity) ? input.severity : item.severity || 'medium',
      lastSeenAt: now,
      lastRunId: context.runId || item.lastRunId || '',
      occurrences: Number(item.occurrences || 0) + (alreadySeenInRun ? 0 : 1),
      updatedAt: now,
    });
    item.history = [...(item.history || []), {
      at: now,
      runId: context.runId,
      status: item.status,
      repaired: verifiedResolution,
      evidence: evidence || '',
    }].slice(-20);
    if (!existing) store.incidents.push(item);
    return structuredClone(item);
  });
}

function contextScore(incident, context) {
  let score = 0;
  if (context.workflowId && incident.workflowId === context.workflowId) score += 8;
  if (context.action && incident.action === context.action) score += 6;
  if (context.system && incident.system === context.system) score += 4;
  if (context.step && incident.step === context.step) score += 2;
  return score;
}

export async function findPreventiveLessons(input = {}, { limit = 8 } = {}) {
  const context = normalizedContext(input);
  const store = await loadStore();
  return store.incidents
    .filter(item => item.status === 'resolved' && item.safeToAutoApply === true && item.prevention && item.evidence)
    .map(item => ({ ...item, matchScore: contextScore(item, context) }))
    .filter(item => item.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore || Number(b.occurrences || 0) - Number(a.occurrences || 0) || String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 8)))
    .map(item => ({
      fingerprint: item.fingerprint,
      system: item.system,
      workflowId: item.workflowId,
      action: item.action,
      step: item.step,
      error: item.error,
      prevention: item.prevention,
      evidence: item.evidence,
      occurrences: item.occurrences,
      matchScore: item.matchScore,
    }));
}

export async function markPreventiveLessonUsed(fingerprint, input = {}) {
  const safeFingerprint = clean(fingerprint, 64);
  return transact(store => {
    const item = store.incidents.find(incident => incident.fingerprint === safeFingerprint && incident.status === 'resolved' && incident.safeToAutoApply === true);
    if (!item) throw new Error('Die verifizierte Prävention wurde nicht gefunden.');
    const now = new Date().toISOString();
    item.preventionUses = Number(item.preventionUses || 0) + 1;
    if (input.prevented === true) item.preventedCount = Number(item.preventedCount || 0) + 1;
    item.lastAppliedAt = now;
    item.updatedAt = now;
    store.preventionEvents.push({
      id: crypto.randomUUID(),
      fingerprint: item.fingerprint,
      runId: clean(input.runId, 120),
      prevented: input.prevented === true,
      evidence: sanitizeIncidentText(input.evidence, 600),
      createdAt: now,
    });
    return structuredClone(item);
  });
}

export async function listIncidents({ status = '', limit = 100 } = {}) {
  const store = await loadStore();
  return store.incidents
    .filter(item => !status || item.status === status)
    .sort((a, b) => Number(b.occurrences || 0) - Number(a.occurrences || 0) || String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
}

export async function incidentMemorySummary() {
  const store = await loadStore();
  const resolved = store.incidents.filter(item => item.status === 'resolved');
  const open = store.incidents.filter(item => item.status !== 'resolved');
  return {
    total: store.incidents.length,
    resolved: resolved.length,
    open: open.length,
    recurring: store.incidents.filter(item => Number(item.occurrences || 0) > 1).length,
    preventionUses: store.incidents.reduce((sum, item) => sum + Number(item.preventionUses || 0), 0),
    preventedCount: store.incidents.reduce((sum, item) => sum + Number(item.preventedCount || 0), 0),
    recoveredCorruptions: Number(store.recoveredCorruptions || 0),
    lastCorruptionAt: store.lastCorruptionAt || '',
    items: [...store.incidents]
      .sort((a, b) => Number(b.occurrences || 0) - Number(a.occurrences || 0) || String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
      .slice(0, 30),
  };
}
