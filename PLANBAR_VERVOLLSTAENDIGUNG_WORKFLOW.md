# Planbar Vervollständigung – verbindlicher Morgenworkflow

## Zeitplan und Umfang

Täglich um 08:00 Uhr (Europe/Berlin) auf diesem Mac Mini. Ausschließlich private Heat-Hero-Kunden; Enter, DeWarmte und B2B sind aus diesem Lauf ausgeschlossen. Ein HH-Präfix allein beweist keinen Privatkundenstatus. Unklare Zuordnungen zuerst lesend anhand der konkreten Deal-/Kundenakte klären.

Zuerst die dauerhafte Warteschlange `data/planbar-completion.json` abarbeiten. IVA legt nach jeder verifizierten Terminreservierung fehlende Beschreibungen, Auftragsnummern und sonstige offene Schritte dort ab. Ein Abgleich mit gespeicherten Terminierungsbelegen rekonstruiert die Warteschlange nach einem unterbrochenen Schreibschritt. Danach Planbar neu laden und alle einschlägigen Bestandsfälle vom Beginn der laufenden Woche bis zum Ende des rollierenden Zehn-Wochen-Forecasts prüfen. Nadines gestrige Nachrichten aus `Terminierungen Dispo` sind eine zusätzliche Quelle. Fehlender WhatsApp-Zugriff verhindert weder Warteschlangenbearbeitung noch Planbar-/Pipedrive-Prüfung.

Keine Fünf-Minuten-Abbruchregel. Technische Fehler beheben, gespeicherte Reservierungen rücklesen und beim ersten offenen Schritt fortsetzen. Nach mehreren technischen Fehlversuchen wartet derselbe Auftrag mit gespeichertem Zwischenstand; keine Doppelbuchung und keine neue Auftrags-ID. Echte externe Zugangsprobleme gelten nur für das betroffene System. Übrige unabhängige Fälle weiter bearbeiten. Kein Erfolg aufgrund eines freien Textberichts oder eines beendeten Prozesses.

## Sichere Fallzuordnung

0. Die ausdrückliche Beauftragung eines konkreten Kunden-/KW-Falls umfasst die notwendige fallspezifische Suche nach diesem Kundennamen in den bereits freigegebenen Systemen Planbar und Pipedrive. Dafür keine erneute Freigabe anfordern; Namen nur innerhalb des beauftragten Arbeitswegs verwenden und nicht in externe Berichte oder andere Systeme übertragen.
1. Falls WhatsApp zugänglich ist: die exakte Community und Gruppe `Terminierungen Dispo` prüfen und nur Nachrichten berücksichtigen, die nach sichtbarem Absender von Nadine stammen und gestern gesendet wurden.
2. Aus jeder relevanten Nachricht Kundenname und Kalenderwoche lesen. Mehrere identische Hinweise zu demselben Kunden und derselben KW bilden einen Fall. Widersprüchliche KW-Angaben werden nicht geraten.
3. In Planbar genau einen bestehenden Termin mit diesem Kunden in dieser sichtbaren Kalenderwoche verlangen. Der sichtbare Kalender ist für die KW allein maßgeblich. Eine abweichende interne Datums- oder Zeitraumangabe im Termindetail ist kein Blocker und wird nicht verändert.
4. Niemals einen Termin neu anlegen, löschen, verschieben oder einer anderen Ressource zuordnen. Bei keinem oder mehreren Treffern bleibt Planbar unverändert und der Fall kommt als Blocker in den Bericht.

## Täglicher Bestandscheck für Kürzel und Vollständigkeit

