# IVA Investment-Agent – Saxo-Grundlage

Stand: 22. August 2026

## Zielbild

Der Investment-Agent verbindet Nadines eigenes Saxo-Depot mit IVA. Er macht Depotstand, Konten, Liquidität, Positionen, offene Orders und Performance sichtbar, prüft das Portfolio deterministisch gegen Nadines eigene Risikogrenzen und hält Watchlist sowie Investmentthesen nachvollziehbar fest.

Die aktuelle Stufe endet absichtlich vor der Orderausführung:

1. Instrument in Saxos offizieller Referenz suchen.
2. These, Widerlegungskriterium und Horizont festhalten.
3. Order nur als internen IVA-Entwurf speichern.
4. IVA-Grenzen prüfen.
5. Saxos offiziellen `trade/v2/orders/precheck` für Kosten und Kontowirkung ausführen.
6. Keine Order an Saxo senden.

## Aktueller Funktionsumfang

- eigener Arbeitsbereich `/investment` mit erhaltenem IVA-Bildschirmagenten;
- eigener Fachagent `iva-investment` und Chat-Werkzeuge;
- OAuth Authorization Code Grant für Saxo SIM oder LIVE;
- Access- und Refresh-Token AES-256-GCM-verschlüsselt auf dem Railway-Volume;
- Konten, Balance, NetPositions, offene Orders und Performance über Saxo OpenAPI;
- Kursverzögerung sichtbar statt stillschweigend als Echtzeit auszugeben;
- Risiko-Ampel für Einzelpositionsgrenze, Mindestliquidität, Margin, Shorts, Hebelprodukte und nicht freigegebene Anlageklassen;
- interne Watchlist mit Saxo-UIC statt unsicherem Namensmatching;
- Orderentwürfe mit Pflichtthese, Limit-/Market-Order, Konto und Gültigkeit;
- Saxo-Precheck plus zusätzlicher IVA-Orderwertgrenze;
- Audit-Trail in `/data/investment.json`;
- keine Orderausführung, keine autonome Kaufentscheidung und keine Renditegarantie.

Die am 22. August 2026 angelegte Saxo-SIM-App besitzt auf Nadines ausdrücklichen Wunsch eine Saxo-Handelsberechtigung. Diese Berechtigung allein aktiviert in IVA keinen Orderversand: Der aktuelle IVA-Code endet weiterhin technisch am Precheck und weist beide Zustände getrennt aus.

## Saxo-Einrichtung

Saxo trennt SIM und LIVE vollständig. Der LIVE-Handelsaccount ersetzt kein Entwicklerkonto.

1. Kostenloses SIM-Entwicklerkonto im Saxo Developer Portal erstellen.
2. Persönliche SIM-App mit Authorization Code Grant und zunächst ohne automatische Orderausführung anlegen.
3. Redirect-URI exakt registrieren:
   `https://iva-core-production.up.railway.app/oauth/saxo/callback`
4. Railway-Secrets setzen:
   `SAXO_ENVIRONMENT=sim`, `SAXO_APP_KEY`, `SAXO_APP_SECRET`, `SAXO_REDIRECT_URI`, `SAXO_TOKEN_KEY`.
5. OAuth-Verbindung in `/investment` herstellen und SIM-Depot, Instrumentensuche sowie Precheck testen.
6. Erst nach erfolgreichem SIM-Test und finanziertem LIVE-Konto eine persönliche LIVE-App bei Saxo beantragen.
7. LIVE-App besitzt eigene App-Zugangsdaten. Vor dem Wechsel auf `SAXO_ENVIRONMENT=live` erneuter kontrollierter Lesetest; Orderausführung bleibt weiterhin gesperrt.

## Sicherheitsgrenzen

- `SAXO_APP_SECRET`, `SAXO_TOKEN_KEY`, Access- und Refresh-Token gehören nur in Railway beziehungsweise das verschlüsselte Volume.
- Browser und Frontend erhalten niemals App Secret oder OAuth-Token.
- OAuth-State ist signiert und zehn Minuten gültig.
- Standardstrategie erlaubt Aktien, ETFs, Fonds und Anleihen, aber keine Shorts, Margin oder Hebelprodukte.
- Saxos Precheck ist keine Order und keine Freigabeempfehlung.
- Eine spätere Orderausführung benötigt eine neue Produktentscheidung, eine Saxo-App mit Trading-Berechtigung, harte Betragslimits, starke erneute Authentifizierung, exakte Ordervorschau und eine separate Bestätigung unmittelbar vor dem Senden.

## Offizielle Grundlagen

- Umgebungen: https://www.developer.saxo/openapi/learn/environments
- OAuth Authorization Code Grant: https://www.developer.saxo/openapi/learn/oauth-authorization-code-grant
- LIVE-App für direkte Saxo-Kunden: https://www.developer.saxo/openapi/learn/direct-clients-request-for-openapi-application-credentials-for-the-live-environ
- Portfolio: https://www.developer.saxo/openapi/learn/portfolio
- Order-Precheck: https://www.developer.saxo/openapi/referencedocs/trade/v2/orders/post__trade__precheck
