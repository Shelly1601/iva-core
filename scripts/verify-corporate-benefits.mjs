import assert from 'node:assert/strict';
import { BENEFIT_PREFERENCE_RANKING, calculateCorporateBenefits, CORPORATE_BENEFIT_SOURCES } from '../public/corporate-benefits-calculator.js';
import { applyBkvOfferSelection, BKV_OFFERS } from '../public/bkv-offer-catalog.js';

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
assert.ok(CORPORATE_BENEFIT_SOURCES.length >= 19);
assert.ok(BKV_OFFERS.length >= 8);

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

const widoValues = calculateCorporateBenefits({ employees: 10, sickDaysMode: 'wido2025' });
assert.equal(widoValues.assumptions.sickDays, 23.3);
assert.equal(widoValues.assumptions.sickDaysSource, 'WIdO/AOK 2025');

const selectedOffer = applyBkvOfferSelection({ bkvOfferId: 'allianz-meinegesundheit', bkvBudgetLevel: '600' }, 'bkvOfferId');
assert.equal(selectedOffer.bkvProvider, 'Allianz');
assert.equal(selectedOffer.bkvTariff, 'MeineGesundheit');
assert.equal(selectedOffer.bkvMonthlyPremium, '22,9');

const extendedPayroll = calculateCorporateBenefits({
  ...selectedOffer,
  employees: 20,
  averageGrossSalary: 4000,
  employeeDeferral: 100,
  employerSubsidyPercent: 15,
  extraEmployerBav: 25,
  nonCashBenefitMonthly: 50,
  otherTaxableBenefitsMonthly: 20,
  bkvTaxMode: 'individual',
  payrollType: 'pkv',
  payrollTaxClass: 'IV',
  employeePkvContributionMonthly: 780,
  employerPkvSubsidyMonthly: 350,
  employerVlMonthly: 40,
  employeeVlMonthly: 10,
  referenceNetPay: 2650,
});
assert.equal(extendedPayroll.products.bkv.provider, 'Allianz');
assert.equal(extendedPayroll.products.bkv.premium, 22.9);
assert.equal(extendedPayroll.payroll.estimatedTaxableGross, 3992.9);
assert.equal(extendedPayroll.payroll.payrollType, 'pkv');
assert.equal(extendedPayroll.payroll.taxClass, 'IV');
assert.equal(extendedPayroll.payroll.employerBenefitSpendMonthly, 452.9);
assert.equal(extendedPayroll.payroll.referenceNetPay, 2650);
assert.equal(extendedPayroll.implementationPlaybook.length, 4);
assert.ok(extendedPayroll.documentBasisNote.includes('WIFO'));

console.log('PASS Firmenvorsorge: Fehlzeiten, Fluktuation, bKV-Katalog, bAV, PKV/VL-Musterabrechnung, Benefit-Ranking und Quellen');
