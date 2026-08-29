# IVA – Anbindungen & Railway-Variablen

_Stand: 4. August 2026. Diese Datei ist die verbindliche Resteliste für IVAs externe Anbindungen._

## So wird die Liste benutzt

- Railway öffnen → Projekt **IVA** → Service **iva-core** → **Variables**.
- Variablennamen exakt wie unten schreiben. Groß-/Kleinschreibung zählt.
- Tokens, Passwörter und Kundendaten niemals in diese Datei, GitHub, einen Prompt oder einen Chat kopieren.
- Nach Änderungen in Railway den Service neu deployen und anschließend den passenden Healthcheck beziehungsweise Testlauf ausführen.
- `✅` = laut Projektstand bereits im Einsatz, `🟡` = vorhanden, aber live prüfen/abschließen, `⬜` = noch einrichten, `➖` = optional.
- Die Statusangaben ersetzen keinen Blick in Railway: IVA kann die dort gespeicherten Secret-Werte absichtlich nicht auslesen.

## 1. IVA-Gehirn, Sprache und Kosten

| Status | Railway-Variable | Zweck / nächster Schritt |
|---|---|---|
| ✅ | `ANTHROPIC_API_KEY` | Hauptmodell für IVA. |
| ⬜ | `GEMINI_API_KEY` | Günstige Research-/Marketing-Aufgaben; Key in Google AI Studio erstellen. |
| ✅ | `GROQ_API_KEY` | Whisper-Transkription für Sprache. |
| ✅ | `TELEGRAM_BOT_TOKEN` | Telegram-Kanal und proaktive Berichte. |
| 🟡 | `API_TOKEN` | Muss exakt mit dem Token der IVA-App übereinstimmen. Der früher verwendete Wert ist im Chat aufgetaucht: rotieren und danach App neu verbinden. |
| ➖ | `IVA_BUDGET_WARN_EUR` | Empfohlen `70`: frühe Monatswarnung. |
| ➖ | `IVA_MONTHLY_BUDGET_EUR` | Empfohlen `100`: sichtbarer Monatsrahmen. |
| ✅ | `ELEVENLABS_API_KEY` | IVA-Stimme. |
| ➖ | `ELEVENLABS_VOICE_ID` | Gewählte ElevenLabs-Stimme. |
| ➖ | `ELEVENLABS_MODEL` | Zum Beispiel `eleven_multilingual_v2`. |
| ➖ | `TTS_PROVIDER` | Default `elevenlabs`; nur bei Providerwechsel setzen. |

## 2. Kalender, E-Mail und Termine

| Status | Railway-Variable | Zweck / nächster Schritt |
|---|---|---|
| 🟡 | `PRIVAT_GOOGLE_ICS_URL` | Privater Google-Kalender; Testtermin im Briefing prüfen. |
| 🟡 | `FAMILIE_GOOGLE_ICS_URL` | Familienkalender prüfen. |
| 🟡 | `PROJEKTE_GOOGLE_ICS_URL` | Projektkalender prüfen. |
| ➖ | `OUTLOOK_ICS_URL` | Nur nötig, falls Outlook nicht bereits über einen vorhandenen Kalender gespiegelt wird. |
| ✅ | `MAIL_1_USER`, `MAIL_1_PASS` | Haupt-Gmail mit App-Passwort. |
| ✅ | `MAIL_2_USER`, `MAIL_2_PASS` | Sammelpostfach. Einmal je Testmail an HeatHero, Goals & Concepts, Sol Living und Privat kontrollieren. |
| ✅ | `CALENDLY_TOKEN` | Kommende Buchungen und Namen. |

## 3. CRM, Qonekto und blau direkt

