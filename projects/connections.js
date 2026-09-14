import fs from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { normalizeInstagramReference } from '../integrations/instagram.js';

const DEFINITIONS = Object.freeze({ instagram: Object.freeze({ id: 'instagram', label: 'Instagram' }) });
const queues = new Map();
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const empty = () => ({ version: 1, connections: [] });

function encryptionKey(env) {
  const encoded = env.IVA_PROJECT_CONNECTIONS_KEY;
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return null;
  const key = Buffer.from(encoded, 'base64');
  return key.length === 32 && key.toString('base64') === encoded ? key : null;
}
function encrypt(token, key, projectId, provider) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify([projectId, provider])));
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return { algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function decrypt(record, key) {
  if (!record.credentials) return '';
  if (!key) throw fail('encryption_unavailable', 'Der Schlüssel für Projektverbindungen ist nicht eingerichtet.', 503);
  try {
    const value = record.credentials;
    if (value.algorithm !== 'aes-256-gcm') throw new Error();
    const iv = Buffer.from(value.iv, 'base64');
    const tag = Buffer.from(value.tag, 'base64');
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([record.projectId, record.provider])));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString('utf8');
  } catch { throw fail('decryption_failed', 'Die gespeicherte Projektverbindung kann nicht entschlüsselt werden.', 503); }
}