1. Nach den offenen IVA-Terminierungen und den zugänglichen WhatsApp-Hinweisen den aktuell relevanten sichtbaren Planbar-Zeitraum vom Beginn der laufenden Kalenderwoche bis zum Ende des derzeit für Angelo maßgeblichen rollierenden Forecast-Horizonts prüfen.
2. Geprüft werden nur echte Kundentermine. Urlaub, `nicht verfügbar`, Blocker und interne Standardaufgaben sind kein Prüfziel.
3. Bei jedem geprüften Kundentermin kontrollieren, ob im Feld `Vorname` genau einmal ein belegtes Partnerpräfix vorangestellt ist. In diesem Lauf ist ausschließlich `HH` für belegte private Heat-Hero-Fälle zulässig.
4. Fehlt das Präfix oder ist es falsch, darf es nur dann korrigiert werden, wenn der Partner für genau diesen bestehenden Fall eindeutig belegt ist, zum Beispiel durch die aktuelle WhatsApp-Nachricht, den passenden Heat-Hero-Deal oder einen anderen im Lauf sichtbar geöffneten Primärbeleg. Ohne eindeutigen Partnerbeleg keine Präfix-Schätzung; der Fall bleibt unverändert und wird als Blocker gemeldet.
5. Fehlen bei einem bestehenden Kundentermin Auftragsnummer oder Beschreibung ganz oder teilweise, darf dieser Termin auch ohne neue WhatsApp-Nachricht vervollständigt werden, sofern Kunde und KW eindeutig sind und die unten stehende Dokumentlogik den Fall eindeutig belegt.
6. Eine Beschreibung ist nicht schon deshalb vollständig, weil sie nicht leer ist. Der zwingende Anlagenbeleg ist ein vorn stehendes Wärmepumpen-Segment mit Leistung und Hersteller, zum Beispiel `10 kW Panasonic` oder `Wärmepumpe: 10 kW Panasonic`; das Wort `Anlage` muss dafür nicht wörtlich stehen. Reine Feldnotizen wie `Kunde kann das Material lagern`, eine bloße Wärmepumpe ohne `kW` oder eine `kW`-Angabe ohne Hersteller gelten genauso als unvollständig wie ein leeres Feld. Danach müssen bei Bosch zusätzlich die belegte Bosch-Nummer/Modellbezeichnung, bei Vaillant ausdrücklich `Plus` oder `Pro`, alle wirksam beauftragten Positionen und erforderlichen Speicherangaben nach diesem Workflow enthalten sein. Eine fehlende Pflichtangabe wird nachgezogen.
7. Bereits fachlich vollständige und korrekt präfixierte Termine bleiben unverändert.

## Lesender Formatvergleich mit Nadines Einträgen

1. Vor der ersten Änderung einige bestehende Planbar-Termine prüfen, bei denen vor dem Vornamen sichtbar `HH` steht. Diese Einträge stammen von Nadine und dienen ausschließlich als Formatbeispiele.
2. Nur wiederkehrende Darstellungsmerkmale ableiten: Aufbau und Reihenfolge der Beschreibung, Schreibweise der Wärmepumpe, Trennzeichen, Groß-/Kleinschreibung und Ablage der Auftragsnummer.
3. Die ausschließlich als Formatbeispiel ausgewählten fremden Einträge nicht verändern und keine Kundenangaben daraus in einen anderen Fall kopieren. Ein eigener unvollständiger HH-Fall wird nach seinem eigenen Beleg korrigiert. Sie ersetzen weder Angebot noch TMB und sind kein Beleg für den aktuellen Kundenfall.
4. Bei unterschiedlichen Beispielen oder einem Widerspruch zur verbindlichen Fachlogik gilt dieser Workflow. Die Abweichung wird im Ergebnisbericht genannt, statt ein Muster zu erraten.

## Frühere Übergaben

Vorhandene alte `planbar-completion-pending.json`/`planbar-completion-retry.json` nur einmal in die neue dauerhafte Warteschlange übernehmen, sofern sie tatsächlich offene, eindeutig private Heat-Hero-Fälle enthalten. Bestehende Reservierungen und geprüfte Ergebnisse erhalten. Frühere Sonderregeln für 25 Einzelfälle begründen keine allgemeine Vaillant-Pro-Regel und keinen veralteten außerplanmäßigen Forecast.

## Pipedrive- und Dokumentprüfung

