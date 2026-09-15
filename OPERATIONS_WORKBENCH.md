# Kundenwerkzeuge · 16. September 2026

Diese Erweiterung verbindet konkrete Arbeitsflächen mit dem vorhandenen IVA-Chat. Alle Daten-APIs liegen hinter dem Owner-Zugang. Beratung, Sales-Coach, WhatsApp und Prospecting sind separat im Projekt freischaltbar; die Steuervorbereitung verwendet das Modul Buchhaltung. Keiner dieser Bereiche wird dadurch öffentlich im Kundenportal freigegeben.

| Arbeitsfläche | Adresse | Tatsächlicher Umfang |
|---|---|---|
| Finanzplanung und Vergleiche | `/advice-workbench` | Modellrechnung, dokumentierte Versicherungsangebote, Gewichtung, Projektfavoriten, PDF und Ablage in der Kundenakte |
| Gespräch und Coaching | `/sales-coach` | Aufnahme/Import, anonyme Sprecher, spätere Benennung, belegte Coachingimpulse und geprüfte Gesprächsablage |
| Steuer vorbereiten | `/tax-preparation` | Firmenzuordnung, Jahresfragebogen, Belegzuordnung, offene Punkte, exportierbares Jahrespaket |
| WhatsApp | `/whatsapp` | Nummern-/Projektzuordnung, begrenzter Servicedialog, persönliche Übergabe, Calendly-Buchung mit Rücklesebeleg |
| Leads und Recruiting | `/prospecting` | Zielgruppenkampagnen, belegte öffentliche Recherche, CSV, LinkedIn-Suchlinks und Nachrichtenentwürfe |

Die Kundenmaske öffnet Vergleich und Coach mit bestehendem Projekt-/Kundenkontext. Das Cockpit enthält direkte Einstiege. IVA-Chatwerkzeuge können Steuerfragen, bestehende Gespräche und Leadkampagnen lesen bzw. beauftragte Antworten und Entwürfe speichern. Kein Sprachbefehl startet heimlich das Mikrofon.

## Nachgewiesene Verbindungen und offene Einrichtung

- Der vorhandene ElevenLabs-Zugang wurde einmal mit einem synthetischen Gespräch getestet: Scribe v2, zwei Sprecher, vier Segmente. Ein anschließender Groq-Coachingaufruf lieferte segmentbezogene Hinweise. Kein echtes Kundengespräch wurde übertragen.
- Calendly lieferte im tatsächlichen lesenden Test Benutzer und 18 Ereignistypen. Damit sind weder Schreibberechtigung noch eine erfolgreiche Buchung bewiesen.
- Meta-WhatsApp ist noch nicht eingerichtet. In der Oberfläche müssen die gewünschten Nummern, Projekte, Aufgaben und Ereignistypen gewählt werden. Token, Signaturgeheimnis und Verifikation bleiben in der Laufzeitumgebung.
- Blau-direkt-/NAFI-/Gesellschafts-Livetarife sind nicht implementiert oder als verbunden bestätigt. Der dokumentbasierte Vergleich und vorbereitete Originalformulare funktionieren unabhängig davon. Details und Grenzen: [Beratungs-Workbench](advice/WORKBENCH.md).
- Für LinkedIn ist kein Versandzugang vorhanden. North Data benötigt einen eigenen API-Vertrag und einen Adapter. Suchlinks, Quellenrecherche und Entwürfe sind ausdrücklich kein bestätigter Nachrichtenversand.
- Im geprüften Live-System war noch kein Buchhaltungs-Rechtsträger angelegt. Firmen werden ausdrücklich Projekten zugeordnet, Belege bleiben getrennt. Eine Vorbereitung ersetzt keine Steuerberechnung oder ELSTER-Übermittlung.

## Aufnahme und Kostenkontrolle

Der mobile Coach verarbeitet vollständige Abschnitte von ungefähr 45 Sekunden. Das ist kein unterbrechungsfreier Echtzeit-Audiokanal. Beim Telefonat auf demselben iPhone kann iOS die Aufnahme unterbrechen; Lautsprecher umgeht diese Grenze nicht. Ein zweites Aufnahmegerät oder der Import eines vorhandenen Mitschnitts ist der separate Aufnahmeweg. Die tatsächliche Hörqualität auf Nadines iPhone ist noch nicht getestet.

Netzausfall, Hintergrundwechsel oder Mikrofonunterbrechung halten die Aufnahme an. Wiederverbindung startet keinen neuen Modellaufruf. Begonnene Audio-/Modellaufrufe können trotzdem Kosten verursacht haben. Mehrfachaufrufe werden durch persistierte Auftragskennung und Audiohash begrenzt; unklare Ergebnisse bleiben sichtbar.

Codex' eigene Reconnection-Anzeige ist davon getrennt. Es wurde keine wirksame Abschaltung der eingebauten Codex-Verbindungsversuche vorgenommen. Die ausgewiesene Codex-Abrechnung basiert auf verarbeiteten Tokens; eine separate Gebühr nur für die Anzeige wurde in den offiziellen Angaben nicht gefunden. Keine Aussage, dass jeder erneute Versuch kostenlos sei.

## Forecast und Zugangsdaten

Der Angelo-Forecast erwartet jetzt genau fünf Spalten: Kalenderwoche, Kunde, Telefon, Adresse, Anlage. Telefonnummern werden als Text erhalten, fehlende Werte sichtbar ausgewiesen. Vor Versand gehört die Telefonnummer zum erneuten Planbar-Abgleich; eine Änderung macht den früheren Export ungültig. Dieser Bauauftrag versendet selbst keinen Forecast.

Apple „Passwörter“ und IVAs eigene Schlüsselbund-Einträge sind getrennte Speicher. Die Apple-App war bei der Prüfung gesperrt. Daraus folgt keine Aussage über Vollständigkeit oder Gültigkeit ihrer gespeicherten Einträge. IVAs Statusmeldung behauptet nur dann gespeicherte Portalzugänge, wenn Benutzername und Passwort tatsächlich vorliegen; bestehende Browseranmeldungen werden getrennt behandelt. Geheimnisse wurden nicht im Chat, Bericht oder Quellcode ausgegeben.

## Prüfungen

`npm run test:operations-workbench` umfasst Berechnung, Dokumente, PDF/Aktenablage, Coach, Projekt-/Firmenisolation, Steuerdatum, persistente Speicherclaims, WhatsApp/Calendly, Leadrecherche sowie den vollständigen HTTP-Server. Die bestehenden Rechner-, Credential-, Planbar-, Workspace-, Zugriffs- und Toolrouting-Prüfungen ergänzen diese Suiten.

Browserprüfungen verwenden isolierte lokale Daten und Anbieterfixtures. PDF-Berichte wurden zusätzlich gerendert und visuell geprüft. Der Meta-Webhook wurde durch den vollständigen Server mit gültiger und fehlender Signatur geprüft; der allgemeine IVA-Zugangsschutz blockiert den signierten Eingang nicht mehr. Keine echten Versicherungsanträge, LinkedIn-Nachrichten, WhatsApp-Nachrichten oder Termine wurden zum Test versendet bzw. gebucht.

Fachdetails: [Sales-Coach](sales-coach/README.md), [WhatsApp](WHATSAPP_AUTOMATION.md), [Beratung](advice/WORKBENCH.md), [Planbar-Forecast](PLANBAR_FORECAST_WORKFLOW.md).
