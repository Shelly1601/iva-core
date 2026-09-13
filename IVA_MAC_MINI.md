# IVA von überall steuern, auf dem Mac Mini ausführen

Verbindlicher Auftrag vom 13.09.2026. Der Gerätekanal macmini-nadine prüft Hostname, Hardwaremodell, Hardware-Fingerprint, Protokollversion und lokalen Arbeitsordner. Das frühere Gerät imac-nadine wird nicht mehr akzeptiert. Die neue Agent-Authentifizierung verwendet MACMINI_DEVICE_TOKEN; das alte IMAC_DEVICE_TOKEN wird nicht mehr ausgewertet.

Das geschützte Cockpit ist unter https://iva-core-production.up.railway.app/cockpit von jedem Gerät erreichbar. Die Oberfläche lädt öffentlich; Daten und Aufträge benötigen den bisherigen Cockpit-Zugang. Dieser kann keinen Geräteagenten authentifizieren. Auf dem Mac Mini bleibt zusätzlich http://127.0.0.1:4318/cockpit verfügbar; dessen Proxy hält seinen eigenen Schlüssel im lokalen Schlüsselbund. Die Beschränkung auf den Mac Mini betrifft die Ausführung, nicht das Gerät, auf dem Nadine das Cockpit öffnet.

Die aktive Quelle liegt unter /Users/macmini/Documents/Codex/IVA/iva-core; die laufenden Helfer verwenden ein geprüftes lokales Runtime-Paket. Die Befehlsabholung erfolgt alle zwei Sekunden. LaunchAgents starten Proxy und Geräteagent nach der Anmeldung neu.

Workflow-Unterbrechungen bleiben mit derselben Auftrags-ID und den vorhandenen Ergebnisbelegen gespeichert. Reparaturversuche verwenden steigende Wartezeiten bis fünf Minuten; bestätigte Ergebnisse verhindern erneute Ausführung. Unklare Schreibausgänge verlangen die Prüfung des Zielzustands, insbesondere bei Planbar-Reservierungen.

Der frühere iMac hat seine beiden IVA-LaunchAgents deaktiviert und die zugehörigen Prozesse nachweislich beendet; die Stilllegungsquittung vom 13.09.2026 meldet keine Fehler. Der ausführende MacBook-Gerätekanal ist gesperrt; das MacBook darf als Cockpit dienen. Sein lokaler Prozesszustand wurde nicht direkt geprüft.

Die native Outlook-Sitzung ist der bevorzugte Mailzugang. Bedienungshilfen und Festplattenvollzugriff sind eingerichtet; der produktive Hintergrunddienst hat die Outlook-Steuerungsberechtigung bestätigt. Der Cockpit-Chat verwendet das bereits vorhandene Groq-Konto. Fachwerkzeuge werden bei Bedarf mit ihren vollständigen Schemas geladen und weiterhin anhand ihrer ursprünglichen Eingaberegeln geprüft.