1. Pipedrive wird nur lesend verwendet. Den Kunden eindeutig finden und dealweit nach dem Angebot suchen. Dateien, deren Name oder Beschreibung ausdrücklich `unterschriebenes Angebot` nennt, haben Vorrang.
2. Auftragsnummer beziehungsweise Angebotsnummer aus dem unterschriebenen Angebot übernehmen. Wird trotz vollständiger Suche kein unterschriebenes Angebot gefunden, darf ersatzweise eine PDF verwendet werden, deren Angebotsnummer eindeutig mit der Nummer im Deal und dem Kunden übereinstimmt. Bei mehreren oder widersprüchlichen Nummern keine Änderung durchführen.
3. Das unterschriebene Angebot visuell auf vollständig durchgestrichene Positionen sowie die Auswahl der Speichervariante prüfen. Bei `Variante A` (zwei Einzelspeicher) und `Variante B` (Kombispeicher) gilt ein sichtbares Häkchen als Auswahl.
4. Über die eindeutige Auftrags-/Angebotsnummer das zugehörige Original-PDF mit `node local-mac-helper/cli.mjs download-pipedrive-files <deal-id> [datei-ids]` über den IVA-Core-API-Hintergrund laden. Dafür niemals Pipedrive oder einen Pipedrive-Tab öffnen, schließen oder auslesen. Original und unterschriebene Fassung müssen zum selben Vorgang gehören. Im erlaubten Ersatzfall ist die eindeutig nummerngleiche PDF selbst der fachliche Beleg; das bloße Fehlen einer sichtbaren Unterschrift blockiert den Fall dann nicht.
5. Die unterschriebene Fassung ist für vollständig gestrichene Positionen und die sichtbare Auswahl zwischen `Variante A` und `Variante B` maßgeblich. Sonstige handschriftliche Randnotizen oder Markierungen sind für die Planbar-Beschreibung irrelevant, solange sie keine vollständige Position streichen und keine Speichervariante ändern. Ist bei keiner Speichervariante ein Häkchen gesetzt, wird aus handschriftlichen Notizen keine Auswahl abgeleitet; anschließend gilt die reguläre Speicher-/TMB-Logik. Nur eine unleserliche oder widersprüchliche Änderung an einer ganzen Position oder an der Speicherwahl blockiert den Fall.
6. Für Vaillant zusätzlich alle eindeutig zum Deal gehörenden Notizen und Dokumentvermerke auf eine spätere Umstellung zwischen `Plus` und `Pro` prüfen. Eine eindeutige, zeitlich spätere Notiz `auf Pro umgestellt` beziehungsweise gleichbedeutend hat Vorrang vor dem älteren Angebotsstand. Quelle und Zeitbezug werden im Laufprotokoll festgehalten. Ohne eindeutigen Umstellungsbeleg gilt die Variante aus dem unterschriebenen Angebot; fehlt auch dort die eindeutige Variante, bleibt genau diese Angabe offen und wird nicht geraten.

## Beschreibung bilden

- Grundsätzlich nur die fett gedruckten Überschriften der tatsächlich beauftragten Positionen übernehmen. Erläuterungen, Unterzeilen und Preise entfallen.
- Optionale Positionen ohne eindeutigen Haken beziehungsweise ohne eindeutige Auswahl auslassen.
- Die Wärmepumpe steht immer zuerst. Für Panasonic, Midea und andere Hersteller genügt grundsätzlich die kompakte Form `Leistung + Hersteller`, zum Beispiel `10 kW Panasonic`.
- Bei Bosch ist die im unterschriebenen Angebot eindeutig belegte Bosch-Nummer beziehungsweise Modellbezeichnung Pflicht und wird unmittelbar ergänzt, zum Beispiel `7 kW Bosch CS6800iAW 7` beziehungsweise exakt in der belegten Schreibweise. Eine bloße Angabe wie `7 kW Bosch` ist unvollständig. Nummern dürfen niemals aus einem anderen Kundenfall oder aus einem bloßen Formatbeispiel übernommen werden.
- Bei Vaillant ist die Variantenbezeichnung Pflicht: immer `Leistung + Vaillant Plus` oder `Leistung + Vaillant Pro`. Maßgeblich ist die unter `Pipedrive- und Dokumentprüfung` festgelegte Quellenreihenfolge einschließlich einer eindeutigen späteren Pro-Umstellungsnotiz. Eine bloße Angabe wie `11 kW Vaillant` ist unvollständig.
- Die danach verbleibenden Positionen folgen in der belegten Angebotsreihenfolge. Dubletten werden nicht künstlich erzeugt.
- Bei mengenabhängigen Zusatzpositionen die belegte Zahl und Einheit direkt hinter der Überschrift ergänzen, zum Beispiel `Extra Verrohrung 3 m`, `Extra Kabel 8 m` oder `Weitere Wanddurchbrüche 2 Stück`. Die Menge muss aus der beauftragten Position stammen; Dezimalnullen dürfen entfallen und `Stk` wird als `Stück` geschrieben. Preise und Rechenerläuterungen bleiben ausgeschlossen.
- Für zusätzliche Heizkreise gilt abweichend: Bei genau einem Heizkreis nur `Zusätzlicher Heizkreis` schreiben. Bei mehreren die Zahl voranstellen und den korrekten Plural verwenden, zum Beispiel `3 zusätzliche Heizkreise`.
- Pauschale Positionen ohne numerische Menge bleiben nur als Überschrift stehen. Fehlt bei einer mengenabhängigen Zusatzposition die eindeutige Zahl oder Einheit, nichts raten und den Fall blockieren.
- Enthält das Angebot nur einen Warmwasserspeicher, zusätzlich `Pufferspeicher` aufnehmen.
- Enthält das Angebot nur einen Pufferspeicher, zusätzlich `Warmwasserspeicher` aufnehmen.
- Sind Warmwasser- und Pufferspeicher bereits enthalten, nichts ergänzen.
- Ist keiner von beiden enthalten und ist keine Variante A/B sichtbar ausgewählt, die TMB prüfen:
  - Die Standhöhe am endgültigen Aufstellort ist das vorrangige Höhenmaß. Bei mindestens **1,80 m Standhöhe** ist ein `Kombispeicher` grundsätzlich möglich; unter 1,80 m werden `zwei Einzelspeicher` ergänzt.
  - Eine niedrigere Türhöhe ist für sich allein kein Ausschlussgrund, weil der Speicher durch die Tür gekippt werden kann. Sie darf deshalb nicht zur Einstufung `zwei Einzelspeicher` führen.
  - Die Breite des vollständigen Transportwegs einschließlich relevanter Türen bleibt zu prüfen. Nur bei eindeutig mehr als **70 cm** an allen Engstellen darf `Kombispeicher` ergänzt werden.
  - Fehlen Standhöhe oder Transportbreite oder sind sie widersprüchlich/mehrdeutig, keine Speicherart raten. Die Speicherangabe bleibt dann offen; der übrige eindeutig belegte Fall wird trotzdem vervollständigt und die fehlende Speicherangabe unter `Manuell prüfen` gemeldet.

