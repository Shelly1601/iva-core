import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAdviceNumber, adviceFutureValue, adviceRemainingLoan, calculateAdviceScenario as calc } from '../public/advice-calculators.js';
import { adviceCalculatorReadiness } from '../advice/calculator-audit.js';
import { adviceConnectorStatus } from '../advice/catalog.js';
import { calculateCorporateBenefits } from '../public/corporate-benefits-calculator.js';
import { calculatePvPrice, calculateHeatPumpElectricity } from '../workspaces/pv-price-calculator.js';
import { calculateHeatLoad, calculateKfw458Funding } from '../workspaces/energy-calculations.js';
import { prepareEnergyTariffRequest, prepareWorkspaceEnergyTariffRequest } from '../integrations/energy-tariffs.js';

const near = (actual, expected, epsilon = 1e-7) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
const retirement = { currentAge: 40, retirementAge: 50, desiredNetPension: 2000, expectedPension: 1000, existingPrivatePension: 0, existingCapital: 100000, inflation: 0, returnRate: 5, withdrawalRate: 4 };
const depot = { years: 1, taxRate: 25, initialA: 10000, monthlyA: 0, returnA: 10, costA: 2, initialB: 10000, monthlyB: 0, returnB: 0, costB: 0 };
const property = { purchasePrice: 100000, ancillaryPercent: 10, equity: 10000, interestRate: 0, repaymentRate: 10, years: 5, monthlyRent: 1000, maintenance: 200 };

