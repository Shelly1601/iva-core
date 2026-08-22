import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || '/data';
const STORE_FILE = path.join(DATA_DIR, 'planbar-search-index.json');
const MAX_APPOINTMENTS = 3000;

function clean(value, max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizedText(value) {
  return clean(value, 5000)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('de-DE');
}

function validDate(value) {
  const text = clean(value, 20);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? text : '';
}

function addDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function isoWeek(value) {
  const date = new Date(`${value}T00:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return {
    isoYear: date.getUTCFullYear(),
    week: Math.ceil((((date - yearStart) / 86400000) + 1) / 7),
  };
}

function berlinDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function normalizeAppointment(input = {}) {
  const customerName = clean(input.customerName, 220);
  const description = clean(input.description, 3000);
  const team = clean(input.team, 260);
  const resourceId = clean(input.resourceId, 140);
  const startDate = validDate(input.startDate);
  const endDateExclusive = validDate(input.endDateExclusive) || (startDate ? addDays(startDate, 1) : '');
  if (!customerName || !team || !startDate || !endDateExclusive || endDateExclusive <= startDate) return null;
  const weekInfo = isoWeek(startDate);
  const fingerprint = [resourceId, customerName, startDate, endDateExclusive, description].join('|');
  return {
    id: clean(input.id, 180) || crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 24),
    customerName,
    description,
    team,
    resourceId,
    startDate,
    endDateExclusive,
    isoYear: weekInfo.isoYear,
    week: weekInfo.week,
  };
}

export function normalizePlanbarSearchIndex(input = {}) {
  const parsedUpdatedAt = new Date(input.updatedAt || Date.now());
  const byId = new Map();
  for (const raw of (Array.isArray(input.appointments) ? input.appointments : [])) {
    const appointment = normalizeAppointment(raw);
    if (appointment) byId.set(appointment.id, appointment);
  }
  const appointments = [...byId.values()]
    .sort((left, right) => left.startDate.localeCompare(right.startDate) || left.team.localeCompare(right.team, 'de'))
    .slice(0, MAX_APPOINTMENTS);
  return {
    version: 1,
    updatedAt: Number.isNaN(parsedUpdatedAt.getTime()) ? new Date().toISOString() : parsedUpdatedAt.toISOString(),
    source: 'Planbar · verifizierter Leseindex',
    rangeStart: validDate(input.rangeStart) || appointments[0]?.startDate || '',
    rangeEndExclusive: validDate(input.rangeEndExclusive) || appointments.at(-1)?.endDateExclusive || '',
    appointments,
  };
}

async function readIndex() {
  try {
    return normalizePlanbarSearchIndex(JSON.parse(await fs.readFile(STORE_FILE, 'utf8')));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return normalizePlanbarSearchIndex({ appointments: [], updatedAt: new Date(0).toISOString() });
  }
}

export async function replacePlanbarSearchIndex(input = {}) {
  const index = normalizePlanbarSearchIndex(input);
  if (!index.appointments.length) throw new Error('Der Planbar-Stand enthält keine eindeutig lesbaren Kundentermine.');
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, STORE_FILE);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
  return { ...index, appointmentCount: index.appointments.length };
}

export async function getPlanbarSearchIndex() {
  const index = await readIndex();
  return { ...index, appointmentCount: index.appointments.length };
}

export async function searchPlanbarAppointments({ query, weeks = 0, fromDate } = {}) {
  const cleanQuery = clean(query, 220);
  if (cleanQuery.length < 2) throw new Error('Bitte mindestens zwei Zeichen für die Planbar-Suche eingeben.');
  const safeWeeks = Math.max(0, Math.min(16, Number(weeks) || 0));
  const rangeStart = validDate(fromDate) || berlinDate();
  const rangeEndExclusive = safeWeeks ? addDays(rangeStart, safeWeeks * 7) : '';
  const tokens = normalizedText(cleanQuery).split(/\s+/).filter(Boolean);
  const index = await readIndex();
  const matches = index.appointments.filter(item => {
    if (rangeEndExclusive && !(item.startDate < rangeEndExclusive && item.endDateExclusive > rangeStart)) return false;
    const haystack = normalizedText(`${item.customerName} ${item.description} ${item.team}`);
    return tokens.every(token => haystack.includes(token));
  });
  return {
    query: cleanQuery,
    weeks: safeWeeks,
    fromDate: rangeStart,
    toDateExclusive: rangeEndExclusive || null,
    updatedAt: index.updatedAt,
    source: index.source,
    indexedRange: { startDate: index.rangeStart || null, endDateExclusive: index.rangeEndExclusive || null },
    indexedAppointments: index.appointments.length,
    stale: Date.now() - Date.parse(index.updatedAt || 0) > 36 * 60 * 60 * 1000,
    count: matches.length,
    matches,
  };
}

export const planbarSearchInternals = Object.freeze({ addDays, isoWeek, normalizeAppointment, normalizedText });
