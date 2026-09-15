import { parseAdviceNumber } from './advice-calculators.js';

export const FINANCIAL_PLAN_VERSION = 'iva-financial-plan-2026-09-16';
export const FINANCIAL_PLAN_FIELDS = [
  ['initialCapital', 'Startkapital', '€', 10000], ['monthlyContribution', 'Monatliche Einzahlung', '€', 200],
  ['savingMonths', 'Ansparzeit', 'Monate', 240], ['annualReturn', 'Effektive Jahresrendite vor Kosten', '%', 4],
  ['annualCost', 'Jährliche Kosten auf das Kapital', '%', 0.5], ['initialCostPercent', 'Einmalige Kosten auf das Startkapital', '%', 0],
  ['contributionCostPercent', 'Kosten auf jede Einzahlung', '%', 0], ['monthlyFixedCost', 'Monatliche feste Kosten', '€', 0],
  ['contributionGrowth', 'Jährliche Erhöhung der Einzahlung', '%', 0], ['inflation', 'Jährliche Inflation', '%', 2],
  ['taxRate', 'Angenommene Steuer auf positiven Gewinn am Ende der Ansparzeit', '%', 0],
  ['drawdownMonths', 'Entnahmezeit', 'Monate', 240], ['monthlyWithdrawal', 'Monatliche Entnahme zum Beginn der Entnahmezeit', '€', 500],
  ['withdrawalGrowth', 'Jährliche Erhöhung der Entnahme', '%', 2], ['drawdownReturn', 'Effektive Rendite in der Entnahmezeit', '%', 2],
];
const defaults = () => Object.fromEntries(FINANCIAL_PLAN_FIELDS.map(([key, , , value]) => [key, value]));
export const financialPlanDefaults = defaults;

