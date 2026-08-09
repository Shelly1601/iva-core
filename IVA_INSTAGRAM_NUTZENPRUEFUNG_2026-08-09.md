# IVA – Nutzenprüfung der Instagram-Ideen

Stand: 9. August 2026

## Verbindliche Regel

Bevor eine Reel-Idee, ein Creator-Workflow, ein Tool oder ein neuer Agent in IVA aufgenommen wird, prüft IVA:

1. Welches konkrete, wiederkehrende Problem wird gelöst?
2. Welche Funktion fehlt wirklich – und welcher bestehende Agent deckt sie schon ab?
3. Gibt es eine offizielle Primärquelle für Funktion, Preis, Limits und technische Voraussetzungen?
4. Wie viel Zeit oder Geld spart die Ergänzung realistisch gegenüber Einrichtungs-, Betriebs- und API-Kosten?
5. Sind Code-, Design-, Inhalts- und Datennutzungsrechte geklärt?
6. Entstehen Datenschutz-, Sicherheits-, Versand-, Budget- oder Haftungsrisiken?

Die zulässigen Ergebnisse sind: in bestehenden Agenten integrieren, als neuer Agent prüfen, nur beobachten, weitere Verifikation nötig oder ablehnen. Fremder Code, Texte und Designs werden nicht kopiert. IVA übernimmt ausschließlich selbst implementierte Funktionsmuster.

## Reels – Entscheidung

| Reel | Tatsächlicher Kern | Entscheidung | Umsetzung in IVA |
|---|---|---|---|
| `DbiQDBooC92` | Logo-/Bild-Transitionen für Kurzvideos | sinnvoll als Option | Content-Agent darf Transitionen als Stilmittel vorschlagen; kein neuer Agent |
| `DbdLYtdo0I_` | Bild/Text zu 3D-Modell, vermutlich Meshy | beobachten | nur Content-Assets; kein technischer Gebäude- oder Energie-Nachweis |
| `DbakgPSou1_` | Prompt-basierter 3D-Website-Builder | Doppelung | Benchmark für IVA-Builder/Sites/Lovable; nicht integrieren |
| `Da5FtIqIb25` | Sammlung angeblich kostenloser KI-Tools | Discovery-only | Einzeltools müssen jeweils neu geprüft werden |
| `DaVGK9wInO3` | Design-Portfolios hochwertiger Produktdesigner | sinnvoll | Qualitätsreferenz für Website-/Content-Arbeit; keine Designkopie |
| `DbbSXBAoFAb` | Open Generative AI | real, aber Claim verkürzt | als späterer Content-PoC vorgemerkt; keine Installation oder Abhängigkeit jetzt |
| `DaNW-RfoSpp` | weiterer Prompt-/3D-Website-Builder | Doppelung | kein neuer Agent |
| `DbJPpZsNEvC` | „Free“-Kommentar-Funnel ohne belegte Funktion | nicht belegt | keine Integration ohne Primärquelle |
| `DaDAtdWoFXL` | sehr große PNG-Sammlung | Rechte unklar | abgelehnt; nur Assets mit belastbarer Einzellizenz |
| `DanF4k0oq2t` | Grundriss-Skizze als möbliertes 3D-Bild | begrenzt sinnvoll | Energie-Agent darf es nur als Konzeptvorschau nach Maß-/Raumprüfung nutzen |
| `Dau9lThIom_` | Datenbank gescheiterter Startups | sinnvoll als Gegenbeleg | Chancenfinder nutzt Failure-Research als Signal, aber nie als Marktnachweis |
| `Daz90y7MpNo` | weiterer KI-App-Builder | Doppelung | IVA-Builder bleibt bis zu sauberer Git-/Test-/Deploy-Trennung deaktiviert |
| `DbA8wcFohcR` | MIT-Kurse und Vorlesungen | hochwertige Quelle | in Wissensmediathek als Lernindex; Lizenz- und Kommerzialitätsgrenzen sichtbar |
| `Dah7D0iIFiU` | Programmier-Lernplattform | Anbieter nicht eindeutig | nur Kandidat, bis die konkrete Primärquelle feststeht |
| `DaIBlv4InFn` | Tech-Roadmaps und Interviewfragen | sinnvoll als Checkliste | roadmap.sh als Navigationsquelle, nicht als alleiniger Standard |
| `DZ16SSgIWwT` | weitere Sammlung kostenloser Websites | Discovery-only | keine pauschale Übernahme |
| `DZHyMX4Ijcp` | Shortcut-Datenbank | geringer Zusatznutzen | vorerst nicht als Agent; ggf. später Mac-Helper-Referenz |
| `DZFPMklIaLz` | kostenlose Alternativen zu Bezahlsoftware | Discovery-only | jede Alternative separat prüfen |
| `DZM-rtGIZno` | Interview-, CV- und Recruiting-Hilfen | eigener Workflow gerechtfertigt | neuer Recruiting-Agent aktiviert |
| `DbLKQlMo1sX` | WhatsApp + Wissensbasis + CRM + Ticket/Handoff | echte Teillücke | vorhandenen WhatsApp-Agenten um Übergabe-Tickets erweitert |

