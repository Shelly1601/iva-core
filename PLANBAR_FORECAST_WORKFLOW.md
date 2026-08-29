# Planbar-Forecast an Angelo – verbindlicher Freitagsworkflow

Stand: 29.08.2026

## Zeitplan und Empfänger

- Lauf: freitags um 19:00 Uhr, Zeitzone `Europe/Berlin`.
- Zeitraum: Die unmittelbar folgende Kalenderwoche wird vollständig ausgelassen. Der Forecast umfasst zehn vollständige Kalenderwochen ab dem übernächsten Montag.
- Verbindliches Beispiel für den Freitagslauf am 21.08.2026: KW 35 auslassen und KW 36–45 exportieren.
- Absender: `n.sell@heat-hero.com`.
- Empfänger: Angelo Keller, `a.keller@heat-hero.com`.
- Versand: sichtbar über Outlook auf dem iMac; danach in „Gesendet“ verifizieren.
- Ausführung: Der Railway-Wochenslot bleibt bis zum echten iMac-Endzustand offen. Ist Railway oder der iMac zum Termin nicht verfügbar, wird derselbe Kalenderwochenslot nachgeholt. Ein bloß eingereihter oder gestarteter iMac-Auftrag ist kein Erfolg.
- Wiederanlauf: Slot-ID und iMac-Auftrags-ID bleiben über Serverneustarts stabil. Fehlversuche werden begrenzt neu gestartet; ein bereits von Outlook übernommener Versand wird ausschließlich in „Gesendet“ nachgeprüft und niemals erneut gesendet.

## Verbindliches Ausgabeformat

Der Versand enthält ausschließlich Excel-Dateien:

1. eine Gesamtdatei `Planbar_Gesamtliste_KW<von>-<bis>_<Jahr>.xlsx`;
2. für jeden tatsächlich vorkommenden Hersteller genau eine eigene Datei `Planbar_<Hersteller>_KW<von>-<bis>_<Jahr>.xlsx`.

PDF-Dateien dürfen weder erzeugt noch angehängt werden. Es werden keine leeren Herstellerdateien angelegt.

Jede Herstellerdatei enthält genau die Spalten:

- `Kalenderwoche`
- `Kunde`
- `Adresse`
- `Anlage`

Die Zeilen sind nach Kalenderwoche und Kunde sortiert. Kopfzeile und Filter bleiben beim Scrollen nutzbar. Die Gesamtdatei verwendet dieselbe Kernstruktur.

## Daten- und Herstellerregeln

- Kalenderwoche aus der sichtbaren Position im Planbar-Kalender übernehmen, nicht aus einem möglicherweise veralteten Detailfeld.
- Die Planbar-Spalten `David Service` und `Antonio Lausich` sind vollständig ausgeschlossen. Kein Termin aus diesen beiden Spalten darf in Gesamt- oder Herstellerdateien erscheinen.
- Zu jedem intern erfassten Termin muss die sichtbare Planbar-Spalte/Ressource gespeichert werden. Fehlt diese Angabe, wird der gesamte Export abgebrochen. Die Spaltenangabe dient nur der Filterkontrolle und erscheint nicht in Angelos Dateien.
- Urlaub, Nicht verfügbar, Blocker und interne Sperrzeiten ausschließen.
- Identische Kundentermine innerhalb derselben KW nach Name und Adresse deduplizieren.
- Hersteller-Schreibweisen normalisieren. Johnson, Johnson Controls und York bilden die Gruppe `Johnson Controls York`.
- Nicht eindeutig erkennbare Hersteller als `Nicht angegeben` führen; niemals raten.
- In `Anlage` nur die Wärmepumpe beziehungsweise eindeutige Modellbezeichnung aufführen, kein Zusatzmaterial.

## Technische Prüfung vor Versand

1. Der Spreadsheet-Workflow erzeugt im aktuellen Laufordner Gesamt- und Herstellerdateien sowie `manifest.json` (alternativ kompatibel: `xlsx-manifest.json`) und `qa.json`.
2. Jede erzeugte XLSX wird wieder eingelesen und auf Struktur und Formel-/Dateifehler geprüft.
3. Jedes Tabellenblatt wird gerendert und visuell auf abgeschnittene oder unlesbare Inhalte kontrolliert.
4. Das Manifest muss genau eine Gesamtdatei und genau eine nichtleere Datei je Hersteller enthalten.
5. Das Manifest muss die beiden Ausschlüsse `David Service` und `Antonio Lausich`, eine vollständige Spaltenzuordnung und die Zahl der entfernten Termine ausweisen.
6. Dateiendungen aller Anlagen müssen `.xlsx` sein; bei `.pdf` bricht der Versand ab.
7. Vor dem sichtbaren Outlook-Versand Manifest und Anhänge erneut validieren, Doppelversand über `send-log.json` und Outlook `Gesendet` ausschließen und die gesendete Nachricht anschließend in Outlook verifizieren.

Der Versand erfolgt ausschließlich mit dem deterministischen iMac-Sender:

```bash
node local-mac-helper/planbar-forecast-mail.mjs "/absoluter/iCloud-Laufordner" --commit
```

Der Sender übernimmt nur die exakten vollständigen XLSX-Pfade aus dem Manifest. Finder-, Spotlight- oder Outlook-Dateisuche ist für Anlagen verboten. Vor dem Senden werden Absender, Empfänger, Betreff und die vollständige sichtbare Anhangsliste erneut verglichen; jede zusätzliche oder fehlende Datei und jede PDF führen zum Abbruch. Nach geschlossenem Verfassen-Fenster wird die Nachricht über Outlooks natives `Gesendet`-Postfach anhand Betreff, Empfänger und exakter Anlagenliste geprüft. Wurde das Senden bereits bestätigt, darf ein noch ausstehender Gesendet-Nachweis niemals einen erneuten Versand auslösen.

## Protokollierung

Jeder Lauf dokumentiert Zeitraum, Zahl der eingelesenen und wegen der beiden Planbar-Spalten ausgeschlossenen Termine, Zahl der verbleibenden Baustellen, Zahl der Hersteller, Zahl und Namen der XLSX-Anhänge, Absender, Empfänger sowie die Prüfung im Gesendet-Ordner. `outputs/planbar-weekly/send-log.json` verhindert Doppelversand. Die zentrale Automation erhält erst den Status `completed`, wenn `sentFolderVerified: true` vorliegt; während iMac- oder Outlook-Arbeit bleibt sie sichtbar auf `waiting`.
