export const CORPORATE_BENEFIT_SOURCES = [
  {
    id: 'tk-health-report-2024',
    title: 'TK-Gesundheitsreport 2024 · Arbeitsunfähigkeit 2023',
    publisher: 'Techniker Krankenkasse',
    year: '2024',
    url: 'https://www.tk.de/resource/blob/2174016/f73d5a93943b2be56a7dafa30dadce21/2024-tk-gesundheitsreport-data.pdf',
    scope: '19,4 Fehltage je Versicherungsjahr bei TK-versicherten Erwerbspersonen im Jahr 2023 (altersstandardisiert).',
  },
  {
    id: 'baua-costs-2024',
    title: 'Volkswirtschaftliche Kosten durch Arbeitsunfähigkeit 2024',
    publisher: 'Bundesanstalt für Arbeitsschutz und Arbeitsmedizin (BAuA)',
    year: '2025',
    url: 'https://www.baua.de/DE/Themen/Monitoring-Evaluation/Zahlen-Daten-Fakten/Kosten-der-Arbeitsunfaehigkeit',
    scope: '881,5 Mio. AU-Tage, 134 Mrd. € Produktionsausfall und 227 Mrd. € ausgefallene Bruttowertschöpfung. Daraus ergeben sich rechnerisch rund 258 € Bruttowertschöpfung je AU-Tag.',
  },
  {
    id: 'arag-bkv-study-2024',
    title: 'Die betriebliche Krankenversicherung · Fachkräftemagnet statt Fachkräftemangel',
    publisher: 'ARAG / YouGov',
    year: '2024',
    url: 'https://www.arag.de/assets/document/whitepaper-arag-bkv-studie-8.2024.pdf',
    scope: 'Befragung von 1.047 Arbeitnehmern und 504 Unternehmensentscheidern; Benefit-Ranking und Bedeutung bei der Arbeitgeberwahl.',
  },
  {
    id: 'pkv-civey-bkv-2026',
    title: 'Betriebliche Krankenversicherung · Bedeutung als Firmen-Benefit',
    publisher: 'PKV-Verband / Civey',
    year: '2026',
    url: 'https://www.pkv.de/positionen/betriebliche-krankenversicherung/',
    scope: 'Rund 45 % bewerten eine bKV höher als andere Firmen-Extras; etwa jede vierte befragte Person höher als eine Gehaltserhöhung.',
  },
  {
    id: 'estg-8',
    title: '§ 8 EStG · Einnahmen und 50-Euro-Sachbezugsfreigrenze',
    publisher: 'Bundesministerium der Justiz / Bundesamt für Justiz',
    year: 'laufend',
    url: 'https://www.gesetze-im-internet.de/estg/__8.html',
    scope: 'Rechtsgrundlage der monatlichen Sachbezugsfreigrenze; konkrete Anwendbarkeit auf die gewählte Gestaltung muss geprüft werden.',
  },
  {
    id: 'bfh-bkv-sachlohn',
    title: 'BFH VI R 13/16 · Krankenversicherungsschutz als Sachlohn',
    publisher: 'Bundesfinanzhof',
    year: '2018',
    url: 'https://www.bundesfinanzhof.de/de/entscheidung/entscheidungen-online/detail/pdf/STRE201810155?type=1646225765',
    scope: 'Versicherungsschutz kann Sachlohn sein, wenn ausschließlich Versicherungsschutz und keine Geldzahlung verlangt werden kann.',
  },
  {
    id: 'betravg-1a',
    title: '§ 1a BetrAVG · Entgeltumwandlung und Arbeitgeberzuschuss',
    publisher: 'Bundesministerium der Justiz / Bundesamt für Justiz',
    year: 'laufend',
    url: 'https://www.gesetze-im-internet.de/betravg/__1a.html',
    scope: '15 % Arbeitgeberzuschuss auf Entgeltumwandlung, soweit der Arbeitgeber Sozialversicherungsbeiträge einspart; Tarifabweichungen und Einzelfall prüfen.',
  },
  {
    id: 'estg-3-63',
    title: '§ 3 Nr. 63 EStG · Steuerliche Behandlung der bAV',
    publisher: 'Bundesministerium der Justiz / Bundesamt für Justiz',
    year: 'laufend',
    url: 'https://www.gesetze-im-internet.de/estg/__3.html',
    scope: 'Steuerrechtlicher Rahmen für Beiträge an Pensionsfonds, Pensionskasse und Direktversicherung; aktuelle Grenzen separat prüfen.',
  },
];

