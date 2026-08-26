# Workflow „Kunde terminieren“

Stand: 26. August 2026 · Version 4

## Trigger und Ziel

Der Workflow startet auf Nadines Zuruf, zum Beispiel: **„Heat-Hero-Kunde terminieren: Stefanie Schneider in KW 39.“** IVA klärt vor dem Start den Kundentyp/Partner, sucht den eindeutig passenden Vorgang, legt den Kunden bei Bedarf in Planbar an und plant die Montage über die fünf Werktage Montag bis Freitag der genannten ISO-Kalenderwoche ein. Ist der Partner im Auftrag nicht eindeutig, fragt IVA ausschließlich diesen fehlenden Wert nach.

Alternativ kann Nadine den Auftrag direkt oben in der Heat-Hero-Projektakte auslösen: Kundentyp/Partner auswählen, Kundenname eintragen, die gewünschte Kalenderwoche aus dem rollierenden Dropdown auswählen, beide Materialfragen per Ja/Nein-Checkbox beantworten und den Workflow starten. Für Enter steht zusätzlich die ausdrückliche Option bereit, bei fehlendem ENTER-Block einen vollständig freien Fünf-Tage-Platz zu verwenden. Die optionale Zusatzinfo wird nur gespeichert und übertragen, wenn sie nach dem Trimmen tatsächlich Inhalt enthält. Ein eindeutiger IVA-Chat- oder Projektaktenauftrag gilt als ausdrückliche Freigabe für genau diesen eng begrenzten Planbar-/Pipedrive-Ablauf; eine zweite Bestätigung wird nicht verlangt.

Verbindliche Standardtypen sind `Heat Hero = HH`, `Enter = EN` und `D Warmte = DW`. Weitere Typen und Präfixe können in der Heat-Hero-Projektakte gespeichert werden. Das ausgewählte Präfix steht im Planbar-Vornamen genau einmal vor dem eigentlichen Vornamen.

## 1. Verbindliche Quellen und Vorprüfung

1. Pipedrive bleibt bis zur erfolgreich rückgeprüften Planbar-Anlage **rein lesend**. Erst der definierte Abschluss in Abschnitt 4 darf den Deal verändern.
2. Der Deal muss entweder in **„Förderung beantragen“** oder in der live sichtbaren Stufe **„Montage einplanen“** liegen. „Montage terminieren“ ist Nadines gleichbedeutender Kurzname dafür.
3. Identität nur bei eindeutiger Übereinstimmung von Kundenname und Deal verwenden. Vorhandene Adresse, E-Mail und Telefonnummer werden aus der belegten Kontaktperson gelesen.
4. Auftragsnummer und Leistungsbeschreibung werden nach `PLANBAR_VERVOLLSTAENDIGUNG_WORKFLOW.md` ermittelt. Die Auftragsnummer stammt **immer aus dem sichtbaren Inhalt des unterschriebenen Angebots**. Deal-Titel, Pipedrive-Auftragsfeld und Dateiname sind dafür niemals maßgeblich. Original und unterschriebene Fassung werden abgeglichen; kann der Inhalt der unterschriebenen Fassung nicht sicher gelesen werden, blockiert das den Planbar-Schreibschritt.
5. Die Beschreibung enthält nur die tatsächlich beauftragten fett gedruckten Positionsüberschriften. Die Wärmepumpe steht zuerst als `Leistung + Hersteller`; Speicher- und TMB-Regeln gelten unverändert.

## 2. Planbar-Kunde anlegen

1. Vor jeder Anlage Planbar aktualisieren und die Sitzung prüfen.
2. Zuerst nach Name, Anschrift, E-Mail und Telefonnummer auf Dubletten prüfen. Ein bereits eindeutig vorhandener Kunde wird verwendet und nicht erneut angelegt.
3. Nur wenn kein Treffer existiert, Privatkunde mit folgenden Feldern anlegen:
   - Vorname: exakt das gespeicherte Präfix des ausgewählten Partners plus Leerzeichen und Vorname; ein vorhandenes identisches Präfix niemals verdoppeln.
   - Nachname: Nachname.
   - Anschrift: Straße/Hausnummer, PLZ und Ort in den dafür vorgesehenen Feldern.
   - E-Mail-Adresse: belegte Kontaktadresse.
   - Telefon oder Mobil: entsprechend der Pipedrive-Kennzeichnung; eine Mobilnummer kommt in `Mobil`.
4. Kundendaten und Speichern sind externe Schreibaktionen. Sie sind ausschließlich durch den eindeutigen Auftrag mit Partner, Kunde, KW und beiden Materialantworten freigegeben; andere oder weitergehende Änderungen bleiben gesperrt.

## 3. Termin in der genannten KW