// This store is server-only. Only resolveEnv returns credentials, and its output must
// go directly to an adapter; list/save/recordVerification are safe for the project UI.
export function createProjectConnectionStore({ dataDir, env = process.env, getProject } = {}) {
  if (typeof dataDir !== 'string' || !dataDir || typeof getProject !== 'function') throw fail('invalid_store_options', 'Projektverbindungen benötigen einen Datenordner und eine Projektprüfung.');
  const filename = path.resolve(dataDir, 'project-connections.json');

  async function requireProject(projectId) {
    if (typeof projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(projectId)) throw fail('invalid_project', 'Ungültiges Projekt.');
    let project;
    try { project = await getProject(projectId); } catch { throw fail('project_lookup_failed', 'Das Projekt konnte nicht geprüft werden.', 503); }
    if (!project) throw fail('project_not_found', 'Projekt nicht gefunden.', 404);
    return projectId;
  }
  function requireProvider(provider) {
    if (typeof provider !== 'string' || !own(DEFINITIONS, provider)) throw fail('unsupported_provider', 'Dieser Anbieter wird für Projektverbindungen noch nicht unterstützt.');
  }
  async function readStore() {
    try {
      const info = await fs.lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error();
      const store = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (store?.version !== 1 || !Array.isArray(store.connections)) throw new Error();
      const pairs = new Set();
      for (const record of store.connections) {
        if (!record || typeof record.projectId !== 'string' || !own(DEFINITIONS, record.provider) || typeof record.revision !== 'string') throw new Error();
        const pair = JSON.stringify([record.projectId, record.provider]);
        if (pairs.has(pair)) throw new Error();
        pairs.add(pair);
      }
      return store;
    } catch (error) {
      if (error?.code === 'ENOENT') return empty();
      throw fail('connection_store_unavailable', 'Die Projektverbindungen konnten nicht gelesen werden.', 503);
    }
  }
  async function writeStore(store) {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, JSON.stringify(store), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, filename);
    } catch {
      await fs.unlink(temporary).catch(() => {});
      throw fail('connection_store_unavailable', 'Die Projektverbindungen konnten nicht gespeichert werden.', 503);
    }
  }
  function serialize(operation) {
    const current = (queues.get(filename) || Promise.resolve()).then(operation);
    const settled = current.then(() => {}, () => {});
    queues.set(filename, settled);
    settled.then(() => { if (queues.get(filename) === settled) queues.delete(filename); });
    return current;
  }
  function redact(value, secrets) {
    let cleaned = value;
    for (const secret of secrets.filter(Boolean)) cleaned = cleaned.split(secret).join('[redacted]').split(encodeURIComponent(secret)).join('[redacted]');
    return cleaned.replace(/((?:access_token|token|api_key|client_secret)=)[^\s&#"']+/gi, '$1[redacted]');
  }
  function publicRecord(record) {
    const key = encryptionKey(env);
    let token = '';
    let locked = false;
    try { token = decrypt(record, key); } catch { locked = Boolean(record.credentials); }
    const secrets = [token, env.APIFY_TOKEN, env.INSTAGRAM_ACCESS_TOKEN, env.META_ACCESS_TOKEN, env.IVA_PROJECT_CONNECTIONS_KEY];
    const hasToken = Boolean(record.credentials);
    const configured = Boolean(record.accountId && record.authMode && record.graphVersion && hasToken && !locked);
    const checked = record.lastCheck && typeof record.lastCheck.ok === 'boolean' ? { ok: record.lastCheck.ok, ...(record.lastCheck.ok ? {} : { error: 'Die Verbindung konnte nicht bestätigt werden. Konto und Berechtigungen prüfen.' }) } : null;
    return {
      provider: record.provider, label: redact(record.label || DEFINITIONS[record.provider].label, secrets), handle: redact(record.handle || '', secrets),
      accountId: record.accountId || '', authMode: record.authMode || '', graphVersion: record.graphVersion || '',
      configured, hasToken, revision: record.revision, verifiedAt: configured && checked?.ok ? record.verifiedAt || null : null,
      lastCheck: locked ? null : checked,
      status: locked ? 'encryption_unavailable' : configured && checked?.ok ? 'verified' : configured && checked?.ok === false ? 'verification_failed' : configured ? 'configured' : 'missing_connection',
    };
  }
  function field(input, previous, name, max, pattern) {
    if (!own(input, name)) return previous?.[name] || '';
    if (typeof input[name] !== 'string') throw fail('invalid_connection_input', 'Ungültige Angaben zur Projektverbindung.');
    const value = input[name].trim();
    if (value.length > max || /[\u0000-\u001f\u007f]/.test(value) || (value && pattern && !pattern.test(value))) throw fail('invalid_connection_input', 'Ungültige Angaben zur Projektverbindung.');
    return value;
  }

  async function list(projectId) {
    await requireProject(projectId);
    return serialize(async () => ({ items: (await readStore()).connections.filter(record => record.projectId === projectId).map(publicRecord), encryptionReady: Boolean(encryptionKey(env)), providers: Object.values(DEFINITIONS).map(item => ({ ...item })) }));
  }
  async function save(projectId, provider, input = {}) {
    await requireProject(projectId);
    requireProvider(provider);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('invalid_connection_input', 'Ungültige Angaben zur Projektverbindung.');
    return serialize(async () => {
      await requireProject(projectId);
      const store = await readStore();
      const previous = store.connections.find(record => record.projectId === projectId && record.provider === provider);
      const key = encryptionKey(env);
      if (own(input, 'accessToken') && own(input, 'token') && input.accessToken !== input.token) throw fail('invalid_connection_input', 'Bitte genau einen Zugangstoken angeben.');
      const rawToken = own(input, 'accessToken') ? input.accessToken : own(input, 'token') ? input.token : '';
      if (typeof rawToken !== 'string' || rawToken.length > 16_384 || /[\u0000-\u001f\u007f]/.test(rawToken)) throw fail('invalid_connection_input', 'Ungültige Angaben zur Projektverbindung.');
      const token = rawToken.trim();
      if (token && !key) throw fail('encryption_unavailable', 'Vor dem Speichern eines Zugangstokens muss der Schlüssel für Projektverbindungen eingerichtet werden.', 503);
      const rawHandle = field(input, previous, 'handle', 1200);
      const reference = rawHandle ? normalizeInstagramReference(rawHandle) : null;
      if (rawHandle && reference?.kind !== 'profile') throw fail('invalid_connection_input', 'Bitte einen Instagram-Profilnamen oder eine Profil-URL angeben.');
      const record = {
        projectId, provider,
        label: field(input, previous, 'label', 100), handle: reference?.username || '',
        accountId: field(input, previous, 'accountId', 40, /^\d{1,40}$/), authMode: field(input, previous, 'authMode', 20, /^(instagram|facebook)$/),
        graphVersion: field(input, previous, 'graphVersion', 10, /^v\d{1,2}\.\d{1,2}$/),
        revision: randomUUID(), verifiedAt: null, lastCheck: null,
      };
      const sameAccount = previous && previous.accountId === record.accountId && previous.authMode === record.authMode;
      if (own(input, 'clearToken') && typeof input.clearToken !== 'boolean') throw fail('invalid_connection_input', 'Ungültige Angaben zur Projektverbindung.');
      if (input.clearToken && token) throw fail('invalid_connection_input', 'Zugangstoken löschen und ersetzen sind getrennte Vorgänge.');
      record.credentials = input.clearToken ? null : token ? encrypt(token, key, projectId, provider) : sameAccount ? previous.credentials || null : null;
      let previousToken = '';
      try { if (previous) previousToken = decrypt(previous, key); } catch { /* Metadata remains editable while credentials are locked. */ }
      const secrets = [token, previousToken, env.APIFY_TOKEN, env.INSTAGRAM_ACCESS_TOKEN, env.META_ACCESS_TOKEN, env.IVA_PROJECT_CONNECTIONS_KEY];
      record.label = redact(record.label, secrets);
      record.handle = redact(record.handle, secrets);
      store.connections = store.connections.filter(item => !(item.projectId === projectId && item.provider === provider));
      store.connections.push(record);
      await writeStore(store);
      return publicRecord(record);
    });
  }
  async function resolveEnv(projectId) {
    await requireProject(projectId);
    return serialize(async () => {
      const record = (await readStore()).connections.find(item => item.projectId === projectId && item.provider === 'instagram');
      const resolved = {};
      if (typeof env.APIFY_TOKEN === 'string' && env.APIFY_TOKEN) resolved.APIFY_TOKEN = env.APIFY_TOKEN;
      if (!record) return resolved;
      if (record.authMode) resolved.INSTAGRAM_AUTH_MODE = record.authMode;
      if (record.accountId) resolved.INSTAGRAM_ACCOUNT_ID = record.accountId;
      if (record.graphVersion) resolved.META_GRAPH_VERSION = record.graphVersion;
      const token = decrypt(record, encryptionKey(env));
      if (token && ['instagram', 'facebook'].includes(record.authMode)) resolved[record.authMode === 'instagram' ? 'INSTAGRAM_ACCESS_TOKEN' : 'META_ACCESS_TOKEN'] = token;
      return resolved;
    });
  }
  async function recordVerification(projectId, provider, result = {}) {
    await requireProject(projectId);
    requireProvider(provider);
    if (!result || typeof result.ok !== 'boolean' || typeof result.expectedRevision !== 'string') throw fail('invalid_verification', 'Die Verbindungsprüfung benötigt Ergebnis und Verbindungsrevision.');
    return serialize(async () => {
      await requireProject(projectId);
      const store = await readStore();
      const record = store.connections.find(item => item.projectId === projectId && item.provider === provider);
      if (!record) throw fail('connection_not_found', 'Projektverbindung nicht gefunden.', 404);
      if (record.revision !== result.expectedRevision) return { ok: false, code: 'stale_revision' };
      if (result.ok && !publicRecord(record).configured) throw fail('connection_incomplete', 'Eine unvollständige Verbindung kann nicht bestätigt werden.');
      record.lastCheck = { ok: result.ok, ...(result.ok ? {} : { error: 'Die Verbindung konnte nicht bestätigt werden. Konto und Berechtigungen prüfen.' }) };
      record.verifiedAt = result.ok ? new Date().toISOString() : null;
      await writeStore(store);
      return publicRecord(record);
    });
  }
  async function remove(projectId, provider) {
    await requireProject(projectId);
    requireProvider(provider);
    return serialize(async () => {
      await requireProject(projectId);
      const store = await readStore();
      const count = store.connections.length;
      store.connections = store.connections.filter(item => !(item.projectId === projectId && item.provider === provider));
      if (count !== store.connections.length) await writeStore(store);
      return { ok: true, removed: count !== store.connections.length };
    });
  }
  return { list, save, resolveEnv, recordVerification, remove };
}
