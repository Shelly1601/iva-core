# Planbar ENTER aus Airtable - separater Workflow

Stand: 29. August 2026 - Version 2

## Strikte Trennung vom bestehenden Morgenworkflow

- Dieser Workflow ist eigenständig. `PLANBAR_VERVOLLSTAENDIGUNG_WORKFLOW.md` und die Automation `Planbar-Vervollständigung täglich um 8 Uhr` bleiben in Ablauf, Quelle, Zeitplan, Status und Regeln unverändert.
- Aus dem bestehenden Workflow werden nur die ausdrücklich passenden Bausteine übernommen: Angebotsauswertung, Kurzbeschreibung, Kundenstammdaten-Format und sichtbare Rückprüfung.
- WhatsApp, die HH-Übergabeliste, TMB, Forecast und Kapazitätsmeldung sind keine Quellen oder Nebenaufgaben dieses ENTER-Workflows.
- Pipedrive ist in diesem Workflow keine allgemeine Nebenquelle, sondern nur der eng begrenzte Ersatzweg aus Abschnitt `Korrigiertes Angebot mit Pipedrive-Fallback`, wenn für einen ENTER-Fall in Airtable kein belastbares Angebot vorliegt.

## Quelle und fester Airtable-Umfang

- Airtable-Link: `https://airtable.com/appBsUeEsjEBzIMDc/pagyBs7hOhHp6u3gh`
- Base: `appBsUeEsjEBzIMDc`
- Interface: `pbdt3FMtYOHgD4m0G`
- Seite: `pagyBs7hOhHp6u3gh` (`Überblick`)
- Tabelle: `tblGcYRzV0X9i6dqc`
- Es werden ausschließlich Datensätze mit Stage `Installation Queue` (`selAsWptav4Fc64UN`) gelesen.
- Relevante Felder sind Kunde, Projektanschrift, Installationsdatum (geplant), Angebot korrigiert, ID (HERO), Mobiltelefon, Festnetz, Emailadresse und Verkauftes Produkt.
- Airtable bleibt rein lesend. Der Workflow ändert weder Stage noch Felder oder Anhänge.

## Einmaliger Start und spätere Idempotenz

1. Beim ersten Lauf werden alle derzeit in `Installation Queue` sichtbaren Datensätze mit `Installationsdatum (geplant)` ab Montag, 7. September 2026 (KW 37), geprüft.
2. Alle beim Start in der Stage vorhandenen Airtable-Record-IDs werden als Baseline gespeichert, auch wenn ihr Datum vor KW 37 liegt, fehlt oder der Fall übersprungen wird.
3. Solange der einmalige Start noch nicht abgeschlossen ist, werden dessen als `pending_initial_planbar_write` markierte Fälle weitergeführt; ein technischer Folgelauf macht sie nicht zu Altbestand.
4. Erst nach `initialRun.completed = true` gilt ausschließlich: Ein Fall ist neu, wenn seine Airtable-Record-ID noch nicht im lokalen Statusspeicher steht und er jetzt in `Installation Queue` erscheint.
5. Bereits abschließend behandelte oder übersprungene Record-IDs werden nicht erneut bearbeitet. Änderungen an alten Airtable-Datensätzen lösen keinen neuen Planbar-Lauf aus.
6. Neue Datensätze ohne geplantes Installationsdatum oder mit einem geplanten Datum vor dem lokalen Tagesdatum werden protokolliert, als gesehen markiert und nicht in Planbar bearbeitet.
7. Statusdatei: `data/planbar-enter-airtable-state.json`. Sie enthält nur IDs, technische Fingerprints, Status, Zeitstempel und kurze sekretfreie Gründe; keine vollständigen Kontakt- oder Angebotsinhalte.

## Dublettenschutz und vorhandene Termine in Planbar

1. Planbar vor dem Lauf genau einmal neu laden und den sichtbaren angemeldeten Zustand prüfen.
2. Vor jeder fachlichen Angebotsauswertung über den relevanten Planbar-Zeitraum nach einer bereits vorhandenen tatsächlichen Baustelle suchen.
3. Eine Baustelle gilt nur bei eindeutiger Übereinstimmung von Kundenname und Projektanschrift als vorhanden. Namensreihenfolge und Leerzeichen dürfen normalisiert werden; bloße Teiltreffer genügen nicht.
4. Existiert in der Ziel-KW bereits genau ein vorhandener echter Kundentermin mit eindeutiger Übereinstimmung von Kundenname und Projektanschrift, wird kein neuer Termin angelegt und kein ENTER-Blocker ersetzt. Dieser vorhandene Termin darf nur nach den unten freigegebenen Regeln vervollständigt werden.
5. Standardaufgaben, Urlaub, `nicht verfügbar` und alle Blockertexte zählen nicht als vorhandene Baustelle.