test('number parser preserves numeric decimals, parses German EUR and rejects nonfinite/empty/coercion', () => {
  assert.equal(parseAdviceNumber(1.234), 1.234);
  assert.equal(parseAdviceNumber('1.234,56'), 1234.56);
  assert.equal(parseAdviceNumber('28.000'), 28000);
  assert.equal(parseAdviceNumber('-1.234,56'), -1234.56);
  for (const input of [undefined, null, '', ' ', '1,2,3', 'NaN', Infinity, -Infinity, NaN, true, [], '0x20']) assert.equal(parseAdviceNumber(input), null);
});
test('effective annual return exactly compounds annually and monthly contributions are at month end', () => {
  near(adviceFutureValue(10000, 0, 10, 12), 11000);
  near(adviceFutureValue(1000, 100, 0, 12), 2200);
  const monthlyRate = 1.1 ** (1 / 12) - 1;
  near(adviceFutureValue(0, 100, 10, 2), 100 * (2 + monthlyRate));
  near(adviceFutureValue(10000, 0, -10, 12), 9000);
  near(adviceFutureValue(10000, 100, 1e-9, 12), 11200, 0.001);
  assert.equal(adviceFutureValue(100, 100, 10, 0), 100);
  for (const rate of [-100, Infinity, NaN]) assert.throws(() => adviceFutureValue(100, 0, rate, 12));
});
test('household zero is preserved, missing data stays unavailable, zero headcount is not invented', () => {
  const result = calc('financial-summary', { monthlyIncome: 3000, monthlyExpenses: 0, essentialExpenses: 2000, liquidAssets: 0, liquidityReserve: 9999, assets: 5000, liabilities: 6000 });
  assert.equal(result.values.cashFlowMonthly, 3000);
  assert.equal(result.values.netWorth, -1000);
  assert.equal(result.values.liquidityMonths, null);
  assert.equal(calc('financial-summary', {}).status, 'data-required');
  assert.equal(calc('business-summary', { employees: 0, annualRevenue: 100000, liquidity: 1000, liabilities: 2000 }).values.revenuePerEmployee, null);
  assert.equal(calc('business-summary', { employees: -2 }).status, 'data-required');
});
test('retirement grows existing capital and computes remaining savings requirement', () => {
  const result = calc('retirement-gap', retirement);
  near(result.values.existingCapitalFuture, 100000 * 1.05 ** 10);
  near(result.values.capitalNeeded, 300000);
  near(result.values.additionalCapital, 300000 - 100000 * 1.05 ** 10);
  near(result.values.monthlySavings * adviceFutureValue(0, 1, 5, 120), result.values.additionalCapital);
  assert.equal(result.automaticProposalEligible, false);
});
test('retirement handles immediate, negative-return, no-gap and invalid scenarios', () => {
  assert.equal(calc('retirement-gap', { ...retirement, retirementAge: 40 }).values.monthlySavings, null);
  assert.equal(calc('retirement-gap', { ...retirement, expectedPension: 2500 }).values.monthlySavings, 0);
  assert.ok(calc('retirement-gap', { ...retirement, returnRate: -5 }).values.monthlySavings > calc('retirement-gap', retirement).values.monthlySavings);
  for (const patch of [{ withdrawalRate: 0 }, { currentAge: 60 }, { returnRate: NaN }, { desiredNetPension: -1 }, { existingCapital: '' }]) assert.equal(calc('retirement-gap', { ...retirement, ...patch }).status, 'data-required');
});
test('depot uses multiplicative asset costs, taxes only positive gain and identical month count', () => {
  const result = calc('depot-comparison', depot);
  near(result.values.a.grossAfterCosts, 10780);
  near(result.values.a.taxAmount, 195);
  near(result.values.a.finalCapital, 10585);
  const loss = calc('depot-comparison', { ...depot, returnA: -10, costA: 0 });
  near(loss.values.a.finalCapital, 9000);
  assert.equal(loss.values.a.taxAmount, 0);
  const halfYear = calc('depot-comparison', { ...depot, years: 0.5, initialA: 0, monthlyA: 100, returnA: 0, costA: 0 });
  assert.equal(halfYear.values.months, 6);
  assert.equal(halfYear.values.a.finalCapital, 600);
  assert.equal(calc('depot-comparison', { ...depot, years: 0 }).values.a.finalCapital, 10000);
  for (const patch of [{ years: -1 }, { years: 0.1 }, { taxRate: 101 }, { costA: -1 }, { returnA: -100 }, { monthlyB: Infinity }]) assert.equal(calc('depot-comparison', { ...depot, ...patch }).status, 'data-required');
});
test('loan zero interest, full payoff and iterated amortization have correct cash and balance', () => {
  const zero = adviceRemainingLoan(100000, 0, 10, 60);
  near(zero.payment, 100000 / 120); near(zero.remaining, 50000); near(zero.interestPaid, 0);
  const repaid = adviceRemainingLoan(100000, 0, 100, 120);
  near(repaid.remaining, 0); near(repaid.paymentsPaid, 100000); assert.equal(repaid.paidOffAtMonth, 12);
  const result = adviceRemainingLoan(100000, 3, 2, 120), rate = 0.03 / 12;
  near(result.remaining, 100000 * (1 + rate) ** 120 - result.payment * (((1 + rate) ** 120 - 1) / rate), 1e-6);
  near(result.paymentsPaid - result.interestPaid + result.remaining, 100000, 1e-6);
  assert.equal(adviceRemainingLoan(100000, 0, 0, 120).remaining, 100000);
});
test('property includes ancillary costs, handles overfunding, distinguishes initial cash flow', () => {
  const result = calc('property-financing', property);
  assert.equal(result.values.loan, 100000); near(result.values.remaining, 50000); near(result.values.grossRentalYield, 12); near(result.values.initialCashFlowMonthly, -100 / 3);
  assert.equal(calc('property-financing', { ...property, equity: 200000 }).values.loan, 0);
  for (const patch of [{ purchasePrice: 0 }, { interestRate: -1 }, { equity: NaN }]) assert.equal(calc('property-financing', { ...property, ...patch }).status, 'data-required');
});
test('corporate missing optional fields use explicit defaults, numeric decimals remain intact and invalid cases fail readiness', () => {
  const defaults = calculateCorporateBenefits({ employees: 10 });
  assert.equal(defaults.assumptions.averageGrossSalary, 4000);
  assert.equal(defaults.scenario.bkvCostAnnual, 3600);
  const numeric = calculateCorporateBenefits({ employees: 1, sickDaysMode: 'company', companySickDays: 1.234 });
  near(numeric.baseline.absenceCostAnnual, 493.6);
  for (const value of [NaN, Infinity, -1, 'garbage']) assert.equal(calculateCorporateBenefits({ employees: 10, bkvMonthlyPremium: value }).calculationReady, false);
  assert.equal(calculateCorporateBenefits({ employees: 0 }).scenario.totalConceptCostAnnual, 0);
});
test('PV power retains watts, price totals remain in cents, fractional hardware and negative inputs fail', () => {
  const result = calculatePvPrice({ moduleCount: 11, storage9Qty: 0, storage6Qty: 0, specificYieldKwhPerKwp: 1000 });
  assert.equal(result.sizing.systemKwp, 5.335);
  assert.equal(result.sizing.estimatedAnnualProductionKwh, 5335);
  assert.equal(result.price.total, Math.round(result.price.breakdown.reduce((sum, row) => sum + row.total, 0) * 100) / 100);
  for (const patch of [{ moduleCount: 11.5 }, { householdConsumptionKwh: -1 }, { heatPumpConsumptionKwh: NaN }, { storage9Qty: 1.5 }, { targetCoveragePercent: 0 }, { basicEquipment: 'false' }]) assert.throws(() => calculatePvPrice({ moduleCount: 20, ...patch }));
});
test('heat-pump conversion uses unit, efficiency and JAZ; invalid values do not become zero demand', () => {
  assert.equal(calculateHeatPumpElectricity({ source: 'gas-kwh', annualConsumption: '20.000,00', seasonalPerformanceFactor: '4,0', boilerEfficiencyPercent: 90 }).result.heatPumpElectricityKwh, 4500);
  assert.equal(calculateHeatPumpElectricity({ source: 'gas-m3', annualConsumption: 2000, seasonalPerformanceFactor: 4 }).result.heatPumpElectricityKwh, 5000);
  assert.equal(calculateHeatPumpElectricity({ annualConsumption: 0 }).result.heatPumpElectricityKwh, 0);
  for (const value of [-1, NaN, Infinity, '', null]) assert.throws(() => calculateHeatPumpElectricity({ annualConsumption: value }));
  assert.throws(() => calculateHeatPumpElectricity({ annualConsumption: 1000, seasonalPerformanceFactor: NaN }));
});
test('heat load respects physical units and explicitly invalid zero room height', () => {
  const input = { building: { designOutdoorTemperature: -10, thermalBridgePercent: 10, floorHeight: 2.5 }, rooms: [{ id: 'one', area: 20, height: 2.5, targetTemperature: 20, airChanges: 0.5, envelope: { externalWallArea: 10, externalWallUValue: 0.5, windowArea: 2, windowUValue: 1, ceilingArea: 0, floorArea: 0 } }] };
  const result = calculateHeatLoad(input);
  // Transmission (10*.5 + 2*1)*1.1*30 = 231 W; ventilation .34*.5*50*30 = 255 W.
  assert.equal(result.totalWatts, 486); assert.equal(result.totalKw, 0.49);
  input.rooms[0].height = 0;
  assert.equal(calculateHeatLoad(input).status, 'data-required');
  input.rooms[0].height = 1e308; input.rooms[0].area = 1e308;
  assert.equal(calculateHeatLoad(input).status, 'data-required');
});
test('KfW money locale and real calendar dates: note blocked until all criteria are evidenced', () => {
  const input = { applicantType: 'private-owner', selfUsed: true, units: 1, projectCosts: '28.000,00', existingBuildingAgeYears: 20, applicationDate: '2026-08-01', incomeBonusRequested: false, climateBonusEligible: true, eligibleCostsConfirmedByBza: true, contractConditional: true, applicationBeforeStart: true, hydraulicBalancingPlanned: true };
  const result = calculateKfw458Funding(input, new Date('2026-09-15T10:00:00Z'));
  assert.equal(result.projectCosts, 28000); assert.equal(result.canUseForFundingNote, true);
  assert.equal(calculateKfw458Funding({ ...input, applicationDate: '2026-02-30' }).calculationReady, false);
  const incomplete = calculateKfw458Funding({ ...input, contractConditional: false }, new Date('2026-09-15T10:00:00Z'));
  assert.equal(incomplete.canUseForFundingNote, false); assert.match(incomplete.noteSummary, /noch nicht belastbar/);
});
test('energy request requires valid input and never invents prices', async () => {
  assert.equal(prepareEnergyTariffRequest({ commodity: 'gas', annualConsumptionKwh: '18.500,5', postalCode: '12345' }).input.annualConsumptionKwh, 18500.5);
  assert.ok(prepareEnergyTariffRequest({ commodity: 'gas', annualConsumptionKwh: 18500, postalCode: '123' }).missing.includes('postalCode'));
  for (const value of [0, -1, NaN, Infinity]) assert.equal(prepareEnergyTariffRequest({ commodity: 'gas', annualConsumptionKwh: value, postalCode: '12345' }).status, 'data-required');
  const workspace = { customer: { name: 'Fixture', address: '12345 Fixture' }, data: { existingHeating: { energySource: 'Gas', consumptionUnit: 'kWh', annualConsumption: 20000 } } };
  const workspaces = { getWorkspace: async () => workspace, updateWorkspace: async (_id, patch) => patch };
  const gas = await prepareWorkspaceEnergyTariffRequest({ workspaces, workspaceId: 'fixture', input: { commodity: 'gas' } });
  assert.equal(gas.request.input.annualConsumptionKwh, 20000); assert.equal(gas.request.result, null);
  const electric = await prepareWorkspaceEnergyTariffRequest({ workspaces, workspaceId: 'fixture', input: { commodity: 'electricity' } });
  assert.equal(electric.request.input.annualConsumptionKwh, null);
  const zero = await prepareWorkspaceEnergyTariffRequest({ workspaces, workspaceId: 'fixture', input: { commodity: 'gas', annualConsumptionKwh: 0 } });
  assert.equal(zero.request.status, 'data-required');
});
test('readiness never mistakes a link or credentials for working provider quotes', () => {
  const old = process.env.GKV_COMPARE_URL;
  try {
    process.env.GKV_COMPARE_URL = 'javascript:alert(1)'; assert.equal(adviceConnectorStatus().gkv.configured, false);
    process.env.GKV_COMPARE_URL = 'https://example.test/';
    const report = adviceCalculatorReadiness();
    assert.equal(report.modules.length, 14);
    assert.equal(report.modules.find(module => module.id === 'insurance-workbench').calculationKind, 'document-comparison');
    assert.equal(report.providers.gkv.status, 'portal-link-only');
    assert.ok(Object.values(report.providers).every(provider => provider.liveQuotes === false));
    assert.equal(report.modules.find(module => module.id === 'energy-tariff-comparison').trafficLight, 'red');
    assert.ok(report.modules.every(module => module.automaticProposalEligible === false));
  } finally { if (old === undefined) delete process.env.GKV_COMPARE_URL; else process.env.GKV_COMPARE_URL = old; }
});
