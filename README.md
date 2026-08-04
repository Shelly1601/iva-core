# IVA-Core

Backend („Gehirn") von IVA. Node.js + Express, deployt auf Railway. Bündelt Kalender, Mail, CRM-Leads, Qonekto/blau direkt, Todos, Calendly, Sprachnachrichten, Morning-Briefing — gesteuert über Telegram und eine kleine REST-API fürs Frontend. Das eigenständige Heat Hero CRM und der Heat-Hero-Bereich im Multi CRM sind bewusst getrennte Datenquellen.

Die dauerhafte Einrichtungs- und Variablenliste liegt in [`INTEGRATIONS_CHECKLIST.md`](./INTEGRATIONS_CHECKLIST.md). Echte Tokens und Passwörter gehören ausschließlich in Railway, niemals in diese Datei oder in den Chat.

## Lokal starten
1. `npm install`
2. `.env.example` zu `.env` kopieren und Werte eintragen
3. `npm start`

## Auf Railway
- Repo zu GitHub pushen, auf railway.app als Service deployen.
- Alle Variablen aus `.env.example` unter „Variables" setzen (echte Werte).
- Ein **Volume** mit Mount-Pfad `/data` anlegen (für `memory.json` = Todos/Notizen/chatId).
- Öffentliche Domain generieren → Telegram-Webhook setzt sich beim Start selbst.

## Wichtige Endpunkte
- `POST /telegram` – Telegram-Webhook (Bot-Kanal).
- `GET /` – Healthcheck („IVA laeuft.").
- `GET /health/qonekto` – sicherer Verbindungscheck ohne Kunden- oder Token-Daten.
- `GET /api/qonekto/status` und `/api/qonekto/tools` – geschützte Qonekto-Verbindungs- und Werkzeugschema-Diagnose, ohne Kundendaten.
- `GET/POST /api/*` – Frontend-API (Bearer `API_TOKEN`): leads, mails, calendar, calendly, todos (+toggle), chat.
- `GET/POST/PATCH /api/workspaces` – gemeinsame Fallakten für Beratung, Kunde und Energieplanung.
- `GET /api/workspaces/:id/tmb.pdf` – A4-TMB aus einer Energie-Fallakte mit Raum-/Heizkörpertabelle und zugeordnetem Fotoanhang.
- `POST /api/workspaces/:id/energy/calculate` – speichert Heizlast-Vorplanung und KfW-458-Fördervorcheck in der Energie-Fallakte.
- `GET/POST/PATCH /api/whatsapp/profiles` – getrennte Lead-, Service- und Hybridprofile; `/api/whatsapp/simulate` testet Antworten ohne Versand.
- `GET/POST /webhooks/whatsapp` – signierter Meta-Webhook für eingehende WhatsApp-Nachrichten.
- `GET /marketing` – Marketing-Zentrale für Marken, Marktanalysen, Firmenrecherche, Kampagnen, Content-/E-Mail-Pläne, Ads-Checks und Reports.
- `GET /api/marketing/status` – Connector-Bereitschaft ohne Ausgabe von Secrets; `/api/marketing/*` verwaltet Research, Unternehmen, Pläne, Ads-Snapshots und Reports.

## Lokale Prüfungen
- `npm run test:workspaces` – Fallakten, Dateien und Persistenz.
- `npm run test:tmb` – versioniertes TMB-Schema und visuell prüfbares Muster-PDF unter `output/pdf/IVA-TMB-Muster.pdf`.
- `npm run test:qonekto` – Qonekto-Konfiguration und serverseitigen Leseschutz prüfen (ohne echten Token).
- `npm run test:energy` – Heizlast-Rechenweg, Pflichtfelder und versionierte KfW-458-Regeln.
- `npm run test:whatsapp` – Webhook-HMAC, Nachrichtenerkennung und Sicherheits-Intents.
- `npm run test:marketing` – Marketing-Persistenz, öffentliche Kontakt-Schutzlogik, Ads-Auswertung, E-Mail-Sperre und Reporting.

## Qonekto / blau direkt
- Railway-Variable `QONEKTO_MCP_TOKEN` enthält den Qonekto-MCP-Token.
- Optionaler Endpoint: `QONEKTO_MCP_URL` (Default für Tenant `goalsandconcepts` ist in `.env.example`).
- IVA führt eindeutig lesende MCP-Werkzeuge direkt aus. Nicht-destruktive Änderungen werden nur vorbereitet und erst nach der separaten exakten Bestätigung „Ja, Qonekto-Änderung ausführen“ ausgeführt.
- Löschen, Stornieren, Versenden und andere destruktive oder unbekannte Werkzeuge bleiben blockiert, selbst wenn der hinterlegte Token mehr Rechte hat.

## WhatsApp
- Verwaltung unter `/whatsapp`; der Testchat funktioniert bereits ohne Meta-Verbindung.
- Live benötigt `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` und eine explizite `WHATSAPP_GRAPH_VERSION` in Railway.
- Vertragsstammdaten dürfen erklärt werden. Eine konkrete Deckungsentscheidung wird nur mit belastbarem Policen-/Bedingungsbeleg getroffen; fehlt er, erzwingt IVA die persönliche Prüfung.
- Schadenmeldungen werden als eigener Eingang erfasst, aber weder als gedeckt bestätigt noch automatisch beim Versicherer eingereicht.

## Energie-Rechenkern
- Die raumweise Heizlast-Vorplanung rechnet transparent mit Bauteilflächen, U-Werten, Lüftung, Wärmebrücken und Temperaturdifferenz.
- Sie ist bewusst als Vorplanung gekennzeichnet und ersetzt keine normgerechte Heizlast nach DIN EN 12831-1 zusammen mit DIN/TS 12831-1.
- Der Fördercheck speichert immer Regelstand, Rechenweg und offene Voraussetzungen. Die produktive Entscheidung erfolgt nach aktuellem KfW-Merkblatt und BzA.

## Marketing-Zentrale
- Verwaltung unter `/marketing`. Bestehende Brand-/Kampagnenmodule wurden erweitert, nicht ersetzt.
- Die Branchen-/Firmensuche nutzt Google Places (New), sobald `GOOGLE_PLACES_API_KEY` gesetzt ist. Öffentliche Websites/Impressen werden quellenbezogen ergänzt; recherchierte Kontakte bleiben bis zur Prüfung von Rechtsgrundlage oder Opt-in im Status `research-only`.
- Instagram-Referenzanalyse nutzt den vorhandenen Apify-Connector. LinkedIn- und Meta-Connectoren dienen für eigene Accounts; Konkurrenz-Ads werden über die öffentliche Meta Ad Library und verknüpfte Quellen geprüft.
- Content-Pläne speichern einen sichtbaren Quality Gate. Veröffentlichung, E-Mail-Versand und Ads-Änderungen bleiben ohne separate Freigabe gesperrt.
- `MARKETING_MORNING_REPORT_ENABLED=true` aktiviert den täglichen Telegram-Marketingreport um 07:10 Uhr.

## Befehle (Telegram)
`/briefing` `/leads` `/termine` `/calendly` `/mails` `/todos`

Details zum Gesamtprojekt: siehe `../CLAUDE.md`.
