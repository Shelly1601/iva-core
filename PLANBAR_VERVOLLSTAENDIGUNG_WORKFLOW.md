# Planbar Vervollständigung – verbindlicher Morgenworkflow

## Zeitplan und Umfang

- Name: `Planbar Vervollständigung`
- Ausführung: täglich um 08:00 Uhr, Zeitzone `Europe/Berlin`, lokal auf Nadines iMac.
- Quelle: ausschließlich Nadines eigene Nachrichten vom vorherigen Kalendertag in der WhatsApp-Gruppe `Terminierungen Dispo` innerhalb der Community `Heat Hero GmbH`.
- Ziel: den bereits von Nadine angelegten Planbar-Termin anhand von Kundenname und Kalenderwoche finden, **Auftragsnummer** und **Beschreibung** vervollständigen und beim eindeutig verknüpften Planbar-Kunden fehlende Stammdaten ergänzen.
- Laufzeitlimit: maximal 20 Minuten. Während des Laufs bleibt das Display stabil an; danach wird es genau einmal ausgeschaltet. Keine Wiederholungs- oder Aufweckschleife außerhalb des nächsten regulären Laufs.

## Sichere Fallzuordnung

1. WhatsApp öffnen, die exakte Community und Gruppe `Terminierungen Dispo` prüfen und nur Nachrichten berücksichtigen, die nach sichtbarem Absender von Nadine stammen und gestern gesendet wurden.
2. Aus jeder relevanten Nachricht Kundenname und Kalenderwoche lesen. Mehrere identische Hinweise zu demselben Kunden und derselben KW bilden einen Fall. Widersprüchliche KW-Angaben werden nicht geraten.
3. In Planbar genau einen bestehenden Termin mit diesem Kunden in dieser sichtbaren Kalenderwoche verlangen. Der sichtbare Kalender ist für die KW allein maßgeblich. Eine abweichende interne Datums- oder Zeitraumangabe im Termindetail ist kein Blocker und wird nicht verändert.
4. Niemals einen Termin neu anlegen, löschen, verschieben oder einer anderen Ressource zuordnen. Bei keinem oder mehreren Treffern bleibt Planbar unverändert und der Fall kommt als Blocker in den Bericht.

## Lesender Formatvergleich mit Nadines Einträgen

1. Vor der ersten Änderung einige bestehende Planbar-Termine prüfen, bei denen vor dem Vornamen sichtbar `HH` steht. Diese Einträge stammen von Nadine und dienen ausschließlich als Formatbeispiele.
2. Nur wiederkehrende Darstellungsmerkmale ableiten: Aufbau und Reihenfolge der Beschreibung, Schreibweise der Wärmepumpe, Trennzeichen, Groß-/Kleinschreibung und Ablage der Auftragsnummer.
3. Die `HH`-Einträge niemals verändern und keine Kundenangaben daraus in einen anderen Fall kopieren. Sie ersetzen weder Angebot noch TMB und sind kein Beleg für den aktuellen Kundenfall.
4. Bei unterschiedlichen Beispielen oder einem Widerspruch zur verbindlichen Fachlogik gilt dieser Workflow. Die Abweichung wird im Ergebnisbericht genannt, statt ein Muster zu erraten.

## Einmalige, von Nadine bestätigte Übergabeliste

- Liegt `data/planbar-completion-pending.json` mit `status: "pending"` vor, wird diese Liste vor den regulären WhatsApp-Nachrichten verarbeitet.
- Sie ist eine ausdrückliche einmalige Nutzerfreigabe und ersetzt nur für die darin enthaltenen Kunden-/KW-Fälle die Prüfung „vorheriger Kalendertag“. Die Bilddateien und die strukturierte Warteschlange bilden gemeinsam den Eingangsbeleg.
- Wärmepumpenangaben aus der Übergabeliste dienen grundsätzlich als Such- und Plausibilitätshinweis. Ausnahmen nur für diese 25 neu gelegten Termine: Jede Vaillant-Anlage wird mit dem sichtbaren Zusatz `Pro` geschrieben, zum Beispiel `7 kW Vaillant Pro`. Steht im unterschriebenen Angebot wegen des ursprünglichen Angebotsstands `10 kW Vaillant` oder `12 kW Vaillant Plus`, während Nadines bestätigte Übergabeliste `11 kW Vaillant Pro` nennt, ist dies zusätzlich die operative Austauschinformation wegen Nichtlieferbarkeit. Dann wird in Planbar `11 kW Vaillant Pro` verwendet. Diese Ausnahmen gelten weder für sonstige Bestandsfälle noch für spätere reguläre WhatsApp-Läufe.
- Bei jedem Kunden aus dieser Übergabeliste muss im Planbar-Feld `Vorname` genau einmal das Präfix `HH ` vor dem eigentlichen Vornamen stehen, zum Beispiel `HH Hartmut`. Ein bereits vorhandenes `HH ` wird nicht verdoppelt.
- Jeder Fall erhält nach der Bearbeitung einen eindeutigen Status und Zeitstempel. Abgeschlossene oder blockierte Einträge werden nicht erneut geschrieben. Wenn alle Einträge beendet sind, wird die Warteschlange auf `completed` gesetzt.
- Nach Abschluss der Übergabeliste gilt wieder ausschließlich die tägliche WhatsApp-Quelle `Terminierungen Dispo`.

