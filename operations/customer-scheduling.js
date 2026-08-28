import { createHash } from 'node:crypto';

export const PLANBAR_SCHEDULING_RULE_VERSION = 'reserve-first-v1';

export function planbarSchedulingKey({ customerName, partnerId, partnerPrefix, isoYear, week, source, objectLocation }) {
  return createHash('sha256').update(JSON.stringify([
    normalizedText(customerName), normalizedText(partnerId || partnerPrefix), Number(isoYear), Number(week),
    ...(source === 'public-heat-hero' ? ['public-heat-hero', normalizedText(objectLocation)] : []),
  ])).digest('hex');
}

// Only observed, re-opened Planbar records may supply this receipt. An accepted
// device command or a successful process exit is never a reservation receipt.
export function mergePlanbarSchedulingProgress(previous = null, input = {}) {
  if (!['reserved', 'details_pending', 'completed'].includes(input.status)) throw new Error('Ungültiger Planbar-Fachstatus.');
  if (!previous?.reservation && input.status !== 'reserved') throw new Error('Zuerst muss der Slot verifiziert reserviert sein.');
  const reservation = input.reservation || previous?.reservation;
  if (!reservation || reservation.verified !== true || reservation.identityVerified !== true) throw new Error('Der Planbar-Reservierungsnachweis fehlt.');
  const { startDate, endDateExclusive } = isoWeekRange(reservation.isoYear, reservation.week);
  if (reservation.startDate !== startDate || reservation.endDateExclusive !== endDateExclusive) throw new Error('Der Planbar-Termin umfasst nicht die beauftragte Montag-bis-Freitag-Woche.');
  for (const field of ['customerId', 'appointmentId', 'resourceId', 'resourceName']) {
    if (typeof reservation[field] !== 'string' || !reservation[field].trim() || reservation[field].length > 180) throw new Error(`Planbar-Nachweis fehlt: ${field}`);
  }
  if (isExcludedPlanbarResource(reservation.resourceName)) throw new Error('Ausgeschlossene Planbar-Ressource.');
  if (!Number.isFinite(Date.parse(reservation.verifiedAt)) || Date.parse(reservation.verifiedAt) > Date.now() + 60_000) throw new Error('Der Planbar-Prüfzeitpunkt fehlt oder ist ungültig.');
  const proof = Object.fromEntries(['customerId', 'appointmentId', 'resourceId', 'resourceName', 'isoYear', 'week', 'startDate', 'endDateExclusive', 'verifiedAt', 'verified', 'identityVerified'].map(key => [key, reservation[key]]));
  if (previous?.reservation) {
    for (const key of ['customerId', 'appointmentId', 'resourceId', 'isoYear', 'week', 'startDate', 'endDateExclusive']) {
      if (previous.reservation[key] !== proof[key]) throw new Error('Die gesicherte Planbar-Reservierung darf nicht ersetzt oder verschoben werden.');
    }
  }
  const missingDetails = (input.missingDetails ?? previous?.missingDetails ?? ['Auftragsnummer', 'Leistungsbeschreibung'])
    .map(value => String(value).trim().slice(0, 180)).filter(Boolean).slice(0, 20);
  const remainingActions = (input.remainingActions ?? previous?.remainingActions ?? ['Pipedrive-Abschluss', 'WhatsApp-Bestätigung'])
    .map(value => String(value).trim().slice(0, 180)).filter(Boolean).slice(0, 20);
  const sourceCheck = input.sourceCheck || previous?.sourceCheck || null;
  if (sourceCheck) {
    assertSchedulableSourceStage(sourceCheck.stage);
    if (sourceCheck.partnerId !== 'heat-hero' || !/^[0-9]+$/.test(sourceCheck.dealId || '')
      || sourceCheck.identityVerified !== true || sourceCheck.objectLocationMatched !== true
      || !Number.isFinite(Date.parse(sourceCheck.verifiedAt)) || Date.parse(sourceCheck.verifiedAt) > Date.now() + 60_000) throw new Error('Der belegte Heat-Hero-Kundenabgleich fehlt.');
  }
  const confirmationMail = input.confirmationMail || previous?.confirmationMail || null;
  if (previous?.sourceCheck && sourceCheck.dealId !== previous.sourceCheck.dealId) throw new Error('Der verifizierte Kundenauftrag darf nicht ersetzt werden.');
  if (previous?.confirmationMail && ['messageId', 'recipientHash', 'from', 'sentAt'].some(key => confirmationMail[key] !== previous.confirmationMail[key])) throw new Error('Der verifizierte Mailnachweis darf nicht ersetzt werden.');
  if (confirmationMail && (confirmationMail.verified !== true || typeof confirmationMail.messageId !== 'string' || !confirmationMail.messageId || confirmationMail.messageId.length > 300
    || confirmationMail.from !== 'n.sell@heat-hero.com' || !/^[a-f0-9]{64}$/.test(confirmationMail.recipientHash || '')
    || !Number.isFinite(Date.parse(confirmationMail.sentAt)) || Date.parse(confirmationMail.sentAt) > Date.now() + 60_000
    || Date.parse(confirmationMail.sentAt) < Date.parse(reservation.verifiedAt))) throw new Error('Der geprüfte Bestätigungs-Mailnachweis fehlt.');
  if (input.status === 'completed' && (missingDetails.length || remainingActions.length || input.completionVerified !== true)) throw new Error('Offene Ergänzungen oder Folgeaktionen dürfen nicht als vollständig gemeldet werden.');
  if (previous?.status === 'completed' && input.status !== 'completed') throw new Error('Ein vollständig geprüfter Auftrag darf nicht zurückgesetzt werden.');
  return { status: input.status, reservation: proof, missingDetails, remainingActions,
    ...(sourceCheck ? { sourceCheck: Object.fromEntries(['dealId', 'partnerId', 'stage', 'identityVerified', 'objectLocationMatched', 'verifiedAt'].map(key => [key, sourceCheck[key]])) } : {}),
    ...(confirmationMail ? { confirmationMail: Object.fromEntries(['messageId', 'from', 'recipientHash', 'sentAt', 'verified'].map(key => [key, confirmationMail[key]])) } : {}),
    completionVerified: input.status === 'completed', updatedAt: new Date().toISOString(), ruleVersion: PLANBAR_SCHEDULING_RULE_VERSION };
}

