# IVA – Smoke-Tests (Baseline)

Kurzer, wiederverwendbarer Skript-Check, mit dem sich vor **und** nach jedem Refactor-Schritt beweisen lässt: die kritischen Endpunkte antworten korrekt und die Auth funktioniert. Ändert **nichts** am Server oder an den Daten.

Skript: [`iva-core/scripts/smoke.js`](iva-core/scripts/smoke.js) · npm-Alias: `npm run test:smoke`

---

## Was wird geprüft

| Check | Erwartung |
|---|---|
| `GET /cockpit` | 200 + `text/html`, enthält "IVA" |
| `POST /telegram` (leere Payload) | 200 (Webhook erreichbar, kein Trigger, kein Nebeneffekt) |
| Auth-Erzwingung | `GET /api/todos` ohne Bearer → 401 |
| `GET /api/todos` | 200, Array |
| `GET /api/calendar` | 200, Array |
| `GET /api/calendly` | 200 + Objekt mit `count` + `events`. Ein `{ fehler }`-Feld ist **FAIL** (Fehlermeldung wird gekürzt geloggt). |
| `GET /api/mails` | 200, Array |
| `GET /api/leads` | 200, Array; jedes Element hat `projekt` und `gruppe` |
| `POST /api/chat` | 200, `{ reply: string }` (**Opt-in**, ruft Claude live auf) |
| `POST /api/speak` | 200 + `audio/*` + nicht-leerer Body (**Opt-in**, ruft ElevenLabs live auf). **204 = FAIL** (kein Audio geliefert). |

Jeder Check wird als `PASS`, `FAIL` oder `SKIP` protokolliert. Exit-Code `0` bei allen bestandenen (skips erlaubt), `1` bei mindestens einem `FAIL`, `2` bei Konfig-/Runner-Fehlern.

---

## Umgebungs-Variablen

Der Test lädt `iva-core/.env` per `dotenv/config` — **dieselbe Datei, die auch `index.js` liest**. Es sind keine expliziten Exports mehr nötig, solange die App-`.env` vorhanden und aktuell ist.

**Precedence (höchste Priorität zuerst):**

1. Explizite Prozess-ENV (Shell, CI, `NAME=value npm run test:smoke …`)
2. Werte aus `iva-core/.env` (dotenv überschreibt bereits gesetzte Variablen nicht)
3. Hartkodierte Defaults / Fallbacks im Skript

**Variablen (alle optional — Defaults oder Fallback greifen)**

| Name | Default / Fallback | Zweck |
|---|---|---|
| `SMOKE_BASE_URL` | `https://iva-core-production.up.railway.app` | Basis-URL des Servers. Ohne Wert testet der Lauf die Produktion. Trailing-Slashes werden gestrippt. |
| `SMOKE_API_TOKEN` | Fallback auf `API_TOKEN` (aus `.env`) | Bearer für `/api/*`. Ohne `SMOKE_API_TOKEN` nutzt das Skript automatisch `API_TOKEN` – dieselbe Variable wie die App. |
| `SMOKE_INCLUDE_CHAT` | `0` | Auf `1` setzen, um `POST /api/chat` scharf zu schalten (löst einen echten Claude-Call aus → Kosten + belegt Session `__smoke__` in `conversations.json`). |
| `SMOKE_INCLUDE_SPEAK` | `0` | Auf `1` setzen, um `POST /api/speak` scharf zu schalten (löst einen echten ElevenLabs-Call aus → Kosten). |
| `SMOKE_TIMEOUT_MS` | `15000` | Timeout für Standard-Checks. |
| `SMOKE_CHAT_TIMEOUT_MS` | `60000` | Höherer Timeout für den Chat-Call (Tool-Loop bis 6 Schritte). |

Wenn **weder** `SMOKE_API_TOKEN` **noch** `API_TOKEN` gefunden werden, bricht der Test mit Exit-Code `2` und einem Hinweis ab — der Token selbst erscheint nirgends im Log.

Der Token wird ausschließlich maskiert geloggt (`abc...xy`, plus Länge und Quelle wie `SMOKE_API_TOKEN` / `API_TOKEN (Fallback)`). Der Wert erscheint nie im Klartext, weder in stdout noch in Fehler-Ausgaben.

---

## Ausführung

**Standardfall (Produktion, Token aus `iva-core/.env`):**

```bash
cd iva-core
npm run test:smoke
```

**Mit Chat/Speak (kostet Geld, Opt-in):**

```bash
cd iva-core
SMOKE_INCLUDE_CHAT=1 SMOKE_INCLUDE_SPEAK=1 npm run test:smoke
```

**Gegen lokal laufenden Server (überschreibt den Default):**

```bash
cd iva-core
SMOKE_BASE_URL=http://localhost:3000 npm run test:smoke
```

