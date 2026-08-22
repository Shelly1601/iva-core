import assert from 'node:assert/strict';
import {
  assertSchedulableSourceStage,
  buildPlanbarSchedulingExtras,
  buildPipedriveCompletion,
  buildPlanbarCustomer,
  isExcludedPlanbarResource,
  isoWeekRange,
  selectFirstFreePlanbarResource,
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

console.log('PASS Kunde terminieren: KW, Quellen-Gate, HH-Kunde, Ausschlüsse, Ressource und Pipedrive-Abschluss');
