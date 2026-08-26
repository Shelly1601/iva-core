import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = process.env.DATA_DIR || '/data';
const ROOT = path.join(DATA_DIR, 'project-protocols');
const TIME_ZONE = 'Europe/Berlin';
export const PROJECT_PROTOCOL_RETENTION = Object.freeze({ daily: 7, weekly: 30 });
const writeQueues = new Map();

function clean(value, max = 4000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeId(value, fallback = 'unknown') {
  const id = clean(value, 140).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return id || fallback;
}

function dateInBerlin(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const pick = type => parts.find(item => item.type === type)?.value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function addDays(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + Number(days || 0));
  return value.toISOString().slice(0, 10);
}

function germanDate(date) {
  const [year, month, day] = String(date).split('-');
  return `${day}.${month}.${year}`;
}

function isoWeek(date) {
  const current = new Date(`${date}T12:00:00Z`);
  const weekday = current.getUTCDay() || 7;
  const monday = new Date(current);
  monday.setUTCDate(current.getUTCDate() - weekday + 1);
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4, 12));
  const firstWeekday = firstThursday.getUTCDay() || 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstWeekday + 4);
  const week = 1 + Math.round((thursday - firstThursday) / 604800000);
  const start = monday.toISOString().slice(0, 10);
  return { year, week, start, end: addDays(start, 6), key: `${year}-W${String(week).padStart(2, '0')}` };
}

function protocolDirectory(projectId, type) {
  return path.join(ROOT, safeId(projectId), type === 'weekly' ? 'woechentlich' : 'taeglich');
}

function protocolFile(projectId, type, periodKey) {
  const prefix = type === 'weekly' ? 'Wochenprotokoll' : 'Tagesprotokoll';
  return path.join(protocolDirectory(projectId, type), `${prefix}_${safeId(periodKey)}.json`);
}

function retention(type) {
  return type === 'weekly' ? PROJECT_PROTOCOL_RETENTION.weekly : PROJECT_PROTOCOL_RETENTION.daily;
}

function periodFor(type, date) {
  if (type === 'weekly') {
    const week = isoWeek(date);
    return { key: week.key, start: week.start, end: week.end, label: `KW ${String(week.week).padStart(2, '0')} / ${week.year}` };
  }
  return { key: date, start: date, end: date, label: germanDate(date) };
}

function tagsFor(type, expiresOn) {
  const days = retention(type);
  return [
    type === 'weekly' ? 'WÖCHENTLICH' : 'TÄGLICH',
    `AUFBEWAHRUNG ${days} TAGE`,
    `AUTOMATISCHE LÖSCHUNG ${germanDate(expiresOn)}`,
  ];
}

function emptyProtocol({ projectId, type, date, generatedAt }) {
  const period = periodFor(type, date);
  const expiresOn = addDays(period.end, retention(type));
  return {
    version: 1,
    projectId: safeId(projectId),
    type,
    fileId: `${type}-${period.key}`,
    fileName: path.basename(protocolFile(projectId, type, period.key)),
    folder: type === 'weekly' ? 'woechentlich' : 'taeglich',
    tags: tagsFor(type, expiresOn),
    period,
    retention: { days: retention(type), expiresOn, automaticDeletion: true },
    generatedAt,
    updatedAt: generatedAt,
    finalized: false,
    health: 'pending',
    expectations: [],
    runs: [],
    result: { total: 0, successful: 0, partial: 0, failed: 0, blocked: 0, skipped: 0 },
    summary: 'Keine Workflow-Läufe protokolliert.',
  };
}

function normalizedOutcome(status) {
  const value = clean(status, 100).toLowerCase();
  if (/sent-and-verified|success|complete|completed|no_changes|run_complete/.test(value)) return 'successful';
  if (/partial/.test(value)) return 'partial';
  if (/fail|error/.test(value)) return 'failed';
  if (/block|login_required|session_expired/.test(value)) return 'blocked';
  if (/skip|not_due|duplicate/.test(value)) return 'skipped';
  return 'successful';
}

function safeObject(value, maxBytes = 12000) {
  if (!value || typeof value !== 'object') return {};
  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > maxBytes) return { note: 'Details aus Größenlimit gekürzt.' };
    return JSON.parse(serialized);
  } catch { return {}; }
}

