import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PIPEDRIVE_COMPANY_DOMAIN, PIPEDRIVE_LAYOUT, comparePipedriveLayout } from './pipedrive-layout.js';

const OAUTH_AUTHORIZE_URL = 'https://oauth.pipedrive.com/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://oauth.pipedrive.com/oauth/token';
const STATE_TTL_MS = 10 * 60_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const MAX_WEBHOOK_EVENTS = 500;
const IVA_NOTE_SIGNATURE = '(Notiz von Nadine via KI)';
const DEAL_CUSTOM_FIELD_KEYS = Object.values(PIPEDRIVE_LAYOUT.dealFields).map(field => field.key).join(',');
export const PIPEDRIVE_WRITE_CONFIRMATION = 'Pipedrive schreiben';

const STANDARD_EDITABLE_DEAL_FIELDS = Object.freeze({
  title: Object.freeze({ apiKey: 'title', name: 'Deal-Titel', type: 'text' }),
  value: Object.freeze({ apiKey: 'value', name: 'Deal-Wert', type: 'number' }),
  currency: Object.freeze({ apiKey: 'currency', name: 'Waehrung', type: 'currency' }),
  expectedCloseDate: Object.freeze({ apiKey: 'expected_close_date', name: 'Erwartetes Abschlussdatum', type: 'date' }),
  probability: Object.freeze({ apiKey: 'probability', name: 'Abschlusswahrscheinlichkeit', type: 'probability' }),
});

const EDITABLE_DEAL_FIELDS = Object.freeze({
  ...STANDARD_EDITABLE_DEAL_FIELDS,
  ...Object.fromEntries(Object.entries(PIPEDRIVE_LAYOUT.dealFields).map(([name, field]) => [
    name,
    Object.freeze({ apiKey: field.key, name: field.name, type: 'custom', custom: true }),
  ])),
});

export const PIPEDRIVE_EDITABLE_DEAL_FIELDS = Object.freeze(Object.fromEntries(
  Object.entries(EDITABLE_DEAL_FIELDS).map(([key, field]) => [key, field.name]),
));

function dataDir() {
  return process.env.DATA_DIR || '/data';
}

function tokenFile() {
  return path.join(dataDir(), 'pipedrive-oauth.enc.json');
}

function stateFile() {
  return path.join(dataDir(), 'pipedrive-oauth-states.enc.json');
}

function webhookEventFile() {
  return path.join(dataDir(), 'pipedrive-webhook-events.json');
}

function clean(value, max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function safeDealFieldValue(value, descriptor) {
  if (value === null) return null;
  if (descriptor.type === 'text') {
    const normalized = clean(value, 500);
    if (!normalized) throw new Error(`${descriptor.name} darf nicht leer sein.`);
    return normalized;
  }
  if (descriptor.type === 'number' || descriptor.type === 'probability') {
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || normalized < 0 || (descriptor.type === 'probability' && normalized > 100)) {
      throw new Error(`Ungueltiger Wert fuer ${descriptor.name}.`);
    }
    return normalized;
  }
  if (descriptor.type === 'currency') {
    const normalized = clean(value, 3).toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalized)) throw new Error('Die Pipedrive-Waehrung muss ein dreistelliger ISO-Code sein.');
    return normalized;
  }
  if (descriptor.type === 'date') {
    const normalized = clean(value, 10);
    if (!validDate(normalized)) throw new Error('Das Pipedrive-Datum muss im Format JJJJ-MM-TT vorliegen.');
    return normalized;
  }
  if (Array.isArray(value)) {
    if (value.length > 100 || value.some(item => !['string', 'number', 'boolean'].includes(typeof item))) {
      throw new Error(`Ungueltiger Mehrfachwert fuer ${descriptor.name}.`);
    }
    return value.map(item => typeof item === 'string' ? clean(item, 1000) : item);
  }
  if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`Ungueltiger Wert fuer ${descriptor.name}.`);
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`Ungueltiger Wert fuer ${descriptor.name}.`);
  return typeof value === 'string' ? clean(value, 2000) : value;
}

