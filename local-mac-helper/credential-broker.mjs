import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SECURITY = '/usr/bin/security';
const KEYCHAIN_PREFIX = 'de.iva.credentials';

export const IVA_CREDENTIAL_FIELDS = Object.freeze(['username', 'password', 'totp']);

export const IVA_CREDENTIAL_SERVICES = Object.freeze({
  panasonic: Object.freeze({
    id: 'panasonic',
    name: 'Panasonic ProMatch',
    loginUrl: 'https://promatch.panasonicproclub.com/#/page/login',
    allowedHosts: ['promatch.panasonicproclub.com', 'sso-ping.ziftsolutions.com', 'hvac-key.eu.panasonic.com'],
    requiredFields: [],
    optionalFields: ['username', 'password'],
    externalAuthenticator: 'ente-auth:phvaceu-prod-panasonic',
    loginMode: 'browser-password-plus-ente-auth',
  }),
  bosch: Object.freeze({
    id: 'bosch',
    name: 'Bosch/Thernovo',
    loginUrl: 'https://bosch-de-home.thernovo.com/home',
    allowedHosts: ['bosch-de-home.thernovo.com'],
    requiredFields: [],
    optionalFields: ['username', 'password', 'totp'],
    loginMode: 'browser-session-with-keychain-fallback',
  }),
  pipedrive: Object.freeze({
    id: 'pipedrive',
    name: 'Pipedrive Heat Hero',
    loginUrl: 'https://simplegategmbh.pipedrive.com/',
    allowedHosts: ['simplegategmbh.pipedrive.com'],
    requiredFields: ['username', 'password'],
    optionalFields: ['totp'],
    loginMode: 'local-keychain',
  }),
  airtable: Object.freeze({
    id: 'airtable',
    name: 'Airtable Heat Hero',
    loginUrl: 'https://airtable.com/appBsUeEsjEBzIMDc/pagyBs7hOhHp6u3gh',
    allowedHosts: ['airtable.com'],
    requiredFields: [],
    optionalFields: ['username', 'password', 'totp'],
    loginMode: 'browser-session-or-connected-airtable',
  }),
  planbar: Object.freeze({
    id: 'planbar',
    name: 'Planbar365 Heat Hero',
    loginUrl: 'https://heathero-partner-a.planbar365.com/kunden',
    allowedHosts: ['heathero-partner-a.planbar365.com'],
    requiredFields: ['username', 'password'],
    optionalFields: ['totp'],
    loginMode: 'browser-session-with-keychain-fallback',
  }),
});

function serviceFor(value) {
  const id = String(value || '').trim().toLowerCase();
  const service = IVA_CREDENTIAL_SERVICES[id];
  if (!service) throw new Error('Dieser Portalzugang ist nicht für IVAs Schlüsselbund freigegeben.');
  return service;
}

function fieldFor(value) {
  const field = String(value || '').trim().toLowerCase();
  if (!IVA_CREDENTIAL_FIELDS.includes(field)) throw new Error('Schlüsselbund-Feld muss username, password oder totp sein.');
  return field;
}

function item(serviceId, fieldName) {
  const service = serviceFor(serviceId);
  const field = fieldFor(fieldName);
  if (![...service.requiredFields, ...service.optionalFields].includes(field)) {
    throw new Error(`${field} wird für ${service.name} nicht in IVAs macOS-Schlüsselbund gespeichert.`);
  }
  return {
    service,
    field,
    account: `iva:${service.id}`,
    keychainService: `${KEYCHAIN_PREFIX}.${service.id}.${field}`,
    label: `IVA · ${service.name} · ${field}`,
  };
}

function withoutTerminalNewline(value) {
  return String(value ?? '').replace(/\r?\n$/, '');
}

export async function hasCredentialField(serviceId, fieldName, { exec = execFileAsync } = {}) {
  const service = serviceFor(serviceId);
  const field = fieldFor(fieldName);
  if (![...service.requiredFields, ...service.optionalFields].includes(field)) return false;
  const target = item(serviceId, fieldName);
  try {
    await exec(SECURITY, ['find-generic-password', '-a', target.account, '-s', target.keychainService], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    return true;
  } catch (error) {
    if (Number(error?.code) === 44 || /could not be found/i.test(String(error?.stderr || error?.message || ''))) return false;
    throw new Error(`macOS-Schlüsselbund konnte für ${target.service.name} nicht geprüft werden.`);
  }
}

export async function readCredentialField(serviceId, fieldName, { exec = execFileAsync } = {}) {
  const target = item(serviceId, fieldName);
  try {
    const { stdout } = await exec(SECURITY, ['find-generic-password', '-a', target.account, '-s', target.keychainService, '-w'], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
    });
    const secret = withoutTerminalNewline(stdout);
    if (!secret) throw new Error('empty');
    return secret;
  } catch {
    throw new Error(`Der sichere ${target.field}-Eintrag für ${target.service.name} fehlt oder wurde von macOS nicht freigegeben.`);
  }
}

