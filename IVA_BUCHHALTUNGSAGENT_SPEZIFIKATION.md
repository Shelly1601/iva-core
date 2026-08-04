# IVA Buchhaltungsagent – Produktspezifikation

_Stand: 4. August 2026. Zielbild und sicherer MVP-Rahmen; noch keine automatische Buchung oder Steuerübermittlung aktiviert._

## Produktentscheidung

Der **IVA Buchhaltungsagent** ist Nadines laufender Beleg-, Ordnungs- und Vorbereitungspartner. Er sammelt Belege, liest sie aus, ordnet sie der richtigen Firma und Zahlung zu, fragt fehlende Angaben sofort ab und bereitet eine nachvollziehbare Übergabe an Buchhaltungssoftware und Steuerberatung vor.

Er soll die Frage „Kann das betrieblich relevant sein und was fehlt noch?“ früh beantworten. Er gibt aber keine unbelegte Zusage „Das kannst du sicher absetzen“ und reicht nichts ungeprüft beim Finanzamt ein.

## Das gewünschte Arbeitserlebnis

1. Nadine fotografiert einen Beleg, lädt eine PDF/XML-Datei hoch oder leitet eine Rechnung an einen eigenen Beleg-Posteingang weiter.
2. IVA erkennt Lieferant, Datum, Leistungszeitraum, Rechnungsnummer, Netto, Umsatzsteuer, Brutto und Zahlungsart.
3. IVA fragt nur das nach, was wirklich fehlt: „Für welche Firma?“, „Was war der geschäftliche Anlass?“, „Wer war dabei?“, „Wie hoch ist der private Anteil?“ oder „Bitte fordere eine korrigierte Rechnung an.“
4. Der Beleg erhält eine Ampel, Begründung, Quelle und Confidence.
5. IVA gleicht ihn später mit Bank-/Kartenumsätzen ab, erkennt Dubletten und zeigt fehlende Belege.
6. Nach Nadines Review entsteht ein sauberer Monatsordner beziehungsweise Export für Steuerberater, DATEV oder eine gewählte Buchhaltungssoftware.

Der kleine IVA-Bildschirmagent bleibt auch in diesem Bereich sichtbar und zeigt zum Beispiel „3 Belege brauchen noch eine Angabe“.

## Ampellogik pro Beleg

| Farbe | Bedeutung | Beispielreaktion |
|---|---|---|
| 🟢 vollständig | klarer betrieblicher Zusammenhang, richtiger Rechtsträger, Beleg vollständig und Zahlung zugeordnet | zur Monatsfreigabe vormerken |
| 🟡 prüfen | plausibel, aber gemischte Nutzung, fehlender Anlass, fehlende Rechnungsangabe oder unsichere Zuordnung | genau eine gezielte Rückfrage stellen |
| 🔴 nicht buchen/eskalieren | privat, falsche Firma, Dublette, widersprüchlicher Beleg, fehlende Rechnung oder rechtlich besonders prüfungsbedürftig | sperren und Steuerberater-/Korrekturhinweis anzeigen |

Jede Einstufung speichert:

- erkannten Sachverhalt und Originalquelle,
- vorgeschlagene Kategorie und Rechtsträger,
- geschäftlichen Zweck,
- mögliche Privatquote beziehungsweise nicht abziehbaren Anteil,
- fehlende Nachweise oder Rechnungsangaben,
- angewandte Regel mit Versionsstand,
- Confidence und manuelle Entscheidung,
- vollständiges Änderungs-/Freigabeprotokoll.

## Was IVA sinnvoll vorbereiten kann

### Belege und E-Rechnungen

- Foto, PDF, E-Mail-Anhang, ZUGFeRD und XRechnung einlesen.
- Das **Original** unverändert aufbewahren; bei E-Rechnungen bleibt das strukturierte Format die führende Quelle, eine PDF-Ansicht ist nur die Darstellung.
- Pflichtangaben, Beträge, Steuersätze und rechnerische Plausibilität prüfen.
- Dubletten über Rechnungsnummer, Lieferant, Betrag, Datum und Dateihash erkennen.
- Korrekturanfrage als Entwurf erzeugen, aber nicht automatisch versenden.

### Zuordnung und Rückfragen

