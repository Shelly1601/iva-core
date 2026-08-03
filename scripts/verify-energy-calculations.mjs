import assert from 'node:assert/strict';
import { calculateHeatLoad, calculateKfw458Funding, climateSpeedBonusRate, eligibleCostCap, incomeBonusRate } from '../workspaces/energy-calculations.js';

const incomplete = calculateHeatLoad({ building: {}, rooms: [] });
assert.equal(incomplete.status, 'data-required');
assert.ok(incomplete.missing.length >= 3);

const heatLoad = calculateHeatLoad({
  building: { designOutdoorTemperature: '-10', thermalBridgePercent: '5' },
  rooms: [{
    id: 'living', name: 'Wohnzimmer', area: '20', height: '2,5', targetTemperature: '20', airChanges: '0,5',
    envelope: {
      externalWallArea: '30', externalWallUValue: '0,3', windowArea: '4', windowUValue: '1,1',
      ceilingArea: '20', ceilingUValue: '0,2', floorArea: '20', floorUValue: '0,4',
    },
  }],
});
assert.equal(heatLoad.status, 'preliminary');
assert.equal(heatLoad.dinCompliant, false);
assert.equal(heatLoad.totalWatts, 1055);
assert.equal(heatLoad.totalKw, 1.06);

assert.equal(eligibleCostCap(1), 28_000);
assert.equal(eligibleCostCap(7), 111_000);
assert.equal(incomeBonusRate(30_000, false), 40);
assert.equal(incomeBonusRate(55_000, true), 10);
assert.equal(climateSpeedBonusRate(new Date('2026-08-03T12:00:00+02:00')), 16);
assert.equal(climateSpeedBonusRate(new Date('2028-08-02T12:00:00+02:00')), 0);

const funding = calculateKfw458Funding({
  applicantType: 'private-owner', selfUsed: true, existingBuildingAgeYears: 10, units: 1,
  projectCosts: 30_000, householdIncome: 25_000, eligibleMinorChild: false, climateBonusEligible: true,
  contractConditional: true, applicationBeforeStart: true, hydraulicBalancingPlanned: true,
}, new Date('2026-08-03T12:00:00+02:00'));
assert.equal(funding.status, 'precheck-positive');
assert.equal(funding.rate, 80);
assert.equal(funding.eligibleCosts, 28_000);
assert.equal(funding.estimatedGrant, 22_400);
assert.equal(funding.bonuses.climateSpeed, 16);

console.log('PASS Energie: Heizlast-Vorplanung, Pflichtfelder und KfW-458-Regelstand');