function currentDealFieldValue(deal, descriptor) {
  if (!descriptor.custom) return deal?.[descriptor.apiKey] ?? null;
  return deal?.custom_fields?.[descriptor.apiKey] ?? deal?.[descriptor.apiKey] ?? null;
}

function comparableValue(value) {
  if (Array.isArray(value)) return value.map(comparableValue);
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, 'id')) return comparableValue(value.id);
    if (Object.hasOwn(value, 'value')) return comparableValue(value.value);
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, comparableValue(item)]));
  }
  if (value === null || value === undefined) return null;
  return String(value);
}

function sameFieldValue(left, right) {
  return JSON.stringify(comparableValue(left)) === JSON.stringify(comparableValue(right));
}

function config() {
  return {
    apiToken: clean(process.env.PIPEDRIVE_API_TOKEN, 1000),
    clientId: clean(process.env.PIPEDRIVE_CLIENT_ID, 500),
    clientSecret: clean(process.env.PIPEDRIVE_CLIENT_SECRET, 1000),
    redirectUri: clean(process.env.PIPEDRIVE_REDIRECT_URI, 1000),
    allowedCompanyDomain: clean(process.env.PIPEDRIVE_ALLOWED_COMPANY_DOMAIN || PIPEDRIVE_COMPANY_DOMAIN, 300).toLowerCase(),
    encryptionSecret: clean(process.env.PIPEDRIVE_TOKEN_KEY || process.env.API_TOKEN || process.env.PIPEDRIVE_CLIENT_SECRET, 2000),
    webhookUsername: clean(process.env.PIPEDRIVE_WEBHOOK_USERNAME, 500),
    webhookPassword: clean(process.env.PIPEDRIVE_WEBHOOK_PASSWORD, 1000),
    writeEnabled: String(process.env.PIPEDRIVE_WRITE_ENABLED || '').toLowerCase() === 'true',
  };
}

function missingConfig() {
  const current = config();
  if (current.apiToken) {
    return [['PIPEDRIVE_ALLOWED_COMPANY_DOMAIN', current.allowedCompanyDomain]]
      .filter(([, value]) => !value).map(([name]) => name);
  }
  return [
    ['PIPEDRIVE_CLIENT_ID', current.clientId],
    ['PIPEDRIVE_CLIENT_SECRET', current.clientSecret],
    ['PIPEDRIVE_REDIRECT_URI', current.redirectUri],
    ['PIPEDRIVE_ALLOWED_COMPANY_DOMAIN', current.allowedCompanyDomain],
    ['PIPEDRIVE_TOKEN_KEY oder API_TOKEN', current.encryptionSecret],
  ].filter(([, value]) => !value).map(([name]) => name);
}

function requireConnectionConfig() {
  const missing = missingConfig();
  if (missing.length) throw new Error(`Pipedrive nicht konfiguriert: ${missing.join(', ')}`);
  return config();
}

