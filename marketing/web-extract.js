import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPublicWebsiteAddress } from '../websites/import-url.js';
import { clean, marketingError, publicMarketingUrl } from './project-store.js';

const ENDPOINT = 'https://api.tavily.com/extract';
const MAX_RESPONSE = 2 * 1024 * 1024;
const stopped = () => marketingError('MARKETING_EXTRACT_ABORTED', 'Die Website-Auswertung wurde beendet oder hat ihr Zeitlimit erreicht.', 504);

// Reject short, recognizable access/challenge shells, not ordinary navigation
// words such as "Login" in otherwise substantive company or article content.
export function isMeaningfulMarketingText(value, { title = '', minimumLength = 60 } = {}) {
  if (typeof value !== 'string') return false;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length < minimumLength) return false;
  const heading = String(title || '').trim();
  const challenge = /(?:enable javascript(?: and cookies)?(?: to (?:continue|run|use|view))?|you need to enable javascript|javascript (?:is (?:required|disabled)|must be enabled)|bitte (?:aktivieren sie|aktiviere) javascript|checking (?:your|the) browser|verifying (?:you are human|your browser)|verify (?:that )?you are human|performing security verification|just a moment|attention required|access denied|checking if the site connection is secure|sicherheitsüberprüfung)/i;
  const login = /(?:sign in to (?:linkedin|continue|your account)|log in to (?:linkedin|continue|your account)|anmelden,? um (?:fortzufahren|diesen inhalt)|log in or sign up|join linkedin|stay updated on your professional world)/i;
  const isShellLead = challenge.test(text.slice(0, 350)) || login.test(text.slice(0, 250)) || /^(?:sign in|log in|login|anmelden|just a moment|attention required)(?:\s*[-|:].*)?$/i.test(heading);
  if (!isShellLead || text.length > 2400) return true;
  // After known boilerplate, a meaningful paragraph still counts as real text.
  // This also avoids rejecting articles discussing Cloudflare or JavaScript.
  const remainder = text
    .replace(new RegExp(challenge.source, 'gi'), ' ')
    .replace(new RegExp(login.source, 'gi'), ' ')
    .replace(/(?:cloudflare|ray id[:\s\w-]*|performance\s*(?:and|&)\s*security|please wait|please stand by|this process is automatic|before proceeding|to continue|for this site|to run this app|email or phone|email address|password|forgot password|remember me|keep me logged in|sign in|log in|sign up|join now|continue with (?:google|apple)|new to linkedin|agree(?:ment)?|privacy policy|cookie policy|user agreement|all rights reserved|we (?:are|need to) (?:check|verify)[^.]*\.?|your browser[^.]*\.?|https?:\/\/\S+|[\w.-]+\.(?:com|de|net|org)\b)/gi, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return remainder.length >= 220 && remainder.split(/\s+/).length >= 30;
}