| Status | Railway-Variable | Zweck / nächster Schritt |
|---|---|---|
| ✅ | `HEATHERO_API_KEY` | HeatHero-Leads. |
| ✅ | `MEINCRM_SERVICE_KEY` | Serverzugriff auf „Mein CRM“; niemals ins Frontend geben. |
| 🟡 | `HEATHERO_PROJECT_ID` | Projektzuordnung kontrollieren. |
| 🟡 | `GOALS_CONCEPTS_PROJECT_ID` | Für Strategiegespräch → Qonekto besonders wichtig. |
| 🟡 | `KOOP_STEUERBERATER_PROJECT_ID` | Projektzuordnung kontrollieren. |
| 🟡 | `SOL_PROJECT_ID` | Projektzuordnung kontrollieren. |
| 🟡 | `VERSURO_PROJECT_ID` | Projektzuordnung kontrollieren. |
| ✅ | `QONEKTO_MCP_TOKEN` | Token „IVA – Qonekto – Produktion“; lesend und bestätigungspflichtig schreibend. |
| ➖ | `QONEKTO_MCP_URL` | Default: `https://app.qonekto.de/api/goalsandconcepts/mcp`. |
| 🟡 | `CRM_QONEKTO_SYNC_ENABLED` | Erst nach einem kontrollierten Testkunden auf `true` setzen. |
| 🟡 | `CRM_QONEKTO_SYNC_STAGE` | Exakt `Strategiegespräch`. |
| ➖ | `CRM_QONEKTO_DEFAULT_SALUTATION_ID` | Nur falls die Anrede-ID im CRM fehlt. |
| ➖ | `CRM_QONEKTO_DEFAULT_BROKER_ID` | Nur falls Qonekto keinen Standardvermittler setzt. |

### Pipedrive als direkte IVA-Arbeitsquelle

Pipedrive bleibt das fuehrende System fuer HeatHero-Deals, Phasen, Notizen und
Dateien. IVA legt keine zweite Kundenkopie an, sondern liest den benoetigten
Deal live. Der bereits vorhandene iMac-/Chrome-Weg bleibt nur als Fallback.

| Status | Railway-Variable | Zweck / naechster Schritt |
|---|---|---|
| 🟡 | `PIPEDRIVE_API_TOKEN` | Schlanker Zugang fuer das bestehende Firmenkonto; ausschliesslich direkt in Railway speichern. |
| ✅ | `PIPEDRIVE_ALLOWED_COMPANY_DOMAIN` | Exakt `simplegategmbh.pipedrive.com`; verhindert die Verbindung mit einem falschen Pipedrive-Unternehmen. |
| ⬜ | `PIPEDRIVE_WRITE_ENABLED` | Zunaechst `false`; erst nach einem Live-Lesetest und einem einzelnen bestaetigten Schreibtest auf `true`. |
| ➖ | `PIPEDRIVE_WEBHOOK_USERNAME`, `PIPEDRIVE_WEBHOOK_PASSWORD` | Optional fuer Webhooks v2 an `/webhooks/pipedrive`; IVA speichert nur Ereignis-Metadaten. |
| ➖ | `PIPEDRIVE_CLIENT_ID`, `PIPEDRIVE_CLIENT_SECRET`, `PIPEDRIVE_REDIRECT_URI`, `PIPEDRIVE_TOKEN_KEY` | Spaeterer OAuth-Weg fuer weitere Konten; fuer das aktuelle Einzelkonto nicht noetig. |

Live-Abnahme in dieser Reihenfolge:

1. `GET /health/pipedrive` muss `readReady: true` liefern.
2. `POST /api/pipedrive/probe` muss drei Pipelines, 15 Phasen und keinen Layout-Drift bestaetigen.
3. Einen bekannten Deal ueber `/api/pipedrive/deals/:id` lesen und Deal, Person, Notizen, Dateien und Aktivitaeten gegen Pipedrive vergleichen.
4. Erst danach genau eine IVA-Testnotiz mit Ruecklesepruefung anlegen. Loeschen bleibt im Code immer gesperrt.

Noch zu prüfen:

- Einen benannten Testkunden aus Qonekto rein lesend abrufen.
- Stammdaten, Verträge, Gesellschaften und Dokumente gegen blau direkt kontrollieren.
- Erst danach den Strategiegespräch-Sync aktivieren.
- Qonekto-/Blau-Direkt-Daten bleiben fachliche Quelle; IVA speichert Quell-ID und Sync-Zeitpunkt.

### Mannheimer LUMIT / Hauswertschutz

