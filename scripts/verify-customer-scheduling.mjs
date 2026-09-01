import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assertSchedulableSourceStage,
  buildPlanbarSchedulingExtras,
  countPlanbarEnterCapacity,
  countPlanbarFreeWorkweekCapacity,
  buildEnterPlanbarCustomer,
  buildPipedriveCompletion,
  buildPlanbarCustomer,
  buildPrefixedPlanbarCustomer,
  isExcludedPlanbarResource,
  isFullWorkweekPlanbarEnterBlocker,
  isoWeekRange,
  normalizePlanbarCapacitySnapshot,
  normalizeCustomerSchedulingPartners,
  PLANBAR_CAPACITY_RULE_VERSION,
  planbarCapacityWindow,
  selectFirstFreePlanbarResource,
  selectFirstPlanbarEnterBlocker,
  selectPlanbarSchedulingSlot,
} from '../operations/customer-scheduling.js';

assert.deepEqual(isoWeekRange(2026, 39), {
  startDate: '2026-09-21',
  endDateExclusive: '2026-09-26',
});

assert.equal(isExcludedPlanbarResource('Dawid Service'), true);
assert.equal(isExcludedPlanbarResource('David Service'), true);
assert.equal(isExcludedPlanbarResource('Antonio Lausic'), true);
assert.equal(isExcludedPlanbarResource('Antonio Lausitsch'), true);
assert.equal(isExcludedPlanbarResource('Infinity Solution 2'), false);
const defaultPartners = normalizeCustomerSchedulingPartners();
assert.deepEqual(defaultPartners.map(item => item.prefix), ['HH', 'EN', 'DW']);
assert.equal(defaultPartners.find(item => item.prefix === 'EN').schedulingMode, 'enter-block-first');
assert.throws(() => normalizeCustomerSchedulingPartners([{ name: 'A', prefix: 'XX' }, { name: 'B', prefix: 'XX' }]), /doppelt/);

const capacity = normalizePlanbarCapacitySnapshot({
  updatedAt: '2026-08-22T15:48:00.000Z',
  minimumBlockDays: 5,
  countingRuleVersion: PLANBAR_CAPACITY_RULE_VERSION,
  excludedResources: ['beliebig'],
  weeks: [
    { isoYear: 2026, week: 35, freeSlots: 0 },
    { isoYear: 2026, week: 36, freeSlots: 1 },
    { isoYear: 2026, week: 37, freeSlots: 3 },
    { isoYear: 2026, week: 38, freeSlots: 5 },
    { isoYear: 2026, week: 39, freeSlots: 7 },
    { isoYear: 2026, week: 39, freeSlots: 6 },
    { isoYear: 2026, week: 54, freeSlots: 99 },
  ],
});
assert.deepEqual(capacity.excludedResources, ['Dawid Service', 'Antonio Lausic']);
assert.equal(capacity.weeks.length, 5);
assert.equal(capacity.weeks.at(-1).freeSlots, 6, 'doppelte KW wird idempotent durch den letzten Wert ersetzt');
const firstWindow = planbarCapacityWindow(capacity);
assert.equal(firstWindow.totalFreeSlots, 9);
assert.deepEqual(firstWindow.nextAvailable, { isoYear: 2026, week: 36, freeSlots: 1 });
assert.equal(firstWindow.hasNext, true);
assert.deepEqual(planbarCapacityWindow(capacity, { offset: 4 }).weeks.map(item => item.week), [36, 37, 38, 39], 'letztes Fenster bleibt vier Wochen breit');
assert.deepEqual(normalizePlanbarCapacitySnapshot({
  updatedAt: '2026-08-22T15:48:00.000Z',
  weeks: [{ isoYear: 2026, week: 37, freeSlots: 7 }],
}).weeks, [], 'alte Kapazitätsstände ohne verifizierte Fünf-Tage-Regel werden nicht mehr angezeigt');

assert.equal(assertSchedulableSourceStage('Förderung beantragen'), true);
assert.equal(assertSchedulableSourceStage('Montage einplanen'), true);
assert.equal(assertSchedulableSourceStage('Montage terminieren'), true);
assert.throws(() => assertSchedulableSourceStage('Angebot offen'), /weder/);

