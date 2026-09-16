const TIME_ZONE = 'Europe/Berlin';
const FREQUENCIES = new Set(['once', 'daily', 'weekly', 'monthly']);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const formatter = new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', {
  timeZone: TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID_RESEARCH_SCHEDULE' });
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
    throw invalid(`${label} muss ein Objekt sein.`);
  }
  return value;
}

function timeZoneValue(value) {
  if (value.timeZone !== undefined && value.timezone !== undefined && value.timeZone !== value.timezone) {
    throw invalid('Die Zeitzonenangaben widersprechen sich.');
  }
  return value.timeZone !== undefined ? value.timeZone : value.timezone;
}

function integer(value, minimum, maximum, label) {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && !/^\d+$/.test(value.trim()))) {
    throw invalid(`${label} muss eine ganze Zahl zwischen ${minimum} und ${maximum} sein.`);
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw invalid(`${label} muss eine ganze Zahl zwischen ${minimum} und ${maximum} sein.`);
  }
  return number;
}

/**
 * Normalize a full schedule or a partial update. Undefined fields retain the
 * existing value; explicit invalid values are rejected. `timezone` is accepted
 * as a legacy input alias, while output always uses `timeZone`.
 */
export function normalizeResearchSchedule(input = {}, existing = {}) {
  object(input, 'Der Recherche-Zeitplan');
  object(existing, 'Der vorhandene Recherche-Zeitplan');
  const field = (key, fallback) => input[key] !== undefined ? input[key]
    : existing[key] !== undefined ? existing[key] : fallback;
  const frequency = field('frequency', 'once');
  if (!FREQUENCIES.has(frequency)) throw invalid('Häufigkeit muss once, daily, weekly oder monthly sein.');
  const time = field('time', '09:00');
  if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw invalid('Die Uhrzeit muss im Format HH:mm zwischen 00:00 und 23:59 liegen.');
  }
  const inputZone = timeZoneValue(input);
  const previousZone = timeZoneValue(existing);
  const timeZone = inputZone !== undefined ? inputZone : previousZone !== undefined ? previousZone : TIME_ZONE;
  if (timeZone !== TIME_ZONE) throw invalid('Der Recherche-Zeitplan unterstützt derzeit nur Europe/Berlin.');
  return {
    frequency,
    time,
    weekday: integer(field('weekday', 1), 1, 7, 'Der Wochentag'),
    dayOfMonth: integer(field('dayOfMonth', 1), 1, 31, 'Der Monatstag'),
    timeZone,
  };
}

function utcTimestamp({ year, month, day, hour = 0, minute = 0, second = 0 }) {
  // setUTCFullYear also handles years 0..99 without Date.UTC's 1900 offset.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (!Number.isFinite(date.getTime())) throw invalid('Das Datum liegt außerhalb des unterstützten Bereichs.');
  return date.getTime();
}

function berlinParts(timestamp) {
  const values = {};
  for (const part of formatter.formatToParts(timestamp)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return values;
}

function calendarDate(timestamp) {
  const date = new Date(timestamp);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function localOccurrence(date, time) {
  const [hour, minute] = time.split(':').map(Number);
  const requested = utcTimestamp({ ...date, hour, minute });
  // These nearby samples expose both Berlin offsets on a clock-change day.
  // All arithmetic describes calendar fields; it never uses the host timezone.
  const offsets = [...new Set([-36, 0, 36].map(hours => {
    const sample = requested + hours * 60 * MINUTE;
    return utcTimestamp(berlinParts(sample)) - sample;
  }))];

  // Spring policy: 02:30 in the missing hour becomes 03:00, the first existing
  // local minute, rather than 03:30. Berlin gaps fit comfortably in this bound.
  for (let minutesLater = 0; minutesLater <= 180; minutesLater += 1) {
    const localMinute = requested + minutesLater * MINUTE;
    const matches = offsets.map(offset => localMinute - offset)
      .filter(timestamp => utcTimestamp(berlinParts(timestamp)) === localMinute);
    // Autumn policy: always select the earlier occurrence of a repeated minute.
    // This selection is independent of `afterDate`, so the second occurrence
    // cannot become a second scheduled run for the same local calendar date.
    if (matches.length) return Math.min(...matches);
  }
  throw invalid('Für diese lokale Uhrzeit konnte kein Ausführungszeitpunkt bestimmt werden.');
}

function afterTimestamp(value) {
  if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') {
    throw invalid('Der Ausgangszeitpunkt ist ungültig.');
  }
  // A string must carry its timezone so scheduling is independent of server TZ.
  if (typeof value === 'string') {
    const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/);
    if (!parts) throw invalid('Der Ausgangszeitpunkt muss ein ISO-Datum mit Zeitzone sein.');
    const [year, month, day, hour, minute, second = 0] = parts.slice(1, 7).map(value => value === undefined ? 0 : Number(value));
    const calendar = calendarDate(utcTimestamp({ year, month, day }));
    // Date.parse otherwise silently turns e.g. February 30 into a March date.
    if (calendar.year !== year || calendar.month !== month || calendar.day !== day
      || hour > 23 || minute > 59 || second > 59 || Number(parts[8] || 0) > 23 || Number(parts[9] || 0) > 59) {
      throw invalid('Der Ausgangszeitpunkt enthält ein ungültiges Datum oder eine ungültige Uhrzeit.');
    }
  }
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw invalid('Der Ausgangszeitpunkt ist ungültig.');
  return timestamp;
}

/**
 * Return the first canonical occurrence strictly after `afterDate` as a UTC ISO
 * string. `once` returns null: the service queues that initial run on creation.
 * Monthly days are clamped to the month's last day without changing the saved
 * dayOfMonth (31 => Feb 28/29, then Mar 31). No catch-up runs are generated.
 * DST: spring gaps use the first existing later minute; autumn folds use only
 * the earlier instance. Callers still persist/claim a run to deduplicate ticks.
 */
export function nextResearchRunAt(schedule, afterDate = new Date()) {
  const normalized = normalizeResearchSchedule(schedule);
  if (normalized.frequency === 'once') return null;
  const after = afterTimestamp(afterDate);
  const { year, month, day } = berlinParts(after);
  const today = utcTimestamp({ year, month, day });
  const weekday = new Date(today).getUTCDay() || 7;

  // At most today's and the next period's occurrence are normally needed. The
  // bounded loop also makes date-range failures explicit rather than spinning.
  for (let period = 0; period < 3; period += 1) {
    let target;
    if (normalized.frequency === 'monthly') {
      const first = calendarDate(utcTimestamp({ year, month: month + period, day: 1 }));
      const lastDay = new Date(utcTimestamp({ year: first.year, month: first.month + 1, day: 0 })).getUTCDate();
      target = { ...first, day: Math.min(normalized.dayOfMonth, lastDay) };
    } else {
      const daysLater = normalized.frequency === 'weekly'
        ? (normalized.weekday - weekday + 7) % 7 + period * 7 : period;
      target = calendarDate(today + daysLater * DAY);
    }
    const occurrence = localOccurrence(target, normalized.time);
    if (occurrence > after) return new Date(occurrence).toISOString();
  }
  throw invalid('Der nächste Ausführungszeitpunkt konnte nicht bestimmt werden.');
}