- ✅ Fester Online-Rechner mit blau-direkt-Zuordnung hinterlegt (`md=162`, `asnr=58556`).
- ✅ Blau-direkt-Agenturnummer `162-58556` und Vermittlernummer `009T7N` als Pflichtkontrolle im IVA-Nachprozess hinterlegt.
- ✅ Nachprozess „servicierter Antrag“, Zieladresse `mdpool@mannheimer.de`, IVA-Dokumentablage und Übergabe an Hauswertschutz implementiert.
- 🟡 Produktiv noch mit einem benannten Testkunden prüfen: erzeugtes Antrags-PDF, Vermittlernummer im PDF, Qonekto-Werkzeug zur Anlage als servicierter Antrag und Dokumentupload.
- 🟡 Digitaler Policenweg ist als Wunsch hinterlegt: Mannheimer/blau direkt müssen einmal schriftlich bestätigen, dass keine zusätzliche Kundenpost erfolgt. Danach gilt: digitaler Eingang → Hauswertschutz-Prüfung → kompaktes Kundenpaket mit unveränderter Originalpolice → ausdrückliche Freigabe. Kein automatischer Kundenversand.
- ✅ Generator für ein zusammenhängendes Hauswertschutz-Kundenpaket gebaut: Schutzurkunde, kompakte Preis-/Vertragsübersicht, Trennseite und danach sämtliche Seiten der unveränderten Mannheimer-Originalpolice. Originaldatei und Hash bleiben separat gespeichert.
- 🟡 Mannheimer-Logo nur nach dokumentierter Nutzungsfreigabe einbinden; ohne Freigabe nutzt das Paket eine neutrale Textkennzeichnung des Versicherers.
- 🟡 E-Mail-Versand ist vorbereitet, aber noch nicht automatisiert; der bestehende IMAP-Zugang liest nur. Vor Liveautomatik einen freigegebenen SMTP-/Microsoft-/Gmail-Sendekanal anbinden.
- ℹ️ LUMIT HOME muss laut Mannheimer über den Online-Rechner eingereicht werden. Manueller PDF-Deckungsauftrag nur für LUMIT FLEX, wenn der aktuelle Vordruck verwendet wird.
- Für diesen festen Ablauf sind keine zusätzlichen Railway-Secrets erforderlich. Ein späterer E-Mail-Sendekanal kann neue Secrets benötigen.

## 4. Marketing-Zentrale

| Priorität | Status | Railway-Variable | Einrichtung |
|---|---|---|---|
| 1 | ⬜ | `APIFY_TOKEN` | Apify für Instagram-/Web-/Wettbewerbsrecherche. |
| 1 | ⬜ | `GOOGLE_PLACES_API_KEY` | Google Cloud → Places API (New); Key auf notwendige API und Nutzung begrenzen. |
| 1 | ⬜ | `FAL_KEY` | Bildgenerierung. |
| 1 | ⬜ | `GEMINI_API_KEY` | Günstige Analyse/Synthese; steht oben nur einmal in Railway. |
| 2 | ⬜ | `META_ACCESS_TOKEN` | Meta-Systemnutzer-Token für eigene Assets. |
| 2 | ⬜ | `META_AD_ACCOUNT_ID` | Eigenes Werbekonto, zum Beispiel `act_...`. |
| 2 | ⬜ | `META_GRAPH_VERSION` | Bewusst feste Version setzen. |
| 2 | ⬜ | `META_PAGE_ID` | Eigene Facebook-Seite. |
| 2 | ⬜ | `INSTAGRAM_BUSINESS_ACCOUNT_ID` | Verbundenes professionelles Instagram-Konto. |
| 3 | ⬜ | `HEYGEN_API_KEY` | UGC-/Avatar-Videos nach Freigabe. |
| 3 | ➖ | `HEYGEN_AVATAR_ID`, `HEYGEN_VOICE_ID` | Feste Figur/Stimme, sobald ausgewählt. |
| 3 | ⬜ | `BREVO_API_KEY` **oder** `RESEND_API_KEY` | E-Mail-Versand; vorher Absenderdomain verifizieren. |
| 3 | ⬜ | `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_ORGANIZATION_ID` | Eigene LinkedIn-Organisation; kein freier Konkurrenz-Scraper. |
| ➖ | ⬜ | `TAVILY_API_KEY` | Zusätzliche Websuche/Quellenrecherche. |
| ➖ | 🟡 | `MARKETING_MORNING_REPORT_ENABLED` | Erst nach Datenprüfung auf `true`; Report um 07:10 Uhr. |

