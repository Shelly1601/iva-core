# IVA Website Host

Separater öffentlicher Dienst für veröffentlichte IVA-Websites. Er benötigt nur Node.js 24 und keine npm-Abhängigkeiten. Website-JavaScript läuft auf dieser Origin und erhält keinen Zugriff auf IVA-Cockpit-Zugänge.

## Railway-Einrichtung

1. Eigenen Railway-Service erstellen; Build-Kontext ist ausschließlich dieses Verzeichnis. Dockerfile verwenden, keine IVA-Core-Umgebungsvariablen übernehmen.
2. Öffentliche Railway-Domain erzeugen. `RAILWAY_PUBLIC_DOMAIN` muss genau diese Domain enthalten.
3. `IVA_CORE_ORIGIN` auf die HTTPS-Origin des bestehenden IVA-Core setzen, z. B. `https://iva-core-production.up.railway.app`.
4. Einen zufälligen, dedizierten `IVA_WEBSITE_PUBLISH_KEY` mit mindestens 32 Zeichen auf Host und Core hinterlegen. Er berechtigt ausschließlich zum Abruf bereits veröffentlichter Artefakte. API-, Modell-, GitHub- und Datenbankzugänge gehören nicht in diesen Service.
5. Startbefehl `npm start`, Port aus `PORT` (Standard `8080`), Healthcheck `/health`.

Keine Schlüssel als Build-Argument, in Dateien oder im Docker-Image speichern. Der Container läuft als Benutzer `node`.

## Veröffentlichung und Domains

Auf der Railway-Adresse werden Websites unter `/s/<siteId>/` bereitgestellt. Unterseiten erhalten dasselbe HTML als SPA-Fallback. Diese Service-Adressen senden `X-Robots-Tag: noindex, nofollow`.

Eine eigene Domain muss am Hosting-Service und in IVA eingerichtet werden. Der tatsächliche `Host`-Header wird normalisiert und als `hostname` an den Core übergeben. `X-Forwarded-Host` wird nicht ausgewertet. Nur der Core entscheidet, welcher veröffentlichte Stand dieser Domain zugeordnet ist. Eigene Domains erhalten keinen zusätzlichen Noindex-Header.

Der Core stellt `GET /_website-published?siteId=…` beziehungsweise `?hostname=…` bereit. Der Host authentifiziert sich mit dem dedizierten Schlüssel. Die Antwort enthält `{ html, revisionId, siteId, artifactHash }`; private Projektmetadaten werden nicht übertragen. `artifactHash` ist ein SHA-256-Wert aus 64 Hexzeichen. Das HTML muss vollständig kompiliert sein und seine Content Security Policy bereits enthalten. Lokale Assets müssen beim Kompilieren eingebettet werden: Der Host liefert keine privaten Quellcodedateien oder IVA-Routen aus.

Der Host folgt keinen Weiterleitungen. Abrufe enden nach spätestens 15 Sekunden. HTML ist auf 20 MiB beschränkt; die umgebende JSON-Antwort auf 40 MiB. Ihr `artifactHash` muss dem tatsächlich berechneten SHA-256-Wert des HTML entsprechen. Maximal vier Abrufe laufen gleichzeitig. Der Cache hält höchstens 100 Artefakte beziehungsweise 50 MiB für maximal 30 Sekunden. Änderungen und zurückgezogene Veröffentlichungen werden daher spätestens nach diesem Zeitraum sichtbar. Browser müssen ETags erneut prüfen. Fehlerantworten werden nicht zwischengespeichert und enthalten keine Core-Fehlerdetails.

Zur Veröffentlichungsprüfung kann IVA `?iva-version=<revisionUuid>` an eine öffentliche GET-Adresse anhängen. Stimmen UUID und Cache-Version überein, bleibt der Cache gültig; andernfalls wird der aktuelle veröffentlichte Stand neu abgerufen. Andere Werte und HEAD-Anfragen umgehen den Cache nicht. `X-IVA-Revision` liefert die tatsächlich ausgelieferte Revision. Der Queryparameter wählt niemals eine unveröffentlichte Version aus.

Nur `GET` und `HEAD` sind verfügbar. Kontaktlinks und im kompilierten HTML zugelassene externe Formular-Endpunkte können verwendet werden; dieser Host stellt keine Formular-, Login- oder Datenbank-API bereit.

## Prüfung

Vom IVA-Core-Verzeichnis: `node scripts/verify-website-host.mjs`. Die Prüfung verwendet injizierte HTTP-Antworten und benötigt weder Netzwerkzugang noch einen offenen Port.
