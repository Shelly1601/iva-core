# IVA Gespräche & Sales-Coach

Stand: 16.09.2026. Owner-Modul `sales-coach`, pro Projekt; kein öffentliches Portal. Root montiert `registerSalesCoachRoutes` nach Owner-Guard und injiziert `getProject` mit Projektmodul-Prüfung. `salesCoachSkill` liest Sitzungen, speichert ausdrücklich zugeordnete Namen/Notizen und legt geprüfte Gespräche ab. Kein Chat-Tool startet Mikrofon oder neue kostenpflichtige Analyse.

## Reale Aufnahmewege

- Persönliches Gespräch/Sprachnotiz: MediaRecorder nach Klick und dokumentierter Zustimmung, Safari/Browser im Vordergrund. Der Pegel zeigt Mikrofonaktivität, nicht garantierte Verständlichkeit.
- Begleitung: vollständige Dateien von ungefähr 45 Sekunden; Transkription und optional ein kurzer Coach-Impuls danach. Kleine Lücken beim Wechsel der Aufnahmedatei sind möglich. Keine behauptete Echtzeit-Diarisierung.
- Telefonat auf demselben iPhone: nicht als zuverlässiger Browser-Mitschnitt unterstützt. Lautsprecher umgeht das Betriebssystem nicht. Praktischer Pfad: Telefonat am iPhone, zweites Gerät mit Mikrofon für IVA oder einen vorhandenen, mit Zustimmung erstellten Mitschnitt importieren. Keine verdeckte Aufnahme.
- iOS-Appwechsel, Hintergrund/Sperre, Mikrofon-Mute/-Ende, Audio-Interruption und Offline halten an. Online startet keine Aufnahme, keinen Upload und keinen Modellaufruf neu. Auf dem konkreten iPhone ist die Hör-/Mikrofonqualität noch nicht verifiziert.

## Anbieter und Status

`OPENAI_API_KEY` ermöglicht `gpt-4o-transcribe-diarize` mit `diarized_json`, `chunking_strategy=auto`; bei fehlendem OpenAI-Zugang wird der vorhandene `ELEVENLABS_API_KEY` für `scribe_v2`, `diarize=true` verwendet. Optional `IVA_COACH_TRANSCRIPTION_PROVIDER=openai|elevenlabs` legt die Auswahl fest. Auswahl erfolgt vor dem ersten Aufruf, kein Fehler-Fallback auf einen zweiten kostenpflichtigen Anbieter. Groq Whisper ist kein Ersatz für Sprechertrennung.

Der Coach verwendet das vorhandene `chat`-Routing oder `IVA_MODEL_SALES_COACH` mit zentraler Budgetreservierung, `maxRetries:0`, höchstens 650 Antworttokens und einem maximal 30 Sekunden langen Aufruf. Keine JSON-Reparaturschleife. Ein Impuls braucht gültige Referenzen zu tatsächlich gespeicherten Segmenten; Preise, Zusagen oder Identitäten dürfen nicht erfunden werden.

Konfigurationsstatus ist ausdrücklich kein Verbindungs-/Qualitätsbeweis. Die UI zeigt nur nach einem bestätigten Abschnitt die letzte Transkription als bestätigt.

## Daten, Zuordnung und Abbrüche

Audioentwürfe bleiben in IndexedDB auf dem Aufnahmegerät, bis die Verarbeitung bestätigt ist oder der Nutzer den Entwurf entfernt. Lokales Anhören und Audio-Download sind möglich. IVA speichert serverseitig nur Text/Segmente/Metadaten; Provideraufbewahrung richtet sich separat nach dem verbundenen Anbietervertrag. Nach unklarem Ausgang bleibt die Audiodatei lokal und der bestätigte Serverstand kann ohne Modellaufruf gelesen werden. Kein automatischer Neuanlauf nach Serverneustart. Ein bereits begonnener Aufruf kann trotz Verbindungsabbruch Kosten verursachen.

Persistierte Clip-ID und Audio-SHA-256 verhindern Doppelverarbeitung (auch eine identische Datei mit neuer Clip-ID im selben Gespräch). Bei Fehler wird `uncertain`, bei erhaltenem Transkript und fehlendem Coach `partial` angezeigt. Kein Ergebnis wird erfunden. Mehrere Abschnitte erhalten getrennte anonyme Sprecher-IDs; Gleichheit einer Person über Abschnitte wird nicht behauptet. Namen vergibt der Nutzer ausdrücklich, spätere Umbenennung verändert keine Originalsegmente.

Kundenablage braucht eine zum Projekt gehörende Kundenakte und explizite Inhaltsprüfung. Die Meeting-ID bestätigt die Ablage. Nochmalige Ablage aktualisiert dasselbe Meeting; E-Mails/LinkedIn-Nachrichten werden nicht gesendet.

## Nachweise

- 19 synthetische Offlineprüfungen: Zustimmung/Projektgrenzen, idempotente Anlage und Audiodedupe, anonyme Sprecher je Abschnitt, spätere Benennung, ASR-Fehler ohne Replay, Transkript bei Coachfehler erhalten, Abbruch vor Coach verhindert zweiten Aufruf, gesicherte Meeting-Ablage, Providerformate OpenAI/ElevenLabs, kein 429-Retry, keine JSON-Reparatur, kostenfreie Wiederverbindung, späte Mikrofonfreigabe nach Stop, Dateiformat und Chat-Projektbindung.
- Bestehender `scripts/verify-workspaces.mjs`: grün.
- Headless Chrome Desktop 1440 und mobile Breite 390: reale isolierte Express-Routen/Service, synthetischer Anbieter und simuliertes Mikrofon. Import → Auswertung → Namenszuordnung → Notiz → Aktenablage; Offline finalisiert den lokalen Entwurf, Wiederverbindung und Standlesen erzeugen 0 zusätzliche Provideraufrufe. Kein Seitenüberlauf.
- Ein echter Providerprobe-Aufruf mit lokal erzeugten künstlichen Stimmen: 30 Sekunden, `scribe_v2`, zwei Sprecher, vier Segmente; genau ein ASR-Aufruf. Anschließend genau ein tatsächlicher Coach-Aufruf mit `groq:openai/gpt-oss-120b`, nächste Frage plus drei Segmentbelege bestätigt. Keine Kundenaudiodaten, keine Geheimnisse in Dateien/Logs, synthetische Audiodateien danach gelöscht.
- Offen: echter Safari-/iPhone-Hardwaretest mit Nutzerzustimmung und tatsächlicher Raum-/Lautsprecherqualität. Keine Garantie für perfekte Trennung, überlappende Stimmen oder gleichzeitigen iPhone-Telefonanruf.

## Offizielle Quellen, geprüft am 16.09.2026

- Apple, Audio-Unterbrechungen: https://developer.apple.com/documentation/avfaudio/avaudiosession/setprefersnointerruptionsfromsystemalerts(_:)
- Apple, regionale Verfügbarkeit einer systemeigenen Telefonaufnahme: https://support.apple.com/en-gb/guide/iphone/iph57c6590e9/ios
- Android, konkurrierende Mikrofonaufnahme/Telefonate: https://developer.android.com/media/platform/sharing-audio-input
- MDN, Safari-/Sperrbildschirm-Unterbrechungen und ungenaue Timeslices: https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/dataavailable_event
- OpenAI, Datei-Transkription und Diarisierung: https://developers.openai.com/api/docs/guides/speech-to-text
- ElevenLabs, Scribe-v2-API/Diarisierung: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