## Bestehende Beschreibungen ergänzen statt verlieren

1. Vor jedem Schreiben aus den eindeutigen Quellen eine vollständige `Sollbeschreibung` nach diesem Kapitel bilden und sie gegen den vorhandenen Text vergleichen.
2. Eine vorhandene, aber unvollständige Beschreibung wird nicht pauschal geleert. Bereits vorhandene, nicht widersprüchliche Arbeitsnotizen bleiben erhalten. Der belegte Wärmepumpen- und Positionsblock wird vorn ergänzt oder eine unvollständige belegte Wärmepumpenangabe wird gezielt vervollständigt; erhaltene Notizen folgen danach, getrennt durch ` | `.
3. Eine vollständige Neuerstellung der Beschreibung ist nur zulässig, wenn die vorhandene primäre Anlage nachweislich falsch ist: andere Leistung, anderer Hersteller, falsche Bosch-Modell-/Nummernkennung oder falsche Vaillant-Variante gegenüber der maßgeblichen Dokumentkette. Dann darf der widersprüchliche Text durch die `Sollbeschreibung` ersetzt werden.
4. Enthält der vorhandene Text einen eindeutigen Prüfvermerk wie `geprüft und geändert`, `geprüft/angepasst` oder gleichbedeutend, ist er gegen eine automatische Komplett-Ersetzung geschützt. Nur fehlende, unmittelbar belegte Pflichtangaben dürfen ergänzt werden; einen verbleibenden Widerspruch nicht verdecken oder raten, sondern als fachliche Nachprüfung kennzeichnen.
5. Eine Notiz, die nur Lagerung, Zugang, Material, Telefonat oder andere Feldhinweise beschreibt, ersetzt niemals den Anlagenbeleg. Sie bleibt Zusatzinformation, bis die belegte Wärmepumpe mit `kW` und Hersteller vorangestellt ist.

## Mobile Übersicht freier Planbar-Plätze