## Korrigiertes Angebot mit Pipedrive-Fallback

1. Primäre fachliche Quelle bleibt der Anhang im Airtable-Feld `Angebot korrigiert`.
2. Ist dort genau ein eindeutiges, lesbares und zum Airtable-Fall passendes korrigiertes Angebot vorhanden, belegt ausschließlich dieses Dokument Auftragsnummer und Planbar-Beschreibung.
3. Fehlt `Angebot korrigiert`, ist das Dokument unleserlich oder reicht es fachlich nicht für eine eindeutige Zuordnung, darf einmalig und nur für denselben Airtable-Fall Pipedrive rein lesend als Ersatzweg geprüft werden.
4. Im erlaubten Ersatzweg den Kunden in Pipedrive eindeutig finden, dealweit nach dem unterschriebenen Angebot suchen und die Regeln aus `PLANBAR_VERVOLLSTAENDIGUNG_WORKFLOW.md` für Auftragsnummer, Original-PDF, visuelle Streichungen und optionale Auswahl inhaltlich gleich anwenden.
5. Wird trotz vollständiger Suche kein unterschriebenes Angebot gefunden, darf ersatzweise nur eine PDF verwendet werden, deren Angebotsnummer eindeutig mit der Nummer im Deal und dem Kunden übereinstimmt. Bei mehreren oder widersprüchlichen Nummern bleibt der Fall unverändert.
6. Das Airtable-Feld `Angebot`, freie Deal-Felder, bloße Dateinamen ohne geöffnete Dokumentprüfung, TMB oder andere Quellen dürfen Auftragsnummer und Beschreibung weiterhin nicht ersatzweise belegen.
7. Bei mehreren Airtable-Anhängen ist nur eine eindeutig spätere korrigierte Version zulässig, zum Beispiel durch `NEU` plus höhere sichtbare Angebotsversion und widerspruchsfreien Inhalt. Ist die Reihenfolge nicht eindeutig, bleibt der Fall unverändert.
8. Das verwendete PDF wird inhaltlich und visuell geprüft. Kundenname beziehungsweise Projektanschrift sowie Auftrags-/Angebotsnummer müssen eindeutig zum Airtable-Fall passen.

## Beschreibung wie bei Planbar-Vervollständigung

- Nur die fett gedruckten Überschriften tatsächlich beauftragter Positionen übernehmen; Erläuterungen, Unterzeilen und Preise entfallen.
- Die Wärmepumpe steht zuerst als `Leistung + Hersteller`; die Modellbezeichnung entfällt.
- Danach folgen die belegten Positionen in Angebotsreihenfolge.
- Mengenabhängige Zusatzpositionen erhalten belegte Zahl und Einheit. `Stk` wird zu `Stück`, überflüssige Dezimalnullen entfallen.
- Für genau einen zusätzlichen Heizkreis gilt `Zusätzlicher Heizkreis`, für mehrere zum Beispiel `3 zusätzliche Heizkreise`.
- Optionale, vollständig gestrichene oder nicht eindeutig ausgewählte Positionen werden ausgelassen.
- Speicher werden ausschließlich nach dem verwendeten fachlichen Beleg aus dem vorherigen Abschnitt behandelt: nur Warmwasserspeicher bedeutet zusätzlich `Pufferspeicher`; nur Pufferspeicher bedeutet zusätzlich `Warmwasserspeicher`; beide vorhanden bedeutet keine Ergänzung. Fehlen beide und ist keine Variante eindeutig ausgewählt, wird keine Speicherart geraten und keine andere Quelle geöffnet.
- Eine fehlende eindeutige Auftragsnummer oder eine unleserliche/widersprüchliche beauftragte Position blockiert den Schreibschritt.

## ENTER-Kunde in Planbar

1. Zuerst nach einem vorhandenen Planbar-Kunden über Name, Anschrift und - soweit vorhanden - Kontaktfelder suchen. Eindeutige Dubletten werden verwendet, nicht neu angelegt.
2. Beim neu anzulegenden oder für diesen Termin eindeutig verwendeten bestehenden Kunden steht im Vornamen genau einmal `EN ` vor dem eigentlichen Vornamen. `HH ` ist in diesem Workflow niemals das Zielpräfix.
3. Nachname, Projektanschrift, E-Mail und Telefon/Mobil stammen aus dem aktuellen Airtable-Datensatz. Fehlende oder widersprüchliche Pflichtdaten werden nicht geraten.
4. Fehlt beim eindeutig verwendeten bestehenden Kundendatensatz das Präfix `EN ` oder trägt er stattdessen `HH ` oder `DW `, darf nur dieses Präfix auf genau einmal `EN ` korrigiert werden. Andere Kundendaten bleiben unverändert, soweit nicht Abschnitt `Schreiben, Rückprüfung und Bericht` ausdrücklich etwas anderes erlaubt.
5. Bereits vorhandene fremde Kundenwerte werden nicht still überschrieben. Ein Konflikt blockiert nur das betreffende Feld beziehungsweise bei unsicherer Identität den gesamten Fall.

