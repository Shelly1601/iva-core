import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import PDFDocument from 'pdfkit';

export const TOO_OFTEN_LABEL_NAME = 'Heat Hero/Zu oft n.e.';
export const TOO_OFTEN_RECLAMATION_REASON = 'Sonstiges';
export const TOO_OFTEN_FOLLOW_UP_OWNER = 'setter';
export const TOO_OFTEN_LEGACY_GOODWILL_BEFORE = '2026-08-23T00:00:00+02:00';
export const TOO_OFTEN_LEGACY_GOODWILL_NOTE = 'Diese Kundenrückmeldung wurde uns von Julia Zollner nicht übermittelt. Wir haben davon erst seit dem kürzlichen Austausch mit Thomas Sommer Kenntnis und bitten deshalb um Kulanz.';

const NEGATIVE_PATTERNS = [
  /\bkein(?:e[snr]?)?\s+(?:interesse|bedarf)\b/i,
  /\bnicht\s+mehr\s+(?:interessiert|aktuell)\b/i,
  /\b(?:thema|anfrage|sache|planung|projekt|vorgang)\b.{0,45}\b(?:erledigt|abschlie(?:ß|ss)en|beenden)\b/i,
  /\b(?:bereits|inzwischen)\b.{0,60}\b(?:gekauft|vertrag|fündig|mitbewerber|anderweitig entschieden)\b/i,
  /\b(?:von|aus)\s+(?:der|ihrer|unserer)?\s*(?:liste|verteiler)\s+(?:streichen|austragen)\b/i,
  /\btechn(?:ische|isch)?\.?\s*machbarkeit\b.{0,50}\b(?:nicht|keine|leider)\b/i,
];

const POSITIVE_PATTERNS = [
  /\b(?:noch|weiterhin|grundsätzlich|immer noch)\s+interesse\b/i,
  /\bgerne\s+(?:anrufen|anruf|rückruf|melden)\b/i,
  /\b(?:rufen|kontaktieren)\s+sie\s+(?:mich|uns)\b/i,
  /\b(?:bin|sind)\s+(?:ich|wir)?\s*(?:wieder\s+)?erreichbar\b/i,
  /\btermin\s+(?:ausmachen|vereinbaren)\b/i,
];

const PRIVACY_PATTERNS = [
  /\b(?:daten|kontaktdaten)\b.{0,35}\b(?:löschen|loeschen|löschung|loeschung)\b/i,
  /\b(?:löschen|loeschen)\b.{0,35}\b(?:daten|kontaktdaten)\b/i,
];

const QUOTE_MARKERS = [
  /^\s*-{2,}\s*(?:ursprüngliche|original)\s+nachricht\s*-{2,}/im,
  /^\s*(?:am|on)\s+.+\s+(?:schrieb|wrote)\b.*:\s*$/im,
  /^\s*(?:von|from):\s+.+$/im,
  /^\s*>+/m,
];