/** Explicit cash-flow model, no security recommendation or product tax model. */
export function calculateFinancialPlan(input = {}) {
  const issues = [], values = {};
  for (const [key, label] of FINANCIAL_PLAN_FIELDS) {
    const value = parseAdviceNumber(input[key]);
    const signedRate = ['annualReturn', 'drawdownReturn', 'inflation', 'contributionGrowth', 'withdrawalGrowth'].includes(key);
    const months = key.endsWith('Months'), percentage = ['annualCost', 'initialCostPercent', 'contributionCostPercent', 'taxRate'].includes(key);
    const min = signedRate ? -99 : 0, max = months ? 1200 : percentage ? (key === 'annualCost' ? 99 : 100) : signedRate ? 100 : 1e12;
    if (value === null || value < min || value > max || (months && !Number.isInteger(value))) issues.push({ field: key, label, message: `${label}: ${months ? 'ganze Zahl' : 'Zahl'} von ${min} bis ${max} erforderlich.` });
    values[key] = value;
  }
  if (issues.length) return { status: 'data-required', version: FINANCIAL_PLAN_VERSION, issues, automaticProposalEligible: false };
  const v = values, monthlyRate = rate => Math.expm1(Math.log1p(rate / 100) / 12), costFraction = -Math.expm1(Math.log1p(-v.annualCost / 100) / 12);
  let balance = v.initialCapital * (1 - v.initialCostPercent / 100), paidIn = v.initialCapital, investmentReturn = 0;
  let costs = v.initialCapital - balance, paidOut = 0, unmetWithdrawals = 0, tax = 0, depletionMonth = null, uncollectedFixedCosts = 0;
  const points = [], months = v.savingMonths + v.drawdownMonths;
  const snapshot = (month, phase) => ({ month, phase, balance, realBalance: balance / Math.pow(1 + v.inflation / 100, month / 12), paidIn, paidOut, investmentReturn, costs, tax, unmetWithdrawals });
  points.push(snapshot(0, 'start'));
  let accumulationCapital = balance;
  function settleTax() { tax = Math.max(0, balance - paidIn) * v.taxRate / 100; balance -= tax; accumulationCapital = balance; }
  if (!v.savingMonths) settleTax();
  for (let month = 1; month <= months; month++) {
    const saving = month <= v.savingMonths, phaseMonth = saving ? month : month - v.savingMonths;
    const gain = balance * monthlyRate(saving ? v.annualReturn : v.drawdownReturn); investmentReturn += gain;
    const afterGrowth = balance + gain, assetCost = afterGrowth * costFraction, fixedCost = Math.min(v.monthlyFixedCost, Math.max(0, afterGrowth - assetCost));
    uncollectedFixedCosts += v.monthlyFixedCost - fixedCost; costs += assetCost + fixedCost;
    balance = Math.max(0, afterGrowth - assetCost - fixedCost);
    if (saving) {
      const contribution = v.monthlyContribution * Math.pow(1 + v.contributionGrowth / 100, Math.floor((phaseMonth - 1) / 12));
      const fee = contribution * v.contributionCostPercent / 100;
      paidIn += contribution; costs += fee; balance += contribution - fee;
      if (month === v.savingMonths) settleTax();
    } else {
      const wanted = v.monthlyWithdrawal * Math.pow(1 + v.withdrawalGrowth / 100, Math.floor((phaseMonth - 1) / 12));
      const actual = Math.min(wanted, balance); balance = Math.max(0, balance - actual); paidOut += actual; unmetWithdrawals += wanted - actual;
      if (actual + 1e-7 < wanted && depletionMonth === null) depletionMonth = month;
    }
    if (month % 12 === 0 || month === v.savingMonths || month === months) points.push(snapshot(month, saving ? 'saving' : 'drawdown'));
  }
  const summary = { finalCapital: balance, finalRealCapital: balance / Math.pow(1 + v.inflation / 100, months / 12), accumulationCapital, paidIn, paidOut, investmentReturn, costs, tax, unmetWithdrawals, uncollectedFixedCosts, depletionMonth, months };
  if (Object.values(summary).some(value => typeof value === 'number' && !Number.isFinite(value)) || points.some(point => !Number.isFinite(point.realBalance))) return { status: 'data-required', version: FINANCIAL_PLAN_VERSION, issues: [{ message: 'Die Kombination aus Laufzeit und Wachstumsannahmen ist nicht zuverlässig berechenbar.' }], automaticProposalEligible: false };
  return { status: 'scenario', version: FINANCIAL_PLAN_VERSION, input: v, summary, points, issues: [], automaticProposalEligible: false,
    assumptions: ['Effektive Jahresrenditen werden durch die zwölfte Wurzel in Monatsrenditen umgerechnet.', 'Einzahlungen und Entnahmen erfolgen am Monatsende. Ihre Erhöhungen erfolgen jeweils nach zwölf Monaten der jeweiligen Phase.', 'Kapitalbezogene Kosten werden monatlich äquivalent zur angegebenen Jahresquote nach der Wertentwicklung belastet; feste Kosten nur bis zum vorhandenen Kapital.', 'Die angenommene Steuer wird einmal am Ende der Ansparzeit ausschließlich auf positiven Gewinn nach Kosten berechnet. Sie ist keine individuelle Depot- oder Versicherungsbesteuerung.', 'Kaufkraftwerte sind auf den heutigen Zeitpunkt abgezinst. Entnahmen sind zu Beginn der Entnahmezeit nominal angegeben.', 'Konstante Renditen sind Modellannahmen. Kursschwankungen, Reihenfolgerisiko, Produktgarantien, individuelle Steuern und Sozialabgaben werden nicht nachgebildet.'],
    warnings: [v.taxRate === 0 ? 'Steuern sind in dieser Rechnung mit 0 % angesetzt.' : null, depletionMonth !== null ? `Die gewünschte Entnahme kann ab Monat ${depletionMonth} nicht vollständig aus dem Kapital bezahlt werden.` : null, uncollectedFixedCosts > 0 ? 'Ein Teil der festen Kosten konnte mangels Kapital nicht belastet werden; solche extern geschuldeten Gebühren sind gesondert zu prüfen.' : null].filter(Boolean) };
}
