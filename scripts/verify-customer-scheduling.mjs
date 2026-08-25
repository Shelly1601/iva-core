import assert from 'node:assert/strict';
import {
  assertSchedulableSourceStage,
  buildPlanbarSchedulingExtras,
  buildEnterPlanbarCustomer,
  buildPipedriveCompletion,
  buildPlanbarCustomer,
  isExcludedPlanbarResource,
  isoWeekRange,
  normalizePlanbarCapacitySnapshot,
  planbarCapacityWindow,
  selectFirstFreePlanbarResource,
  selectFirstPlanbarEnterBlocker,
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

const capacity = normalizePlanbarCapacitySnapshot({
  updatedAt: '2026-08-22T15:48:00.000Z',
  excludedResources: ['beliebig'],
  weeks: [
    { isoYear: 2026, week: 35, freeSlots: 0 },
    { isoYear: 2026, week: 36, freeSlots: 1 },
    { isoYear: 2026, week: 37, freeSlots: 7 },
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
assert.equal(firstWindow.totalFreeSlots, 13);
assert.deepEqual(firstWindow.nextAvailable, { isoYear: 2026, week: 36, freeSlots: 1 });
assert.equal(firstWindow.hasNext, true);
assert.deepEqual(planbarCapacityWindow(capacity, { offset: 4 }).weeks.map(item => item.week), [36, 37, 38, 39], 'letztes Fenster bleibt vier Wochen breit');

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

const resources = [
  { id: '1439', name: 'Team Batek+Marcin' },
  { id: '1490', name: 'Team Tomek/Tomek/Kuba' },
  { id: '1648', name: 'Infinity Solution 2' },
  { id: '1674', name: 'Dawid Service' },
];
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

console.log('PASS Kunde terminieren: KW, Quellen-Gate, HH-/EN-Kunde, Ausschlüsse, Ressource, ENTER-Blocker und Pipedrive-Abschluss');
