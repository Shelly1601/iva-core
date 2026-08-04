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

Noch zu prüfen:

- Einen benannten Testkunden aus Qonekto rein lesend abrufen.
- Stammdaten, Verträge, Gesellschaften und Dokumente gegen blau direkt kontrollieren.
- Erst danach den Strategiegespräch-Sync aktivieren.
- Qonekto-/Blau-Direkt-Daten bleiben fachliche Quelle; IVA speichert Quell-ID und Sync-Zeitpunkt.

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

## 5. WhatsApp-Kundenagent

| Status | Railway-Variable | Einrichtung |
|---|---|---|
| ⬜ | `WHATSAPP_ACCESS_TOKEN` | Meta-Systemnutzer-Token der WhatsApp Business Platform. |
| ⬜ | `WHATSAPP_PHONE_NUMBER_ID` | Exakte Phone Number ID der verbundenen Geschäftsnummer. |
| ⬜ | `WHATSAPP_VERIFY_TOKEN` | Selbst erzeugter langer Zufallswert für die Webhook-Verifikation. |
| ⬜ | `WHATSAPP_APP_SECRET` | Secret der Meta-App für HMAC-Signaturprüfung. |
| ⬜ | `WHATSAPP_GRAPH_VERSION` | Explizite Graph-API-Version. |
| ➖ | `WHATSAPP_DEFAULT_PROFILE_ID` | Nur für interne Tests/Fallback. |

Meta-Webhook: `https://iva-core-production.up.railway.app/webhooks/whatsapp`

Wichtig: Diese offizielle Verbindung liest und beantwortet Nachrichten der registrierten **WhatsApp-Business-Nummer**. Sie gibt IVA keinen Zugriff auf das vollständige private WhatsApp-Archiv deines iPhones. Vertragsauskünfte benötigen eine eindeutige Kundenzuordnung; Deckungsentscheidungen ohne Policen-/Bedingungsbeleg werden an dich übergeben. Senden, Schaden einreichen oder Daten ändern bleibt bestätigungspflichtig.

## 6. Beratung und Fachwissen

| Status | Railway-Variable / Inhalt | Nächster Schritt |
|---|---|---|
| ⬜ | `GKV_COMPARE_PROVIDER` | Anbietername des ausgewählten GKV-Portals. |
| ⬜ | `GKV_COMPARE_URL` | Sichere Start-/Deep-Link- oder API-URL ohne Zugangsdaten. |
| 🟡 | Produktinformationsblätter / Bedingungen | Nur offizielle, lizenzierte oder erlaubte Quellen versioniert hinterlegen. |
| 🟡 | DIN 77230 / 77235 | Vollständiges lizenziertes Regelwerk plus fachliche Abnahme, bevor IVA „DIN-konform“ ausgibt. |

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

## 9. Railway-Betrieb

- 🟡 Railway-Hobby-Plan aktiv und Zahlungsstatus prüfen.
- ✅ Volume mit Mount-Pfad `/data` beibehalten; nicht durch flüchtige Speicherung ersetzen.
- `PORT` und `RAILWAY_PUBLIC_DOMAIN` setzt Railway automatisch.
- `DATA_DIR` nur setzen, wenn der Mount-Pfad bewusst geändert wird.
- Nach jedem Secret-Wechsel: Deploy prüfen, Healthchecks aufrufen und genau eine ungefährliche Testaktion ausführen.

## Empfohlene nächste Reihenfolge

1. `API_TOKEN` rotieren und App-Verbindung testen.
2. Marketing-Pilot mit `APIFY_TOKEN`, `GOOGLE_PLACES_API_KEY`, `FAL_KEY`, `GEMINI_API_KEY`, einer Marke und Referenzkonten starten.
3. Meta Business + WhatsApp Business Platform anbinden.
4. Danach HeyGen und Brevo/Resend aktivieren.
5. Als ersten Handy-Baustein den IVA-iPhone-Kurzbefehl und das Teilen-Menü bauen; die native App folgt danach.