## Profile – was übernommen wird

- `iamformed`: sichtbare Agentenläufe, Systemgraphen und Workflow-Orchestrierung als Produkt-Benchmark. In IVA bereits weitgehend vorhanden.
- `herr_tech`: wiederverwendbare Skills, Content-Automation und sichtbare Ausführung. Die Muster sind brauchbar; Reichweiten-/Kundenversprechen werden verworfen.
- `setupsai`, `lucaswebq`, `beasttechx`: reine Discovery-Quellen für den Chancenfinder. Zwei Profile rotieren pro Lauf, um Scraping-Kosten zu begrenzen.
- `nickgeringer`: Experiment- und Creative-Testlogik ist brauchbar. Einkommens- und Skalierungsclaims werden nicht übernommen.
- `marine.games22`: Gaming-/Game-Development-Schwerpunkt passt aktuell nicht zu IVAs priorisierten Geschäftsprozessen – keine Integration.
- `adis`: Aus dem öffentlichen Profil ließ sich keine klar abgegrenzte, belegte IVA-Funktion ableiten – keine Integration.
- Doppelt angegebene Profile werden nur einmal geführt.

## Technische Umsetzung

- Capability-Gate `iva-capability-gate-1.0` mit Nutzen-, Doppelungs-, Kosten-, Beleg-, Rechte- und Sicherheitsprüfung.
- Die zentrale IVA und der Marketing-Agent müssen neue Reel-/Tool-Ideen vor einer Empfehlung über dieses Gate prüfen.
- Wissens-Agent aktiviert; kuratierte Mediathek mit Autorität, Status, Rechten, erlaubter Nutzung und Sperren.
- Recruiting-Agent aktiviert:
  - manuelle LinkedIn-Recruiter-Suchpläne,
  - Lebenslaufprüfung gegen explizite Muss-/Kann-Kriterien mit Belegstellen,
  - strukturierte Interviewleitfäden mit einheitlicher Bewertungsrubrik.
- Keine automatischen Zusagen, Absagen, Profil-Scrapes oder Massenansprachen.
- Chancenfinder nutzt die geeigneten Creator-Profile nur als Discovery-Signale und rotiert kostenbegrenzt.
- Content-Agent übernimmt nur abstrakte Muster und sperrt konkrete Text-, Claim-, Layout- und Designkopien.
- Energie-Agent kennzeichnet KI-3D-Bilder ausdrücklich als Konzeptvorschau, nie als technische Berechnungsgrundlage.
- WhatsApp-Agent erzeugt bei Deckungsfragen, Schadenfällen oder gewünschter persönlicher Übergabe ein Ticket mit Grund, Priorität, Owner, Fälligkeit, Verlauf und Status.

## Bewusst nicht eingebaut

- Kein neuer App-Builder-Agent allein aufgrund der Reels. IVA hat bereits die notwendige Entwicklungsarchitektur; der Builder bleibt deaktiviert, bis Git-, Test-, Vorschau-, Deployment- und Rollback-Freigaben technisch getrennt sind.
- Keine Base44-Abhängigkeit. Base44 bleibt ein möglicher Prototyping- oder UI-Benchmark, nicht IVAs führendes Backend.
- Open Generative AI wird nicht pauschal installiert. Der Quellcode ist offen, die vielen Cloud-Modelle benötigen jedoch API-Zugänge/Guthaben; lokale Videoerzeugung benötigt geeignete Hardware.
- Keine ungeprüfte Volltextsammlung aus Kursen, Creator-Profilen oder Tool-Aggregatoren.