assert.deepEqual(buildPlanbarSchedulingExtras({
  materialDeliverySpace: true,
  theftWeatherProtected: false,
  additionalInfo: '  Zufahrt nur über den Hof.  ',
}), [
  'Materialannahme einige Tage vor Montagebeginn: Ja',
  'Diebstahl- und wettersicher: Nein',
  'Zusatzinfo: Zufahrt nur über den Hof.',
]);
assert.deepEqual(buildPlanbarSchedulingExtras({ materialDeliverySpace: false, theftWeatherProtected: true, additionalInfo: '   ' }), [
  'Materialannahme einige Tage vor Montagebeginn: Nein',
  'Diebstahl- und wettersicher: Ja',
]);

assert.deepEqual(buildPlanbarCustomer({
  firstName: 'HH Stefanie',
  lastName: 'Schneider',
  address: 'Musterstraße 1, 12345 Musterstadt',
  email: 'stefanie@example.test',
  phone: '+49 170 1234567',
  phoneKind: 'Mobil',
}), {
  firstName: 'HH Stefanie',
  lastName: 'Schneider',
  address: 'Musterstraße 1, 12345 Musterstadt',
  email: 'stefanie@example.test',
  phone: '+49 170 1234567',
  phoneKind: 'Mobil',
});

assert.deepEqual(buildEnterPlanbarCustomer({
  firstName: 'HH Urban',
  lastName: 'Backes',
  address: 'Musterstraße 2, 12345 Musterstadt',
  email: 'urban@example.test',
  phone: '+49 170 7654321',
  phoneKind: 'Telefon',
}), {
  firstName: 'EN Urban',
  lastName: 'Backes',
  address: 'Musterstraße 2, 12345 Musterstadt',
  email: 'urban@example.test',
  phone: '+49 170 7654321',
  phoneKind: 'Telefon',
});

assert.deepEqual(buildPrefixedPlanbarCustomer({
  prefix: 'DW', firstName: 'HH Stefanie', lastName: 'Schneider',
  address: 'Musterstraße 1, 12345 Musterstadt', email: 'stefanie@example.test', phone: '+49 170 1234567', phoneKind: 'Mobil',
}), {
  firstName: 'DW Stefanie', lastName: 'Schneider', address: 'Musterstraße 1, 12345 Musterstadt',
  email: 'stefanie@example.test', phone: '+49 170 1234567', phoneKind: 'Mobil',
});

