# IVA – Inbetriebnahme-Runbook

_Stand: 5. August 2026. Keine Secret-Werte in diese Datei, GitHub oder einen Chat kopieren._

## Ziel und aktueller Prüfstand

IVA hat neun aktive Rollen: Zentrale, Kunden/Backoffice, Beratung, Marketing, Energie, Buchhaltung, Sales, Wissen und Recruiting. Builder/QA bleibt bewusst deaktiviert, bis Git-, Test-, Deployment- und Rollback-Freigaben technisch getrennt sind.

Am 5. August 2026 lokal verifiziert:

- Agentenrouting, Berechtigungsgrenzen, Freigaben und Audit
- Qonekto-Leseschutz und exakte Schreibbestätigung
- CRM→Qonekto-Mapping und Dublettenschutz
- Marketing, WhatsApp, Beratung, Energie, Buchhaltung, Voice-Lab und PDF-Erzeugung
- echter Anthropic-Modellaufruf
- Live-Erreichbarkeit von `/cockpit`, `/control` und Telegram-Webhook

Nicht aus dem lokalen Rechner ablesbar: welche Secrets aktuell in Railway gesetzt sind. Dafür ist `/control` die verbindliche Live-Anzeige.

## 1. Railway öffnen und Grundbetrieb sichern

1. Railway öffnen: <https://railway.app/dashboard>
2. Projekt **IVA** wählen.
3. Service **iva-core** öffnen.
4. Unter **Settings / Volumes** kontrollieren: persistentes Volume mit Mount-Pfad `/data`.
5. Unter **Variables** arbeiten. Variablennamen exakt übernehmen; Werte niemals hier dokumentieren.
6. Nach einer Variablenrunde den neuen Deploy abwarten.
7. Danach <https://iva-core-production.up.railway.app/control> öffnen und denselben `API_TOKEN` wie in der App eintragen.

### API_TOKEN zuerst rotieren

Der alte Token war in einem Chat sichtbar. Einen neuen Wert lokal erzeugen:

```bash
openssl rand -hex 32
```

Den Wert direkt in Railway als `API_TOKEN` und anschließend in der IVA-App beziehungsweise im Kontrollzentrum eintragen. Nicht in eine Nachricht kopieren. Danach Cockpit, App und `/control` neu laden.

## 2. Basis: Damit IVA hören, denken und antworten kann

| Variable | Woher | Was eintragen | Live-Test |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | <https://console.anthropic.com/settings/keys> | eigener Server-API-Key | Cockpit: „Antworte nur mit OK“ |
| `GROQ_API_KEY` | <https://console.groq.com/keys> | Key für Whisper | `/voice-lab`: kurze Aufnahme transkribieren |
| `TELEGRAM_BOT_TOKEN` | <https://t.me/BotFather> | Token des bestehenden IVA-Bots | IVA in Telegram „ping“ senden |
| `ELEVENLABS_API_KEY` | <https://elevenlabs.io/app/settings/api-keys> | Key des bezahlten Kontos | `/voice-lab`: Antwort abspielen |
| `ELEVENLABS_VOICE_ID` | ElevenLabs → Voices → gewünschte Stimme | ID der Eva-Stimme | Stimme gegen bekannte Eva-Stimme prüfen |
| `ELEVENLABS_MODEL` | ElevenLabs-Modellbezeichnung | empfohlen aktuell im Projekt: `eleven_multilingual_v2` | Datum/Uhrzeit und Abkürzungen vorlesen lassen |
| `TTS_PROVIDER` | kein externer Wert | leer lassen oder `elevenlabs` | nur bei Providerwechsel ändern |
| `IVA_BUDGET_WARN_EUR` | eigene Entscheidung | z. B. `70` | `/control`: Budgetanzeige |
| `IVA_MONTHLY_BUDGET_EUR` | eigene Entscheidung | z. B. `100` | harter Monatsrahmen |

Optionales Modellrouting erst nach dem Grundtest ändern. Erlaubte Overrides stehen in `core/router.js`, z. B. `IVA_MODEL_CHAT`. Niemals einen nicht registrierten Modellnamen setzen; der Server bricht bewusst mit einer klaren Fehlermeldung ab.

## 3. Kalender, E-Mail und Calendly

### Kalender

Für jeden Google-Kalender: Google Calendar → Einstellungen des Kalenders → **Kalender integrieren** → **Geheime Adresse im iCal-Format** kopieren.

- `PRIVAT_GOOGLE_ICS_URL`
- `FAMILIE_GOOGLE_ICS_URL`
- `PROJEKTE_GOOGLE_ICS_URL`
- optional `OUTLOOK_ICS_URL`

Test: in jeden verbundenen Kalender einen eindeutig benannten Termin wie `IVA TEST Privat` legen und `/api/calendar` beziehungsweise die Kalenderkachel prüfen. Testtermine danach löschen.

