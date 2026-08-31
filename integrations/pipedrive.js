import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PIPEDRIVE_COMPANY_DOMAIN, PIPEDRIVE_LAYOUT, comparePipedriveLayout } from './pipedrive-layout.js';

const OAUTH_AUTHORIZE_URL = 'https://oauth.pipedrive.com/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://oauth.pipedrive.com/oauth/token';
const STATE_TTL_MS = 10 * 60_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const MAX_WEBHOOK_EVENTS = 500;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
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

export async function getPipedriveDealBundle(id, { customFieldKeys = DEAL_CUSTOM_FIELD_KEYS } = {}) {
  const dealId = clean(id, 40);
  if (!/^\d+$/.test(dealId)) throw new Error('Ungültige Pipedrive-Deal-ID.');
  const dealResult = await pipedriveRequest(`/api/v2/deals/${dealId}${queryString({
    custom_fields: clean(customFieldKeys, 4000) || DEAL_CUSTOM_FIELD_KEYS,
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

function primaryEmail(record) {
  const emails = Array.isArray(record?.email) ? record.email : [];
  return clean(emails.find(item => item?.primary && item?.value)?.value || emails.find(item => item?.value)?.value, 500) || null;
}

function fundingNoteEvidence(note) {
  const content = String(note?.content || '');
  const text = htmlText(content).replace(/\s+/g, ' ').trim();
  const marker = content.match(/IVA-FUNDING-REQUEST:\d+:[0-9a-f]{24}/i)?.[0] || null;
  const kfwEvidenceMarker = content.match(/IVA-KFW-EVIDENCE:\d+:[0-9a-f]{24}/i)?.[0] || null;
  const humanReadableIvaRequest = /^fehlende unterlagen:/i.test(text)
    && /angefragt\./i.test(text)
    && text.toLowerCase().endsWith(IVA_NOTE_SIGNATURE.toLowerCase());
  const kfwEmailMatch = text.match(/[a-z0-9.!#$%&'*+/=?^_{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  const kfwSecretAfterEmail = kfwEmailMatch
    ? text.slice((kfwEmailMatch.index || 0) + kfwEmailMatch[0].length).trim().match(/^(\S{6,})/)?.[1] || ''
    : '';
  const hasKfwCredentials = Boolean(kfwEmailMatch)
    && (/(?:passwort|kennwort)\s*[:=\-]\s*\S{3,}/i.test(text)
      || (/kfw.{0,30}konto/i.test(text) && /[A-Za-z]/.test(kfwSecretAfterEmail) && /\d/.test(kfwSecretAfterEmail)));
  return {
    noteId: String(note?.id || ''),
    addTime: note?.add_time || note?.addTime || null,
    updateTime: note?.update_time || note?.updateTime || null,
    hasKfwCredentials,
    invalidatesKfwCredentials: /(?:zugangsdaten|passwort|kennwort|kfw.{0,30}konto).{0,80}(?:stimm(?:en|t)\s*nicht|ungültig|ungueltig|geändert|geaendert|nicht\s+bestätigt|nicht\s+bestaetigt|nicht\s+bestatigt)|(?:konto|aktivierungslink).{0,60}(?:nicht\s+bestätigt|nicht\s+bestaetigt|nicht\s+bestatigt)/i.test(text),
    isIvaFundingRequest: Boolean(marker) || humanReadableIvaRequest,
    marker,
    kfwEvidenceMarker,
    includesKfwMissing: (Boolean(marker) || humanReadableIvaRequest) && /(?:kfw.{0,60}(?:konto|bestätigung|bestatigung|bestaetigung|zugang)|bestätigung.{0,60}kfw|bestatigung.{0,60}kfw|bestaetigung.{0,60}kfw)/i.test(text),
    redactedExcerpt: hasKfwCredentials
      ? 'KfW-Zugangsdaten in der Notiz vorhanden; E-Mail-Adresse und Passwort vollständig ausgeblendet.'
      : text.replace(/[a-z0-9.!#$%&'*+/=?^_{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/ig, '[E-Mail ausgeblendet]')
        .replace(/((?:passwort|kennwort)\s*[:=\-]\s*)\S+/ig, '$1[ausgeblendet]').slice(0, 600),
  };
}

export async function getPipedriveFundingSnapshot(id) {
  const structure = await cachedPipedriveFundingStructure();
  const relevantFieldNames = new Set(['vertriebspartner', 'e-mail', 'e-mail-adresse', 'email', 'auftragsnummer', 'angebotsnummer', 'angebotsnummer (sevdesk)', 'kundennummer', 'kunden-nr.', 'telefonnummer', 'telefon', 'mobilnummer', 'anlage', 'einkommensbonus', 'einkommens-bonus']);
  const customFieldKeys = structure.dealFields.filter(field => relevantFieldNames.has(clean(field.name).toLocaleLowerCase('de-DE'))).map(field => field.key).filter(Boolean).join(',');
  const bundle = await getPipedriveDealBundle(id, { customFieldKeys });
  const { deal, person, notes, files } = bundle;
  const fieldByName = new Map(structure.dealFields.map(field => [clean(field.name).toLocaleLowerCase('de-DE'), field]));
  const field = (...names) => names.map(name => fieldByName.get(String(name).toLocaleLowerCase('de-DE'))).find(Boolean) || null;
  const value = (...names) => {
    const definition = field(...names);
    return definition ? deal?.custom_fields?.[definition.key] ?? deal?.[definition.key] ?? null : null;
  };
  const enumLabel = (rawValue, definition) => definition?.options?.find(option => String(option.id) === String(rawValue))?.label || rawValue || null;
  const stageName = structure.stages.find(stage => String(stage.id) === String(deal.stage_id))?.name || String(deal.stage_id || '');
  const customerName = clean(deal.person_name || person?.name, 500) || null;
  const title = clean(deal.title, 1000);
  const titleOrderNumber = title.match(/\bHH-(?:AN|AB)-[A-Z0-9-]{4,}\b/i)?.[0]?.toUpperCase() || null;
  const location = customerName ? (() => {
    const tail = title.replace(/^AM:\s*/i, '').slice(customerName.length).replace(/^\s*-\s*/, '');
    const candidate = tail.split(/\s+-\s+/)[0]?.trim() || '';
    return !candidate || candidate === '-' || /HH-(?:AN|AB)-|SOL\s*LIVING|HEAT\s*HERO|EKD/i.test(candidate) ? null : candidate;
  })() : null;
  const vpId = value('Vertriebspartner');
  const vp = /^\d+$/.test(String(vpId || ''))
    ? await pipedriveRequest(`/api/v2/persons/${encodeURIComponent(vpId)}`).then(result => result.data).catch(() => null)
    : null;
  const incomeBonusValue = value('Einkommensbonus', 'Einkommens-Bonus');
  const incomeBonusRequested = incomeBonusValue == null ? null
    : /^(ja|yes|beantragt|true|1)$/i.test(String(incomeBonusValue).trim()) ? true
      : /^(nein|no|nicht beantragt|false|0)$/i.test(String(incomeBonusValue).trim()) ? false : null;
  const evidence = notes.map(fundingNoteEvidence);
  const plantField = field('Anlage');
  return {
    dealId: String(deal.id || id),
    url: `https://${config().allowedCompanyDomain}/deal/${String(deal.id || id)}`,
    dealTitle: title,
    pipeline: structure.pipelines.find(item => String(item.id) === String(deal.pipeline_id))?.name || String(deal.pipeline_id || ''),
    stage: stageName,
    customerName,
    customerPersonId: deal.person_id?.value ? String(deal.person_id.value) : deal.person_id ? String(deal.person_id) : null,
    customerEmail: clean(value('E-Mail', 'E-Mail-Adresse', 'Email'), 500) || primaryEmail(person),
    orderNumber: clean(value('Auftragsnummer', 'Angebotsnummer', 'Angebotsnummer (sevdesk)'), 200) || titleOrderNumber,
    customerNumber: clean(value('Kundennummer', 'Kunden-Nr.'), 200) || null,
    phoneNumber: clean(value('Telefonnummer', 'Telefon', 'Mobilnummer'), 200) || null,
    plant: clean(enumLabel(value('Anlage'), plantField), 500) || null,
    incomeBonusRequested,
    location,
    vpName: clean(vp?.name || (typeof vpId === 'string' && vpId.includes('@') ? vpId : ''), 500) || null,
    vpPersonId: vpId ? String(vpId) : null,
    vpEmail: primaryEmail(vp) || (typeof vpId === 'string' && vpId.includes('@') ? vpId.toLowerCase() : null),
    files: files.map(file => clean(file.name || file.file_name, 500)).filter(Boolean),
    fileRecords: files.map(file => ({ id: String(file.id || ''), name: clean(file.name || file.file_name, 500), size: Number(file.file_size || file.size || 0), mimeType: clean(file.file_type || file.mime_type, 200) })).filter(file => /^\d+$/.test(file.id) && file.name),
    noteCount: notes.length,
    latestNoteAt: evidence.map(note => note.updateTime || note.addTime).filter(Boolean).sort().at(-1) || null,
    latestExternalNote: evidence.filter(note => !note.isIvaFundingRequest).sort((a, b) => String(b.updateTime || b.addTime || '').localeCompare(String(a.updateTime || a.addTime || '')))[0] || null,
    kfwAccountConfirmedByCredentials: evidence.some(note => note.hasKfwCredentials),
    kfwCredentialEvidenceNoteIds: evidence.filter(note => note.hasKfwCredentials).map(note => note.noteId),
    kfwCredentialInvalidationNoteIds: evidence.filter(note => note.invalidatesKfwCredentials).map(note => note.noteId),
    ivaFundingRequestNotes: evidence.filter(note => note.isIvaFundingRequest),
    readOnly: true,
    mutated: false,
    source: 'iva-core-pipedrive-api',
  };
}

