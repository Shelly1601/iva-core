const COMMON_LENSES = [
  { id: 'mandate', title: 'Mandat & Horizont', question: 'Passt das Instrument zu Ziel, Zeithorizont, Liquiditaetsbedarf und maximalem Verlustbudget?' },
  { id: 'identity', title: 'Instrument eindeutig', question: 'Sind UIC, AssetType, Boerse, Waehrung, Primaerlisting und Produktstruktur eindeutig?' },
  { id: 'freshness', title: 'Datenfrische', question: 'Wie alt und wie stark verzoegert sind Kurs, Berichtszahlen, Makrodaten und Ereignisse?' },
  { id: 'fundamentals', title: 'Fundament & Qualitaet', question: 'Welche belegten Treiber bestimmen Ertrag, Cashflow, Bilanzqualitaet und Kapitalallokation?' },
  { id: 'valuation', title: 'Bewertung', question: 'Welche Annahmen sind im Preis enthalten und wie empfindlich ist der Wert gegen Wachstum, Marge, Zins und Risikoaufschlag?' },
  { id: 'market', title: 'Marktstruktur & Technik', question: 'Was zeigen Trend, Momentum, Volatilitaet, Liquiditaet und Drawdown, ohne daraus allein eine Prognose zu machen?' },
  { id: 'macro', title: 'Makro & Regime', question: 'Welche Zins-, Inflations-, Konjunktur-, Waehrungs- oder Liquiditaetsregime wirken auf das Instrument?' },
  { id: 'catalysts', title: 'Katalysatoren', question: 'Welche datierten Ereignisse koennen die These bestaetigen oder widerlegen?' },
  { id: 'counter', title: 'Gegenhypothese', question: 'Was ist die staerkste plausible Gegenposition und welche Primaerquelle wuerde sie bestaetigen?' },
  { id: 'portfolio', title: 'Portfolio-Wirkung', question: 'Wie veraendern Positionsgroesse, Korrelation, Waehrung, Liquiditaet und Tail-Risiko das Gesamtdepot?' },
  { id: 'execution', title: 'Ausfuehrung', question: 'Sind Spread, Ordertyp, Handelszeit, Kosten, Steuern und Slippage vor einer bewussten Entscheidung geklaert?' },
  { id: 'review', title: 'Messbarer Review', question: 'Sind Prognose, Wahrscheinlichkeit, Widerlegung und Review-Datum vorab im Journal festgehalten?' },
];

const ASSET_QUESTIONS = {
  Stock: [
    'Umsatzwachstum organisch oder akquisitionsgetrieben?', 'Margen, Free Cashflow und Working Capital ueber einen Zyklus?',
    'Nettofinanzverschuldung, Faelligkeiten und Zinsdeckung?', 'Verwaesserung, Insidertransaktionen und Kapitalallokation?',
    'Kunden-, Produkt-, Lieferanten- und Regulierungsabhaengigkeiten?', 'Bewertung unter Bull-, Base- und Bear-Annahmen statt Ein-Punkt-Ziel?',
  ],
  Etf: [
    'Welcher Index und welche Methodik werden exakt repliziert?', 'Physisch, Sampling oder synthetisch; welche Gegenparteirisiken?',
    'TER plus Tracking Difference, Spread und Quellensteuerwirkung?', 'Fondsdomizil, Waehrung, Ausschüttung und Steuerstatus?',
    'Konzentration nach Titel, Sektor, Land und Faktor?', 'Fondsvolumen, Liquiditaet, Wertpapierleihe und Schliessungsrisiko?',
  ],
  Bond: [
    'Emittent, Rang, Besicherung, Covenants und Ausfallwahrscheinlichkeit?', 'Yield-to-Maturity, Duration, Konvexitaet und Reinvestment-Risiko?',
    'Zinskurven-, Spread-, Inflations- und Waehrungssensitivitaet?', 'Kuendigung, Wandel, Nachrang oder sonstige eingebettete Optionen?',
    'Faelligkeitsstruktur und Liquiditaet im Stress?', 'Realrendite nach Kosten, Steuer und Inflation?',
  ],
  MutualFund: [
    'Mandat, Benchmark, aktiver Anteil und Stiltreue?', 'Managerhistorie inklusive Rollenwechsel und Fondsverschmelzungen?',
    'Gesamtkosten, Ausgabeaufschlag, Performance Fee und Turnover?', 'Liquiditaet der Basiswerte und Rueckgaberegeln?',
    'Konzentration, Faktorwetten und Waehrungsrisiken?', 'Mehrwert nach Kosten gegen eine passende investierbare Benchmark?',
  ],
};