## ENTER-Blocker ersetzen

1. Zulässig ist ausschließlich eine sichtbare Standardaufgabe mit dem exakten Text `Geblockt für Kunde ENTER` in der ISO-Kalenderwoche des geplanten Airtable-Datums.
2. Andere Blocker, Urlaub, Service, `nicht verfügbar` und fremde Partnerblocker bleiben unangetastet.
3. Ein ENTER-Blocker wird übersprungen, wenn sich auf derselben Ressource in seinem Zeitraum bereits eine andere sichtbare Buchung oder Baustelle befindet. Es wird dabei nichts an der überlappenden Buchung verändert.
4. Sind mehrere konfliktfreie ENTER-Blocker vorhanden, wird nach der sichtbaren Planbar-Ressourcenreihenfolge von oben nach unten der erste verwendet. Innerhalb derselben Ressource gilt der früheste passende Blocker. `Dawid Service` sowie `Antonio Lausic` und bekannte Schreibvarianten bleiben ausgeschlossen.
5. Der tatsächliche Termin übernimmt exakt Ressource, Start und Ende des ausgewählten Blockers. Das Airtable-Datum bestimmt die Kalenderwoche, überschreibt aber nicht die sichtbaren Blockergrenzen.
6. Vor jeder Entfernung müssen Kunde, Kontaktdaten, Auftragsnummer, Kurzbeschreibung, Ressource und Zeitraum vollständig vorbereitet und nochmals geprüft sein.
7. Wenn Planbar eine parallele Anlage zulässt, wird zuerst die tatsächliche Baustelle angelegt und verifiziert und erst danach genau dieser eine Blocker entfernt. Wenn die Oberfläche dies nicht zulässt, wird der vorbereitete Blocker genau einmal entfernt und der Termin unmittelbar am gleichen Platz angelegt; bei Fehlschlag ist der identische Blocker wiederherzustellen und sichtbar zu verifizieren.
8. Niemals einen Blocker löschen, wenn die anschließende Anlage nicht eindeutig vorbereitet ist. Keine Serienaufgabe oder andere Vorkommen des Standardaufgaben-Typs verändern.
9. Existiert bereits ein eindeutiger echter Kundentermin aus dem Abschnitt `Dublettenschutz und vorhandene Termine in Planbar`, wird kein ENTER-Blocker entfernt. In diesem Fall sind nur die dort freigegebenen Ergänzungen am vorhandenen Termin beziehungsweise Kunden zulässig.

## Schreiben, Rückprüfung und Bericht

1. Pro Fall höchstens eine tatsächliche Baustelle und höchstens ein entfernter ENTER-Blocker. Bei einem bereits vorhandenen Termin gibt es keinen zweiten Termin und keinen ersetzten Blocker.
2. Nach dem Speichern Planbar neu öffnen und `EN`-Kunde, Anschrift, Auftragsnummer, Beschreibung, Ressource, Start/Ende und gegebenenfalls das Verschwinden genau des ersetzten Blockers sichtbar prüfen.
3. Bei Soll-/Ist-Abweichung keine weiteren Schreibversuche am selben Fall; technische und fachliche Ursache dokumentieren.
4. Pro Lauf einen sekretfreien JSON-Bericht unter `outputs/planbar-enter-airtable/YYYY-MM-DD/lauf.json` speichern und im Ergebnis der Codex-Aufgabe zusammenfassen.
5. Berichtssummen: Airtable-Datensätze in der Stage, neue Datensätze, ab KW 37 beziehungsweise nicht vergangen, bereits in Planbar vorhanden, mit Pipedrive-Fallback geprüft, bestehende Termine vervollständigt, Präfix korrigiert, geändert, übersprungen und blockiert.
6. Keine Passwörter, OTPs, vollständigen Kontaktdaten, Anhang-URLs oder vollständigen Angebotsinhalte protokollieren.

## Zeitplan

- Eigenständige lokale Automation täglich um 02:30 Uhr Europe/Berlin. Der Abstand hält sie vom unveränderten Planbar-Vervollständigungsworkflow um 08:00 Uhr getrennt und lässt den separaten ENTER-Lauf nachts vorlaufen.
- Maximale Laufzeit 20 Minuten. Transiente Browserfehler gezielt beheben; keine blinde Schleife.