**Anderen Token verwenden (überschreibt `API_TOKEN` aus `.env`):**

```bash
cd iva-core
SMOKE_API_TOKEN="<abweichender Wert>" npm run test:smoke
```

Voraussetzung: Node 18+ (natives `fetch`) und `dotenv` (bereits als App-Dependency installiert). Kein zusätzliches `npm install` nötig.

---

## Beispiel-Ausgabe

```
IVA Smoke Test
  Ziel:   https://iva-core-production.up.railway.app (Quelle: Default)
  Token:  abc...xy (Laenge 32, Quelle: API_TOKEN (Fallback))
  Chat:   skip (setze SMOKE_INCLUDE_CHAT=1)
  Speak:  skip (setze SMOKE_INCLUDE_SPEAK=1)

[PASS] GET /cockpit (statisches Frontend) -- HTML geliefert (25805 B)
[PASS] POST /telegram (Webhook erreichbar) -- antwortet 200 auf leere Payload
[PASS] Bearer-Auth erzwungen (/api ohne Token = 401)
[PASS] GET /api/todos -- 4 offene Todos
[PASS] GET /api/calendar -- 12 Eintraege in 7 Tagen
[PASS] GET /api/calendly -- 3 Buchungen
[PASS] GET /api/mails -- 25 Nachrichten
[PASS] GET /api/leads -- 6 Quellen
[SKIP] POST /api/chat -- SMOKE_INCLUDE_CHAT!=1 (LLM-Kosten)
[SKIP] POST /api/speak -- SMOKE_INCLUDE_SPEAK!=1 (ElevenLabs-Kosten)

Summary: 8 PASS, 0 FAIL, 2 SKIP  (10 total)
```

---

## Was der Test **nicht** kann (bewusst / noch nicht)

Diese Punkte sind entweder außerhalb dessen, was ein HTTP-Skript sicher prüfen kann, oder würden Nebeneffekte / Kosten erzeugen:

- **Telegram-Ende-zu-Ende:** Der Webhook-Check bestätigt nur, dass der Endpoint 200 liefert. Er beweist nicht, dass eine echte Nachricht → Claude → Reply → Telegram-`sendMessage` funktioniert. Dafür bräuchte es einen Test-Bot + einen Test-Chat + Auslesen der Bot-API-Response.
- **Voice-Round-Trip (Groq Whisper):** Nur über eine echte Telegram-Voice-Message prüfbar. Manueller Test.
- **Morning-Briefing (Cron 07:00):** Nicht automatisierbar ohne den Cron zu triggern. `sendBriefing()` ist derzeit nicht als API-Endpunkt exponiert; ihn nur zum Testen zu exponieren würde die Regel „nichts an bestehender App ändern" verletzen.
- **CRM-Schreib-Pfade:** Es existiert kein CRM-Write-Endpoint → nichts zu prüfen.
- **Konversations-Verlauf-Persistenz:** Nur mit mindestens zwei Chat-Calls prüfbar → würde reale LLM-Kosten und Session-Datei-Schreibvorgänge produzieren. Auf `POST /api/chat` (Opt-in) beschränkt.
- **Kalender-/Mail-Inhalte inhaltlich:** Wir prüfen Shape und Erreichbarkeit, nicht Korrektheit einzelner Termine/Mails (wären an persönliche Daten gebunden).
- **Kosten-/Rate-Limit-Schutz externer APIs:** Der Test kann Provider-Fehler (ElevenLabs Free-Plan, Apify-Quota, Gemini-Limits) nicht vorhersagen. Provider-seitige Fehler → `FAIL` mit HTTP-Status.
- **Marketing-Endpunkte (`/api/campaigns/*`, `/api/brands/*`, `/api/analyze`, `/api/generate-image`, `/api/assist/*`):** Bewusst nicht enthalten. `analyze` und `generate-image` sind teure Live-Calls (Apify-Scrape ~30–60 s, fal.ai kostet). Für diese lohnt sich später ein separater `test:smoke:marketing` mit klarem Opt-in.
- **Race-Conditions auf `/data/*.json`:** Der Test führt Requests seriell aus. Concurrency-Fehler der File-Persistenz bleiben verborgen — die sind Refactor-Ziel, nicht Smoke-Test-Ziel.

---

## Verwendung im Refactor-Workflow

1. **Vor dem Refactor:** einmal ausführen → aktuelle Baseline dokumentieren.
2. **Nach jedem Schritt** (siehe Aufteilungs-Plan im Chat / Analyse-Report): erneut ausführen. Solange alle vorher grünen Checks weiter grün sind, hat der Refactor keine Regression eingeführt.
3. **Chat/Speak** einmalig scharf schalten, wenn die entsprechenden Module (`src/ai/chat.js`, `voice.js`-Verkabelung) angefasst wurden — nicht in jeder Iteration.
