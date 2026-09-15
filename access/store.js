import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const MAX_BYTES = 1024 * 1024;
const SESSION_MS = 8 * 60 * 60_000;
const storageQueues = new Map();
const roles = ['viewer', 'editor', 'publisher'];
const fail = (message, status = 400, code = 'PROJECT_ACCESS_ERROR') => Object.assign(new Error(message), { status, statusCode: status, code });
const digest = token => crypto.createHash('sha256').update(token).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
const iso = time => new Date(time).toISOString();
const minimumRole = (left, right) => roles[Math.min(roles.indexOf(left), roles.indexOf(right))];
export const PROJECT_MODULES = Object.freeze([
  { id: 'websites', label: 'Websites', externalAvailable: true },
  { id: 'team', label: 'Projektteam', externalAvailable: false },
  { id: 'instagram', label: 'Instagram', externalAvailable: false },
  { id: 'knowledge', label: 'Wissen', externalAvailable: false },
  { id: 'creator', label: 'Produkt-Creator', externalAvailable: false },
  { id: 'marketing', label: 'Marketing', externalAvailable: false },
  { id: 'crm', label: 'CRM', externalAvailable: false },
  { id: 'accounting', label: 'Buchhaltung', externalAvailable: false },
  { id: 'energy', label: 'Energie', externalAvailable: false },
].map(Object.freeze));
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,99}$/.test(value)) throw fail('Ungültige Projekt-ID.');
  return value;
}
function email(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized.length > 254 || !/^[a-z\d.!#$%&'*+\/=?^_`{|}~-]{1,64}@[a-z\d](?:[a-z\d.-]*[a-z\d])?\.[a-z]{2,63}$/i.test(normalized) || normalized.includes('..')) throw fail('Bitte eine gültige E-Mail-Adresse angeben.');
  return normalized;
}
function password(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128 || value.includes('\0')) throw fail('Das Passwort muss 12 bis 128 Zeichen enthalten.');
  return value;
}
function validToken(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(value); }
function validRole(value) { if (!roles.includes(value)) throw fail('Ungültige Zugriffsrolle.'); return value; }
function configuration(projectId) { return { projectId, modules: PROJECT_MODULES.map(module => module.id), externalEnabled: false, externalRole: 'editor', dailyBuildLimit: 10 }; }
const fresh = () => ({ version: 1, configs: [], users: [], grants: [], invites: [], sessions: [], usage: [] });

