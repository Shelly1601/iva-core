import { ADVICE_MODULES, adviceConnectorStatus } from './catalog.js';
import { ADVICE_CALCULATION_VERSION } from '../public/advice-calculators.js';
import { FUNDING_RULES_VERSION, FUNDING_RULES_CHECKED_AT } from '../workspaces/energy-calculations.js';
import { PV_PRICE_VERSION } from '../workspaces/pv-price-calculator.js';

export const CALCULATOR_AUDIT_CHECKED_AT = '2026-09-16';
export const COMPARISON_PROVIDER_SOURCES = [
  { provider: 'NAFI', title: 'NAFI API für Portale', url: 'https://www.nafi.de/Produkte/Portale', checkedAt: CALCULATOR_AUDIT_CHECKED_AT },
  { provider: 'NAFI', title: 'NAFI Schnittstellen', url: 'https://www.nafi.de/Dienstleistungen/Schnittstellen', checkedAt: CALCULATOR_AUDIT_CHECKED_AT },
  { provider: 'EnergyPartner24', title: 'EnergyPartner24 Vertriebsportal', url: 'https://energypartner24.de/', checkedAt: CALCULATOR_AUDIT_CHECKED_AT },
  { provider: 'EnergyPartner24', title: 'Hinweis zum aktuellen Partnerzugang', url: 'https://energypartner24.de/login/', checkedAt: CALCULATOR_AUDIT_CHECKED_AT },
];

const MODULE_READINESS = {
  'financial-plan-workbench': ['conditional', 'manual-scenario', true, 'Anspar- und Entnahmephase, effektive Rendite, konkrete Kostenannahmen und Kaufkraft sind getrennt berechnet und als Kunden-PDF verfügbar. Produktspezifische Steuern, Garantien und Kursschwankungen bleiben außerhalb der Modellrechnung.'],
  'insurance-workbench': ['conditional', 'document-comparison', true, 'Original-PDF/Text, wörtlich belegte Kriterien, Gewichtung, aktuelle Dokumentangebote, Ranking und Projektfavoriten sind implementiert. Anbieterzugänge und automatischer Live-Tarifrücklauf sind nicht verifiziert.'],
  'financial-holistic': ['works', 'arithmetic-summary', true, 'Cashflow, Nettovermögen und Rücklagenreichweite werden aus den vollständig erfassten Werten berechnet.'],
  'din-77230': ['conditional', 'structured-intake', true, 'Grundrechnungen funktionieren; für eine DIN-konforme Analyse fehlt das lizenzierte Regelwerk mit fachlicher Abnahme.'],
  'din-77235': ['conditional', 'structured-intake', true, 'Liquidität und Umsatz je Beschäftigtem werden berechnet; die vollständige DIN-Analyse ist nicht freigeschaltet.'],
  'corporate-benefits': ['conditional', 'manual-scenario', true, 'Kosten und Beiträge werden berechnet. Auswirkungen auf Fehlzeiten, Bindung und Nettoabrechnung bleiben ausdrücklich Annahmen; öffentliche bKV-Beispiele sind keine persönlichen Angebote.'],
  'topic-consultation': ['works', 'structured-intake', null, 'Themenberatung erfasst Anliegen und Ergebnisse; dieses Modul ist kein Tarifrechner.'],
  'retirement-planning': ['conditional', 'manual-scenario', true, 'Sparrate berücksichtigt nun die Entwicklung vorhandenen Kapitals. Inflation, Rendite und Entnahmerate sind Annahmen; konkrete Steuern und Produktkosten fehlen.'],
  'depot-comparison': ['conditional', 'manual-scenario', true, 'Laufzeit, effektive Rendite, Kosten und pauschale Endbesteuerung sind geprüft. Produktspezifische Steuer- und Vertragsregeln sind nicht abgebildet.'],
  'contract-comparison': ['conditional', 'document-comparison', null, 'Leistungsprüfung erfordert die Originalbedingungen beider Verträge. Automatische Live-Tarifberechnung über NAFI ist noch nicht angebunden.'],
  'property-calculator': ['conditional', 'manual-scenario', true, 'Annuität, Restschuld und Mietkennzahlen sind geprüft. Die Rechnung verwendet einen konstanten Sollzins und ersetzt kein konkretes Finanzierungsangebot.'],
  'gkv-comparison': ['unavailable', 'provider-quote', false, 'GKV-Datenerfassung und ein optionaler Portallink sind vorhanden. Ein Adapter mit geprüftem Ergebnisrücklauf fehlt.'],
  'energy-planning': ['conditional', 'technical-preplan', true, 'Heizlast, PV-Preisstand und Wärmepumpenverbrauch werden mit offengelegten Annahmen gerechnet. KfW-Vorprüfung erfordert datierte Nachweise; finale Auslegung und verbindliches Angebot bleiben gesondert.'],
  'energy-tariff-comparison': ['unavailable', 'provider-quote', false, 'EnergyPartner-Anfragen können vorbereitet werden. Ein authentifizierter, verifizierter Vergleich mit aktuellen Preisen ist noch nicht verfügbar.'],
};

