# Kundenakten: geprüfte Rechenwege und Vergleichsanbindungen

Stand der Quellcode- und Regressionprüfung: 15.09.2026. Die Ampel beschreibt den implementierten Rechenweg, nicht die Vollständigkeit eines Kundenfalls oder eine verbindliche Tarif-/Finanzierungszusage.

## API für Cockpit und Regeln

`advice/calculator-audit.js` exportiert `adviceCalculatorReadiness()` ohne Kundendaten oder Secrets. Ergebnis: `schemaVersion`, `checkedAt`, zwölf `modules`, vier `providers`, `energyRules`, `sources`. Pro Modul: `status` (`works`, `conditional`, `unavailable`), `trafficLight` (`green`, `yellow`, `red`), `calculationKind`, `formulaVerified`, `liveQuotes`, `automaticProposalEligible`, `reason`, `nextSteps`.

`automaticProposalEligible` ist bei den vorhandenen Rechenmodulen bewusst `false`: eine manuelle Szenariorechnung beweist weder einen besseren Tarif noch dessen Verfügbarkeit für einen bestimmten Kunden. Die Kundenbetreuungsregeln können einen Jahrescheck versenden; eine konkrete Spar-/Leistungsbehauptung benötigt zusätzlich aktuelle Originalangebote und eine vollständige Kosten-/Leistungsprüfung. Die Integration darf das Ergebnis nicht aus einem gesetzten Link oder Token herleiten.

`public/advice-calculators.js` exportiert den gemeinsamen Kern `calculateAdviceScenario(module, data)` für Browser und Server. Ausgaben sind `{status, values, items, issues, rulesVersion, automaticProposalEligible, note}`. Fehlende oder ungültige Pflichtwerte ergeben `data-required`, `values:null`, keine Zahlenkacheln. Ein expliziter Nullwert bleibt nullwertig, fehlende Daten werden nicht als null Euro dargestellt. Beträge in `values` bleiben ungerundet; gerundet wird erst für Anzeigen.

## Korrigierte Defekte

- Altersvorsorge: vorhandenes Kapital entwickelt sich bis Rentenbeginn mit. Effektive Jahresrendite wird in eine dazu passende Monatsrendite umgerechnet; Sparraten werden am Monatsende angenommen. Kein Entnahmeprozentsatz von 0, keine negative Laufzeit; sofortiger Rentenbeginn mit Kapitalfehlbetrag ergibt keine erfundene monatliche Sparrate.
- Depot: gleiche ganze Monatszahl für Einzahlungen und Wachstum. Jährliche Vermögenskosten werden nach der Wertentwicklung abgezogen; Steuer nur auf positiven Endgewinn. Rendite-/Kostenkonvention ist offengelegt. Das ist keine Abbildung der individuellen Depot-/Policenbesteuerung.
- Liquidität und Unternehmen: 0 Euro wird nicht durch einen anderen Wert ersetzt, 0 Beschäftigte nicht zu einer Person umgedeutet. Fehlende Angaben bleiben offen.
- Immobilien: Tilgungsverlauf mit tatsächlicher letzter Rate, Restschuld nie negativ; Nullzins und vollständige Tilgung geprüft. Cashflow ist als anfänglicher Cashflow gekennzeichnet.
- Firmenvorsorge: fehlende optionale Angaben verwenden die vorgesehenen Planwerte; eine numerische Dezimalzahl wird nicht durch Tausenderformatierung verfälscht. Negative/nichtfinite/falsche Angaben sperren die Rechnung.
- PV: 11 × 485 W sind 5,335 kWp. Die Leistung wird nicht vor der Ertragsberechnung auf zwei Nachkommastellen gerundet. Stückzahlen müssen ganzzahlig sein; Grenzverletzungen werden nicht still zurechtgestutzt. Preise bleiben Cent-genau.
- Wärmepumpenverbrauch: Liter, Gas-kWh und Gas-m³, JAZ und Kesselwirkungsgrad sind separat berücksichtigt; ungültiger Verbrauch ergibt keinen scheinbar fertigen Nullverbrauch.
- Heizlast: eine ausdrücklich eingegebene Raumhöhe 0 wird nicht aus Gebäudedaten überschrieben. Nichtfinite Rechenergebnisse werden abgefangen. Die Methode bleibt technische Vorplanung, keine vollständige DIN-Auslegung.
- KfW: deutsche Geldbeträge werden korrekt gelesen; Notiz-Zusammenfassung verlangt das vorhandene `canUseForFundingNote`-Signal. Förderregeln wurden hier nicht geändert.
- EnergyPartner: Gas-Heizverbrauch wird nur für Gas und nach passender Energieträger-/Einheitenprüfung übernommen. Haushalts-/Wärmepumpenstrom braucht den eigenen Verbrauch. Explizite 0 wird nicht automatisch ersetzt, PLZ wird geprüft.

## Tatsächliche Anbieterlage

- **NAFI:** offizielles API-Angebot für Portale und MVP-Schnittstellen sind dokumentiert. IVA enthält noch keinen Adapter und keine verifizierten Tarifantworten. Benötigt werden die zum Projekt passende Lizenz/Partnerzuordnung, offizielle Schnittstellendokumentation/Testzugang und anschließend ein geprüfter Adapter. Anbieterquellen: [Portal-API](https://www.nafi.de/Produkte/Portale), [Schnittstellen](https://www.nafi.de/Dienstleistungen/Schnittstellen), gelesen am 15.09.2026.
- **EnergyPartner24:** Anfragevorbereitung vorhanden, Live-Vergleich und Einreichung deaktiviert. Das [offizielle Portalangebot](https://energypartner24.de/) beschreibt persönliche Angebote; der [Login-Hinweis](https://energypartner24.de/login/) verweist für den aktuellen Portal-Link an den Partner-Manager. In den geprüften öffentlichen Seiten lag kein verifiziertes API-Schema vor. Ein vorhandener gespeicherter Zugang beweist keine funktionierende Automation.
- **GKV:** optionaler HTTPS-Portallink und Datenerfassung, kein geprüfter Tarif-Adapter. Nicht-HTTPS-Links und in URLs eingebettete Zugangsdaten werden nicht als konfigurierter Zugang ausgegeben.
- **Mannheimer/LUMIT:** Servicegebührenrechnung mit manuell übernommenem Originalbeitrag. Fehlt dieser, bleibt der Paketgesamtpreis offen. Kein automatischer Preisabruf.
- **DIN-Module:** strukturierte Eingaben und Grundrechnungen; keine Behauptung einer lizenzierten vollständigen DIN-Analyse.

## Prüfung

Neue fokussierte Fälle: `node scripts/verify-advice-calculator-audit.mjs`. Bestehende Prüfungen zusätzlich: Advice, Corporate Benefits, PV, Energy Calculations, Funding Calculation, Energy Tariffs, Presentations und LUMIT. Keine realen Kundenmails, Vertragswechsel, Portalbestellungen oder kostenpflichtigen Modellaufrufe für diese Prüfung.
