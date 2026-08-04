# IVA Sales Coach – Produktspezifikation

_Stand: 4. August 2026. Zielbild nach Benchmark-Recherche, noch nicht als Live-Aufzeichnung aktiviert._

## Produktentscheidung

Der **IVA Sales Coach** ist kein sichtbarer Meeting-Bot und kein autonomer Verkäufer. Er läuft als persönliche Desktop-Begleitung auf Nadines Rechner, hört nach einem bewussten Start beide Gesprächsseiten, zeigt nur Nadine kurze Live-Hinweise und schreibt das Ergebnis nach Freigabe in die gemeinsame Kunden-/Beratungsakte.

`SalesCloser.ai` ist nur ein Teilbenchmark: Das Produkt lässt einen autonomen KI-Agenten selbst Gespräche/Demos führen. Für IVAs Zielbild passen diese Referenzen besser:

- [Convo](https://www.itsconvo.com/): lokale Audioaufnahme, kein Bot, Einwandantworten aus Dokumenten und vergangenen Gesprächen, CRM-Nachbereitung.
- [CoachMode](https://www.getcoachmode.com/): eine kurze nächste Reaktion pro Einwand, offene Discovery-Punkte, Talk-Ratio und Bewertung nach dem Gespräch.
- [ConversationPilot](https://www.conversationpilot.ai/): diskretes Desktop-Overlay, Live-Scorecard, Kaufsignale und nächstbeste Frage.
- [LiveSuggest](https://livesuggest.ai/sales-meetings/): separates nur für den Verkäufer sichtbares Fenster, Live-Hinweise ohne Meeting-Teilnehmer.
- [Closer](https://closer.tech/): gute Referenz für Gesprächs-Scorecard, CRM-Nachbereitung und Außendienst, aber weniger für das gewünschte Live-Overlay.

## Live-Oberfläche

Das Overlay bleibt klein, ruhig und mit einem Blick erfassbar. Der kleine IVA-Bildschirmagent bleibt sichtbar und zeigt den Zustand, ohne Gesprächsinhalte zu verdecken.

```text
┌ IVA Sales Coach ─ LIVE ─ Bedarfsanalyse ─ 18:42 ┐
│ Gesprächslage  🟢 76/100   Du 43 % · Kunde 57 %  │
│                                                  │
│ 🟡 EINWAND · 58/100 · Preis/Budget               │
│ „Das ist schon deutlich mehr als gedacht.“       │
│                                                  │
│ Sag kurz: „Was genau hatten Sie eingeplant?“      │
│ Stichworte: erst verstehen · nicht rechtfertigen  │
│                                                  │
│ Nächster Hebel: Auswirkung des Nichtstuns klären  │
└──────────────────────────────────────────────────┘
```

Pro Moment gibt es maximal **eine** aktive Empfehlung. Keine Textwand und kein schneller Kartenwechsel, solange Nadine spricht.

### Ampeln

Die Ampel bewertet nicht die Persönlichkeit des Kunden, sondern das aktuell erkennbare Verkaufsrisiko.

| Farbe | Einwand-Risiko | Reaktion |
|---|---|---|
| 🟢 0–34 | Verständnisfrage, schwacher oder bereits gelöster Vorbehalt | ruhig beantworten oder weiterfragen |
| 🟡 35–69 | echter, noch offener Vorbehalt | isolieren, Ursache klären, dann belegen |
| 🔴 70–100 | wiederholter Dealbreaker, Vertrauensbruch, klares Nein, fehlende Entscheidungsmacht oder harte Budgetgrenze | nicht drücken; stoppen, Ursache/Entscheidungsweg klären oder sauber vertagen |

Jede Bewertung zeigt eine kurze Belegstelle und eine Confidence. Intensität, Wiederholung, Wortwahl, Gesprächsphase, Entscheidungsmacht und bisherige Reaktion fließen deterministisch in den Score ein; das Sprachmodell darf ihn erklären, aber nicht frei erfinden.

## Live-Signale

- Einwand erkannt: Typ, Stärke, Wiederholung, Deal-Risiko und ein kurzer Antwortvorschlag.
- Nächstbeste Frage, passend zur aktuellen Gesprächsphase.
- Redeanteil phasenabhängig: In der Bedarfsermittlung wird früher gewarnt als in einer notwendigen Produkterklärung.
- Zu langer Monolog, Unterbrechungen, mehrere geschlossene Fragen hintereinander oder unbeantwortete Kundenfrage.
- Fehlende Punkte: Bedarf, Priorität, Budget, Entscheidungsweg, Zeitplan, bestehende Lösung, nächster Schritt.
- Kaufsignale, Unsicherheit, Vertrauenssignal und ausdrücklich verlangte Bedenkzeit.
- Fachfrage: belegte Antwort aus der freigegebenen Wissensbasis; bei fehlender Quelle nur „prüfen/nachreichen“.
- Im Versicherungsbereich niemals eine Deckungszusage oder rechtlich/fachlich unbelegte Behauptung erzeugen.

## Gesprächsphasen

1. Einstieg und Erwartungsklärung
2. Situation und Bedarf
3. Auswirkungen und Priorität
4. Lösung/Empfehlung
5. Rückfragen und Einwände
6. Entscheidung und nächste Schritte

IVA zeigt die vermutete Phase. Nadine kann sie mit einem Klick korrigieren; die Korrektur verbessert die folgenden Hinweise.

## Technische No-Bot-Architektur

Eine reine PWA kann Audio aus allen Meeting-Apps und Kopfhörern nicht zuverlässig erfassen. Der Zielweg ist deshalb eine kleine **macOS-Begleit-App**:

1. Nadine öffnet in IVA die passende Kunden-/Beratungsakte und startet „Sales Coach“.
2. Die App verlangt Aufnahme-/Systemaudio-Berechtigung und zeigt dauerhaft einen roten Live-Indikator.
3. Mikrofon und Meeting-/Systemaudio werden als getrennte Audioströme erfasst. Auf dem Mac ist das mit Apples ScreenCaptureKit/Core-Audio-Berechtigungen möglich.
4. Streaming-Transkription trennt Nadine und Kunde bereits über die beiden Audiokanäle; Sprecher-Diarisierung ist nur Fallback.
5. Ein schneller Signaldetektor aktualisiert Redeanteil, Phase, Einwände und offene Punkte.
6. Nur bei einem relevanten Ereignis erzeugt IVA eine kurze Antwort aus Gesprächskontext, Kundenakte und freigegebenem Sales-/Produktwissen.
7. Nach Gesprächsende erstellt IVA Zusammenfassung, Einwände, Bedarfe, nächste Schritte, Coaching-Score und einen CRM-Entwurf. Übernahme erst nach Freigabe.

Zielwerte für den Pilot: Transkript unter einer Sekunde, verwertbarer Hinweis in höchstens zwei Sekunden, kein Speichern der Roh-Audiodatei im Standardmodus.

## Einwilligung und Datenschutz-Gate

„Kein Bot im Meeting“ bedeutet nicht „heimlich mithören“. Vor jedem Start wird dokumentiert, dass alle Gesprächspartner der Live-Verarbeitung zugestimmt haben. In Deutschland schützt § 201 StGB das nichtöffentlich gesprochene Wort; deshalb wird der Coach ohne bestätigte Einwilligung nicht aktiv.

Der genaue Hinweis muss zum Speichermodus passen, zum Beispiel:

> „Ich nutze während unseres Gesprächs eine KI-gestützte Assistenz für Live-Notizen und Gesprächsqualität. Der Ton wird dabei verarbeitet, standardmäßig aber nicht als Audiodatei gespeichert. Ist das für Sie in Ordnung?“

- Start erst nach aktiv dokumentiertem „Ja“.
- Standard: flüchtiger Audiopuffer; Roh-Audio nach Verarbeitung verwerfen.
- Transkript und Auswertung nur der richtigen Kundenakte zuordnen.
- Sichtbarer Stop-/Pause-Schalter und Löschmöglichkeit.
- Zweck, Speicherfrist, Anbieter und Auftragsverarbeitung vor Produktivbetrieb juristisch/datenschutzfachlich abnehmen.

## Nach dem Gespräch

- Kurzfassung und Gesprächsphase je Abschnitt.
- Bedürfnisse, Prioritäten, Zahlen und offene Unterlagen.
- Einwände mit Stärke, tatsächlicher Antwort und besserer Alternativantwort.
- Redeanteil, Fragen, Unterbrechungen, längste Monologe und ungenutzte Kaufsignale.
- Vereinbarte nächste Schritte mit Datum und Verantwortlichem.
- Beratungs-/CRM-Entwurf, Follow-up-Mail oder WhatsApp-Entwurf – nie automatisch versenden.
- Persönliche Lernkarte: genau ein bis drei Hebel für das nächste Gespräch.

## MVP-Reihenfolge

### Phase 1 – Nadine-Pilot auf dem Mac

- Manuelles Start/Stop mit Einwilligungs-Häkchen.
- Meeting-/Systemaudio + Mikrofon, ohne Bot-Teilnehmer.
- Live-Transkript, Redeanteil und Gesprächsphase.
- Einwandkarte mit Ampel, Belegstelle und maximal einer empfohlenen Reaktion.
- Keine dauerhafte Audioablage und kein automatischer CRM-Schreibzugriff.

### Phase 2 – Kunden- und Wissenskontext

- Start aus der Kunden-/Beratungsakte.
- Qonekto-/CRM-Stammdaten und ausgewählte Verträge rein lesend laden.
- Eigene Gesprächsleitfäden, Einwandbibliothek und freigegebene Fachquellen per Retrieval.
- Nachbereitung als bestätigungspflichtiger CRM-/Beratungsakten-Entwurf.

### Phase 3 – Lernen und Teamfähigkeit

- Nadine bewertet Vorschläge mit hilfreich/nicht hilfreich und speichert bessere Formulierungen.
- Persönliche Erfolgsbibliothek statt ungeprüftem Lernen aus jedem Gespräch.
- Score-Trends, häufige Einwände, Rollenspiele und Vorbereitung auf kommende Termine.
- Später Windows-Version und optionales Team-Dashboard.

## Vor dem Bau noch festzulegen

- Primärer Meetingweg: Zoom-Desktop, Google Meet oder Microsoft Teams.
- Ob im Pilot nur Online-Meetings oder zusätzlich Vor-Ort-Gespräche unterstützt werden.
- Welche Verkaufs-/Einwandmethodik IVA zuerst verwendet und welche Formulierungen Nadine freigibt.
- Ob nur das strukturierte Ergebnis oder zusätzlich ein vollständiges Transkript gespeichert werden soll.
- Streaming-Transkriptionsanbieter nach einem echten Latenz-, Deutsch- und Kostentest auswählen.

