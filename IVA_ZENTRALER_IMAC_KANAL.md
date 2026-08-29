# Zentraler iMac-Kanal

Stand: 29. August 2026. Auftrag von Nadine: alle Rechneraktionen zentral auf dem iMac ausführen; MacBook als Arbeitsgerät freihalten. Operative Workflows haben Vorrang und werden bis zu einem belegten Endstatus beaufsichtigt.

## Ein Weg für alle Eingänge

Handy / MacBook / Telegram / IVA-Chat → authentifizierter IVA-Core auf Railway → Gerätewarteschlange `imac-nadine` → dauerhafter iMac-Agent → tatsächliches Ergebnis zurück an IVA.

- Geräteaktionen: IVA-Werkzeug `sendCommandToImac`.
- Freie, ausdrücklich beauftragte operative Aufgaben: `runTaskOnImac`.
- Codeänderungen: `startIvaBuild`.
- Nachverfolgung: `getImacCommandStatus`, anschließend bei Codex-Aufträgen `getImacTaskStatus`. `queued` bedeutet ausschließlich angenommen.
- Direkte API-Clients verwenden dieselben geschützten Endpunkte: `POST /api/devices/imac-nadine/commands`, `GET /api/devices/imac-nadine/commands/:id`, `GET /api/device-agent/status`. Keine eigenen lokalen Ausführungskanäle starten. Vorhandene Authentifizierung ausschließlich im sicheren Laufzeitkontext verwenden; keine Tokens in Dokumente, Skripte oder Protokolle schreiben.

## Laufzeit und Projektdateien

Der einzige dauerhafte Geräteagent ist `de.iva.device-agent`. Er startet:

`~/Library/Application Support/IVA Mac Helper/runtime/central/current/local-mac-helper/device-agent-runner.mjs`

Der IVA-Core stellt ein authentifiziertes Paket ausschließlich aus veröffentlichtem Helfer-Quellcode bereit. Der iMac prüft Inhalte, Prüfsummen, Syntax und Modulimporte, bevor er atomar auf eine neue lokale Version umschaltet. Projektquellen und Dokumente bleiben unter `iCloud/IVA-Assistent`. Laufende Helfer werden nicht mehr direkt aus eventuell ausgelagerten iCloud-Dateien importiert.

Keine alten Installations- oder Bootstrap-Skripte als normalen Aktualisierungsweg ausführen und keine zweite Agent-Kopie starten. Die initiale Migration erfolgt mit `local-mac-helper/install-central-runtime.mjs` auf dem iMac; spätere Updates kommen über den zentralen veröffentlichten Stand.

## Zuverlässigkeit und Freigaben

- Serielle Speichertransaktionen verhindern verlorene Befehle bei gleichzeitigen Heartbeats und Aufträgen.
- Eindeutige Ausführungsrechte und stabile Codex-Auftrags-IDs schützen vor Doppelstarts.
- UI-Aufträge teilen eine lokale Sperre. Weitere Aufträge warten; Statusabfragen bleiben möglich.
- Jeder laufende Codex-Workflow meldet alle 30 Sekunden ein eigenes Lebenszeichen samt Worker-/Unterprozess- und letzter Logaktivität. Das gilt auch während der Wartezeit auf einen anderen UI-Auftrag.
- Die lokale UI-Warteschlange darf bis zu zwölf Stunden warten; die eigentliche Workflow-Laufzeit ist auf sechs Stunden erweitert. Der Systemschlaf bleibt während der Ausführung verhindert.
- Der Agent gleicht alle lokalen Codex-Aufträge fortlaufend ab. Ein vor der Ausführungsfreigabe verlorener Start wird begrenzt wiederholt; ein nachweislich toter Worker wird mit demselben Auftrag höchstens zweimal kontrolliert fortgesetzt.
- Vor einer Fortsetzung prüft Codex vorhandene Belege und den sichtbaren Zielzustand und setzt am ersten nicht verifizierten Schritt fort. Bereits sichtbare oder gespeicherte Aktionen dürfen nicht wiederholt werden.
- Hat der unterbrochene Worker bereits einen vollständigen Erfolgs- oder Blockernachweis geschrieben, übernimmt die Aufsicht diesen Endstatus ohne erneute Geschäftsausführung.
- Planbar-Terminierungen bleiben strenger: Nach möglicher Schreibaktion gibt es keinen automatischen Neustart, bevor der Zielzustand geprüft wurde; ein belegter Slot bleibt erhalten und wird nie doppelt gebucht.
- `dispatchReady` bestätigt eine aktuelle Befehlsabholung. Ein Heartbeat allein reicht dafür nicht.
- Unklar abgeschlossene schreibende Aktionen werden nicht blind wiederholt.
- Normale Zwischenschritte im beauftragten Umfang brauchen keine neue Planbestätigung. Codex verwendet die vorhandene automatische Freigabeprüfung und den begrenzten Schreibbereich. Technisch erzwungene macOS-/Kontobestätigungen und außerhalb des Auftrags liegende Aktionen werden dadurch nicht aufgehoben.

## Bereits nachgewiesen

- Vollständige IVA-Testsuite erfolgreich; zusätzliche Tests für gleichzeitige Queue-Zugriffe, eindeutige Claims, beschädigte Pakete und UI-Serialisierung.
- Railway-Paket und lokal erwartetes Paket stimmen per SHA-256 überein.
- Neue Laufzeit `imac-central-v5` mit zwei fortlaufenden Heartbeats installiert.
- Öffentlicher Statusauftrag `677208bf-cdbc-44e0-9ba5-196855bb68b3`: auf dem iMac abgeschlossen.
- Öffentlicher Codex-Auftrag `76b6557f-acbd-423a-8e90-fb67f49210d4`, Job `0edcbba9-c9c1-49a1-919c-075719705572`: abgeschlossen; tatsächlicher Host `iMac-von-Nadine.local`, Projektpaket `iva-core`, Version `0.1.0`, keine geschäftlichen Schreibaktionen.
- Öffentliche Seiten `/control` und `/control.js` liefern HTTP 200; zentrale iMac-Anzeige vorhanden, IVA-Maskottchen erhalten.

Die Prüfung belegt den zentralen Transport, die lokale Ausführung und den Ergebnisrückweg. Sie ersetzt nicht die fachliche Abnahme jedes einzelnen Geschäftsworkflows.