### Gmail/IMAP

Google-Konto → 2‑Faktor-Authentifizierung aktivieren → <https://myaccount.google.com/apppasswords> → eigenes App-Passwort für IVA erzeugen.

- `MAIL_1_USER`, `MAIL_1_PASS`
- `MAIL_2_USER`, `MAIL_2_PASS`
- `MAIL_1_HOST` / `MAIL_2_HOST` nur setzen, wenn es kein Gmail-Konto ist
- `MAIL_1_LABEL` / `MAIL_2_LABEL` optional für eine verständliche Anzeige

Test: je eine Testmail an HeatHero, Goals & Concepts, Sol Living und Privat senden. In IVA prüfen, ob Eingang und Firmenzuordnung stimmen.

### Calendly

Calendly → Integrationen / Developer → Personal Access Token erzeugen und als `CALENDLY_TOKEN` hinterlegen.

Test: einen Testtermin buchen und in der Calendly-Kachel Name plus Termin kontrollieren; danach stornieren.

## 4. CRM, Qonekto und blau direkt

### HeatHero und Mein CRM

- `HEATHERO_API_KEY`: vorhandener HeatHero-Gateway-Key
- `MEINCRM_SERVICE_KEY`: Supabase-`service_role`, ausschließlich serverseitig
- `HEATHERO_PROJECT_ID`
- `GOALS_CONCEPTS_PROJECT_ID`
- `KOOP_STEUERBERATER_PROJECT_ID`
- `SOL_PROJECT_ID`
- `VERSURO_PROJECT_ID`

Projekt-IDs kommen aus „Mein CRM“/Supabase und müssen jeweils zur richtigen Marke gehören.

Test: pro Projekt genau einen bekannten Lead lesen und Projektname, Status und Wiedervorlage vergleichen. Keine Kundendaten im Chat wiedergeben.

### Qonekto

- `QONEKTO_MCP_TOKEN`: in Qonekto als dedizierten Produktionszugang `IVA – Qonekto – Produktion` erzeugen
- `QONEKTO_MCP_URL`: nur bei offizieller Änderung setzen; Default ist bereits im Code

Erster Test ist rein lesend:

1. `/control` muss Qonekto als erreichbar zeigen.
2. Einen von Nadine benannten Testkunden in `/customers` suchen.
3. Stammdaten, Verträge, Gesellschaften und Dokumente gegen Qonekto/blau direkt prüfen.
4. Noch keine Änderung bestätigen.

### CRM→Qonekto erst danach

- `CRM_QONEKTO_SYNC_STAGE=Strategiegespräch`
- `CRM_QONEKTO_SYNC_ENABLED=false` für den ersten kontrollierten Lauf
- `CRM_QONEKTO_DEFAULT_SALUTATION_ID` nur wenn im Lead keine Anrede steht
- `CRM_QONEKTO_DEFAULT_BROKER_ID` nur wenn Qonekto keinen richtigen Standardvermittler setzt

Nach einem einzelnen, kontrollierten Testkunden darf `CRM_QONEKTO_SYNC_ENABLED=true` gesetzt werden. Das ist keine Freigabe für Versicherungsanträge oder Versand.

## 5. Marketing: zuerst echte Analyse, danach Publishing

### Stufe A – heute aktivierbar

| Variable | Woher | Funktion |
|---|---|---|
| `GEMINI_API_KEY` | <https://aistudio.google.com/app/apikey> | günstige Marketing-Synthese |
| `APIFY_TOKEN` | <https://console.apify.com/account/integrations> | Instagram-/Social-Research |
| `FAL_KEY` | <https://fal.ai/dashboard/keys> | Bildgenerierung |
| `GOOGLE_PLACES_API_KEY` | Google Cloud → APIs & Services → Credentials; nur Places API (New) freigeben | Firmensuche |
| `TAVILY_API_KEY` | <https://app.tavily.com/home> | quellenorientierte Webrecherche |

Praxistest mit **einer** Pilotmarke:

1. In `/marketing` Brand-Profil anlegen.
2. 5–15 Referenzkonten hinzufügen.
3. Marktanalyse starten und Quellenqualität kontrollieren.
4. Erst bei belastbaren Quellen einen Content-Plan erzeugen.
5. Ein einzelnes Bild generieren und Ergebnis visuell abnehmen.

### Stufe B – nur teilweise implementiert