const clean = (value, max = 100_000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
const compact = (value, max = 10_000) => clean(value, max).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n');

function clone(value) {
  return structuredClone(value);
}

function normalizeEmail(value) {
  const match = clean(value, 500).match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
  return String(match?.[0] || '').toLowerCase();
}

function normalizedPhone(value) {
  const digits = clean(value, 100).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0049')) return `49${digits.slice(4)}`;
  if (digits.startsWith('0')) return `49${digits.slice(1)}`;
  return digits;
}

function displayName(value) {
  const raw = clean(value, 500);
  const beforeAddress = raw.replace(/<[^>]+>/g, '').replace(/^['"]|['"]$/g, '').trim();
  return beforeAddress.includes('@') ? '' : beforeAddress.slice(0, 200);
}

export function stripQuotedHistory(value) {
  const text = compact(value);
  let cut = text.length;
  for (const marker of QUOTE_MARKERS) {
    const match = marker.exec(text);
    if (match && match.index > 0) cut = Math.min(cut, match.index);
  }
  return compact(text.slice(0, cut), 30_000);
}

export function extractPhoneCandidates(value) {
  const matches = clean(value).match(/(?:\+49|0049|0)[\d\s()./-]{7,20}\d/g) || [];
  return [...new Set(matches.map(normalizedPhone).filter(number => number.length >= 10))].slice(0, 8);
}

function berlinParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function berlinDateTimeToIso({ year, month, day, hour = 9, minute = 0 }) {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const first = berlinParts(utcGuess);
  const displayedAsUtc = Date.UTC(
    Number(first.year), Number(first.month) - 1, Number(first.day),
    Number(first.hour), Number(first.minute), Number(first.second),
  );
  const offset = displayedAsUtc - utcGuess.getTime();
  const candidate = new Date(utcGuess.getTime() - offset);
  const check = berlinParts(candidate);
  if (Number(check.hour) === hour && Number(check.minute) === minute) return candidate.toISOString();
  return new Date(candidate.getTime() - (Number(check.hour) - hour) * 3_600_000).toISOString();
}

function localDateSeed(date) {
  const parts = berlinParts(date);
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function addLocalDays(seed, amount) {
  const result = new Date(Date.UTC(seed.year, seed.month - 1, seed.day + amount));
  return { year: result.getUTCFullYear(), month: result.getUTCMonth() + 1, day: result.getUTCDate() };
}

function timeFromText(text) {
  const direct = text.match(/\b(?:um|ab|gegen|zwischen)?\s*([01]?\d|2[0-3])(?:[:.]([0-5]\d))?\s*(?:uhr)?\b/i);
  if (direct && (direct[2] || /\b(?:um|ab|gegen|uhr|zwischen)\b/i.test(direct[0]))) {
    return { hour: Number(direct[1]), minute: Number(direct[2] || 0), source: direct[0].trim() };
  }
  if (/\bvormittag/i.test(text)) return { hour: 9, minute: 0, source: 'vormittags' };
  if (/\bmittag/i.test(text)) return { hour: 12, minute: 0, source: 'mittags' };
  if (/\bnachmittag/i.test(text)) return { hour: 15, minute: 0, source: 'nachmittags' };
  if (/\babend/i.test(text)) return { hour: 18, minute: 0, source: 'abends' };
  return { hour: 9, minute: 0, source: 'CRM-Standardzeit 09:00 Uhr' };
}

function nextWeekday(seed, targetWeekday, forceNextWeek = false) {
  const base = new Date(Date.UTC(seed.year, seed.month - 1, seed.day));
  let delta = (targetWeekday - base.getUTCDay() + 7) % 7;
  if (delta === 0 || forceNextWeek) delta += forceNextWeek ? 7 : 0;
  return addLocalDays(seed, delta);
}

export function extractCallbackSchedule(value, { messageDate = new Date() } = {}) {
  const text = stripQuotedHistory(value);
  const baseDate = Number.isNaN(new Date(messageDate).getTime()) ? new Date() : new Date(messageDate);
  const seed = localDateSeed(baseDate);
  let date = null;
  let dateSource = '';

  const explicit = text.match(/\b(?:ab\s+|am\s+)?([0-3]?\d)\s*[.]\s*([01]?\d)(?:\s*[.]\s*(20\d{2}|\d{2}))?\b/i);
  if (explicit) {
    let year = explicit[3] ? Number(explicit[3]) : seed.year;
    if (year < 100) year += 2000;
    date = { year, month: Number(explicit[2]), day: Number(explicit[1]) };
    const candidate = Date.UTC(date.year, date.month - 1, date.day);
    const baseline = Date.UTC(seed.year, seed.month - 1, seed.day) - 86_400_000;
    if (!explicit[3] && candidate < baseline) date.year += 1;
    dateSource = explicit[0].trim();
  }

  if (!date) {
    const relative = text.match(/\b(übermorgen|uebermorgen|morgen|heute)\b/i);
    if (relative) {
      const amount = /übermorgen|uebermorgen/i.test(relative[1]) ? 2 : /morgen/i.test(relative[1]) ? 1 : 0;
      date = addLocalDays(seed, amount);
      dateSource = relative[1];
    }
  }

  if (!date) {
    const weekdays = new Map([
      ['sonntag', 0], ['montag', 1], ['dienstag', 2], ['mittwoch', 3],
      ['donnerstag', 4], ['freitag', 5], ['samstag', 6],
    ]);
    const weekday = text.match(/\b(?:(nächste[nrsm]?|naechste[nrsm]?)\s+)?(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\b/i);
    if (weekday) {
      date = nextWeekday(seed, weekdays.get(weekday[2].toLowerCase()), Boolean(weekday[1]));
      dateSource = weekday[0];
    }
  }

  if (!date && /\bnächste\s+woche|\bnaechste\s+woche/i.test(text)) {
    date = nextWeekday(seed, 1, true);
    dateSource = 'nächste Woche';
  }

  if (!date) return { callbackAt: '', source: '', concrete: false };
  const time = timeFromText(explicit ? text.replace(explicit[0], ' ') : text);
  const callbackAt = berlinDateTimeToIso({ ...date, hour: time.hour, minute: time.minute });
  return { callbackAt, source: `${dateSource}, ${time.source}`, concrete: true };
}

export function classifyTooOftenReplyRules(message, { messageDate } = {}) {
  const customerText = stripQuotedHistory(message?.customerText || message?.bodyText || message?.snippet || '');
  const negative = NEGATIVE_PATTERNS.some(pattern => pattern.test(customerText));
  const privacyRequest = PRIVACY_PATTERNS.some(pattern => pattern.test(customerText));
  const callback = extractCallbackSchedule(customerText, { messageDate: messageDate || message?.date });
  const strongPositive = /\b(?:noch|weiterhin|grundsätzlich|immer noch)\s+interesse\b/i.test(customerText);
  const callbackContext = /\b(?:handynummer|telefonnummer|rückruf|anruf|anrufen|erreichen|erreichbar)\b/i.test(customerText);
  const positive = POSITIVE_PATTERNS.some(pattern => pattern.test(customerText)) || (callback.concrete && callbackContext);

  if (!customerText) return { decision: 'manual_review', confidence: 0, reason: 'Kein lesbarer Nachrichtentext.', customerText, privacyRequest, ...callback };
  if (negative && strongPositive) return { decision: 'manual_review', confidence: 0.55, reason: 'Die Mail enthält zugleich positive und negative Signale.', customerText, privacyRequest, ...callback };
  if (negative) return { decision: 'reclamation', confidence: 0.99, reason: 'Die Kundenmail enthält eine ausdrückliche Absage beziehungsweise Erledigung.', customerText, privacyRequest, ...callback };
  if (positive && callback.concrete) return { decision: 'follow_up', confidence: 0.98, reason: 'Die Kundenmail bestätigt Interesse und nennt einen konkreten Rückrufzeitpunkt.', customerText, privacyRequest, ...callback };
  if (positive) return { decision: 'manual_review', confidence: 0.82, reason: 'Interesse ist belegt, aber ein konkreter Rückrufzeitpunkt fehlt.', customerText, privacyRequest, ...callback };
  return { decision: 'manual_review', confidence: 0.4, reason: 'Keine eindeutige Absage und kein sicherer Rückrufauftrag erkannt.', customerText, privacyRequest, ...callback };
}

function leadRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.leads)) return value.leads;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function leadEmail(lead) {
  return normalizeEmail(lead?.email || lead?.email_address || lead?.mail || lead?.kontakt_email || '');
}

function leadPhones(lead) {
  return [lead?.telefon, lead?.phone, lead?.mobil, lead?.mobile, lead?.telefonnummer]
    .map(normalizedPhone).filter(Boolean);
}

function resultLead(result) {
  if (result?.matchStatus !== 'unique') return null;
  if (result?.bestMatch?.lead) return result.bestMatch.lead;
  const rows = leadRows(result);
  return rows.length === 1 ? rows[0] : null;
}

export async function resolveReplyLead(message, findLead) {
  if (typeof findLead !== 'function') throw new Error('CRM-Suche fehlt.');
  const senderEmail = normalizeEmail(message?.from);
  const phones = extractPhoneCandidates(message?.customerText || message?.bodyText || '');
  const name = displayName(message?.from);
  const attempts = [
    ...(senderEmail ? [{ type: 'email', value: senderEmail }] : []),
    ...phones.map(value => ({ type: 'phone', value })),
    ...(name ? [{ type: 'name', value: name }] : []),
  ];

  for (const attempt of attempts) {
    const result = await findLead(attempt.value, 8);
    const lead = resultLead(result);
    if (!lead) continue;
    if (attempt.type === 'email' && leadEmail(lead) !== senderEmail) continue;
    if (attempt.type === 'phone' && !leadPhones(lead).includes(attempt.value)) continue;
    return { matched: true, lead, matchedBy: attempt.type, query: attempt.value };
  }
  return { matched: false, lead: null, matchedBy: '', query: attempts.map(item => item.value).join(' | ') };
}

function formatBerlinDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return clean(value, 200) || 'unbekannt';
  return date.toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function isLegacyTooOftenReply(message, cutoff = TOO_OFTEN_LEGACY_GOODWILL_BEFORE) {
  const occurredAt = Date.parse(message?.date || '');
  const threshold = Date.parse(cutoff || '');
  return Number.isFinite(occurredAt) && Number.isFinite(threshold) && occurredAt < threshold;
}

export function buildReclamationOtherText(message, { legacyGoodwillBefore = TOO_OFTEN_LEGACY_GOODWILL_BEFORE } = {}) {
  return isLegacyTooOftenReply(message, legacyGoodwillBefore)
    ? `Siehe Anhang. ${TOO_OFTEN_LEGACY_GOODWILL_NOTE}`
    : 'Siehe Anhang.';
}

export function buildTooOftenGatewayRequest(leadId, action) {
  const id = clean(leadId, 120);
  if (!id) throw new Error('HeatHero-Lead-ID fehlt.');
  if (action?.action === 'reclamation') {
    return { path: `/${encodeURIComponent(id)}/reklamation`, method: 'POST', body: action };
  }
  if (action?.action === 'follow_up') {
    return { path: `/${encodeURIComponent(id)}/wiedervorlage`, method: 'PATCH', body: action };
  }
  throw new Error('Unbekannte HeatHero-Rückmeldungsaktion.');
}

export function buildReplyNote(message, classification, { legacyGoodwillBefore = TOO_OFTEN_LEGACY_GOODWILL_BEFORE } = {}) {
  const lines = [
    `E-Mail vom Kunden am ${formatBerlinDate(message?.date)}.`,
    `Betreff: ${clean(message?.subject, 500) || '(kein Betreff)'}`,
    `Von: ${clean(message?.from, 500) || '(unbekannt)'}`,
    '',
    'Kundenrückmeldung:',
    compact(classification?.customerText || message?.bodyText || message?.snippet || '', 12_000) || '(kein lesbarer Text)',
  ];
  if (isLegacyTooOftenReply(message, legacyGoodwillBefore)) {
    lines.push('', `Kulanzhinweis zum Altbestand: ${TOO_OFTEN_LEGACY_GOODWILL_NOTE}`);
  }
  if (classification?.privacyRequest) {
    lines.push('', 'WICHTIG: Die Kundenmail enthält zusätzlich eine Bitte um Löschung von Kontaktdaten. Diese muss separat geprüft werden; IVA löscht keine Kundendaten automatisch.');
  }
  return lines.join('\n');
}

function safeFilenamePart(value) {
  return clean(value, 120).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'kundenmail';
}

function pdfSafe(value) {
  return clean(value).replace(/[\u2010-\u2015]/g, '-').replace(/\u00a0/g, ' ').replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

export function emailPdfFilename(message) {
  const date = new Date(message?.date);
  const datePart = Number.isNaN(date.getTime()) ? 'ohne-datum' : berlinParts(date);
  const prefix = typeof datePart === 'string' ? datePart : `${datePart.year}-${datePart.month}-${datePart.day}`;
  return `${prefix}-${safeFilenamePart(displayName(message?.from) || normalizeEmail(message?.from))}-kundenmail.pdf`;
}

export async function createEmailPdfBuffer(message) {
  const chunks = [];
  const document = new PDFDocument({ size: 'A4', margins: { top: 52, right: 52, bottom: 58, left: 52 }, bufferPages: true, info: { Title: `Kundenmail - ${clean(message?.subject, 200)}`, Author: 'IVA fuer Heat Hero' } });
  document.on('data', chunk => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    document.once('end', resolve);
    document.once('error', reject);
  });

  document.font('Helvetica-Bold').fontSize(17).fillColor('#172a47').text('Heat Hero - Kundenrückmeldung');
  document.moveDown(0.35).font('Helvetica').fontSize(9).fillColor('#52627a').text('Automatisch aus dem Gmail-Label "Heat Hero/Zu oft n.e." dokumentiert.');
  document.moveDown(1.2);

  const metadata = [
    ['Von', message?.from], ['An', message?.to], ['CC', message?.cc],
    ['Datum', formatBerlinDate(message?.date)], ['Betreff', message?.subject], ['Gmail-ID', message?.id],
  ];
  for (const [label, value] of metadata) {
    if (!clean(value, 1000)) continue;
    const rowY = document.y;
    const labelText = `${label}:`;
    const valueText = pdfSafe(value);
    document.font('Helvetica-Bold').fontSize(9.5);
    const labelHeight = document.heightOfString(labelText, { width: 64 });
    document.font('Helvetica');
    const valueHeight = document.heightOfString(valueText, { width: 413 });
    document.font('Helvetica-Bold').fillColor('#172a47').text(labelText, 52, rowY, { width: 64 });
    document.font('Helvetica').fillColor('#1f2937').text(valueText, 124, rowY, { width: 419 });
    document.y = rowY + Math.max(labelHeight, valueHeight) + 3;
  }

  document.x = 52;
  document.moveDown(0.8).strokeColor('#d7dee8').lineWidth(0.8).moveTo(52, document.y).lineTo(543, document.y).stroke();
  document.moveDown(0.9).font('Helvetica-Bold').fontSize(11).fillColor('#172a47').text('Nachrichteninhalt');
  document.moveDown(0.45).font('Helvetica').fontSize(10).fillColor('#111827').text(pdfSafe(message?.bodyText || message?.snippet || '(kein lesbarer Nachrichtentext)'), { lineGap: 2, align: 'left' });

  if (Array.isArray(message?.attachments) && message.attachments.length) {
    document.moveDown(1).font('Helvetica-Bold').fontSize(10).fillColor('#172a47').text('Anhänge der Originalmail');
    for (const attachment of message.attachments) {
      document.font('Helvetica').fontSize(9).fillColor('#374151').text(`- ${pdfSafe(attachment.filename || 'Anhang')} (${pdfSafe(attachment.mimeType || 'unbekannt')}, ${Number(attachment.size || 0)} Bytes)`);
    }
  }

  const range = document.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    document.switchToPage(index);
    const originalBottomMargin = document.page.margins.bottom;
    document.page.margins.bottom = 0;
    document.font('Helvetica').fontSize(8).fillColor('#6b7280').text(`IVA - Heat Hero | Seite ${index + 1} von ${range.count}`, 52, document.page.height - 32, { width: 491, align: 'center', lineBreak: false });
    document.page.margins.bottom = originalBottomMargin;
  }
  document.end();
  await done;
  return Buffer.concat(chunks);
}

export function createTooOftenReplyStore({ dataDir = process.env.DATA_DIR || '/data' } = {}) {
  const file = path.join(dataDir, 'heat-hero-too-often-replies.json');
  let queue = Promise.resolve();

  const empty = () => ({ version: 1, messages: {}, runs: [] });
  async function load() {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      return { ...empty(), ...parsed, messages: parsed?.messages && typeof parsed.messages === 'object' ? parsed.messages : {}, runs: Array.isArray(parsed?.runs) ? parsed.runs : [] };
    } catch { return empty(); }
  }
  async function save(store) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  }
  async function mutate(action) {
    let result;
    const job = queue.catch(() => {}).then(async () => {
      const store = await load();
      result = await action(store);
      store.runs = store.runs.slice(-180);
      const entries = Object.entries(store.messages).sort(([, left], [, right]) => String(right.updatedAt).localeCompare(String(left.updatedAt))).slice(0, 5000);
      store.messages = Object.fromEntries(entries);
      await save(store);
    });
    queue = job.catch(() => {});
    await job;
    return result;
  }

  return {
    async get(messageId) { return clone((await load()).messages[clean(messageId, 200)] || null); },
    async record(messageId, input = {}) {
      return mutate(store => {
        const id = clean(messageId, 200);
        const now = new Date().toISOString();
        const previous = store.messages[id] || {};
        store.messages[id] = {
          ...previous, messageId: id, status: clean(input.status, 80) || 'prepared',
          decision: clean(input.decision, 80), leadId: clean(input.leadId, 120), matchedBy: clean(input.matchedBy, 40),
          occurredAt: clean(input.occurredAt, 100), callbackAt: clean(input.callbackAt, 100),
          error: clean(input.error, 1200), createdAt: previous.createdAt || now, updatedAt: now,
        };
        return clone(store.messages[id]);
      });
    },
    async recordRun(input = {}) {
      return mutate(store => {
        const item = { id: crypto.randomUUID(), status: clean(input.status, 80), summary: clean(input.summary, 2000), counts: clone(input.counts || {}), startedAt: clean(input.startedAt, 100), completedAt: new Date().toISOString() };
        store.runs.push(item);
        return clone(item);
      });
    },
    async summary() {
      const store = await load();
      const values = Object.values(store.messages);
      return {
        total: values.length,
        completed: values.filter(item => item.status === 'completed').length,
        prepared: values.filter(item => item.status === 'prepared').length,
        needsReview: values.filter(item => item.status === 'needs_review').length,
        failed: values.filter(item => item.status === 'failed').length,
        lastRun: clone(store.runs.at(-1) || null),
      };
    },
  };
}