Zusätzlich ohne Railway-Variable nötig:

- Eine Pilotmarke festlegen; Empfehlung: **Goals & Concepts**.
- 5–15 gute Referenzkonten und die eigenen Zielkonten hinterlegen.
- Meta Ad Library dient für öffentliche Konkurrenzanzeigen; fremde Account-Insights sind nicht über den eigenen Meta-Token verfügbar.
- Firmenkontakte bleiben bis zur Prüfung von Rechtsgrundlage/Opt-in im Status `research-only`.

## 5. Multi-WhatsApp Hub und Kundenagent

### Bevorzugter Weg: vorhandener Multi-WhatsApp Hub

Der Hub wurde am 04.08.2026 geprüft. Er nutzt eine Evolution-Bridge per QR-Verknüpfung, enthält drei verbundene Accounts und synchronisiert Chatübersichten. Seine geschützte öffentliche API kann `me`, Accounts, Chats und Vorlagen lesen sowie Nachrichten senden. IVA bindet zunächst ausschließlich die Lesewege an; Versand bleibt gesperrt.

| Status | Railway-Variable | Einrichtung |
|---|---|---|
| ✅ | `WHATSAPP_HUB_BASE_URL` | `https://whatapphub.lovable.app/api/public/v1` |
| ⬜ | `WHATSAPP_HUB_API_KEY` | Im Hub unter **Einstellungen → API-Zugänge** als `IVA – Produktion` erstellen und den einmal sichtbaren Klartext ausschließlich in Railway speichern. |

Vor dem Erstellen/Einsetzen des Keys zwingend:

- Der öffentlich ausgelieferte Hub-Frontendcode enthält derzeit feste Anmeldedaten. Diese nicht weiterverwenden: Passwort ändern, Sitzungen widerrufen und die Werte vollständig aus dem Frontend entfernen.
- Der vierstellige PIN wurde im Chat geteilt und muss ersetzt werden. Für echte Kundendaten auf richtige Anmeldung mit MFA sowie geprüfte Supabase-RLS-Regeln umstellen.
- Bestehende Evolution-Sessions und hinterlegte Secrets nach dem Auth-Umbau prüfen; keine Zugangsdaten in Chatvorschauen versenden.

Für vollständige IVA-Automation im Hub noch ergänzen:

- `GET /v1/chats/:chat_id/messages?after=&limit=` für einen paginierten Nachrichtenverlauf.
- Signierter Webhook `message.created` an IVA statt aggressivem Polling.
- HMAC-Secret, Event-ID/Idempotenz, Account-ID und Absendernummer im Webhook.
- In IVA: Account → Unternehmen/Projekt/Bot-Profil zuordnen und Versandvorschau mit ausdrücklicher Bestätigung bauen.

### Optionaler zweiter Weg: offizielle Meta-Verbindung

| Status | Railway-Variable | Einrichtung |
|---|---|---|
| ⬜ | `WHATSAPP_ACCESS_TOKEN` | Meta-Systemnutzer-Token der WhatsApp Business Platform. |
| ⬜ | `WHATSAPP_PHONE_NUMBER_ID` | Exakte Phone Number ID der verbundenen Geschäftsnummer. |
| ⬜ | `WHATSAPP_VERIFY_TOKEN` | Selbst erzeugter langer Zufallswert für die Webhook-Verifikation. |
| ⬜ | `WHATSAPP_APP_SECRET` | Secret der Meta-App für HMAC-Signaturprüfung. |
| ⬜ | `WHATSAPP_GRAPH_VERSION` | Explizite Graph-API-Version. |
| ➖ | `WHATSAPP_DEFAULT_PROFILE_ID` | Nur für interne Tests/Fallback. |

Meta-Webhook: `https://iva-core-production.up.railway.app/webhooks/whatsapp`

Wichtig: Die Meta-Verbindung liest und beantwortet Nachrichten der registrierten **WhatsApp-Business-Nummer**. Der Hub kann über seine QR-Sessions auch bestehende persönliche oder geschäftliche Accounts spiegeln, ist als inoffizielle WhatsApp-Web-Brücke aber störungs- und sperranfälliger. Vertragsauskünfte benötigen immer eine eindeutige Kundenzuordnung; Deckungsentscheidungen ohne Policen-/Bedingungsbeleg werden an dich übergeben. Senden, Schaden einreichen oder Daten ändern bleibt bestätigungspflichtig.