export async function configureCredentialFieldInteractive(serviceId, fieldName, { spawnProcess = spawn } = {}) {
  const target = item(serviceId, fieldName);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Die einmalige Schlüsselbund-Einrichtung muss in einem lokalen interaktiven Terminal gestartet werden.');
  }
  const args = [
    'add-generic-password', '-U',
    '-a', target.account,
    '-s', target.keychainService,
    '-l', target.label,
    '-j', 'Nur für den lokalen IVA Mac Helper. Niemals in Chat, Dateien oder Logs ausgeben.',
    '-w',
  ];
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawnProcess(SECURITY, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', code => resolve(code));
  });
  if (exitCode !== 0) throw new Error(`Der ${target.field}-Eintrag für ${target.service.name} wurde nicht gespeichert.`);
  return { service: target.service.id, field: target.field, configured: true, secretReturned: false };
}

export async function credentialServiceStatus(serviceId, options = {}) {
  const service = serviceFor(serviceId);
  const configured = {};
  for (const field of IVA_CREDENTIAL_FIELDS) configured[field] = await hasCredentialField(service.id, field, options);
  const missingRequiredFields = service.requiredFields.filter(field => !configured[field]);
  return {
    id: service.id,
    name: service.name,
    loginMode: service.loginMode,
    configured,
    missingRequiredFields,
    keychainReady: missingRequiredFields.length === 0,
    externalAuthenticator: service.externalAuthenticator || null,
    secretValuesReturned: false,
  };
}

export async function credentialBrokerStatus(serviceId = '', options = {}) {
  if (serviceId) return credentialServiceStatus(serviceId, options);
  const services = [];
  for (const id of Object.keys(IVA_CREDENTIAL_SERVICES)) services.push(await credentialServiceStatus(id, options));
  return { services, secretValuesReturned: false };
}

function parseTotpValue(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('TOTP-Schlüssel fehlt.');
  if (!/^otpauth:\/\//i.test(raw)) return { secret: raw, algorithm: 'sha1', digits: 6, period: 30 };
  const url = new URL(raw);
  if (url.protocol !== 'otpauth:' || url.hostname.toLowerCase() !== 'totp') throw new Error('Nur TOTP-Einträge werden unterstützt.');
  return {
    secret: String(url.searchParams.get('secret') || ''),
    algorithm: String(url.searchParams.get('algorithm') || 'SHA1').toLowerCase(),
    digits: Number(url.searchParams.get('digits') || 6),
    period: Number(url.searchParams.get('period') || 30),
  };
}

function decodeBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = String(value || '').toUpperCase().replace(/[\s=-]/g, '');
  if (!normalized || [...normalized].some(char => !alphabet.includes(char))) throw new Error('TOTP-Schlüssel ist kein gültiger Base32-Wert.');
  let bits = '';
  for (const char of normalized) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

export function generateTotp(value, { now = Date.now() } = {}) {
  const parsed = parseTotpValue(value);
  if (!['sha1', 'sha256', 'sha512'].includes(parsed.algorithm)) throw new Error('TOTP-Algorithmus wird nicht unterstützt.');
  if (![6, 7, 8].includes(parsed.digits)) throw new Error('TOTP-Stellenzahl wird nicht unterstützt.');
  if (!Number.isFinite(parsed.period) || parsed.period < 15 || parsed.period > 120) throw new Error('TOTP-Zeitraum wird nicht unterstützt.');
  const counter = Math.floor(Number(now) / 1000 / parsed.period);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac(parsed.algorithm, decodeBase32(parsed.secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % (10 ** parsed.digits)).padStart(parsed.digits, '0');
}

export async function currentTotpForService(serviceId, options = {}) {
  const secret = await readCredentialField(serviceId, 'totp', options);
  return generateTotp(secret, options);
}

export function credentialBrokerPolicy() {
  return Object.freeze({
    storage: 'macOS-login-keychain',
    services: Object.keys(IVA_CREDENTIAL_SERVICES),
    fields: IVA_CREDENTIAL_FIELDS,
    secretsInFiles: false,
    secretsInLogs: false,
    secretsInModelOutput: false,
    interactiveSetupOnly: true,
    remoteSecretRead: false,
    extensibleByAllowlistedServiceProfile: true,
  });
}
