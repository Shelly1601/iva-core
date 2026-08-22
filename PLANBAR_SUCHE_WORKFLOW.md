# Planbar-Suche – verbindlicher Ablauf

Stand: 22. August 2026

Die Heat-Hero-Projektakte enthält direkt oberhalb von „Kunde terminieren“ eine rein lesende Planbar-Suche. Sie durchsucht Kundenname, Hersteller und weitere Stichwörter aus der Auftragsbeschreibung und zeigt die Kalenderwoche, den Terminzeitraum sowie das aktuell zugeordnete Team.

## Datenstand

- „Planbar aktualisieren“ beauftragt den eingerichteten iMac-Geräteagenten, über die angemeldete Planbar-Plantafel den aktuellen Terminstand ab dem Montag der laufenden Woche für 16 Wochen rein lesend einzulesen.
- Maßgeblich sind die Termine und Teamzuordnungen aus Planbars eigener Kalender-Lesequelle. Abweichende ältere Datumswerte aus einem Auftragsdetail werden nicht als Kalenderwoche übernommen.
- Gespeichert werden nur Kundenname, Auftragsbeschreibung, Team/Ressource und Terminzeitraum. Telefonnummer und Adresse werden nicht in den Suchindex übernommen.
- Jede Suche nennt den Zeitpunkt des zuletzt verifizierten Planbar-Stands. Ein Stand über 36 Stunden wird als veraltet markiert.

## Suche

- Ohne Zeitraum wird der gesamte aktuell eingelesene 16-Wochen-Stand durchsucht.
- Mit „nächste 3/6/12 Wochen“ werden nur überlappende Termine im gewählten Zeitraum ausgegeben.
- Eine Anfrage wie „Such mir in den nächsten drei Wochen eine Cuderos“ verwendet die Planbar-Suche mit dem Stichwort `Cuderos` und dem Zeitraum `3 Wochen`.
- Mehrere Treffer werden vollständig mit Kunde, KW, Zeitraum und Team ausgegeben. Bei keinem Treffer wird weder ein Termin noch eine Ressource geraten.

Die Suche verändert keine Planbar-Kunden, Termine, Beschreibungen oder Teamzuordnungen.
