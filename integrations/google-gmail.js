import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API_URL = 'https://gmail.googleapis.com/gmail/v1';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;

function dataDir() {
  return process.env.DATA_DIR || '/data';
}

function tokenFile() {
  return path.join(dataDir(), 'google-gmail-oauth.enc.json');
}

function stateFile() {
  return path.join(dataDir(), 'google-gmail-oauth-states.enc.json');
}

function config() {
  return {
    clientId: String(process.env.GOOGLE_GMAIL_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.GOOGLE_GMAIL_CLIENT_SECRET || '').trim(),
    redirectUri: String(process.env.GOOGLE_GMAIL_REDIRECT_URI || '').trim(),
    allowedAccount: String(process.env.GMAIL_ALLOWED_ACCOUNT || '').trim().toLowerCase(),
    encryptionSecret: String(
      process.env.GOOGLE_GMAIL_TOKEN_KEY
      || process.env.API_TOKEN
      || process.env.GOOGLE_GMAIL_CLIENT_SECRET
      || '',
    ).trim(),
  };
}

function missingConfig() {
  const current = config();
  return [
    ['GOOGLE_GMAIL_CLIENT_ID', current.clientId],
    ['GOOGLE_GMAIL_CLIENT_SECRET', current.clientSecret],
    ['GOOGLE_GMAIL_REDIRECT_URI', current.redirectUri],
    ['GMAIL_ALLOWED_ACCOUNT', current.allowedAccount],
    ['GOOGLE_GMAIL_TOKEN_KEY oder API_TOKEN', current.encryptionSecret],
  ].filter(([, value]) => !value).map(([name]) => name);
}

function requireConfig() {
  const missing = missingConfig();
  if (missing.length) throw new Error(`Gmail-OAuth nicht konfiguriert: ${missing.join(', ')}`);
  return config();
}

function encryptionKey() {
  return crypto.createHash('sha256').update(requireConfig().encryptionSecret).digest();
}

function encryptJson(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
}

