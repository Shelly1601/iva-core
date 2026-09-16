import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { decryptCredentialEnvelope } from './secret-envelope.mjs';
import { ensurePortalProfileLogin } from './portal-auth.mjs';
import { generateTotp } from './credential-broker.mjs';

const DATA_ROOT = process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper');
const REGISTRY_FILE = path.join(DATA_ROOT, 'course-credential-profiles.json');
const KEYCHAIN_PREFIX = 'de.iva.course-credentials';
const SECURITY = '/usr/bin/security';
let queue = Promise.resolve();

const clean = (value, max = 1000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);

function profileId(value) {
  const id = clean(value, 80).toLowerCase();
  if (!/^course-[a-f0-9]{18}$/.test(id)) throw new Error('Ungültiges Kurs-Zugangsprofil.');
  return id;
}

function normalizeProfile(input = {}) {
  const id = profileId(input.id || input.profileId);
  let url;
  try { url = new URL(clean(input.loginUrl || input.sourceUrl, 1800)); } catch { throw new Error('Ungültige Kursadresse.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Kursadresse muss HTTPS verwenden.');
  const expected = `course-${crypto.createHash('sha256').update(url.hostname.toLowerCase()).digest('hex').slice(0, 18)}`;
  if (id !== expected) throw new Error('Kurs-Zugangsprofil passt nicht zur Kursadresse.');
  url.hash = '';
  return {
    id,
    name: clean(input.name || input.title, 220) || url.hostname,
    loginUrl: url.toString(),
    allowedHosts: [url.hostname.toLowerCase()],
    requiredFields: ['username', 'password'],
    optionalFields: ['totp'],
    loginMode: 'course-keychain',
  };
}

async function readRegistry() {
  try {
    const parsed = JSON.parse(await readFile(REGISTRY_FILE, 'utf8'));
    return { version: 1, profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [] };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { version: 1, profiles: [] };
  }
}

async function mutateRegistry(work) {
  let result;
  const task = queue.catch(() => {}).then(async () => {
    const store = await readRegistry();
    result = await work(store);
    await mkdir(path.dirname(REGISTRY_FILE), { recursive: true, mode: 0o700 });
    const temporary = `${REGISTRY_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, profiles: store.profiles.slice(-100) }, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, REGISTRY_FILE);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  });
  queue = task.catch(() => {});
  await task;
  return result;
}

function keychainTarget(id, field) {
  if (!['username', 'password', 'totp'].includes(field)) throw new Error('Ungültiges Zugangsdatenfeld.');
  return { account: `iva:${id}`, service: `${KEYCHAIN_PREFIX}.${id}.${field}` };
}

function securityCommand(args, { stdin = '', sensitive = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(SECURITY, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 15_000);
    child.stdout.on('data', chunk => { if (stdout.length < 16_384) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 16_384) stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(Object.assign(new Error(sensitive ? 'macOS-Schlüsselbundzugriff fehlgeschlagen.' : clean(stderr || stdout, 400)), { code }));
    });
    if (stdin) child.stdin.end(`${stdin}\n`); else child.stdin.end();
  });
}

async function storeSecret(id, field, value) {
  if (!value) return false;
  const target = keychainTarget(id, field);
  await securityCommand([
    'add-generic-password', '-U', '-a', target.account, '-s', target.service,
    '-l', `IVA · Kurszugang · ${field}`, '-j', 'Nur lokaler IVA Mac Helper; nie ausgeben oder protokollieren.', '-w',
  ], { stdin: value, sensitive: true });
  return true;
}

async function hasSecret(id, field) {
  const target = keychainTarget(id, field);
  try {
    await securityCommand(['find-generic-password', '-a', target.account, '-s', target.service]);
    return true;
  } catch (error) {
    if (Number(error?.code) === 44) return false;
    return false;
  }
}

async function readSecret(id, field) {
  const target = keychainTarget(id, field);
  try {
    return String(await securityCommand(['find-generic-password', '-a', target.account, '-s', target.service, '-w'], { sensitive: true }))
      .replace(/\r?\n$/, '').replace(/\u0000/g, '').slice(0, field === 'password' ? 1000 : 2000);
  } catch {
    throw new Error('Der sichere Kurszugang fehlt oder wurde von macOS nicht freigegeben.');
  }
}

export async function storeCourseCredentialEnvelope(input = {}) {
  const profile = normalizeProfile(input);
  const credentials = decryptCredentialEnvelope(input.envelope);
  const stored = {};
  for (const field of ['username', 'password', 'totp']) stored[field] = await storeSecret(profile.id, field, credentials[field]);
  await mutateRegistry(store => {
    const previous = store.profiles.find(item => item.id === profile.id);
    const saved = { ...profile, createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    if (previous) Object.assign(previous, saved); else store.profiles.push(saved);
    return saved;
  });
  return { profileId: profile.id, configured: stored, keychainReady: stored.username && stored.password, secretValuesReturned: false };
}

export async function getCourseCredentialProfile(id) {
  const profile = (await readRegistry()).profiles.find(item => item.id === profileId(id));
  return profile ? { ...profile } : null;
}

export async function courseCredentialStatus(id) {
  const profile = await getCourseCredentialProfile(id);
  if (!profile) return { profileId: profileId(id), configured: { username: false, password: false, totp: false }, keychainReady: false, secretValuesReturned: false };
  const configured = {};
  for (const field of ['username', 'password', 'totp']) configured[field] = await hasSecret(profile.id, field);
  return { profileId: profile.id, name: profile.name, configured, keychainReady: configured.username && configured.password, secretValuesReturned: false };
}

export async function ensureCourseLogin(id, options = {}) {
  const profile = await getCourseCredentialProfile(id);
  if (!profile) throw new Error('Für diesen Kurs ist noch kein lokales Zugangsprofil eingerichtet.');
  return ensurePortalProfileLogin(profile, {
    ...options,
    readSecret: async (_service, field) => readSecret(profile.id, field),
    createTotp: async () => generateTotp(await readSecret(profile.id, 'totp')),
    keychainStatus: async () => courseCredentialStatus(profile.id),
  });
}

export function courseCredentialPolicy() {
  return Object.freeze({
    registryContainsSecrets: false,
    secretStorage: 'macOS-login-keychain',
    encryptedProvisioning: true,
    arbitraryProtocol: false,
    hostBoundProfiles: true,
    secretValuesReturned: false,
  });
}
