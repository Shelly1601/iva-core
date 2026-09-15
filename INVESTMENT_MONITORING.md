# Saxo-Kursmonitor und lokales Paper-Depot

IVA liest Saxo-Konten, Positionen und Kurse über die OpenAPI. Der neue Kursmonitor kann deine ausdrücklich eingerichteten Kursregeln prüfen und Käufe oder Verkäufe **ausschließlich in einem lokalen virtuellen Depot** simulieren. Es werden weder Saxo-Orders noch Einzahlungen ausgeführt. Das gilt auch mit LIVE-Zugang oder einer Saxo-App mit Handelsrechten. Der bestehende manuelle Orderentwurf und Saxo-Precheck bleiben getrennte, bewusst ausgelöste Funktionen.

## Einmalige Verbindung

Ein Saxo-Konto allein enthält noch keine OpenAPI-App. SIM und LIVE benötigen getrennte Zugangsdaten; ein SIM-Login verbindet kein echtes Depot. Saxo beschreibt die Voraussetzungen unter [Umgebungen](https://www.developer.saxo/openapi/learn/environments) und [Authorization Code Grant](https://www.developer.saxo/openapi/learn/oauth-authorization-code-grant). LIVE-Zugang hängt von Saxos App-Freigabe ab.

In der Server-Konfiguration werden diese Werte benötigt:

| Variable | Inhalt |
| --- | --- |
| `SAXO_ENVIRONMENT` | `sim` oder `live`; ohne Angabe SIM |
| `SAXO_APP_KEY` | Schlüssel der passenden Saxo-App |
| `SAXO_APP_SECRET` | Secret derselben App, ausschließlich serverseitig |
| `SAXO_REDIRECT_URI` | Exakt die bei Saxo registrierte HTTPS-Adresse, beispielsweise `https://dein-iva.example/oauth/saxo/callback` |
| `SAXO_TOKEN_KEY` | Eigenständiger zufälliger Schlüssel mit mindestens 32 Zeichen für die Tokenverschlüsselung |

Im Investment-Bereich zeigt IVA die Redirect-Adresse für die aktuell geöffneten IVA-Domain und fehlende Variablen. Nach „Saxo verbinden“ erfolgen Login und Freigabe bei Saxo. OAuth-Tokens werden AES-GCM-verschlüsselt im privaten Server-Volume gespeichert und nicht an Browser oder Agenten ausgegeben. Nach einem Serverneustart während des Loginvorgangs die Verbindung neu starten. „Aktualisieren“ prüft die tatsächliche API-Erreichbarkeit; vorhandene Tokens allein werden nicht als bestätigte Erreichbarkeit dargestellt.

Bei Saxo müssen OpenAPI-Marktdaten freigeschaltet, deren Bedingungen akzeptiert und gegebenenfalls passende Börsendaten abonniert sein. Siehe [Marktdaten aktivieren](https://www.developer.saxo/excel/user-guide/enabling-market-data). Daten können fehlen oder verzögert sein. Insbesondere SIM liefert häufig keine Aktienkurse: [Saxos Erklärung zu NoAccess](https://openapi.help.saxo/hc/en-us/articles/4405160773661-Why-do-I-get-NoAccess-instead-of-prices). IVA umgeht keine Datenrechte und verändert keine Saxo-Sessionrechte; ein Session-Upgrade kann andere Saxo-Anwendungen beeinflussen. [Session Capabilities](https://www.developer.saxo/openapi/learn/session-capabilities)

## Monitor verwenden

1. Eindeutige Saxo-Instrumente zur Watchlist hinzufügen.
2. „Kursmonitor & Paper“ öffnen. Der Monitor ist anfangs ausgeschaltet; sämtliche Kapital-, Verlust- und Kostenfelder sind leer.
3. Für reine Beobachtung „Beobachten und Alarme“ wählen, Abfrageintervall und zulässiges Kursalter festlegen und aktivieren.
4. Für Paper Trading Monatsbudget, gesamtes virtuelles Kapital, Order- und Positionsgrenze, Tagesverlust, Drawdown sowie Gebühren- und Slippage-Annahmen ausdrücklich festlegen. Auch eine Kostenannahme von null muss eingegeben werden.
5. Gewünschtes Kapital mit „Nur virtuell einbuchen“ zuweisen. Diese Buchung verändert ausschließlich IVAs Paper-Depot. Danach Paper-Modus aktivieren und eigene einmalige Kursregeln anlegen.

Kursregeln sind explizite Schwellenwerte. Der Vergleich verwendet den Geldkurs, ersatzweise vorhandenen Mittel- oder letzten Kurs; eine Ausführung setzt anschließend vollständige verwendbare Geld-/Briefdaten voraus. Ein ausgelöster Alarm oder Paper-Auftrag bleibt erledigt. Eine neue Ausführung benötigt eine bewusst neu angelegte Regel. Alarme erscheinen im Journal; es wird keine externe Nachricht versandt.

Der Monitor liest höchstens die ersten 20 Watchlist-Werte über Saxos [InfoPrices-Abfrage](https://www.developer.saxo/openapi/referencedocs/trade/v1/infoprices/get__trade__list), nach Anlageklasse gebündelt. **Der Transport ist REST-Polling, kein Tick-Streaming.** Das einstellbare Zielintervall beträgt 15–300 Sekunden; Netzlaufzeit, Verarbeitung und Backoff können es verlängern. API-Requests laufen nach 15 Sekunden ab. Bei HTTP 429 wartet IVA entsprechend der Serverhinweise beziehungsweise konservativ vor einem neuen Versuch. [Saxo-Ratelimits](https://www.developer.saxo/openapi/learn/rate-limiting)

Saxo bietet für geringere Latenz separate WebSocket-Streams und Subscriptions. Diese erfordern unter anderem Kontext- und Referenz-IDs, Heartbeats, Reset-/Reconnect-Behandlung und Reautorisierung. Das ist hier nicht implementiert; `streamingConnected` bleibt ausdrücklich `false`. [Saxo Streaming](https://www.developer.saxo/openapi/learn/streaming)

## Grenzen und Auswertung

Das Monatslimit begrenzt virtuelle Einzahlungen pro Kalendermonat in Europe/Berlin. Das Kapitalmaximum begrenzt die Summe aller virtuellen Einzahlungen. Reale Saxo-Einzahlungen werden weder ausgeführt noch automatisch mit diesen lokalen Limits abgeglichen. Das ältere Analyse-Mandat ist kein Ersatz für diese getrennten Paper-Grenzen.

Paper Trading unterstützt ganze Aktien-/ETF-Stückzahlen in der gewählten Depotwährung, ohne Shorting, Margin oder geschätzte Währungsumrechnung. Käufe werden am Briefkurs und Verkäufe am Geldkurs zuzüglich deiner Slippage-/Gebührenannahmen simuliert. Cash, Order- und Positionsgröße werden bei jedem Fill erneut geprüft. Tagesverlust und Drawdown blockieren neue Käufe; auch die unmittelbare Wirkung von Spread und Kosten wird vor einem Kauf geprüft. Verkäufe zum Reduzieren bestehender Positionen benötigen weiterhin gültige Daten und ausreichende Mittel für ihre Kosten.

Fehlende, verspätete, ungültige oder nicht freigegebene Kurse und unbestätigte Marktöffnung blockieren Regeln. Kurszeitpunkt und Abrufzeitpunkt bleiben getrennt sichtbar. Bei Verbindungsabbruch gelten zwischengespeicherte Kurse nicht als aktuell bestätigt. Eine während der Kursabfrage geänderte Konfiguration verhindert Ausführungen aus diesem laufenden Durchgang.

Paper-Wert und G/V sind Simulationen beziehungsweise bei fehlenden Kursen gekennzeichnete Schätzwerte. Liquidität, Teilfills, tatsächliche Börsengebühren, Steuern, Dividenden und Kapitalmaßnahmen werden nicht vollständig modelliert. Verlustgrenzen verhindern weitere Käufe, garantieren aber keinen maximalen Verlust bei Kurslücken oder bestehenden Positionen. Daraus entstehen keine Gewinnzusage oder sichere Marktprognose.

Journal und Review halten Fehler, blockierte Regeln und simulierte Entscheidungen nachvollziehbar fest. Ein Review ergänzt den ursprünglichen Eintrag; es verändert keine Grenzen oder Regeln und trainiert kein Modell automatisch. Limits lassen sich ausschließlich über das Admin-Formular ändern. Es gibt keine automatischen Kapitalerhöhungen. Persistiert werden höchstens 1000 Journal-Ereignisse und 1000 Paper-Aufträge; die API zeigt jeweils die letzten 100, die Oberfläche die letzten 30 Journal-Ereignisse. Das ist kein unbegrenztes revisionssicheres Archiv.

## Einbindung und Prüfung

`investment/index.js` registriert die neuen `/api/investment/monitor`-Routen innerhalb des bestehenden Admin-Bereichs. Im äußeren App-Einstieg ist keine neue Route erforderlich. Die vorhandene Investment-Skill-Einbindung liefert `getInvestmentMonitoring` und `refreshInvestmentMonitoring`; diese Namen im Trader-Werkzeugkatalog ergänzen. Kein Agenten-Tool darf `configure` oder `deposit` erhalten. Die Modulinstanz besitzt `close()` zum Stoppen ihrer Timer.

Lokale Tests: `node --test scripts/verify-investment-monitor.mjs` sowie `node scripts/verify-investment.mjs`. Sie prüfen echte Client-/Monitorlogik mit isoliertem Speicher und simulierten Saxo-Antworten. Ein verbundener echter Saxo-Account und seine Marktdatenrechte müssen anschließend vom Betreiber geprüft werden; die Tests bestätigen keine externe Kontoanbindung.
