import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractText } from 'unpdf';

const DATA_DIR = process.env.DATA_DIR || '/data';
const STORE_FILE = path.join(DATA_DIR, 'knowledge-base.json');
const FILES_DIR = path.join(DATA_DIR, 'knowledge-files');
const ALLOWED_KINDS = new Set(['knowledge', 'course', 'document', 'link']);
const ALLOWED_MIME = new Set(['application/pdf', 'text/plain', 'text/markdown']);
const MAX_TEXT = 250_000;
let mutationQueue = Promise.resolve();

const clean = (value, max = 2000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
const clone = value => JSON.parse(JSON.stringify(value));
const uniqueList = (value, max = 24) => [...new Set((Array.isArray(value) ? value : String(value || '').split(/[,\n]/)).map(item => clean(item, 100)).filter(Boolean))].slice(0, max);
const emptyStore = () => ({ version: 1, entries: [] });

function normalizeUrl(value) {
  const raw = clean(value, 1800);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    return url.toString();
  } catch { return ''; }
}

async function loadStore() {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE_FILE, 'utf8'));
    return { version: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch { return emptyStore(); }
}

async function saveStore(data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, STORE_FILE);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function mutate(fn) {
  let result;
  const job = mutationQueue.catch(() => {}).then(async () => {
    const data = await loadStore();
    result = await fn(data);
    await saveStore(data);
  });
  mutationQueue = job.catch(() => {});
  await job;
  return result;
}

function normalizeEntry(input = {}, existing = {}) {
  const now = new Date().toISOString();
  const title = clean(input.title ?? existing.title, 240);
  if (!title) throw new Error('Ein Titel fehlt.');
  const sourceUrl = input.sourceUrl === undefined ? existing.sourceUrl || '' : normalizeUrl(input.sourceUrl);
  if (clean(input.sourceUrl, 1800) && !sourceUrl) throw new Error('Bitte eine gültige http- oder https-Adresse verwenden.');
  const content = clean(input.content ?? existing.content, MAX_TEXT);
  const documentText = clean(existing.documentText, MAX_TEXT);
  const hasKnowledge = Boolean(content || documentText);
  return {
    ...existing,
    title,
    kind: ALLOWED_KINDS.has(input.kind) ? input.kind : existing.kind || 'knowledge',
    category: clean(input.category ?? existing.category, 140) || 'Allgemein',
    sourceUrl,
    sourceOwner: ['own', 'licensed', 'public-reference'].includes(input.sourceOwner) ? input.sourceOwner : existing.sourceOwner || 'own',
    tags: input.tags === undefined ? uniqueList(existing.tags) : uniqueList(input.tags),
    content,
    documentText,
    notes: clean(input.notes ?? existing.notes, 12_000),
    status: input.status === 'archived' ? 'archived' : hasKnowledge ? 'ready' : 'needs-material',
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

function publicEntry(entry, { includeContent = false } = {}) {
  const result = clone(entry);
  result.wordCount = `${entry.content || ''}\n${entry.documentText || ''}`.trim().split(/\s+/).filter(Boolean).length;
  result.preview = clean(entry.content || entry.documentText || entry.notes, 360);
  if (!includeContent) {
    delete result.content;
    delete result.documentText;
  }
  return result;
}

export async function knowledgeBaseStatus() {
  const entries = (await loadStore()).entries;
  return {
    total: entries.filter(item => item.status !== 'archived').length,
    ready: entries.filter(item => item.status === 'ready').length,
    needsMaterial: entries.filter(item => item.status === 'needs-material').length,
    courses: entries.filter(item => item.kind === 'course' && item.status !== 'archived').length,
    archived: entries.filter(item => item.status === 'archived').length,
    supportedFiles: ['PDF', 'TXT', 'MD'],
    maxFileMb: 15,
  };
}

export async function listKnowledgeEntries({ query = '', status = '', kind = '', limit = 100 } = {}) {
  const needle = clean(query, 300).toLocaleLowerCase('de-DE');
  return (await loadStore()).entries
    .filter(item => (!status ? item.status !== 'archived' : item.status === status) && (!kind || item.kind === kind))
    .filter(item => !needle || [item.title, item.category, item.sourceUrl, item.notes, item.content, item.documentText, ...(item.tags || [])].join('\n').toLocaleLowerCase('de-DE').includes(needle))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, Math.max(1, Math.min(300, Number(limit) || 100)))
    .map(item => publicEntry(item));
}

export async function getKnowledgeEntry(id) {
  const item = (await loadStore()).entries.find(entry => entry.id === id);
  return item ? publicEntry(item, { includeContent: true }) : null;
}

export async function createKnowledgeEntry(input = {}) {
  return mutate(data => {
    const item = normalizeEntry(input);
    item.id = crypto.randomUUID();
    data.entries.push(item);
    return publicEntry(item, { includeContent: true });
  });
}

export async function updateKnowledgeEntry(id, patch = {}) {
  return mutate(data => {
    const index = data.entries.findIndex(item => item.id === id);
    if (index < 0) return null;
    const item = normalizeEntry(patch, data.entries[index]);
    item.id = data.entries[index].id;
    item.document = data.entries[index].document;
    data.entries[index] = item;
    return publicEntry(item, { includeContent: true });
  });
}

export async function deleteKnowledgeEntry(id) {
  const deleted = await mutate(data => {
    const item = data.entries.find(entry => entry.id === id);
    if (!item) return null;
    data.entries = data.entries.filter(entry => entry.id !== id);
    return clone(item);
  });
  if (deleted) await fs.rm(path.join(FILES_DIR, id), { recursive: true, force: true }).catch(() => {});
  return deleted ? publicEntry(deleted) : null;
}

async function extractDocumentText(buffer, mime) {
  if (mime === 'text/plain' || mime === 'text/markdown') return clean(buffer.toString('utf8'), MAX_TEXT);
  if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Die Datei ist keine gültige PDF.');
  const result = await extractText(new Uint8Array(buffer), { mergePages: true });
  return clean(result.text, MAX_TEXT);
}

export async function storeKnowledgeDocument(id, { name, mime, buffer } = {}) {
  const safeMime = clean(mime, 100).split(';')[0].toLowerCase();
  if (!ALLOWED_MIME.has(safeMime)) throw new Error('Erlaubt sind PDF-, TXT- und Markdown-Dateien.');
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Die Datei fehlt.');
  if (buffer.length > 15 * 1024 * 1024) throw new Error('Die Datei darf höchstens 15 MB groß sein.');
  const documentText = await extractDocumentText(buffer, safeMime);
  if (!documentText) throw new Error('Aus der Datei konnte kein Text gelesen werden. Bitte eine durchsuchbare Datei verwenden.');
  const existing = (await loadStore()).entries.find(item => item.id === id);
  if (!existing) return null;
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const extension = safeMime === 'application/pdf' ? '.pdf' : safeMime === 'text/markdown' ? '.md' : '.txt';
  const directory = path.join(FILES_DIR, id);
  await fs.mkdir(directory, { recursive: true });
  const fileName = `${hash}${extension}`;
  await fs.writeFile(path.join(directory, fileName), buffer, { mode: 0o600 });
  return mutate(data => {
    const index = data.entries.findIndex(item => item.id === id);
    if (index < 0) return null;
    data.entries[index] = normalizeEntry({}, {
      ...data.entries[index],
      documentText,
      document: { name: clean(name, 300) || `Wissensdatei${extension}`, mime: safeMime, fileName, size: buffer.length, hash },
    });
    return publicEntry(data.entries[index], { includeContent: true });
  });
}

export async function readKnowledgeDocument(id) {
  const item = (await loadStore()).entries.find(entry => entry.id === id);
  if (!item?.document?.fileName) return null;
  return { meta: clone(item.document), buffer: await fs.readFile(path.join(FILES_DIR, id, item.document.fileName)) };
}

function tokens(value) {
  return [...new Set(clean(value, 500).toLocaleLowerCase('de-DE').split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 2))];
}

