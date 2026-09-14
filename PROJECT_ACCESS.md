# Projektfreigaben und Kundenzugang

IVA trennt die Admin-Ansicht vom Kundenportal. Als Admin verwaltest du Projekte, freigegebene Module, Kundenrollen und Anbindungen. Kunden melden sich unter `/portal` mit einem eigenen Zugang an und arbeiten ausschließlich in ihren freigegebenen Projekten. Das Kundenportal stellt derzeit Website Studio bereit.

## Ein Projekt freigeben

1. Öffne das Projekt in der Admin-Ansicht und seine Zugriffsverwaltung.
2. Aktiviere das Website-Modul für dieses Projekt.
3. Aktiviere den Kundenzugang, lege die höchstens erlaubte Rolle und das tägliche Kontingent je Person fest und speichere die Einstellungen. Erstelle anschließend eine Einladung für die E-Mail-Adresse des Kunden.
4. Gib den erzeugten Einladungslink an den vorgesehenen Kunden weiter. IVA erstellt den Link; sie versendet keine Einladungs-E-Mail.
5. Der Kunde öffnet den Link, legt sein Passwort fest und nutzt anschließend `/portal`.

Ein Kunde kann mehrere Projekte erhalten. Die Projektauswahl zeigt ausschließlich seine aktuellen Freigaben. Eine Mitgliedschaft oder Modulfreigabe lässt sich in der Admin-Ansicht wieder entziehen. Bestehende Sitzungen erhalten dadurch keinen dauerhaften Zugriff: Der Server prüft die aktuelle Freigabe bei jeder geschützten Anfrage erneut.

## Rollen im Website Studio

| Rolle | Vorschau ansehen | Chat, Import und Änderungen | ZIP-Export | Veröffentlichen |
| --- | --- | --- | --- | --- |
| Viewer | Ja | Nein | Nein | Nein |
| Editor | Ja | Ja | Ja | Nein |
| Publisher | Ja | Ja | Ja | Ja |

GitHub-Verbindungen, private Repository-Imports über die Admin-Anbindung und Domainverwaltung bleiben in der Admin-Ansicht. Ein Kunde kann diese Rechte auch durch einen Chat-Auftrag nicht umgehen. Öffentliche Website-Imports und ZIP-Quelldateien stehen Editoren und Publishern zur Verfügung.

Website-Änderungen werden zunächst als neue Entwurfsrevision gespeichert und geprüft. Nur eine gesonderte Veröffentlichung macht einen Entwurf öffentlich. Frühere Revisionen bleiben erhalten.

## Kontingent und laufende Aufträge

Ein modellgestützter Chat-Auftrag verbraucht das vorgesehene tägliche Kontingent einmal, auch wenn der Server die Berechtigung während des Auftrags mehrfach prüft oder einen fehlerhaften Build repariert. Informationsfragen von Editoren und Publishern nutzen ebenfalls ein Modell und zählen zum Kontingent. Ein bereits vor dem Modellaufruf verweigerter GitHub- oder Veröffentlichungsauftrag verbraucht kein Modellkontingent.

Der Server prüft Rechte auch während längerer Vorgänge erneut: vor einem Modellaufruf, vor dem Speichern eines Ergebnisses und unmittelbar vor Veröffentlichung oder GitHub-Zugriff. Wird die Berechtigung während einer Generierung oder eines Downloads entzogen, darf das spät eintreffende Ergebnis keine neue Entwurfsrevision speichern. Wird eine Veröffentlichung während der Prüfung am Hosting-Ziel widerrufen, wird die bisherige veröffentlichte Version wiederhergestellt.

## Zugang und Betrieb

Kundensitzungen verwenden ein `HttpOnly`-Cookie mit `SameSite=Strict`; unter HTTPS trägt es zusätzlich `Secure`. Der Sitzungstoken wird nicht im Login-JSON oder im Browser-Local-Storage bereitgestellt. Schreibanfragen müssen von der eigenen IVA-Adresse stammen. Der Admin-Bearer-Token gilt nicht als Kundensitzung und wird nicht an Kunden weitergegeben.

Die Vorschau bleibt in einem isolierten Iframe. Veröffentlichte Websites laufen auf dem separaten Website-Host. Importierte Projekte führen keine eigenen Installationsskripte oder Build-Konfigurationen auf dem IVA-Server aus; die unterstützten Quelldateien werden durch den kontrollierten Website-Compiler verarbeitet.

Die Kundenfreigaben ermöglichen manuell verwaltete Kundenprojekte. Vertragsverwaltung, Rechnungsstellung und automatischer Zahlungseinzug sind eigenständige Geschäftsprozesse und werden von diesem Zugangsmodul nicht ausgeführt.

## Prüfung

`scripts/verify-project-access-service.mjs` prüft die Berechtigungen bei laufenden Website-Aufträgen. `scripts/verify-project-portal-http.mjs` prüft die Express-Routen über eine lokale HTTP-Verbindung mit dem tatsächlichen Website-Service: Sitzungscookies, Herkunftsprüfung, Projektgrenzen, Rollen, Kontingente und Berechtigungsentzug während Import oder Veröffentlichung.