function requireOAuthConfig() {
  const current = config();
  const missing = [
    ['PIPEDRIVE_CLIENT_ID', current.clientId],
    ['PIPEDRIVE_CLIENT_SECRET', current.clientSecret],
    ['PIPEDRIVE_REDIRECT_URI', current.redirectUri],
    ['PIPEDRIVE_ALLOWED_COMPANY_DOMAIN', current.allowedCompanyDomain],
    ['PIPEDRIVE_TOKEN_KEY oder API_TOKEN', current.encryptionSecret],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Pipedrive-OAuth nicht konfiguriert: ${missing.join(', ')}`);
  return current;
}

function encryptionKey() {
  return crypto.createHash('sha256').update(requireOAuthConfig().encryptionSecret).digest();
}

function encryptJson(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()]);
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
}

function decryptJson(payload) {
  if (!payload || payload.version !== 1 || payload.algorithm !== 'aes-256-gcm') throw new Error('Unbekanntes Pipedrive-Tokenformat.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'base64')), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

async function atomicWrite(file, value, { mode = 0o600 } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { mode });
    await fs.rename(temporary, file);
    await fs.chmod(file, mode).catch(() => {});
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function writeEncrypted(file, value) {
  return atomicWrite(file, encryptJson(value));
}

async function readEncrypted(file, fallback = null) {
  try { return decryptJson(JSON.parse(await fs.readFile(file, 'utf8'))); }
  catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function readToken() {
  return readEncrypted(tokenFile(), null);
}

async function saveToken(token) {
  return writeEncrypted(tokenFile(), token);
}

async function readStates() {
  const states = await readEncrypted(stateFile(), []);
  return Array.isArray(states) ? states.filter(item => Number(item.expiresAt) > Date.now()) : [];
}

async function consumeState(value) {
  const states = await readStates();
  const matched = states.find(item => item.value === value);
  await writeEncrypted(stateFile(), states.filter(item => item.value !== value));
  if (!matched) throw new Error('Pipedrive-OAuth-Anfrage ist abgelaufen oder wurde bereits verwendet.');
}

function safeApiDomain(value) {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new Error('Pipedrive hat keine gültige API-Domain geliefert.'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.pipedrive.com')) throw new Error('Unerwartete Pipedrive-API-Domain.');
  const allowed = requireConnectionConfig().allowedCompanyDomain;
  if (allowed && url.hostname.toLowerCase() !== allowed) throw new Error('Das verbundene Pipedrive-Unternehmen entspricht nicht der Freigabe.');
  return url.origin;
}

async function exchangeToken(body) {
  const current = requireOAuthConfig();
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${current.clientId}:${current.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw new Error(clean(payload.error_description || payload.error || `Pipedrive-Tokenaustausch fehlgeschlagen (${response.status})`, 500));
  return payload;
}

async function refreshToken(token) {
  if (!token?.refreshToken) throw new Error('Kein Pipedrive-Refresh-Token gespeichert.');
  const payload = await exchangeToken({ grant_type: 'refresh_token', refresh_token: token.refreshToken });
  const updated = {
    ...token,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || token.refreshToken,
    expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000,
    tokenType: payload.token_type || token.tokenType || 'Bearer',
    scope: payload.scope || token.scope || '',
    apiDomain: safeApiDomain(payload.api_domain || token.apiDomain),
    refreshedAt: new Date().toISOString(),
  };
  await saveToken(updated);
  return updated;
}

async function validToken() {
  let token = await readToken();
  if (!token?.refreshToken || !token?.apiDomain) throw new Error('Pipedrive ist noch nicht autorisiert.');
  if (!token.accessToken || Number(token.expiresAt || 0) <= Date.now() + TOKEN_REFRESH_SKEW_MS) token = await refreshToken(token);
  return token;
}

async function validCredential() {
  const current = requireConnectionConfig();
  if (current.apiToken) {
    return {
      mode: 'api-token',
      apiToken: current.apiToken,
      apiDomain: safeApiDomain(`https://${current.allowedCompanyDomain}`),
    };
  }
  const token = await validToken();
  return { mode: 'oauth', ...token };
}

function safeError(payload, response) {
  return clean(payload?.error_info || payload?.error || payload?.message || `Pipedrive API HTTP ${response.status}`, 600);
}

