const field = (key, label, options = {}) => ({ key, label, type: 'number', ...options });

export const ADVICE_GROUPS = [
  { id: 'finance', label: 'Finanzplanung' },
  { id: 'retirement', label: 'Vorsorge & Vermögen' },
  { id: 'insurance', label: 'Versicherungen' },
  { id: 'property', label: 'Immobilien' },
  { id: 'health', label: 'Gesundheit' },
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
  return { gkv: { configured: Boolean(url), provider: provider || '', launchUrl: url || '' } };
}