1. Bei aktivem Projekt-Schalter wird nach dem einmaligen Planbar-Neuladen zusätzlich eine Kapazitätsaufnahme für die kommenden zwölf Kalenderwochen erstellt.
2. Als freier Montageplatz zählt ausschließlich eine sichtbare Ressource, die in der jeweiligen Zielwoche von Montag bis Freitag vollständig frei ist. Eine auch nur teilweise Belegung sperrt die Ressource für diese Woche; einzelne freie Tage werden nicht addiert. Jede vollständig freie zulässige Ressource zählt genau einmal.
3. Die Ressourcen `Dawid Service` und `Antonio Lausic` sowie erkennbare Schreibvarianten dieser Namen werden vollständig ausgeschlossen. Ihre Termine oder Blöcke dürfen weder eine freie Kapazität erzeugen noch die Wochenzahl beeinflussen.
4. Für jede geprüfte Kalenderwoche wird auch der Wert `0` gespeichert. Der lokale Mac-Mini-Lauf übermittelt Zeitstempel, ISO-Jahr, KW und Anzahl über den freigegebenen Geräte-Endpunkt an die Heat-Hero-Projektakte.
5. IVA zeigt oberhalb von `Kunde terminieren` immer vier Kalenderwochen, deren Summe, die nächste KW mit mindestens einem freien Platz und Pfeile für frühere beziehungsweise spätere Vier-Wochen-Fenster. Quelle, Aktualisierungszeit und beide ausgeschlossenen Ressourcen bleiben sichtbar.
6. Ist Planbar unklar, nicht eingeloggt oder der Kalender nicht vollständig sichtbar, wird kein neuer Kapazitätsstand veröffentlicht; der letzte verifizierte Stand bleibt mit seinem Zeitstempel sichtbar.

## Planbar-Kundenstammdaten vervollständigen

1. Ausschließlich den Kunden bearbeiten, der mit dem eindeutig zugeordneten bestehenden Termin verknüpft ist. Niemals einen neuen Kunden anlegen, Kunden zusammenführen oder einen anderen Datensatz auswählen.
2. Bei Fällen aus der einmaligen Übergabeliste im Feld `Vorname` genau einmal `HH ` voranstellen. Nachname und Kundentyp nicht verändern.
3. Fehlende Anschrift aus dem unterschriebenen Angebot beziehungsweise dem dazugehörigen Original-PDF übernehmen. Straße/Hausnummer, Postleitzahl und Ort müssen zum eindeutigen Pipedrive-Kontakt oder dessen Organisation passen.
4. Fehlende E-Mail-Adresse und Telefonnummer aus dem eindeutigen Pipedrive-Kontakt übernehmen. Pipedrive bleibt dabei strikt lesend. Ein separates Mobilfeld nur befüllen, wenn es vollständig, eindeutig und ausdrücklich als Mobilnummer belegt ist.
5. Bereits gefüllte, widersprüchliche Planbar-Werte nicht automatisch überschreiben. Bei Konflikten zwischen Planbar, Angebot und Pipedrive bleibt der betreffende Stammdatenwert unverändert und kommt in `Manuell prüfen`.
6. Keine unnötigen Kontaktdaten in Bericht oder Laufprotokoll wiedergeben. Dort nur nennen, welche Felder ergänzt, unverändert gelassen oder blockiert wurden.
7. Im Bestandscheck dürfen zusätzlich nur eindeutig belegte Präfix-Korrekturen auf `HH ` vorgenommen werden. Ein vorhandenes korrektes Präfix wird niemals verdoppelt.

## Schreiben und Verifizieren

1. Planbar-Seite vor der Bearbeitung einmal aktualisieren und den eingeloggten Zustand prüfen. Bei Bedarf ist die erneute Anmeldung mit den in Chrome gespeicherten Zugangsdaten freigegeben.
2. Am Termin ausschließlich Auftragsnummer und Beschreibung ändern. Beim eindeutig verknüpften Kunden dürfen zusätzlich nur `Vorname` für ein eindeutig belegtes Präfix `HH ` sowie fehlende Straße/Hausnummer, Postleitzahl, Ort, E-Mail, Telefon und bei eindeutigem Beleg Mobil ergänzt werden. Alle anderen Felder und Termine bleiben unangetastet.
3. Vor dem Speichern Kundenname, sichtbare KW, Auftragsnummer, Beschreibung und alle vorgesehenen Stammdatenänderungen nochmals gegen WhatsApp, Pipedrive, Angebot und gegebenenfalls TMB prüfen.
4. Nach jedem Speichern den Termin beziehungsweise die Kundenansicht erneut öffnen und alle geänderten Zielwerte sichtbar verifizieren. Bei Abweichung den aktuellen Zielzustand erneut lesen, Ursache beheben und ausschließlich die noch fehlende Korrektur am selben Termin ausführen.
5. Ein lokales Laufprotokoll verhindert die erneute Verarbeitung derselben WhatsApp-Nachricht beziehungsweise desselben Kunden-KW-Falls.
6. Vor Abschluss des Laufs alle echten Kundentermine im geprüften Zeitraum ein zweites Mal anhand der Vollständigkeitsdefinition rücklesen. Der Lauf darf nur dann `completed` melden, wenn jeder erfasste private Heat-Hero-Termin fachlich vollständig sichtbar verifiziert ist. Tatsächlich externe offene Punkte ergeben `partial`, niemals `completed`. Ein technischer Browser-, Tab-, Fenster-, Reload-, Verbindungs- oder Steuerungsfehler wird repariert und idempotent fortgesetzt; er ist kein fachlicher Blocker und erscheint nicht als Blocker-Benachrichtigung an Nadine.

