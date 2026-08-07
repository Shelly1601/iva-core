import assert from 'node:assert/strict';
import {
  calculateHeatPumpElectricity,
  calculatePvPrice,
  PV_PRICE_VERSION,
  pvPriceCatalog,
} from '../workspaces/pv-price-calculator.js';

const catalog = pvPriceCatalog();
assert.equal(catalog.version, PV_PRICE_VERSION);
assert.equal(catalog.module.powerW, 485);
assert.equal(catalog.range.minimumModules, 8);
assert.ok(catalog.addOns.length >= 20);

const oilHeatPump = calculateHeatPumpElectricity({
  source: 'oil-liters',
  annualConsumption: 3000,
  seasonalPerformanceFactor: 4,
  boilerEfficiencyPercent: 100,
});
assert.equal(oilHeatPump.result.fossilEnergyKwh, 30000);
assert.equal(oilHeatPump.result.heatPumpElectricityKwh, 7500);

const gasHeatPump = calculateHeatPumpElectricity({
  source: 'gas-kwh',
  annualConsumption: 20000,
  seasonalPerformanceFactor: 4,
  boilerEfficiencyPercent: 100,
});
assert.equal(gasHeatPump.result.heatPumpElectricityKwh, 5000);

const correctedOilHeatPump = calculateHeatPumpElectricity({
  source: 'oil-liters',
  annualConsumption: 3000,
  seasonalPerformanceFactor: 4,
  boilerEfficiencyPercent: 90,
});
assert.equal(correctedOilHeatPump.result.usefulHeatKwh, 27000);
assert.equal(correctedOilHeatPump.result.heatPumpElectricityKwh, 6750);
assert.throws(() => calculateHeatPumpElectricity({ annualConsumption: 3000, seasonalPerformanceFactor: 1 }), /Jahresarbeitszahl/);

const standard = calculatePvPrice({
  householdConsumptionKwh: 4000,
  moduleCount: 20,
  basicEquipment: true,
  inverterFamily: 'tp',
  storage9Qty: 1,
  storage6Qty: 0,
});
assert.equal(standard.sizing.selectedModules, 20);
assert.equal(standard.sizing.systemKwp, 9.7);
assert.equal(standard.sizing.selectedInverter.id, 'tp-8');
assert.equal(standard.sizing.storageCapacityKwh, 9);
assert.equal(standard.price.total, 19590.34);
assert.equal(standard.price.breakdown.reduce((sum, item) => Math.round((sum + item.total) * 100) / 100, 0), standard.price.total);

const sized = calculatePvPrice({
  householdConsumptionKwh: 4000,
  heatPumpConsumptionKwh: 3500,
  evConsumptionKwh: 2500,
  targetCoveragePercent: 100,
  specificYieldKwhPerKwp: 950,
  usableRoofAreaM2: 60,
  layoutFactorPercent: 85,
  basicEquipment: true,
  storage9Qty: 1,
});
assert.equal(sized.sizing.demandModules, 22);
assert.equal(sized.sizing.roofCapacityModules, 25);
assert.equal(sized.sizing.selectedModules, 22);
assert.equal(sized.sizing.systemKwp, 10.67);

const constrained = calculatePvPrice({
  householdConsumptionKwh: 12000,
  usableRoofAreaM2: 40,
  layoutFactorPercent: 85,
  storage9Qty: 1,
});
assert.equal(constrained.sizing.roofCapacityModules, 17);
assert.equal(constrained.sizing.selectedModules, 17);
assert.ok(constrained.warnings.some(item => item.includes('Jahresenergiebilanz')));

const extras = calculatePvPrice({
  moduleCount: 12,
  inverterFamily: 'tp2',
  inverterId: 'tp2-6',
  storage6Qty: 1,
  storage9Qty: 0,
  addOnIds: ['gateway-homepro', 'cabinet-replacement'],
  dismantleModules: 12,
});
assert.equal(extras.sizing.selectedInverter.id, 'tp2-6');
assert.equal(extras.sizing.storageCapacityKwh, 6);
assert.ok(extras.price.breakdown.some(item => item.id === 'gateway-homepro'));
assert.ok(extras.price.breakdown.some(item => item.id === 'dismantleModules' && item.total === 720));

assert.throws(() => calculatePvPrice({ moduleCount: 7 }), /8 bis 70 Module/);
assert.throws(() => calculatePvPrice({ moduleCount: 20, addOnIds: ['nicht-vorhanden'] }), /Unbekannte Zusatzposition/);
assert.throws(() => calculatePvPrice({ moduleCount: 20, inverterFamily: 'tp2', inverterId: 'tp-8' }), /gehört nicht/);

console.log('PV-Schnellrechner geprüft: Modulbedarf, Wärmepumpen-Umrechnung, Preisstaffel, Komponenten und Validierung.');