## 6. Beratung und Fachwissen

| Status | Railway-Variable / Inhalt | Nächster Schritt |
|---|---|---|
| ⬜ | `GKV_COMPARE_PROVIDER` | Anbietername des ausgewählten GKV-Portals. |
| ⬜ | `GKV_COMPARE_URL` | Sichere Start-/Deep-Link- oder API-URL ohne Zugangsdaten. |
| 🟡 | Produktinformationsblätter / Bedingungen | Nur offizielle, lizenzierte oder erlaubte Quellen versioniert hinterlegen. |
| 🟡 | DIN 77230 / 77235 | Vollständiges lizenziertes Regelwerk plus fachliche Abnahme, bevor IVA „DIN-konform“ ausgibt. |

### Strom- und Gas-Tarifvergleich · EnergyPartner24

IVA kann eine Tarifvergleichsanfrage jetzt aus Kundenadresse/Fallakte, Verbrauch und Sparte vorbereiten. Ohne belegtes Provider-Ergebnis nennt IVA bewusst keine Preise, Boni oder Laufzeiten und reicht keinen Vertrag ein.

| Status | Railway-Variable | Nächster Schritt |
|---|---|---|
| ✅ | `ENERGY_TARIFF_PROVIDER` | `EnergyPartner24` setzen. |
| ✅ | `ENERGY_TARIFF_PORTAL_URL` | `https://portal-energypartner.de` setzen. |
| ⬜ | `ENERGY_TARIFF_PORTAL_USER` | Möglichst eigener IVA-Testnutzer; nicht im Chat teilen. |
| ⬜ | `ENERGY_TARIFF_PORTAL_PASSWORD` | Ausschließlich als Railway-Secret speichern. |
| ➖ | `ENERGY_TARIFF_API_URL` | Nur setzen, wenn EnergyPartner einen offiziellen API-Endpunkt freigibt. |
| ➖ | `ENERGY_TARIFF_API_TOKEN` | Nur mit passender offizieller Dokumentation/Sandbox setzen. |

Vor dem Live-Betrieb EnergyPartner schriftlich fragen, ob automatisierte Tarifabfragen erlaubt sind und ob API, Sandbox, Deep-Link oder White-Label-Zugang vorhanden sind. Der erste authentifizierte Technik-Check bleibt rein lesend: Login, Tarifmaske, Pflichtfelder und Ergebnisstruktur prüfen; keine Antragseinreichung und keine Online-Signatur auslösen.

## 7. PLAUD Note, TMB und Vor-Ort-Agent

| Status | Baustein | Nächster Schritt |
|---|---|---|
| ✅ | IVA-TMB und Foto-Checkliste | Strukturierte Fallakte, PDF und dynamische Pflichtfotos sind gebaut. |
| ⬜ | PLAUD-Zugang | Offiziellen OAuth-/MCP-Zugang anbinden; bis dahin Audio/Transkript exportieren. Keine PLAUD-Passwörter in IVA speichern. |
| ⬜ | Original-TMB-Vorlage | Leere finale Vorlage versioniert hinterlegen und Feld-/Koordinatenmapping visuell abnehmen. |
| ⬜ | Editierbare Review-Datei | Arbeitsversion vor finaler PDF-Freigabe. |
| ⬜ | 3D-Hauseditor | Grundrissvorschlag, Kontrollmaß und bestätigbare Räume/Heizkörper. |

## 8. Handy-/„Jarvis“-Anbindung

Für diese Stufe gibt es noch keine einzelne Wunder-Variable. Der sichere Ausbau erfolgt in vier Schritten:

