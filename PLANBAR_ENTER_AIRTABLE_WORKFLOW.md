# Planbar ENTER aus Airtable - separater Workflow

Stand: 25. August 2026 - Version 1

## Strikte Trennung vom bestehenden Morgenworkflow

- Dieser Workflow ist eigenständig. `PLANBAR_VERVOLLSTAENDIGUNG_WORKFLOW.md` und die Automation `Planbar-Vervollständigung täglich um 8 Uhr` bleiben in Ablauf, Quelle, Zeitplan, Status und Regeln unverändert.
- Aus dem bestehenden Workflow werden nur die ausdrücklich passenden Bausteine übernommen: Angebotsauswertung, Kurzbeschreibung, Kundenstammdaten-Format und sichtbare Rückprüfung.
- WhatsApp, die HH-Übergabeliste, Pipedrive, TMB, Forecast und Kapazitätsmeldung sind keine Quellen oder Nebenaufgaben dieses ENTER-Workflows.

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

## Dublettenschutz in Planbar

1. Planbar vor dem Lauf genau einmal neu laden und den sichtbaren angemeldeten Zustand prüfen.
2. Vor jeder fachlichen Angebotsauswertung über den relevanten Planbar-Zeitraum nach einer bereits vorhandenen tatsächlichen Baustelle suchen.
3. Eine Baustelle gilt nur bei eindeutiger Übereinstimmung von Kundenname und Projektanschrift als vorhanden. Namensreihenfolge und Leerzeichen dürfen normalisiert werden; bloße Teiltreffer genügen nicht.
4. Bereits vorhandene Baustellen werden vollständig ignoriert. Sie werden weder umbenannt noch ergänzt oder auf `EN` korrigiert - auch nicht, wenn sie derzeit `HH` oder kein Präfix tragen.
5. Standardaufgaben, Urlaub, `nicht verfügbar` und alle Blockertexte zählen nicht als vorhandene Baustelle.

## Korrigiertes Angebot als einzige fachliche Quelle

1. Nur Anhänge aus dem Airtable-Feld `Angebot korrigiert` dürfen Auftragsnummer und Planbar-Beschreibung belegen.
2. Das Feld `Angebot`, Pipedrive-Dateien, Deal-Felder, Dateinamen außerhalb dieses Feldes, TMB oder andere Quellen dürfen nicht ersatzweise verwendet werden.
3. Fehlt `Angebot korrigiert`, wird keine Baustelle angelegt und kein Blocker verändert.
4. Bei mehreren Anhängen ist nur eine eindeutig spätere korrigierte Version zulässig, zum Beispiel durch `NEU` plus höhere sichtbare Angebotsversion und widerspruchsfreien Inhalt. Ist die Reihenfolge nicht eindeutig, bleibt der Fall unverändert.
5. Das PDF wird inhaltlich und visuell geprüft. Kundenname beziehungsweise Projektanschrift sowie Auftrags-/Angebotsnummer müssen eindeutig zum Airtable-Fall passen.

## Beschreibung wie bei Planbar-Vervollständigung

- Nur die fett gedruckten Überschriften tatsächlich beauftragter Positionen übernehmen; Erläuterungen, Unterzeilen und Preise entfallen.
- Die Wärmepumpe steht zuerst als `Leistung + Hersteller`; die Modellbezeichnung entfällt.
- Danach folgen die belegten Positionen in Angebotsreihenfolge.
- Mengenabhängige Zusatzpositionen erhalten belegte Zahl und Einheit. `Stk` wird zu `Stück`, überflüssige Dezimalnullen entfallen.
- Für genau einen zusätzlichen Heizkreis gilt `Zusätzlicher Heizkreis`, für mehrere zum Beispiel `3 zusätzliche Heizkreise`.
- Optionale, vollständig gestrichene oder nicht eindeutig ausgewählte Positionen werden ausgelassen.
- Speicher werden ausschließlich nach dem korrigierten Angebot behandelt: nur Warmwasserspeicher bedeutet zusätzlich `Pufferspeicher`; nur Pufferspeicher bedeutet zusätzlich `Warmwasserspeicher`; beide vorhanden bedeutet keine Ergänzung. Fehlen beide und ist keine Variante eindeutig ausgewählt, wird keine Speicherart geraten und keine andere Quelle geöffnet.
- Eine fehlende eindeutige Auftragsnummer oder eine unleserliche/widersprüchliche beauftragte Position blockiert den Schreibschritt.

