# IVA-Projektteams und Werkzeugauswahl

IVA kann einen Auftrag an echte Fachagenten verteilen. Jeder Teilauftrag erzeugt einen eigenen Modellaufruf mit Fachrolle, zugelassenen Lesewerkzeugen und eigenem protokollierten Lauf. Die bisherige Gehirnprüfung bleibt zusätzlich bestehen: Sie liefert Modellhinweise ohne Werkzeuge. Ein Teamlauf verwendet keine rekursive Gehirnprüfung und kann keine weiteren Teams starten.

## Arbeiten im Projekt

Im Bereich **Team & Anbindungen** einer Projektakte kann ein Auftrag mit automatischer Zuständigkeit oder einer ausgewählten Fachrolle gestartet werden. Alle aktivierten IVA-Fachrollen sind in jedem Projekt nutzbar. Konten können später ergänzt werden; ein fehlendes Konto blockiert die unabhängige Analyse bereitgestellter Informationen nicht.

Die Projekt-ID wird vom Server an Werkzeuge und Teilaufträge gebunden. Projektsitzungen besitzen getrennte, gehashte Verlaufskennungen. Projektprompts laden keine globalen Erinnerungen, persönlichen Wissenseinträge oder unternehmensspezifischen Standardabläufe anderer Projekte. Allgemeine Fachrollen bleiben verwendbar.

Ein Projekt erhält:

- seine eigene Akte, Notizen, Dateiliste und Anbindungen;
- einen Leser für eigene Text-, Markdown-, CSV-, JSON- und textbasierte PDF-Dateien;
- ausdrücklich geprüfte allgemeine Recherche-, Generierungs- und Analysefunktionen;
- konkret für dieses Projekt gebundene Kontowerkzeuge.

Globale Postfächer, Kalender, CRM-Systeme, Depots, Fallakten, Marketingbestände und Geräteaufträge werden nicht automatisch in neue Projekte übernommen. Neue Projektanbindungen benötigen einen tatsächlich gebundenen Adapter. Ein `readOnly`-Kennzeichen allein reicht für eine Freigabe nicht aus. Fehlende Fähigkeiten werden als Lücke zurückgegeben; es gibt keinen Rückfall auf ein anderes Projektkonto.

## Entscheidung und Ausführung

`findIvaTools` und `planIvaToolUse` bewerten die registrierten Werkzeuge anhand von Aufgabe, Fachrolle, Transportweg, Verbindungskonfiguration und beobachteten Aufrufergebnissen. Exakte Werkzeugnamen bleiben auffindbar. Strukturierte Schnittstellen werden bevorzugt; außerhalb des Projektscopes haben E-Mail-Aufträge den vorhandenen nativen Outlook-Weg auf dem Mac Mini als bevorzugten Weg.

`executeIvaTool` führt das ausgewählte Originalwerkzeug mit dessen Eingabeschema und bestehenden Fachprüfungen aus. Schreibende Aufrufe einer Toolmap werden geordnet ausgeführt. Der Audit-Eintrag nennt das tatsächlich ausgeführte Fachwerkzeug und den Projekt-/Laufkontext. Eine Planung führt noch keine Aktion aus. `queued`, `pending` und technische Fehler sind keine Erfolgsmeldungen.

Ein Hauptauftrag kann mit `delegateIvaTasks` bis zu drei abgegrenzte Teilaufträge vergeben. Maximal zwei laufen pro Anfrage gleichzeitig, insgesamt vier Specialist-Läufe pro Serverprozess. Jeder Lauf hat höchstens vier Modellschritte und 1.600 Ausgabetokens. Standardzeitlimit: 30 Sekunden, maximal 35 Sekunden. Modellbudgetprüfungen und Usage-Erfassung bleiben aktiv.

