# WhatsApp je Projekt und Nummer

Die Nummernprofile werden ausdrücklich einem bestehenden, für WhatsApp freigeschalteten Projekt und einer Aufgabe zugeordnet: Terminierung, Schadenaufnahme oder Kundenservice. Die Meta Phone Number ID ist die eingehende Routingkennung, nicht eine vom Absender auswählbare Projekt-ID. Pro Nummer ist genau ein aktives Profil erlaubt. Bereits belegte Nummern-/Projektbindungen werden nicht umgehängt; bestehende Verläufe behalten ihre Zuordnung. Alte Profile ohne Projekt bleiben deaktiviert.

## Laufzeit und HTTP-Vertrag

`createWhatsAppEngine({dataDir,getProject,getCustomers})` benötigt eine frische Projekt-/Modulprüfung und einen autoritativen, projektgebundenen Kundenleser. `createWhatsAppCustomers({listWorkspaces,listProjects})` verwendet lokale Kundenakten und deren explizite Projektzuordnung. Rufnummern werden vollständig normalisiert verglichen, niemals anhand eines gemeinsamen Suffixes. Mehrdeutige Treffer geben keine Akteninformationen aus. Akten werden im Gespräch nicht automatisch geändert.

Der öffentliche Meta-Webhook ist ausschließlich `GET/POST /webhooks/whatsapp`. GET verlangt das separate Verify-Token; POST verlangt die HMAC-Signatur über den unveränderten Body. Erst `await engine.enqueueVerified({...message,verified:true})` und das persistente `acceptStatuses(...,{verified:true})`, dann HTTP 200. Fehler vor dieser Speicherung erhalten kein Erfolgs-ACK. `verified:true` ist nur eine interne Bestätigung des Signaturhandlers und darf nicht aus einer öffentlichen Request-Nutzlast übernommen werden.

`engine.tick()` verarbeitet die dauerhaft gespeicherte Inbox. Der Server ruft ihn nach dem ACK und regelmäßig auf; es gibt keine nur im RAM gehaltene Warteschlange. Nachrichten-IDs, Verarbeitungsleases, Antworten, Versandversuche und Buchungsversuche liegen in `DATA_DIR/whatsapp-automation.json` mit atomarem Ersatz, Modus 0600 und prozessübergreifendem Lock. Ein inhaltlich ungeklärter Vorgang wird nicht als erfolgreich zugestellt oder gebucht angezeigt. Nach drei erfolglosen internen Verarbeitungsversuchen bleibt eine persönliche Prüfaufgabe erhalten. Die Ablage begrenzt sich auf 30 MiB / 50.000 Inbound-IDs und bricht bei voller oder beschädigter Ablage vor dem ACK ab; Dedup-Belege werden nicht still gelöscht.

Neue Owner-Routen werden mit `registerWhatsAppAutomationRoutes(app,{engine,listProjects})` **hinter** dem Owner-API-Guard registriert:

- `GET /api/whatsapp/automation/config`: Profile, Projekte, getrennte Zugangs- und Evidenzstände.
- `POST /profiles`, `PATCH|DELETE /profiles/:id`: Zuordnung/Regeln konfigurieren.
- `POST /profiles/:id/verify`: ausschließlich lesende Meta-Nummern-/Calendly-Verfügbarkeitsprüfung.
- `GET /calendly-events`: tatsächliche Ereignistypen des verbundenen Calendly-Benutzers.
- `GET /conversations?projectId=...`: nur Verläufe dieses Projekts, standardmäßig ohne Simulationen.
- `PATCH /conversations/:id/handoff`: `projectId`, `status`, optional `owner`/`note`.
- `POST /simulate`: `profileId`, `sender`, `message`, optionale eindeutige `messageId`; getrennte Simulationsverläufe, niemals Versand oder Buchungs-POST.

## Gespräch und Buchungsbeleg

Der Dialog verwendet die gespeicherte Aufgabe, kontrollierte Gesprächszustände, belegte FAQ-Antworten sowie persönliche Übergaben. Eine freie interne Zielnotiz ist kein ausführbarer Prompt und keine autonome Rechts-/Produktberatung. Die konfigurierte Begrüßung erscheint beim ersten Kontakt. Fachliche Deckungs-, Anlage- und Rechtsfragen gehen an die Beratung. Schadenangaben sind Kundenaussagen; IVA behauptet damit weder Versicherungsschutz noch die Einreichung bei einem Versicherer. Anhänge werden mit ihrer Provider-ID vorgemerkt, aber nicht als transkribiert oder visuell analysiert ausgegeben. Persönliche Übergaben sind im Projektverlauf sichtbar; eine zusätzliche Berater-E-Mail wird nicht ungefragt verschickt.

Vor einer Terminbuchung benötigt IVA einen Namen, die vom Kunden ausdrücklich vollständig genannte E-Mail-Adresse, eine aktuell von Calendly gelieferte Zeit und eine ausdrückliche Bestätigung der zusammengefassten Buchung. Ein einfaches Ja bestätigt keine aus einer Kundenakte übernommene E-Mail-Adresse. Ein gewechselter Ereignistyp während der Abstimmung verlangt neue Bestätigung.

