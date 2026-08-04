import assert from 'node:assert/strict';
import { BENEFIT_PREFERENCE_RANKING, calculateCorporateBenefits, CORPORATE_BENEFIT_SOURCES } from '../public/corporate-benefits-calculator.js';

const result = calculateCorporateBenefits({
  employees: 50,
  sickDaysMode: 'tk2023',
  sickDayCostMode: 'plan400',
  averageGrossSalary: 4000,
  turnoverMode: 'plan15',
  replacementCostMonths: 12,
  savedSickDaysPerEmployee: 2,
  turnoverReductionPoints: 3,
  bkvParticipationPercent: 100,
  bkvMonthlyPremium: 30,
  bavParticipationPercent: 60,
  employeeDeferral: 100,
  employerSubsidyPercent: 15,
  extraEmployerBav: 25,
  estimatedNetImpactPercent: 55,
});

assert.equal(result.assumptions.sickDays, 19.4);
assert.equal(result.assumptions.sickDayCost, 400);
assert.equal(result.baseline.absenceCostAnnual, 388000);
assert.equal(result.baseline.turnoverCostAnnual, 360000);
assert.equal(result.baseline.totalAnnual, 748000);
assert.equal(result.scenario.absenceSavingsAnnual, 40000);
assert.equal(result.scenario.turnoverSavingsAnnual, 72000);
assert.equal(result.scenario.potentialSavingsAnnual, 112000);
assert.equal(result.scenario.bkvCostAnnual, 18000);
assert.equal(result.scenario.bavEmployerCostAnnual, 14400);
assert.equal(result.scenario.totalConceptCostAnnual, 32400);
assert.equal(result.scenario.netAfterConcept, 79600);
assert.equal(result.scenario.breakEvenSavedDays, 0.9);
assert.equal(result.payroll.insuranceContributionMonthly, 140);
assert.equal(result.payroll.estimatedEmployeeNetImpact, 55);
assert.equal(BENEFIT_PREFERENCE_RANKING.find(item => item.featured)?.value, 50);
assert.ok(CORPORATE_BENEFIT_SOURCES.length >= 8);

const companyValues = calculateCorporateBenefits({
  employees: 10,
  sickDaysMode: 'company',
  companySickDays: '12,5',
  sickDayCostMode: 'company',
  companySickDayCost: '550',
  turnoverMode: 'company',
  companyTurnoverRate: '8,5',
  averageGrossSalary: 3500,
  replacementCostMonths: 18,
});
assert.equal(companyValues.assumptions.sickDays, 12.5);
assert.equal(companyValues.assumptions.sickDayCost, 550);
assert.equal(companyValues.assumptions.turnoverRate, 8.5);
assert.equal(companyValues.assumptions.replacementCostMonths, 18);

console.log('PASS Firmenvorsorge: Fehlzeiten, Fluktuation, bKV, bAV, Musterabrechnung, Benefit-Ranking und Quellen');