/** Readiness of implemented paths, never a promise that a specific customer case is ready. */
export function adviceCalculatorReadiness() {
  const connectors = adviceConnectorStatus();
  const modules = ADVICE_MODULES.map(module => {
    const [status, calculationKind, formulaVerified, reason] = MODULE_READINESS[module.id] || ['unavailable', 'unknown', false, 'Für dieses Modul liegt noch keine Prüfung vor.'];
    return { id: module.id, title: module.title, group: module.group, status,
      trafficLight: status === 'works' ? 'green' : status === 'conditional' ? 'yellow' : 'red',
      calculationKind, formulaVerified, liveQuotes: false, automaticProposalEligible: false, reason,
      nextSteps: status === 'unavailable' ? ['Projektbezogenen Anbieterzugang hinterlegen.', 'Offizielles Datenschema und Testzugang zuordnen.', 'Vergleich und Preis-/Leistungsrücklauf prüfen, erst danach automatische Tarifvorschläge freischalten.'] : [],
    };
  });
  return {
    schemaVersion: 1, checkedAt: CALCULATOR_AUDIT_CHECKED_AT,
    calculationVersion: ADVICE_CALCULATION_VERSION,
    scope: 'Rechenwege und verfügbare Integrationen; keine Einzelfall-, Tarif- oder Zulassungsbestätigung.',
    modules,
    providers: {
      nafi: { provider: 'NAFI', status: 'not-connected', liveQuotes: false, automatedComparison: false, adapterImplemented: false,
        nextSteps: ['NAFI-Lizenz bzw. Poolzugang für das Projekt zuordnen.', 'NAFI um Portal-API-/MVP-Schnittstellendokumentation und Testdaten bitten.', 'Adapter für Risikoübergabe, Tarifantwort und Originalunterlagen implementieren und mit NAFI prüfen.'], sourceUrl: COMPARISON_PROVIDER_SOURCES[0].url },
      energyTariffs: { provider: connectors.energyTariffs.provider, status: connectors.energyTariffs.configured ? 'access-present-validation-pending' : 'access-required', liveQuotes: false, automatedComparison: false,
        mode: connectors.energyTariffs.mode, reason: connectors.energyTariffs.reason,
        nextSteps: ['Beim EnergyPartner-Manager den aktuellen EP24-Portalzugang für das Projekt anfordern oder vorhandenen Zugang hinterlegen.', 'Offizielles API-Schema oder den erlaubten authentifizierten Portalablauf bereitstellen.', 'Preise inklusive Grundpreis, Arbeitspreis, Boni, Laufzeit und Gültigkeit rücklesen und einem Kundenfall eindeutig zuordnen.'], sourceUrl: 'https://energypartner24.de/login/' },
      gkv: { provider: connectors.gkv.provider || 'Noch nicht ausgewählt', status: connectors.gkv.configured ? 'portal-link-only' : 'access-required', liveQuotes: false, automatedComparison: false,
        nextSteps: ['Vergleichsanbieter und Vertrag für das Projekt wählen.', 'Schnittstellenzugang und Tarifrücklauf einrichten und prüfen.'] },
      mannheimer: { provider: 'Mannheimer / LUMIT', status: 'manual-official-premium', liveQuotes: false, automatedComparison: false,
        reason: 'Der Paketpreis addiert einen manuell erfassten Originalbeitrag des Mannheimer-Rechners und die hinterlegte Servicegebühr. Ohne Originalbeitrag gibt es keinen Gesamtpreis.' },
    },
    energyRules: { kfwVersion: FUNDING_RULES_VERSION, kfwCheckedAt: FUNDING_RULES_CHECKED_AT, pvPriceVersion: PV_PRICE_VERSION },
    automaticProposalRule: 'Rechnerstatus allein erlaubt keine Kundenaussage über Einsparung oder bessere Leistung. Dafür werden eine aktuelle, kundenspezifische Original-Tarifantwort, vollständige Kosten und ein belegter Leistungsvergleich benötigt.',
    sources: COMPARISON_PROVIDER_SOURCES,
  };
}