function summarize(protocol) {
  const result = { total: protocol.runs.length, successful: 0, partial: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const run of protocol.runs) result[run.outcome] = Number(result[run.outcome] || 0) + 1;
  const parts = [
    `${result.total} Läufe`,
    `${result.successful} erfolgreich`,
    result.partial && `${result.partial} teilweise erfolgreich`,
    result.failed && `${result.failed} fehlgeschlagen`,
    result.blocked && `${result.blocked} blockiert`,
    result.skipped && `${result.skipped} übersprungen`,
  ].filter(Boolean);
  protocol.result = result;
  protocol.summary = result.total ? `${parts.join(' · ')}.` : 'Keine Workflow-Läufe protokolliert.';
  return protocol;
}

function applyExpectations(protocol, expectedWorkflows = []) {
  const weekday = new Date(`${protocol.period.start}T12:00:00Z`).getUTCDay();
  protocol.expectations = expectedWorkflows.map(item => {
    const cadence = item?.cadence === 'weekly' ? 'weekly' : 'daily';
    const dueToday = cadence === 'daily' || Number(item?.weekday) === weekday;
    const expectedRuns = protocol.type === 'weekly' ? (cadence === 'daily' ? 7 : 1) : (dueToday ? 1 : 0);
    const actualRuns = protocol.runs.filter(run => run.workflowId === safeId(item?.workflowId)).length;
    return {
      workflowId: safeId(item?.workflowId),
      workflowName: clean(item?.workflowName || item?.workflowId, 240),
      cadence,
      expectedRuns,
      actualRuns,
      missingRuns: Math.max(0, expectedRuns - actualRuns),
      complete: actualRuns >= expectedRuns,
    };
  }).filter(item => item.expectedRuns > 0);
  protocol.health = protocol.expectations.some(item => !item.complete) ? 'missing_results' : 'complete';
  return protocol;
}

async function readProtocol(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}

