import { energyTariffStatus } from '../integrations/energy-tariffs.js';
import { CORPORATE_BENEFIT_SOURCES } from '../public/corporate-benefits-calculator.js';

const field = (key, label, options = {}) => ({ key, label, type: 'number', ...options });

export const ADVICE_GROUPS = [
  { id: 'finance', label: 'Finanzplanung' },
  { id: 'retirement', label: 'Vorsorge & Vermögen' },
  { id: 'insurance', label: 'Versicherungen' },
  { id: 'property', label: 'Immobilien' },
  { id: 'health', label: 'Gesundheit' },
  { id: 'corporate', label: 'Firmenvorsorge & Benefits' },
  { id: 'energy', label: 'Energie & Versorgung' },
];

export const ADVICE_MODULES = [
  {
    id: 'financial-holistic', group: 'finance', icon: '◎', title: 'Ganzheitliche Finanzberatung', short: 'Finanzen vollständig erfassen, priorisieren und in einen Maßnahmenplan überführen.', status: 'ready', badge: 'Startklar',
    sections: [
      { title: 'Liquidität & Bilanz', fields: [
        field('monthlyIncome', 'Monatliches Haushaltsnetto', { unit: '€' }), field('monthlyExpenses', 'Monatliche Ausgaben', { unit: '€' }),
        field('liquidAssets', 'Liquide Rücklagen', { unit: '€' }), field('assets', 'Vermögen gesamt', { unit: '€' }), field('liabilities', 'Verbindlichkeiten', { unit: '€' }),
      ] },
      { title: 'Ziele & Prioritäten', fields: [
        field('goals', 'Wünsche und Ziele', { type: 'textarea', wide: true, placeholder: 'Was möchte der Kunde erreichen?' }),
        field('priorities', 'Prioritäten / Engpässe', { type: 'textarea', wide: true }),
      ] },
    ], calculator: 'financial-summary',
  },
  {
    id: 'din-77230', group: 'finance', icon: '30', title: 'DIN 77230 · Privathaushalt', short: 'Strukturierte Basis-Finanzanalyse für private Haushalte.', status: 'licensed-rules-needed', badge: 'DIN-orientiert',
    notice: 'Die Datenerfassung ist DIN-orientiert. Die Bezeichnung „DIN-konforme Analyse“ darf erst nach Einbindung des vollständigen lizenzierten Regelwerks und fachlicher Abnahme verwendet werden.',
    sections: [
      { title: 'Haushalt', fields: [field('householdMembers', 'Personen im Haushalt'), field('dependants', 'Davon wirtschaftlich abhängig'), field('monthlyIncome', 'Haushaltsnetto', { unit: '€' }), field('essentialExpenses', 'Notwendige Ausgaben', { unit: '€' }), field('liquidityReserve', 'Liquiditätsreserve', { unit: '€' })] },
      { title: 'Absicherung & Ziele', fields: [field('existingProtection', 'Bestehende Absicherung', { type: 'textarea', wide: true }), field('goals', 'Wünsche und Ziele', { type: 'textarea', wide: true })] },
    ], calculator: 'financial-summary',
  },
  {
    id: 'din-77235', group: 'finance', icon: '35', title: 'DIN 77235 · Unternehmen', short: 'Basis-Finanz- und Risikoanalyse für Selbstständige und KMU.', status: 'licensed-rules-needed', badge: 'DIN-orientiert',
    notice: 'Die Datenerfassung ist DIN-orientiert. Das vollständige lizenzierte Regelwerk und eine fachliche Abnahme sind für eine normkonforme Auswertung erforderlich.',
    sections: [
      { title: 'Organisation', fields: [field('legalForm', 'Rechtsform', { type: 'text' }), field('employees', 'Beschäftigte'), field('annualRevenue', 'Jahresumsatz', { unit: '€' }), field('liquidity', 'Liquide Mittel', { unit: '€' }), field('liabilities', 'Verbindlichkeiten', { unit: '€' })] },
      { title: 'Risiken', fields: [field('keyPersons', 'Schlüsselpersonen', { type: 'textarea', wide: true }), field('businessRisks', 'Haftungs-, Ausfall- und Substanzrisiken', { type: 'textarea', wide: true }), field('goals', 'Ziele / Handlungsfelder', { type: 'textarea', wide: true })] },
    ], calculator: 'business-summary',
  },
  {
    id: 'corporate-benefits', group: 'corporate', icon: 'B+', title: 'Firmenvorsorge · bKV & bAV', short: 'Fehlzeiten und Fluktuation bewerten, bKV gegenrechnen und ein finanziertes bAV-Vorsorgewerk präsentieren.', status: 'ready', badge: 'Live-Rechner',
    notice: 'IVA zeigt eine vertriebliche Szenariorechnung, keine garantierte Wirkung. Der 400-Euro-Planwert, vermiedene Krankheitstage und geringere Fluktuation bleiben sichtbar veränderbare Annahmen. Steuer-, Arbeits- und Versicherungsrecht werden vor Umsetzung fachlich geprüft.',
    sections: [
      { title: 'Unternehmen & Fehlzeiten', fields: [
        field('employees', 'Mitarbeitende', { value: 50 }),
        field('sickDaysMode', 'Krankheitstage', { type: 'select', value: 'tk2023', options: [{ value: 'tk2023', label: 'TK 2023 · 19,4 Tage' }, { value: 'company', label: 'Tatsächlicher Unternehmenswert' }] }),
        field('companySickDays', 'Tatsächliche Krankheitstage je Mitarbeitendem', { unit: 'Tage / Jahr', value: 19.4 }),
        field('sickDayCostMode', 'Kosten je Krankheitstag', { type: 'select', value: 'plan400', options: [{ value: 'plan400', label: 'Planwert · 400 €' }, { value: 'baua2024', label: 'BAuA 2024 · ca. 258 € Wertschöpfung' }, { value: 'company', label: 'Tatsächlicher Unternehmenswert' }] }),
        field('companySickDayCost', 'Tatsächliche Kosten je Krankheitstag', { unit: '€', value: 400 }),
        field('averageGrossSalary', 'Durchschnittliches Monatsbrutto', { unit: '€', value: 4000 }),
      ] },
      { title: 'Fluktuation & Wiederbesetzung', fields: [
        field('turnoverMode', 'Fluktuationsquote', { type: 'select', value: 'plan15', options: [{ value: 'plan15', label: 'Planwert · 15 %' }, { value: 'company', label: 'Tatsächlicher Unternehmenswert' }] }),
        field('companyTurnoverRate', 'Tatsächliche Fluktuation', { unit: '% / Jahr', value: 15 }),
        field('replacementCostMonths', 'Kosten je Wiederbesetzung', { type: 'select', value: '12', options: [{ value: '12', label: '12 Monatsgehälter' }, { value: '18', label: '18 Monatsgehälter' }, { value: '24', label: '24 Monatsgehälter' }] }),
      ] },
      { title: 'Wirkungsszenario · frei einstellbar', fields: [
        field('savedSickDaysPerEmployee', 'Angenommene vermiedene Krankheitstage', { unit: 'Tage je Person / Jahr', value: 2 }),
        field('turnoverReductionPoints', 'Angenommene Senkung der Fluktuation', { unit: 'Prozentpunkte', value: 3 }),
        field('bkvParticipationPercent', 'Teilnahme an der bKV', { unit: '% der Mitarbeitenden', value: 100 }),
      ] },
      { title: 'Konkrete betriebliche Krankenversicherung', fields: [
        field('bkvProvider', 'Versicherer', { type: 'text', placeholder: 'z. B. Hallesche, Allianz, Barmenia' }),
        field('bkvTariff', 'Tarif / Tarifkombination', { type: 'text', placeholder: 'Tarif und Tarifstand' }),
        field('bkvMonthlyPremium', 'Beitrag Arbeitgeber', { unit: '€ je Person / Monat', value: 30 }),
        field('bkvAnnualBudget', 'Gesundheitsbudget / Leistungen', { type: 'text', placeholder: 'z. B. 600 € Budget, Zahn, Sehhilfe, Vorsorge' }),
        field('bkvTaxMode', 'Geplante lohnsteuerliche Behandlung', { type: 'select', value: 'benefit50', options: [{ value: 'benefit50', label: 'Sachbezug / 50-€-Freigrenze prüfen' }, { value: 'individual', label: 'Individuelle Versteuerung' }, { value: 'flat', label: 'Pauschalierung prüfen' }] }),
      ] },
      { title: 'Betriebliche Altersvorsorge & Musterabrechnung', fields: [
        field('bavProvider', 'Versicherer / Versorgungsträger', { type: 'text' }),
        field('bavTariff', 'Tarif / Durchführungsweg', { type: 'text', placeholder: 'z. B. Direktversicherung · Tarifstand' }),
        field('bavParticipationPercent', 'Teilnahme an der bAV', { unit: '% der Mitarbeitenden', value: 60 }),
        field('employeeDeferral', 'Entgeltumwandlung Mitarbeitender', { unit: '€ / Monat', value: 100 }),
        field('employerSubsidyPercent', 'Arbeitgeberzuschuss auf Entgeltumwandlung', { unit: '%', value: 15 }),
        field('extraEmployerBav', 'Zusätzlicher Arbeitgeberbeitrag', { unit: '€ je Teilnehmendem / Monat', value: 25 }),
        field('estimatedNetImpactPercent', 'Geschätzter Nettoaufwand der Entgeltumwandlung', { unit: '% des Umwandlungsbetrags', value: 55 }),
      ] },
      { title: 'Vergleich mit anderen Benefits', fields: [
        field('comparisonBudgetMonthly', 'Vergleichsbudget', { unit: '€ je Person / Monat', value: 30 }),
        field('salaryOnCostsPercent', 'Arbeitgebernebenkosten bei Gehalt', { unit: '% Planwert', value: 20 }),
      ] },
    ],
    calculator: 'corporate-benefits',
    researchSources: CORPORATE_BENEFIT_SOURCES,
  },
  {
    id: 'topic-consultation', group: 'finance', icon: '◇', title: 'Einzelne Themenberatung', short: 'Nur das konkrete Kundenanliegen erfassen und dokumentieren.', status: 'ready', badge: 'Startklar',
    sections: [{ title: 'Thema', fields: [field('topic', 'Beratungsthema', { type: 'text' }), field('currentSituation', 'Ausgangslage', { type: 'textarea', wide: true }), field('desiredOutcome', 'Gewünschtes Ergebnis', { type: 'textarea', wide: true })] }],
  },
  {
    id: 'retirement-planning', group: 'retirement', icon: '↗', title: 'Altersvorsorgeplanung', short: 'Versorgungslücke, Kapitalbedarf und notwendige Sparrate sichtbar machen.', status: 'ready', badge: 'Rechner',
    sections: [{ title: 'Ruhestand', fields: [field('currentAge', 'Aktuelles Alter'), field('retirementAge', 'Gewünschtes Rentenalter'), field('desiredNetPension', 'Gewünschtes Netto im Ruhestand', { unit: '€ / Monat' }), field('expectedPension', 'Erwartete gesetzliche / berufliche Rente', { unit: '€ / Monat' }), field('existingPrivatePension', 'Bestehende private Renten', { unit: '€ / Monat' }), field('existingCapital', 'Vorhandenes Vorsorgekapital', { unit: '€' }), field('inflation', 'Inflation', { unit: '%', value: 2 }), field('returnRate', 'Rendite bis Rentenbeginn', { unit: '%', value: 4 }), field('withdrawalRate', 'Entnahmerate im Ruhestand', { unit: '%', value: 3.5 })] }], calculator: 'retirement-gap',
  },
  {
    id: 'depot-comparison', group: 'retirement', icon: '⇄', title: 'Depot / Fondspolice vergleichen', short: 'Zwei Spar- oder Anlagewege mit Rendite und Kosten gegenüberstellen.', status: 'ready', badge: 'Rechner',
    sections: [
      { title: 'Rahmen', fields: [field('years', 'Laufzeit', { unit: 'Jahre', value: 25 }), field('taxRate', 'Steuer auf Ertrag (vereinfacht)', { unit: '%', value: 25 })] },
      { title: 'Variante A', fields: [field('scenarioAName', 'Bezeichnung A', { type: 'text', value: 'Depot' }), field('initialA', 'Startkapital A', { unit: '€' }), field('monthlyA', 'Sparrate A', { unit: '€ / Monat' }), field('returnA', 'Bruttorendite A', { unit: '%', value: 6 }), field('costA', 'Laufende Kosten A', { unit: '%', value: 0.4 })] },
      { title: 'Variante B', fields: [field('scenarioBName', 'Bezeichnung B', { type: 'text', value: 'Fondspolice' }), field('initialB', 'Startkapital B', { unit: '€' }), field('monthlyB', 'Sparrate B', { unit: '€ / Monat' }), field('returnB', 'Bruttorendite B', { unit: '%', value: 6 }), field('costB', 'Laufende Kosten B', { unit: '%', value: 1.2 })] },
    ], calculator: 'depot-comparison',
  },
  {
    id: 'contract-comparison', group: 'insurance', icon: '≠', title: 'Alt-/Neu-Vertragsvergleich', short: 'Sachverträge quellenbasiert Leistung für Leistung gegenüberstellen.', status: 'knowledge-needed', badge: 'Quellenprüfung',
    notice: 'Ein belastbarer Leistungsvergleich wird nur aus hinterlegten Originalunterlagen erzeugt. Ohne Versicherungsbedingungen oder Produktinformationsblatt markiert IVA das Ergebnis als unvollständig.',
    sections: [
      { title: 'Altvertrag', fields: [field('oldCompany', 'Gesellschaft alt', { type: 'text' }), field('oldTariff', 'Tarif alt', { type: 'text' }), field('oldYear', 'Tarifstand / Jahr'), field('oldPolicyNumber', 'Versicherungsscheinnummer', { type: 'text' })] },
      { title: 'Neuvertrag', fields: [field('newCompany', 'Gesellschaft neu', { type: 'text' }), field('newTariff', 'Tarif neu', { type: 'text' }), field('newYear', 'Tarifstand / Jahr'), field('comparisonFocus', 'Besonders wichtige Leistungsmerkmale', { type: 'textarea', wide: true })] },
    ], knowledgeSearch: true,
  },
  {
    id: 'property-calculator', group: 'property', icon: '⌂', title: 'Immobilien- & Finanzierungsrechner', short: 'Kaufnebenkosten, Finanzierung, Rate, Restschuld und Mietrendite berechnen.', status: 'ready', badge: 'Rechner',
    sections: [{ title: 'Immobilie & Finanzierung', fields: [field('purchasePrice', 'Kaufpreis', { unit: '€' }), field('ancillaryPercent', 'Kaufnebenkosten', { unit: '%', value: 12 }), field('equity', 'Eigenkapital', { unit: '€' }), field('interestRate', 'Sollzins', { unit: '%', value: 3.5 }), field('repaymentRate', 'Anfängliche Tilgung', { unit: '%', value: 2 }), field('years', 'Betrachtungszeitraum', { unit: 'Jahre', value: 10 }), field('monthlyRent', 'Kaltmiete / Mietwert', { unit: '€ / Monat' }), field('maintenance', 'Instandhaltung / nicht umlagefähig', { unit: '€ / Monat' })] }], calculator: 'property-financing',
  },
  {
    id: 'gkv-comparison', group: 'health', icon: '+', title: 'Gesetzliche Krankenkassen', short: 'Kassenvergleich vorbereiten und später über den gewählten Anbieter rechnen.', status: 'connector-ready', badge: 'Anbindung vorbereitet',
    notice: 'Die Kunden- und Beratungsdaten können bereits erfasst werden. Tarifdaten und Ergebnisse werden erst angezeigt, wenn ein Vergleichsportal angebunden ist.',
    sections: [{ title: 'Vergleichsdaten', fields: [field('currentFund', 'Aktuelle Krankenkasse', { type: 'text' }), field('grossIncome', 'Bruttoeinkommen', { unit: '€ / Monat' }), field('employmentType', 'Status', { type: 'select', options: ['Angestellt', 'Selbstständig', 'Rentner/in', 'Studierend', 'Sonstiges'] }), field('state', 'Bundesland', { type: 'text' }), field('familyInsured', 'Familienversicherung relevant', { type: 'select', options: ['Nein', 'Ja', 'Prüfen'] }), field('priorities', 'Prioritäten', { type: 'textarea', wide: true, placeholder: 'z. B. Zusatzbeitrag, Bonus, Osteopathie, Zahnreinigung, Service' })] }],
  },
  {
    id: 'energy-planning', group: 'energy', icon: '⌁', title: 'PV- & Wärmepumpen-Energieplaner', short: 'TMB, Gebäudeaufnahme, Foto-Checkliste, Heizlast-Vorplanung, Förderung, PV und Wärmepumpenplanung.', status: 'ready', badge: 'Energie-Fallakte', launchMode: 'energie',
    notice: 'Der Energieplaner öffnet eine vollständige Energie-Fallakte für den ausgewählten Kunden.',
    sections: [],
  },
  {
    id: 'energy-tariff-comparison', group: 'energy', icon: '⚡', title: 'Strom- & Gasvergleich', short: 'Verbrauch und Kundendaten erfassen, EnergyPartner-Anfrage vorbereiten und Ergebnisse später in der Beratungsakte dokumentieren.', status: 'connector-ready', badge: 'EnergyPartner',
    notice: 'Ohne belegtes Ergebnis des Tarifportals zeigt IVA keine Preise, Boni oder Laufzeiten an und reicht keinen Vertrag ein.',
    sections: [{ title: 'Tarifanfrage', fields: [
      field('commodity', 'Sparte', { type: 'select', options: [{ value: 'electricity', label: 'Strom' }, { value: 'gas', label: 'Gas' }] }),
      field('annualConsumptionKwh', 'Jahresverbrauch', { unit: 'kWh' }),
      field('postalCode', 'Postleitzahl', { type: 'text' }),
      field('city', 'Ort', { type: 'text' }),
      field('meterType', 'Zählerart / Sondertarif', { type: 'text', placeholder: 'z. B. Haushaltsstrom, Wärmepumpe, HT/NT' }),
      field('currentSupplier', 'Aktueller Versorger', { type: 'text' }),
      field('currentTariff', 'Aktueller Tarif', { type: 'text' }),
      field('desiredStartDate', 'Gewünschter Vertragsbeginn', { type: 'text', placeholder: 'z. B. nächstmöglich' }),
      field('notes', 'Hinweise / gewünschte Kriterien', { type: 'textarea', wide: true, placeholder: 'z. B. Preisgarantie, Ökostrom, maximale Laufzeit' }),
    ] }],
  },
];

export function publicAdviceCatalog() {
  return { version: 1, groups: ADVICE_GROUPS, modules: ADVICE_MODULES };
}

export function getAdviceModule(id) {
  return ADVICE_MODULES.find(module => module.id === id) || null;
}

export function adviceConnectorStatus() {
  const url = String(process.env.GKV_COMPARE_URL || '').trim();
  const provider = String(process.env.GKV_COMPARE_PROVIDER || '').trim();
  const tariffs = energyTariffStatus();
  return {
    gkv: { configured: Boolean(url), provider: provider || '', launchUrl: url || '' },
    energyTariffs: {
      configured: tariffs.portalLoginConfigured || tariffs.apiCredentialsConfigured,
      comparisonEnabled: tariffs.comparisonEnabled,
      provider: tariffs.provider,
      launchUrl: tariffs.portalUrl,
      mode: tariffs.mode,
      reason: tariffs.reason,
    },
  };
}
