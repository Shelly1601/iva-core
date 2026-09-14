import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';

const MAX_FILE = 3 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024;
const MAX_ASSETS = 100;
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const stopped = () => fail('WEBSITE_IMPORT_ABORTED', 'Website-Import wurde beendet oder hat sein Zeitlimit erreicht.', 504);

export function isPublicWebsiteAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99) || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (family !== 6 || address.includes('%') || address.includes('.')) return false;
  const first = parseInt(address.split(':')[0] || '0', 16);
  const second = parseInt(address.split(':')[1] || '0', 16);
  // Only global unicast; exclude special-purpose, documentation and transition ranges.
  return first >= 0x2000 && first <= 0x3ffe && first !== 0x2002 && !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8));
}

export function validateWebsiteUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw fail('WEBSITE_INVALID_URL', 'Bitte eine vollständige öffentliche HTTPS-Adresse angeben.'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password || url.href.length > 2048 || /[\x00-\x20\\]/.test(String(input)) || !hostname.includes('.') && !isIP(hostname) || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(hostname) || hostname.endsWith('.') || isIP(hostname) && !isPublicWebsiteAddress(hostname)) {
    throw fail('WEBSITE_UNSAFE_URL', 'Nur öffentliche HTTPS-Websites auf dem Standardport sind zugelassen.');
  }
  if ([...url.searchParams.keys()].some(key => /token|secret|password|credential|api[-_]?key|authorization|signature/i.test(key))) throw fail('WEBSITE_UNSAFE_URL', 'Öffentliche Website-Referenzen dürfen keine Zugangsdaten enthalten.');
  url.hash = '';
  return url;
}

async function boundedRace(promise, signal, timeout) {
  if (signal?.aborted) throw stopped();
  let timer, listener;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(stopped()), timeout);
      if (signal) { listener = () => reject(stopped()); signal.addEventListener('abort', listener, { once: true }); }
    })]);
  } finally { clearTimeout(timer); if (listener) signal.removeEventListener('abort', listener); }
}