## Pipedrive- und Dokumentprüfung

1. Pipedrive wird nur lesend verwendet. Den Kunden eindeutig finden und dealweit nach dem Angebot suchen. Dateien, deren Name oder Beschreibung ausdrücklich `unterschriebenes Angebot` nennt, haben Vorrang.
2. Auftragsnummer beziehungsweise Angebotsnummer aus dem unterschriebenen Angebot übernehmen. Wird trotz vollständiger Suche kein unterschriebenes Angebot gefunden, darf ersatzweise eine PDF verwendet werden, deren Angebotsnummer eindeutig mit der Nummer im Deal und dem Kunden übereinstimmt. Bei mehreren oder widersprüchlichen Nummern keine Änderung durchführen.
3. Das unterschriebene Angebot visuell auf vollständig durchgestrichene Positionen sowie die Auswahl der Speichervariante prüfen. Bei `Variante A` (zwei Einzelspeicher) und `Variante B` (Kombispeicher) gilt ein sichtbares Häkchen als Auswahl.
4. Über die eindeutige Auftrags-/Angebotsnummer das zugehörige Original-PDF in Pipedrive öffnen. Original und unterschriebene Fassung müssen zum selben Vorgang gehören. Im erlaubten Ersatzfall ist die eindeutig nummerngleiche PDF selbst der fachliche Beleg; das bloße Fehlen einer sichtbaren Unterschrift blockiert den Fall dann nicht.
5. Die unterschriebene Fassung ist für vollständig gestrichene Positionen und die sichtbare Auswahl zwischen `Variante A` und `Variante B` maßgeblich. Sonstige handschriftliche Randnotizen oder Markierungen sind für die Planbar-Beschreibung irrelevant, solange sie keine vollständige Position streichen und keine Speichervariante ändern. Ist bei keiner Speichervariante ein Häkchen gesetzt, wird aus handschriftlichen Notizen keine Auswahl abgeleitet; anschließend gilt die reguläre Speicher-/TMB-Logik. Nur eine unleserliche oder widersprüchliche Änderung an einer ganzen Position oder an der Speicherwahl blockiert den Fall.

## Beschreibung bilden

- Grundsätzlich nur die fett gedruckten Überschriften der tatsächlich beauftragten Positionen übernehmen. Erläuterungen, Unterzeilen und Preise entfallen.
- Optionale Positionen ohne eindeutigen Haken beziehungsweise ohne eindeutige Auswahl auslassen.
- Die Wärmepumpe steht immer zuerst. Dafür genügt die kompakte Form `Leistung + Hersteller`, zum Beispiel `10 kW Panasonic` oder `15 kW Vaillant`; die genaue Modellbezeichnung wird weggelassen.
- Abweichend davon wird bei den 25 Fällen der einmaligen Übergabeliste jede Vaillant-Anlage ausdrücklich als `Leistung + Vaillant Pro` geschrieben, damit keine Verwechslung mit einer Plus-Anlage entsteht.
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

## Mobile Übersicht freier Planbar-Plätze

