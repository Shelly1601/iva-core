import crypto from 'node:crypto';
import path from 'node:path';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { normalizeWebsiteFiles, websiteFileBytes } from './archive.js';

const queues = new Map();
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_REVISION_BYTES = 30 * 1024 * 1024;

function failure(message, status = 400, code = 'INVALID_WEBSITE') {
  return Object.assign(new Error(message), { status, statusCode: status, code });
}
function clean(value, limit = 1000) { return String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, limit); }
function identifier(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value)) throw failure(`Ungültige ${label}.`);
  return value;
}
function isoNow() { return new Date().toISOString(); }
async function serial(key, action) {
  const previous = queues.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(action);
  queues.set(key, pending);
  try { return await pending; }
  finally { if (queues.get(key) === pending) queues.delete(key); }
}
function publicUrl(value) {
  if (!value) return '';
  let parsed;
  try { parsed = new URL(value); } catch { throw failure('Ungültige Website-URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw failure('Website-URLs dürfen keine Zugangsdaten enthalten.');
  if ([...parsed.searchParams.keys()].some(key => /token|secret|password|credential|api[-_]?key|authorization|signature/i.test(key))) throw failure('Website-URLs dürfen keine Zugangsdaten enthalten.');
  return parsed.href.slice(0, 2000);
}
function safeText(value, limit = 1000) {
  const text = clean(value, limit);
  if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[A-Z0-9]{16})\b/.test(text)) throw failure('Zugangsdaten dürfen nicht in Website-Metadaten gespeichert werden.');
  return text;
}
function metadataObject(input, allowed) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw failure('Ungültige Website-Metadaten.');
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) throw failure(`Nicht unterstütztes Website-Metadatenfeld: ${clean(key, 60)}`);
    if (/url$/i.test(key) || key === 'url') result[key] = publicUrl(value);
    else if (typeof value === 'boolean') result[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (value == null) result[key] = null;
    else if (typeof value === 'string') result[key] = safeText(value, key === 'error' || key === 'summary' || key === 'detail' ? 3000 : 1000);
    else throw failure('Website-Metadaten dürfen keine verschachtelten Daten oder Zugangsdaten enthalten.');
  }
  return result;
}

const GITHUB_FIELDS = new Set(['owner', 'repo', 'repository', 'branch', 'ref', 'sha', 'commit', 'commitSha', 'url', 'repositoryUrl', 'importedAt', 'lastImportedAt', 'status', 'private', 'path', 'created', 'files', 'operationId']);
const PUBLICATION_FIELDS = new Set(['status', 'url', 'provider', 'deploymentId', 'revisionId', 'publishedAt', 'updatedAt', 'verifiedAt', 'error', 'domain', 'serviceId', 'projectId', 'host', 'artifactHash', 'previousRevisionId', 'operationId']);
const DOMAIN_FIELDS = new Set(['hostname', 'name', 'status', 'target', 'type', 'recordType', 'recordName', 'recordValue', 'verifiedAt', 'checkedAt', 'provider', 'error', 'url']);
const JOB_FIELDS = new Set(['id', 'jobId', 'type', 'status', 'phase', 'progress', 'message', 'detail', 'summary', 'error', 'createdAt', 'startedAt', 'updatedAt', 'completedAt', 'revisionId', 'baseRevisionId', 'model', 'provider', 'attempt', 'commandId', 'deviceId', 'executionVerified']);
const SOURCE_FIELDS = new Set(['type', 'url', 'repositoryUrl', 'owner', 'repo', 'repository', 'branch', 'ref', 'sha', 'commit', 'commitSha', 'name', 'importedAt', 'revisionId']);
const MODEL_FIELDS = new Set(['provider', 'modelId', 'key', 'task']);

