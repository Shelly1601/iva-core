# IVA Website Studio

`/website-studio` bietet einen projektgebundenen Website-Chat mit isolierter Desktop-, Tablet- und Mobilvorschau. Das Cockpit und jede Projektakte enthalten einen Einstieg. IVA kann die vier registrierten Website-Werkzeuge auch aus dem normalen Chat verwenden; Fachagenten erhalten den jeweils gebundenen Projektkontext.

## Bedienung

- Neue Website: Projekt wählen, Website anlegen und die gewünschte Gestaltung beschreiben.
- Eigene bestehende Website: GitHub-Repository oder ZIP-Quelldateien importieren. Eine öffentliche URL erstellt lediglich einen Snapshot der öffentlich abrufbaren Dateien.
- Referenz: „Gestalte etwas Ähnliches für … https://…“. Die Referenz wird gelesen; der Generator soll daraus ein eigenständiges Design entwickeln.
- Änderungen und 3D: Auftrag im Chat beschreiben, optional Modell wählen. „IVA wählt“ versucht eingerichtete Modelle und nennt das tatsächlich verwendete Modell. Ein Provider-Ausfall ist sichtbar. Ein Auftrag hat höchstens sechs Minuten Zeit und maximal einen Compiler-Reparaturversuch.
- GitHub: Zugang einmal unter Anbindungen verbinden. Er wird bei GitHub geprüft und mit dem bestehenden IVA-Verbindungsschlüssel verschlüsselt gespeichert. „Pack die Website bei GitHub rüber“ erstellt ein privates Repository im verbundenen persönlichen Konto. Folgeexporte aktualisieren ausschließlich die dieser Website zugeordnete Sicherung ohne Force-Push. Ein fremdes importiertes Repository wird dadurch nicht überschrieben.
- Veröffentlichung: geprüfte Version über den separaten Website-Host ausliefern. Erfolg wird durch die tatsächlich ausgelieferte Revisionskennung geprüft; bei Fehler bleibt der vorherige Veröffentlichungsstand erhalten. Änderungen am Entwurf verändern veröffentlichte Versionen nicht.
- Domain: gewünschte Domain vormerken. Domainzuordnung, TLS und DNS müssen beim Hosting eingerichtet und verifiziert werden. Das Vormerken oder ein passender CNAME allein wird nicht als erfolgreiche Umstellung angezeigt. Es findet kein automatischer Registrartransfer statt.

## Unterstützte Websites und Umzug

Direkt unterstützt: statisches HTML/CSS/JavaScript und React/Vite mit browserfähigen Abhängigkeiten. Der Compiler arbeitet aus geprüften Quelldateien im Speicher, führt keine importierten npm-Skripte oder Vite-/Tailwind-Konfigurationen aus und kann nicht über seine Modulauflösung auf lokale Hostdateien zugreifen. Tailwind wird mit einer festen IVA-Konfiguration verarbeitet; spezielle Projektplugins und zusätzliche Theme-Anpassungen brauchen einen gezielten Abgleich. Browser-Pakete werden in festgelegten Versionen über esm.sh geladen; diese Abhängigkeit ist in der Vorschau ausgewiesen.

Eine Lovable-URL enthält weder den ursprünglichen React-Quellcode noch vollständige Backenddaten. Für einen vollständigen Umzug werden der Export und gegebenenfalls Supabase-Daten, Storage, Authentifizierung, Funktionen und projektspezifische Umgebungsvariablen getrennt benötigt. Der Website-Host bietet keine eigene Datenbank-, Login- oder Formular-API. Server-Rendering etwa mit Next.js, Nuxt oder Astro benötigt einen zusätzlichen isolierten Framework-Worker und wird derzeit mit einem konkreten Fehler abgelehnt.

ZIP/Quellcode: maximal 500 Dateien, 3 MiB je Datei, insgesamt 20 MiB. Zugangsdaten, Schlüsseldateien, Traversal, Symlinks und beschädigte Archive werden zurückgewiesen. Versionen sind unveränderlich, gehasht und mit optimistischer Konfliktprüfung projektweise gespeichert. Der aufrufende Browser erhält für die Vorschau ausschließlich `sandbox="allow-scripts"` ohne gemeinsame Origin.

## Betrieb

- Core: bestehender IVA-Server mit persistentem DATA_DIR.
- GitHub: `GITHUB_TOKEN`/`GH_TOKEN` oder verschlüsselte Studio-Verbindung. `IVA_PROJECT_CONNECTIONS_KEY` wird für gespeicherte Verbindungen benötigt. Ein konfigurierter Schlüssel bedeutet noch keine pauschale Berechtigung für jedes Repository.
- Veröffentlichung: eigener Dienst aus `website-host/`, `IVA_WEBSITE_HOST_ORIGIN` im Core und ein dedizierter `IVA_WEBSITE_PUBLISH_KEY` auf beiden Diensten. Niemals IVA-API-, Modell- oder Kontozugänge an den Host weitergeben.
- Der interne Abruf `/_website-published` liefert mit diesem separaten Schlüssel ausschließlich bereits veröffentlichte Artefakte. Die normalen Studio-API-Routen benötigen die bestehende IVA-Authentifizierung.
- Abgebrochene Serverjobs werden als fehlgeschlagen sichtbar. Ein GitHub-Export mit unklarem Endzustand wird vor einer Wiederholung angehalten, um doppelte Repositories zu vermeiden.

Prüfung: `npm run test:websites`, `node scripts/verify-website-host.mjs`. Browser- und reale Modelltests zusätzlich vor der Bereitstellung. Tests benötigen keine echten GitHub-Schreibzugänge.

Offizielle Grundlagen: [Lovable GitHub-Export](https://docs.lovable.dev/integrations/github), [Lovable Hosting und Eigentum](https://docs.lovable.dev/tips-tricks/deployment-hosting-ownership), [externer Lovable-Umzug](https://docs.lovable.dev/tips-tricks/external-deployment-hosting), [esbuild Plugin-API](https://esbuild.github.io/plugins/), [Railway Domains](https://docs.railway.com/cli/domain).