let fundingStructureCache = null;
async function cachedPipedriveFundingStructure() {
  if (fundingStructureCache && fundingStructureCache.expiresAt > Date.now()) return fundingStructureCache.value;
  const value = await getPipedriveStructure();
  fundingStructureCache = { value, expiresAt: Date.now() + 5 * 60_000 };
  return value;
}

export async function listPipedriveFundingBoard() {
  const structure = await getPipedriveStructure();
  const targets = [
    { output: 'Angebot veröffentlicht', aliases: ['Angebot veröffentlicht', 'Angebot gesendet'] },
    { output: 'Antrag eingereicht / Förderunterlagen einreichen', aliases: ['Antrag eingereicht / Förderunterlagen einreichen', 'Auftrag eingereicht / Förderunterlagen einreichen'] },
    { output: 'Förderung beantragt', aliases: ['Förderung beantragen', 'Förderung beantragt'] },
  ];
  const pipeline = structure.pipelines.find(item => Number(item.id) === Number(PIPEDRIVE_LAYOUT.pipelines.orderFeasibility.id));
  if (!pipeline) throw new Error('Die Pipedrive-Pipeline Auftragsmachbarkeit ist nicht verfügbar.');
  const stages = {};
  for (const target of targets) {
    const matches = structure.stages.filter(stage => Number(stage.pipeline_id ?? stage.pipelineId) === Number(pipeline.id)
      && target.aliases.some(alias => clean(alias).toLocaleLowerCase('de-DE') === clean(stage.name).toLocaleLowerCase('de-DE')));
    const deals = [];
    for (const stage of matches) {
      let cursor = '';
      do {
        const page = await listPipedriveDeals({ pipelineId: pipeline.id, stageId: stage.id, status: 'open', limit: 500, cursor });
        deals.push(...page.deals.map(deal => ({ id: String(deal.id), title: clean(deal.title, 1000), stage: target.output })));
        cursor = clean(page.additionalData?.next_cursor || page.additionalData?.pagination?.next_cursor, 500);
      } while (cursor);
    }
    stages[target.output] = [...new Map(deals.map(deal => [deal.id, deal])).values()];
  }
  return { pipeline: clean(pipeline.name), readOnly: true, source: 'iva-core-pipedrive-api', stages };
}

