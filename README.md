# IVA-Core

Backend („Gehirn") von IVA. Node.js + Express, deployt auf Railway. Bündelt Kalender, Mail, CRM-Leads, Qonekto/blau direkt, Todos, Calendly, Sprachnachrichten, Morning-Briefing — gesteuert über Telegram und eine kleine REST-API fürs Frontend. Das eigenständige Heat Hero CRM und der Heat-Hero-Bereich im Multi CRM sind bewusst getrennte Datenquellen.

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

## Lokale Prüfungen
- `npm run test:workspaces` – Fallakten, Dateien und Persistenz.
- `npm run test:tmb` – versioniertes TMB-Schema und visuell prüfbares Muster-PDF unter `output/pdf/IVA-TMB-Muster.pdf`.
- `npm run test:qonekto` – Qonekto-Konfiguration und serverseitigen Leseschutz prüfen (ohne echten Token).

## Qonekto / blau direkt
- Railway-Variable `QONEKTO_MCP_TOKEN` enthält den Qonekto-MCP-Token.
- Optionaler Endpoint: `QONEKTO_MCP_URL` (Default für Tenant `goalsandconcepts` ist in `.env.example`).
- IVA führt eindeutig lesende MCP-Werkzeuge direkt aus. Nicht-destruktive Änderungen werden nur vorbereitet und erst nach der separaten exakten Bestätigung „Ja, Qonekto-Änderung ausführen“ ausgeführt.
- Löschen, Stornieren, Versenden und andere destruktive oder unbekannte Werkzeuge bleiben blockiert, selbst wenn der hinterlegte Token mehr Rechte hat.

## Befehle (Telegram)
`/briefing` `/leads` `/termine` `/calendly` `/mails` `/todos`

Details zum Gesamtprojekt: siehe `../CLAUDE.md`.