const resources = [
  { id: '1439', name: 'Team Batek+Marcin' },
  { id: '1490', name: 'Team Tomek/Tomek/Kuba' },
  { id: '1648', name: 'Infinity Solution 2' },
  { id: '1674', name: 'Dawid Service' },
];
assert.equal(isFullWorkweekPlanbarEnterBlocker({
  startDate: '2026-09-14', endDateExclusive: '2026-09-19', text: 'Geblockt für Kunde ENTER',
}, { year: 2026, week: 38 }), true);
assert.equal(isFullWorkweekPlanbarEnterBlocker({
  startDate: '2026-09-16', endDateExclusive: '2026-09-21', text: 'Geblockt für Kunde ENTER',
}, { year: 2026, week: 38 }), false, 'ein nur teilweise in der Zielwoche liegender Fünf-Tage-Block ist kein freier Wochenplatz');
assert.equal(countPlanbarEnterCapacity({
  resources,
  bookings: [
    { resourceId: '1439', startDate: '2026-09-14', endDateExclusive: '2026-09-19', text: 'Geblockt für Kunde ENTER' },
    { resourceId: '1490', startDate: '2026-09-14', endDateExclusive: '2026-09-18', text: 'Geblockt für Kunde ENTER' },
    { resourceId: '1648', startDate: '2026-09-14', endDateExclusive: '2026-09-19', text: 'Geblockt für Kunde ENTER' },
    { resourceId: '1674', startDate: '2026-09-14', endDateExclusive: '2026-09-19', text: 'Geblockt für Kunde ENTER' },
  ],
  year: 2026,
  week: 38,
}), 2, 'nur vollständige Montag-bis-Freitag-Blöcke zulässiger Ressourcen zählen');
assert.equal(countPlanbarFreeWorkweekCapacity({
  resources,
  bookings: [{ resourceId: '1439', startDate: '2026-09-16', endDateExclusive: '2026-09-17', text: 'Teilbelegung' }],
  year: 2026,
  week: 38,
}), 2, 'eine Teilbelegung sperrt die ganze Woche; vollständig freie zulässige Ressourcen zählen je einmal');
const { buildPlanbarCapacitySnapshot } = await import('../local-mac-helper/planbar.mjs');
const measuredCapacity = buildPlanbarCapacitySnapshot({
  updatedAt: '2026-08-26T08:00:00.000Z',
  sourceCheckedAt: '2026-08-26T08:00:00.000Z',
  refreshMode: 'direct-live-read',
  rangeStart: '2026-08-24',
  resources,
  enterBlockers: [
    { resourceId: '1439', startDate: '2026-09-07', endDateExclusive: '2026-09-12', text: 'Geblockt für Kunde ENTER' },
    { resourceId: '1490', startDate: '2026-09-09', endDateExclusive: '2026-09-14', text: 'Geblockt für Kunde ENTER' },
    { resourceId: '1648', startDate: '2026-09-07', endDateExclusive: '2026-09-12', text: 'Geblockt für Kunde ENTER' },
    { resourceId: '1674', startDate: '2026-09-07', endDateExclusive: '2026-09-12', text: 'Geblockt für Kunde ENTER' },
  ],
});
assert.equal(measuredCapacity.weeks.length, 12);
assert.deepEqual(measuredCapacity.weeks.find(item => item.week === 37), { isoYear: 2026, week: 37, freeSlots: 0 });
assert.equal(measuredCapacity.minimumBlockDays, 5);
assert.equal(measuredCapacity.sourceCheckedAt, '2026-08-26T08:00:00.000Z');
assert.equal(measuredCapacity.pageRefreshedAt, null);
assert.equal(measuredCapacity.refreshMode, 'direct-live-read');
const normalizedDirectCapacity=normalizePlanbarCapacitySnapshot(measuredCapacity);
assert.equal(normalizedDirectCapacity.sourceCheckedAt,measuredCapacity.sourceCheckedAt);
assert.equal(normalizedDirectCapacity.refreshMode,'direct-live-read');
const bookings = [
  { resourceId: '1439', startDate: '2026-09-21', endDateExclusive: '2026-09-26' },
  { resourceId: '1490', startDate: '2026-09-24', endDateExclusive: '2026-09-25' },
];
assert.deepEqual(selectFirstFreePlanbarResource({
  resources,
  bookings,
  startDate: '2026-09-21',
  endDateExclusive: '2026-09-26',
}), resources[2], 'auch eine teilweise belegte Woche blockiert die Ressource vollständig');

assert.throws(() => selectFirstFreePlanbarResource({
  resources: [{ id: '1674', name: 'Dawid Service' }],
  startDate: '2026-09-21',
  endDateExclusive: '2026-09-26',
}), /keine zulässige Ressource/);

assert.deepEqual(selectFirstPlanbarEnterBlocker({
  resources,
  bookings: [
    { id: 'excluded', resourceId: '1674', startDate: '2026-09-14', endDateExclusive: '2026-09-19', text: 'Geblockt für Kunde ENTER' },
    { id: 'later-resource', resourceId: '1648', startDate: '2026-09-14', endDateExclusive: '2026-09-19', text: 'Geblockt für Kunde ENTER' },
    { id: 'first-visible', resourceId: '1490', startDate: '2026-09-16', endDateExclusive: '2026-09-21', text: 'Geblockt für Kunde ENTER' },
    { id: 'real-site-conflict', resourceId: '1490', startDate: '2026-09-17', endDateExclusive: '2026-09-18', text: 'HH Bestehende Baustelle' },
    { id: 'wrong-text', resourceId: '1439', startDate: '2026-09-14', endDateExclusive: '2026-09-19', text: 'Geblockt für Enervado' },
  ],
  year: 2026,
  week: 38,
}), {
  id: 'later-resource',
  resourceId: '1648',
  startDate: '2026-09-14',
  endDateExclusive: '2026-09-19',
  text: 'Geblockt für Kunde ENTER',
  resource: resources[2],
}, 'ein mit einer echten Baustelle kollidierender ENTER-Blocker wird übersprungen; fremde Blocker und ausgeschlossene Ressourcen bleiben unberührt');