export function createWebsiteStore({ dataDir = process.env.IVA_DATA_DIR || path.join(process.cwd(), 'data'), getProject } = {}) {
  if (typeof getProject !== 'function') throw new TypeError('Website-Store benötigt getProject.');
  const root = path.resolve(dataDir, 'websites');

  async function directory(folder, create = false) {
    const relative = path.relative(root, folder);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw failure('Ungültiger Website-Speicherpfad.');
    const segments = relative ? relative.split(path.sep) : [];
    let current = root;
    for (const segment of ['', ...segments]) {
      if (segment) current = path.join(current, segment);
      let info;
      try { info = await fs.lstat(current); }
      catch (error) {
        if (error.code !== 'ENOENT' || !create) throw error;
        await fs.mkdir(current, { recursive: current === root, mode: 0o700 });
        info = await fs.lstat(current);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw failure('Unsicherer Website-Speicherpfad.', 400, 'WEBSITE_UNSAFE_STORAGE');
    }
  }
  async function readJson(file, maxBytes = MAX_METADATA_BYTES) {
    await directory(path.dirname(file));
    let handle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes || stat.nlink > 1) throw failure('Unsichere oder zu große Website-Speicherdatei.');
      return JSON.parse(await handle.readFile('utf8'));
    } finally { await handle?.close(); }
  }
  async function writeJson(file, value, { immutable = false } = {}) {
    await directory(path.dirname(file), true);
    const serialized = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(serialized) > (immutable ? MAX_REVISION_BYTES : MAX_METADATA_BYTES)) throw failure('Website-Speicherdaten sind zu groß.');
    if (immutable) {
      const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      return;
    }
    const temporary = path.join(path.dirname(file), `.write-${crypto.randomUUID()}.tmp`);
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    try { await fs.rename(temporary, file); }
    catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
  }
  async function project(value) {
    const id = identifier(value, 'Projekt-ID');
    const result = await getProject(id);
    if (!result || result.id !== id) throw failure('Projekt nicht gefunden.', 404, 'PROJECT_NOT_FOUND');
    return id;
  }
  function sitePaths(projectId, siteId) {
    identifier(siteId, 'Website-ID');
    const folder = path.join(root, projectId, siteId);
    return { folder, metadata: path.join(folder, 'site.json'), revisions: path.join(folder, 'revisions') };
  }
  async function readSite(projectId, siteId, required = false) {
    const paths = sitePaths(projectId, siteId);
    let value;
    try { value = await readJson(paths.metadata); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (required) throw failure('Website nicht gefunden.', 404, 'WEBSITE_NOT_FOUND');
      return null;
    }
    if (value.id !== siteId || value.projectId !== projectId) throw failure('Website gehört nicht zum Projekt.', 404, 'WEBSITE_NOT_FOUND');
    return value;
  }
  async function get(projectId, siteId) { return readSite(await project(projectId), siteId); }
  async function list(projectId) {
    const id = await project(projectId);
    let entries;
    try { await directory(path.join(root, id)); entries = await fs.readdir(path.join(root, id), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const sites = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw failure('Unsicherer Website-Speicherpfad.', 400, 'WEBSITE_UNSAFE_STORAGE');
      if (!entry.isDirectory() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(entry.name)) continue;
      const value = await readSite(id, entry.name);
      if (value) sites.push(value);
    }
    return sites.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async function create(projectId, input = {}) {
    const id = await project(projectId);
    if (typeof input !== 'object' || Array.isArray(input)) throw failure('Ungültige Website-Daten.');
    const name = safeText(input.name, 180);
    if (!name) throw failure('Die Website benötigt einen Namen.');
    return serial(path.join(root, id), async () => {
      if ((await list(id)).length >= 100) throw failure('Ein Projekt kann höchstens 100 Websites enthalten.');
      const now = isoNow();
      const site = { id: crypto.randomUUID(), projectId: id, name, description: safeText(input.description, 4000), sourceUrl: publicUrl(input.sourceUrl), draftRevisionId: null, publishedRevisionId: null, messages: [], revisions: [], github: null, publication: null, domain: null, job: null, createdAt: now, updatedAt: now };
      await writeJson(sitePaths(id, site.id).metadata, site);
      return structuredClone(site);
    });
  }
  async function readRevision(projectId, siteId, revisionId) {
    const id = await project(projectId);
    const site = await readSite(id, siteId, true);
    const requested = revisionId || site.draftRevisionId;
    if (!requested) return null;
    identifier(requested, 'Versions-ID');
    const metadata = site.revisions.find(item => item.id === requested);
    if (!metadata) throw failure('Website-Version nicht gefunden.', 404, 'WEBSITE_REVISION_NOT_FOUND');
    const revision = await readJson(path.join(sitePaths(id, siteId).revisions, `${requested}.json`), MAX_REVISION_BYTES);
    if (revision.id !== requested || revision.projectId !== id || revision.siteId !== siteId) throw failure('Website-Version gehört nicht zu diesem Projekt.', 404, 'WEBSITE_REVISION_NOT_FOUND');
    const files = normalizeWebsiteFiles(revision.files);
    const digest = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
    if (revision.sha256 !== digest || metadata.sha256 !== digest) throw failure('Die Website-Version ist beschädigt und wurde nicht geladen.', 409, 'WEBSITE_REVISION_INTEGRITY');
    return { ...revision, files };
  }
  async function saveRevision(projectId, siteId, input = {}) {
    const id = await project(projectId);
    const paths = sitePaths(id, siteId);
    const files = normalizeWebsiteFiles(input.files);
    const summary = safeText(input.summary, 3000);
    const source = input.source == null ? null : typeof input.source === 'string' ? safeText(input.source, 1000) : metadataObject(input.source, SOURCE_FIELDS);
    const model = input.model == null ? null : typeof input.model === 'string' ? safeText(input.model, 1000) : metadataObject(input.model, MODEL_FIELDS);
    return serial(paths.metadata, async () => {
      const site = await readSite(id, siteId, true);
      const expected = input.baseRevisionId == null || input.baseRevisionId === '' ? null : identifier(input.baseRevisionId, 'Ausgangsversions-ID');
      if (site.draftRevisionId !== expected) throw failure('Die Website wurde inzwischen geändert. Lade die aktuelle Version und wiederhole die Änderung.', 409, 'WEBSITE_REVISION_CONFLICT');
      if (site.revisions.length >= 500) throw failure('Die Website hat das Versionslimit von 500 erreicht. Exportiere sie vor weiteren Änderungen.', 409, 'WEBSITE_REVISION_LIMIT');
      const revision = { id: crypto.randomUUID(), projectId: id, siteId, baseRevisionId: expected, files, summary, source, model, createdAt: isoNow() };
      revision.sha256 = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
      await writeJson(path.join(paths.revisions, `${revision.id}.json`), revision, { immutable: true });
      const metadata = { id: revision.id, summary, createdAt: revision.createdAt, baseRevisionId: expected, fileCount: files.length, bytes: files.reduce((sum, file) => sum + websiteFileBytes(file).length, 0), sha256: revision.sha256, source, model };
      site.draftRevisionId = revision.id;
      site.revisions.push(metadata);
      site.updatedAt = revision.createdAt;
      await writeJson(paths.metadata, site);
      return { site: structuredClone(site), revision: structuredClone(revision) };
    });
  }
  async function appendMessage(projectId, siteId, input = {}) {
    const id = await project(projectId);
    const paths = sitePaths(id, siteId);
    if (!['user', 'assistant', 'system'].includes(input.role)) throw failure('Ungültige Gesprächsrolle.');
    const content = safeText(input.content, 20_000);
    if (!content) throw failure('Eine Nachricht darf nicht leer sein.');
    const jobId = input.jobId ? identifier(input.jobId, 'Auftrags-ID') : null;
    return serial(paths.metadata, async () => {
      const site = await readSite(id, siteId, true);
      const message = { id: crypto.randomUUID(), role: input.role, content, jobId, createdAt: isoNow() };
      site.messages.push(message);
      // Keep bounded chat metadata; source revision history remains immutable.
      while (site.messages.length > 100 || Buffer.byteLength(JSON.stringify(site.messages)) > 500_000) site.messages.shift();
      site.updatedAt = message.createdAt;
      await writeJson(paths.metadata, site);
      return structuredClone(message);
    });
  }
  async function updateSite(projectId, siteId, patch = {}) {
    const id = await project(projectId);
    const paths = sitePaths(id, siteId);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw failure('Ungültige Website-Änderung.');
    const allowed = new Set(['name', 'description', 'sourceUrl', 'github', 'publication', 'domain', 'job', 'draftRevisionId', 'publishedRevisionId']);
    for (const key of Object.keys(patch)) if (!allowed.has(key)) throw failure('Dieses Website-Feld darf nicht geändert werden.');
    return serial(paths.metadata, async () => {
      const site = await readSite(id, siteId, true);
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'name') { site.name = safeText(value, 180); if (!site.name) throw failure('Die Website benötigt einen Namen.'); }
        else if (key === 'description') site.description = safeText(value, 4000);
        else if (key === 'sourceUrl') site.sourceUrl = publicUrl(value);
        else if (key === 'github') site.github = metadataObject(value, GITHUB_FIELDS);
        else if (key === 'publication') site.publication = metadataObject(value, PUBLICATION_FIELDS);
        else if (key === 'domain') site.domain = typeof value === 'string' ? safeText(value, 300) : metadataObject(value, DOMAIN_FIELDS);
        else if (key === 'job') site.job = metadataObject(value, JOB_FIELDS);
        else {
          const revisionId = value == null ? null : identifier(value, 'Versions-ID');
          if (revisionId && !site.revisions.some(revision => revision.id === revisionId)) throw failure('Website-Version nicht gefunden.', 404, 'WEBSITE_REVISION_NOT_FOUND');
          site[key] = revisionId;
        }
      }
      if (site.publication?.revisionId && !site.revisions.some(revision => revision.id === site.publication.revisionId)) throw failure('Veröffentlichte Website-Version gehört nicht zu dieser Website.');
      site.updatedAt = isoNow();
      await writeJson(paths.metadata, site);
      return structuredClone(site);
    });
  }
  return Object.freeze({ list, get, create, readRevision, saveRevision, appendMessage, updateSite });
}
