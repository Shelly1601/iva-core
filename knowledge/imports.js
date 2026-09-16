import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deriveKnowledgeTitle, knowledgeSourceType } from '../local-mac-helper/knowledge-source.mjs';

const DATA_DIR = process.env.DATA_DIR || '/data';
const STORE_FILE = path.join(DATA_DIR, 'knowledge-imports.json');
const DEFAULT_ARCHIVE_FOLDER_URL = process.env.KNOWLEDGE_DRIVE_FOLDER_URL
  || 'https://drive.google.com/drive/folders/1cVB6ZZ__DSolnzEm9kgCgXsdXsBTUzb-';
const ACTIVE_STATUSES = new Set(['queued', 'running', 'recovering']);
let mutationQueue = Promise.resolve();

const clean = (value, max = 1000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
const clone = value => JSON.parse(JSON.stringify(value));

function safeUrl(value) {
  const raw = clean(value, 1800);
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('scheme');
    url.hash = '';
    return url.toString();
  } catch {
    throw new Error('Für die automatische Aufnahme ist eine gültige HTTPS-Adresse erforderlich.');
  }
}

function emptyStore() {
  return { version: 1, imports: [] };
}

async function loadStore() {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE_FILE, 'utf8'));
    return { version: 1, imports: Array.isArray(parsed.imports) ? parsed.imports : [] };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return emptyStore();
  }
}

async function saveStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify({ version: 1, imports: store.imports.slice(-300) }, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, STORE_FILE);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function mutate(work) {
  let result;
  const task = mutationQueue.catch(() => {}).then(async () => {
    const store = await loadStore();
    result = await work(store);
    await saveStore(store);
  });
  mutationQueue = task.catch(() => {});
  await task;
  return result;
}

function normalizedMode(value) {
  return value === 'iva-drive' ? 'iva-drive' : 'iva-only';
}

export function prepareKnowledgeImport(input = {}) {
  const sourceUrl = safeUrl(input.sourceUrl);
  return { sourceUrl, title: deriveKnowledgeTitle({ ...input, sourceUrl }), category: clean(input.category, 140) || 'Allgemein', sourceType: knowledgeSourceType(sourceUrl), completionVersion: 2 };
}

export function knowledgeImportPolicy() {
  return Object.freeze({
    modes: ['iva-only', 'iva-drive'],
    archiveFolderUrl: DEFAULT_ARCHIVE_FOLDER_URL,
    credentials: 'encrypted-in-browser-to-imac-keychain',
    serverStoresPlaintextCredentials: false,
    credentialsOptional: true,
    accessStrategy: 'public-or-existing-session-first',
    technicalRecovery: 'automatic-idempotent-resume',
    externalActionStates: ['captcha', 'account-locked', 'purchase-approval', 'external-confirmation'],
  });
}

export async function createKnowledgeImport(input = {}) {
  const now = new Date().toISOString();
  const prepared = prepareKnowledgeImport(input);
  const { sourceUrl, title } = prepared;
  const hostname = new URL(sourceUrl).hostname.toLowerCase();
  return mutate(store => {
    const item = {
      id: crypto.randomUUID(),
      entryId: clean(input.entryId, 80),
      title,
      titleGenerated: !clean(input.title, 240),
      sourceType: prepared.sourceType,
      completionVersion: prepared.completionVersion,
      category: clean(input.category, 140) || 'Allgemein',
      sourceUrl,
      sourceHost: hostname,
      mode: normalizedMode(input.mode),
      accessMode: input.accessMode === 'purchase-needed' ? 'purchase-needed' : 'existing',
      archiveFolderUrl: normalizedMode(input.mode) === 'iva-drive' ? DEFAULT_ARCHIVE_FOLDER_URL : '',
      credentialProfileId: `course-${crypto.createHash('sha256').update(hostname).digest('hex').slice(0, 18)}`,
      credentialUsernameHint: clean(input.credentialUsernameHint, 240),
      status: 'queued',
      phase: 'Warteschlange',
      progress: 2,
      detail: 'Der Wissensimport wird sicher an den Mac Mini übergeben.',
      attempts: 0,
      commandId: '',
      createdAt: now,
      updatedAt: now,
    };
    store.imports.push(item);
    return clone(item);
  });
}