## ENTER-Kunde in Planbar

1. Zuerst nach einem vorhandenen Planbar-Kunden über Name, Anschrift und - soweit vorhanden - Kontaktfelder suchen. Eindeutige Dubletten werden verwendet, nicht neu angelegt.
2. Bei einem neu anzulegenden oder für diesen Termin eindeutig verwendeten Kunden steht im Vornamen genau einmal `EN ` vor dem eigentlichen Vornamen. `HH ` ist in diesem Workflow niemals das Zielpräfix.
3. Nachname, Projektanschrift, E-Mail und Telefon/Mobil stammen aus dem aktuellen Airtable-Datensatz. Fehlende oder widersprüchliche Pflichtdaten werden nicht geraten.
4. Bereits vorhandene fremde Kundenwerte werden nicht still überschrieben. Ein Konflikt blockiert nur das betreffende Feld beziehungsweise bei unsicherer Identität den gesamten Fall.

## ENTER-Blocker ersetzen

1. Zulässig ist ausschließlich eine sichtbare Standardaufgabe mit dem exakten Text `Geblockt für Kunde ENTER` in der ISO-Kalenderwoche des geplanten Airtable-Datums.
2. Andere Blocker, Urlaub, Service, `nicht verfügbar` und fremde Partnerblocker bleiben unangetastet.
3. Sind mehrere passende ENTER-Blocker vorhanden, wird nach der sichtbaren Planbar-Ressourcenreihenfolge von oben nach unten der erste verwendet. Innerhalb derselben Ressource gilt der früheste passende Blocker. `Dawid Service` sowie `Antonio Lausic` und bekannte Schreibvarianten bleiben ausgeschlossen.
4. Der tatsächliche Termin übernimmt exakt Ressource, Start und Ende des ausgewählten Blockers. Das Airtable-Datum bestimmt die Kalenderwoche, überschreibt aber nicht die sichtbaren Blockergrenzen.
5. Vor jeder Entfernung müssen Kunde, Kontaktdaten, Auftragsnummer, Kurzbeschreibung, Ressource und Zeitraum vollständig vorbereitet und nochmals geprüft sein.
6. Wenn Planbar eine parallele Anlage zulässt, wird zuerst die tatsächliche Baustelle angelegt und verifiziert und erst danach genau dieser eine Blocker entfernt. Wenn die Oberfläche dies nicht zulässt, wird der vorbereitete Blocker genau einmal entfernt und der Termin unmittelbar am gleichen Platz angelegt; bei Fehlschlag ist der identische Blocker wiederherzustellen und sichtbar zu verifizieren.
7. Niemals einen Blocker löschen, wenn die anschließende Anlage nicht eindeutig vorbereitet ist. Keine Serienaufgabe oder andere Vorkommen des Standardaufgaben-Typs verändern.

## Schreiben, Rückprüfung und Bericht

1. Pro Fall höchstens eine tatsächliche Baustelle und höchstens ein entfernter ENTER-Blocker.
2. Nach dem Speichern Planbar neu öffnen und `EN`-Kunde, Anschrift, Auftragsnummer, Beschreibung, Ressource, Start/Ende und das Verschwinden genau des ersetzten Blockers sichtbar prüfen.
3. Bei Soll-/Ist-Abweichung keine weiteren Schreibversuche am selben Fall; technische und fachliche Ursache dokumentieren.
4. Pro Lauf einen sekretfreien JSON-Bericht unter `outputs/planbar-enter-airtable/YYYY-MM-DD/lauf.json` speichern und im Ergebnis der Codex-Aufgabe zusammenfassen.
5. Berichtssummen: Airtable-Datensätze in der Stage, neue Datensätze, ab KW 37 beziehungsweise nicht vergangen, bereits in Planbar vorhanden, ohne korrigiertes Angebot, geändert, übersprungen und blockiert.
6. Keine Passwörter, OTPs, vollständigen Kontaktdaten, Anhang-URLs oder vollständigen Angebotsinhalte protokollieren.

## Zeitplan

- Eigenständige lokale Automation täglich um 08:30 Uhr Europe/Berlin. Der Abstand hält sie vom unveränderten Planbar-Vervollständigungsworkflow um 08:00 Uhr getrennt.
- Maximale Laufzeit 20 Minuten. Transiente Browserfehler gezielt beheben; keine blinde Schleife.
