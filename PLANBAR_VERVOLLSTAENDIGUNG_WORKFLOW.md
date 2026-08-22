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
- Wärmepumpenangaben aus der Übergabeliste dienen ausschließlich als Such- und Plausibilitätshinweis. Auftragsnummer, beauftragte Positionen und Beschreibung werden weiterhin nur aus unterschriebenem Angebot, Original-PDF und gegebenenfalls TMB belegt.
- Bei jedem Kunden aus dieser Übergabeliste muss im Planbar-Feld `Vorname` genau einmal das Präfix `HH ` vor dem eigentlichen Vornamen stehen, zum Beispiel `HH Hartmut`. Ein bereits vorhandenes `HH ` wird nicht verdoppelt.
- Jeder Fall erhält nach der Bearbeitung einen eindeutigen Status und Zeitstempel. Abgeschlossene oder blockierte Einträge werden nicht erneut geschrieben. Wenn alle Einträge beendet sind, wird die Warteschlange auf `completed` gesetzt.
- Nach Abschluss der Übergabeliste gilt wieder ausschließlich die tägliche WhatsApp-Quelle `Terminierungen Dispo`.

## Pipedrive- und Dokumentprüfung

1. Pipedrive wird nur lesend verwendet. Den Kunden eindeutig finden und das unterschriebene Angebot öffnen.
2. Auftragsnummer beziehungsweise Angebotsnummer aus dem unterschriebenen Angebot übernehmen. Bei mehreren oder widersprüchlichen Nummern keine Änderung durchführen.
3. Das unterschriebene Angebot visuell auf vollständig durchgestrichene Positionen sowie die Auswahl der Speichervariante prüfen. Bei `Variante A` (zwei Einzelspeicher) und `Variante B` (Kombispeicher) gilt ein sichtbares Häkchen als Auswahl.
4. Über die eindeutige Auftrags-/Angebotsnummer das zugehörige Original-PDF in Pipedrive öffnen. Original und unterschriebene Fassung müssen zum selben Vorgang gehören.
5. Die unterschriebene Fassung ist für vollständig gestrichene Positionen und die sichtbare Auswahl zwischen `Variante A` und `Variante B` maßgeblich. Sonstige handschriftliche Randnotizen oder Markierungen sind für die Planbar-Beschreibung irrelevant, solange sie keine vollständige Position streichen und keine Speichervariante ändern. Ist bei keiner Speichervariante ein Häkchen gesetzt, wird aus handschriftlichen Notizen keine Auswahl abgeleitet; anschließend gilt die reguläre Speicher-/TMB-Logik. Nur eine unleserliche oder widersprüchliche Änderung an einer ganzen Position oder an der Speicherwahl blockiert den Fall.

## Beschreibung bilden

- Nur die fett gedruckten Überschriften der tatsächlich beauftragten Positionen übernehmen. Erläuterungen, Unterzeilen, Mengen-/Preistext und sonstige Details unterhalb der Überschrift entfallen.
- Optionale Positionen ohne eindeutigen Haken beziehungsweise ohne eindeutige Auswahl auslassen.
- Die Wärmepumpe steht immer zuerst. Dafür genügt die kompakte Form `Leistung + Hersteller`, zum Beispiel `10 kW Panasonic` oder `15 kW Vaillant`; die genaue Modellbezeichnung wird weggelassen.
- Die danach verbleibenden Positionen folgen in der belegten Angebotsreihenfolge. Dubletten werden nicht künstlich erzeugt.
- Enthält das Angebot nur einen Warmwasserspeicher, zusätzlich `Pufferspeicher` aufnehmen.
- Enthält das Angebot nur einen Pufferspeicher, zusätzlich `Warmwasserspeicher` aufnehmen.
- Sind Warmwasser- und Pufferspeicher bereits enthalten, nichts ergänzen.
- Ist keiner von beiden enthalten, die TMB für den vollständigen Keller-/Transportweg einschließlich aller relevanten Türen prüfen:
  - Nur wenn sämtliche benötigten Maße eindeutig **größer als 1,80 m Höhe und größer als 70 cm Breite** sind, `Kombispeicher` ergänzen.
  - Ist mindestens ein belegtes Maß nicht größer als eine der Grenzen, `zwei Einzelspeicher` ergänzen.
  - Fehlen Maße oder sind sie widersprüchlich/mehrdeutig, keine Speicherart raten und den Fall ohne Planbar-Änderung als Blocker melden.

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