export function createWebsiteUrlImporter({ lookupImpl = lookup, requestImpl = https.request, requestTimeoutMs = 15_000, operationTimeoutMs = 60_000 } = {}) {
  const requestTimeout = Math.min(Math.max(Number(requestTimeoutMs) || 15_000, 1), 20_000);
  const operationTimeout = Math.min(Math.max(Number(operationTimeoutMs) || 60_000, 1), 90_000);
  const operation = signal => ({ signal, deadline: Date.now() + operationTimeout, bytes: 0 });
  function remaining(context) {
    const value = Math.min(requestTimeout, context.deadline - Date.now());
    if (context.signal?.aborted || value <= 0) throw stopped();
    return value;
  }
  async function fetchPublic(input, context, origin, redirects = 0) {
    const url = validateWebsiteUrl(input);
    if (origin && url.origin !== origin) throw fail('WEBSITE_ASSET_ORIGIN', 'Eine Datei verweist auf einen anderen Anbieter.');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await boundedRace(lookupImpl(host, { all: true, verbatim: true }), context.signal, remaining(context));
    if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !isPublicWebsiteAddress(item.address))) throw fail('WEBSITE_PRIVATE_NETWORK', 'Die Website verweist auf ein internes oder reserviertes Netzwerk.');
    const pinned = addresses[0];
    const result = await new Promise((resolve, reject) => {
      let request, timer;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', abort);
        if (error) { request?.destroy(); reject(error); } else resolve(value);
      };
      const abort = () => finish(stopped());
      try {
        request = requestImpl(url, { method: 'GET', agent: false, maxHeaderSize: 16 * 1024, headers: { Accept: '*/*', 'Accept-Encoding': 'identity', 'User-Agent': 'IVA-Website-Studio/1.0' }, lookup(_hostname, options, callback) {
          if (typeof options === 'function') callback = options;
          if (options?.all) callback(null, [pinned]); else callback(null, pinned.address, pinned.family);
        } }, response => {
          const status = Number(response.statusCode);
          if (status >= 300 && status < 400) { response.resume(); finish(null, { redirect: response.headers.location, status }); return; }
          if (status < 200 || status >= 300) { response.resume(); finish(fail('WEBSITE_FETCH_FAILED', `Die öffentliche Website antwortet mit HTTP ${status}.`, 502)); return; }
          const length = Number(response.headers['content-length'] || 0);
          if (length > MAX_FILE || context.bytes + length > MAX_TOTAL) { response.destroy(); finish(fail('WEBSITE_IMPORT_SIZE', 'Website-Datei überschreitet die Importgrenze.', 413)); return; }
          if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); finish(fail('WEBSITE_ENCODING_UNSUPPORTED', 'Der Webserver liefert eine nicht unterstützte komprimierte Antwort.', 502)); return; }
          const chunks = [];
          let size = 0;
          response.on('data', chunk => {
            if (settled) return;
            const bytes = Buffer.from(chunk);
            size += bytes.length;
            context.bytes += bytes.length;
            if (size > MAX_FILE || context.bytes > MAX_TOTAL) { response.destroy(); finish(fail('WEBSITE_IMPORT_SIZE', 'Website überschreitet 3 MiB pro Datei oder 20 MiB insgesamt.', 413)); return; }
            chunks.push(bytes);
          });
          response.on('end', () => finish(null, { bytes: Buffer.concat(chunks), contentType: String(response.headers['content-type'] || '').split(';')[0].toLowerCase(), url: url.href }));
          response.on('error', () => finish(fail('WEBSITE_FETCH_FAILED', 'Die öffentliche Website konnte nicht vollständig gelesen werden.', 502)));
        });
        request.on('error', () => finish(fail('WEBSITE_FETCH_FAILED', 'Die öffentliche Website ist momentan nicht erreichbar.', 502)));
        timer = setTimeout(abort, remaining(context));
        context.signal?.addEventListener('abort', abort, { once: true });
        if (context.signal?.aborted) abort(); else request.end();
      } catch { finish(fail('WEBSITE_FETCH_FAILED', 'Die öffentliche Website konnte nicht abgerufen werden.', 502)); }
    });
    if (result.redirect !== undefined || result.status >= 300) {
      if (!result.redirect || redirects >= 3) throw fail('WEBSITE_REDIRECT_LIMIT', 'Die Website leitet zu häufig oder ohne gültiges Ziel weiter.', 502);
      return fetchPublic(new URL(result.redirect, url).href, context, origin, redirects + 1);
    }
    return result;
  }
  async function html(input, context) {
    const response = await fetchPublic(input, context);
    if (!['text/html', 'application/xhtml+xml'].includes(response.contentType) && !/^\s*(?:<!doctype\s+html|<html\b)/i.test(response.bytes.toString('utf8'))) throw fail('WEBSITE_NOT_HTML', 'Die angegebene Adresse liefert keine HTML-Website.');
    return { ...response, text: response.bytes.toString('utf8') };
  }
  async function readWebsiteReference(input, { signal } = {}) {
    const result = await html(input, operation(signal));
    const title = cleanText(result.text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').slice(0, 300);
    const text = cleanText(result.text.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')).slice(0, 12_000);
    return { url: result.url, title, text, summary: 'Frisch gelesene öffentlich sichtbare Website als gestalterische Referenz; keine Anmeldung, internen Daten oder Originalquellen.' };
  }
  async function importWebsiteUrl(input, { signal } = {}) {
    const context = operation(signal);
    const page = await html(input, context);
    const origin = new URL(page.url).origin;
    const records = new Map();
    const queue = [];
    const warnings = ['Dieser Snapshot enthält öffentlich ausgeliefertes HTML und Dateien. Originale React-Quellen, Backend, Datenbanken, Anmeldungen und Kontozugänge werden dadurch nicht übertragen.'];
    let external = 0, unavailable = 0, limited = false;
    const enqueue = (value, base) => {
      const raw = decodeEntities(value).trim();
      if (!raw || /^(?:data:|blob:|#)/i.test(raw)) return;
      let url;
      try { url = validateWebsiteUrl(new URL(raw, base).href); } catch { unavailable++; return; }
      if (url.origin !== origin) { external++; return; }
      if (url.href === page.url || records.has(url.href)) return;
      if (records.size >= MAX_ASSETS) { limited = true; return; }
      const original = url.pathname.split('/').pop() || 'asset';
      const basename = original.replace(/[^a-z\d_.-]/gi, '-').slice(-100) || 'asset';
      const name = `assets/${createHash('sha256').update(url.href).digest('hex').slice(0, 12)}-${basename}`;
      const record = { url: url.href, path: name, bytes: null, text: null, kind: null };
      records.set(url.href, record); queue.push(record);
    };
    discoverAssets(page.text, 'html', page.url, enqueue);
    for (let index = 0; index < queue.length; index++) {
      remaining(context);
      const record = queue[index];
      try {
        const response = await fetchPublic(record.url, context, origin);
        record.bytes = response.bytes;
        record.kind = response.contentType.includes('css') || /\.css(?:\?|$)/i.test(record.url) ? 'css' : /(?:javascript|ecmascript)/.test(response.contentType) || /\.m?js(?:\?|$)/i.test(record.url) ? 'js' : null;
        if (record.kind) { record.text = response.bytes.toString('utf8'); discoverAssets(record.text, record.kind, response.url, enqueue); }
      } catch (error) {
        if (context.signal?.aborted || Date.now() >= context.deadline || ['WEBSITE_IMPORT_ABORTED', 'WEBSITE_IMPORT_SIZE'].includes(error.code)) throw error;
        unavailable++;
      }
    }
    const rewrite = (value, base, prefix) => {
      try {
        const url = new URL(decodeEntities(value), base);
        const fragment = url.hash;
        url.hash = '';
        const record = records.get(url.href);
        return record?.bytes ? `${prefix}${record.path.replace(/^assets\//, '')}${fragment}` : value;
      } catch { return value; }
    };
    let pageText = rewriteAssets(page.text.replace(/<base\b[^>]*>/gi, ''), 'html', page.url, (value, base) => rewrite(value, base, './assets/'));
    const files = [{ path: 'index.html', content: pageText, encoding: 'utf8' }];
    for (const record of records.values()) {
      if (!record.bytes) continue;
      if (record.text !== null) files.push({ path: record.path, content: rewriteAssets(record.text, record.kind, record.url, (value, base) => rewrite(value, base, './')), encoding: 'utf8' });
      else files.push({ path: record.path, content: record.bytes.toString('base64'), encoding: 'base64' });
    }
    if (external) warnings.push('Externe Dateien bleiben Verweise auf ihre bisherigen Anbieter und wurden nicht kopiert.');
    if (unavailable) warnings.push(`${unavailable} Dateiverweise konnten nicht übernommen werden; Darstellung und Funktionen in der Vorschau prüfen.`);
    if (limited) warnings.push('Die Grenze von 100 zusätzlichen Dateien wurde erreicht.');
    return { files, source: { type: 'public-snapshot', url: page.url, importedAt: new Date().toISOString() }, warnings, summary: `Öffentliche Website mit ${files.length - 1} Dateien als bearbeitbaren Snapshot übernommen. Originalcode und Backend sind nicht enthalten.` };
  }
  return Object.freeze({ importWebsiteUrl, readWebsiteReference });
}

function decodeEntities(value) {
  return String(value).replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#(\d+);/g, (_, n) => Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : '').replace(/&#x([a-f\d]+);/gi, (_, n) => parseInt(n, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(n, 16)) : '');
}
function cleanText(value) { return decodeEntities(String(value).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function rewriteAssets(text, kind, base, transform) {
  if (kind === 'html') {
    return text.replace(/<(?:script|img|source|video|audio|link|input|iframe)\b[^>]*>/gi, tag => tag.replace(/\b(src|href|poster)\s*=\s*(["'])(.*?)\2/gi, (all, attribute, quote, value) => `${attribute}=${quote}${transform(value, base)}${quote}`).replace(/\bsrcset\s*=\s*(["'])(.*?)\1/gi, (all, quote, value) => `srcset=${quote}${value.split(',').map(candidate => candidate.trim().replace(/^(\S+)/, url => transform(url, base))).join(', ')}${quote}`)).replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (all, css) => all.replace(css, rewriteAssets(css, 'css', base, transform)));
  }
  if (kind === 'css') return text.replace(/url\(\s*(["']?)([^)'"\s]+)\1\s*\)/gi, (all, quote, url) => `url(${quote}${transform(url, base)}${quote})`).replace(/(@import\s+)(["'])(.*?)\2/gi, (all, prefix, quote, url) => `${prefix}${quote}${transform(url, base)}${quote}`);
  if (kind === 'js') return text.replace(/((?:\bfrom\s*|\bimport\s*\(?\s*|\bexport\s*[^;]*?\bfrom\s*))(["'])([^"']+)\2/g, (all, prefix, quote, url) => /^[./]|^https:\/\//i.test(url) ? `${prefix}${quote}${transform(url, base)}${quote}` : all);
  return text;
}
function discoverAssets(text, kind, base, enqueue) { rewriteAssets(text, kind, base, value => { enqueue(value, base); return value; }); }
const defaultImporter = createWebsiteUrlImporter();
export const importWebsiteUrl = (url, options) => defaultImporter.importWebsiteUrl(url, options);
export const readWebsiteReference = (url, options) => defaultImporter.readWebsiteReference(url, options);