export const BENEFIT_PREFERENCE_RANKING = [
  { label: 'Flexible Arbeitszeiten', value: 70 },
  { label: 'Homeoffice', value: 61 },
  { label: 'Gesundheitsvorsorge', value: 56 },
  { label: 'Getränke, Obst & Snacks', value: 55 },
  { label: 'Arbeitgeberfinanzierte bKV', value: 50, featured: true },
  { label: 'Fitnessstudio', value: 46 },
  { label: 'Pausenangebote', value: 43 },
  { label: 'Betriebliche Kinderbetreuung', value: 40 },
];

function number(value, fallback = 0) {
  let normalized = String(value ?? '').trim().replace(/\s/g, '');
  if (normalized.includes(',')) normalized = normalized.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(?:\.\d{3})+$/.test(normalized)) normalized = normalized.replace(/\./g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bounded(value, min, max, fallback = min) {
  return Math.min(max, Math.max(min, number(value, fallback)));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function euroText(value) {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  }).format(Number(value) || 0);
}

function selectedSickDays(data) {
  return data.sickDaysMode === 'company' ? bounded(data.companySickDays, 0, 365, 19.4) : 19.4;
}

function selectedSickDayCost(data) {
  if (data.sickDayCostMode === 'baua2024') return 258;
  if (data.sickDayCostMode === 'company') return bounded(data.companySickDayCost, 0, 100000, 400);
  return 400;
}

function selectedTurnoverRate(data) {
  return data.turnoverMode === 'company' ? bounded(data.companyTurnoverRate, 0, 100, 15) : 15;
}