Fachagenten erhalten ausschließlich tatsächlich zugelassene Lesewerkzeuge. Änderungen und Versand bleiben beim Hauptablauf mit den jeweiligen vorhandenen Prüfungen. Ergebnisse enthalten Child-Lauf-ID, Projekt-ID, Status, Werkzeugnamen, Zusammenfassung und Modellnutzung. Teilfehler bleiben sichtbar; ein erfolgreiches anderes Teilresultat kann weiterverwendet werden.

Bei Abbruch erhalten Modell und Toolwrapper ein Abbruchsignal. Nach Abbruch startet kein neues Werkzeug. Falls ein Anbieter den Abbruch verspätet verarbeitet, bleibt sein Kapazitätsplatz bis zum tatsächlichen Abschluss belegt. Eine späte Antwort wird weiterhin für die Usage-Erfassung beobachtet.

## Instagram und spätere Konten

Der erste eigenständige Projekt-Kontoadapter ist Instagram. Er unterstützt öffentliche Referenzen über Apify sowie Medien und Kommentare eigener, bestätigter Professional-Konten über die offizielle Meta-Schnittstelle. Die eigene Kontozuordnung und die Zugehörigkeit eines Beitrags werden geprüft. Ein Reel-Link allein liefert keine vollständige Videoauswertung oder Audiotranskription.

Publishing, Direktnachrichten, Likes/Follows und vollständige Browsersteuerung von Instagram sind durch diesen Adapter nicht implementiert. Das UI unterscheidet vorgemerkte Kontodaten, konfigurierte Zugänge und tatsächlich bestätigte Verbindungen. Ein Medien-Verbindungstest bestätigt keine zusätzlichen Kommentar- oder Publishingrechte.

Kontobezeichnung und Profil können zunächst ohne Token gespeichert werden. Tokens werden serverseitig mit AES-256-GCM verschlüsselt, gebunden an Projekt und Anbieter. Dafür muss `IVA_PROJECT_CONNECTIONS_KEY` als vorhandener Server-Secret eingerichtet sein. Im Browser bleibt ein eingegebenes Token nur bis zum Absenden im Passwortfeld und wird nicht in Browserstorage gespeichert. Die öffentlichen Statusantworten enthalten keine Tokens. Ein Projekt übernimmt niemals globale Instagram-Tokens.

## Schnittstellen und Nachweise

Die folgenden Endpunkte liegen hinter dem bestehenden `/api`-Zugangsschutz:

| Endpunkt | Funktion |
| --- | --- |
| `GET /api/agents/runtime` | Runtime und Fachrollen anzeigen |
| `GET /api/tools/status?projectId=…` | Werkzeugkatalog im Kontext anzeigen |
| `GET /api/projects/:id/team` | Team und Anbindungen des Projekts anzeigen |
| `POST /api/projects/:id/agents/run` | Explizite Teilaufträge ausführen |
| `GET /api/projects/:id/connections` | Projektanbindungen anzeigen |
| `PUT /api/projects/:id/connections/:provider` | Kontodaten/Token im Projekt speichern |
| `POST /api/projects/:id/connections/:provider/verify` | Tatsächliche Konto- und Medienprüfung starten |
| `DELETE /api/projects/:id/connections/:provider` | Anbindung aus diesem Projekt entfernen |

Der normale Chat und Stream akzeptieren eine Projekt-ID und verwenden denselben Scope. Die Projekt-ID im URL-Pfad eines Teamauftrags hat Vorrang vor einem widersprechenden Feld im Requestbody.

Relevante Prüfungen: `verify-specialists.mjs`, `verify-project-scope.mjs`, `verify-tool-routing.mjs`, `verify-project-tools.mjs`, `verify-project-team.mjs` und die Chat-/Stream-Projektfälle in `verify-brain.mjs`. Die Projektdateitests verwenden zwei echte isolierte Testprojektakten und belegen, dass eine gültige fremde Datei-ID keinen Zugriff eröffnet. Die Runtime-Tests prüfen separate Modell-/Werkzeugläufe, Fehlerbehandlung, Grenzen, Abbruch und die Erfassung verspäteter Nutzung.
