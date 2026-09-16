# Selbstrecherche in IVA

In der Wissensdatenbank öffnet **Selbstrecherche** den Kriterienfilter. Thema und Wissenskategorie genügen; der Titel des Ergebnisses entsteht automatisch. Optional begrenzen Suchbegriffe, Ausschlüsse, Domains, Region, gewünschte Schwerpunkte und maximal drei, fünf oder acht Quellen die Recherche. Domainfilter erlauben auch Unterdomains. Ergebnisse müssen mindestens eines der angegebenen Suchwörter enthalten; Ausschlussbegriffe werden zusätzlich im gelesenen Text geprüft. Region und Auftrag steuern Suche und Auswertung, sind keine garantierte geografische Klassifikation.

Einmalige Aufträge starten nach dem Speichern. Wiederholungen laufen täglich, wöchentlich oder monatlich zur gewählten Zeit in Europe/Berlin, erstmals zum nächsten Termin. Der Server übernimmt die Ausführung auch bei geschlossenem Browser. **Jetzt starten** führt einen gespeicherten aktiven Auftrag zusätzlich aus. **Pausieren** unterbindet weitere Läufe; laufende Ergebnisse werden nach einer Pause oder Kriterienänderung nicht nachträglich veröffentlicht. Bearbeiten startet einen einmaligen Auftrag nicht erneut. Im Frühjahr wird eine fehlende Uhrzeit auf den ersten gültigen Zeitpunkt verschoben, im Herbst wird die doppelte Stunde nur einmal verwendet. Nach Ausfällen entstehen keine Serien nachträglicher Läufe.

Recherche ist ein begrenzter Lesevorgang über die vorhandene Tavily-Suche und das konfigurierte Wissensmodell. Kandidaten werden als öffentliche HTTPS-Webseiten mit DNS-/Redirect-Prüfung tatsächlich gelesen. Such-Snippets allein erzeugen keinen Wissenseintrag. Anmeldungen, geschlossene Communities, Videos und nicht lesbare Quellen werden nicht als gelesen ausgegeben; dafür bleibt der bestehende Link-/Materialimport verfügbar. Die Oberfläche zeigt fehlende Anbindungen oder fehlgeschlagene Läufe mit einem aufklappbaren Bericht.

Die Auswertung speichert eigene Zusammenfassungen, kurze Belegstellen, Quelllinks und offene Punkte. Wiederholungen verwenden denselben Wissenseintrag und vermeiden eine erneute KI-Auswertung bei unveränderten Quellen. Ein gespeicherter, rückgelesener Eintrag steht IVAs bestehender Wissenssuche zur Verfügung. Das ist eine Ergänzung des Wissensspeichers, kein Training der zugrunde liegenden Modelle. Manuelle Änderungen am Wissensinhalt werden vor automatischem Überschreiben geschützt.

API unter bestehender IVA-Authentifizierung:

- GET /api/knowledge/research – Aufträge und Anbindungen
- POST /api/knowledge/research – Auftrag speichern; requestId schützt Wiederholungen derselben Anfrage
- PATCH /api/knowledge/research/:id – Kriterien, Zeitplan oder enabled ändern
- POST /api/knowledge/research/:id/run – zusätzlichen Lauf einreihen

Die Rechercheablage liegt persistent unter DATA_DIR. Der Server prüft Zeitpläne beim Start und einmal pro Minute. Keine separate Codex-Automation oder Geräteanmeldung ist nötig. Tests verwenden ausschließlich isolierte Recherche- und Wissensablagen. Für den Funktionsbau wird kein echter regelmäßiger Rechercheauftrag vorausgewählt.
