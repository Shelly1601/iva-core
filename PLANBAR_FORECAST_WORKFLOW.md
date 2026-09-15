# Planbar-Forecast an Angelo – verbindlicher Freitagsworkflow

Stand: 15.09.2026 · Ausführung ausschließlich auf dem attestierten Mac Mini gemäß ../AGENTS.md

## Verbindlicher Aktualitätslauf vor jedem Versand

1. Der **erste fachliche Schritt** ist Planbar im eigenen Chrome-Arbeitsfenster auf dem Mac Mini: den Kalender vollständig neu laden und auf ein neues, vollständig geladenes Dokument mit sichtbarer Plantafel warten. Ein einzelnes Display genügt; fremde Fenster bleiben unangetastet. Der deterministische Collector erzwingt diesen Reload vor jedem Snapshot und zeichnet `planbarRefreshedAt` sowie `reloadVerified` auf.
2. Die Forecast-Daten werden danach cachefrei neu aus Planbar eingelesen. `forecast-data.json` und `data.json` müssen im aktuellen Laufordner entstehen. `--from-existing`, ältere Quelldateien und vorbereitete Exporte sind technisch gesperrt.
3. Quelle, XLSX-Erzeugung, technische und visuelle Prüfung sowie Versand müssen in demselben Lauf liegen. Der belegte Planbar-Snapshot darf beim Versand höchstens 15 Minuten alt sein.
4. Unmittelbar bevor Outlook geöffnet wird, fragt der deterministische Sender denselben Zeitraum nochmals cachefrei aus Planbar ab. Die exportrelevanten Termine müssen einschließlich Kalenderwoche, Kunde, Adresse, Anlage, Hersteller und Quell-ID exakt mit dem Export-Snapshot übereinstimmen. Die Gesamtzahl und die Herstellergruppen müssen ebenfalls identisch sein.
5. Eine Verschiebung, Löschung, Neuanlage oder ein zu alter Export führt zu `PLANBAR_FORECAST_REBUILD_REQUIRED` (CLI-Exitcode 3). Dies ist eine konkrete Fortsetzungsaktion: **denselben Auftrag und dieselbe Versand-ID behalten**, Plantafel neu laden, Daten + XLSX + QA neu erzeugen und den Sender erneut aufrufen. Der Sender speichert `forecast-rebuild-required.json` im Laufordner sowie einen auftragsbezogenen Marker in `rebuild-requests/`. Höchstens drei Neuaufbauten je Auftrag; bei weiter wechselnden Daten bleibt der Auftrag mit `PLANBAR_FORECAST_SOURCE_UNSTABLE` nachvollziehbar offen. Ein bloßes „Änderung gefunden“ ist kein Abschluss.

## Zeitplan und Empfänger

- Automatischer Lauf: genau einmal pro Wochen-Slot, freitags um 18:00 Uhr, Zeitzone `Europe/Berlin`.
- Ausdrücklich beauftragte manuelle Läufe werden als `manual` getrennt protokolliert und verändern weder den Freitags-Slot noch dessen Historie.
- Automatik und manuelle Aufträge besitzen getrennte Zähler. Ein ausdrücklich beauftragter manueller Lauf darf auch bei identischem Empfänger, Betreff, Forecast-Zeitraum und identischen Anlagen zusätzlich zum Freitagslauf versendet werden.
- Der Versand-Duplikatschutz gilt ausschließlich für technische Wiederholungen derselben stabilen Auftrags-ID: derselbe Automatik-Slot beziehungsweise derselbe konkrete manuelle Auftrag darf niemals blind ein zweites Mal versendet werden.
- Zeitraum: Die unmittelbar folgende Kalenderwoche wird vollständig ausgelassen. Der Forecast umfasst zehn vollständige Kalenderwochen ab dem übernächsten Montag.
- Verbindliches Beispiel für den Freitagslauf am 21.08.2026: KW 35 auslassen und KW 36–45 exportieren.
- Absender: `n.sell@heat-hero.com`.
- Empfänger: Angelo Keller, `a.keller@heat-hero.com`.
- Versand: sichtbar über Outlook auf dem Mac Mini; danach in „Gesendet“ verifizieren.
- Ausführung: Der Railway-Wochenslot bleibt bis zum verifizierten Mac-Mini-Endzustand offen. Ist Railway oder der Mac Mini zum Termin nicht verfügbar, wird derselbe Kalenderwochenslot nachgeholt. Ein bloß eingereihter oder gestarteter Mac-Mini-Auftrag ist kein Erfolg.
- Wiederanlauf: Slot-ID und Mac-Mini-Auftrags-ID bleiben über Serverneustarts stabil. Fehlversuche werden begrenzt neu gestartet; ein bereits von Outlook übernommener Versand wird ausschließlich in „Gesendet“ nachgeprüft und niemals erneut gesendet.

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