// Official request and response fields, verified 2026-09-15:
// https://docs.tavily.com/documentation/api-reference/endpoint/extract
export async function extractMarketingWebsite(input, { env = process.env, fetchImpl = globalThis.fetch, lookupImpl = lookup, signal, timeoutMs = 40000, now = Date.now } = {}) {
  const url = publicMarketingUrl(input);
  if (!url) throw marketingError('MARKETING_EXTRACT_URL', 'Bitte eine vollständige öffentliche Website-Adresse angeben.');
  const key = env.TAVILY_API_KEY;
  if (typeof key !== 'string' || !key.trim()) throw marketingError('MARKETING_EXTRACT_MISSING', 'Der zusätzliche Website-Lesezugang ist noch nicht verbunden.', 503);
  if (key.length > 16000 || /[\r\n]/.test(key)) throw marketingError('MARKETING_EXTRACT_MISSING', 'Der zusätzliche Website-Lesezugang ist nicht gültig eingerichtet.', 503);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(40000, Math.max(1, Number(timeoutMs) || 40000)));
  const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let listener, reader;
  const aborted = new Promise((_, reject) => { listener = () => reject(stopped()); active.addEventListener('abort', listener, { once: true }); if (active.aborted) listener(); });
  const bounded = async action => { if (active.aborted) throw stopped(); return Promise.race([Promise.resolve().then(action), aborted]); };
  try {
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await bounded(() => lookupImpl(hostname, { all: true, verbatim: true }));
    if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !isPublicWebsiteAddress(item.address))) throw marketingError('MARKETING_EXTRACT_PRIVATE', 'Die Website verweist auf ein internes oder reserviertes Netzwerk.');
    const response = await bounded(() => fetchImpl(ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: [url], extract_depth: 'advanced', format: 'text', timeout: 30 }), redirect: 'error', signal: active }));
    if (response.redirected || response.status >= 300 && response.status < 400 || response.url && new URL(response.url).href !== ENDPOINT) throw marketingError('MARKETING_EXTRACT_REDIRECT', 'Der Website-Leseanbieter lieferte eine unerwartete Weiterleitung.', 502);
    if (!response.ok) throw marketingError('MARKETING_EXTRACT_FAILED', `Der zusätzliche Website-Leseanbieter meldet HTTP ${Number(response.status) || 0}.`, 502);
    if (Number(response.headers?.get?.('content-length') || 0) > MAX_RESPONSE) throw marketingError('MARKETING_EXTRACT_SIZE', 'Die Website-Auswertung überschreitet die erlaubte Antwortgröße.', 502);
    reader = response.body?.getReader();
    let body;
    if (reader) {
      const chunks = []; let size = 0;
      while (true) {
        const item = await bounded(() => reader.read()); if (item.done) break;
        size += item.value.byteLength;
        if (size > MAX_RESPONSE) throw marketingError('MARKETING_EXTRACT_SIZE', 'Die Website-Auswertung überschreitet die erlaubte Antwortgröße.', 502);
        chunks.push(Buffer.from(item.value));
      }
      body = Buffer.concat(chunks).toString('utf8');
    } else {
      body = await bounded(() => response.text());
      if (Buffer.byteLength(body) > MAX_RESPONSE) throw marketingError('MARKETING_EXTRACT_SIZE', 'Die Website-Auswertung überschreitet die erlaubte Antwortgröße.', 502);
    }
    let payload; try { payload = JSON.parse(body); } catch { throw marketingError('MARKETING_EXTRACT_FORMAT', 'Der Website-Leseanbieter hat keine auswertbare Antwort geliefert.', 502); }
    // A different site is never silently substituted for the requested source.
    const row = (Array.isArray(payload.results) ? payload.results : []).find(item => { try { return publicMarketingUrl(item?.url) === url; } catch { return false; } });
    const raw = typeof row?.raw_content === 'string' ? row.raw_content.trim() : '';
    if (!isMeaningfulMarketingText(raw, { title: row?.title })) throw marketingError('MARKETING_EXTRACT_EMPTY', 'Auch der zusätzliche Leseweg hat keinen ausreichenden frei lesbaren Inhalt dieser Website geliefert.', 502);
    const redact = value => clean(value, 12000).split(key).join('[Zugang entfernt]').split(encodeURIComponent(key)).join('[Zugang entfernt]');
    return { url, finalUrl: url, title: redact(row.title || new URL(url).hostname).slice(0, 300), text: redact(raw), status: 'read', provider: 'tavily-extract', fetchedAt: new Date(now()).toISOString(), modalities: ['text'], limitations: ['Öffentlicher Website-Text über Tavily Extract gelesen. Bilder, Animationen, Audio und Videos wurden durch diese Textextraktion nicht geprüft.'] };
  } catch (error) {
    if (active.aborted) throw stopped();
    if (error?.code?.startsWith('MARKETING_') || error?.code?.startsWith('WEBSITE_')) throw error;
    throw marketingError('MARKETING_EXTRACT_FAILED', 'Der zusätzliche Website-Leseweg ist momentan nicht verfügbar.', 502);
  } finally {
    clearTimeout(timer); active.removeEventListener('abort', listener);
    // Cancel asynchronously: a broken stream must not outlive the operation's timeout.
    if (reader) void reader.cancel().catch(() => {});
    void aborted.catch(() => {});
  }
}