async function writeProtocol(file, protocol) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(protocol, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

function queue(key, action) {
  const previous = writeQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  writeQueues.set(key, next.catch(() => {}));
  return next;
}

function normalizeRun(input = {}, now = new Date()) {
  const startedAt = new Date(input.startedAt || input.completedAt || now).toISOString();
  const completedAt = new Date(input.completedAt || now).toISOString();
  const status = clean(input.status || 'completed', 100);
  return {
    runId: clean(input.runId, 180) || crypto.randomUUID(),
    workflowId: safeId(input.workflowId || input.automationId || 'workflow'),
    workflowName: clean(input.workflowName || input.name || input.workflowId || 'Workflow', 240),
    status,
    outcome: normalizedOutcome(status),
    startedAt,
    completedAt,
    summary: clean(input.summary || input.result || 'Lauf abgeschlossen.', 4000),
    metrics: safeObject(input.metrics),
    artifacts: (Array.isArray(input.artifacts) ? input.artifacts : []).map(item => clean(item, 500)).filter(Boolean).slice(0, 100),
    error: clean(input.error, 2000) || null,
  };
}

async function upsertProtocol({ projectId, type, run, now }) {
  const date = dateInBerlin(run?.completedAt || now);
  const period = periodFor(type, date);
  const file = protocolFile(projectId, type, period.key);
  return queue(file, async () => {
    const generatedAt = new Date(now).toISOString();
    const protocol = await readProtocol(file, emptyProtocol({ projectId, type, date, generatedAt }));
    if (run) {
      const index = protocol.runs.findIndex(item => item.runId === run.runId);
      if (index >= 0) protocol.runs[index] = run;
      else protocol.runs.push(run);
      protocol.runs.sort((left, right) => String(left.completedAt).localeCompare(String(right.completedAt)));
    }
    protocol.updatedAt = generatedAt;
    summarize(protocol);
    await writeProtocol(file, protocol);
    return protocol;
  });
}

export async function recordProjectWorkflowResult(projectId, input = {}, { now = new Date() } = {}) {
  const run = normalizeRun(input, now);
  const [daily, weekly] = await Promise.all([
    upsertProtocol({ projectId, type: 'daily', run, now }),
    upsertProtocol({ projectId, type: 'weekly', run, now }),
  ]);
  return { run, daily, weekly };
}

export async function ensureProjectProtocolSummaries(projectId, { now = new Date(), finalizeDaily = false, finalizeWeekly = false, expectedWorkflows = [] } = {}) {
  const [daily, weekly] = await Promise.all([
    upsertProtocol({ projectId, type: 'daily', run: null, now }),
    upsertProtocol({ projectId, type: 'weekly', run: null, now }),
  ]);
  if (finalizeDaily) {
    daily.finalized = true;
    applyExpectations(daily, expectedWorkflows);
    await writeProtocol(protocolFile(projectId, 'daily', daily.period.key), daily);
  }
  if (finalizeWeekly) {
    weekly.finalized = true;
    applyExpectations(weekly, expectedWorkflows);
    await writeProtocol(protocolFile(projectId, 'weekly', weekly.period.key), weekly);
  }
  return { daily, weekly };
}

async function listDirectory(projectId, type) {
  const directory = protocolDirectory(projectId, type);
  const names = await fs.readdir(directory).catch(() => []);
  const files = [];
  for (const name of names.filter(name => name.endsWith('.json'))) {
    const item = await readProtocol(path.join(directory, name), null);
    if (item) files.push(item);
  }
  return files.sort((left, right) => String(right.period?.end).localeCompare(String(left.period?.end)));
}

export async function listProjectProtocols(projectId) {
  const [daily, weekly] = await Promise.all([listDirectory(projectId, 'daily'), listDirectory(projectId, 'weekly')]);
  return {
    projectId: safeId(projectId),
    rootFolder: path.join('project-protocols', safeId(projectId)),
    folders: [
      { id: 'daily', name: 'Tägliche Protokolle', path: 'taeglich', retentionDays: PROJECT_PROTOCOL_RETENTION.daily, files: daily },
      { id: 'weekly', name: 'Wöchentliche Protokolle', path: 'woechentlich', retentionDays: PROJECT_PROTOCOL_RETENTION.weekly, files: weekly },
    ],
  };
}

export async function listProjectWorkflowRuns(projectId, { limit = 250 } = {}) {
  const protocols = await listProjectProtocols(projectId);
  const runs = new Map();
  for (const folder of protocols.folders || []) {
    for (const file of folder.files || []) {
      for (const run of file.runs || []) {
        if (!runs.has(run.runId) || String(run.completedAt).localeCompare(String(runs.get(run.runId)?.completedAt || '')) > 0) {
          runs.set(run.runId, { ...run, projectId: safeId(projectId) });
        }
      }
    }
  }
  return [...runs.values()]
    .sort((left, right) => String(right.completedAt || right.startedAt).localeCompare(String(left.completedAt || left.startedAt)))
    .slice(0, Math.max(1, Math.min(1000, Number(limit) || 250)));
}

export async function getProjectProtocol(projectId, type, fileId) {
  const files = await listDirectory(projectId, type === 'weekly' ? 'weekly' : 'daily');
  return files.find(item => item.fileId === clean(fileId, 180)) || null;
}

export async function cleanupExpiredProjectProtocols({ now = new Date(), projectId = null } = {}) {
  const today = dateInBerlin(now);
  const projectIds = projectId
    ? [safeId(projectId)]
    : await fs.readdir(ROOT, { withFileTypes: true }).then(items => items.filter(item => item.isDirectory()).map(item => item.name)).catch(() => []);
  const deleted = [];
  for (const id of projectIds) {
    for (const type of ['daily', 'weekly']) {
      const directory = protocolDirectory(id, type);
      const names = await fs.readdir(directory).catch(() => []);
      for (const name of names.filter(name => name.endsWith('.json'))) {
        const file = path.join(directory, name);
        const item = await readProtocol(file, null);
        if (!item?.retention?.expiresOn || today < item.retention.expiresOn) continue;
        await fs.unlink(file);
        deleted.push({ projectId: id, type, fileName: name, expiredOn: item.retention.expiresOn });
      }
    }
  }
  return { checkedAt: new Date(now).toISOString(), deletedCount: deleted.length, deleted };
}

export const projectProtocolInternals = Object.freeze({ dateInBerlin, isoWeek, addDays, normalizedOutcome, applyExpectations });
