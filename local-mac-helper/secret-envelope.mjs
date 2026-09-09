import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_ROOT = process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper');
const KEY_DIR = path.join(DATA_ROOT, 'keys');
const PRIVATE_KEY_FILE = path.join(KEY_DIR, 'credential-envelope-private.pem');
const PUBLIC_KEY_FILE = path.join(KEY_DIR, 'credential-envelope-public.pem');

function ensureKeyPair() {
  fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  try {
    return {
      privateKey: fs.readFileSync(PRIVATE_KEY_FILE, 'utf8'),
      publicKey: fs.readFileSync(PUBLIC_KEY_FILE, 'utf8'),
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const pair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  fs.writeFileSync(PRIVATE_KEY_FILE, pair.privateKey, { mode: 0o600 });
  fs.writeFileSync(PUBLIC_KEY_FILE, pair.publicKey, { mode: 0o600 });
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

function decode(value, maxBytes) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length > Math.ceil(maxBytes * 4 / 3) + 8) {
    throw new Error('Der verschlüsselte Zugangsdaten-Umschlag ist ungültig.');
  }
  const buffer = Buffer.from(text, 'base64');
  if (!buffer.length || buffer.length > maxBytes) throw new Error('Der verschlüsselte Zugangsdaten-Umschlag ist ungültig.');
  return buffer;
}

export function credentialEnvelopeMetadata() {
  const { publicKey } = ensureKeyPair();
  const spki = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
  return Object.freeze({
    version: 1,
    algorithm: 'RSA-OAEP-256+A256GCM',
    publicKey: spki.toString('base64'),
    fingerprint: crypto.createHash('sha256').update(spki).digest('hex').slice(0, 24),
  });
}

export function decryptCredentialEnvelope(envelope = {}) {
  try {
    if (Number(envelope.version) !== 1 || envelope.algorithm !== 'RSA-OAEP-256+A256GCM') throw new Error('version');
    const { privateKey } = ensureKeyPair();
    const wrappedKey = decode(envelope.wrappedKey, 512);
    const iv = decode(envelope.iv, 32);
    const encrypted = decode(envelope.ciphertext, 16_384);
    if (iv.length !== 12 || encrypted.length < 17) throw new Error('shape');
    const key = crypto.privateDecrypt({ key: privateKey, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, wrappedKey);
    if (key.length !== 32) throw new Error('key');
    const authTag = encrypted.subarray(encrypted.length - 16);
    const ciphertext = encrypted.subarray(0, encrypted.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString('utf8'));
    const credentials = {
      username: String(parsed.username || '').replace(/\u0000/g, '').trim().slice(0, 320),
      password: String(parsed.password || '').replace(/\u0000/g, '').slice(0, 1000),
      totp: String(parsed.totp || '').replace(/\u0000/g, '').trim().slice(0, 2000),
    };
    if (!credentials.username && !credentials.password && !credentials.totp) throw new Error('empty');
    return credentials;
  } catch {
    throw new Error('Die Zugangsdaten konnten auf dem iMac nicht sicher entschlüsselt werden.');
  }
}

export function secretEnvelopePolicy() {
  return Object.freeze({
    transport: 'hybrid-encrypted',
    keyWrap: 'RSA-OAEP-SHA256',
    payload: 'AES-256-GCM',
    privateKeyLocation: 'iMac-local-only',
    plaintextOnRailway: false,
    plaintextInLogs: false,
  });
}