1. Der Spreadsheet-Workflow erzeugt im aktuellen Laufordner aus der unmittelbar zuvor erstellten `forecast-data.json` und `data.json` die Gesamt- und Herstellerdateien sowie `manifest.json` (alternativ kompatibel: `xlsx-manifest.json`) und `qa.json`.
2. Jede erzeugte XLSX wird wieder eingelesen und auf Struktur und Formel-/Dateifehler geprüft.
3. Jedes Tabellenblatt wird gerendert und visuell auf abgeschnittene oder unlesbare Inhalte kontrolliert.
4. Das Manifest muss genau eine Gesamtdatei und genau eine nichtleere Datei je Hersteller enthalten.
5. Das Manifest muss die beiden Ausschlüsse `David Service` und `Antonio Lausich`, eine vollständige Spaltenzuordnung und die Zahl der entfernten Termine ausweisen.
6. Dateiendungen aller Anlagen müssen `.xlsx` sein; bei `.pdf` bricht der Versand ab.
7. Vor dem sichtbaren Outlook-Versand die zweite cachefreie Planbar-Abfrage und den exakten Snapshot-Abgleich durchführen, danach Manifest und Anhänge erneut validieren, Doppelversand über `send-log.json` und Outlook `Gesendet` ausschließen und die gesendete Nachricht anschließend in Outlook verifizieren.

Der Versand erfolgt ausschließlich mit dem deterministischen Mac-Mini-Sender:

```bash
node local-mac-helper/planbar-forecast-mail.mjs "/Users/macmini/Documents/Codex/IVA/iva-core/outputs/planbar-weekly/<aktueller-Lauf>" --commit --run-mode manual --delivery-run "<stabile-ID-dieses-manuellen-Auftrags>"
```

Der zentrale Freitagslauf ergänzt stattdessen `--run-mode automatic --automation-slot "<stabile Wochen-Slot-ID>"`. Jeder neue ausdrückliche manuelle Auftrag erhält eine neue `--delivery-run`-ID; technische Wiederholungen desselben Auftrags behalten dieselbe ID. Manuelle Aufträge dürfen niemals eine Automatik-Slot-ID erhalten.

Der Sender übernimmt nur die exakten vollständigen XLSX-Pfade aus dem Manifest. Er verlangt `forecast-data.json`, prüft deren Alter und liest Planbar unmittelbar vor Outlook erneut cachefrei. Finder-, Spotlight- oder Outlook-Dateisuche ist für Anlagen verboten. Vor dem Senden werden Absender, Empfänger, Betreff und die vollständige sichtbare Anhangsliste erneut verglichen; jede Planbar-Abweichung, jede zusätzliche oder fehlende Datei und jede PDF führen zum Abbruch. Nach geschlossenem Verfassen-Fenster wird die Nachricht über Outlooks natives `Gesendet`-Postfach anhand Betreff, Empfänger und exakter Anlagenliste geprüft. Wurde das Senden bereits bestätigt, darf ein noch ausstehender Gesendet-Nachweis niemals einen erneuten Versand auslösen.

## Protokollierung

Jeder Lauf dokumentiert Zeitraum, Zahl der eingelesenen und wegen der beiden Planbar-Spalten ausgeschlossenen Termine, Zahl der verbleibenden Baustellen, Zahl der Hersteller, Zahl und Namen der XLSX-Anhänge, Absender, Empfänger sowie die Prüfung im Gesendet-Ordner. `outputs/planbar-weekly/send-log.json` verhindert Doppelversand. Die zentrale Automation erhält erst den Status `completed`, wenn `sentFolderVerified: true` vorliegt; während Mac-Mini- oder Outlook-Arbeit bleibt sie sichtbar auf `waiting`.

## Deterministische Fortsetzung und Versandbeleg

- Der Daten-Builder verlangt ausdrücklich `--year`, `--start-week` und `--end-week`; er verwendet keinen alten Standardzeitraum. Beispielaufruf: `node scripts/build-planbar-forecast-data.mjs --output "<aktueller-Laufordner>" --year <Jahr> --start-week <von> --end-week <bis>`.
- Die abschließende Frischeprüfung lädt Planbar erneut und prüft den Snapshot. Direkt danach werden Manifest, QA und Anlagen erneut validiert; SHA-256-Prüfsummen schützen die bereits geprüften Anhänge vor nachträglichem Austausch.
- `delivery-receipts/` enthält einen atomar angelegten, dauerhaften Beleg je stabiler Versand-ID. Er entsteht vor dem Outlook-Aufruf und wird nicht automatisch gelöscht. Parallele Prozesse können denselben Auftrag dadurch nicht zweimal abschicken.
- Bei einem vorhandenen Versandversuch sind weitere Planbar-Abfragen und neue Anhänge für die Versandentscheidung unerheblich: Es wird nur der ursprünglich gespeicherte Absender, Empfänger, Betreff, die exakte Anlagenliste und das feste Zeitfenster des ersten Versuchs in Gesendet geprüft. Auch ein später fehlender Laufordner darf keinen Neuversand auslösen. Mehrdeutigkeit bleibt offen.
- Der zentrale Runner verlangt `sentFolderVerified: true` für **genau dieselbe manuelle Auftrags-ID bzw. denselben automatischen Wochen-Slot**. Ein anderer erfolgreicher Forecast oder ein Erfolgssatz im Chat ist kein Versandbeleg.
