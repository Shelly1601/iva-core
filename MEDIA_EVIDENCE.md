# Öffentliche Videoquellen für IVA

`integrations/media-evidence.js` exportiert `readMediaEvidence(url, options)` und `readSocialFeed(input, options)`. Das Modul speichert weder Quellvideos noch Ergebnisse lokal. Projektzuordnung und Aufbewahrung übernimmt der aufrufende Dienst.

## Tatsächlich ausgewertete Inhalte

Instagram-Posts/Reels und einzelne TikTok-Videos werden über Apify gelesen. Wenn eine öffentliche Videodatei vorliegt, lädt IVA deren Bytes sicher herunter und gibt sie an Gemini. YouTube verwendet den offiziellen Videoeingang mit einer kanonischen Video-URL. Öffentliche Webseiten werden auf Video-Metadaten, Video-Tags und YouTube-Einbettungen geprüft. Login, private Konten, Bilderfolgen, DRM, HLS-Playlists und reine JavaScript-Player sind hier nicht erschlossen.

Gemini unterstützt öffentliche YouTube-Videos als Videoeingabe; diese Funktion wird vom Anbieter als Vorschau beschrieben. Videoauswertung verarbeitet Bild und Ton, kann aber durch Bildabtastung kurze Ereignisse übersehen. IVA behauptet deshalb keine vollständige Abdeckung. [Offizielle Video-Dokumentation](https://ai.google.dev/gemini-api/docs/video-understanding)

`coverage.caption` bedeutet nur abgerufener Beitragstext. `transcript`, `visual` und `audio` werden erst bei tatsächlich an Gemini übergebenem Video und gültigen Beobachtungen mit Zeitmarken gesetzt. Kanal-Booleans aus einer Modellantwort genügen nicht. Ein Beitragstext wird niemals als Videotranskript an Gemini gesendet oder ausgegeben. `status` ist `analyzed`, `metadata_only` oder `unavailable`; Providerfehler führen zu ehrlichen Teilresultaten mit `gaps`.

`evidence` enthält Herkunft, Abrufzeit und gegebenenfalls Sekundenmarken. `claims` verweist auf passende Beobachtungs-IDs und bleibt ausdrücklich eine Aussage der Quelle, keine unabhängige Faktenprüfung. Zeitmarken sind Modellbeobachtungen; `coverageDetails.complete` bleibt `false`. Ein gesprochenes Claim benötigt ein Transkriptsegment; Musik allein genügt nicht. Inhalte der Quellen sind untrusted data und dürfen keine Agenten-Anweisungen ersetzen.

## Konfiguration und Schnittstellen

- `APIFY_TOKEN`: serverseitiger Bearer-Token, ausschließlich an `api.apify.com`.
- `GEMINI_API_KEY` oder `GOOGLE_API_KEY`: serverseitiger Header, ausschließlich an `generativelanguage.googleapis.com`.
- `IVA_MEDIA_GEMINI_MODEL`: optional, Standard `gemini-3.6-flash` entsprechend dem vorhandenen IVA-Modell. Modell muss Video unterstützen und für den verwendeten Schlüssel verfügbar sein.
- `options.signal`, `timeoutMs`: Abbruch und Gesamtlaufzeit; Standard 180 Sekunden, maximal 300 Sekunden.
- `fetchImpl`, `lookupImpl`, `requestImpl`, `checkBudgetImpl`, `recordUsageImpl`, `now`: Dependency Injection für Tests. Produktionsstandard verwendet vorhandene Budgetprüfung und Nutzungsverbuchung des Routers.

Die Rückgabe enthält `url`, `finalUrl`, `platform`, `title`, `caption`, `text`, `transcript`, `transcriptSegments`, `visualObservations`, `audioObservations`, `claims`, `metrics`, `coverage`, `coverageDetails`, `evidence`, `warnings`, `gaps`, `provider`, `fetchedAt` und `status`. Nicht verfügbare Kennzahlen sind `null`. Eine heruntergeladene Videodatei wird durch Größe, MIME-Typ und SHA-256 beschrieben. API-Schlüssel und signierte Downloadadressen erscheinen nicht im Ergebnis.

`readSocialFeed({platform:'tiktok', accounts:[], keywords:[], limit:12}, options)` liefert `{posts, provider, fetchedAt, coverage, warnings}`. Jeder Post enthält `url`, `caption`, `account`, `timestamp`, `views`, `likes`, `comments`, `platform`. Der Feed verwendet Profile, Hashtags (`#begriff`) oder Suchbegriffe; er lädt keine Videos herunter und analysiert keinen Ton oder Bildinhalt. Ausgewählte Clips können danach separat über `readMediaEvidence` ausgewertet werden. Pro Aufruf sind höchstens 10 Accounts, 10 Begriffe und 50 Ergebnisse möglich; es gibt kein neues Tageslimit.

Die verwendeten Actor-Eingaben sind `directUrls/resultsType/posts/resultsLimit` bei Instagram sowie `postURLs`, `profiles`, `hashtags`, `searchQueries`, `profileSorting`, `resultsPerPage` und Download-Optionen bei TikTok. Videodownloads können bei Apify zusätzliche Kosten erzeugen. [Instagram-Input](https://apify.com/apify/instagram-scraper/input-schema), [TikTok-Input](https://apify.com/clockworks/tiktok-scraper/input-schema)

## Grenzen und sichere Übertragung

Öffentliche Downloads akzeptieren nur HTTPS auf Port 443 ohne Benutzername/Passwort. DNS wird pro Abruf und Weiterleitung geprüft; interne, reservierte und gemischt öffentliche/private Adressantworten werden gesperrt. Die Verbindung wird an eine geprüfte IP gebunden. Keine Cookies oder Provider-Header werden an Quellen weitergereicht. Höchstens drei Weiterleitungen, 64 MiB Videodatei, 2 MiB verarbeitete HTML-/JSON-Antwort und feste Teilzeitlimits begrenzen einen Aufruf. Dateisignaturen müssen zu einem unterstützten Videocontainer passen.

Bis 12 MiB werden Videobytes inline übergeben. Größere Dateien verwenden einen resumierbaren Gemini-Upload, werden erst nach Status `ACTIVE` ausgewertet und anschließend gelöscht. Scheitert das Entfernen, erscheint eine Warnung; es wird kein erfolgreicher Cleanup behauptet. Uploadziele und Dateiverweise müssen beim festen Google-Anbieter bleiben. [Files-API](https://ai.google.dev/api/files), [GenerateContent-API](https://ai.google.dev/api/generate-content)

Die Gemini-URL-Context-Funktion wird hier nicht als Ersatz für eine Videoanalyse verwendet; sie unterstützt keine Audio-/Videodateien bzw. YouTube-Videos. [URL-Context-Grenzen](https://ai.google.dev/gemini-api/docs/url-context)

## Prüfung

`node --test scripts/verify-media-evidence.mjs` führt 24 lokale Tests mit injizierten Provider-, DNS- und HTTPS-Fixtures aus. Enthalten sind echte übergebene Fixture-Bytes, Quellenabgrenzung, Zeitmarken, Credentials, private Netzwerke, Weiterleitungen, Größenlimits, Timeout, YouTube-Eingabe und Files-Upload samt Löschung. Diese Tests belegen die lokale Integration; Verfügbarkeit, Actor-Abrechnung und reale Videoqualität müssen mit den verbundenen Konten separat geprüft werden. Für diese Implementierung wurden keine Liveprovider aufgerufen.

Vor der Medienanalyse zählt Gemini die tatsächlichen Eingabetokens. IVA reserviert diese Eingabe und maximal 12.000 Ausgabetokens anhand der hinterlegten EUR-Schätzpreise; die tatsächliche Providerrechnung kann abweichen. Fehlt die Zählung oder ein expliziter Modellpreis, bleibt die Quelle gegebenenfalls nur als Caption auswertbar.
