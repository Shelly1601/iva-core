import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { incidentFingerprint, normalizeIncidentSignature, sanitizeIncidentText } from '../operations/incident-memory.js';

const DATA_DIR = process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper');
const STORE_FILE = path.join(DATA_DIR, 'incident-memory.json');
let queue = Promise.resolve();

function emptyStore() {
  return { version: 1, incidents: [], preventionEvents: [] };
}

function clean(value, max = 500) {
  return String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function key(value, max = 140) {
  return clean(value, max).toLowerCase().replace(/[^a-z0-9äöüß._:-]+/g, '-').replace(/^-+|-+$/g, '');
}

async function load() {
  try {
    const parsed = JSON.parse(await readFile(STORE_FILE, 'utf8'));
    return { ...emptyStore(), ...parsed, incidents: Array.isArray(parsed.incidents) ? parsed.incidents : [], preventionEvents: Array.isArray(parsed.preventionEvents) ? parsed.preventionEvents : [] };
  } catch (error) {
    if (error?.code !== 'ENOENT') return { ...emptyStore(), recoveredCorruptions: 1, lastCorruptionAt: new Date().toISOString() };
    return emptyStore();
  }
}

async function save(store) {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${STORE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ ...store, version: 1, incidents: store.incidents.slice(-1200), preventionEvents: store.preventionEvents.slice(-4000) }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, STORE_FILE);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function transact(work) {
  const job = queue.catch(() => {}).then(async () => {
    const store = await load();
    const result = await work(store);
    await save(store);
    return result;
  });
  queue = job.catch(() => {});
  return job;
}

function context(input = {}) {
  return {
    system: key(input.system || 'imac'),
    workflowId: key(input.workflowId),
    action: key(input.action),
    step: key(input.step),
    runId: clean(input.runId, 120),
    source: clean(input.source || 'imac-local', 120),
  };
}

export async function recordLocalIncident(input = {}) {
  const scope = context(input);
  const error = sanitizeIncidentText(input.error || input.signal || 'Unbekannte technische Störung', 1000);
  const fingerprint = incidentFingerprint({ ...scope, error });
  return transact(store => {
    const now = new Date().toISOString();
    const existing = store.incidents.find(item => item.fingerprint === fingerprint);
    const item = existing || { id: crypto.randomUUID(), fingerprint, firstSeenAt: now, occurrences: 0, preventionUses: 0, preventedCount: 0, history: [] };
    const remedy = sanitizeIncidentText(input.remedy, 1200);
    const evidence = sanitizeIncidentText(input.evidence, 1000);
    const resolved = (input.status === 'resolved' || input.resolved === true) && Boolean(remedy && evidence);
    const alreadySeenInRun = Boolean(scope.runId && item.history.some(entry => entry.runId === scope.runId));
    Object.assign(item, {
      ...scope,
      error,
      signature: normalizeIncidentSignature(error),
      cause: sanitizeIncidentText(input.cause, 1000) || item.cause || '',
      remedy: remedy || item.remedy || '',
      prevention: sanitizeIncidentText(input.prevention, 1200) || (resolved ? remedy : item.prevention || ''),
      evidence: evidence || item.evidence || '',
      status: resolved ? 'resolved' : (item.status === 'resolved' ? 'open' : item.status || 'open'),
      safeToAutoApply: resolved && input.safeToAutoApply === true,
      severity: ['low', 'medium', 'high', 'critical'].includes(input.severity) ? input.severity : item.severity || 'medium',
      occurrences: Number(item.occurrences || 0) + (alreadySeenInRun || (existing && input.imported === true) ? 0 : 1),
      lastSeenAt: now,
      updatedAt: now,
      syncedAt: input.syncedAt || item.syncedAt || '',
    });
    item.history = [...item.history, { at: now, runId: scope.runId, status: item.status, repaired: resolved, evidence }].slice(-20);
    if (!existing) store.incidents.push(item);
    return structuredClone(item);
  });
}

function score(item, input) {
  const wanted = context(input);
  return (wanted.workflowId && item.workflowId === wanted.workflowId ? 8 : 0)
    + (wanted.action && item.action === wanted.action ? 6 : 0)
    + (wanted.system && item.system === wanted.system ? 4 : 0)
    + (wanted.step && item.step === wanted.step ? 2 : 0);
}

export async function findLocalPreventions(input = {}, limit = 8) {
  const store = await load();
  return store.incidents
    .filter(item => item.status === 'resolved' && item.safeToAutoApply === true && item.prevention && item.evidence)
    .map(item => ({ ...item, matchScore: score(item, input) }))
    .filter(item => item.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore || Number(b.occurrences || 0) - Number(a.occurrences || 0))
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 8)));
}

export async function mergeRemotePreventions(items = []) {
  for (const item of items) {
    await recordLocalIncident({
      ...item,
      status: 'resolved',
      safeToAutoApply: true,
      cause: item.cause || 'Vom zentralen IVA-Fehlergedächtnis übernommen.',
      remedy: item.prevention,
      prevention: item.prevention,
      runId: '',
      source: 'iva-core-sync',
      syncedAt: new Date().toISOString(),
      imported: true,
    });
  }
}

export async function markLocalPreventionUsed(fingerprint, input = {}) {
  return transact(store => {
    const item = store.incidents.find(entry => entry.fingerprint === clean(fingerprint, 64) && entry.status === 'resolved');
    if (!item) throw new Error('Lokale Prävention wurde nicht gefunden.');
    const now = new Date().toISOString();
    item.preventionUses = Number(item.preventionUses || 0) + 1;
    if (input.prevented === true) item.preventedCount = Number(item.preventedCount || 0) + 1;
    item.lastAppliedAt = now;
    item.updatedAt = now;
    store.preventionEvents.push({ id: crypto.randomUUID(), fingerprint: item.fingerprint, runId: clean(input.runId, 120), prevented: input.prevented === true, evidence: sanitizeIncidentText(input.evidence, 600), createdAt: now });
    return structuredClone(item);
  });
}

export async function localIncidentSummary() {
  const store = await load();
  return {
    total: store.incidents.length,
    open: store.incidents.filter(item => item.status !== 'resolved').length,
    resolved: store.incidents.filter(item => item.status === 'resolved').length,
    recurring: store.incidents.filter(item => Number(item.occurrences || 0) > 1).length,
    preventedCount: store.incidents.reduce((sum, item) => sum + Number(item.preventedCount || 0), 0),
    items: store.incidents.sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt))).slice(0, 30),
  };
}