export function calculateCorporateBenefits(data = {}) {
  const employees = Math.round(bounded(data.employees, 0, 100000, 0));
  const sickDays = selectedSickDays(data);
  const sickDayCost = selectedSickDayCost(data);
  const averageGrossSalary = bounded(data.averageGrossSalary, 0, 1000000, 4000);
  const turnoverRate = selectedTurnoverRate(data);
  const replacementCostMonths = bounded(data.replacementCostMonths, 0, 60, 12);
  const savedSickDaysPerEmployee = Math.min(sickDays, bounded(data.savedSickDaysPerEmployee, 0, 365, 2));
  const turnoverReductionPoints = Math.min(turnoverRate, bounded(data.turnoverReductionPoints, 0, 100, 3));
  const bkvParticipation = bounded(data.bkvParticipationPercent, 0, 100, 100) / 100;
  const bkvParticipants = employees * bkvParticipation;
  const bkvMonthlyPremium = bounded(data.bkvMonthlyPremium, 0, 100000, 30);
  const bavParticipation = bounded(data.bavParticipationPercent, 0, 100, 60) / 100;
  const bavParticipants = employees * bavParticipation;
  const employeeDeferral = bounded(data.employeeDeferral, 0, 100000, 100);
  const employerSubsidyPercent = bounded(data.employerSubsidyPercent, 0, 100, 15);
  const extraEmployerBav = bounded(data.extraEmployerBav, 0, 100000, 25);
  const estimatedNetImpactPercent = bounded(data.estimatedNetImpactPercent, 0, 100, 55);
  const comparisonBudget = bounded(data.comparisonBudgetMonthly, 0, 100000, bkvMonthlyPremium || 30);
  const salaryOnCostsPercent = bounded(data.salaryOnCostsPercent, 0, 100, 20);

  const absenceCostAnnual = employees * sickDays * sickDayCost;
  const replacementsAnnual = employees * turnoverRate / 100;
  const replacementCostPerPosition = averageGrossSalary * replacementCostMonths;
  const turnoverCostAnnual = replacementsAnnual * replacementCostPerPosition;
  const baselineLossAnnual = absenceCostAnnual + turnoverCostAnnual;

  const absenceSavingsAnnual = employees * savedSickDaysPerEmployee * sickDayCost;
  const retainedPositions = employees * turnoverReductionPoints / 100;
  const turnoverSavingsAnnual = retainedPositions * replacementCostPerPosition;
  const potentialSavingsAnnual = absenceSavingsAnnual + turnoverSavingsAnnual;

  const bkvCostAnnual = bkvParticipants * bkvMonthlyPremium * 12;
  const employerSubsidyMonthly = employeeDeferral * employerSubsidyPercent / 100;
  const bavEmployerCostAnnual = bavParticipants * (employerSubsidyMonthly + extraEmployerBav) * 12;
  const totalConceptCostAnnual = bkvCostAnnual + bavEmployerCostAnnual;
  const netAfterBkv = potentialSavingsAnnual - bkvCostAnnual;
  const netAfterConcept = potentialSavingsAnnual - totalConceptCostAnnual;
  const reinvestmentCapacityMonthly = employees ? Math.max(0, netAfterBkv) / employees / 12 : 0;
  const breakEvenSavedDays = employees && sickDayCost ? bkvCostAnnual / employees / sickDayCost : 0;
  const scenarioRoi = totalConceptCostAnnual ? (potentialSavingsAnnual - totalConceptCostAnnual) / totalConceptCostAnnual * 100 : 0;

  const employeeNetImpact = employeeDeferral * estimatedNetImpactPercent / 100;
  const insuranceContributionMonthly = employeeDeferral + employerSubsidyMonthly + extraEmployerBav;

  const benefitComparison = [
    {
      label: data.bkvTariff ? `bKV · ${data.bkvTariff}` : 'Betriebliche Krankenversicherung',
      monthlyPerEmployee: bkvMonthlyPremium,
      annualEmployerCost: employees * bkvMonthlyPremium * 12,
      tax: data.bkvTaxMode === 'individual' ? 'Individuell versteuert' : data.bkvTaxMode === 'flat' ? 'Pauschalierung nur nach Prüfung' : 'Sachbezug / 50-€-Freigrenze nur bei passender Gestaltung',
      use: 'Direkt erlebbarer Gesundheitsschutz; Produktleistung und Teilnahmebedingungen belegen.',
      featured: true,
    },
    {
      label: data.bavTariff ? `bAV · ${data.bavTariff}` : 'Arbeitgeberfinanzierte bAV',
      monthlyPerEmployee: extraEmployerBav,
      annualEmployerCost: employees * extraEmployerBav * 12,
      tax: '§ 3 Nr. 63 EStG / § 1a BetrAVG; Grenzen und Durchführungsweg prüfen',
      use: 'Langfristige Bindung und Altersvorsorge; Nutzen wird zeitversetzt erlebt.',
    },
    {
      label: 'Bruttogehaltserhöhung',
      monthlyPerEmployee: comparisonBudget,
      annualEmployerCost: employees * comparisonBudget * 12 * (1 + salaryOnCostsPercent / 100),
      tax: 'Regulär lohnsteuer- und sozialversicherungspflichtig',
      use: 'Sehr flexibel, aber nach Abgaben oft geringere sichtbare Netto-Wirkung.',
    },
    {
      label: 'Gutschein / Sachbezug',
      monthlyPerEmployee: comparisonBudget,
      annualEmployerCost: employees * comparisonBudget * 12,
      tax: comparisonBudget <= 50 ? '50-€-Freigrenze grundsätzlich möglich; Voraussetzungen prüfen' : 'Über 50 €: Freigrenze überschritten, steuerliche Behandlung prüfen',
      use: 'Sofort nutzbar, aber begrenzte Differenzierung und Bindungswirkung.',
    },
    {
      label: 'Fitness-Benefit',
      monthlyPerEmployee: comparisonBudget,
      annualEmployerCost: employees * comparisonBudget * 12,
      tax: 'Vertrags- und lohnsteuerliche Gestaltung individuell prüfen',
      use: 'Hoher Nutzen für aktive Nutzer; Teilnahmequote kann stark variieren.',
    },
  ];

  return {
    assumptions: {
      employees, sickDays: round(sickDays, 1), sickDaysSource: data.sickDaysMode === 'company' ? 'Unternehmenswert' : 'TK 2023',
      sickDayCost: round(sickDayCost), sickDayCostSource: data.sickDayCostMode === 'company' ? 'Unternehmenswert' : data.sickDayCostMode === 'baua2024' ? 'BAuA 2024, abgeleitet' : 'Planwert',
      averageGrossSalary: round(averageGrossSalary), turnoverRate: round(turnoverRate, 1), turnoverSource: data.turnoverMode === 'company' ? 'Unternehmenswert' : 'Planwert',
      replacementCostMonths, savedSickDaysPerEmployee: round(savedSickDaysPerEmployee, 1), turnoverReductionPoints: round(turnoverReductionPoints, 1),
    },
    baseline: {
      absenceCostAnnual: round(absenceCostAnnual), replacementsAnnual: round(replacementsAnnual, 1), replacementCostPerPosition: round(replacementCostPerPosition),
      turnoverCostAnnual: round(turnoverCostAnnual), totalAnnual: round(baselineLossAnnual),
    },
    scenario: {
      absenceSavingsAnnual: round(absenceSavingsAnnual), retainedPositions: round(retainedPositions, 1), turnoverSavingsAnnual: round(turnoverSavingsAnnual),
      potentialSavingsAnnual: round(potentialSavingsAnnual), bkvParticipants: round(bkvParticipants, 1), bkvCostAnnual: round(bkvCostAnnual),
      bavParticipants: round(bavParticipants, 1), bavEmployerCostAnnual: round(bavEmployerCostAnnual), totalConceptCostAnnual: round(totalConceptCostAnnual),
      netAfterBkv: round(netAfterBkv), netAfterConcept: round(netAfterConcept), reinvestmentCapacityMonthly: round(reinvestmentCapacityMonthly),
      breakEvenSavedDays: round(breakEvenSavedDays, 2), roiPercent: round(scenarioRoi, 1),
    },
    payroll: {
      grossSalary: round(averageGrossSalary), employeeDeferral: round(employeeDeferral), employerSubsidyPercent: round(employerSubsidyPercent, 1),
      employerSubsidyMonthly: round(employerSubsidyMonthly), extraEmployerBav: round(extraEmployerBav), insuranceContributionMonthly: round(insuranceContributionMonthly),
      estimatedEmployeeNetImpact: round(employeeNetImpact), estimatedNetImpactPercent: round(estimatedNetImpactPercent, 1),
    },
    products: {
      bkv: { provider: String(data.bkvProvider || '').trim(), tariff: String(data.bkvTariff || '').trim(), budget: String(data.bkvAnnualBudget || '').trim(), premium: round(bkvMonthlyPremium) },
      bav: { provider: String(data.bavProvider || '').trim(), tariff: String(data.bavTariff || '').trim(), contribution: round(insuranceContributionMonthly) },
    },
    benefitComparison,
    preferenceRanking: BENEFIT_PREFERENCE_RANKING.map(entry => ({ ...entry })),
    sources: CORPORATE_BENEFIT_SOURCES.map(source => ({ ...source })),
    narrative: [
      `Bei ${employees || 'der erfassten Zahl an'} Mitarbeitenden ergeben die gewählten Annahmen rechnerische Fehlzeiten- und Fluktuationskosten von ${euroText(baselineLossAnnual)} pro Jahr.`,
      `Das Szenario mit ${round(savedSickDaysPerEmployee, 1)} vermiedenen Krankheitstagen je Person und ${round(turnoverReductionPoints, 1)} Prozentpunkten geringerer Fluktuation modelliert ein Potenzial von ${euroText(potentialSavingsAnnual)} pro Jahr.`,
      `Nach den eingegebenen bKV-Kosten verbleiben im Szenario ${euroText(netAfterBkv)}. Das entspricht rechnerisch bis zu ${euroText(reinvestmentCapacityMonthly)} je Mitarbeitendem und Monat für zusätzliche Arbeitgeberleistungen.`,
      `Mit bKV und der gewählten bAV-Finanzierung verbleibt ein modellierter Saldo von ${euroText(netAfterConcept)}. Das ist eine Szenariorechnung und weder Einspar- noch Wirkungszusage.`,
    ],
    note: 'Szenariorechnung, keine Wirkungs-, Steuer- oder Rechtszusage. Weniger Fehlzeiten und Fluktuation dürfen nicht allein der bKV zugerechnet werden. Vor Umsetzung Tarif, Arbeitsvertrag, Gleichbehandlung, Lohnsteuer, Sozialversicherung und bAV-Durchführungsweg fachlich prüfen.',
  };
}