1. Bei aktivem Projekt-Schalter wird nach dem einmaligen Planbar-Neuladen zusätzlich eine Kapazitätsaufnahme für die kommenden zwölf Kalenderwochen erstellt.
2. Als freier Montageplatz zählt ausschließlich ein im sichtbaren Kalender vorhandener Block mit dem exakten Text `Geblockt für Kunde ENTER`. Leere Zellen, Urlaub, Service-Termine oder sonstige Annahmen zählen nicht.
3. Die Ressourcen `Dawid Service` und `Antonio Lausic` sowie erkennbare Schreibvarianten dieser Namen werden vollständig ausgeschlossen. Ihre Termine oder Blöcke dürfen weder eine freie Kapazität erzeugen noch die Wochenzahl beeinflussen.
4. Für jede geprüfte Kalenderwoche wird auch der Wert `0` gespeichert. Der lokale iMac-Lauf übermittelt Zeitstempel, ISO-Jahr, KW und Anzahl über den freigegebenen Geräte-Endpunkt an die Heat-Hero-Projektakte.
5. IVA zeigt oberhalb von `Kunde terminieren` immer vier Kalenderwochen, deren Summe, die nächste KW mit mindestens einem freien Platz und Pfeile für frühere beziehungsweise spätere Vier-Wochen-Fenster. Quelle, Aktualisierungszeit und beide ausgeschlossenen Ressourcen bleiben sichtbar.
6. Ist Planbar unklar, nicht eingeloggt oder der Kalender nicht vollständig sichtbar, wird kein neuer Kapazitätsstand veröffentlicht; der letzte verifizierte Stand bleibt mit seinem Zeitstempel sichtbar.

## Planbar-Kundenstammdaten vervollständigen

1. Ausschließlich den Kunden bearbeiten, der mit dem eindeutig zugeordneten bestehenden Termin verknüpft ist. Niemals einen neuen Kunden anlegen, Kunden zusammenführen oder einen anderen Datensatz auswählen.
2. Bei Fällen aus der einmaligen Übergabeliste im Feld `Vorname` genau einmal `HH ` voranstellen. Nachname und Kundentyp nicht verändern.
3. Fehlende Anschrift aus dem unterschriebenen Angebot beziehungsweise dem dazugehörigen Original-PDF übernehmen. Straße/Hausnummer, Postleitzahl und Ort müssen zum eindeutigen Pipedrive-Kontakt oder dessen Organisation passen.
4. Fehlende E-Mail-Adresse und Telefonnummer aus dem eindeutigen Pipedrive-Kontakt übernehmen. Pipedrive bleibt dabei strikt lesend. Ein separates Mobilfeld nur befüllen, wenn es vollständig, eindeutig und ausdrücklich als Mobilnummer belegt ist.
5. Bereits gefüllte, widersprüchliche Planbar-Werte nicht automatisch überschreiben. Bei Konflikten zwischen Planbar, Angebot und Pipedrive bleibt der betreffende Stammdatenwert unverändert und kommt in `Manuell prüfen`.
6. Keine unnötigen Kontaktdaten in Bericht oder Laufprotokoll wiedergeben. Dort nur nennen, welche Felder ergänzt, unverändert gelassen oder blockiert wurden.

## Schreiben und Verifizieren

1. Planbar-Seite vor der Bearbeitung einmal aktualisieren und den eingeloggten Zustand prüfen. Bei Bedarf ist die erneute Anmeldung mit den in Chrome gespeicherten Zugangsdaten freigegeben.
2. Am Termin ausschließlich Auftragsnummer und Beschreibung ändern. Beim eindeutig verknüpften Kunden dürfen zusätzlich nur `Vorname` für das Präfix `HH ` sowie fehlende Straße/Hausnummer, Postleitzahl, Ort, E-Mail, Telefon und bei eindeutigem Beleg Mobil ergänzt werden. Alle anderen Felder und Termine bleiben unangetastet.
3. Vor dem Speichern Kundenname, sichtbare KW, Auftragsnummer, Beschreibung und alle vorgesehenen Stammdatenänderungen nochmals gegen WhatsApp, Pipedrive, Angebot und gegebenenfalls TMB prüfen.
4. Nach jedem Speichern den Termin beziehungsweise die Kundenansicht erneut öffnen und alle geänderten Zielwerte sichtbar verifizieren. Bei Abweichung keine weiteren Schreibversuche; Fehler dokumentieren.
5. Ein lokales Laufprotokoll verhindert die erneute Verarbeitung derselben WhatsApp-Nachricht beziehungsweise desselben Kunden-KW-Falls.