export const INVESTMENT_PLAYBOOK = Object.freeze({
  version: 'iva-investment-intelligence-1.0',
  asOf: '2026-08-22',
  doctrine: [
    'Keine These ohne Widerlegungskriterium.',
    'Keine aktuelle Tatsachenbehauptung ohne datierte Quelle.',
    'Primaerquelle vor Zusammenfassung; belegte Fakten vor Meinung.',
    'Wahrscheinlichkeit und Unsicherheit statt Gewissheit.',
    'Positionsgroesse ist Teil der Analyse, nicht deren spaeter Anhang.',
    'Ein technischer Indikator ist Zustandsmessung, kein alleiniger Handelsgrund.',
    'Ergebnisqualitaet wird im Journal kalibriert; gute Sprache zaehlt nicht als Treffer.',
  ],
  sourceHierarchy: [
    { tier: 1, label: 'Primaer', examples: ['Unternehmens-Filings und Investor Relations', 'Boersen- und Aufsichtsmitteilungen', 'Zentralbanken und Statistikbehoerden', 'Saxo Instrumenten- und Marktdaten'] },
    { tier: 2, label: 'Methodisch belastbar', examples: ['Index- und Fondsanbieter-Methodik', 'testierte Berichte', 'wissenschaftliche Originalarbeiten'] },
    { tier: 3, label: 'Sekundaer', examples: ['Nachrichtenagenturen', 'Broker-Research', 'Fachmedien'], rule: 'Nur als Hinweis oder zweite Perspektive, nicht als alleiniger Beleg fuer harte Zahlen.' },
    { tier: 4, label: 'Signal', examples: ['Social Media', 'Foren', 'Influencer'], rule: 'Nur zur Hypothesensuche; nie als Beweis.' },
  ],
  lenses: COMMON_LENSES,
  decisionGate: [
    'Instrument und Kursquelle eindeutig', 'Datenverzoegerung sichtbar', 'These und staerkste Gegenhypothese dokumentiert',
    'Wesentliche Fakten durch Primaerquellen belegt', 'Bull/Base/Bear-Szenario mit Annahmen', 'Portfolio- und Verlustwirkung innerhalb der Leitplanken',
    'Prognose und Review-Termin vor einer Entscheidung gespeichert',
  ],
  officialAnchors: [
    { label: 'Saxo Chart v3', url: 'https://www.developer.saxo/openapi/referencedocs/chart/v3/charts/get__chart' },
    { label: 'Saxo Instrument Details', url: 'https://www.developer.saxo/openapi/referencedocs/ref/v1/instruments/get__ref__details_uic_assettype' },
    { label: 'SEC EDGAR APIs', url: 'https://www.sec.gov/search-filings/edgar-application-programming-interfaces' },
    { label: 'ECB Data Portal', url: 'https://data.ecb.europa.eu/' },
  ],
});

export function playbookFor(assetType = '') {
  return {
    version: INVESTMENT_PLAYBOOK.version,
    doctrine: INVESTMENT_PLAYBOOK.doctrine,
    sourceHierarchy: INVESTMENT_PLAYBOOK.sourceHierarchy,
    lenses: INVESTMENT_PLAYBOOK.lenses,
    assetType: String(assetType || ''),
    assetQuestions: ASSET_QUESTIONS[assetType] || [
      'Produktstruktur, Zahlungsstroeme und Verlustmechanik vollstaendig verstanden?',
      'Primaerquellen, Marktliquiditaet, Kosten und Stressverhalten geklaert?',
    ],
    decisionGate: INVESTMENT_PLAYBOOK.decisionGate,
    officialAnchors: INVESTMENT_PLAYBOOK.officialAnchors,
  };
}
