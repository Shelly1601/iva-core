# Projektgebundenes Marketing

Stand: 14. September 2026. Die neue Oberfläche `/marketing?projectId=…` verbindet Firmenprofil, Wettbewerberanalyse, eigene Inhalte und echte Higgsfield-Aufträge. Die bisherige globale Markenwerkbank bleibt unter `/marketing?legacy=1` erreichbar und wird ausdrücklich nicht als Datenbestand des gewählten Projekts dargestellt.

## Vorhandener Umfang

- Pro realem IVA-Projekt: Markenname, Unternehmen, Angebot, Zielgruppe, Branche, Region, Website, Instagram, LinkedIn, Farben, Tonalität, Regeln und eigenes PNG/JPEG/WebP-Logo (3 MiB). Eigenständiger atomarer Store, Daten werden nie anhand einer vom Modell frei wählbaren Marke umgebunden.
- Direkte öffentliche Referenz-URLs oder automatische Websuche über den bestehenden Tavily-Zugang. Suchtreffer werden erst nach echtem Abruf zu Inhaltsbelegen. Website-/LinkedIn-Text über den bestehenden DNS-gepinnten HTTPS-Reader. Instagram-Profile: öffentliche Post-Stichprobe über vorhandenes Apify, einschließlich beobachteter Captions und tatsächlich gelieferter Metriken. Einzelne Instagram-Posts/Reels: optional gemeinsamer `readMediaEvidence` mit expliziter Text-/Video-/Tonabdeckung.
- Quellen, Abrufdatum, unbekannte Metriken, nicht lesbare Quellen und Grenzen bleiben sichtbar. Keine erfundenen Umsätze, Reichweiten oder Erfolgsquoten. Ein Quellenlink oder eine Caption ist keine vollständige Videoanalyse. LinkedIn kann öffentliche Lesezugriffe blockieren; eine eigene Kontoverbindung hebt das nicht auf.
- Eigene Reel-/UGC-/Carousel-/LinkedIn-Entwürfe und Kampagnenkonzepte auf Grundlage des gespeicherten Projektprofils und optional einer Analyse desselben Projekts. Modelle nutzen den bestehenden Router und seine Budgetprüfung, Reservierung und Verbrauchsbuchung. Auto priorisiert Claude Sonnet, danach eingerichtetes Gemini, danach Groq. Kein neues Tageslimit.
- Higgsfield: exakte dokumentierte Veo-3.1-Endpunkte, standardmäßig 1080p mit Ton, 4/6/8 Sekunden, Hoch-/Querformat. Modellwahl einschließlich eigenem Ausgangsbild und optional Fast. Zuerst authentifizierte Preisabfrage, anschließend expliziter Auftrag für genau diese gespeicherten Parameter. Preissteigerungen blockieren die Generation bis zur neuen Schätzung. Gleichzeitige Klicks und unsicher beendete Provider-POSTs werden nicht automatisch wiederholt.
- Videozustand kommt von Higgsfield; erfolgreich nur bei `completed` plus tatsächlicher HTTPS-Video-URL. Keine Posts, Anzeigen oder Nachrichten werden versendet. Medien-URLs werden angezeigt, nicht automatisch dauerhaft archiviert. Higgsfield garantiert mindestens sieben Tage Abrufbarkeit; die Oberfläche fordert zum Download auf.
- Projektspezifische Verbindungsanleitungen und sichere Eingabefelder für den generischen Providerkatalog, derzeit Higgsfield/Instagram/Meta Ads/LinkedIn. Die Oberfläche liest keine geheimen Zugangsdaten zurück. Zugang gespeichert und Anbieterprüfung erfolgreich sind verschiedene Zustände.

## Verdrahtung

```js
import { createProjectMarketingService } from './marketing/project-service.js';
import { registerProjectMarketingRoutes } from './marketing/project-routes.js';
import { verifyHiggsfieldConnection } from './marketing/higgsfield.js';
import { projectMarketingSkill } from './skills/marketing.js';

// Behind existing administrator authentication. getProject must enforce the
// current marketing module permission on every invocation, including tool calls.
const service = createProjectMarketingService({
  dataDir, getProject: guardedGetProject, listProjects: marketingProjects,
  providers: projectProviderStore, readMediaEvidence,
});
registerProjectMarketingRoutes(app, { service, authorizeProject });
// Providerstore verification hook:
// verifiers: { higgsfield: env => verifyHiggsfieldConnection(env) }
// Agent tools in a known server-side project context:
const tools = projectMarketingSkill({ service, projectId });
```

