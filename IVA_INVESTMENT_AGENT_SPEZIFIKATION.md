# IVA Investment Intelligence – Saxo, Research, Chancenmonitor und Trust-Ladder

Stand: 22. August 2026

## Zielbild

Der Investment-Agent verbindet Nadines eigenes Saxo-Depot mit IVA. Er macht Depotstand, Konten, Liquidität, Positionen, offene Orders und Performance sichtbar, prüft das Portfolio deterministisch gegen Nadines eigene Risikogrenzen und hält Watchlist sowie Investmentthesen nachvollziehbar fest. Die Intelligence-Stufe ergänzt Tages-/Wochencharts, regelbasierte Mustererkennung, quellengeprüften Research, ein Chancen-Ranking, ein monatliches Investment-Mandat und ein Kalibrierungsjournal.

Ziel ist nicht „gute Börsensprache“, sondern ein messbares System: Jede aktuelle Tatsachenbehauptung braucht eine datierte Quelle, jede These eine Gegenhypothese und Widerlegung, jedes Chartmuster seine Kursbelege und jede Prognose einen vorab definierten Review.

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
- deterministische Tages- und Wochenchartanalyse aus Saxo Chart v3;
- Renditen, SMA 20/50/200, RSI 14, ATR 14, historische Volatilität, maximaler Drawdown und 20-/60-/252-Perioden-Spannen;
- regelbasierte Erkennung von steigender/fallender Marktstruktur, Breakout/Breakdown, SMA-Kreuzungen, Volatilitätskompression/-expansion, Inside-/Outside-Bar und Volumenbestätigung;
- Zeitebenen-Abgleich zwischen Tages- und Wochenregime;
- aktueller Web-Research mit gefetchten Originalquellen, Quellen-Halluzinationsfilter, lokalem Zahlenabgleich und Gegenprüfung;
- feste Quellenhierarchie: Filings/IR, Aufsicht/Börse, Zentralbanken/Statistik und Saxo vor Sekundärquellen; Social Media nur zur Hypothesensuche;
- Watchlist-Chancenmonitor mit transparentem Research-Prioritätsscore statt erfundener Renditeprognose;
- automatischer Scan nach hinterlegtem Takt, sobald Betrag X gesetzt und Saxo autorisiert ist; kein automatischer Quellenresearch und keine Order;
- monatliches Mandat mit Betrag X, Reserve, maximalem Monatsverlust, Drawdown-, Volatilitäts- und Produktgrenzen;
- Autonomie-Leiter `observe → propose → sim-auto → separater LIVE-Review`;
- Prognosejournal mit These, Gegenhypothese, Widerlegung, Referenzkurs, Horizont und Wahrscheinlichkeit;
- Brier-Score, Richtungsquote, Stichprobengröße und Mindest-Bewährungszeit statt nachträglicher Erfolgsbehauptungen;
- keine LIVE-Orderausführung, keine ungeprüfte LIVE-Autonomie und keine Renditegarantie.

Die am 22. August 2026 angelegte Saxo-SIM-App besitzt auf Nadines ausdrücklichen Wunsch eine Saxo-Handelsberechtigung. Diese Berechtigung allein aktiviert in IVA keinen Orderversand: Der aktuelle IVA-Code endet weiterhin technisch am Precheck und weist beide Zustände getrennt aus.

## Monatliches Mandat und Autonomie

Nadine kann einen monatlichen Betrag X hinterlegen. IVAs Optimierungsziel lautet verbindlich **risikoadjustiertes Wachstum unter harten Verlustgrenzen**, nicht „Rendite egal wie“. Eine Zielfunktion ohne Risikobudget würde Hebel, Konzentration und Ruin belohnen und ist deshalb technisch nicht zulässig.

Die Stufen:

1. `observe`: Charts, Muster, Quellen und Depotrisiken beobachten.
2. `propose`: begründete Kandidaten und Allokations-/Orderentwürfe vorschlagen.
3. `sim-auto`: dieselbe Logik im Saxo-SIM-/Kalibrierungsbetrieb selbständig durchspielen; kein LIVE-Geld.
4. LIVE-Review erst nach mindestens 30 bewerteten Prognosen, sechs Beobachtungsmonaten, ausreichender Kalibrierung, mindestens zehn quellengetragenen Analysen und erfüllten Risikogrenzen.
5. Auch ein bestandener Review aktiviert nicht automatisch den Orderversand. Dafür braucht es einen getrennten Codepfad, starke erneute Authentifizierung, unmittelbare Ordervorschau, Kill-Switch, Verluststop und eine eigene dokumentierte Produktentscheidung.

Echte Optionskontrakte und Hebelprodukte werden nicht mit dem allgemeinen Begriff „Anlagechancen“ gleichgesetzt. Sie benötigen vor einer Freigabe ein separates Modell für maximale Verlustmechanik, Greeks, Liquidität, Assignment/Exercise, Volatilität und Gap-Risiko.

## Analyse-Standard

Jede vollständige Vorlage prüft zwölf Linsen: Mandat/Horizont, Instrumentidentität, Datenfrische, Fundament/Qualität, Bewertung, Marktstruktur/Technik, Makroregime, Katalysatoren, Gegenhypothese, Portfolio-Wirkung, Ausführung und messbaren Review. Charts bestimmen, **was tiefer recherchiert wird**; sie beweisen nicht, was künftig die höchste Rendite erzielt.

Der automatische Chancenmonitor läuft nach dem Mandats-Takt, sobald Betrag X größer null und die Saxo-OAuth-Verbindung bereit ist. Er analysiert die Watchlist in Tages- und Wochenzeitebene, speichert den Lauf und priorisiert Kandidaten für den nachgelagerten Quellenresearch. Teurer Quellenresearch bleibt bewusst bestätigt; LIVE-Orders bleiben gesperrt.

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
- Chart v3: https://www.developer.saxo/openapi/referencedocs/chart/v3/charts/get__chart
- Instrumentdetails: https://www.developer.saxo/openapi/referencedocs/ref/v1/instruments/get__ref__details_uic_assettype
- SEC EDGAR APIs: https://www.sec.gov/search-filings/edgar-application-programming-interfaces
- ECB Data Portal: https://data.ecb.europa.eu/
- Order-Precheck: https://www.developer.saxo/openapi/referencedocs/trade/v2/orders/post__trade__precheck