1. Zeitraum ist immer Montag bis einschließlich Freitag der ISO-Kalenderwoche; technisch endet ein ganztägiger Termin am Samstag exklusiv.
2. Für Heat Hero, D Warmte und weitere Partner im Modus `free-resource` zählt ausschließlich eine sichtbare Ressource, die in der Zielwoche von Montag bis Freitag vollständig frei ist. Die Ressourcenauswahl erfolgt in der sichtbaren Planbar-Reihenfolge von oben nach unten. Eine auch nur teilweise Belegung in diesem Fünf-Tage-Zeitraum sperrt die Ressource vollständig; mehrere einzelne freie Tage werden nicht zu einem Platz zusammengerechnet.
3. Für Enter wird vorrangig der erste konfliktfreie Standardblock mit dem exakten Text `Geblockt für Kunde ENTER` verwendet, der Montag bis Freitag vollständig umfasst. Dieser eine Block wird durch den tatsächlichen Termin ersetzt. Kürzere oder nur teilweise überlappende ENTER-Blöcke sind unzulässig.
4. Nur wenn Nadine beim konkreten Enter-Auftrag das Feld `Falls kein ENTER-Block vorhanden ist, freien Fünf-Tage-Platz verwenden` aktiviert hat, darf nach belegtem Fehlen eines passenden ENTER-Blocks ersatzweise die erste vollständig freie Montag-bis-Freitag-Ressource verwendet werden. Ohne Häkchen bleibt Planbar unverändert.
5. Nie verwenden: **David/Dawid Service** und **Antonio Lausic/Lausich/Lausitsch**. Die Schreibvarianten werden absichtlich gemeinsam ausgeschlossen.
6. Gibt es nach der partnerbezogenen Regel keinen zulässigen Platz, wird nichts angelegt und der Fall mit den belegten Kalenderdaten gemeldet.
7. Der Termin erhält den vorhandenen oder neu angelegten Planbar-Kunden, die belegte Auftragsnummer und die nach dem Vervollständigungs-Workflow erzeugte Kurzbeschreibung.
8. Unter den Angebotspositionen stehen immer die beiden Projektakten-Antworten `Materialannahme einige Tage vor Montagebeginn: Ja/Nein` und `Diebstahl- und wettersicher: Ja/Nein` als eigene Zeilen.
9. `Zusatzinfo: …` wird nur als weitere eigene Zeile angehängt, wenn das Freitextfeld einen nicht-leeren Inhalt besitzt. Bei leerem oder nur aus Leerzeichen bestehendem Feld erscheint keine Zusatzinfo in Planbar.

## 4. Pipedrive-Abschluss

1. Erst wenn Kunde und Montagetermin in Planbar gespeichert und sichtbar rückgeprüft sind, wird der zugehörige Pipedrive-Deal verändert.
2. Im linken Bereich **Dealinfo** das Feld **„Einbautermin Kalenderwoche“** auf `KW` direkt gefolgt von der zweistelligen oder einstelligen ISO-Kalenderwoche setzen, zum Beispiel `KW39`, und speichern.
3. Danach den Deal oben in der sichtbaren Phasenleiste **genau eine Phase nach rechts** verschieben. Die Zielphase wird aus der aktuell sichtbaren Reihenfolge ermittelt und nicht geraten. Im geprüften Fall führte `Montage einplanen` zu `Montage Terminiert, RG+AB senden`.
4. Pipedrive darf die Kalenderwoche dabei automatisch an den Deal-Titel anhängen. Ein Titel wie `… SOL LIVINGKW39` ist gewollt und wird nicht zurückkorrigiert.
5. Feldwert, ausgewählte Phase und gegebenenfalls automatisch ergänzter Deal-Titel werden nach den Schreibschritten sichtbar rückgeprüft. Ist die aktuelle Phase bereits die letzte sichtbare Phase, wird nicht verschoben und der Fall gemeldet.
6. Das Eintragen der Kalenderwoche und der Phasenwechsel sind mit dem eindeutigen Terminierungsauftrag freigegeben; eine erneute Bestätigung wird nicht verlangt.

## 5. WhatsApp-Bestätigung

1. Unmittelbar nach der sichtbar verifizierten Planbar-Anlage wird über die native WhatsApp-App auf Nadines iMac genau eine Nachricht im Format `Vorname Nachname, KW <Kalenderwoche>` gesendet, zum Beispiel `Stefanie Schneider, KW 39`.
2. Ziel ist ausschließlich die Gruppe `Terminierungen Dispo` innerhalb der Community `Heat Hero GmbH`. Da eine zweite gleichnamige Gruppe existiert, muss die Community-Zuordnung vor dem Senden sichtbar eindeutig sein.
3. WhatsApp Web und `web.whatsapp.com` sind ausgeschlossen. Ist Community oder Gruppe nicht eindeutig unterscheidbar, wird nichts gesendet und der konkrete Blocker gemeldet.
4. Bei fehlgeschlagener oder nicht vollständig rückgeprüfter Planbar-Anlage wird keine Nachricht gesendet. Ein lokaler idempotenter Abschlussnachweis verhindert eine zweite Nachricht für denselben Kunden-KW-Auftrag.

## 6. Sicherheits- und Abschlussprüfung

- Keine Teilanlage: Ohne eindeutige Identität, vollständige Kontaktdaten, widerspruchsfreie Auftragsnummer und belegte Beschreibung wird weder Kunde noch Termin gespeichert.
- Direkt vor dem Speichern Zeitraum, Ressource, Kunde, Auftragsnummer und Beschreibung erneut prüfen.
- Nach dem Speichern Planbar neu laden und Kundenstammdaten, Ressource, Montag–Freitag-Zeitraum, Auftragsnummer und Beschreibung sichtbar rückprüfen.
- Das Ergebnis nennt knapp Kunde, KW, Ressource, Pipedrive-Zielphase sowie Planbar- und WhatsApp-Verifikationsstatus. Personenbezogene Kontaktdaten werden nicht im Bericht wiederholt.
- Neue Regeln werden versioniert in diesem Dokument und in den automatisierten Prüfungen ergänzt.