1. **iPhone-Kurzbefehl + Teilen-Menü:** Text, Link, Foto, Datei, Bildschirmfoto oder Sprache bewusst an IVA senden; IVA analysiert und öffnet die passende Kunden-/Beratungsakte.
2. **Native IVA-Begleit-App:** Siri/App Intents, Kamera, Dateien, Kontakte und Kalender nur mit iOS-Berechtigung. Kritische Aktionen zeigen immer eine Vorschau und verlangen eine Bestätigung.
3. **Vom Nutzer gestartete Bildschirmfreigabe:** IVA darf den sichtbaren Bildschirm analysieren, zusammenfassen und durch die nächsten Schritte führen. Keine heimliche Daueraufnahme.
4. **Offizielle APIs/Deep Links:** Wenn ein Zielsystem schreiben kann, bereitet IVA die Aktion vor; Ausführung erst nach der exakten Bestätigung.

Technische Grenze auf dem iPhone: Eine normale App kann wegen der iOS-Sandbox nicht still die Datenbank anderer Apps oder das komplette private WhatsApp-Archiv lesen und nicht beliebig in fremden Apps tippen. Das im Moritz-Maaker-Reel sichtbare „Handy sehen und Bolt bedienen“ ist wahrscheinlich eine Bildschirm-/Computer-Use- beziehungsweise Entwicklerbrücke; das Reel nennt die konkrete Technik nicht. Wir können den Effekt nachbauen, aber nicht als heimlichen Vollzugriff verkaufen.

Optional kann ein dediziertes Android-Arbeits-/Testgerät nach ausdrücklicher Freigabe neue Benachrichtigungen an IVA spiegeln. Auch das ist kein Zugriff auf alte Chats und sollte nicht der Kernweg für sensible Kundendaten sein.

## 9. IVA Sales Coach

| Status | Baustein | Nächster Schritt |
|---|---|---|
| ✅ | Zielbild | Spezifikation in `IVA_SALES_COACH_SPEZIFIKATION.md`: No-Bot-Overlay, Einwandampel, Redeanteil, nächste Frage und Nachbereitung. |
| ⬜ | macOS-Begleit-App | Mikrofon und ausgewählten App-/Systemton nach Berechtigung getrennt erfassen; dadurch unabhängig von Zoom, Teams, Google Meet oder einem anderen Meetinganbieter. PWA allein reicht bei Kopfhörern nicht zuverlässig. |
| ⬜ | Streaming-Transkription | Anbieter erst nach Latenz-/Deutsch-/Kostentest auswählen; bis dahin bewusst noch keinen Railway-Key festlegen. |
| ⬜ | Einwilligungs-Gate | Aktives Ja vor jedem Start dokumentieren; Roh-Audio standardmäßig nicht dauerhaft speichern. |
| ⬜ | Sales-Wissen | Nadines Leitfäden, Einwandbibliothek und freigegebene Formulierungen versioniert hinterlegen. |
| ⬜ | CRM-Nachbereitung | Ergebnis nur als Vorschau in Kunden-/Beratungsakte schreiben; Versand und Änderungen bleiben bestätigungspflichtig. |

## 10. IVA Buchhaltungsagent

| Status | Baustein | Nächster Schritt |
|---|---|---|
| ✅ | Zielbild | Eigenes internes IVA-Buchhaltungssystem in `IVA_BUCHHALTUNGSAGENT_SPEZIFIKATION.md`; Fremdprodukte sind weder Pflicht noch führendes System. Keine autonome Steuerabgabe. |
| ✅ | Interner MVP | `/accounting` mit eigener Belegablage, unverändertem Original/Hash, Firmenzuordnung, Ampel, Monatsübersicht und neutralem Download ist gebaut. |
| ⬜ | Rechtsträger | Alle getrennt zu führenden Firmen, Gewinnermittlungsart und Umsatzsteuerstatus einmal erfassen. |
| 🟡 | Beleg-Inbox | Upload für PDF, Bild, ZUGFeRD und XRechnung ist gebaut; automatische Auslesung, Kamera-Flow und eigene Weiterleitungsadresse folgen. |
| ⬜ | Bank-/Kartenimport | Im MVP zuerst CSV; später nur einen freigegebenen, eng begrenzten Banking-Connector anbinden. |
| ⬜ | Eigene Buchungsansicht | IVA-Konten/Kategorien, Einnahmen, Ausgaben, Abstimmung und versionierte Monatsfreigabe fachlich abnehmen. |
| ⬜ | Steuerberaterportal | Eigener zeitlich begrenzter IVA-Zugang für freigegebene Firmen/Zeiträume, Rückfragen, Kommentare und Downloadpakete. |