function isInternalSender(from) {
  const email = normalizeEmail(from);
  return !email || /(?:@|\.)heat-hero\.com$|@heathero\.app$|@notify\.heathero\.app$|nadine\.iva\.inbox@gmail\.com$/i.test(email);
}

async function classifyMessage(message, classifyUnclear) {
  const rules = classifyTooOftenReplyRules(message);
  if (rules.decision !== 'manual_review' || typeof classifyUnclear !== 'function') return rules;
  const modelResult = await classifyUnclear({ ...message, customerText: rules.customerText, deterministicCallback: { callbackAt: rules.callbackAt, source: rules.source, concrete: rules.concrete } });
  const evidence = clean(modelResult?.evidenceQuote, 500);
  const evidencePresent = evidence.length >= 3 && rules.customerText.toLocaleLowerCase('de').includes(evidence.toLocaleLowerCase('de'));
  if (!evidencePresent || Number(modelResult?.confidence || 0) < 0.9) return { ...rules, modelReview: modelResult };
  if (modelResult.decision === 'reclamation') return { ...rules, decision: 'reclamation', confidence: Number(modelResult.confidence), reason: clean(modelResult.reason, 500), modelReview: modelResult };
  if (modelResult.decision === 'follow_up' && rules.concrete) return { ...rules, decision: 'follow_up', confidence: Number(modelResult.confidence), reason: clean(modelResult.reason, 500), modelReview: modelResult };
  return { ...rules, modelReview: modelResult };
}