- Goals & Concepts, weitere Unternehmen/Projekte und Privat strikt getrennt führen.
- Kostenstelle/Projekt, Kategorie, Zahlungsweg und möglichen privaten Anteil vorschlagen.
- Bewirtung: Anlass und Teilnehmer abfragen und Rechnung zuordnen.
- Reise/Fahrt: Termin, Strecke, Zweck und zugehörigen Kunden/Projektbezug erfassen.
- Wiederkehrende Software-/Abo-Belege erkennen und fehlende Monate melden.
- Bank-/Kartenumsatz mit Beleg abgleichen; unklare Treffer nicht automatisch fest buchen.

### Typische Prüfkandidaten für Selbstständige

IVA hält dafür strukturierte Checklisten bereit, entscheidet aber immer anhand der tatsächlichen betrieblichen Veranlassung und Nachweise:

- Hardware, Büroausstattung und Arbeitsmittel,
- Software, KI-Tools, Cloud- und Telekommunikationskosten,
- Telefon/Internet mit dokumentiertem betrieblichen Anteil,
- Website, Werbung, Content, Druck und Veranstaltungen,
- fachliche Fortbildung, Literatur und Mitgliedschaften,
- Versicherungen, Bankgebühren, Buchhaltung und Steuerberatung,
- Fremdleistungen, Freelancer und Personalaufwand,
- Geschäftsreisen, Fahrten und Reisekosten,
- Bewirtung und Geschenke mit den jeweiligen Sonderregeln,
- Büro, Coworking sowie häusliches Arbeiten nur nach passender Voraussetzung und Dokumentation.

Diese Liste ist eine Eingangskontrolle, keine pauschale Absetzbarkeitszusage.

## Monatsablauf

```text
Beleg-Inbox
  → Original sichern + auslesen
  → Firma/Kategorie/Zahlung vorschlagen
  → fehlende Angaben nachfragen
  → Bank-/Kartenumsatz abgleichen
  → Nadines Review
  → Steuerberater-/Software-Export
  → Monatsstatus + offene Punkte
```

Das Monatscockpit zeigt:

- neue, vollständige und ungeklärte Belege,
- Umsätze ohne Beleg und Belege ohne Zahlung,
- mögliche Dubletten,
- Umsatzsteuer-/Vorsteuer-Vorschau mit Datenlücken,
- EÜR-/Ergebnisvorschau oder später BWA-Daten aus dem führenden System,
- Liquidität, wiederkehrende Kosten und ungewöhnliche Preissteigerungen,
- Fristen als Erinnerung, nicht als autonome Einreichung.

## Sicherheits- und Steuer-Gates

- Kein Beleg wird endgültig verbucht, verworfen oder einer anderen Firma zugeordnet, ohne Review beziehungsweise eine ausdrücklich freigegebene Regel.
- Keine automatische Umsatzsteuer-Voranmeldung, EÜR, Steuererklärung, Zahlung oder ELSTER-Übermittlung im MVP.
- Individuelle Zweifelsfälle gehen als kompakte Frage mit Beleg und Begründung an den Steuerberater.
- IVA darf für Nadines eigene Abläufe Informationen strukturieren und mögliche Regeln anzeigen. Wird das später als Produkt für fremde Mandanten angeboten, muss die Grenze zur geschäftsmäßigen Hilfeleistung in Steuersachen vorab rechtlich geklärt und gegebenenfalls mit befugten Steuerberatern umgesetzt werden.
- Steuer- und Kategorisierungsregeln sind versioniert und quellenbezogen; sie werden nicht aus freien Modellantworten erzeugt.
- Originalbelege, personenbezogene Daten und Bankdaten werden verschlüsselt, getrennt nach Rechtsträger gespeichert und nur rollenbasiert angezeigt.
- Löschung, Buchung, Export und Versand stehen im Audit-Log. Bankwerte werden in Vorschauen maskiert.

## Technische Architektur

### Führende Systeme

IVA ist zunächst die Arbeits- und Klärungsoberfläche, nicht automatisch das steuerliche Hauptbuch. Nach Auswahl des Zielsystems wird festgelegt, ob DATEV, lexoffice, sevdesk oder ein anderes System die führende Buchführung hält. IVA speichert dann Quell-ID, Sync-Zeitpunkt und Freigabestatus statt eine widersprüchliche zweite Buchhaltung zu erzeugen.

### Datenbausteine