export function planbarSchedulingSummary(progress) {
  if (!progress?.reservation?.verified) return 'Noch kein gesicherter Planbar-Slot bestätigt.';
  if (progress.status === 'completed') return 'Slot in Planbar gesichert – Angaben und Folgeaktionen vollständig geprüft.';
  const open = [...(progress.missingDetails || []), ...(progress.remainingActions || [])];
  return `Slot in Planbar gesichert – ${progress.missingDetails?.length ? 'Angaben noch offen' : 'Nacharbeiten offen'}${open.length ? ': ' + open.join(', ') : '.'}`;
}

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
  'förderung beantragt',
  'foerderung beantragt',
  'montage einplanen',
  'montage terminieren',
]);

export const PLANBAR_ENTER_BLOCK_TEXT = 'Geblockt für Kunde ENTER';
export const PLANBAR_MINIMUM_BLOCK_DAYS = 5;
export const PLANBAR_CAPACITY_RULE_VERSION = 'free-full-workweek-v3';
export const DEFAULT_CUSTOMER_SCHEDULING_PARTNERS = Object.freeze([
  Object.freeze({ id: 'heat-hero', name: 'Heat Hero', prefix: 'HH', schedulingMode: 'free-resource' }),
  Object.freeze({ id: 'enter', name: 'Enter', prefix: 'EN', schedulingMode: 'enter-block-first' }),
  Object.freeze({ id: 'd-warmte', name: 'D Warmte', prefix: 'DW', schedulingMode: 'free-resource' }),
]);

function normalizedText(value) {
  return String(value || '').trim().toLocaleLowerCase('de-DE').replace(/\s+/g, ' ');
}

export function normalizePlanbarCustomerPrefix(value) {
  const prefix = String(value || '').trim().toLocaleUpperCase('de-DE');
  if (!/^[A-Z0-9]{1,6}$/.test(prefix)) throw new Error('Das Planbar-Kürzel muss aus 1 bis 6 Buchstaben oder Zahlen bestehen.');
  return prefix;
}