export function createProjectAccessStore({ dataDir, getProject, env = process.env, now = Date.now } = {}) {
  if (!dataDir || typeof getProject !== 'function') throw fail('Projektzugriff benötigt Speicher und Projektverzeichnis.');
  const root = path.join(path.resolve(dataDir), 'project-access');
  const file = path.join(root, 'access.json');
  const time = () => { const value = Number(now()); if (!Number.isFinite(value)) throw fail('Ungültige Zugriffszeit.', 500); return value; };
  async function directory() {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('Unsicherer Zugriffsspeicher.', 500);
  }
  async function read() {
    await directory();
    let handle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_BYTES) throw fail('Zugriffsspeicher ist ungültig oder zu groß.', 500);
      const data = JSON.parse(await handle.readFile('utf8'));
      if (data.version !== 1 || ['configs', 'users', 'grants', 'invites', 'sessions', 'usage'].some(key => !Array.isArray(data[key]))) throw fail('Zugriffsspeicher ist ungültig.', 500);
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return fresh();
      throw fail('Zugriffsspeicher konnte nicht sicher gelesen werden.', 500);
    } finally { await handle?.close(); }
  }
  async function write(data) {
    const encoded = JSON.stringify(data);
    if (Buffer.byteLength(encoded) > MAX_BYTES) throw fail('Zugriffsspeicher ist voll.', 507);
    await directory();
    const info = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink())) throw fail('Unsicherer Zugriffsspeicher.', 500);
    const temporary = path.join(root, `.access-${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, encoded, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async function serialized(fn, mutate = false) {
    const pending = (storageQueues.get(file) || Promise.resolve()).then(async () => {
      const data = await read();
      const result = await fn(data);
      if (mutate) { prune(data); await write(data); }
      return result;
    });
    const settled = pending.catch(() => {});
    storageQueues.set(file, settled);
    void settled.then(() => { if (storageQueues.get(file) === settled) storageQueues.delete(file); });
    return pending;
  }
  function prune(data) {
    const current = time();
    data.sessions = data.sessions.filter(item => item.expiresAt > current);
    data.invites = data.invites.filter(item => item.expiresAt > current && !item.acceptedAt);
    const earliest = iso(current - 2 * 86400_000).slice(0, 10);
    data.usage = data.usage.filter(item => item.day >= earliest);
  }
  async function project(projectId) {
    identifier(projectId);
    const found = await getProject(projectId);
    if (!found) throw fail('Projekt nicht gefunden.', 404, 'PROJECT_NOT_FOUND');
    return found;
  }
  const config = (data, projectId) => data.configs.find(item => item.projectId === projectId) || configuration(projectId);
  const account = user => ({ id: user.id, email: user.email });
  async function verifyPassword(value, user) {
    const salt = user ? Buffer.from(user.salt, 'hex') : Buffer.alloc(16);
    const result = await scrypt(value, salt, 32);
    const expected = user ? Buffer.from(user.passwordHash, 'hex') : Buffer.alloc(32);
    return Boolean(user && expected.length === result.length && crypto.timingSafeEqual(expected, result));
  }
  async function projectsFor(data, userId) {
    const output = [];
    for (const grant of data.grants.filter(item => item.userId === userId)) {
      const settings = config(data, grant.projectId);
      const modules = settings.modules.filter(id => PROJECT_MODULES.some(module => module.id === id && module.externalAvailable));
      if (!settings.externalEnabled || !modules.length || !roles.includes(grant.role) || !roles.includes(settings.externalRole)) continue;
      const found = await getProject(grant.projectId);
      if (!found) continue;
      output.push({ projectId: grant.projectId, name: String(found.name || grant.projectId).slice(0, 180), modules, role: minimumRole(grant.role, settings.externalRole), dailyBuildLimit: settings.dailyBuildLimit });
    }
    return output;
  }
  async function sessionData(data, sessionToken) {
    if (!validToken(sessionToken)) throw fail('Bitte anmelden.', 401, 'PROJECT_SESSION_REQUIRED');
    const stored = data.sessions.find(item => item.tokenHash === digest(sessionToken) && item.expiresAt > time());
    const user = stored && data.users.find(item => item.id === stored.userId);
    if (!user) throw fail('Sitzung ist abgelaufen oder ungültig.', 401, 'PROJECT_SESSION_REQUIRED');
    return { user: account(user), projects: await projectsFor(data, user.id) };
  }
  async function access(data, sessionToken, projectId, { module = 'websites', action = 'read' } = {}) {
    identifier(projectId);
    const result = await sessionData(data, sessionToken);
    const granted = result.projects.find(item => item.projectId === projectId);
    if (!granted || !granted.modules.includes(module) || !PROJECT_MODULES.some(item => item.id === module && item.externalAvailable)) throw fail('Kein Zugriff auf dieses Projekt oder Modul.', 403, 'PROJECT_ACCESS_DENIED');
    if (!['read', 'edit', 'publish', 'export', 'build'].includes(action) || (action === 'publish' ? granted.role !== 'publisher' : action !== 'read' && granted.role === 'viewer')) throw fail('Diese Aktion ist für die Projektrolle nicht freigegeben.', 403, 'PROJECT_ACTION_DENIED');
    return { user: result.user, project: granted, ...granted };
  }
  async function createSession(data, user) {
    const sessionToken = token();
    data.sessions.push({ tokenHash: digest(sessionToken), userId: user.id, createdAt: time(), expiresAt: time() + SESSION_MS });
    return { sessionToken, user: account(user), projects: await projectsFor(data, user.id) };
  }
  async function getProjectAccess(projectId) {
    await project(projectId);
    return serialized(data => {
      const settings = config(data, projectId);
      const members = data.grants.filter(item => item.projectId === projectId).map(grant => ({ userId: grant.userId, email: data.users.find(user => user.id === grant.userId)?.email || '', role: minimumRole(grant.role, settings.externalRole) }));
      const pendingInvites = data.invites.filter(item => item.projectId === projectId && !item.acceptedAt && item.expiresAt > time()).map(item => ({ email: item.email, role: minimumRole(item.role, settings.externalRole), expiresAt: iso(item.expiresAt), createdAt: iso(item.createdAt) }));
      return { ...structuredClone(settings), catalog: PROJECT_MODULES.map(item => ({ ...item })), members, pendingInvites };
    });
  }
  async function configure(projectId, input = {}) {
    await project(projectId);
    await serialized(data => {
      const previous = config(data, projectId);
      if (input.modules !== undefined && (!Array.isArray(input.modules) || input.modules.some(id => !PROJECT_MODULES.some(module => module.id === id)))) throw fail('Unbekanntes Projektmodul.');
      if (input.externalEnabled !== undefined && typeof input.externalEnabled !== 'boolean') throw fail('Externer Zugriff muss aktiviert oder deaktiviert sein.');
      if (input.dailyBuildLimit !== undefined && (!Number.isInteger(input.dailyBuildLimit) || input.dailyBuildLimit < 1 || input.dailyBuildLimit > 50)) throw fail('Das Tageslimit muss zwischen 1 und 50 liegen.');
      const next = { projectId, modules: input.modules === undefined ? previous.modules : [...new Set(input.modules)], externalEnabled: input.externalEnabled ?? previous.externalEnabled, externalRole: input.externalRole === undefined ? previous.externalRole : validRole(input.externalRole), dailyBuildLimit: input.dailyBuildLimit ?? previous.dailyBuildLimit };
      data.configs = data.configs.filter(item => item.projectId !== projectId); data.configs.push(next);
    }, true);
    return getProjectAccess(projectId);
  }
  async function createInvite(projectId, { email: inputEmail, role, expiresInHours = 24 } = {}) {
    await project(projectId);
    const address = email(inputEmail);
    if (!Number.isFinite(expiresInHours) || expiresInHours < 1 || expiresInHours > 24) throw fail('Einladungen sind zwischen 1 und 24 Stunden gültig.');
    return serialized(data => {
      const settings = config(data, projectId);
      if (!settings.externalEnabled || !settings.modules.includes('websites')) throw fail('Externer Website-Zugriff ist für dieses Projekt nicht aktiviert.', 403, 'PROJECT_ACCESS_DISABLED');
      const chosenRole = validRole(role || settings.externalRole);
      if (roles.indexOf(chosenRole) > roles.indexOf(settings.externalRole)) throw fail('Einladungsrolle überschreitet die Projektfreigabe.', 403, 'PROJECT_ROLE_CAP');
      const inviteToken = token();
      const expiresAt = time() + expiresInHours * 3600_000;
      data.invites = data.invites.filter(item => !(item.projectId === projectId && item.email === address));
      data.invites.push({ tokenHash: digest(inviteToken), projectId, email: address, role: chosenRole, createdAt: time(), expiresAt });
      return { token: inviteToken, expiresAt: iso(expiresAt), email: address };
    }, true);
  }
  async function acceptInvite({ token: inviteToken, password: inputPassword } = {}) {
    password(inputPassword);
    if (!validToken(inviteToken)) throw fail('Einladung ist ungültig oder abgelaufen.', 401, 'PROJECT_INVITE_INVALID');
    return serialized(async data => {
      const invite = data.invites.find(item => item.tokenHash === digest(inviteToken) && !item.acceptedAt && item.expiresAt > time());
      if (!invite) throw fail('Einladung ist ungültig oder abgelaufen.', 401, 'PROJECT_INVITE_INVALID');
      const settings = config(data, invite.projectId);
      if (!settings.externalEnabled || !settings.modules.includes('websites')) throw fail('Projektzugriff wurde deaktiviert.', 403, 'PROJECT_ACCESS_DISABLED');
      await project(invite.projectId);
      let user = data.users.find(item => item.email === invite.email);
      if (user) { if (!await verifyPassword(inputPassword, user)) throw fail('Für dieses Konto bitte das bestehende Passwort verwenden.', 401, 'PROJECT_LOGIN_FAILED'); }
      else {
        const salt = crypto.randomBytes(16);
        user = { id: crypto.randomUUID(), email: invite.email, salt: salt.toString('hex'), passwordHash: (await scrypt(inputPassword, salt, 32)).toString('hex'), createdAt: time() };
        data.users.push(user);
      }
      const grantedRole = minimumRole(invite.role, settings.externalRole);
      data.grants = data.grants.filter(item => !(item.userId === user.id && item.projectId === invite.projectId));
      data.grants.push({ userId: user.id, projectId: invite.projectId, role: grantedRole, createdAt: time() });
      invite.acceptedAt = time();
      return createSession(data, user);
    }, true);
  }
  async function login({ email: inputEmail, password: inputPassword } = {}) {
    const address = email(inputEmail); password(inputPassword);
    return serialized(async data => {
      const user = data.users.find(item => item.email === address);
      if (!await verifyPassword(inputPassword, user)) throw fail('E-Mail-Adresse oder Passwort ist falsch.', 401, 'PROJECT_LOGIN_FAILED');
      return createSession(data, user);
    }, true);
  }
  const logout = sessionToken => serialized(data => { if (validToken(sessionToken)) data.sessions = data.sessions.filter(item => item.tokenHash !== digest(sessionToken)); return { loggedOut: true }; }, true);
  const session = sessionToken => serialized(data => sessionData(data, sessionToken));
  const requireAccess = (sessionToken, projectId, options) => serialized(data => access(data, sessionToken, projectId, options));
  const revokeProjectAccess = async (projectId, userId) => {
    await project(projectId);
    return serialized(data => { const user = data.users.find(item => item.id === userId); data.grants = data.grants.filter(item => !(item.projectId === projectId && item.userId === userId)); if (user) data.invites = data.invites.filter(item => !(item.projectId === projectId && item.email === user.email)); return { revoked: true, projectId, userId }; }, true);
  };
  const consumeBuildQuota = (sessionToken, projectId) => serialized(async data => {
    const granted = await access(data, sessionToken, projectId, { module: 'websites', action: 'build' });
    const day = iso(time()).slice(0, 10);
    let usage = data.usage.find(item => item.userId === granted.user.id && item.projectId === projectId && item.day === day);
    if ((usage?.count || 0) >= granted.dailyBuildLimit) throw fail('Das tägliche Website-Baulimit ist erreicht.', 429, 'PROJECT_BUILD_LIMIT');
    if (!usage) { usage = { userId: granted.user.id, projectId, day, count: 0 }; data.usage.push(usage); }
    usage.count++;
    return { projectId, day, used: usage.count, limit: granted.dailyBuildLimit, remaining: granted.dailyBuildLimit - usage.count };
  }, true);
  return Object.freeze({ getProjectAccess, configure, createInvite, acceptInvite, login, logout, session, requireAccess, revokeProjectAccess, consumeBuildQuota });
}