export async function pipedriveRequest(pathname, { method = 'GET', body, write = false } = {}) {
  const verb = String(method || 'GET').toUpperCase();
  if (verb === 'DELETE') throw new Error('Pipedrive-Löschaktionen sind in IVA gesperrt.');
  if (!['GET', 'HEAD'].includes(verb)) {
    if (!write) throw new Error('Pipedrive-Schreibaufruf ohne expliziten Schreibkontext abgelehnt.');
    if (!config().writeEnabled) throw new Error('Pipedrive-Schreibzugriff ist noch nicht freigeschaltet.');
  }
  const credential = await validCredential();
  const requestUrl = new URL(`${safeApiDomain(credential.apiDomain)}${pathname}`);
  if (credential.mode === 'api-token') requestUrl.searchParams.set('api_token', credential.apiToken);
  const response = await fetch(requestUrl, {
    method: verb,
    headers: {
      ...(credential.mode === 'oauth' ? { Authorization: `Bearer ${credential.accessToken}` } : {}),
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) throw new Error(safeError(payload, response));
  return {
    data: payload?.data ?? null,
    additionalData: payload?.additional_data || payload?.additionalData || null,
    rateLimit: {
      limit: response.headers.get('x-ratelimit-limit'),
      remaining: response.headers.get('x-ratelimit-remaining'),
      reset: response.headers.get('x-ratelimit-reset'),
    },
  };
}

export async function createPipedriveAuthUrl() {
  const current = requireOAuthConfig();
  const states = await readStates();
  const state = crypto.randomBytes(32).toString('base64url');
  states.push({ value: state, expiresAt: Date.now() + STATE_TTL_MS });
  await writeEncrypted(stateFile(), states.slice(-20));
  const params = new URLSearchParams({ client_id: current.clientId, redirect_uri: current.redirectUri, state });
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

export async function completePipedriveOAuth({ code, state }) {
  if (!code || !state) throw new Error('Pipedrive-OAuth-Code oder Status fehlt.');
  await consumeState(state);
  const current = requireOAuthConfig();
  const payload = await exchangeToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: current.redirectUri,
  });
  const apiDomain = safeApiDomain(payload.api_domain);
  const previous = await readToken();
  const token = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || previous?.refreshToken || '',
    expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000,
    tokenType: payload.token_type || 'Bearer',
    scope: payload.scope || '',
    apiDomain,
    connectedAt: new Date().toISOString(),
  };
  if (!token.refreshToken) throw new Error('Pipedrive hat keinen Refresh-Token geliefert.');
  await saveToken(token);
  const probe = await probePipedrive();
  return { connected: true, companyDomain: new URL(apiDomain).hostname, probe };
}

function queryString(values = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export async function getPipedriveStructure() {
  const [pipelines, stages, dealFields, personFields, organizationFields, activityTypes] = await Promise.all([
    pipedriveRequest('/api/v1/pipelines?start=0&limit=500'),
    pipedriveRequest('/api/v1/stages?start=0&limit=500'),
    pipedriveRequest('/api/v1/dealFields?start=0&limit=500'),
    pipedriveRequest('/api/v1/personFields?start=0&limit=500'),
    pipedriveRequest('/api/v1/organizationFields?start=0&limit=500'),
    pipedriveRequest('/api/v1/activityTypes?start=0&limit=500'),
  ]);
  const result = {
    pipelines: pipelines.data || [],
    stages: stages.data || [],
    dealFields: dealFields.data || [],
    personFields: personFields.data || [],
    organizationFields: organizationFields.data || [],
    activityTypes: activityTypes.data || [],
  };
  return { ...result, layout: PIPEDRIVE_LAYOUT, drift: comparePipedriveLayout(result) };
}

export async function listPipedriveDeals({ pipelineId, stageId, status = 'open', limit = 100, cursor = '' } = {}) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const normalizedStatus = clean(status, 30).toLowerCase();
  if (!['open', 'won', 'lost', 'deleted', 'all'].includes(normalizedStatus)) throw new Error('Ungueltiger Pipedrive-Dealstatus.');
  const result = await pipedriveRequest(`/api/v2/deals${queryString({
    pipeline_id: pipelineId,
    stage_id: stageId,
    status: normalizedStatus === 'all' ? '' : normalizedStatus,
    custom_fields: DEAL_CUSTOM_FIELD_KEYS,
    include_option_labels: true,
    limit: safeLimit,
    cursor,
  })}`);
  return { deals: Array.isArray(result.data) ? result.data : [], additionalData: result.additionalData, rateLimit: result.rateLimit };
}

export async function searchPipedriveDeals(term, { exactMatch = false, limit = 50 } = {}) {
  const value = clean(term, 500);
  if (value.length < (exactMatch ? 1 : 2)) throw new Error('Pipedrive-Suchbegriff ist zu kurz.');
  const result = await pipedriveRequest(`/api/v2/deals/search${queryString({ term: value, exact_match: exactMatch, limit: Math.max(1, Math.min(100, Number(limit) || 50)) })}`);
  return { term: value, items: result.data?.items || result.data || [], additionalData: result.additionalData };
}