Für den internen Grundbetrieb ist **keine neue Railway-Variable** erforderlich; die Daten liegen im bestehenden `/data`-Volume. Spätere Mail-, Bank- oder Steuerberater-Zugänge nur serverseitig als Secrets hinterlegen, nie in Belegen, Browserfeldern oder Prompts.

## 11. Railway-Betrieb

- 🟡 Railway-Hobby-Plan aktiv und Zahlungsstatus prüfen.
- ✅ Volume mit Mount-Pfad `/data` beibehalten; nicht durch flüchtige Speicherung ersetzen.
- `PORT` und `RAILWAY_PUBLIC_DOMAIN` setzt Railway automatisch.
- `DATA_DIR` nur setzen, wenn der Mount-Pfad bewusst geändert wird.
- Nach jedem Secret-Wechsel: Deploy prüfen, Healthchecks aufrufen und genau eine ungefährliche Testaktion ausführen.

## 12. IVA-Kontrollzentrum und aktive Agenten

- `/control` ist die zentrale Betriebsansicht. Sie verwendet denselben im Browser gespeicherten `API_TOKEN` wie das Cockpit.
- Aktiv: **IVA · Zentrale**, **Kunden & Backoffice**, **Beratung & Fachprüfung**, **Marketing & Growth**, **Energie & Vor Ort**, **Buchhaltung & Controlling** und **Sales & Gesprächscoach**.
- Bewusst gesperrt: **Wissen & Kurse**, bis der rechte- und quellengeprüfte Importweg steht; **Entwicklung & QA**, bis Vorschau, Git-Freigabe, Tests, Rollback und Produktionsfreigabe sauber getrennt sind.
- Im Kontrollzentrum werden ausschließlich Secret-**Namen** als fehlend angezeigt, niemals Werte. Agentenläufe speichern nur gekürzte und automatisch redigierte Vorschauen; E-Mail, Telefonnummer und IBAN werden maskiert.
- Ein gelber Connector bedeutet nicht, dass der vorhandene Modulbau fehlt. Es bedeutet, dass eine externe Live-Funktion noch ein Konto, einen Key oder eine bewusste Aktivierung benötigt.

## Empfohlene nächste Reihenfolge

1. Deployment öffnen, `/control` aufrufen und den bestehenden App-Token eintragen. Falls `API_TOKEN` noch der alte im Chat genannte Wert ist: in Railway rotieren und danach Cockpit plus Kontrollzentrum neu verbinden.
2. In `/control` zuerst Qonekto, CRM, Kalender, Mail, Calendly und Voice auf Grün prüfen. Einen benannten Testkunden aus Qonekto rein lesend öffnen; noch keinen Massensync starten.
3. Strategiegespräch-Sync mit genau einem Testkunden prüfen. Erst wenn Felder, Anrede und Vermittler stimmen, `CRM_QONEKTO_SYNC_ENABLED=true` setzen.
4. Marketing-Pilot mit `APIFY_TOKEN`, `GOOGLE_PLACES_API_KEY`, `FAL_KEY`, `GEMINI_API_KEY`, einer Marke und 5–15 Referenzkonten starten.
5. Multi-WhatsApp Hub absichern, danach `WHATSAPP_HUB_API_KEY` erstellen und in Railway hinterlegen. Nachrichtenverlauf und signierten Webhook ergänzen; erst danach Bot-Profile live aktivieren.
6. Meta Business als stabilen Kanal für kritische Geschäftsnummern anbinden; danach HeyGen und Brevo/Resend.
7. Im Buchhaltungsbereich Rechtsträger anlegen und echte Testbelege prüfen; danach automatische Auslesung und erst im zweiten Schritt Bankdaten anbinden.
8. Als ersten Handy-Baustein den IVA-iPhone-Kurzbefehl und das Teilen-Menü bauen; die native App folgt danach.
9. EnergyPartner mit einem dedizierten Testzugang prüfen; zuerst nur Tarifvergleich und Ergebnisübernahme, Vertragsabschluss erst später mit eigener Bestätigung.
10. Eine Woche lang im Kontrollzentrum Freigaben, Fehlversuche und Datenlücken beobachten. Erst dann weitere Autonomie freischalten.