export async function runTooOftenReplyWorkflow({
  listMessages,
  findLead,
  submitAction,
  classifyUnclear,
  store = createTooOftenReplyStore(),
  writeEnabled = false,
  limit = 100,
  now = new Date(),
  legacyGoodwillBefore = TOO_OFTEN_LEGACY_GOODWILL_BEFORE,
} = {}) {
  if (typeof listMessages !== 'function') throw new Error('Gmail-Lesefunktion fehlt.');
  const startedAt = now.toISOString();
  const result = await listMessages({ limit, query: `label:"${TOO_OFTEN_LABEL_NAME}"`, includeBody: true });
  const messages = [...(result?.messages || [])].sort((left, right) => Date.parse(left.date || 0) - Date.parse(right.date || 0));
  const counts = { checked: messages.length, alreadyCompleted: 0, ignoredInternal: 0, reclamations: 0, followUps: 0, prepared: 0, needsReview: 0, failed: 0 };
  const outcomes = [];

  for (const source of messages) {
    const message = { ...source, customerText: stripQuotedHistory(source.bodyText || source.snippet || '') };
    const previous = await store.get(message.id);
    if (['completed', 'ignored_internal'].includes(previous?.status)) {
      counts.alreadyCompleted += 1;
      continue;
    }
    if (isInternalSender(message.from)) {
      counts.ignoredInternal += 1;
      await store.record(message.id, { status: 'ignored_internal', occurredAt: message.date });
      continue;
    }

    try {
      const classification = await classifyMessage(message, classifyUnclear);
      if (classification.decision === 'manual_review') {
        counts.needsReview += 1;
        await store.record(message.id, { status: 'needs_review', decision: classification.decision, occurredAt: message.date, callbackAt: classification.callbackAt });
        outcomes.push({ messageId: message.id, status: 'needs_review', decision: classification.decision, reason: classification.reason });
        continue;
      }

      const resolved = await resolveReplyLead(message, findLead);
      if (!resolved.matched) {
        counts.needsReview += 1;
        await store.record(message.id, { status: 'needs_review', decision: classification.decision, occurredAt: message.date, callbackAt: classification.callbackAt, error: 'Kein eindeutiger CRM-Lead gefunden.' });
        outcomes.push({ messageId: message.id, status: 'needs_review', decision: classification.decision, reason: 'Kein eindeutiger CRM-Lead gefunden.' });
        continue;
      }

      const leadId = String(resolved.lead?.id || resolved.lead?.lead_id || '');
      if (!leadId) throw new Error('Der eindeutige CRM-Treffer besitzt keine Lead-ID.');
      const note = buildReplyNote(message, classification, { legacyGoodwillBefore });
      let attachment = null;
      if (classification.decision === 'reclamation') {
        const pdf = await createEmailPdfBuffer(message);
        attachment = { filename: emailPdfFilename(message), mimeType: 'application/pdf', bytes: pdf.length, base64: pdf.toString('base64') };
      }

      const action = {
        idempotencyKey: `gmail-too-often:${message.id}`,
        source: { provider: 'gmail', messageId: message.id, threadId: message.threadId || '', label: TOO_OFTEN_LABEL_NAME, occurredAt: message.date || '' },
        action: classification.decision,
        note,
        customerReply: classification.customerText,
        email: { from: clean(message.from, 500), to: clean(message.to, 500), cc: clean(message.cc, 500), subject: clean(message.subject, 500), date: clean(message.date, 200) },
        ...(classification.decision === 'reclamation' ? {
          reclamation: {
            reason: TOO_OFTEN_RECLAMATION_REASON,
            reasons: [TOO_OFTEN_RECLAMATION_REASON],
            otherText: buildReclamationOtherText(message, { legacyGoodwillBefore }),
            setStatusReklamiert: true,
          },
          attachment,
        } : {}),
        ...(classification.decision === 'follow_up' ? { followUp: { at: classification.callbackAt, assignedTo: TOO_OFTEN_FOLLOW_UP_OWNER, statusDetail: 'wiedervorlage' } } : {}),
        flags: { privacyRequest: classification.privacyRequest === true },
      };

      if (!writeEnabled) {
        counts.prepared += 1;
        await store.record(message.id, { status: 'prepared', decision: classification.decision, leadId, matchedBy: resolved.matchedBy, occurredAt: message.date, callbackAt: classification.callbackAt });
        outcomes.push({ messageId: message.id, status: 'prepared', decision: classification.decision, leadId, matchedBy: resolved.matchedBy, attachmentBytes: attachment?.bytes || 0 });
        continue;
      }
      if (typeof submitAction !== 'function') throw new Error('Der bestätigte CRM-Schreibadapter fehlt.');
      const submitted = await submitAction({ leadId, action });
      if (submitted?.verified !== true && submitted?.idempotentReplay !== true) throw new Error('Das CRM hat die Aktion nicht als gespeichert und rückgeprüft bestätigt.');
      counts[classification.decision === 'reclamation' ? 'reclamations' : 'followUps'] += 1;
      await store.record(message.id, { status: 'completed', decision: classification.decision, leadId, matchedBy: resolved.matchedBy, occurredAt: message.date, callbackAt: classification.callbackAt });
      outcomes.push({ messageId: message.id, status: 'completed', decision: classification.decision, leadId, matchedBy: resolved.matchedBy });
    } catch (error) {
      counts.failed += 1;
      await store.record(message.id, { status: 'failed', occurredAt: message.date, error: error.message });
      outcomes.push({ messageId: message.id, status: 'failed', error: error.message });
    }
  }

  const status = counts.failed ? 'failed' : writeEnabled ? 'completed' : 'prepared';
  const summary = writeEnabled
    ? `${counts.checked} Rückmeldungen geprüft: ${counts.reclamations} Reklamationen und ${counts.followUps} Wiedervorlagen gespeichert; ${counts.needsReview} Fälle benötigen Prüfung.`
    : `${counts.checked} Rückmeldungen geprüft: ${counts.prepared} sichere Aktionen vorbereitet; CRM-Schreiben bleibt bis zur Live-Freigabe gesperrt.`;
  await store.recordRun({ status, summary, counts, startedAt });
  return { status, writeEnabled, label: TOO_OFTEN_LABEL_NAME, counts, outcomes, summary };
}