export async function updateKnowledgeImport(id, patch = {}) {
  return mutate(store => {
    const item = store.imports.find(candidate => candidate.id === String(id));
    if (!item) return null;
    if (patch.commandId !== undefined) item.commandId = clean(patch.commandId, 100);
    if (patch.title !== undefined && clean(patch.title, 240)) item.title = clean(patch.title, 240);
    if (patch.status !== undefined) item.status = clean(patch.status, 40);
    if (patch.phase !== undefined) item.phase = clean(patch.phase, 160);
    if (patch.detail !== undefined) item.detail = clean(patch.detail, 1200);
    if (patch.progress !== undefined) item.progress = Math.max(0, Math.min(100, Number(patch.progress) || 0));
    if (patch.attempts !== undefined) item.attempts = Math.max(0, Number(patch.attempts) || 0);
    if (patch.archiveFolderUrl !== undefined) item.archiveFolderUrl = clean(patch.archiveFolderUrl, 1800);
    if (patch.completedAt !== undefined) item.completedAt = clean(patch.completedAt, 80);
    if (patch.resultSummary !== undefined) item.resultSummary = clean(patch.resultSummary, 1800);
    if (patch.sourceEvidence !== undefined) item.sourceEvidence = clone(patch.sourceEvidence);
    if (patch.completedLessons !== undefined) item.completedLessons = Number(patch.completedLessons);
    if (patch.totalLessons !== undefined) item.totalLessons = Number(patch.totalLessons);
    item.updatedAt = new Date().toISOString();
    return clone(item);
  });
}

export async function markKnowledgeImportDispatched(id, commandId) {
  const current = await getKnowledgeImport(id);
  if (!current) return null;
  return updateKnowledgeImport(id, {
    commandId,
    status: 'queued',
    phase: 'An Mac Mini übergeben',
    progress: Math.max(5, current.progress || 0),
    detail: 'Der Mac Mini prüft den Link und nimmt den zugänglichen Inhalt auf. Zugangsdaten sind nur bei einer tatsächlichen Anmeldesperre nötig.',
    attempts: Number(current.attempts || 0) + 1,
  });
}

export async function completeKnowledgeImport(id, input = {}) {
  return updateKnowledgeImport(id, {
    title: input.title,
    status: 'completed',
    phase: 'Abgeschlossen',
    progress: 100,
    detail: clean(input.detail || input.summary, 1200) || 'Wissen wurde aufgenommen und vollständig geprüft.',
    resultSummary: input.summary,
    sourceEvidence: input.sourceEvidence,
    completedLessons: input.completedLessons,
    totalLessons: input.totalLessons,
    archiveFolderUrl: input.archiveFolderUrl,
    completedAt: new Date().toISOString(),
  });
}

export function validateKnowledgeImportCompletion(job = {}, input = {}) {
  const content = clean(input.content, 250_000);
  if (content.length < 80) throw new Error('Die zusammengeführte Wissensfassung ist noch unvollständig.');
  const legacy = Number(job.completionVersion || 1) < 2;
  const retainedTitle = legacy ? clean(input.title, 240) || clean(job.title, 240)
    : job.titleGenerated === true ? clean(input.title, 240) : clean(job.title, 240) || clean(input.title, 240);
  const title = deriveKnowledgeTitle({ title: retainedTitle, content, sourceUrl: job.sourceUrl });
  // Jobs already dispatched with the previous prompt keep their original
  // completion contract; new evidence requirements apply to new imports only.
  if (legacy) {
    const completedLessons = Math.max(0, Number(input.completedLessons) || 0), totalLessons = Math.max(0, Number(input.totalLessons) || 0);
    if (totalLessons > 0 && completedLessons < totalLessons) throw new Error(`Der Wissensimport ist noch nicht vollständig (${completedLessons}/${totalLessons} Inhalte).`);
    return { title, content, completedLessons, totalLessons };
  }
  const totalLessons = Number(input.totalLessons), completedLessons = Number(input.completedLessons);
  if (!Number.isSafeInteger(totalLessons) || totalLessons < 1 || !Number.isSafeInteger(completedLessons) || completedLessons !== totalLessons) {
    throw new Error('Die gelesenen Inhalte müssen vollständig anhand eines positiven Inventars bestätigt sein. Ein einzelner Beitrag zählt als 1/1.');
  }
  const evidence = input.sourceEvidence;
  if (!evidence || evidence.sourceRead !== true || safeUrl(evidence.sourceUrl) !== safeUrl(job.sourceUrl)) throw new Error('Der Lesebeleg für die beauftragte Quelle fehlt.');
  if ((knowledgeSourceType(job.sourceUrl) === 'video' || evidence.mediaType === 'video') && (evidence.videoRead !== true || !(evidence.audioRead === true || evidence.speechPresent === false && evidence.visualsRead === true))) {
    throw new Error('Der Videoinhalt ist noch nicht vollständig gelesen: Titel, Caption oder Vorschaubild allein reichen nicht.');
  }
  return {
    title,
    content, completedLessons, totalLessons,
    sourceEvidence: {
      sourceUrl: safeUrl(job.sourceUrl), sourceRead: true,
      mediaType: knowledgeSourceType(job.sourceUrl) === 'video' || evidence.mediaType === 'video' ? 'video' : 'page',
      videoRead: evidence.videoRead === true, audioRead: evidence.audioRead === true,
      visualsRead: evidence.visualsRead === true, speechPresent: typeof evidence.speechPresent === 'boolean' ? evidence.speechPresent : null,
      method: clean(evidence.method, 160),
    },
  };
}