const enterSlot = selectPlanbarSchedulingSlot({
  resources,
  bookings: [{ id: 'enter', resourceId: '1648', startDate: '2026-09-21', endDateExclusive: '2026-09-26', text: 'Geblockt für Kunde ENTER' }],
  year: 2026, week: 39, schedulingMode: 'enter-block-first', allowFreeResourceFallback: true,
});
assert.equal(enterSlot.mode, 'replace-enter-block');
assert.equal(enterSlot.resource.id, '1648');
assert.throws(() => selectPlanbarSchedulingSlot({
  resources,
  bookings: [{ resourceId: '1439', startDate: '2026-09-21', endDateExclusive: '2026-09-26', text: 'Fremdbelegung' }],
  year: 2026, week: 39, schedulingMode: 'enter-block-first', allowFreeResourceFallback: false,
}), /kein zulässiger ENTER-Blocker/);
const enterFallbackSlot = selectPlanbarSchedulingSlot({
  resources,
  bookings: [{ resourceId: '1439', startDate: '2026-09-21', endDateExclusive: '2026-09-26', text: 'Fremdbelegung' }],
  year: 2026, week: 39, schedulingMode: 'enter-block-first', allowFreeResourceFallback: true,
});
assert.equal(enterFallbackSlot.mode, 'free-resource');
assert.equal(enterFallbackSlot.resource.id, '1490');

assert.throws(() => selectFirstPlanbarEnterBlocker({
  resources,
  bookings: [{ resourceId: '1439', startDate: '2026-09-21', endDateExclusive: '2026-09-26', text: 'Blocker Art of Energy' }],
  year: 2026,
  week: 39,
}), /kein zulässiger ENTER-Blocker/);

assert.deepEqual(buildPipedriveCompletion({
  year: 2026,
  week: 39,
  currentStage: 'Montage einplanen',
  visibleStages: [
    'Montage einplanen',
    'Montage Terminiert, RG+AB senden',
    'Zahlungseingang prüfen',
  ],
}), {
  fieldName: 'Einbautermin Kalenderwoche',
  fieldValue: 'KW39',
  sourceStage: 'Montage einplanen',
  targetStage: 'Montage Terminiert, RG+AB senden',
  allowAutomaticDealTitleWeekSuffix: true,
});

assert.throws(() => buildPipedriveCompletion({
  year: 2026,
  week: 39,
  currentStage: 'Zahlungseingang prüfen',
  visibleStages: ['Montage einplanen', 'Zahlungseingang prüfen'],
}), /letzte sichtbare Phase/);

const workflow = await readFile(new URL('../KUNDE_TERMINIEREN_WORKFLOW.md', import.meta.url), 'utf8');
assert.match(workflow, /native WhatsApp-App/);
assert.match(workflow, /Gruppe `Terminierung Dispo` innerhalb der Community `Heat Hero GmbH`/);
assert.match(workflow, /Vorname Nachname, KW <Kalenderwoche>/);
assert.match(workflow, /vollständig frei/);
assert.match(workflow, /`Heat Hero = HH`, `Enter = EN` und `D Warmte = DW`/);
assert.match(workflow, /Falls kein ENTER-Block vorhanden ist, freien Fünf-Tage-Platz verwenden/);

console.log('PASS Kunde terminieren: Fünf-Tage-Kapazität, Quellen-Gate, Planbar/Pipedrive und native WhatsApp-Bestätigung');
