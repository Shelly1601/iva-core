import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const MiB = 1024 * 1024;
const MAX_HTML_BYTES = 20 * MiB;
const MAX_PAYLOAD_BYTES = 40 * MiB;
const MAX_CACHE_BYTES = 50 * MiB;
const MAX_CACHE_ENTRIES = 100;
const MAX_IN_FLIGHT = 4;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const HASH = /^[a-f\d]{64}$/i;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const fail = (status, message = 'Website momentan nicht erreichbar.') => Object.assign(new Error(message), { status });

function hostname(value, { allowPort = false } = {}) {
  if (typeof value !== 'string' || value.length > 260 || value !== value.trim()) return '';
  let name = value.toLowerCase();
  if (allowPort && /:\d{1,5}$/.test(name)) {
    const index = name.lastIndexOf(':');
    const port = Number(name.slice(index + 1));
    if (port < 1 || port > 65535) return '';
    name = name.slice(0, index);
  }
  if (name.endsWith('.')) name = name.slice(0, -1);
  if (!name || name.length > 253 || !name.includes('.') || !name.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))) return '';
  if (/^\d+(?:\.\d+){3}$/.test(name)) return '';
  return name;
}

function configuration(env) {
  let origin;
  try { origin = new URL(env.IVA_CORE_ORIGIN); } catch { throw new Error('IVA_CORE_ORIGIN muss eine HTTPS-Origin sein.'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('IVA_CORE_ORIGIN muss eine HTTPS-Origin ohne Pfad oder Zugangsdaten sein.');
  const publicDomain = hostname(env.RAILWAY_PUBLIC_DOMAIN);
  if (!publicDomain) throw new Error('RAILWAY_PUBLIC_DOMAIN muss die öffentliche Host-Domain enthalten.');
  if (publicDomain === origin.hostname.toLowerCase()) throw new Error('Website-Host und IVA-Core benötigen getrennte Origins.');
  const key = env.IVA_WEBSITE_PUBLISH_KEY;
  if (typeof key !== 'string' || key.length < 32 || key.length > 4096 || /[\s\x00-\x1f\x7f]/.test(key)) throw new Error('IVA_WEBSITE_PUBLISH_KEY fehlt oder ist ungültig.');
  return { origin: origin.origin, publicDomain, key };
}

async function limitedJson(response, signal) {
  const declared = response.headers?.get?.('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_PAYLOAD_BYTES)) {
    await response.body?.cancel?.().catch(() => {});
    throw fail(502);
  }
  if (!response.body || typeof response.body.getReader !== 'function') throw fail(502);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_PAYLOAD_BYTES) throw fail(502);
      chunks.push(Buffer.from(chunk.value));
    }
    signal.throwIfAborted();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  } catch {
    await reader.cancel().catch(() => {});
    throw fail(502);
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function commonHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

function sendText(req, res, status, message, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  commonHeaders(res);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  const bytes = Buffer.from(message);
  res.setHeader('Content-Length', String(bytes.length));
  res.end(req.method === 'HEAD' ? undefined : bytes);
}

/** A standalone public host. The only upstream capability is the published-artifact endpoint. */
export function createWebsiteHostHandler({ env = process.env, fetchImpl = fetch, now = Date.now, timeoutMs = 15000, cacheAgeMs = 30000 } = {}) {
  const config = configuration(env);
  const cache = new Map();
  const inFlight = new Map();
  const timeout = Math.max(1, Math.min(15000, Number(timeoutMs) || 15000));
  const ttl = Math.max(0, Math.min(30000, Number(cacheAgeMs) || 0));
  let cacheBytes = 0;

  function evict(key) {
    const value = cache.get(key);
    if (value) cacheBytes -= value.bytes.length;
    cache.delete(key);
  }
  function prune() {
    const timestamp = now();
    for (const [key, value] of cache) if (value.expiresAt <= timestamp) evict(key);
  }
  function cacheGet(key) {
    const result = cache.get(key);
    if (!result) return null;
    if (result.expiresAt <= now()) { evict(key); return null; }
    cache.delete(key);
    cache.set(key, result);
    return result;
  }
  function cachePut(key, value) {
    if (!ttl) return;
    prune();
    evict(key);
    while (cache.size >= MAX_CACHE_ENTRIES || cacheBytes + value.bytes.length > MAX_CACHE_BYTES) evict(cache.keys().next().value);
    cache.set(key, { ...value, expiresAt: now() + ttl });
    cacheBytes += value.bytes.length;
  }

  async function fetchArtifact(source) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(fail(504)); }, timeout); });
    const operation = (async () => {
      const url = new URL('/_website-published', config.origin);
      url.searchParams.set(source.kind, source.value);
      let response;
      try {
        response = await fetchImpl(url.href, { method: 'GET', headers: { Authorization: `Bearer ${config.key}`, Accept: 'application/json', 'User-Agent': 'IVA-Website-Host/1.0' }, redirect: 'error', signal: controller.signal });
      } catch { throw fail(502); }
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        throw [404, 410].includes(response.status) ? fail(404, 'Diese Website ist noch nicht veröffentlicht.') : fail(503);
      }
      const payload = await limitedJson(response, controller.signal);
      if (!payload || typeof payload.html !== 'string' || !payload.html.trim() || !IDENTIFIER.test(payload.siteId || '') || !IDENTIFIER.test(payload.revisionId || '') || !HASH.test(payload.artifactHash || '')) throw fail(502);
      if (payload.html.includes(config.key)) throw fail(502);
      if (source.kind === 'siteId' && payload.siteId !== source.value) throw fail(502);
      const bytes = Buffer.from(payload.html, 'utf8');
      if (bytes.length > MAX_HTML_BYTES) throw fail(502);
      const htmlHash = createHash('sha256').update(bytes).digest('hex');
      if (payload.artifactHash.toLowerCase() !== htmlHash) throw fail(502);
      return { bytes, revisionId: payload.revisionId, etag: `"${htmlHash}"` };
    })();
    try { return await Promise.race([operation, deadline]); }
    finally { clearTimeout(timer); controller.abort(); }
  }

  async function artifact(source, requestedRevision = '', retryShared = true) {
    const key = `${source.kind}:${source.value}`;
    const existing = cacheGet(key);
    if (existing && (!requestedRevision || existing.revisionId === requestedRevision)) return existing;
    if (inFlight.has(key)) {
      const shared = await inFlight.get(key);
      if (!requestedRevision || shared.revisionId === requestedRevision || !retryShared) return shared;
      return artifact(source, requestedRevision, false);
    }
    if (inFlight.size >= MAX_IN_FLIGHT) throw fail(503);
    const pending = fetchArtifact(source).then(value => { cachePut(key, value); return value; }).finally(() => { inFlight.delete(key); });
    inFlight.set(key, pending);
    return pending;
  }

  async function handle(req, res) {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) { sendText(req, res, 405, 'Methode nicht erlaubt.', { Allow: 'GET, HEAD' }); return; }
      if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//') || req.url.length > 8192 || /[\x00-\x20\x7f\\]/.test(req.url)) { sendText(req, res, 400, 'Ungültige Anfrage.'); return; }
      let url;
      try { url = new URL(req.url, 'https://website.invalid'); } catch { sendText(req, res, 400, 'Ungültige Anfrage.'); return; }
      if (url.pathname === '/health') {
        if (res.destroyed || res.writableEnded) return;
        res.statusCode = 200; commonHeaders(res); res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
        const body = '{"ok":true}'; res.setHeader('Content-Length', String(Buffer.byteLength(body))); res.end(req.method === 'HEAD' ? undefined : body); return;
      }
      const host = hostname(req.headers?.host, { allowPort: true });
      if (!host) { sendText(req, res, 400, 'Ungültige Website-Adresse.'); return; }
      const serviceAddress = host === config.publicDomain;
      let source;
      if (serviceAddress) {
        const siteId = /^\/s\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,99})(?:\/.*)?$/.exec(url.pathname)?.[1];
        if (!siteId) { sendText(req, res, 404, 'Website nicht gefunden.'); return; }
        source = { kind: 'siteId', value: siteId };
      } else source = { kind: 'hostname', value: host };
      const revisionHint = req.method === 'GET' ? url.searchParams.get('iva-version') || '' : '';
      const published = await artifact(source, UUID.test(revisionHint) ? revisionHint : '');
      if (res.destroyed || res.writableEnded) return;
      commonHeaders(res);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      res.setHeader('ETag', published.etag);
      res.setHeader('X-IVA-Revision', published.revisionId);
      if (serviceAddress) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      const conditional = req.headers?.['if-none-match'];
      const matches = typeof conditional === 'string' && conditional.length <= 8192 && conditional.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === published.etag);
      if (matches) { res.statusCode = 304; res.end(); return; }
      res.statusCode = 200; res.setHeader('Content-Length', String(published.bytes.length)); res.end(req.method === 'HEAD' ? undefined : published.bytes);
    } catch (error) {
      const status = [404, 502, 503, 504].includes(error.status) ? error.status : 502;
      sendText(req, res, status, status === 404 ? 'Diese Website ist noch nicht veröffentlicht.' : 'Website momentan nicht erreichbar.', status === 503 || status === 504 ? { 'Retry-After': '15' } : {});
    }
  }

  return { handle, cacheStats: () => { prune(); return { entries: cache.size, bytes: cacheBytes, inFlight: inFlight.size }; } };
}

export function startWebsiteHost({ env = process.env } = {}) {
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT ist ungültig.');
  const { handle } = createWebsiteHostHandler({ env });
  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 20000, headersTimeout: 15000, keepAliveTimeout: 5000 }, (req, res) => { handle(req, res); });
  server.maxConnections = 200;
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  server.listen(port, '0.0.0.0');
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { startWebsiteHost(); }
  catch (error) { process.stderr.write(`Website-Host konnte nicht starten: ${error.message}\n`); process.exitCode = 1; }
}