- `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_GRAPH_VERSION`: echte Ads-Insights sind implementiert und testbar.
- `META_PAGE_ID`, `INSTAGRAM_BUSINESS_ACCOUNT_ID`: für späteres Publishing nötig; Publishing selbst ist noch nicht implementiert.
- `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_ORGANIZATION_ID`: Statusvorbereitung vorhanden, echter Posting-/Analytics-Adapter fehlt.
- `HEYGEN_API_KEY`, `HEYGEN_AVATAR_ID`, `HEYGEN_VOICE_ID`: Statusvorbereitung vorhanden, Video-Adapter fehlt.
- `BREVO_API_KEY` oder `RESEND_API_KEY`: Statusvorbereitung vorhanden, echter Versand bleibt gesperrt.

Wichtig: Das Setzen dieser Stufe-B-Keys allein macht den jeweiligen Agenten noch nicht live. Erst der konkrete Adapter plus ein kontrollierter Test darf im Kontrollzentrum als „bereit“ gelten.

## 6. WhatsApp

### Bevorzugter Hub-Weg

Vorher Hub-Login, feste Frontend-Zugangsdaten, geteilte PIN und Supabase-RLS absichern. Danach im Hub unter **Einstellungen → API-Zugänge** den Key `IVA – Produktion` erzeugen:

- `WHATSAPP_HUB_BASE_URL=https://whatapphub.lovable.app/api/public/v1`
- `WHATSAPP_HUB_API_KEY`

Aktuell kann IVA Accounts, Chatübersichten und Vorlagen lesen. Nachrichtenverlauf, signierter Eingangswebhook und freigegebener Versand fehlen noch. Deshalb zunächst nur den Testchat unter `/whatsapp` verwenden.

### Offizielle Meta-Verbindung

- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_VERIFY_TOKEN` (selbst erzeugter langer Zufallswert)
- `WHATSAPP_APP_SECRET`
- `WHATSAPP_GRAPH_VERSION`
- optional `WHATSAPP_DEFAULT_PROFILE_ID`

Webhook: `https://iva-core-production.up.railway.app/webhooks/whatsapp`

Erst mit einer Meta-Testnummer prüfen. Keine echte Vertragsauskunft ohne eindeutige Kundenzuordnung; keine Deckungszusage ohne Policen-/Bedingungsbeleg.

## 7. Bereiche ohne neue Variable

- Buchhaltung: MVP läuft auf dem `/data`-Volume; Rechtsträger und Testbelege in `/accounting` erfassen.
- Energie/TMB: Fallakte, Heizlast-Vorplanung, Fördervorcheck und PDF sind intern testbar.
- Beratung: 12 Module sind intern testbar; GKV bleibt ohne gewählten Anbieter nur Übergabe.
- Sales Coach: benötigt zuerst die macOS-Begleit-App und Einwilligungs-Gate, keinen vorschnell erfundenen Railway-Key.
- PLAUD: offizieller OAuth-/MCP-Weg fehlt noch; kein Passwort in Railway oder IVA speichern.
- Wissen/Kurse: Der Wissens-Agent ist mit einer kuratierten Quellenmediathek aktiv. Inhalte ohne Herkunft, Rechtebasis und Versionsstand bleiben außerhalb der aktiven Suche; kommerzielle Kursproduktion benötigt weiterhin eine gesonderte Quellenfreigabe.
- Builder/QA: bleibt bis zu getrennten Git-/Deploy-/Rollback-Freigaben deaktiviert.

## 8. Automatisierte Tests

Lokal im Ordner `iva-core`:

```bash
npm run test:all
```

Live-Smoke-Test, ohne den Token in die Shell-History zu schreiben:

```bash
read -s "SMOKE_API_TOKEN?IVA API_TOKEN: "
export SMOKE_API_TOKEN
SMOKE_BASE_URL=https://iva-core-production.up.railway.app npm run test:smoke
unset SMOKE_API_TOKEN
```

Chat und Sprache kosten Provider-Nutzung und werden bewusst separat aktiviert:

```bash
read -s "SMOKE_API_TOKEN?IVA API_TOKEN: "
export SMOKE_API_TOKEN
SMOKE_BASE_URL=https://iva-core-production.up.railway.app SMOKE_INCLUDE_CHAT=1 SMOKE_INCLUDE_SPEAK=1 npm run test:smoke
unset SMOKE_API_TOKEN
```

## 9. Abnahmereihenfolge

1. `/control`: API, Anthropic, Telegram, Spracheingabe und Stimme grün.
2. Kalender, Mail und Calendly mit benannten Testobjekten prüfen.
3. CRM-Quellen lesen; einen Qonekto-Testkunden vollständig abgleichen.
4. Erst danach CRM→Qonekto mit genau einem Testkunden aktivieren.
5. Marketing-Stufe A mit einer Pilotmarke testen.
6. WhatsApp zunächst im Simulator, dann Meta-Testnummer oder abgesicherter Hub.
7. Eine Woche Audit, Fehler und Datenlücken beobachten, bevor mehr Autonomie freigeschaltet wird.
