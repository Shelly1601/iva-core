const EXCLUDED_RESOURCE_KEYS = new Set([
  'david service',
  'dawid service',
  'antonio lausic',
  'antonio lausich',
  'antonio lausitsch',
]);

const ALLOWED_SOURCE_STAGES = new Set([
  'förderung beantragen',
  'foerderung beantragen',
  'montage einplanen',
  'montage terminieren',
]);

function normalizedText(value) {
  return String(value || '').trim().toLocaleLowerCase('de-DE').replace(/\s+/g, ' ');
}

function utcDateString(date) {
  return date.toISOString().slice(0, 10);
}

export function isoWeekRange(year, week) {
  const numericYear = Number(year);
  const numericWeek = Number(week);
  if (!Number.isInteger(numericYear) || numericYear < 2000 || numericYear > 2100) {
    throw new Error('Ungültiges ISO-Kalenderjahr.');
  }
  if (!Number.isInteger(numericWeek) || numericWeek < 1 || numericWeek > 53) {
    throw new Error('Ungültige ISO-Kalenderwoche.');
  }

  const januaryFourth = new Date(Date.UTC(numericYear, 0, 4));
  const mondayOfWeekOne = new Date(januaryFourth);
  mondayOfWeekOne.setUTCDate(januaryFourth.getUTCDate() - ((januaryFourth.getUTCDay() + 6) % 7));

  const monday = new Date(mondayOfWeekOne);
  monday.setUTCDate(mondayOfWeekOne.getUTCDate() + ((numericWeek - 1) * 7));
  const saturdayExclusive = new Date(monday);
  saturdayExclusive.setUTCDate(monday.getUTCDate() + 5);

  return {
    startDate: utcDateString(monday),
    endDateExclusive: utcDateString(saturdayExclusive),
  };
}

export function isExcludedPlanbarResource(name) {
  return EXCLUDED_RESOURCE_KEYS.has(normalizedText(name));
}

export function assertSchedulableSourceStage(stage) {
  if (!ALLOWED_SOURCE_STAGES.has(normalizedText(stage))) {
    throw new Error('Der Deal liegt weder in „Förderung beantragen“ noch in „Montage einplanen/terminieren“.');
  }
  return true;
}

export function buildPlanbarCustomer({ firstName, lastName, address, email, phone, phoneKind = 'Telefon' }) {
  const cleanFirstName = String(firstName || '').trim().replace(/^HH\s+/i, '');
  const cleanLastName = String(lastName || '').trim();
  if (!cleanFirstName || !cleanLastName) throw new Error('Vor- und Nachname sind Pflichtfelder.');
  if (!String(address || '').trim() || !String(email || '').trim() || !String(phone || '').trim()) {
    throw new Error('Adresse, E-Mail-Adresse und Telefonnummer müssen vollständig belegt sein.');
  }

  return {
    firstName: `HH ${cleanFirstName}`,
    lastName: cleanLastName,
    address: String(address).trim(),
    email: String(email).trim(),
    phone: String(phone).trim(),
    phoneKind: normalizedText(phoneKind) === 'mobil' ? 'Mobil' : 'Telefon',
  };
}

function overlaps(startDate, endDateExclusive, booking) {
  const bookingStart = String(booking.startDate || booking.start || '');
  const bookingEnd = String(booking.endDateExclusive || booking.end || bookingStart);
  return bookingStart < endDateExclusive && bookingEnd > startDate;
}

export function selectFirstFreePlanbarResource({ resources, bookings = [], startDate, endDateExclusive }) {
  if (!Array.isArray(resources) || !resources.length) throw new Error('Keine Planbar-Ressourcen vorhanden.');
  if (!startDate || !endDateExclusive || startDate >= endDateExclusive) throw new Error('Ungültiger Terminzeitraum.');

  for (const resource of resources) {
    if (!resource?.id || isExcludedPlanbarResource(resource.name)) continue;
    const occupied = bookings.some(booking => String(booking.resourceId) === String(resource.id)
      && overlaps(startDate, endDateExclusive, booking));
    if (!occupied) return resource;
  }

  throw new Error('In der gewünschten Kalenderwoche ist keine zulässige Ressource vollständig von Montag bis Freitag frei.');
}

export const CUSTOMER_SCHEDULING_RULES = Object.freeze({
  excludedResources: [...EXCLUDED_RESOURCE_KEYS],
  allowedSourceStages: [...ALLOWED_SOURCE_STAGES],
});
