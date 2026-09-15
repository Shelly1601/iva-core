import { adviceError, cleanText, safeAdviceUrl } from './comparison.js';

export const ADVICE_PROVIDER_SOURCES = [
  { id: 'blau-caas', title: 'blau direkt / Dionera: Calculation as a Service', url: 'https://docs.blaudirekt.dev/caas/', checkedAt: '2026-09-16', finding: 'Dokumentierte Berechnungs-API, getrennt vom vollständigen Vergleichsprozess. Kein Nachweis eines freigeschalteten IVA-Zugangs.' },
  { id: 'blau-launch', title: 'blau direkt: Vergleichsrechner einbinden', url: 'https://docs.blaudirekt.dev/vergleichsrechner/', checkedAt: '2026-09-16', finding: 'Projekt-/Vermittler- und Rechnerzuordnung ist für den passenden Portalstart erforderlich.' },
  { id: 'blau-oauth', title: 'blau direkt: AMEISE OAuth2 / OIDC', url: 'https://docs.blaudirekt.dev/ameise-apis/auth/', checkedAt: '2026-09-16', finding: 'AMEISE-Datenzugang und CaaS-Berechnungszugang sind getrennte Anbindungen.' },
  { id: 'blau-marketplace', title: 'blau direkt Marketplace', url: 'https://www.blaudirekt.de/marketplace/', checkedAt: '2026-09-16', finding: 'Spartenabhängige Partnerrechner, unter anderem für Sach, Kfz, KV und LV; keine pauschale Freischaltung aller Sparten.' },
  { id: 'nafi-portals', title: 'NAFI: API für Portale', url: 'https://www.nafi.de/Produkte/Portale', checkedAt: '2026-09-16', finding: 'Offizielles API-Angebot für Kfz und mehrere Sachsparten; individueller Vertrag und Integration erforderlich.' },
  { id: 'nafi-interface', title: 'NAFI: Schnittstellen', url: 'https://www.nafi.de/Dienstleistungen/Schnittstellen', checkedAt: '2026-09-16', finding: 'Übergabe von Kunden-/Risikodaten und Rückgabe eines berechneten Tarifs an ein MVP werden angeboten.' },
  { id: 'inflation', title: 'Bundesbank: Wert stabilen Geldes', url: 'https://publikationen.bundesbank.de/publikationen-de/schule-bildung/geld-und-geldpolitik-921580?article=5-der-wert-stabilen-geldes-922608', checkedAt: '2026-09-16', finding: 'Nominale Geldbeträge und reale Kaufkraft sind zu unterscheiden.' },
  { id: 'costs', title: 'BMF: Produktinformationsblatt und Effektivkosten', url: 'https://www.bundesfinanzministerium.de/Monatsberichte/2017/04/Inhalte/Kapitel-3-Analysen/3-6-Das-neue-Produktinformationsblatt.html', checkedAt: '2026-09-16', finding: 'Produktbezogene Kosteninformationen sind für einen tatsächlichen Vorsorgevergleich zusätzlich zur Modellrechnung erforderlich.' },
];
const SPECS = [
  { id: 'blau-direkt', label: 'blau direkt / AMEISE', categories: ['sach', 'kv', 'lv', 'kfz'], sourceId: 'blau-marketplace', steps: ['Projekt und Vermittler-/Mandantenzuordnung im vorhandenen Poolzugang prüfen.', 'Für die gewünschte Sparte freigeschalteten Rechner und dessen Original-Startlink hinterlegen.', 'Für einen automatischen Tarifrücklauf zusätzlich CaaS-/Partnerberechtigung und aktuelle Original-Spezifikation bereitstellen; Zugang nur im geschützten Verbindungsspeicher hinterlegen.', 'Testangebot auf Risikodaten, Bruttobeitrag, Unterlagen und Gültigkeit prüfen. Erst danach einen geprüften Live-Adapter aktivieren.'] },
  { id: 'nafi', label: 'NAFI', categories: ['sach', 'kfz'], sourceId: 'nafi-portals', steps: ['Lizenz-/Poolzuordnung für dieses Projekt prüfen.', 'Offizielle API-/MVP-Dokumentation und Testfreigabe dem Projekt zuordnen.', 'Kunden- und Risikofelder sowie Tarif-/Dokumentrücklauf mit Testfällen abnehmen.'] },
  { id: 'insurer', label: 'Versicherer direkt / Originalformular', categories: ['sach', 'kv', 'lv', 'kfz'], sourceId: null, steps: ['Aktuellen Original-Portalstart oder interaktive Original-PDF dieses Versicherers bereitstellen.', 'Kunden-/Risikofelder ausdrücklich dem Formular zuordnen; Unbekanntes bleibt leer.', 'Ausgefüllte Vorschau prüfen. IVA bereitet nur vor und reicht nichts ein.'] },
];
export function providerCatalog(configurations = {}) {
  return SPECS.map(spec => ({ ...spec, ...configurations[spec.id], status: configurations[spec.id]?.portalUrl ? 'portal-link-only' : 'setup-required', liveQuotes: false, adapterImplemented: false, originalFormPreparation: true }));
}
export function normalizeProviderSetup(id, input) {
  if (!SPECS.some(row => row.id === id)) throw adviceError('Unbekannter Anbieter.');
  return { id, portalUrl: safeAdviceUrl(input.portalUrl), accountLabel: cleanText(input.accountLabel, 'Projektkonto-Bezeichnung', 150, true), brokerReference: cleanText(input.brokerReference, 'Vermittlerzuordnung', 150, true),
    accessRecorded: input.accessRecorded === true, mode: 'preparation-only', liveQuotes: false, updatedAt: new Date().toISOString() };
}
export function buildProviderPreparation(record, customer, provider) {
  if (!provider || !provider.categories.includes(record.category)) throw adviceError('Dieser Anbieter ist für die gewählte Sparte nicht vorbereitet.');
  return { schemaVersion: 1, status: 'prepared-not-submitted', provider: provider.id, projectId: record.projectId, caseId: record.id, revision: record.revision, category: record.category,
    portalUrl: provider.portalUrl || null, liveQuote: false, submitted: false,
    customer: Object.fromEntries(['id', 'name', 'email', 'phone', 'mobile', 'address', 'postalCode', 'city', 'birthDate'].filter(key => customer[key] !== undefined).map(key => [key, customer[key]])),
    oldContract: record.oldContract ? { provider: record.oldContract.provider, tariff: record.oldContract.tariff, premium: record.oldContract.premium, notes: record.oldContract.notes } : null,
    requirements: record.criteria, notes: record.notes, risk: record.riskProfile,
    missing: [!provider.portalUrl ? 'Original-Portalstart noch nicht hinterlegt.' : null, !record.oldContract ? 'Altvertrag noch nicht erfasst.' : null, 'Anbieterabhängige Pflichtfelder und endgültige Angebotserstellung im Originalsystem prüfen.'].filter(Boolean),
    instructions: 'Lokale Übergabevorbereitung. Enthält Kundendaten; nur dem ausdrücklich gewählten Anbieter zuordnen. Es wurde kein Angebot abgerufen und kein Antrag eingereicht.' };
}