function decryptJson(payload) {
  if (!payload || payload.version !== 1 || payload.algorithm !== 'aes-256-gcm') {
    throw new Error('Unbekanntes Gmail-Tokenformat.');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(payload.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}

async function writeEncrypted(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(encryptJson(value)), { mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => {});
}

async function readEncrypted(file, fallback = null) {
  try {
    return decryptJson(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function readToken() {
  return readEncrypted(tokenFile(), null);
}

async function saveToken(token) {
  await writeEncrypted(tokenFile(), token);
}

async function readStates() {
  const now = Date.now();
  const states = await readEncrypted(stateFile(), []);
  return Array.isArray(states) ? states.filter(item => Number(item.expiresAt) > now) : [];
}

async function saveStates(states) {
  await writeEncrypted(stateFile(), states.slice(-20));
}

async function consumeState(value) {
  const states = await readStates();
  const matched = states.find(item => item.value === value);
  await saveStates(states.filter(item => item.value !== value));
  if (!matched) throw new Error('OAuth-Anfrage ist abgelaufen oder wurde bereits verwendet.');
}

async function googleRequest(pathname, { accessToken, method = 'GET', body } = {}) {
  const response = await fetch(`${GMAIL_API_URL}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
  if (!response.ok) {
    const message = parsed?.error?.message || `Google API antwortet mit HTTP ${response.status}`;
    throw new Error(message);
  }
  return parsed;
}

async function exchangeCode(code) {
  const current = requireConfig();
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: current.clientId,
      client_secret: current.clientSecret,
      redirect_uri: current.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || `Token-Austausch fehlgeschlagen (${response.status})`);
  }
  return payload;
}

async function refreshToken(token) {
  const current = requireConfig();
  if (!token?.refreshToken) throw new Error('Kein Gmail-Refresh-Token gespeichert.');
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: token.refreshToken,
      client_id: current.clientId,
      client_secret: current.clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || `Token-Erneuerung fehlgeschlagen (${response.status})`);
  }
  const updated = {
    ...token,
    accessToken: payload.access_token,
    expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000,
    scope: payload.scope || token.scope,
    tokenType: payload.token_type || token.tokenType || 'Bearer',
    refreshedAt: new Date().toISOString(),
  };
  await saveToken(updated);
  return updated;
}

async function validToken() {
  let token = await readToken();
  if (!token?.refreshToken) throw new Error('Gmail ist noch nicht autorisiert.');
  if (!token.accessToken || Number(token.expiresAt || 0) <= Date.now() + TOKEN_REFRESH_SKEW_MS) {
    token = await refreshToken(token);
  }
  return token;
}

function headerValue(headers, name) {
  return (headers || []).find(item => String(item?.name || '').toLowerCase() === name.toLowerCase())?.value || '';
}

async function countMessages(accessToken, query) {
  const result = await googleRequest(`/users/me/messages?maxResults=1&q=${encodeURIComponent(query)}`, { accessToken });
  return Number(result.resultSizeEstimate || 0);
}

export async function createGoogleGmailAuthUrl() {
  const current = requireConfig();
  const states = await readStates();
  const state = crypto.randomBytes(32).toString('base64url');
  states.push({ value: state, expiresAt: Date.now() + STATE_TTL_MS });
  await saveStates(states);
  const params = new URLSearchParams({
    client_id: current.clientId,
    redirect_uri: current.redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPE,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
    login_hint: current.allowedAccount,
  });
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

export async function completeGoogleGmailOAuth({ code, state }) {
  if (!code || !state) throw new Error('OAuth-Code oder Status fehlt.');
  await consumeState(state);
  const payload = await exchangeCode(code);
  const profile = await googleRequest('/users/me/profile', { accessToken: payload.access_token });
  const current = requireConfig();
  const connectedAccount = String(profile.emailAddress || '').trim().toLowerCase();
  if (!connectedAccount || connectedAccount !== current.allowedAccount) {
    throw new Error('Falsches Google-Konto. Bitte ausschließlich das freigegebene IVA-Gmail-Konto verbinden.');
  }
  const previous = await readToken();
  const token = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || previous?.refreshToken || '',
    expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000,
    scope: payload.scope || GMAIL_SCOPE,
    tokenType: payload.token_type || 'Bearer',
    connectedAccount,
    connectedAt: new Date().toISOString(),
  };
  if (!token.refreshToken) throw new Error('Google hat keinen Refresh-Token geliefert. Bitte die Verbindung erneut freigeben.');
  await saveToken(token);
  const probe = await probeGoogleGmail();
  return { connected: true, account: connectedAccount, probe };
}

export async function listGoogleGmailLabels() {
  const token = await validToken();
  const result = await googleRequest('/users/me/labels', { accessToken: token.accessToken });
  return (result.labels || []).map(label => ({ id: label.id, name: label.name, type: label.type || '' }));
}

export async function listGoogleGmailMessages({ limit = 20, query = 'in:inbox', includeBody = false } = {}) {
  const token = await validToken();
  const maxResults = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const listed = await googleRequest(`/users/me/messages?maxResults=${maxResults}&q=${encodeURIComponent(query || 'in:inbox')}`, { accessToken: token.accessToken });
  const messages = await Promise.all((listed.messages || []).map(async item => {
    const format = includeBody ? 'full' : 'metadata';
    const metadataHeaders = ['From', 'To', 'Delivered-To', 'Subject', 'Date'].map(value => `metadataHeaders=${encodeURIComponent(value)}`).join('&');
    const detail = await googleRequest(`/users/me/messages/${encodeURIComponent(item.id)}?format=${format}${includeBody ? '' : `&${metadataHeaders}`}`, { accessToken: token.accessToken });
    const headers = detail.payload?.headers || [];
    return {
      id: detail.id,
      threadId: detail.threadId,
      labelIds: detail.labelIds || [],
      from: headerValue(headers, 'From'),
      to: headerValue(headers, 'To'),
      deliveredTo: headerValue(headers, 'Delivered-To'),
      subject: headerValue(headers, 'Subject') || '(kein Betreff)',
      date: headerValue(headers, 'Date'),
      snippet: detail.snippet || '',
      body: includeBody ? detail.payload || null : undefined,
    };
  }));
  return { query, resultSizeEstimate: Number(listed.resultSizeEstimate || 0), messages };
}

export async function probeGoogleGmail() {
  const token = await validToken();
  const [profile, labels, heatHeroCount, fundingCount] = await Promise.all([
    googleRequest('/users/me/profile', { accessToken: token.accessToken }),
    googleRequest('/users/me/labels', { accessToken: token.accessToken }),
    countMessages(token.accessToken, 'newer_than:30d "n.sell@heat-hero.com"'),
    countMessages(token.accessToken, 'newer_than:30d "foerderung@heat-hero.com"'),
  ]);
  const current = requireConfig();
  const account = String(profile.emailAddress || '').trim().toLowerCase();
  if (account !== current.allowedAccount) throw new Error('Das verbundene Gmail-Konto entspricht nicht der Freigabe.');
  const result = {
    ok: true,
    checkedAt: new Date().toISOString(),
    accountMatches: true,
    labels: Array.isArray(labels.labels) ? labels.labels.length : 0,
    heatHeroMessages30d: heatHeroCount,
    fundingMessages30d: fundingCount,
  };
  await saveToken({ ...token, lastProbe: result });
  return result;
}

export async function googleGmailStatus({ probe = false } = {}) {
  const missing = missingConfig();
  if (missing.length) return { configured: false, authorized: false, ready: false, missing };
  try {
    const token = await readToken();
    const authorized = Boolean(token?.refreshToken && token?.connectedAccount);
    if (!authorized) return { configured: true, authorized: false, ready: false, missing: ['Google-Gmail einmal freigeben'] };
    const liveProbe = probe ? await probeGoogleGmail() : null;
    return {
      configured: true,
      authorized: true,
      ready: true,
      missing: [],
      connectedAccount: token.connectedAccount,
      connectedAt: token.connectedAt,
      lastProbe: liveProbe || token.lastProbe || null,
    };
  } catch (error) {
    return { configured: true, authorized: false, ready: false, missing: ['Google-Gmail erneut freigeben'], error: error.message };
  }
}

export function googleGmailScope() {
  return GMAIL_SCOPE;
}
