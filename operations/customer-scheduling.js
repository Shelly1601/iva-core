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

export function normalizePlanbarCapacitySnapshot(input = {}) {
  const byWeek = new Map();
  for (const item of (Array.isArray(input.weeks) ? input.weeks : [])) {
    const isoYear = Number(item?.isoYear);
    const week = Number(item?.week);
    const freeSlots = Number(item?.freeSlots);
    if (!Number.isInteger(isoYear) || isoYear < 2000 || isoYear > 2100) continue;
    if (!Number.isInteger(week) || week < 1 || week > 53) continue;
    if (!Number.isInteger(freeSlots) || freeSlots < 0 || freeSlots > 500) continue;
    byWeek.set(`${isoYear}-${week}`, { isoYear, week, freeSlots });
  }
  const weeks = [...byWeek.values()].sort((left, right) => left.isoYear - right.isoYear || left.week - right.week);
  const parsedUpdatedAt = new Date(input.updatedAt || Date.now());
  return {
    updatedAt: Number.isNaN(parsedUpdatedAt.getTime()) ? new Date().toISOString() : parsedUpdatedAt.toISOString(),
    source: 'Planbar · sichtbare Blöcke „Geblockt für Kunde ENTER“',
    excludedResources: ['Dawid Service', 'Antonio Lausic'],
    weeks,
  };
}

export function planbarCapacityWindow(snapshot = {}, { offset = 0, size = 4 } = {}) {
  const normalized = normalizePlanbarCapacitySnapshot(snapshot);
  const safeSize = Math.max(1, Math.min(12, Number(size) || 4));
  const maxOffset = Math.max(0, normalized.weeks.length - safeSize);
  const safeOffset = Math.max(0, Math.min(maxOffset, Number(offset) || 0));
  const weeks = normalized.weeks.slice(safeOffset, safeOffset + safeSize);
  return {
    ...normalized,
    offset: safeOffset,
    size: safeSize,
    maxOffset,
    weeks,
    totalFreeSlots: weeks.reduce((sum, item) => sum + item.freeSlots, 0),
    nextAvailable: normalized.weeks.find(item => item.freeSlots > 0) || null,
    hasPrevious: safeOffset > 0,
    hasNext: safeOffset < maxOffset,
  };
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

export function buildEnterPlanbarCustomer({ firstName, lastName, address, email, phone, phoneKind = 'Telefon' }) {
  const cleanFirstName = String(firstName || '').trim().replace(/^(?:EN|HH)\s+/i, '');
  const cleanLastName = String(lastName || '').trim();
  if (!cleanFirstName || !cleanLastName) throw new Error('Vor- und Nachname sind Pflichtfelder.');
  if (!String(address || '').trim() || !String(email || '').trim() || !String(phone || '').trim()) {
    throw new Error('Adresse, E-Mail-Adresse und Telefonnummer müssen vollständig belegt sein.');
  }

  return {
    firstName: `EN ${cleanFirstName}`,
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

export function selectFirstPlanbarEnterBlocker({ resources, bookings = [], year, week }) {
  if (!Array.isArray(resources) || !resources.length) throw new Error('Keine Planbar-Ressourcen vorhanden.');
  const { startDate, endDateExclusive } = isoWeekRange(year, week);
  const resourceById = new Map(resources.map((resource, index) => [String(resource?.id || ''), { resource, index }]));
  const isEnterBlocker = booking => String(booking?.text || booking?.description || booking?.title || '').trim() === 'Geblockt für Kunde ENTER';

  const candidates = bookings
    .filter(isEnterBlocker)
    .filter(booking => overlaps(startDate, endDateExclusive, booking))
    .map(booking => ({ booking, match: resourceById.get(String(booking?.resourceId || '')) }))
    .filter(item => item.match?.resource?.id && !isExcludedPlanbarResource(item.match.resource.name))
    .filter(item => !bookings.some(other => other !== item.booking
      && String(other?.resourceId || '') === String(item.booking?.resourceId || '')
      && !isEnterBlocker(other)
      && overlaps(
        String(item.booking.startDate || item.booking.start || ''),
        String(item.booking.endDateExclusive || item.booking.end || item.booking.startDate || item.booking.start || ''),
        other,
      )))
    .sort((left, right) => left.match.index - right.match.index
      || String(left.booking.startDate || left.booking.start || '').localeCompare(String(right.booking.startDate || right.booking.start || '')));

  if (!candidates.length) throw new Error('In der gewünschten Kalenderwoche ist kein zulässiger ENTER-Blocker vorhanden.');
  return {
    ...candidates[0].booking,
    resource: candidates[0].match.resource,
  };
}

export function buildPlanbarSchedulingExtras({ materialDeliverySpace, theftWeatherProtected, additionalInfo = '' }) {
  const lines = [
    `Materialannahme einige Tage vor Montagebeginn: ${materialDeliverySpace === true ? 'Ja' : 'Nein'}`,
    `Diebstahl- und wettersicher: ${theftWeatherProtected === true ? 'Ja' : 'Nein'}`,
  ];
  const cleanAdditionalInfo = String(additionalInfo || '').trim();
  if (cleanAdditionalInfo) lines.push(`Zusatzinfo: ${cleanAdditionalInfo}`);
  return lines;
}

export function buildPipedriveCompletion({ year, week, currentStage, visibleStages }) {
  isoWeekRange(year, week);
  if (!Array.isArray(visibleStages) || visibleStages.length < 2) {
    throw new Error('Die sichtbare Pipedrive-Phasenleiste ist unvollständig.');
  }

  const currentKey = normalizedText(currentStage);
  const currentIndex = visibleStages.findIndex(stage => normalizedText(stage) === currentKey);
  if (currentIndex < 0) throw new Error('Die aktuelle Pipedrive-Phase ist in der sichtbaren Phasenleiste nicht eindeutig belegt.');
  if (currentIndex >= visibleStages.length - 1) throw new Error('Die aktuelle Pipedrive-Phase ist bereits die letzte sichtbare Phase.');

  return {
    fieldName: 'Einbautermin Kalenderwoche',
    fieldValue: `KW${Number(week)}`,
    sourceStage: String(visibleStages[currentIndex]).trim(),
    targetStage: String(visibleStages[currentIndex + 1]).trim(),
    allowAutomaticDealTitleWeekSuffix: true,
  };
}

export const CUSTOMER_SCHEDULING_RULES = Object.freeze({
  excludedResources: [...EXCLUDED_RESOURCE_KEYS],
  allowedSourceStages: [...ALLOWED_SOURCE_STAGES],
  pipedriveWeekField: 'Einbautermin Kalenderwoche',
  allowAutomaticDealTitleWeekSuffix: true,
});
