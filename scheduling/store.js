import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = process.env.DATA_DIR || '/data';
const STORE_FILE = path.join(DATA_DIR, 'scheduling.json');
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
let writeQueue = Promise.resolve();

async function loadStore() {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE_FILE, 'utf8'));
    return { version: 1, appointmentTypes: Array.isArray(parsed.appointmentTypes) ? parsed.appointmentTypes : [], bookings: Array.isArray(parsed.bookings) ? parsed.bookings : [] };
  } catch { return { version: 1, appointmentTypes: [], bookings: [] }; }
}

async function saveStore(data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STORE_FILE}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data, null, 2));
  await fs.rename(temporary, STORE_FILE);
}

function mutate(fn) {
  const job = writeQueue.then(async () => {
    const data = await loadStore();
    const result = await fn(data);
    await saveStore(data);
    return result;
  });
  writeQueue = job.catch(() => {});
  return job;
}

function text(value, max = 1000) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function number(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}
function slugify(value) {
  return text(value, 100).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || `termin-${crypto.randomUUID().slice(0, 8)}`;
}
function normalizeWindows(value) {
  const windows = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  for (const weekday of WEEKDAYS) {
    out[weekday] = (Array.isArray(windows[weekday]) ? windows[weekday] : [])
      .map(window => ({ start: text(window?.start, 5), end: text(window?.end, 5) }))
      .filter(window => /^\d{2}:\d{2}$/.test(window.start) && /^\d{2}:\d{2}$/.test(window.end) && window.start < window.end)
      .slice(0, 4);
  }
  return out;
}
function defaultAvailability() {
  return { sun: [], mon: [{ start: '09:00', end: '17:00' }], tue: [{ start: '09:00', end: '17:00' }], wed: [{ start: '09:00', end: '17:00' }], thu: [{ start: '09:00', end: '17:00' }], fri: [{ start: '09:00', end: '15:00' }], sat: [] };
}
function normalizeType(input = {}, existing = {}) {
  const now = new Date().toISOString();
  const name = text(input.name, 160) || existing.name || 'Kennenlerngespräch';
  return {
    id: existing.id || crypto.randomUUID(),
    name,
    slug: slugify(input.slug || existing.slug || name),
    description: text(input.description, 2000) || existing.description || '',
    durationMinutes: number(input.durationMinutes, existing.durationMinutes || 30, 15, 240),
    timeZone: text(input.timeZone, 80) || existing.timeZone || 'Europe/Berlin',
    locationKind: ['phone', 'video', 'onsite'].includes(input.locationKind) ? input.locationKind : existing.locationKind || 'video',
    locationDetails: text(input.locationDetails, 500) || existing.locationDetails || '',
    minNoticeHours: number(input.minNoticeHours, existing.minNoticeHours ?? 24, 1, 720),
    maxDaysAhead: number(input.maxDaysAhead, existing.maxDaysAhead || 60, 1, 365),
    bufferBeforeMinutes: number(input.bufferBeforeMinutes, existing.bufferBeforeMinutes || 0, 0, 120),
    bufferAfterMinutes: number(input.bufferAfterMinutes, existing.bufferAfterMinutes || 15, 0, 120),
    availability: normalizeWindows(input.availability || existing.availability || defaultAvailability()),
    active: input.active === true,
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

export async function listAppointmentTypes() {
  return clone((await loadStore()).appointmentTypes.sort((a, b) => a.name.localeCompare(b.name, 'de')));
}

export async function getAppointmentTypeBySlug(slug, { includeInactive = false } = {}) {
  const type = (await loadStore()).appointmentTypes.find(item => item.slug === slug && (includeInactive || item.active));
  return type ? clone(type) : null;
}

export async function createAppointmentType(input = {}) {
  return mutate(data => {
    const type = normalizeType({ ...input, active: false });
    const known = new Set(data.appointmentTypes.map(item => item.slug));
    let slug = type.slug;
    let suffix = 2;
    while (known.has(slug)) slug = `${type.slug}-${suffix++}`;
    type.slug = slug;
    data.appointmentTypes.push(type);
    return clone(type);
  });
}

export async function updateAppointmentType(id, input = {}, { allowActivation = false } = {}) {
  return mutate(data => {
    const index = data.appointmentTypes.findIndex(item => item.id === id);
    if (index < 0) return null;
    if (input.active === true && !allowActivation) throw new Error('Live-Buchung bleibt gesperrt, bis Kalender-Schreibzugriff und Bestätigungs-Mail verbunden sind.');
    const next = normalizeType({ ...data.appointmentTypes[index], ...input, active: input.active === true }, data.appointmentTypes[index]);
    const duplicate = data.appointmentTypes.find(item => item.id !== id && item.slug === next.slug);
    if (duplicate) throw new Error('Dieser Terminlink ist bereits vergeben.');
    data.appointmentTypes[index] = next;
    return clone(next);
  });
}

function berlinParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}
function berlinLocalToDate(day, time) {
  const candidate = new Date(`${day}T${time}:00+01:00`);
  const summerProbe = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', timeZoneName: 'shortOffset', hour: '2-digit' }).formatToParts(candidate).find(part => part.type === 'timeZoneName')?.value || 'GMT+1';
  const match = summerProbe.match(/GMT([+-]\d+)(?::(\d+))?/);
  const hours = Number(match?.[1] || 1);
  const minutes = Number(match?.[2] || 0);
  const sign = hours < 0 ? '-' : '+';
  const offset = `${sign}${String(Math.abs(hours)).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  return new Date(`${day}T${time}:00${offset}`);
}
function overlaps(start, end, booking, type) {
  const bookingStart = new Date(booking.startAt).getTime() - (type.bufferBeforeMinutes || 0) * 60_000;
  const bookingEnd = new Date(booking.endAt).getTime() + (type.bufferAfterMinutes || 0) * 60_000;
  return start.getTime() < bookingEnd && end.getTime() > bookingStart;
}

export async function listAvailableSlots(type, { from = new Date(), days = 14 } = {}) {
  const data = await loadStore();
  const startFloor = new Date(Math.max(from.getTime(), Date.now() + type.minNoticeHours * 60 * 60 * 1000));
  const endLimit = new Date(Date.now() + Math.min(days, type.maxDaysAhead) * 86400000);
  const bookings = data.bookings.filter(item => item.appointmentTypeId === type.id && item.status === 'confirmed');
  const slots = [];
  for (let cursor = new Date(startFloor); cursor <= endLimit; cursor = new Date(cursor.getTime() + 86400000)) {
    const parts = berlinParts(cursor);
    const weekday = parts.weekday.toLowerCase().slice(0, 3);
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    for (const window of type.availability?.[weekday] || []) {
      const windowStart = berlinLocalToDate(day, window.start);
      const windowEnd = berlinLocalToDate(day, window.end);
      for (let slotStart = windowStart; slotStart.getTime() + type.durationMinutes * 60_000 <= windowEnd.getTime(); slotStart = new Date(slotStart.getTime() + type.durationMinutes * 60_000)) {
        const slotEnd = new Date(slotStart.getTime() + type.durationMinutes * 60_000);
        if (slotStart < startFloor || bookings.some(booking => overlaps(slotStart, slotEnd, booking, type))) continue;
        slots.push({ startAt: slotStart.toISOString(), endAt: slotEnd.toISOString() });
        if (slots.length >= 100) return slots;
      }
    }
  }
  return slots;
}

export async function listBookings({ limit = 200 } = {}) {
  const data = await loadStore();
  return clone(data.bookings.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, Math.min(Math.max(Number(limit) || 200, 1), 1000)));
}

export async function createBooking(slug, input = {}) {
  return mutate(async data => {
    const type = data.appointmentTypes.find(item => item.slug === slug && item.active);
    if (!type) throw new Error('Dieser Terminlink ist nicht aktiv.');
    if (input.privacyConsent !== true) throw new Error('Die Datenschutzeinwilligung ist erforderlich.');
    const startAt = new Date(input.startAt);
    if (Number.isNaN(startAt.getTime())) throw new Error('Ungültiger Termin.');
    const allowed = await listAvailableSlots(type, { from: new Date(), days: type.maxDaysAhead });
    const slot = allowed.find(item => item.startAt === startAt.toISOString());
    if (!slot) throw new Error('Dieser Termin ist nicht mehr verfügbar.');
    const now = new Date().toISOString();
    const booking = {
      id: crypto.randomUUID(), appointmentTypeId: type.id, appointmentTypeName: type.name,
      startAt: slot.startAt, endAt: slot.endAt, status: 'confirmed',
      customerName: text(input.customerName, 200), customerEmail: text(input.customerEmail, 320), customerPhone: text(input.customerPhone, 100),
      note: text(input.note, 3000), privacyConsentAt: now, createdAt: now, updatedAt: now,
    };
    if (!booking.customerName || !/^\S+@\S+\.\S+$/.test(booking.customerEmail)) throw new Error('Name und gültige E-Mail-Adresse sind erforderlich.');
    data.bookings.push(booking);
    return { booking: clone(booking), appointmentType: clone(type) };
  });
}

export function createBookingIcs(booking, type) {
  const stamp = date => new Date(date).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const escape = value => String(value || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//IVA//Terminbuchung//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${booking.id}@iva`, `DTSTAMP:${stamp(booking.createdAt)}`, `DTSTART:${stamp(booking.startAt)}`, `DTEND:${stamp(booking.endAt)}`,
    `SUMMARY:${escape(type.name)}`, `DESCRIPTION:${escape(type.description)}`, `LOCATION:${escape(type.locationDetails)}`, 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}