export async function getKnowledgeImport(id) {
  const item = (await loadStore()).imports.find(candidate => candidate.id === String(id));
  return item ? clone(item) : null;
}

export async function listKnowledgeImports({ limit = 30 } = {}) {
  return (await loadStore()).imports
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 30)))
    .map(clone);
}

export function mergeKnowledgeImportStatus(item, { run = null, command = null } = {}) {
  if (!item) return null;
  if (item.status === 'completed') return clone(item);
  if (run) {
    // A successful worker exit is not the verified import receipt. Only the
    // completion endpoint may mark the persisted import completed.
    const unfiledCompletion = run.status === 'completed';
    const status = unfiledCompletion ? 'incomplete' : clean(run.status, 40) || item.status;
    return {
      ...clone(item),
      status,
      phase: clean(run.phase, 160) || item.phase,
      progress: Math.min(99, Math.max(Number(item.progress || 0), Number(run.progress || 0))),
      detail: unfiledCompletion ? 'Der Lauf ist beendet; die vollständige Wissensablage wurde noch nicht bestätigt.' : clean(run.resultPreview || run.detail || run.error, 1200) || item.detail,
      taskJobId: clean(run.jobId, 100),
      updatedAt: run.updatedAt || item.updatedAt,
      active: ACTIVE_STATUSES.has(status),
      actionRequired: status === 'blocked',
    };
  }
  if (command) {
    const externalBlocker = command.status === 'failed'
      && /captcha|konto(?:sperre| gesperrt)|account locked|externe best[aä]tigung|purchase|bezahlung|buchung/i.test(String(command.error || ''));
    const retryQueued = command.status === 'queued' && Boolean(command.retryAt);
    const exhaustedFailure = command.status === 'failed' && !externalBlocker;
    const status = externalBlocker ? 'blocked' : exhaustedFailure ? 'failed' : retryQueued ? 'recovering' : command.status === 'completed' ? 'queued' : command.status;
    return {
      ...clone(item),
      status,
      phase: command.status === 'running' ? 'Mac Mini startet Aufnahme'
        : externalBlocker ? 'Externe Aktion erforderlich'
          : exhaustedFailure ? 'Fortsetzung bereit'
            : retryQueued ? 'Technische Reparatur läuft' : item.phase,
      progress: Math.max(Number(item.progress || 0), command.status === 'running' ? 8 : 5),
      detail: externalBlocker ? clean(command.error, 1200)
        : exhaustedFailure ? 'Der automatische Start wurde ausgeschöpft. Der Auftrag bleibt gespeichert und kann ohne Doppelanlage fortgesetzt werden.'
          : retryQueued ? 'Ein technischer Startfehler wird automatisch repariert und derselbe Auftrag fortgesetzt.'
            : item.detail,
      active: ACTIVE_STATUSES.has(status),
      actionRequired: externalBlocker,
    };
  }
  return { ...clone(item), active: ACTIVE_STATUSES.has(item.status), actionRequired: item.status === 'blocked' };
}
