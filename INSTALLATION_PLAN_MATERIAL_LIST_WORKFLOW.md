# Installationsplan als deutsche Materialliste

## Zweck

Dieser manuell startbare Heat-Hero-Workflow sucht in Outlook eine konkrete Installationsmail, öffnet den darin verlinkten Installationsplan ausschließlich lesend und erzeugt daraus eine deutschsprachige PDF für Nadine.

## Auftragseingang

Für jeden Lauf müssen mindestens Absender oder Betreff sowie das Empfängerpostfach erkennbar sein. Standardmäßig wird nach einer Mail von Daan Köster an `n.sell@heat-hero.com` gesucht. Bei mehreren Treffern ist anhand von Betreff, Kundenname, Auftragsnummer und Datum eindeutig abzugleichen. Bleibt die Zuordnung mehrdeutig, wird nichts geöffnet oder versendet und der Lauf endet mit einem konkreten Prüffall.

## Verbindlicher Nur-Lese-Schutz

- Die Mail und das verlinkte Quelldokument werden ausschließlich gelesen.
- Im Quelldokument niemals Text, Kommentare, Freigaben, Dateinamen, Ablageort oder Berechtigungen ändern.
- Niemals Seiten, Anhänge, Mails oder Quelldateien löschen oder verschieben.
- Eine lokale Arbeitskopie darf nur über eine vorhandene Download- oder Exportfunktion erzeugt werden. Der Originalinhalt bleibt unverändert.
- Der Workflow sendet nichts an Daan, Kunden oder andere Dritte. Das Ergebnis wird ausschließlich Nadine als PDF bereitgestellt.

## Ausführung auf dem iMac

1. Vor jeder sichtbaren Aktion den zweiten, physisch rechten Bildschirm mit `node local-mac-helper/right-display-check.mjs --require-second-display` prüfen. Outlook und das eigene Chrome-Fenster müssen nachweislich rechts liegen.
2. In Outlook die eindeutige Mail öffnen und Absender, Empfänger, Betreff, Datum, Kunde, Auftragsnummer und Installationszeitraum erfassen.
3. Den Link in einem eigenen Chrome-Tab auf dem rechten Display öffnen. Nur lesend navigieren; keine Bearbeitungsaktionen auslösen.
4. Den Plan als lokale PDF-Arbeitskopie exportieren oder herunterladen. PDF-Integrität, Seitenzahl und lesbaren Text prüfen.
5. Seite 1 der Quell-PDF unverändert als erste Seite der Ergebnis-PDF übernehmen.
6. Aus Mail und Plan eine einfache deutsche Materialliste erstellen. Jede Position enthält Menge, Material/Bauteil, kurze Spezifikation und Belegstelle. Fehlende Mengen werden nicht erfunden, sondern mit „nach Weg“, „vor Ort prüfen“ oder einem offenen Punkt kenntlich gemacht.
7. Widersprüche oder nicht belastbar bezifferte Angaben separat unter „Vor finaler Bestellung klären“ aufführen.
8. Ergebnis als A4-PDF unter `output/pdf/Materialliste_Installation_<Auftragsnummer>_<Kunde>.pdf` speichern. Alle Seiten rendern und visuell auf abgeschnittenen Text, Überlagerungen, fehlerhafte Zeichen und unschöne Seitenumbrüche prüfen.
9. Die fertige PDF in der Abschlussnachricht als Datei an Nadine ausliefern. Dabei kurz bestätigen, dass das Quelldokument ausschließlich gelesen und nicht verändert oder gelöscht wurde.

## Qualitätskriterien

- Seite 1 stimmt sichtbar mit Seite 1 des bereitgestellten Originalplans überein.
- Die Materialliste ist deutsch, einfach, belegbasiert und enthält keine erfundenen Stückzahlen.
- Mailangaben und Planangaben werden gemeinsam berücksichtigt.
- Widersprüche bleiben sichtbar statt still aufgelöst zu werden.
- Die Ergebnis-PDF ist vollständig lesbar und visuell geprüft.
- Es gab keine Änderung, Löschung, Verschiebung oder externe Kommunikation an der Quelle.