Der Connector liest Ereignistyp und Verfügbarkeit frisch, persistiert den Buchungsversuch und führt maximal einen `POST /invitees` aus. Die Antwort alleine ist noch kein Buchungsbeleg: Ereignis und Invitee werden separat zurückgelesen und nach Aktivstatus, Ereignistyp, Zeit, E-Mail und eigener Trackingkennung abgeglichen. Bei unklarem POST-Ausgang wird ausschließlich nach diesem Termin gesucht/zurückgelesen, nie blind erneut gebucht. Hintergrundprüfungen haben einen ansteigenden Abstand von 1 bis 10 Minuten. Ungeklärte bestehende Buchungen lassen sich nicht durch einen Wechsel in den Beratungsdialog erneut auslösen.

Pflicht-Zusatzfragen, kostenpflichtige Ereignisse und nicht eindeutig vorbereitbare Orte werden offen zur persönlichen Abstimmung bzw. zum Buchungslink übergeben. Der Kalenderabruf umfasst standardmäßig sieben Tage und zeigt bis zu drei echte freie Zeiten. Kalenderänderungen, Absagen und beliebige Freitext-Zeitplanung sind keine behaupteten Fähigkeiten dieses Dialogs.

## Zustellung, Einrichtung und echte Grenzen

Erforderlich sind `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` und eine explizit gepflegte `WHATSAPP_GRAPH_VERSION`; die jeweilige Phone Number ID kommt aus dem Profil. `WHATSAPP_PHONE_NUMBER_ID` bleibt für ältere globale Status-/Aufrufschnittstellen vorhanden. Für Calendly wird `CALENDLY_TOKEN` verwendet. Zugangsdaten stehen ausschließlich in der Laufzeitumgebung.

Ein Token oder erfolgreicher lesender API-Aufruf wird nicht als erfolgreicher Versand oder erfolgreiche Buchung ausgegeben. `status.evidence` meldet getrennte **historische** Ereignisbelege und bescheinigt keine derzeitige durchgängige Konnektivität. Der vorhandene WhatsApp Hub bleibt lesend, solange dessen signierter Inbound-/Sendekanal nicht belegt ist.

Freie WhatsApp-Antworten werden ausschließlich innerhalb von 24 Stunden nach dem belegten Kundeneingang versandt. Außerhalb davon gibt es keinen erfundenen Template-Fallback. Jeder Versandversuch wird vorher gespeichert. Meta-Akzeptanz ist noch keine Zustellung; erst passende signierte Statusreceipts liefern `sent`, `delivered`, `read` oder `failed`. Früher eintreffende Receipts werden dauerhaft aufbewahrt und später zugeordnet. Geht eine POST-Antwort ohne Message-ID verloren, bleibt dieser Versand ehrlich ungeklärt und wird nicht automatisch wiederholt.

Die Tests verwenden synthetische Kunden, HTTP-Fixtures und temporäre Ordner. Es wurden weder echte Nachrichten verschickt noch echte Termine gebucht. Einrichtung und Verifikation der tatsächlich gewünschten Nummern/Ereignisse bleiben separate, sichtbare Schritte.

Am 16.09.2026 um 01:26 Uhr Europe/Berlin wurde der vorhandene Calendly-Zugang ausschließlich lesend geprüft: Benutzer- und Ereignisabruf lieferten jeweils HTTP 200 und insgesamt 18 Ereignistypen ohne abgeschnittene Liste. Der Zugriff auf die Ereignisliste ist damit tatsächlich belegt; Schreibberechtigung, Zustellung und Buchung wurden dabei nicht getestet. Der Token blieb im Arbeitsspeicher, der Prüfbeleg enthält nur Statuscodes und Anzahl.

## Offizielle API-Grundlagen

Stand der Prüfung: 16.09.2026. Calendlys [Invitee-Erstellung](https://developer.calendly.com/api-docs/calendly-api/scheduled-events/create-event-invitee) beschreibt direkte Buchungen, erforderliche Felder und bezahlte Tarife mit Schreibberechtigung. Die [Verfügbarkeits-API](https://developer.calendly.com/api-docs/calendly-api/event-types/list-event-type-available-times) liefert tatsächliche Slots; der [offizielle Scheduling-Leitfaden](https://developer.calendly.com/docs/api-guides/schedule-events-with-ai-agents) beschreibt Ereignisauswahl, Ort und Buchung. Die [Authentifizierungs-Scopes](https://developer.calendly.com/docs/authentication/scopes) müssen zum eingerichteten Token passen.

Metas [offizielle Statusobjekte](https://www.postman.com/meta/whatsapp-business-platform/folder/fuaee8l/statuses-object) unterscheiden Akzeptanz und Zustellung. Die [WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/) beschreibt das Kundenservicefenster und den erreichbaren Übergang zur persönlichen Bearbeitung.

Prüfung: `node scripts/verify-whatsapp-automation.mjs` und `node scripts/verify-whatsapp.mjs`.
