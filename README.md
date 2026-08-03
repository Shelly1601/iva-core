# IVA-Core

Backend („Gehirn") von IVA. Node.js + Express, deployt auf Railway. Bündelt Kalender, Mail, CRM-Leads, Todos, Calendly, Sprachnachrichten, Morning-Briefing — gesteuert über Telegram und eine kleine REST-API fürs Frontend. Das eigenständige Heat Hero CRM und der Heat-Hero-Bereich im Multi CRM sind bewusst getrennte Datenquellen.

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
- `GET/POST /api/*` – Frontend-API (Bearer `API_TOKEN`): leads, mails, calendar, calendly, todos (+toggle), chat.
- `GET/POST/PATCH /api/workspaces` – gemeinsame Fallakten für Beratung, Kunde und Energieplanung.
- `GET /api/workspaces/:id/tmb.pdf` – A4-TMB aus einer Energie-Fallakte mit Raum-/Heizkörpertabelle und zugeordnetem Fotoanhang.

## Lokale Prüfungen
- `npm run test:workspaces` – Fallakten, Dateien und Persistenz.
- `npm run test:tmb` – versioniertes TMB-Schema und visuell prüfbares Muster-PDF unter `output/pdf/IVA-TMB-Muster.pdf`.

## Befehle (Telegram)
`/briefing` `/leads` `/termine` `/calendly` `/mails` `/todos`

Details zum Gesamtprojekt: siehe `../CLAUDE.md`.