export function normalizeCustomerSchedulingPartners(input) {
  const source = Array.isArray(input) && input.length ? input : DEFAULT_CUSTOMER_SCHEDULING_PARTNERS;
  const partners = [];
  const usedIds = new Set();
  const usedPrefixes = new Set();
  for (const item of source.slice(0, 20)) {
    const name = String(item?.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) throw new Error('Jeder Planbar-Partner braucht einen Namen.');
    const prefix = normalizePlanbarCustomerPrefix(item?.prefix);
    const generatedId = name.toLocaleLowerCase('de-DE')
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || prefix.toLowerCase();
    let id = String(item?.id || generatedId).trim().toLocaleLowerCase('de-DE').replace(/[^a-z0-9_-]+/g, '-').slice(0, 80);
    if (!id || usedIds.has(id)) id = `${generatedId}-${partners.length + 1}`;
    if (usedPrefixes.has(prefix)) throw new Error(`Das Planbar-Kürzel ${prefix} ist doppelt vergeben.`);
    usedIds.add(id);
    usedPrefixes.add(prefix);
    const schedulingMode = item?.schedulingMode === 'enter-block-first' ? 'enter-block-first' : 'free-resource';
    partners.push({ id, name, prefix, schedulingMode });
  }
  if (!partners.length) throw new Error('Mindestens ein Planbar-Partner ist erforderlich.');
  return partners;
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
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  if (thursday.getUTCFullYear() !== numericYear) throw new Error('Diese ISO-Kalenderwoche existiert in diesem Jahr nicht.');

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
  const usesVerifiedRule = Number(input.minimumBlockDays) === PLANBAR_MINIMUM_BLOCK_DAYS
    && input.countingRuleVersion === PLANBAR_CAPACITY_RULE_VERSION;
  for (const item of (usesVerifiedRule && Array.isArray(input.weeks) ? input.weeks : [])) {
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
    pageRefreshedAt: Number.isFinite(Date.parse(input.pageRefreshedAt)) ? new Date(input.pageRefreshedAt).toISOString() : null,
    source: 'Planbar · vollständig freie Ressourcen von Montag bis Freitag',
    excludedResources: ['Dawid Service', 'Antonio Lausic'],
    minimumBlockDays: PLANBAR_MINIMUM_BLOCK_DAYS,
    countingRuleVersion: PLANBAR_CAPACITY_RULE_VERSION,
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

  return {
    firstName: `HH ${cleanFirstName}`,
    lastName: cleanLastName,
    address: String(address || '').trim(),
    email: String(email || '').trim(),
    phone: String(phone || '').trim(),
    phoneKind: normalizedText(phoneKind) === 'mobil' ? 'Mobil' : 'Telefon',
  };
}

export function buildPrefixedPlanbarCustomer({ prefix, firstName, lastName, address, email, phone, phoneKind = 'Telefon', knownPrefixes = [] }) {
  const cleanPrefix = normalizePlanbarCustomerPrefix(prefix);
  const prefixSet = new Set([cleanPrefix, ...DEFAULT_CUSTOMER_SCHEDULING_PARTNERS.map(item => item.prefix), ...knownPrefixes.map(normalizePlanbarCustomerPrefix)]);
  const prefixPattern = [...prefixSet].map(item => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const cleanFirstName = String(firstName || '').trim().replace(new RegExp(`^(?:${prefixPattern})\\s+`, 'i'), '');
  const cleanLastName = String(lastName || '').trim();
  if (!cleanFirstName || !cleanLastName) throw new Error('Vor- und Nachname sind Pflichtfelder.');
  return {
    firstName: `${cleanPrefix} ${cleanFirstName}`,
    lastName: cleanLastName,
    address: String(address || '').trim(),
    email: String(email || '').trim(),
    phone: String(phone || '').trim(),
    phoneKind: normalizedText(phoneKind) === 'mobil' ? 'Mobil' : 'Telefon',
  };
}

export function buildEnterPlanbarCustomer({ firstName, lastName, address, email, phone, phoneKind = 'Telefon' }) {
  const cleanFirstName = String(firstName || '').trim().replace(/^(?:EN|HH)\s+/i, '');
  const cleanLastName = String(lastName || '').trim();
  if (!cleanFirstName || !cleanLastName) throw new Error('Vor- und Nachname sind Pflichtfelder.');

  return {
    firstName: `EN ${cleanFirstName}`,
    lastName: cleanLastName,
    address: String(address || '').trim(),
    email: String(email || '').trim(),
    phone: String(phone || '').trim(),
    phoneKind: normalizedText(phoneKind) === 'mobil' ? 'Mobil' : 'Telefon',
  };
}

function overlaps(startDate, endDateExclusive, booking) {
  const bookingStart = String(booking.startDate || booking.start || '');
  const bookingEnd = String(booking.endDateExclusive || booking.end || bookingStart);
  return bookingStart < endDateExclusive && bookingEnd > startDate;
}

function bookingRange(booking = {}) {
  const startDate = String(booking.startDate || booking.start || '').slice(0, 10);
  const endDateExclusive = String(booking.endDateExclusive || booking.end || '').slice(0, 10);
  return { startDate, endDateExclusive };
}

function isEnterBlocker(booking = {}) {
  return String(booking.text || booking.description || booking.title || '').trim() === PLANBAR_ENTER_BLOCK_TEXT;
}

export function isFullWorkweekPlanbarEnterBlocker(booking, { year, week } = {}) {
  const target = isoWeekRange(year, week);
  const range = bookingRange(booking);
  return isEnterBlocker(booking)
    && /^\d{4}-\d{2}-\d{2}$/.test(range.startDate)
    && /^\d{4}-\d{2}-\d{2}$/.test(range.endDateExclusive)
    && range.startDate <= target.startDate
    && range.endDateExclusive >= target.endDateExclusive;
}

function eligibleEnterBlockers({ resources, bookings = [], year, week }) {
  const { startDate, endDateExclusive } = isoWeekRange(year, week);
  const resourceById = new Map(resources.map((resource, index) => [String(resource?.id || ''), { resource, index }]));
  return bookings
    .filter(booking => isFullWorkweekPlanbarEnterBlocker(booking, { year, week }))
    .map(booking => ({ booking, match: resourceById.get(String(booking?.resourceId || '')) }))
    .filter(item => item.match?.resource?.id && !isExcludedPlanbarResource(item.match.resource.name))
    .filter(item => !bookings.some(other => other !== item.booking
      && String(other?.resourceId || '') === String(item.booking?.resourceId || '')
      && !isEnterBlocker(other)
      && overlaps(startDate, endDateExclusive, other)))
    .sort((left, right) => left.match.index - right.match.index
      || bookingRange(left.booking).startDate.localeCompare(bookingRange(right.booking).startDate));
}

export function countPlanbarEnterCapacity({ resources, bookings = [], year, week }) {
  if (!Array.isArray(resources) || !resources.length) throw new Error('Keine Planbar-Ressourcen vorhanden.');
  const candidates = eligibleEnterBlockers({ resources, bookings, year, week });
  return new Set(candidates.map(item => String(item.booking.resourceId))).size;
}

export function countPlanbarFreeWorkweekCapacity({ resources, bookings = [], year, week }) {
  if (!Array.isArray(resources) || !resources.length) throw new Error('Keine Planbar-Ressourcen vorhanden.');
  const { startDate, endDateExclusive } = isoWeekRange(year, week);
  const eligibleResourceIds = new Set();
  for (const resource of resources) {
    const resourceId = String(resource?.id || '');
    if (!resourceId || isExcludedPlanbarResource(resource.name) || eligibleResourceIds.has(resourceId)) continue;
    const occupied = bookings.some(booking => String(booking?.resourceId || '') === resourceId
      && overlaps(startDate, endDateExclusive, booking));
    if (!occupied) eligibleResourceIds.add(resourceId);
  }
  return eligibleResourceIds.size;
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
  const candidates = eligibleEnterBlockers({ resources, bookings, year, week });

  if (!candidates.length) throw new Error('In der gewünschten Kalenderwoche ist kein zulässiger ENTER-Blocker vorhanden, der Montag bis Freitag vollständig umfasst.');
  return {
    ...candidates[0].booking,
    resource: candidates[0].match.resource,
  };
}

export function selectPlanbarSchedulingSlot({
  resources,
  bookings = [],
  year,
  week,
  schedulingMode = 'free-resource',
  allowFreeResourceFallback = false,
}) {
  const range = isoWeekRange(year, week);
  if (schedulingMode === 'enter-block-first') {
    try {
      const blocker = selectFirstPlanbarEnterBlocker({ resources, bookings, year, week });
      return {
        mode: 'replace-enter-block',
        resource: blocker.resource,
        blocker,
        ...range,
      };
    } catch (error) {
      if (!allowFreeResourceFallback) throw error;
    }
  }
  return {
    mode: 'free-resource',
    resource: selectFirstFreePlanbarResource({ resources, bookings, ...range }),
    blocker: null,
    ...range,
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
