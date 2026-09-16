import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateFundingIntakeReceipt, withFundingFileLock } from '../local-mac-helper/funding-intake-state.mjs';

export const MICROSOFT_FUNDING_LOGIN = 'n.sell@heat-hero.com';
export const MICROSOFT_FUNDING_MAILBOX = 'foerderung@heat-hero.com';
export const MICROSOFT_FUNDING_SCOPES = Object.freeze(['offline_access', 'User.Read', 'Mail.ReadWrite.Shared']);
const GRAPH = 'https://graph.microsoft.com';
const USER_PATH = `/v1.0/users/${encodeURIComponent(MICROSOFT_FUNDING_MAILBOX)}`;
const BACKFILL_START = '2026-07-31T22:00:00.000Z';
const MAX_JSON = 12 * 1024 * 1024;
const MAX_ATTACHMENT = 50 * 1024 * 1024;
const MAX_ATTACHMENTS = 200;
const STATE_TTL = 10 * 60 * 1000;
// Filtered message deltas have a 5,000-message ceiling. Initialize the folder
// without a server-side filter and discard pre-August metadata locally. Later
// runs use the original deltaLink and do not repeat the mailbox history scan.
const DELTA_QUERY_MODE = 'unfiltered-inbox-metadata';
const BASIC_FIELDS = 'id,internetMessageId,parentFolderId,receivedDateTime,sentDateTime,subject,from,toRecipients,ccRecipients,hasAttachments';
const DETAIL_FIELDS = `${BASIC_FIELDS},body`;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code: `MICROSOFT_FUNDING_${code}`, source: 'microsoft-graph', complete: false, coverageVerified: false, ...extra });
const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 1200 && /^[A-Za-z0-9_+=/-]+$/.test(value);
const rfcId = value => typeof value === 'string' && /^<[^\s<>]{1,500}@[^\s<>]{1,250}>$/.test(value);
const addresses = value => [...new Set((value || []).map(x => String(x?.emailAddress?.address || '').toLowerCase()).filter(Boolean))].sort();
const normalizedText = value => String(value ?? '').replace(/\r\n/g, '\n').trim();
const folderName = value => ['Posteingang', 'Fertig'].includes(value);

