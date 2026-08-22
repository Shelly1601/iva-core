# Workflow „Kunde terminieren“

Stand: 22. August 2026 · Version 1

## Trigger und Ziel

Der Workflow startet auf Nadines Zuruf, zum Beispiel: **„Kunde terminieren: Stefanie Schneider in KW 39.“** IVA sucht den eindeutig passenden Heat-Hero-Vorgang, legt den Kunden bei Bedarf in Planbar an und plant die Montage über die fünf Werktage Montag bis Freitag der genannten ISO-Kalenderwoche ein.

## 1. Verbindliche Quellen und Vorprüfung

1. Pipedrive bleibt vollständig **rein lesend**.
2. Der Deal muss entweder in **„Förderung beantragen“** oder in der live sichtbaren Stufe **„Montage einplanen“** liegen. „Montage terminieren“ ist Nadines gleichbedeutender Kurzname dafür.
3. Identität nur bei eindeutiger Übereinstimmung von Kundenname und Deal verwenden. Vorhandene Adresse, E-Mail und Telefonnummer werden aus der belegten Kontaktperson gelesen.
4. Auftragsnummer und Leistungsbeschreibung werden nach `PLANBAR_VERVOLLSTAENDIGUNG_WORKFLOW.md` ermittelt. Die Auftragsnummer stammt **immer aus dem sichtbaren Inhalt des unterschriebenen Angebots**. Deal-Titel, Pipedrive-Auftragsfeld und Dateiname sind dafür niemals maßgeblich. Original und unterschriebene Fassung werden abgeglichen; kann der Inhalt der unterschriebenen Fassung nicht sicher gelesen werden, blockiert das den Planbar-Schreibschritt.
5. Die Beschreibung enthält nur die tatsächlich beauftragten fett gedruckten Positionsüberschriften. Die Wärmepumpe steht zuerst als `Leistung + Hersteller`; Speicher- und TMB-Regeln gelten unverändert.

## 2. Planbar-Kunde anlegen

1. Vor jeder Anlage Planbar aktualisieren und die Sitzung prüfen.
2. Zuerst nach Name, Anschrift, E-Mail und Telefonnummer auf Dubletten prüfen. Ein bereits eindeutig vorhandener Kunde wird verwendet und nicht erneut angelegt.
3. Nur wenn kein Treffer existiert, Privatkunde mit folgenden Feldern anlegen:
   - Vorname: exakt `HH ` plus Vorname; ein vorhandenes `HH ` niemals verdoppeln.
   - Nachname: Nachname.
   - Anschrift: Straße/Hausnummer, PLZ und Ort in den dafür vorgesehenen Feldern.
   - E-Mail-Adresse: belegte Kontaktadresse.
   - Telefon oder Mobil: entsprechend der Pipedrive-Kennzeichnung; eine Mobilnummer kommt in `Mobil`.
4. Kundendaten und Speichern sind externe Schreibaktionen. Unmittelbar davor wird Nadines konkrete Bestätigung eingeholt, welche Daten an Planbar übertragen und welche Buchung angelegt wird.

## 3. Termin in der genannten KW

1. Zeitraum ist immer Montag bis einschließlich Freitag der ISO-Kalenderwoche; technisch endet ein ganztägiger Termin am Samstag exklusiv.
2. Ressourcenauswahl erfolgt in der sichtbaren Planbar-Reihenfolge von oben nach unten. Verwendet wird die erste Ressource, die über den gesamten Zeitraum Montag bis Freitag ohne Überschneidung frei ist. Eine auch nur teilweise Belegung sperrt die Ressource für diesen Auftrag.
3. Nie verwenden: **David/Dawid Service** und **Antonio Lausic/Lausich/Lausitsch**. Die Schreibvarianten werden absichtlich gemeinsam ausgeschlossen.
4. Gibt es keine vollständig freie zulässige Ressource, wird nichts angelegt und der Fall mit den belegten Kalenderdaten gemeldet.
5. Der Termin erhält den vorhandenen oder neu angelegten Planbar-Kunden, die belegte Auftragsnummer und die nach dem Vervollständigungs-Workflow erzeugte Kurzbeschreibung.

## 4. Sicherheits- und Abschlussprüfung

- Keine Teilanlage: Ohne eindeutige Identität, vollständige Kontaktdaten, widerspruchsfreie Auftragsnummer und belegte Beschreibung wird weder Kunde noch Termin gespeichert.
- Direkt vor dem Speichern Zeitraum, Ressource, Kunde, Auftragsnummer und Beschreibung erneut prüfen.
- Nach dem Speichern Planbar neu laden und Kundenstammdaten, Ressource, Montag–Freitag-Zeitraum, Auftragsnummer und Beschreibung sichtbar rückprüfen.
- Das Ergebnis nennt knapp Kunde, KW, Ressource und Verifikationsstatus. Personenbezogene Kontaktdaten werden nicht im Bericht wiederholt.
- Neue Regeln werden versioniert in diesem Dokument und in den automatisierten Prüfungen ergänzt.
