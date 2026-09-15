# Kundenbetreuung – UI-Vertrag

Die bestehenden Kunden-/Projektseiten laden `/customer-care.css` und `/customer-care.js` und rufen `IVACustomerCare.mount(element, {projectId, workspaceId?, customerId?, customerName?, api, onNotice?})` auf. Der Rückgabewert bietet `refresh()` und `destroy()`. `api(path, fetchOptions)` ist der vorhandene angemeldete Fetch-Wrapper; der Modulcode serialisiert JSON-Schreibkörper selbst. Nur diese neue Komponente wird durch `destroy()` entfernt.

Alle Anfragen verwenden `/api/customer-care` und tragen die Projekt-/Kundenkennung in der Query. Die gewählte Monatsübersicht ergänzt `month=YYYY-MM`. `getDashboard()` liefert Einstellungen, `customer.care`, Verträge, Kampagnen, Monatsbuckets, Benachrichtigungen, letzte Ausgänge und Verbindungsstatus. Die UI flacht nur den gewählten Monatsbucket ab. Ein Rechnerobjekt mit `modules` wird unterstützt: `works` = grün, `conditional` = gelb, `unavailable` = rot. Unbekannte Zustände erscheinen nie grün.

Projektregeln, individuelle Kontaktfreigabe und nullable Kunden-Overrides werden per PATCH gespeichert. Themen nutzen stabile IDs (`pv`, `heat-pump`, `insurance`, `energy`, `finance`, weitere normalisierte IDs). Kundenspezifische Kampagnen bleiben auf diese Kundenakte begrenzt. Projektkampagnen richten sich nach Thema und Kontaktfreigabe. Kampagnen und Verträge erhalten je Formular eine stabile `idempotencyKey`; ein unsicherer Netzwerkfehler erzeugt beim erneuten Speichern keine neue Kennung. Das Backend muss dieselbe Kennung ebenfalls abgleichen. Die gespeicherte Versandart ist `auto`.

POST `/landing` liefert einen Studiolink, der nur auf der aktuellen Origin unter `/website-studio` geöffnet werden kann. Die UI bezeichnet den erzeugten Stand als Entwurf. Eine öffentliche Landingpage ist optional als `settings.landingUrl` hinterlegt. Buchungslinks müssen HTTPS ohne Zugangsdaten verwenden.

## Öffentlicher Check-up

`/checkup/:token` liefert `public/customer-checkup.html`; CSS und JS müssen ohne Cockpit-Anmeldung verfügbar sein. GET/POST laufen ausschließlich über `/public/customer-care/:token`, ohne Cookies, ohne Cache, ohne Referrer. Das Token ist eine zufällige Capability, keine Kundenkennung. Die Seite nutzt weder Analyseanbieter noch externe Fonts noch lokalen Antwortspeicher.

GET liefert `status`, `project:{name,accentColor}`, `kind`, `intro`, und 3–5 Fragen mit `id`, `label`, `type: single|multi|text`, `options`, `required`. Fragekennungen und Optionen werden zusätzlich im Browser validiert; die verbindliche Prüfung bleibt serverseitig. POST übermittelt `{answers,interest,bookingRequested,idempotencyKey}`. Die Seite zeigt Erfolg erst nach `status:submitted`; bei Verbindungsfehlern bleibt dieselbe Kennung erhalten. Ein Buchungslink in der bestätigten Antwort bietet lediglich die Terminwahl an. Er behauptet keine bereits erfolgte Buchung.

Ein kleiner Abmeldelink sendet `{unsubscribe:true,idempotencyKey}` mit eigener stabiler Kennung. Bestätigt wird nur `status:unsubscribed` oder `unsubscribed:true`. Der Link bleibt auch nach abgeschlossener Antwort erreichbar. Bereits beantwortete Tokens können GET `status:submitted` liefern. 404 wird ungültig, 410 abgelaufen; `code:revoked` ermöglicht einen gesonderten Widerrufstext.

## Prüfung

`node scripts/verify-customer-care-ui.mjs` prüft Fragegrenzen, doppelte Kennungen, unbekannte/mehrfach gewählte Optionen, Pflichtangaben, unsichere Buchungslinks, Ampelzustände und ausgewählte Monatsbuckets.

Zusätzlich wurde die Oberfläche isoliert mit synthetischen Daten in Headless Chrome bei 390 px und 1240 px geprüft: kein horizontaler Überlauf, Pflichtfehler, vollständiges Ausfüllen, einmaliger Verbindungsfehler und Wiederholung mit identischer Kennung, bestätigtes Absenden, echter Buchungslink als Auswahl, anschließende Abmeldung, Kampagnenzeitplan und Kundenthemen. Es wurden keine echten Nachrichten verschickt oder Kunden verändert.

## Originalangebote und Kundenantworten

`dashboard.documents` enthält ausschließlich die in dieser Akte vorhandenen PDFs als `{id,name}`. In der Kundenansicht kann eine manuell geprüfte Originalofferte zu einem bestehenden Vertrag hinterlegt werden. POST `/quotes` erhält `{contractId,sourceDocumentId,provider,monthlyCost,expiresAt,summary,conditions,reviewConfirmed:true}`; `expiresAt` wird von der örtlichen Datum-/Uhrzeitauswahl in ISO umgerechnet. Eine Bestätigung ohne zukünftige Gültigkeit und aktiv gesetzte Preis-/Leistungsprüfung wird nicht abgeschickt. Der Server prüft Zuordnung und Dateiinhalt. `dashboard.quotes` erscheint unter Verträgen; abgelaufene Offerten werden nicht als aktuell grün dargestellt. Die öffentliche Seite kennzeichnet `offer.sourceType:'verified-document'` als „Manuell geprüftes Originalangebot“ und zeigt Bedingungen aufklappbar.

`dashboard.responses` wird unter „Kundenantworten“ aufklappbar angezeigt. Erwartet werden `{id,customerId,workspaceId,customerName,submittedAt,questions,answers,interest,bookingRequested}` ohne geheimes Token. Optionswerte werden über die ursprünglichen Fragen in verständliche Texte aufgelöst. Freitext wird als Text dargestellt, niemals als HTML. Ein Terminwunsch wird auch hier nicht als gebuchter Termin bezeichnet.