function snippet(text, wanted) {
  const source = clean(text, MAX_TEXT);
  if (!source) return '';
  const lower = source.toLocaleLowerCase('de-DE');
  const positions = wanted.map(word => lower.indexOf(word)).filter(index => index >= 0);
  const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 160);
  return `${start ? '…' : ''}${source.slice(start, start + 700).trim()}${start + 700 < source.length ? '…' : ''}`;
}

export async function searchKnowledgeBase(query, { limit = 6 } = {}) {
  const wanted = tokens(query);
  const entries = (await loadStore()).entries.filter(item => item.status === 'ready');
  const ranked = entries.map(item => {
    const title = `${item.title} ${(item.tags || []).join(' ')} ${item.category}`.toLocaleLowerCase('de-DE');
    const body = `${item.content || ''}\n${item.documentText || ''}\n${item.notes || ''}`.toLocaleLowerCase('de-DE');
    const score = wanted.reduce((sum, word) => sum + (title.includes(word) ? 8 : 0) + (body.includes(word) ? 2 : 0), 0);
    return { item, score };
  }).filter(match => !wanted.length || match.score > 0).sort((a, b) => b.score - a.score || String(b.item.updatedAt).localeCompare(String(a.item.updatedAt)));
  return ranked.slice(0, Math.max(1, Math.min(12, Number(limit) || 6))).map(({ item, score }) => ({
    id: item.id, title: item.title, category: item.category, kind: item.kind, tags: item.tags || [], sourceUrl: item.sourceUrl || '',
    updatedAt: item.updatedAt, relevance: score, snippet: snippet(`${item.content || ''}\n${item.documentText || ''}\n${item.notes || ''}`, wanted),
  }));
}