export async function getPipedriveDealBundle(id) {
  const dealId = clean(id, 40);
  if (!/^\d+$/.test(dealId)) throw new Error('Ungültige Pipedrive-Deal-ID.');
  const dealResult = await pipedriveRequest(`/api/v2/deals/${dealId}${queryString({
    custom_fields: DEAL_CUSTOM_FIELD_KEYS,
    include_option_labels: true,
    include_fields: 'next_activity_id,last_activity_id,files_count,notes_count,activities_count,undone_activities_count,source_lead_id',
  })}`);
  const deal = dealResult.data || {};
  const personId = deal.person_id?.value || deal.person_id || null;
  const organizationId = deal.org_id?.value || deal.org_id || null;
  const [person, organization, notes, files, activities] = await Promise.all([
    personId ? pipedriveRequest(`/api/v2/persons/${encodeURIComponent(personId)}`).then(result => result.data).catch(() => null) : null,
    organizationId ? pipedriveRequest(`/api/v2/organizations/${encodeURIComponent(organizationId)}`).then(result => result.data).catch(() => null) : null,
    pipedriveRequest(`/api/v1/notes?deal_id=${dealId}&start=0&limit=500`).then(result => result.data || []),
    pipedriveRequest(`/api/v1/deals/${dealId}/files?start=0&limit=500`).then(result => result.data || []),
    pipedriveRequest(`/api/v2/activities?deal_id=${dealId}&limit=500`).then(result => result.data || []),
  ]);
  return { deal, person, organization, notes, files, activities };
}