- `entities`: Rechtsträger/Firma, Steuermerkmale, Konten und Exportziel.
- `documents`: unverändertes Original, Hash, Typ, Extraktion und Aufbewahrungsstatus.
- `expenses`: Zuordnung, Kategorie, betrieblicher Zweck, Privatanteil, Steuerstatus und Confidence.
- `transactions`: Bank-/Kartenumsätze mit Importquelle und Matchingstatus.
- `clarifications`: offene Rückfragen, Antworten und Belege.
- `rules`: versionierte, freigegebene Regeln mit offizieller Quelle.
- `exports`: Zielsystem, Zeitraum, Prüfer, Ergebnis und unveränderliches Protokoll.

Bank- und Buchhaltungszugänge gehören ausschließlich als Secrets in Railway beziehungsweise in einen geeigneten Secret Store. Keine Zugangsdaten im Browser, Prompt oder Belegtext.

## MVP-Reihenfolge

### Phase 1 – Beleg-Inbox und Ordnung

- Upload/Kamera/E-Mail-Weiterleitung für PDF, Bild und E-Rechnung.
- Originaldatei, Hash, OCR/Extraktion und Pflichtfeldprüfung.
- Firma, Kategorie, Zweck und Ampel mit gezielten Rückfragen.
- Monatsansicht, Dublettenprüfung und neutraler CSV-/Belegexport.

### Phase 2 – Zahlungen und Buchhaltungsziel

- Bank-/Kartenimport zunächst per CSV, später über einen freigegebenen Banking-Connector.
- Beleg-Umsatz-Matching und Liste fehlender Nachweise.
- Zielsystem anbinden; zuerst lesend/testweise exportieren, erst danach bestätigte Schreibvorgänge.

### Phase 3 – Steuerberater-Loop

- Steuerberaterzugang oder DATEV-kompatibler Übergabekanal.
- Rückfragen, Korrekturen und Freigaben direkt am Beleg.
- Monatsabschluss-Checkliste und exportierbares Prüfprotokoll.

### Phase 4 – Assistenz und Controlling

- Regelmäßige Kosten, Liquidität, Budgetabweichungen und Einsparhinweise.
- Lernende Vorschläge nur aus von Nadine/Steuerberater bestätigten Entscheidungen.
- Fristen und Vorbereitung weiter automatisieren; Einreichung bleibt eine bewusste, kontrollierte Aktion.

## Vor dem technischen Bau noch erforderlich

- alle getrennt zu führenden Rechtsträger/Firmen,
- Gewinnermittlungsart je Rechtsträger (zum Beispiel EÜR oder Bilanz),
- Umsatzsteuerstatus und Voranmeldungsrhythmus,
- aktuelle Buchhaltungssoftware beziehungsweise bevorzugtes Zielsystem des Steuerberaters,
- gewünschter Eingang: Upload, eigene Beleg-E-Mail und/oder bestehende Postfächer,
- Bank-/Kartenquellen und gewünschter Startzeitraum,
- Freigabe, ob vollständige Transaktionen oder zunächst nur CSV-Dateien verarbeitet werden.

Diese Angaben sind für das Zielsystem wichtig, blockieren aber nicht den Bau des neutralen Beleg-Inbox-MVP.

## Verbindliche offizielle Grundlagen für die Regelbibliothek

- [§ 4 EStG – Betriebsausgaben und besondere Abzugsgrenzen](https://www.gesetze-im-internet.de/estg/__4.html)
- [§ 12 EStG – nicht abziehbare private Lebensführung](https://www.gesetze-im-internet.de/estg/__12.html)
- [§ 14 UStG – Rechnung und strukturierte E-Rechnung](https://www.gesetze-im-internet.de/ustg_1980/__14.html)
- [§ 15 UStG – Voraussetzungen des Vorsteuerabzugs](https://www.gesetze-im-internet.de/ustg_1980/__15.html)
- [§ 147 AO – geordnete Aufbewahrung und Fristen](https://www.gesetze-im-internet.de/ao_1977/__147.html)
- [BMF – GoBD, Änderung vom 11. März 2024](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Weitere_Steuerthemen/Abgabenordnung/AO-Anwendungserlass/2024-03-11-aenderung-gobd.html)
- [BMF – Einführung der obligatorischen E-Rechnung](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/2024-10-15-einfuehrung-e-rechnung.pdf?__blob=publicationFile&v=4)
- [§ 2 StBerG – Grenze geschäftsmäßiger Hilfeleistung in Steuersachen](https://www.gesetze-im-internet.de/stberg/__2.html)
- [§ 33 StBerG – Aufgaben des Steuerberaters](https://www.gesetze-im-internet.de/stberg/__33.html)