## Aktueller Forecast und Ergebnis

Jeder beauftragte Forecast für Angelo folgt `PLANBAR_FORECAST_WORKFLOW.md`: zuerst Planbar frisch laden, den aktuellen Zehn-Wochen-Zeitraum auslesen, Dateien daraus bauen und unmittelbar vor dem Versand erneut vergleichen. Ändert sich die Quelle, Dateien im selben Auftrag neu erstellen. Nie historische Arbeitskopien oder einen alten Versandnachweis als aktuellen Stand verwenden. Im Vervollständigungslauf keinen zusätzlichen Forecast-Versand auslösen.

Ergebnis in IVA mit tatsächlichen Fallzahlen, ausgeführten Änderungen, Rücklesebelegen und noch offenen Punkten speichern. Details aufklappbar; keine täglichen Meldungen allein über gefundene, aber nicht bearbeitete Fälle. Technische Fehler intern mit Ursache, erfolgter Reparatur und verifizierter Vorbeugung dokumentieren. Eine noch ungeprüfte Vermutung ist keine gelernte Regel. Dieser Prüf- und Reparaturlauf versendet keine E-Mail oder Telegram-Nachricht.

## Maschinenlesbarer Abschluss

Der Runner verwendet Protokoll 2. CLI: `node <absoluter-Laufzeitpfad>/codex-tasks.mjs planbar-completion <jobId> <action> [eingangsbeleg.json]`. Eingangsdateien müssen im eigenen Auftragsordner liegen; IDs und Zeitpunkte stammen aus tatsächlich ausgeführten Leseaktionen.

1. `reconcile` und `list` übernehmen offene Reservierungsbelege und zeigen noch offene Fälle.
2. `begin` erhält `{scope:"heat-hero-private",refreshedAt,sourceChecks:[{source:"planbar",status:"read",observedCount,checkedAt,evidence}]}`. Zusätzliche Quellen separat als `read`, `not_required` oder `unavailable` mit konkretem Grund und `external:true` nur bei tatsächlich externer Hürde angeben.
3. `observe` erhält `{scopeEvidence:{partnerId:"heat-hero",customerSegment:"private",identityVerified:true,dealId,checkedAt,evidence},identity:{customerId,appointmentId,resourceId,resourceName,isoYear,week,startDate,endDateExclusive},missingDetails,remainingActions,preservedNotes,customerName}`. Die Kalenderwoche ist maßgeblich. `startDate`/`endDateExclusive` bezeichnen Montag/Samstag dieser sichtbaren Woche; abweichende interne Details nicht verschieben.
4. `proof` erhält `{caseId,expected,actual,readback,sourceEvidence,missingDetails,externalBlockers,preservedNotes}`. `expected` und `actual`: `{orderNumber,description,manufacturer,powerKw,model,variant}`. `readback` enthält dieselbe Terminidentität plus `{source:"planbar",partnerId:"heat-hero",customerSegment:"private",identityVerified:true,firstName,checkedAt,evidence}`. Für jedes Sollfeld einen konkreten `sourceEvidence`-Eintrag `{field,sourceId,sourceKind,evidence,verified:true,checkedAt}` speichern. Auftragsnummer aus `signed-offer`; nummerngleiche Original-PDF nur nach vollständig erfolgloser Unterschriftensuche und `{sourceKind:"original-offer",matchedDealId,matchedOfferNumber,identityVerified:true,signedOfferSearchComplete:true,signedOfferFound:false}`.
5. Vor Ende Planbar nochmals frisch öffnen, `finalReadbackStartedAt` speichern und alle erledigten Fälle in dieser letzten Runde mit `proof` rücklesen. Erst danach `finish` mit `{checkedCaseIds,inventoryComplete:true,finalReadbackStartedAt,finalReadbackAt}`. Der Helfer berechnet Vollständigkeit, Lücken und Wiederholbedarf selbst. Eine neue Endzeit ersetzt keine zweite Rückprüfung.