function htmlText(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function assertConfirmedWrite(confirmation) {
  if (confirmation !== PIPEDRIVE_WRITE_CONFIRMATION) throw new Error(`Pipedrive-Schreibbestätigung fehlt: „${PIPEDRIVE_WRITE_CONFIRMATION}“.`);
}

export async function createPipedriveDealNote({ dealId, text, confirmation } = {}) {
  assertConfirmedWrite(confirmation);
  const id = clean(dealId, 40);
  const noteText = clean(text, 20_000);
  if (!/^\d+$/.test(id) || !noteText) throw new Error('Deal-ID und Notiztext sind erforderlich.');
  const visible = `${noteText}\n${IVA_NOTE_SIGNATURE}`;
  const current = await pipedriveRequest(`/api/v1/notes?deal_id=${id}&start=0&limit=500`);
  const existing = (current.data || []).find(note => htmlText(note.content) === htmlText(visible));
  if (existing) return { created: false, alreadyPresent: true, noteId: String(existing.id), verified: true };
  const content = `<p>${escapeHtml(noteText).replace(/\n/g, '<br>')}</p><p>${IVA_NOTE_SIGNATURE}</p>`;
  const created = await pipedriveRequest('/api/v1/notes', { method: 'POST', body: { deal_id: Number(id), content }, write: true });
  const verifiedNotes = await pipedriveRequest(`/api/v1/notes?deal_id=${id}&start=0&limit=500`);
  const verified = (verifiedNotes.data || []).find(note => htmlText(note.content) === htmlText(visible));
  if (!verified) throw new Error('Pipedrive-Notiz wurde nach dem Speichern nicht bestätigt.');
  return { created: true, alreadyPresent: false, noteId: String(verified.id || created.data?.id || ''), verified: true };
}

export async function updatePipedriveDealStage({ dealId, expectedStageId, targetStageId, confirmation } = {}) {
  assertConfirmedWrite(confirmation);
  const id = clean(dealId, 40);
  const expected = Number(expectedStageId);
  const target = Number(targetStageId);
  const allowedStages = new Set(Object.values(PIPEDRIVE_LAYOUT.stages).map(stage => stage.id));
  if (!/^\d+$/.test(id) || !allowedStages.has(expected) || !allowedStages.has(target) || expected === target) throw new Error('Ungültige oder nicht freigegebene Pipedrive-Phasenänderung.');
  const before = (await pipedriveRequest(`/api/v2/deals/${id}`)).data || {};
  if (Number(before.stage_id) === target) return { changed: false, alreadyPresent: true, verified: true, fromStageId: target, toStageId: target };
  if (Number(before.stage_id) !== expected) throw new Error(`Pipedrive-Deal steht unerwartet in Phase ${before.stage_id}.`);
  await pipedriveRequest(`/api/v2/deals/${id}`, { method: 'PATCH', body: { stage_id: target }, write: true });
  const after = (await pipedriveRequest(`/api/v2/deals/${id}`)).data || {};
  if (Number(after.stage_id) !== target) throw new Error('Pipedrive-Phasenänderung wurde nicht bestätigt.');
  return { changed: true, alreadyPresent: false, verified: true, fromStageId: expected, toStageId: target };
}

export async function updatePipedriveDealField({ dealId, field, expectedValue, value, confirmation } = {}) {
  assertConfirmedWrite(confirmation);
  const id = clean(dealId, 40);
  const fieldName = clean(field, 100);
  const descriptor = EDITABLE_DEAL_FIELDS[fieldName];
  if (!/^\d+$/.test(id) || !descriptor) throw new Error('Ungueltige Deal-ID oder nicht freigegebenes Pipedrive-Deal-Feld.');
  if (expectedValue === undefined) throw new Error('Der erwartete aktuelle Feldwert ist fuer die sichere Pipedrive-Aenderung erforderlich.');
  const nextValue = safeDealFieldValue(value, descriptor);
  const dealPath = `/api/v2/deals/${id}${queryString({ custom_fields: DEAL_CUSTOM_FIELD_KEYS, include_option_labels: true })}`;
  const before = (await pipedriveRequest(dealPath)).data || {};
  const previousValue = currentDealFieldValue(before, descriptor);
  if (sameFieldValue(previousValue, nextValue)) {
    return { changed: false, alreadyPresent: true, verified: true, dealId: id, field: fieldName, fieldName: descriptor.name, previousValue, value: previousValue };
  }
  if (!sameFieldValue(previousValue, expectedValue)) throw new Error(`Pipedrive-Feld „${descriptor.name}“ hat sich seit dem Lesen veraendert.`);
  const body = descriptor.custom
    ? { custom_fields: { [descriptor.apiKey]: nextValue } }
    : { [descriptor.apiKey]: nextValue };
  await pipedriveRequest(`/api/v2/deals/${id}`, { method: 'PATCH', body, write: true });
  const after = (await pipedriveRequest(dealPath)).data || {};
  const verifiedValue = currentDealFieldValue(after, descriptor);
  if (!sameFieldValue(verifiedValue, nextValue)) throw new Error(`Pipedrive-Feld „${descriptor.name}“ wurde nach dem Speichern nicht bestaetigt.`);
  return { changed: true, alreadyPresent: false, verified: true, dealId: id, field: fieldName, fieldName: descriptor.name, previousValue, value: verifiedValue };
}

export async function probePipedrive() {
  const [me, structure] = await Promise.all([
    pipedriveRequest('/api/v1/users/me'),
    getPipedriveStructure(),
  ]);
  const current = config();
  const token = current.apiToken ? null : await readToken();
  const result = {
    ok: true,
    checkedAt: new Date().toISOString(),
    companyDomain: current.apiToken ? current.allowedCompanyDomain : (token?.apiDomain ? new URL(token.apiDomain).hostname : ''),
    userId: me.data?.id || null,
    pipelines: structure.pipelines.length,
    stages: structure.stages.length,
    dealFields: structure.dealFields.length,
    layoutMatches: structure.drift.matches,
    layoutWarnings: structure.drift.warnings,
  };
  if (!current.apiToken) await saveToken({ ...token, lastProbe: result });
  return result;
}

export async function pipedriveStatus({ probe = false } = {}) {
  const missing = missingConfig();
  const current = config();
  if (missing.length) return {
    configured: false,
    authorized: false,
    readReady: false,
    writeEnabled: false,
    webhookConfigured: Boolean(current.webhookUsername && current.webhookPassword),
    missing,
  };
  try {
    if (current.apiToken) {
      const liveProbe = probe ? await probePipedrive() : null;
      return {
        configured: true,
        authorized: true,
        readReady: true,
        authMode: 'api-token',
        writeEnabled: current.writeEnabled,
        webhookConfigured: Boolean(current.webhookUsername && current.webhookPassword),
        companyDomain: current.allowedCompanyDomain,
        connectedAt: null,
        scope: 'Pipedrive-Nutzerrechte; IVA-Schreibschutz bleibt separat aktiv',
        lastProbe: liveProbe,
        missing: [
          ...(!current.webhookUsername || !current.webhookPassword ? ['Pipedrive-Webhook-Zugang'] : []),
          ...(!current.writeEnabled ? ['Pipedrive-Schreiben bewusst deaktiviert'] : []),
        ],
      };
    }
    const token = await readToken();
    const authorized = Boolean(token?.refreshToken && token?.apiDomain);
    if (!authorized) return {
      configured: true,
      authorized: false,
      readReady: false,
      writeEnabled: current.writeEnabled,
      webhookConfigured: Boolean(current.webhookUsername && current.webhookPassword),
      missing: ['Pipedrive einmal per OAuth freigeben'],
    };
    const liveProbe = probe ? await probePipedrive() : null;
    return {
      configured: true,
      authorized: true,
      readReady: true,
      authMode: 'oauth',
      writeEnabled: current.writeEnabled,
      webhookConfigured: Boolean(current.webhookUsername && current.webhookPassword),
      companyDomain: new URL(token.apiDomain).hostname,
      connectedAt: token.connectedAt,
      scope: token.scope,
      lastProbe: liveProbe || token.lastProbe || null,
      missing: [
        ...(!current.webhookUsername || !current.webhookPassword ? ['Pipedrive-Webhook-Zugang'] : []),
        ...(!current.writeEnabled ? ['Pipedrive-Schreiben bewusst deaktiviert'] : []),
      ],
    };
  } catch (error) {
    return { configured: true, authorized: false, readReady: false, writeEnabled: false, webhookConfigured: false, missing: ['Pipedrive erneut freigeben'], error: error.message };
  }
}

function timingSafeText(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function authorizePipedriveWebhook(authorizationHeader) {
  const current = config();
  if (!current.webhookUsername || !current.webhookPassword) return false;
  const encoded = String(authorizationHeader || '').match(/^Basic\s+(.+)$/i)?.[1] || '';
  let decoded = '';
  try { decoded = Buffer.from(encoded, 'base64').toString('utf8'); } catch { return false; }
  const separator = decoded.indexOf(':');
  if (separator < 1) return false;
  return timingSafeText(decoded.slice(0, separator), current.webhookUsername)
    && timingSafeText(decoded.slice(separator + 1), current.webhookPassword);
}

async function readWebhookEvents() {
  try {
    const value = JSON.parse(await fs.readFile(webhookEventFile(), 'utf8'));
    return Array.isArray(value?.events) ? value : { version: 1, events: [] };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { version: 1, events: [] };
  }
}

export async function recordPipedriveWebhook(payload = {}) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const meta = payload?.meta || {};
  const entityId = clean(meta.entity_id || payload?.data?.id || payload?.current?.id || payload?.previous?.id, 120);
  const event = {
    id: clean(meta.id || meta.webhook_id || hash, 160),
    hash,
    action: clean(meta.action || payload?.event_action || payload?.event?.split('.')?.[0], 80),
    object: clean(meta.entity || payload?.event_object || payload?.event?.split('.')?.[1], 100),
    entityId,
    changeSource: clean(meta.change_source, 30),
    attempt: Number(meta.attempt || 0),
    occurredAt: clean(meta.timestamp || payload?.timestamp, 100),
    receivedAt: new Date().toISOString(),
  };
  const store = await readWebhookEvents();
  if (store.events.some(item => item.hash === hash || (event.id && item.id === event.id))) return { accepted: true, duplicate: true, event };
  store.events.push(event);
  store.events = store.events.slice(-MAX_WEBHOOK_EVENTS);
  store.updatedAt = event.receivedAt;
  await atomicWrite(webhookEventFile(), store);
  return { accepted: true, duplicate: false, event };
}

export async function pipedriveWebhookStatus() {
  const store = await readWebhookEvents();
  return {
    configured: Boolean(config().webhookUsername && config().webhookPassword),
    events: store.events.length,
    lastEvent: store.events.at(-1) || null,
    updatedAt: store.updatedAt || null,
  };
}
