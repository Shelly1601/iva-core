# Chancenradar: Linkprüfung und wiederkehrende Entdeckung

## In IVA verwenden

1. `/opportunities` öffnen und einen öffentlichen Video- oder Webseitenlink einfügen. Eine konkrete Frage ist optional.
2. Der Auftrag läuft im Hintergrund. Nach einem Seitenwechsel zeigt IVA den gespeicherten Status wieder an.
3. Die erste Ansicht zeigt eine Ampel: Funktioniert, funktioniert bedingt oder funktioniert nicht. Fehlende Belege ergeben einen grauen offenen Status. „Bericht ansehen“ klappt Details auf. Die Ampel ist eine IVA-Einschätzung. Der vollständige Bericht enthält geprüfte Aussagen, Quellen, offene Punkte, Risiken, mögliche Umsetzung und einen kleinen Validierungstest.
4. Im Suchprofil Instagram-Konten/Hashtags, TikTok-Konten und allgemeine Suchbegriffe ergänzen. Einzelne Profile oder Websites können auch direkt unter Beobachtungsquellen eingetragen werden.
5. Täglich oder wöchentlich mit Uhrzeit und Wochentag wählen. Die Planung verwendet Europe/Berlin und berücksichtigt Sommerzeit. Ergebnisse landen in IVA; dieser Scheduler versendet keine Telegram-Nachrichten.

## Was eine Prüfung tatsächlich tut

- Apify liefert öffentliche Instagram-/TikTok-Metadaten und, soweit verfügbar, das konkrete Video. Gemini bekommt echte Videodaten bzw. den offiziellen YouTube-Videoeingang.
- Caption, Transkript, Bildbeobachtung und Tonbeobachtung bleiben getrennt. Nicht zugängliche, nicht ausgewählte und nicht vollständig erfasste Videos werden entsprechend gekennzeichnet. Ein Modell kann kurze Ereignisse im Video übersehen.
- Tavily sucht weitere Quellen zu Funktionsweise, Nachfrage und konkreten Risiken. Seiten werden nach Möglichkeit direkt gelesen. Suchauszüge und bloße Suchtreffer sind unterschiedlich gekennzeichnet.
- Zitate müssen auf tatsächlich vorhandene Quellen-IDs zeigen. Ein reiner Suchtreffer darf einen Claim nicht bestätigen. Mehrere Subdomains zählen nicht als mehrere Herausgeber; verschiedene Domains beweisen allein ebenfalls keine Unabhängigkeit.
- Nutzen, Aufwand und Risiken sind begründete Einschätzungen. Die Diagramme sind keine statistischen Erfolgswahrscheinlichkeiten. Fehlende Daten bleiben offen.
- Eine Videoidee ohne gelesenen Video-/Audioinhalt erhält keine positive Funktionsbestätigung. Kritische Rechtsfragen werden als Unsicherheit und konkrete Konsequenzen dargestellt, soweit keine passende Quelle vorliegt.

## Anbindungen

Die gemeinsamen Recherchezugänge werden serverseitig eingerichtet: `APIFY_TOKEN`, `TAVILY_API_KEY` und `GEMINI_API_KEY`; weitere konfigurierte Modellanbieter können die Synthese übernehmen. Das sind Infrastrukturzugänge. Ein eigenes Instagram-Konto wird pro Projekt separat verbunden und ist für öffentliche Recherche nicht automatisch erforderlich.

Das vorhandene Modellbudget gilt auch für diese Aufrufe. Reparaturversuche und Anbieterwechsel erhalten jeweils eine eigene Budgetprüfung. IVA führt höchstens zwei Webaufträge gleichzeitig aus; die begrenzte Warteschlange verhindert überfüllte Prozesse und ist kein Tageskontingent. Auch das Quellenbudget gilt pro Scan, nicht pro Tag.

## Betrieb und Fehlerfälle

Jobs speichern Status und Ergebnisse atomar. Ein Zeitlimit signalisiert Abbruch; verspätete Ergebnisse werden nicht nachträglich als fertig ausgegeben. Laufende Jobs eines früheren Serverstarts werden unterbrochen markiert. Automatische Termine erhalten vor Start einen exklusiven gespeicherten Beleg und werden nach Neustart nicht doppelt ausgeführt. Fehlgeschlagene Termine können manuell neu geprüft werden.

Ein Scan verteilt sein Quellenbudget auf die konfigurierten Ziele. Zurückgestellte Accounts und Videoprüfungen werden sichtbar gekennzeichnet und bei späteren Läufen berücksichtigt. Automatische Entdeckung ersetzt keine vertiefte Einzelprüfung einer Geschäftsidee. Ein neuer Scan integriert kein Tool, erstellt kein Projekt und startet keine Kampagne.

## Prüfung

`npm run test:growth` prüft Medienzugriff, Evidenzgrenzen, Hintergrundjobs, Zeitplanung, Projektzugänge, Marketing und Paper-Monitoring. Echte Provideraufrufe erfolgen ausschließlich in gesonderten Integrationsprüfungen. Lokale Browser-Fixtures sind keine Belege für eine verbundene Kundenintegration.

Vor der Medienanalyse zählt Gemini die tatsächlichen Eingabetokens. IVA reserviert diese Eingabe und maximal 12.000 Ausgabetokens anhand der hinterlegten EUR-Schätzpreise; die tatsächliche Providerrechnung kann abweichen. Fehlt die Zählung oder ein expliziter Modellpreis, bleibt die Quelle gegebenenfalls nur als Caption auswertbar.