## Einmaliger Abschluss-Forecast für Angelos Excel-Listen

- Die Warteschlange `data/planbar-completion-pending.json` enthält eine einmalige Abschlussaktion. Sie wird erst freigegeben, wenn **alle 25 Kundenfälle den Status `completed`** haben. Ein blockierter, übersprungener oder noch offener Fall zählt nicht als Abschluss.
- Nach Freigabe genau einmal außerplanmäßig den verbindlichen Workflow `PLANBAR_FORECAST_WORKFLOW.md` ausführen. Für diese Abschlussaktion ist der Zeitraum fest auf **KW 36 bis einschließlich KW 45 des Jahres 2026** gesetzt, unabhängig vom späteren tatsächlichen Ausführungsdatum.
- Empfänger ist ausschließlich Angelo Keller unter `a.keller@heat-hero.com`. Es werden ausschließlich die dort vorgeschriebenen Excel-Dateien versendet; keine PDFs und keine zusätzlichen Empfänger.
- Die reguläre Freitagsautomation bleibt bestehen. Vor dem außerplanmäßigen Versand sowohl den lokalen Forecast-Sendelaufstatus als auch Outlook `Gesendet` auf denselben Empfänger, Betreff und KW-Bereich prüfen. Ein bereits verifizierter Versand wird nicht wiederholt.
- Die Abschlussaktion wechselt erst nach sichtbarer Prüfung in Outlook `Gesendet` auf `sent-and-verified`. Bei einem technischen oder fachlichen Blocker bleibt sie ungesendet und wird mit konkretem Grund protokolliert; es gibt pro Lauf höchstens einen logischen Versandversuch.
- Nach bestätigtem Versand das Ergebnis zusätzlich mit `workflowId: planbar-weekly-export` an die Heat-Hero-Projektakte melden und im Detailbericht des Vervollständigungslaufs aufführen.

## Detaillierter Ergebnisbericht: E-Mail mit Telegram-Ersatz

Nach jedem Lauf einen detaillierten, nachvollziehbaren Bericht an `n.sell@heat-hero.com` senden – auch bei keinen relevanten Nachrichten, ausgeschaltetem Projekt-Schalter, Blockern oder technischen Fehlern.

Der Bericht enthält:

- Laufdatum, Start-/Endzeit, betrachteten WhatsApp-Tag und Gesamtstatus;
- die nur lesend erkannten Formatmuster der geprüften `HH`-Beispiele, ohne unnötige Kundendaten;
- pro Fall Kundenname und KW, verwendete Quellen, eindeutigen Planbar-Treffer, geprüfte Dokumentarten, vorherige und neue Terminwerte, geänderte Kundenstammdatenfelder ohne deren vollständige sensible Inhalte sowie die tatsächlich ausgeführten Klicks/Änderungen;
- die sichtbare Kontrolle nach dem Speichern und jede Abweichung zwischen Soll und Ist;
- konkrete Gründe für übersprungene oder blockierte Fälle;
- Summen für gefunden, geändert, unverändert, übersprungen und blockiert;
- bei keinen relevanten Nachrichten ausdrücklich `Keine relevanten Nachrichten von gestern`;
- einen Abschnitt `Manuell prüfen` mit allen Unsicherheiten oder auffälligen Ergebnissen.

E-Mail-Regeln:

1. Betreff: `IVA Planbar-Vervollständigung – <Datum> – geändert <Anzahl> / blockiert <Anzahl>`.
2. Der E-Mail-Versand gilt erst als erfolgreich, wenn Empfänger, Betreff, Zeitpunkt und vollständiger Bericht im Gesendet-Ordner sichtbar geprüft wurden.
3. Ist Versand oder Sichtprüfung nicht eindeutig erfolgreich, genau einen Telegram-Ersatzbericht an Nadine senden. Er enthält den vollständigen Bericht und zusätzlich den konkreten E-Mail-Fehler. Bei Längenbegrenzung darf dieser eine logische Bericht nummeriert auf mehrere Telegram-Nachrichten verteilt werden.
4. Bei bestätigter E-Mail-Zustellung keinen zusätzlichen Telegram-Doppelbericht senden.

Keine Passwörter, OTPs, vollständigen Kontaktdaten, vollständigen Dokumentinhalte oder unnötige sensible Daten in E-Mail, Telegram oder Laufprotokoll wiedergeben.