`providers.status(projectId)` liefert `{catalog,connections}`. `resolveEnv(projectId,'higgsfield')` liefert ausschließlich den diesem Projekt zugeordneten `HF_API_KEY_ID` und `HF_API_KEY_SECRET`. Keine globalen Higgsfield- oder Kundensocialzugänge werden übernommen. Interne Plattformzugänge für Recherche und KI dürfen vom Betreiber bereitgestellt werden.

API-Basis `/api/marketing/projects`:

| Methode | Pfad | Verhalten |
| --- | --- | --- |
| GET | `/` | Erlaubte Projekte |
| GET | `/:projectId` | Profil, Quellenanalysen, Entwürfe, Videoaufträge, Verbindungen, aktiver Job |
| POST | `/:projectId/profile` | Eigene Profilangaben speichern |
| POST/GET | `/:projectId/logo` | Bilddatei speichern/lesen, authentifiziert |
| POST | `/:projectId/research` | `{urls,automatic,briefing,model}`; laufender Auftrag mit 202 |
| POST | `/:projectId/drafts` | `{researchId?,briefing,format,model}`; laufender Auftrag mit 202 |
| POST | `/:projectId/videos/quote` | Konkretes Preisangebot für Modell/Prompt/Dauer/Bild/Format |
| POST | `/:projectId/videos` | `{quoteId,confirmCost:true}`; genau ein Provider-POST |
| GET | `/:projectId/videos/:id` | Zustand nur eines Auftrags desselben Projekts |

Die UI fragt laufende interne Jobs alle 2,5 Sekunden, Videos alle 5 Sekunden ab. Projektwechsel invalidieren asynchrone Antworten; Texteingaben bleiben pro Projekt nur im Arbeitsspeicher erhalten. Nicht abgeschlossene interne Jobs werden beim Neustart als unterbrochen markiert, unklare Paid-Submissions als unklar. Es wird kein Erfolg nachträglich erfunden.

## Offizielle Higgsfield-Quellen

Am 14. September 2026 geprüft:

- [Authentifizierung](https://docs.higgsfield.ai/docs/authentication): `Authorization: Key ID:SECRET`, ausschließlich serverseitig.
- [OpenAPI-Spezifikation](https://docs.higgsfield.ai/docs/openapi.json): `https://api.higgsfield.ai`; `/veo3.1`, `/veo3.1/image-to-video`, `/veo3.1/fast`; `duration` ist ein String, `resolution` `1080`, `aspect_ratio` `9:16`/`16:9`, `generate_audio` ein Boolean.
- [Kosten und Aufbewahrung](https://docs.higgsfield.ai/docs/concepts/billing-and-retention): `/estimate/{model}`, authentifizierte `{credits,usd}`-Schätzung, wenigstens sieben Tage Medienverfügbarkeit. Ein Website-Abo ist kein zugesichertes API-Guthaben.
- [Requeststatus](https://docs.higgsfield.ai/docs/api-reference/requests/get-request-status): `/requests/{request_id}/status`, UUID, Zustände queued/in_progress/completed/failed/nsfw/canceled.

Kein Endpunkt wird aus einem inoffiziellen SDK geraten. Verfügbarkeit und Kosten hängen vom tatsächlich verbundenen Anbieter-Konto ab. Die Implementierung behauptet keinen Live-Test ohne zugewiesenen Zugang und keinen bezahlten Testauftrag.

## Prüfung

`node --test scripts/verify-marketing-projects.mjs`

Isolierte Tests ohne Netzwerk, Port oder echte Konten: Projekttrennung, Quellenstatus, Caption-vs-Video, tatsächliche Metriken, erfundene Quellenkennungen, Modellrouting und Nutzung, Profil-Snapshot bei laufendem Job, Neustart, Modulberechtigungen, Higgsfield-Schema, reine Kosten-Verifikation, Geheimnisbegrenzung, Video-URL, Kostenbestätigung, Projekt-/Quote-Zuordnung, Preisänderung, Doppelstart und unklarer POST.

Noch gesondert zu prüfen: echte Browserdarstellung einschließlich schmaler Ansicht sowie Live-Providerzugang mit bestehendem Projektkonto. Diese Dokumentation ist keine Behauptung einer erfolgten Veröffentlichung oder Live-Generation.