export async function downloadPipedriveDealFile({ dealId, fileId } = {}) {
  const id = clean(dealId, 40);
  const requestedFileId = clean(fileId, 40);
  if (!/^\d+$/.test(id) || !/^\d+$/.test(requestedFileId)) throw new Error('Ungültige Pipedrive-Deal- oder Datei-ID.');
  const bundle = await getPipedriveDealBundle(id);
  const file = bundle.files.find(item => String(item.id) === requestedFileId);
  if (!file) throw new Error('Die Pipedrive-Datei gehört nicht zu diesem Deal.');
  if (Number(file.file_size || file.size || 0) > MAX_FILE_BYTES) throw new Error('Die Pipedrive-Datei ist größer als 50 MB.');
  const credential = await validCredential();
  const url = new URL(`${safeApiDomain(credential.apiDomain)}/api/v1/files/${requestedFileId}/download`);
  if (credential.mode === 'api-token') url.searchParams.set('api_token', credential.apiToken);
  const response = await fetch(url, {
    headers: credential.mode === 'oauth' ? { Authorization: `Bearer ${credential.accessToken}` } : {},
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Pipedrive-Datei konnte nicht geladen werden (${response.status}).`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_FILE_BYTES) throw new Error('Die Pipedrive-Datei ist leer oder größer als 50 MB.');
  return { buffer, filename: clean(file.name || file.file_name || `pipedrive-${requestedFileId}`, 500), type: clean(response.headers.get('content-type') || file.file_type || file.mime_type || 'application/octet-stream', 200) };
}

export async function listPipedriveDealsByStageName(stageName) {
  const requested = clean(stageName, 300).toLocaleLowerCase('de-DE');
  if (!requested) throw new Error('Pipedrive-Phase fehlt.');
  const structure = await getPipedriveStructure();
  const aliasGroups = [
    ['montage terminieren', 'montage terminiert, rg+ab senden'],
    ['angebot veröffentlicht', 'angebot gesendet'],
    ['antrag eingereicht / förderunterlagen einreichen', 'auftrag eingereicht / förderunterlagen einreichen'],
    ['förderung beantragen', 'förderung beantragt'],
  ];
  const aliases = aliasGroups.find(group => group.includes(requested)) || [requested];
  const matches = structure.stages.filter(stage => aliases.includes(clean(stage.name).toLocaleLowerCase('de-DE')));
  if (matches.length !== 1) throw new Error(matches.length ? 'Pipedrive-Phase ist nicht eindeutig.' : 'Pipedrive-Phase wurde nicht gefunden.');
  const stage = matches[0];
  const deals = [];
  let cursor = '';
  do {
    const page = await listPipedriveDeals({ pipelineId: stage.pipeline_id ?? stage.pipelineId, stageId: stage.id, status: 'open', limit: 500, cursor });
    deals.push(...page.deals.map(deal => ({ id: String(deal.id), title: clean(deal.title, 1000), stage: clean(stage.name), stageId: Number(stage.id), pipelineId: Number(stage.pipeline_id ?? stage.pipelineId) })));
    cursor = clean(page.additionalData?.next_cursor || page.additionalData?.pagination?.next_cursor, 500);
  } while (cursor);
  return { stage: clean(stage.name), stageId: Number(stage.id), pipelineId: Number(stage.pipeline_id ?? stage.pipelineId), count: deals.length, deals, readOnly: true, source: 'iva-core-pipedrive-api' };
}

export async function updatePipedriveDealFieldsByName({ dealId, updates, confirmation } = {}) {
  assertConfirmedWrite(confirmation);
  const id = clean(dealId, 40);
  if (!/^\d+$/.test(id)) throw new Error('Ungültige Pipedrive-Deal-ID.');
  const allowed = new Set(['Auftragsnummer', 'Kundennummer', 'Telefonnummer', 'E-Mail', 'Anlage']);
  const requested = (Array.isArray(updates) ? updates : []).map(item => ({ field: clean(item?.field, 100), value: clean(item?.value, 500) })).filter(item => allowed.has(item.field) && item.value);
  if (!requested.length || requested.length > allowed.size) throw new Error('Keine gültigen Pipedrive-Feldänderungen übergeben.');
  const structure = await getPipedriveStructure();
  const descriptors = requested.map(item => {
    const matches = structure.dealFields.filter(field => clean(field.name) === item.field);
    if (matches.length !== 1) throw new Error(`Pipedrive-Feld „${item.field}“ fehlt oder ist nicht eindeutig.`);
    return { ...item, descriptor: matches[0] };
  });
  const keys = descriptors.map(item => item.descriptor.key).join(',');
  const before = (await pipedriveRequest(`/api/v2/deals/${id}${queryString({ custom_fields: keys, include_option_labels: true })}`)).data || {};
  const changes = {};
  const results = [];
  for (const item of descriptors) {
    const current = before.custom_fields?.[item.descriptor.key] ?? before[item.descriptor.key] ?? null;
    if (current !== null && current !== undefined && String(current).trim() !== '') {
      results.push({ field: item.field, status: 'existing_value_present', mutated: false });
      continue;
    }
    let value = item.value;
    if (item.field === 'Anlage' && Array.isArray(item.descriptor.options)) {
      const options = item.descriptor.options.filter(option => clean(option.label).toLocaleLowerCase('de-DE') === item.value.toLocaleLowerCase('de-DE'));
      if (options.length !== 1) {
        results.push({ field: item.field, status: options.length ? 'ambiguous_select_option' : 'select_option_not_found', mutated: false });
        continue;
      }
      value = options[0].id;
    }
    changes[item.descriptor.key] = value;
    results.push({ field: item.field, status: 'prepared', mutated: false });
  }
  if (Object.keys(changes).length) await pipedriveRequest(`/api/v2/deals/${id}`, { method: 'PATCH', body: { custom_fields: changes }, write: true });
  const after = (await pipedriveRequest(`/api/v2/deals/${id}${queryString({ custom_fields: keys, include_option_labels: true })}`)).data || {};
  for (const result of results.filter(item => item.status === 'prepared')) {
    const item = descriptors.find(candidate => candidate.field === result.field);
    const expected = changes[item.descriptor.key];
    const actual = after.custom_fields?.[item.descriptor.key] ?? after[item.descriptor.key] ?? null;
    result.status = sameFieldValue(actual, expected) ? 'updated_and_verified' : 'update_not_verified';
    result.mutated = actual !== null && actual !== undefined && String(actual).trim() !== '';
    result.verified = sameFieldValue(actual, expected);
  }
  return { dealId: id, results, mutated: results.some(item => item.mutated), fullyVerified: results.filter(item => item.status !== 'existing_value_present').every(item => item.verified === true), source: 'iva-core-pipedrive-api' };
}

export async function transitionPipedriveFundingStageApi({ dealId, fromStage, toStage, confirmation } = {}) {
  assertConfirmedWrite(confirmation);
  const allowed = [
    { from: ['Angebot veröffentlicht', 'Angebot gesendet'], to: ['Antrag eingereicht / Förderunterlagen einreichen', 'Auftrag eingereicht / Förderunterlagen einreichen'] },
    { from: ['Antrag eingereicht / Förderunterlagen einreichen', 'Auftrag eingereicht / Förderunterlagen einreichen'], to: ['Förderung beantragen', 'Förderung beantragt'] },
  ];
  const normalize = value => clean(value, 300).toLocaleLowerCase('de-DE');
  const rule = allowed.find(item => item.from.some(value => normalize(value) === normalize(fromStage)) && item.to.some(value => normalize(value) === normalize(toStage)));
  if (!rule) throw new Error('Nicht freigegebener Pipedrive-Förderphasenwechsel.');
  const structure = await getPipedriveStructure();
  const fromMatches = structure.stages.filter(stage => rule.from.some(value => normalize(value) === normalize(stage.name)));
  const toMatches = structure.stages.filter(stage => rule.to.some(value => normalize(value) === normalize(stage.name)));
  if (fromMatches.length !== 1 || toMatches.length !== 1) throw new Error('Pipedrive-Förderphase fehlt oder ist nicht eindeutig.');
  return { dealId: String(dealId), ...(await updatePipedriveDealStage({ dealId, expectedStageId: fromMatches[0].id, targetStageId: toMatches[0].id, confirmation })), source: 'iva-core-pipedrive-api' };
}

export async function markPipedriveFundingDealWonApi({ dealId, approvalFileName, confirmation } = {}) {
  assertConfirmedWrite(confirmation);
  const id = clean(dealId, 40);
  const fileName = path.basename(clean(approvalFileName, 500));
  if (!/^\d+$/.test(id) || !/\.pdf$/i.test(fileName) || !/(?:kfw.{0,40}zusage|zusage.{0,40}kfw|zuschuss.{0,20}(?:zusage|bescheid))/i.test(fileName)) {
    throw new Error('„Gewonnen“ ist nur mit gültiger Deal-ID und eindeutig bezeichnetem KfW-Zusageschreiben als PDF zulässig.');
  }
  const before = await getPipedriveFundingSnapshot(id);
  if (!['förderung beantragen', 'förderung beantragt'].includes(clean(before.stage).toLocaleLowerCase('de-DE'))) throw new Error(`Deal ${id} steht nicht eindeutig in „Förderung beantragt“.`);
  if (before.files.filter(name => path.basename(name) === fileName).length !== 1) throw new Error(`Das KfW-Zusageschreiben „${fileName}“ ist im Deal nicht genau einmal vorhanden.`);
  const current = (await pipedriveRequest(`/api/v2/deals/${id}`)).data || {};
  const alreadyPresent = clean(current.status).toLowerCase() === 'won';
  if (!alreadyPresent) await pipedriveRequest(`/api/v2/deals/${id}`, { method: 'PATCH', body: { status: 'won' }, write: true });
  let after = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 1500));
    after = (await pipedriveRequest(`/api/v2/deals/${id}`)).data || {};
    if (clean(after.status).toLowerCase() === 'won') break;
  }
  if (clean(after?.status).toLowerCase() !== 'won') throw new Error('Pipedrive-Status „Gewonnen“ wurde nicht bestätigt.');
  return { dealId: id, changed: !alreadyPresent, alreadyPresent, verified: true, status: after.status, stageId: String(after.stage_id || ''), mutated: !alreadyPresent, deletedFromPipedrive: false, source: 'iva-core-pipedrive-api' };
}

export async function uploadPipedriveDealFile({ dealId, filename, buffer } = {}) {
  const id = clean(dealId, 40);
  const safeFilename = path.basename(clean(filename, 500));
  if (!/^\d+$/.test(id) || !safeFilename || !Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_FILE_BYTES) throw new Error('Ungültiger Pipedrive-Dateiupload.');
  const before = await getPipedriveDealBundle(id);
  if (before.files.some(file => clean(file.name || file.file_name) === safeFilename)) return { dealId: id, fileName: safeFilename, uploaded: false, alreadyPresent: true, verified: true };
  const credential = await validCredential();
  if (!config().writeEnabled) throw new Error('Pipedrive-Schreibzugriff ist noch nicht freigeschaltet.');
  const url = new URL(`${safeApiDomain(credential.apiDomain)}/api/v1/files`);
  if (credential.mode === 'api-token') url.searchParams.set('api_token', credential.apiToken);
  const form = new FormData();
  form.set('deal_id', id);
  form.set('file', new Blob([buffer]), safeFilename);
  const response = await fetch(url, { method: 'POST', headers: credential.mode === 'oauth' ? { Authorization: `Bearer ${credential.accessToken}` } : {}, body: form, signal: AbortSignal.timeout(60_000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) throw new Error(safeError(payload, response));
  const after = await getPipedriveDealBundle(id);
  const matches = after.files.filter(file => clean(file.name || file.file_name) === safeFilename);
  if (matches.length !== 1) throw new Error('Pipedrive-Dateiupload wurde nicht eindeutig bestätigt.');
  return { dealId: id, fileName: safeFilename, fileId: String(matches[0].id || ''), uploaded: true, alreadyPresent: false, verified: true };
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
