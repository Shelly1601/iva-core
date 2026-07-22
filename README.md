# IVA-Core

Backend („Gehirn") von IVA. Node.js + Express, deployt auf Railway. Bündelt Kalender, Mail, CRM-Leads, Todos, Calendly, Sprachnachrichten, Morning-Briefing — gesteuert über Telegram und eine kleine REST-API fürs Frontend.

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

## Befehle (Telegram)
`/briefing` `/leads` `/termine` `/calendly` `/mails` `/todos`

Details zum Gesamtprojekt: siehe `../CLAUDE.md`.