/** Shared mailbox only. No send, delete, draft, arbitrary account or Graph proxy API. */
export function createMicrosoftFundingMail({ env = process.env, fetch: fetchImpl = globalThis.fetch, now = Date.now, dataDir = env.DATA_DIR || '/data' } = {}) {
  const root = path.resolve(dataDir);
  const file = kind => path.join(root, `microsoft-funding-${kind}.enc.json`);
  const stamp = () => new Date(now()).toISOString();
  function config() {
    const value = {
      tenantId: String(env.MICROSOFT_FUNDING_TENANT_ID || '').trim(),
      clientId: String(env.MICROSOFT_FUNDING_CLIENT_ID || '').trim(),
      clientSecret: String(env.MICROSOFT_FUNDING_CLIENT_SECRET || ''),
      redirectUri: String(env.MICROSOFT_FUNDING_REDIRECT_URI || '').trim(),
      tokenKey: String(env.MICROSOFT_FUNDING_TOKEN_KEY || ''),
    };
    const missing = Object.entries(value).filter(([, entry]) => !entry).map(([name]) => ({ tenantId: 'MICROSOFT_FUNDING_TENANT_ID', clientId: 'MICROSOFT_FUNDING_CLIENT_ID', clientSecret: 'MICROSOFT_FUNDING_CLIENT_SECRET', redirectUri: 'MICROSOFT_FUNDING_REDIRECT_URI', tokenKey: 'MICROSOFT_FUNDING_TOKEN_KEY' })[name]);
    let redirect;
    try { redirect = new URL(value.redirectUri); } catch {}
    const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const valid = guid.test(value.tenantId) && guid.test(value.clientId) && value.clientSecret.length > 0 && value.tokenKey.length >= 32
      && redirect?.protocol === 'https:' && !redirect.username && !redirect.password && !redirect.search && !redirect.hash
      && !redirect.port && redirect.pathname === '/oauth/microsoft-funding/callback';
    return { ...value, missing, valid, binding: sha(JSON.stringify([value.tenantId.toLowerCase(), value.clientId.toLowerCase(), value.redirectUri, MICROSOFT_FUNDING_LOGIN, MICROSOFT_FUNDING_MAILBOX])) };
  }
  function requireConfig() {
    const value = config();
    if (value.missing.length || !value.valid) throw fail('CONFIG_REQUIRED', 'Die eigene Microsoft-App für das Förderpostfach ist noch nicht vollständig und gültig eingerichtet.');
    return value;
  }
  function encrypt(value) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(requireConfig().tokenKey).digest(), iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return { version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') };
  }
  function decrypt(value) {
    try {
      if (value?.version !== 1 || value.algorithm !== 'aes-256-gcm') throw Error();
      const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(requireConfig().tokenKey).digest(), Buffer.from(value.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    } catch { throw fail('STORE_INVALID', 'Der verschlüsselte Microsoft-Verbindungsstand ist nicht lesbar.'); }
  }
  async function load(kind, fallback) {
    try {
      const stat = await fs.lstat(file(kind));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 30 * 1024 * 1024) throw Error();
      return decrypt(JSON.parse(await fs.readFile(file(kind), 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      if (String(error.code || '').startsWith('MICROSOFT_FUNDING_')) throw error;
      throw fail('STORE_INVALID', 'Der gespeicherte Microsoft-Verbindungsstand ist ungültig.');
    }
  }
  async function save(kind, value) {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = `${file(kind)}.${crypto.randomUUID()}.tmp`, body = JSON.stringify(encrypt(value));
    if (Buffer.byteLength(body) > 30 * 1024 * 1024) throw fail('STORE_LIMIT', 'Der Förderpostfach-Stand muss vor der Fortsetzung geprüft werden.');
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, file(kind));
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  const locked = (kind, action) => withFundingFileLock(file(kind), action, { timeoutMs: 5000 });
  async function bytes(response, maximum) {
    if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel().catch(() => {}); throw fail('RESPONSE_LIMIT', 'Die Postfachantwort überschreitet die zulässige Größe.'); }
    const chunks = []; let size = 0;
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > maximum) { await reader.cancel(); throw fail('RESPONSE_LIMIT', 'Die Postfachantwort überschreitet die zulässige Größe.'); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks);
  }
  async function request(url, { method = 'GET', headers = {}, body, binary = false, maxBytes = MAX_JSON } = {}) {
    let response;
    try { response = await fetchImpl(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw fail('NETWORK', 'Microsoft ist nicht zuverlässig erreichbar; der offene Schritt bleibt erhalten.', { writeAttempted: method === 'POST' }); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const code = response.status === 401 || response.status === 403 ? 'ACCESS_REQUIRED' : response.status === 404 ? 'NOT_FOUND' : response.status === 410 ? 'CURSOR_EXPIRED' : response.status === 429 ? 'THROTTLED' : 'HTTP';
      const retryAfter = Number(response.headers.get('retry-after'));
      throw fail(code, code === 'ACCESS_REQUIRED' ? 'Die Microsoft-Freigabe fehlt, ist abgelaufen oder reicht für das Förderpostfach nicht aus.' : 'Microsoft hat den Postfachschritt nicht bestätigt; der gespeicherte Stand bleibt erhalten.', { httpStatus: response.status, writeAttempted: method === 'POST', definitivelyRejected: [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(response.status), retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 3600) : response.status === 429 ? 60 : 0 });
    }
    let raw;
    try { raw = await bytes(response, maxBytes); }
    catch (error) { if (String(error.code || '').startsWith('MICROSOFT_FUNDING_')) throw error; throw fail('RESPONSE_INCOMPLETE', 'Microsoft hat keine vollständige Postfachantwort geliefert.', { writeAttempted: method === 'POST' }); }
    if (binary) return raw;
    try { return JSON.parse(raw.toString('utf8')); }
    catch { throw fail('RESPONSE_INVALID', 'Microsoft hat keinen prüfbaren Postfachstand geliefert.', { writeAttempted: method === 'POST' }); }
  }
  function validateScope(value) {
    const scopes = String(value || '').split(/\s+/).map(x => x.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase());
    if (!scopes.includes('mail.readwrite.shared') || !scopes.includes('user.read') || scopes.some(x => /^mail\.send(?:\.|$)/.test(x)))
      throw fail('SCOPE_REQUIRED', 'Die Microsoft-Freigabe muss User.Read und Mail.ReadWrite.Shared ohne Versandrecht enthalten.');
  }
  function validateToken(token) {
    if (!token?.refreshToken || token.binding !== requireConfig().binding || token.connectedAccount !== MICROSOFT_FUNDING_LOGIN || token.mailbox !== MICROSOFT_FUNDING_MAILBOX || !token.actorId)
      throw fail('CONSENT_REQUIRED', 'Das Förderpostfach muss einmal über Nadines Microsoft-Konto freigegeben werden.');
  }
  async function exchange(parameters) {
    const current = requireConfig();
    const payload = await request(`https://login.microsoftonline.com/${current.tenantId}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: current.clientId, client_secret: current.clientSecret, scope: MICROSOFT_FUNDING_SCOPES.join(' '), ...parameters }).toString(),
    });
    if (!payload.access_token || payload.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(Number(payload.expires_in)) || Number(payload.expires_in) <= 60)
      throw fail('TOKEN_INVALID', 'Microsoft hat keinen verwendbaren Zugriff bestätigt.');
    validateScope(payload.scope);
    return payload;
  }
  async function graph(pathname, token, { method = 'GET', body, binary = false, maxBytes } = {}) {
    if (typeof pathname !== 'string' || (!pathname.startsWith(`${USER_PATH}/`) && pathname !== '/v1.0/me?$select=id,mail,userPrincipalName')) throw fail('SCOPE_DENIED', 'Dieser Zugriff liegt außerhalb des Förderpostfachs.');
    return request(`${GRAPH}${pathname}`, { method, headers: { Authorization: `Bearer ${token.accessToken}`, Accept: binary ? 'application/octet-stream' : 'application/json', Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), binary, maxBytes });
  }
  function collectionLink(link, expectedPath) {
    let url; try { url = new URL(link); } catch {}
    if (!url || url.origin !== GRAPH || url.username || url.password || url.hash || url.pathname !== expectedPath || url.href.length > 6000)
      throw fail('CONTINUATION_DENIED', 'Die Microsoft-Fortsetzung gehört nicht zum freigegebenen Postfachbereich.');
    return url.pathname + url.search;
  }
  async function collection(first, token, { maximum = 1000, maxPages = 30 } = {}) {
    const expected = new URL(first, GRAPH).pathname, seenLinks = new Set(), rows = [];
    let next = first;
    for (let page = 0; next && page < maxPages; page++) {
      if (seenLinks.has(next)) throw fail('PAGINATION_INVALID', 'Die Microsoft-Seitenfolge wiederholt sich; kein vollständiger Stand bestätigt.');
      seenLinks.add(next);
      const result = await graph(next, token);
      if (!Array.isArray(result.value) || result.value.length > maximum || rows.length + result.value.length > maximum) throw fail('COLLECTION_LIMIT', 'Der Postfachbestand wurde nicht vollständig und begrenzt gelesen.');
      rows.push(...result.value);
      next = result['@odata.nextLink'] ? collectionLink(result['@odata.nextLink'], expected) : null;
    }
    if (next) throw fail('PAGINATION_LIMIT', 'Der Postfachbestand benötigt weitere Seiten und bleibt offen.');
    return rows;
  }
  async function probeAccess(token) {
    const actor = await graph('/v1.0/me?$select=id,mail,userPrincipalName', token);
    // A fixed principal, rather than an email alias in a message, authorizes the connection.
    if (!safeId(actor.id) || String(actor.userPrincipalName || '').toLowerCase() !== MICROSOFT_FUNDING_LOGIN || token.actorId && actor.id !== token.actorId)
      throw fail('LOGIN_MISMATCH', 'Bitte ausschließlich Nadines Microsoft-Konto n.sell@heat-hero.com verbinden.');
    const inbox = await graph(`${USER_PATH}/mailFolders/inbox?$select=id,displayName,parentFolderId`, token);
    if (!safeId(inbox.id)) throw fail('MAILBOX_UNVERIFIED', 'Der Posteingang des Förderpostfachs ist nicht bestätigt.');
    return { actorId: actor.id, inboxId: inbox.id, mailbox: MICROSOFT_FUNDING_MAILBOX, accountMatches: true, mailboxVerified: true, checkedAt: stamp() };
  }
  async function validToken({ probe = false } = {}) {
    requireConfig();
    return locked('token', async () => {
      let token = await load('token', null); validateToken(token);
      if (!token.accessToken || Number(token.expiresAt) <= now() + 60_000) {
        const payload = await exchange({ grant_type: 'refresh_token', refresh_token: token.refreshToken });
        token = { ...token, accessToken: payload.access_token, refreshToken: payload.refresh_token || token.refreshToken, scope: payload.scope, expiresAt: now() + Number(payload.expires_in) * 1000, refreshedAt: stamp(), lastProbe: null };
        // Persist a rotated refresh token before a potentially failing mailbox probe.
        await save('token', token);
      }
      if (probe || !token.lastProbe?.mailboxVerified) {
        try { token.lastProbe = await probeAccess(token); }
        catch (error) { await save('token', { ...token, lastProbe: null }); throw error; }
        await save('token', token);
      }
      return token;
    });
  }
  function scope(input = {}, { inboxOnly = false } = {}) {
    if (input.from !== undefined && String(input.from).toLowerCase() !== MICROSOFT_FUNDING_MAILBOX || !folderName(input.folder || 'Posteingang') || inboxOnly && (input.folder || 'Posteingang') !== 'Posteingang')
      throw fail('SCOPE_DENIED', 'Dieser Mailzugriff gilt ausschließlich für Posteingang und Fertig des Förderpostfachs.');
    if (input.messageId !== undefined && !rfcId(input.messageId)) throw fail('MESSAGE_ID_REQUIRED', 'Eine echte und eindeutige RFC-Nachrichten-ID ist erforderlich.');
  }
  async function folders(token, { requireDone = false } = {}) {
    const inbox = await graph(`${USER_PATH}/mailFolders/inbox?$select=id,parentFolderId`, token);
    if (!safeId(inbox.id) || inbox.id !== token.lastProbe.inboxId) throw fail('MAILBOX_CHANGED', 'Die Kennung des Förderposteingangs hat sich geändert; die Verbindung muss erneut geprüft werden.');
    if (!requireDone) return { inboxId: inbox.id, doneId: null };
    const rows = await collection(`${USER_PATH}/mailFolders/${encodeURIComponent(inbox.id)}/childFolders?$select=id,displayName,parentFolderId&$top=100`, token);
    const matches = rows.filter(x => String(x.displayName || '').normalize('NFC').toLowerCase() === 'fertig');
    if (matches.length !== 1 || !safeId(matches[0].id) || matches[0].parentFolderId !== inbox.id)
      throw fail('DONE_FOLDER_REQUIRED', 'Im Förderposteingang muss genau ein Unterordner Fertig vorhanden sein. Bitte diesen einmal anlegen beziehungsweise prüfen.');
    return { inboxId: inbox.id, doneId: matches[0].id };
  }
  function messageRow(row) {
    if (!safeId(row?.id) || !rfcId(row.internetMessageId) || !safeId(row.parentFolderId) || !Number.isFinite(Date.parse(row.receivedDateTime)))
      throw fail('MESSAGE_INVALID', 'Eine Mail besitzt keine vollständig prüfbare Identität oder Empfangszeit.');
    const sender = addresses(row.from ? [row.from] : []), subject = normalizedText(row.subject);
    const receivedAt = new Date(row.receivedDateTime).toISOString();
    return { messageId: row.internetMessageId, immutableId: row.id, receivedAt, sentAt: row.sentDateTime || null, sender, recipients: addresses(row.toRecipients), cc: addresses(row.ccRecipients), subject, hasAttachments: row.hasAttachments === true,
      description: `Absender: ${sender.join(', ')}, Betreff: ${subject.replace(/[\r\n\t]/g, ' ') || 'Kein Betreff'}, ${new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: '2-digit' }).format(new Date(receivedAt))}, ${row.hasAttachments ? 'Hat Dateien' : 'Keine Anlagen gemeldet'}`,
      parentFolderId: row.parentFolderId, identityVerified: true, source: 'microsoft-graph' };
  }
  async function remember(rows) {
    if (!rows.length) return;
    await locked('identities', async () => {
      const state = await load('identities', { version: 1, binding: requireConfig().binding, entries: {} });
      if (state.binding !== requireConfig().binding || !state.entries || state.version !== 1) throw fail('IDENTITY_STORE_CHANGED', 'Die gespeicherten Nachrichten gehören zu einer anderen Microsoft-Verbindung.');
      for (const row of rows) {
        const key = sha(row.messageId), previous = state.entries[key];
        if (previous && previous.immutableId !== row.immutableId) throw fail('DUPLICATE_MESSAGE_ID', 'Mehrere unterschiedliche Mails verwenden dieselbe RFC-Nachrichten-ID; keine automatische Verarbeitung.');
        state.entries[key] = { ...previous, messageId: row.messageId, immutableId: row.immutableId, observedAt: stamp() };
      }
      await save('identities', state);
    });
  }
  async function findMessage(messageId, token) {
    if (!rfcId(messageId)) throw fail('MESSAGE_ID_REQUIRED', 'Eine echte RFC-Nachrichten-ID fehlt.');
    const filter = encodeURIComponent(`internetMessageId eq '${messageId.replace(/'/g, "''")}'`);
    const matches = await collection(`${USER_PATH}/messages?$filter=${filter}&$select=${DETAIL_FIELDS}&$top=2`, token, { maximum: 2, maxPages: 2 });
    if (!matches.length) return null;
    if (matches.length !== 1 || matches[0].internetMessageId !== messageId) throw fail('DUPLICATE_MESSAGE_ID', 'Die Fördermail ist im Postfach nicht eindeutig identifiziert.');
    const normalized = messageRow(matches[0]); await remember([normalized]);
    return { row: matches[0], normalized };
  }
  async function attachments(id, token) {
    const rows = await collection(`${USER_PATH}/messages/${encodeURIComponent(id)}/attachments?$select=id,name,size,contentType,isInline,lastModifiedDateTime&$top=100`, token, { maximum: MAX_ATTACHMENTS });
    const seen = new Set();
    return rows.map(row => {
      if (!safeId(row.id) || seen.has(row.id) || !Number.isSafeInteger(row.size) || row.size < 0 || row.size > MAX_ATTACHMENT * 2 || !Number.isFinite(Date.parse(row.lastModifiedDateTime))) throw fail('ATTACHMENT_INVALID', 'Eine Anlage ist nicht eindeutig oder überschreitet die zulässige Größe.');
      seen.add(row.id);
      const type = String(row['@odata.type'] || '');
      return { attachmentId: row.id, name: String(row.name || 'Anhang'), size: row.size, contentType: String(row.contentType || 'application/octet-stream'), isInline: row.isInline === true, lastModifiedDateTime: new Date(row.lastModifiedDateTime).toISOString(),
        type, supported: type === '#microsoft.graph.fileAttachment' };
    });
  }
  function contentFingerprint(message) {
    return sha(JSON.stringify({ messageId: message.messageId, immutableId: message.immutableId, sender: message.sender, recipients: message.recipients, cc: message.cc, subject: message.subject, body: message.body, bodyType: message.bodyType,
      attachments: message.attachments.map(({ attachmentId, name, size, contentType, type, lastModifiedDateTime }) => ({ attachmentId, name, size, contentType, type, lastModifiedDateTime })).sort((a, b) => a.attachmentId.localeCompare(b.attachmentId)) }));
  }
  async function detail(input, token, { markRead = false } = {}) {
    scope(input);
    const located = await findMessage(input.messageId, token);
    if (!located) return { notFound: true, messageId: input.messageId, searchComplete: true, source: 'microsoft-graph' };
    const folder = input.folder || 'Posteingang', known = await folders(token, { requireDone: folder === 'Fertig' });
    if (located.normalized.parentFolderId !== (folder === 'Fertig' ? known.doneId : known.inboxId)) return { notFound: true, messageId: input.messageId, searchComplete: true, source: 'microsoft-graph' };
    if (!located.row.body || !['text', 'html'].includes(String(located.row.body.contentType).toLowerCase()) || typeof located.row.body.content !== 'string') throw fail('BODY_INCOMPLETE', 'Der vollständige Text der Fördermail ist noch nicht belegt.');
    const result = { ...located.normalized, folder, account: MICROSOFT_FUNDING_MAILBOX, body: normalizedText(located.row.body.content), bodyType: String(located.row.body.contentType).toLowerCase() === 'text' ? 'text/plain' : 'text/html', attachments: await attachments(located.row.id, token), sourceReadComplete: true, attachmentsComplete: true };
    result.hasAttachments = result.attachments.length > 0;
    result.sourceHash = contentFingerprint(result);
    if (markRead) await locked('identities', async () => {
      const state = await load('identities', null), entry = state?.entries?.[sha(input.messageId)];
      if (!entry || entry.immutableId !== result.immutableId) throw fail('IDENTITY_STORE_CHANGED', 'Der Nachrichtenbeleg hat sich verändert.');
      Object.assign(entry, { sourceHash: result.sourceHash, sourceReadAt: stamp(), attachmentIds: result.attachments.map(x => x.attachmentId) });
      await save('identities', state);
    });
    return result;
  }
  async function createAuthUrl() {
    const current = requireConfig(), value = crypto.randomBytes(32).toString('base64url'), verifier = crypto.randomBytes(48).toString('base64url');
    await locked('states', async () => {
      const states = await load('states', []);
      if (!Array.isArray(states)) throw fail('STORE_INVALID', 'Der Microsoft-Freigabestand ist ungültig.');
      await save('states', [...states.filter(x => x.expiresAt > now()).slice(-19), { value, verifier, binding: current.binding, expiresAt: now() + STATE_TTL }]);
    });
    return `https://login.microsoftonline.com/${current.tenantId}/oauth2/v2.0/authorize?` + new URLSearchParams({ client_id: current.clientId, redirect_uri: current.redirectUri, response_type: 'code', response_mode: 'query', scope: MICROSOFT_FUNDING_SCOPES.join(' '), state: value, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', login_hint: MICROSOFT_FUNDING_LOGIN, prompt: 'select_account' });
  }
  async function completeOAuth({ code, state } = {}) {
    if (typeof code !== 'string' || !code || code.length > 8000 || typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) throw fail('OAUTH_STATE', 'Die Microsoft-Freigabe ist ungültig oder abgelaufen.');
    const current = requireConfig();
    const pending = await locked('states', async () => {
      const states = await load('states', []);
      if (!Array.isArray(states)) throw fail('STORE_INVALID', 'Der Microsoft-Freigabestand ist ungültig.');
      const found = states.find(x => x.value === state && x.expiresAt > now() && x.binding === current.binding);
      await save('states', states.filter(x => x.value !== state && x.expiresAt > now()));
      if (!found) throw fail('OAUTH_STATE', 'Die Microsoft-Freigabe ist abgelaufen oder wurde bereits verwendet.');
      return found;
    });
    const payload = await exchange({ grant_type: 'authorization_code', code, redirect_uri: current.redirectUri, code_verifier: pending.verifier });
    if (!payload.refresh_token) throw fail('OFFLINE_REQUIRED', 'Microsoft hat keinen dauerhaften Zugriff erteilt. Bitte die Kontofreigabe erneut durchführen.');
    const candidate = { accessToken: payload.access_token, refreshToken: payload.refresh_token, expiresAt: now() + Number(payload.expires_in) * 1000, scope: payload.scope, connectedAccount: MICROSOFT_FUNDING_LOGIN, mailbox: MICROSOFT_FUNDING_MAILBOX, binding: current.binding, connectedAt: stamp() };
    const proof = await probeAccess(candidate); candidate.actorId = proof.actorId; candidate.lastProbe = proof;
    await locked('token', () => save('token', candidate));
    return { connected: true, account: MICROSOFT_FUNDING_LOGIN, mailbox: MICROSOFT_FUNDING_MAILBOX, probe: proof, sendsMail: false };
  }
  async function status({ probe = false } = {}) {
    const current = config();
    const base = { provider: 'microsoft-graph', account: MICROSOFT_FUNDING_LOGIN, mailbox: MICROSOFT_FUNDING_MAILBOX, scopes: [...MICROSOFT_FUNDING_SCOPES], sendsMail: false, requiresUnlockedScreen: false };
    if (current.missing.length || !current.valid) return { ...base, configured: false, authorized: false, ready: false, missing: current.missing.length ? current.missing : ['Gültige eigene Microsoft-App-Konfiguration'] };
    try {
      const stored = await load('token', null); validateToken(stored);
      const token = probe ? await validToken({ probe: true }) : stored;
      return { ...base, configured: true, authorized: true, ready: token.lastProbe?.mailboxVerified === true, missing: token.lastProbe?.mailboxVerified ? [] : ['Zugriff auf das Förderpostfach prüfen'], connectedAt: token.connectedAt, lastProbe: token.lastProbe || null };
    } catch (error) { return { ...base, configured: true, authorized: false, ready: false, missing: ['Microsoft-Freigabe für das Förderpostfach'], errorCode: String(error.code || 'MICROSOFT_FUNDING_UNAVAILABLE') }; }
  }
  function cursorValue(cursor, inboxId) {
    try {
      if (typeof cursor !== 'string' || cursor.length > 8000 || !/^msgraph:[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
      const result = decrypt(JSON.parse(Buffer.from(cursor.slice(8), 'base64url').toString('utf8')));
      if (result.version !== 3 || result.queryMode !== DELTA_QUERY_MODE || result.binding !== requireConfig().binding || result.mailbox !== MICROSOFT_FUNDING_MAILBOX || result.inboxId !== inboxId || !['page', 'checkpoint'].includes(result.kind) || result.since !== BACKFILL_START || !Number.isSafeInteger(result.roundRows) || result.roundRows < 0) throw Error();
      collectionLink(result.link, `${USER_PATH}/mailFolders/${encodeURIComponent(inboxId)}/messages/delta`);
      return result;
    } catch { throw fail('CURSOR_INVALID', 'Der gespeicherte Cursor gehört nicht zum geprüften Microsoft-Förderpostfach. Vorhandenen Outlook-Lesestand gezielt migrieren.'); }
  }
  function makeCursor(value) {
    const result = 'msgraph:' + Buffer.from(JSON.stringify(encrypt({ version: 3, queryMode: DELTA_QUERY_MODE, binding: requireConfig().binding, mailbox: MICROSOFT_FUNDING_MAILBOX, since: BACKFILL_START, ...value }))).toString('base64url');
    if (result.length > 8000) throw fail('CURSOR_LIMIT', 'Die Postfachfortsetzung überschreitet die zulässige Größe.');
    return result;
  }
  async function readPage(input = {}) {
    scope(input, { inboxOnly: true });
    const { cursor, since, mode = 'incremental', limit = 100 } = input;
    if (!['initial-backfill', 'incremental'].includes(mode) || !Number.isInteger(limit) || limit < 1 || limit > 200) throw fail('BAD_RANGE', 'Ungültiger Modus oder Umfang des Förderpostfachlaufs.');
    if (since != null && since !== '2026-08-01' && since !== BACKFILL_START) throw fail('BAD_RANGE', 'Der einmalige Rücklauf beginnt am 1. August 2026; anschließend wird der gespeicherte Delta-Stand verwendet.');
    if (!cursor && (mode !== 'initial-backfill' || !since)) throw fail('INITIAL_BACKFILL_REQUIRED', 'Der direkte Förderpostfachzugriff benötigt zuerst den einmaligen Rücklauf ab 1. August 2026.');
    const token = await validToken(), { inboxId } = await folders(token), saved = cursor ? cursorValue(cursor, inboxId) : null;
    if (saved?.kind === 'checkpoint' && mode !== 'incremental') throw fail('CURSOR_INVALID', 'Ein abgeschlossener Delta-Stand wird nur inkrementell fortgesetzt.');
    const deltaPath = `${USER_PATH}/mailFolders/${encodeURIComponent(inboxId)}/messages/delta`;
    const requestPath = saved ? collectionLink(saved.link, deltaPath) : `${deltaPath}?$select=${BASIC_FIELDS}&$top=${limit}`;
    const response = await graph(requestPath, token);
    if (!Array.isArray(response.value) || response.value.length > 500 || Boolean(response['@odata.nextLink']) === Boolean(response['@odata.deltaLink'])) throw fail('PAGE_INCOMPLETE', 'Die Microsoft-Seite besitzt keinen eindeutigen Fortsetzungs- oder Abschlussnachweis.');
    const roundRows = (saved?.kind === 'page' ? saved.roundRows : 0) + response.value.length;
    if (!Number.isSafeInteger(roundRows)) throw fail('PAGE_INCOMPLETE', 'Die Anzahl der Postfachänderungen ist nicht eindeutig prüfbar.');
    const complete = Boolean(response['@odata.deltaLink']), link = response['@odata.deltaLink'] || response['@odata.nextLink'];
    collectionLink(link, deltaPath);
    if (saved?.kind === 'page' && link === saved.link) throw fail('PAGINATION_INVALID', 'Microsoft hat dieselbe offene Seite erneut geliefert.');
    const messages = [], removed = [], seen = new Set();
    for (const row of response.value) {
      if (!safeId(row?.id)) throw fail('MESSAGE_INVALID', 'Eine Delta-Änderung besitzt keine prüfbare Nachrichtenkennung.');
      if (row['@removed']) { removed.push(row.id); continue; }
      if (row.parentFolderId !== inboxId || !Number.isFinite(Date.parse(row.receivedDateTime))) throw fail('PAGE_SCOPE_MISMATCH', 'Eine Delta-Änderung besitzt keinen prüfbaren Empfangszeitpunkt oder gehört zu einem anderen Ordner.');
      // Older messages contribute only to metadata coverage. No RFC lookup,
      // body read, attachment request or persisted identity is needed for them.
      if (Date.parse(row.receivedDateTime) < Date.parse(BACKFILL_START)) continue;
      const normalized = messageRow(row);
      if (normalized.parentFolderId !== inboxId) throw fail('PAGE_SCOPE_MISMATCH', 'Die Delta-Seite enthält eine Nachricht außerhalb des Förderposteingangs.');
      if (seen.has(normalized.messageId)) throw fail('DUPLICATE_MESSAGE_ID', 'Eine Postfachseite enthält mehrfach dieselbe Nachrichten-ID.');
      seen.add(normalized.messageId); messages.push(normalized);
    }
    await remember(messages);
    const continuation = makeCursor({ kind: complete ? 'checkpoint' : 'page', inboxId, link, roundRows });
    return { messages, removedImmutableIds: removed, nextCursor: complete ? null : continuation, checkpoint: complete ? continuation : null, complete, coverageVerified: true, source: 'microsoft-graph',
      coverage: { since: BACKFILL_START, checkedAt: stamp(), scope: 'shared-mailbox-inbox-delta', queryMode: DELTA_QUERY_MODE, deletedEventsDoNotCompleteMessages: true, roundRows }, limitations: [] };
  }
  async function readMessage(input = {}) {
    scope(input); const result = await detail(input, await validToken(), { markRead: true });
    if (result.notFound) throw fail('MESSAGE_NOT_FOUND', 'Die angefragte Fördermail ist nicht im angegebenen Ordner vorhanden.');
    return result;
  }
  async function resolveIdentity(input = {}) {
    scope(input); const token = await validToken(), located = await findMessage(input.messageId, token);
    if (!located) return { notFound: true, messageId: input.messageId, searchComplete: true, source: 'microsoft-graph' };
    const folder = input.folder || 'Posteingang', known = await folders(token, { requireDone: folder === 'Fertig' });
    if (located.normalized.parentFolderId !== (folder === 'Fertig' ? known.doneId : known.inboxId)) return { notFound: true, messageId: input.messageId, searchComplete: true, source: 'microsoft-graph' };
    return { ...located.normalized, folder, account: MICROSOFT_FUNDING_MAILBOX };
  }
  async function downloadAttachment(input = {}) {
    scope(input);
    if (!safeId(input.attachmentId)) throw fail('ATTACHMENT_ID_REQUIRED', 'Die eindeutige Anlagenkennung fehlt.');
    const token = await validToken(), source = await detail(input, token, { markRead: true });
    if (source.notFound) throw fail('MESSAGE_NOT_FOUND', 'Die Originalmail fehlt im angegebenen Förderordner.');
    const attachment = source.attachments.find(x => x.attachmentId === input.attachmentId);
    if (!attachment || !attachment.supported) throw fail('ATTACHMENT_UNSUPPORTED', 'Diese Anlage kann nicht als gewöhnliche Datei vollständig übernommen werden; der Einzelfall bleibt offen.');
    const buffer = await graph(`${USER_PATH}/messages/${encodeURIComponent(source.immutableId)}/attachments/${encodeURIComponent(attachment.attachmentId)}/$value`, token, { binary: true, maxBytes: MAX_ATTACHMENT });
    if (!buffer.length) throw fail('ATTACHMENT_SIZE_MISMATCH', 'Der Anlagendownload ist leer.');
    if (buffer.length !== attachment.size) {
      // Exchange's attachment metadata can include storage overhead. In this
      // case compare the raw file with the API's explicit base64 file content.
      const value = await graph(`${USER_PATH}/messages/${encodeURIComponent(source.immutableId)}/attachments/${encodeURIComponent(attachment.attachmentId)}?$select=id,contentBytes`, token, { maxBytes: Math.ceil(MAX_ATTACHMENT / 3) * 4 + 64 * 1024 });
      if (value.id !== attachment.attachmentId || typeof value.contentBytes !== 'string' || value.contentBytes.length > Math.ceil(MAX_ATTACHMENT / 3) * 4 || value.contentBytes.length % 4 || /[^A-Za-z0-9+/=]/.test(value.contentBytes))
        throw fail('ATTACHMENT_SIZE_MISMATCH', 'Die unterschiedliche Anlagengröße konnte nicht anhand des vollständigen Dateiinhalts geklärt werden.');
      const comparison = Buffer.from(value.contentBytes, 'base64');
      if (comparison.length > MAX_ATTACHMENT || comparison.toString('base64') !== value.contentBytes || !buffer.equals(comparison)) throw fail('ATTACHMENT_SIZE_MISMATCH', 'Die zwei Dateiansichten von Microsoft enthalten unterschiedliche Bytes.');
    }
    // Re-read after download so a changed source cannot produce a false complete proof.
    const after = await detail(input, token);
    if (after.notFound || after.sourceHash !== source.sourceHash) throw fail('SOURCE_CHANGED', 'Die Originalmail hat sich während des Downloads verändert.');
    const filename = path.basename(attachment.name.replace(/\\/g, '/')).normalize('NFKC').replace(/[\u0000-\u001f\u007f/\\]/g, '-').replace(/^\.+/, '').trim().slice(0, 220) || 'Anhang';
    return { buffer, filename, originalName: attachment.name, contentType: attachment.contentType, size: buffer.length, reportedSize: attachment.size, sha256: sha(buffer), attachmentId: attachment.attachmentId, messageId: source.messageId, immutableId: source.immutableId, sourceHash: source.sourceHash, verified: true, messageMutated: false };
  }
  async function moveMessage(input = {}) {
    scope(input, { inboxOnly: true });
    if (input.destinationFolder !== 'Fertig') throw fail('DESTINATION_DENIED', 'Bearbeitete Fördermails dürfen ausschließlich nach Posteingang/Fertig verschoben werden.');
    let receipt;
    try { receipt = validateFundingIntakeReceipt(input.receipt); }
    catch { throw fail('RECEIPT_REQUIRED', 'Vor der Mailverschiebung fehlt der vollständige, verifizierte Pipedrive-Ablagebeleg.'); }
    if (receipt.messageId !== input.messageId) throw fail('RECEIPT_MISMATCH', 'Der Pipedrive-Beleg gehört zu einer anderen Fördermail.');
    if (input.receipt?.source !== 'microsoft-graph' || !/^[a-f0-9]{64}$/.test(input.receipt?.sourceHash || '')) throw fail('SOURCE_RECEIPT_REQUIRED', 'Der Pipedrive-Ablagebeleg muss den vollständig gelesenen Microsoft-Quellstand enthalten.');
    receipt = { ...receipt, source: 'microsoft-graph', sourceHash: input.receipt.sourceHash };
    const key = sha(input.messageId);
    return locked('moves', async () => {
      const token = await validToken(), known = await folders(token, { requireDone: true });
      const ledger = await load('moves', { version: 1, binding: requireConfig().binding, entries: {} });
      if (ledger.binding !== requireConfig().binding || ledger.version !== 1 || !ledger.entries) throw fail('MOVE_STORE_INVALID', 'Der gespeicherte Verschiebestand gehört zu einer anderen Verbindung.');
      let record = ledger.entries[key];
      if (record && record.dealId !== receipt.dealId) throw fail('RECEIPT_MISMATCH', 'Die begonnene Mailablage gehört zu einem anderen Deal.');
      if (record && (record.sourceHash !== receipt.sourceHash || record.receiptHash !== sha(JSON.stringify(receipt)))) throw fail('RECEIPT_CHANGED', 'Der gespeicherte Verschiebeauftrag besitzt andere Quelldaten oder Ablagebelege.');
      const located = await findMessage(input.messageId, token);
      if (!located) throw fail('MOVE_UNCERTAIN', 'Die Originalmail ist nicht eindeutig auffindbar; die offene Verschiebung muss geprüft werden.');
      if (record && (record.immutableId !== located.normalized.immutableId || record.doneId !== known.doneId)) throw fail('MOVE_IDENTITY_CHANGED', 'Die Identität der begonnenen Verschiebung hat sich geändert.');
      if (located.normalized.parentFolderId === known.doneId) {
        if (!record?.attemptedAt) throw fail('MOVE_PROOF_REQUIRED', 'Die Mail liegt bereits in Fertig, aber es fehlt ein eigener bestätigter Verschiebeauftrag.');
        const current = await detail({ messageId: input.messageId, folder: 'Fertig' }, token);
        if (current.notFound || current.sourceHash !== receipt.sourceHash) throw fail('SOURCE_CHANGED', 'Die in Fertig liegende Mail entspricht nicht mehr dem verarbeiteten Quellstand.');
        record.status = 'completed'; record.completedAt ||= stamp(); await save('moves', ledger);
        return { status: 'already_completed', moved: false, verified: true, verifiedInDestination: true, messageId: input.messageId, immutableId: record.immutableId, destinationFolder: 'Fertig', completedAt: record.completedAt };
      }
      if (record?.status === 'completed') throw fail('SOURCE_CHANGED', 'Eine bereits abgeschlossene Mail liegt wieder außerhalb von Fertig. Keine erneute automatische Verschiebung.');
      if (located.normalized.parentFolderId !== known.inboxId) throw fail('MOVE_SOURCE_DENIED', 'Die Mail liegt nicht mehr im Förderposteingang.');
      if (input.reconcileOnly === true) throw fail('MOVE_RECONCILE_ONLY', 'Die vorhandene Ablage ist noch nicht in Fertig bestätigt. Diese Rückleseprüfung startet keine neue Verschiebung.');
      const readState = await load('identities', null), observed = readState?.entries?.[key];
      const source = await detail({ messageId: input.messageId, folder: 'Posteingang' }, token);
      if (!observed?.sourceReadAt || observed.sourceHash !== source.sourceHash || receipt.sourceHash !== source.sourceHash || receipt.expectedAttachmentCount !== source.attachments.length)
        throw fail('SOURCE_READ_REQUIRED', 'Die aktuelle Originalmail und ihre vollständige Anlagenzahl müssen vor der Verschiebung gelesen und abgeglichen werden.');
      if (source.attachments.some(x => !x.supported)) throw fail('ATTACHMENT_UNSUPPORTED', 'Mindestens eine Anlage ist noch nicht vollständig unterstützt; die Mail bleibt im Posteingang.');
      if (record && record.sourceHash !== source.sourceHash) throw fail('RECEIPT_CHANGED', 'Der offene Verschiebeauftrag besitzt andere Quelldaten.');
      if (!record) {
        record = { messageId: input.messageId, immutableId: source.immutableId, dealId: receipt.dealId, doneId: known.doneId, sourceHash: source.sourceHash, receiptHash: sha(JSON.stringify(receipt)), status: 'prepared', preparedAt: stamp() };
        ledger.entries[key] = record; await save('moves', ledger);
      }
      // Once a POST was attempted, an uncertain response must never trigger another POST.
      if (record.attemptedAt) throw fail('MOVE_UNCERTAIN', 'Der Verschiebeversuch ist noch nicht eindeutig bestätigt. Quelle und Ziel werden erneut geprüft; keine blinde Wiederholung.');
      if (record.retryNotBefore && now() < record.retryNotBefore) throw fail('THROTTLED', 'Microsoft verlangt vor der erneuten Verschiebung noch eine kurze Wartezeit.');
      record.attemptedAt = stamp(); record.status = 'attempted'; await save('moves', ledger);
      let response;
      try { response = await graph(`${USER_PATH}/messages/${encodeURIComponent(record.immutableId)}/move`, token, { method: 'POST', body: { destinationId: known.doneId } }); }
      catch (error) {
        record.lastError = String(error.code || 'MICROSOFT_FUNDING_MOVE_UNCERTAIN');
        if (error.definitivelyRejected) { record.lastRejectedAt = record.attemptedAt; delete record.attemptedAt; record.status = 'rejected'; record.retryNotBefore = now() + Number(error.retryAfterSeconds || 0) * 1000; }
        await save('moves', ledger); throw error;
      }
      if (response?.id !== record.immutableId || response.internetMessageId !== input.messageId || response.parentFolderId !== known.doneId) throw fail('MOVE_RESPONSE_UNVERIFIED', 'Microsoft hat keine passende verschobene Originalmail bestätigt; zuerst den Zielstand rücklesen.');
      const verified = await findMessage(input.messageId, token);
      if (!verified || verified.normalized.immutableId !== record.immutableId || verified.normalized.parentFolderId !== known.doneId) throw fail('MOVE_UNCERTAIN', 'Die Fördermail wurde noch nicht eindeutig in Fertig rückgelesen.');
      record.status = 'completed'; record.completedAt = stamp(); await save('moves', ledger);
      return { status: 'completed', moved: true, verified: true, verifiedInDestination: true, messageId: input.messageId, immutableId: record.immutableId, destinationFolder: 'Fertig', completedAt: record.completedAt };
    });
  }
  return { createAuthUrl, completeOAuth, status, readPage, readMessage, downloadAttachment, resolveIdentity, moveMessage };
}

const service = createMicrosoftFundingMail();
export const createMicrosoftFundingAuthUrl = (...args) => service.createAuthUrl(...args);
export const completeMicrosoftFundingOAuth = (...args) => service.completeOAuth(...args);
export const microsoftFundingMailStatus = (...args) => service.status(...args);
export const readMicrosoftFundingPage = (...args) => service.readPage(...args);
export const readMicrosoftFundingMessage = (...args) => service.readMessage(...args);
export const downloadMicrosoftFundingAttachment = (...args) => service.downloadAttachment(...args);
export const resolveMicrosoftFundingIdentity = (...args) => service.resolveIdentity(...args);
export const moveMicrosoftFundingMessage = (...args) => service.moveMessage(...args);
