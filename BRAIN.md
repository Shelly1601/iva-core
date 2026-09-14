# IVAs automatische Modellprüfung

Seit Version 1.0.0 nutzt IVA bei komplexen Chat-Aufträgen zwei vorhandene Modelle als Berater. Der normale Chat und der Streaming-Chat verwenden denselben Ablauf; Telegram verwendet ebenfalls den normalen Chat-Einstieg. Es gibt keinen zusätzlichen Bedienknopf.

## Ablauf

1. Die Anfrage wird lokal im Serverprozess anhand von Aufgabenbegriffen und mehreren Arbeitsschritten eingeordnet. Kurze Bestätigungen, Statusfragen und andere einfache Anfragen gehen direkt an das reguläre Modell.
2. Bei komplexen Anfragen prüfen zwei unterschiedliche konfigurierte Modelle den begrenzten Gesprächsausschnitt parallel: Lösungsentwurf und Gegenprüfung. Verschiedene Anbieter werden bevorzugt. Im aktuellen Betrieb sind dies Groq und Gemini.
3. IVAs reguläres Modell erhält die Hinweise ausdrücklich als ungeprüftes Datenmaterial. Es entscheidet, was brauchbar ist, gleicht erforderliche Fakten mit seinen Werkzeugen ab und formuliert die Antwort.
4. Ausschließlich der bestehende IVA-Ablauf erhält Werkzeuge und führt beauftragte Aktionen aus. Es entstehen durch den Vergleich keine konkurrierenden Aktionsausführungen. Eine allgemeine Garantie genau einmaliger Ausführung bei Netzwerkfehlern ergibt sich daraus nicht; dafür bleiben die bestehenden Workflows zuständig.

Der Vergleich ist kein Faktenbeweis. Die Berater haben weder Live-Recherche noch Zugriff auf Fachsysteme. Die konfigurierten Hauptmodelle, Fachregeln und Gerätebindung werden nicht verändert. Die Fachwerkzeuge und bestehenden Codex-Worker bleiben die Ausführungsebene.

## Daten und Betrieb

Die Berater erhalten maximal vier Textnachrichten aus derselben Sitzung, insgesamt maximal 7.000 Zeichen und höchstens 5.000 Zeichen pro Nachricht. Systemprompt, eingebundenes Wissen, Werkzeuginhalte und Bilder werden nicht zusätzlich mitgeschickt. Die Gesprächsausschnitte gehen an die bereits eingerichteten Cloud-Anbieter; dies ist keine Offline-KI. Es werden keine neuen Anbieter, Konten oder Telemetriedienste eingeführt und kein G0DM0D3-Code übernommen.

Beide Berater besitzen keine Tools. Ihre Antworten werden nicht in den Nutzerverlauf geschrieben und nur als begrenzte Hinweise für den Hauptaufruf verwendet. Prüfstatus, Modellkennungen und Laufzeit stehen in der geschützten internen API `GET /api/brain/status` und im vorhandenen Audit unter Kategorie `brain`. Dort werden keine Gesprächsinhalte, Antworten oder Anbieterfehlermeldungen gespeichert.

Zeitüberschreitung, fehlende Zugänge, leere Antworten oder ausgeschöpftes Zusatzbudget blockieren den Hauptablauf nicht. Ein erfolgreicher Hinweis kann allein genutzt werden; bei vollständigem Ausfall bleibt der ursprüngliche Prompt erhalten. Fehlerhafte Modelle werden 60 Sekunden von weiteren Prüfungen ausgenommen. Nutzerabbruch beendet auch die Prüfphase und verhindert den nachfolgenden Hauptaufruf.

## Einstellungen

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `IVA_BRAIN_MODE` | `auto` | `off` deaktiviert; `always` prüft auch einfache Anfragen. |
| `IVA_BRAIN_MODELS` | vorhandene Routen | Optionale Liste vorhandener Router-Modellkennungen, durch Komma getrennt; maximal zwei werden verwendet. |
| `IVA_BRAIN_TIMEOUT_MS` | 12.000; Sprache 5.000 | Gemeinsames Zeitlimit der Berater; maximal 20.000 ms. |
| `IVA_BRAIN_MAX_TOKENS` | 1.000 | Ausgabelimit je Berater; maximal 1.500. |
| `IVA_BRAIN_MAX_EUR` | 0,03 | Obergrenze der geschätzten Kosten beider Berater je Anfrage. |
| `IVA_BRAIN_MAX_CONCURRENT` | 4 | Höchstens vier parallele Berateraufrufe pro Serverprozess. |

Kosten werden unter `brain-review` im bestehenden Modellverbrauch erfasst. Reservierungen verhindern, dass parallele Beratungen dasselbe verbleibende Monatsbudget mehrfach einplanen. Die Anzeige verwendet weiterhin die vorhandenen geschätzten Tokenpreise und ersetzt keine Anbieterabrechnung. Für hohe Kostenkontrolle bleiben anbieter-seitige Limits maßgeblich. Es wird kein Monatsbudget erhöht.

## Prüfung

`npm run test:brain` prüft automatische Auswahl, Datenbegrenzung, parallele Beratung ohne Werkzeuge, vorhandene Zugänge, Zeitlimit, Abbruch, Teilfehler, Zusatzbudget, konkurrierende Kostenerfassung und die tatsächlichen Chat-/Streaming-Einstiege mit genau einem Aktionsausführer. Die Tests enthalten keine echten Kundendaten und erzeugen keine Geschäftsvorgänge. Die Testgruppe ist in `test:all` enthalten.
