# HEAT HERO – täglicher Förderlauf

Verbindlicher Stand: 27.08.2026. Dieser Ablauf läuft täglich um 05:00 Uhr Europe/Berlin ausschließlich auf `imac-nadine`. MacBook, iPhone und IVA-Chat sind nur Fernsteuerungen. Der Railway-Scheduler reiht genau einen iMac-Auftrag ein; der lokale iMac führt die drei Schritte strikt nacheinander aus.

## Feste Reihenfolge und Namen

1. **Förderung 1 – Vollständigkeit & Unterlagen**
2. **Förderung 2 – Förderhöhe prüfen**
3. **Förderung 3 – KfW-Zusagen prüfen**

Schritt 2 startet erst nach dem Abschlussprotokoll von Schritt 1. Schritt 3 startet erst nach dem Abschlussprotokoll von Schritt 2. Ein Fehler in einem Deal blockiert nicht automatisch andere eindeutig bearbeitbare Deals; der betroffene Deal bleibt jedoch ohne Folgeaktion und erscheint im Bericht.

Ein Teilprotokoll mit Status `partial` ist ein gültiger Abschluss des jeweiligen Schritts und lässt die nachfolgenden Workflows für alle dort eindeutig prüfbaren Fälle weiterlaufen. Nur ein technischer Gesamtblocker mit Status `blocked` – etwa ein CAPTCHA vor jedem Zugriff – stoppt die Reihenfolge. Ein einzelner nicht ladbarer Deal darf Workflow 2 und 3 nicht pauschal verhindern.

## Globale Regeln

- Nichts aus Outlook, Pipedrive, der Google-Tabelle oder einem anderen Fachsystem löschen. Einzige ausdrücklich freigegebene Ausnahme: Nach verifiziertem Ersatz-Upload dürfen ausschließlich die exakt zugehörigen IVA-Arbeitskopien innerhalb des verwalteten Förderordners endgültig lokal entfernt werden. Fremde Dateien und der übrige Benutzer-Papierkorb bleiben unangetastet; der gesamte Papierkorb wird nie pauschal geleert.
- Kundenmails werden bis zu einer neuen ausdrücklichen Freigabe ausschließlich als Outlook-Entwurf im Konto `foerderung@heat-hero.com` angelegt. Es gibt in diesem Ablauf keinen Kundenmail-Versand.
- Mails gehen an die eindeutige Kundenadresse im An-Feld und an die eindeutige VP-Adresse im CC. Fehlt eine davon, wird nicht geraten. Der Entwurf bleibt bei fehlender Kundenadresse blockiert; ein fehlendes VP-CC wird sichtbar gemeldet.
- Vor jeder Anforderung werden der vollständige Deal, alle Notizen, alle Dateien, die TMB und alle eindeutig zugeordneten Fördermails geprüft.
- Zuordnung nur anhand exakter Auftragsnummer oder eindeutig passendem vollständigem Kundennamen. Gleichnamige oder widersprüchliche Treffer bleiben manuell.
- Notizen beginnen mit der wichtigsten Aussage in der ersten sichtbaren Zeile und enden exakt mit `(Notiz von Nadine via KI)`. Fremde Notizen werden nie geändert oder gelöscht. Eine inhaltlich unveränderte IVA-Notiz wird nicht dupliziert.
- Normale Pipedrive-Anmeldungen erledigt der iMac selbstständig. Bei der Gerätefrage werden andere Sitzungen abgemeldet. CAPTCHA, Kontosperre oder eine technisch erzwungene externe Bestätigung werden als konkreter Blocker gemeldet.
- KfW-Passwörter, OTPs und Steuerdaten erscheinen nie in Berichten, Logs oder Prompts.
- Alle sichtbaren Rechneraktionen laufen ausschließlich auf dem physisch rechten Display. IVA öffnet dafür eigene Chrome-Fenster und Tabs rechts und verwendet kein vorhandenes Pipedrive-, Planbar-, Outlook- oder WhatsApp-Fenster links. Fehlt das rechte Display oder kann das Zielfenster dort nicht verifiziert werden, wird der Lauf konkret blockiert; es gibt keinen Rückfall auf links.
- Jeder Schreibschritt wird nach dem Speichern erneut gelesen und verifiziert. Kein Folgeschritt bei unbestätigter Änderung.
- Vor der ersten vollständigen Deal-Folgeaktion wird die Google-Liste einmal auf die eindeutigen Spalten `Kundename` (Alias `Name`), `Datum` und `Bemerkung` geprüft. Fehlt eine Spalte oder ist sie doppelt, werden weder Deal-Weiterbewegung noch WhatsApp noch Tabellenzeile für den betroffenen vollständigen Deal ausgelöst; der Bericht nennt die fehlende Überschrift. Werte werden niemals ersatzweise in eine andere Spalte geschrieben. Live am 27.08.2026 verifiziert: `✓`, `Kundename`, `Bemerkung`, `Datum`; die Spaltenreihenfolge wird nicht fest angenommen, sondern über die Überschriften aufgelöst.
- Eine bearbeitete Fördermail wird erst nach vollständig verifiziertem Datei-Upload und – falls ihr Text fachlich relevant ist – nach verifiziertem Pipedrive-Vermerk in den Outlook-Unterordner `fertig` verschoben. Unklare, nur teilweise bearbeitete oder fehlerhafte Mails bleiben im Posteingang. Der Zielordner wird nach dem Verschieben erneut geprüft; der Nachrichtenfingerprint verhindert Wiederholungen. Verschieben ist ausdrücklich erlaubt, Löschen bleibt verboten.

## Förderung 1 – Vollständigkeit & Unterlagen

### Angebot veröffentlicht

1. Alle Deals in `Angebot veröffentlicht` prüfen.
2. Nur wenn die Unterschrift im Angebot visuell eindeutig vorhanden ist, Auftragsnummer und verbaute Anlage aus diesem Dokument auslesen.
3. Leere Felder `Auftragsnummer` und `Anlage` befüllen. Bestehende widersprüchliche Werte nicht überschreiben.
4. Telefonnummer und Kunden-E-Mail in den Dealinformationen prüfen. Fehlt ein Wert, die TMB vollständig prüfen und nur einen eindeutigen belegten Wert übernehmen.
5. Nach erfolgreicher Schreib-/Leserückprüfung in `Antrag eingereicht / Förderunterlagen einreichen` verschieben.

### Förderunterlagen und Postfach

Beim ersten produktiven Lauf werden alle Deals der Zielphasen und alle sichtbaren, zuordenbaren Nachrichten im Förderpostfach als Ausgangsbestand geprüft. Danach werden Nachrichtenfingerprints und Dealstände inkrementell verarbeitet; offene Deals werden trotzdem täglich erneut auf Vollständigkeit geprüft.

- Anlagen aus `foerderung@heat-hero.com` lokal in einem IVA-Arbeitsordner prüfen, in PDF umwandeln, Dokumenttypen getrennt halten und eindeutig benennen.
- Bereits im Deal vorhandene Dateien werden ebenfalls heruntergeladen und inhaltlich geprüft: echtes PDF, lesbar/renderbar, vollständig, richtiger Dokumenttyp und eindeutige Standardbezeichnung. Bei falschem Format oder Namen wird eine korrigierte PDF-Arbeitskopie erzeugt, hochgeladen und im Deal erneut gelesen. Die alte Pipedrive-Datei bleibt wegen des Löschverbots bestehen. Erst danach werden nur die verwalteten lokalen Arbeitskopien endgültig entfernt und die Entfernung verifiziert.
- Personalausweis-Vorder- und -Rückseite werden gemeinsam in einer PDF gespeichert. Unterschiedliche Unterlagen werden nie in eine Sammel-PDF gepackt.
- Erst nach erfolgreichem Upload und erneuter Pipedrive-Dateiprüfung gilt ein Maildokument als vorhanden.
- Fachlich relevanter Mailtext wird als konkrete Pipedrive-Informationsnotiz mit Quelle und dem festen Notizabschluss hinterlegt. Erst wenn Dateien und gegebenenfalls Text im richtigen Deal erneut gelesen wurden, die Mail nach `fertig` verschieben.
- Pflichtunterlagen: unterschriebenes Angebot, Personalausweis Vorder-/Rückseite, möglichst aktuelle Meldebescheinigung, vollständiger leserlicher Grundbuchauszug, bestätigtes KfW-Konto. Bei beantragtem Einkommensbonus zusätzlich Einkommensteuerbescheide 2023 und 2024.
- Neue oder geänderte vollständige KfW-Zugangsdaten werden genau einmal auf `meine.kfw.de` getestet. Erfolg: sofort abmelden. Ablehnung: kein zweiter Versuch mit demselben Passwort. Ergebnis als erste Notizzeile mit ✅, ❌ oder ⚠️; keine Zugangsdaten in der Notiz wiedergeben.
- Fehlt etwas, den freigegebenen Text aus `renderFundingMissingDocumentsEmail` als Outlook-Entwurf an Kunde, VP im CC, erzeugen. Keine Zustellung.
- Zusätzlich täglich tatsächlich versandte Fehlunterlagen-Mails prüfen. Ab dem echten Versandzeitpunkt laufen sieben volle Kalendertage. Hat danach weder der Kunde noch der zugeordnete VP im Mailverlauf geantwortet, die ursprüngliche Mail genau einmal als echten Outlook-Weiterleitungsentwurf samt Originalinhalt vorbereiten: bei Vertriebsstruktur `EKD` oder eindeutigem EKD-Domainhinweis an `k.bolz@heat-hero.com`, sonst an `p.germer@heat-hero.com`. Dafür ausschließlich den verifizierenden CLI-Pfad `create-funding-escalation-forward ... --commit` verwenden; eine neu geschriebene Ersatzmail gilt nicht als Weiterleitung. Eine vorhandene Antwort stoppt die Eskalation. Entwurfsdatum, Deal-ID und ursprünglicher Versandzeitpunkt bilden die Deduplizierungskennung; auch diese interne Mail wird vorerst nicht versandt.
- Ist alles vollständig: erst nach erneuter Komplettprüfung nach `Förderung beantragt` verschieben; dann über die native WhatsApp-App genau einmal an Viktoria Lambel `VOLLSTÄNDIGER KUNDENNAME AUFTRAGSNUMMER fertig` senden und sichtbar verifizieren.
- Danach den Kunden genau einmal in die Tabelle `1XPlBa5XgBixML0RquR_kwIwyxTDqRtpfXAudYimKB_8` eintragen: nur `Kundename` (beziehungsweise vorhandener Alias `Name`), heutiges `Datum`, `Bemerkung` leer. Vor dem Eintrag nach Name plus Auftragsnummer/Deal-ID im Laufzustand deduplizieren; keine vorhandene Tabellenzeile löschen oder überschreiben.

## Förderung 2 – Förderhöhe prüfen

- Aktueller Regelstand für Anträge ab 21.07.2026: offizielles KfW-458-Merkblatt Stand 07/2026. Anträge bis einschließlich 20.07.2026 bleiben im separaten früheren Regelwerk; bei unbekanntem Antragsdatum keine endgültige Zahl.
- Preisquelle: unterschriebenes Angebot mit sichtbarer Unterschrift. Fehlt es, Auftragsnummer aus den Dealinformationen nehmen und das exakt passende Originalangebot verwenden. Ohne eindeutige Preisquelle nur GELB.
- Für einen Antrag 2026 wird der Durchschnitt des zu versteuernden Einkommens aus 2023 und 2024 der relevanten erwachsenen Haushaltsmitglieder verwendet. Minderjährige werden nicht zum Einkommen addiert.
- Leben laut belastbarer Information mehr als zwei Personen in einem EFH, zuerst alle Dealquellen nach einem minderjährigen, kindergeldberechtigten Kind prüfen. Nur wenn die Information danach offen bleibt, den dafür vorgesehenen Kundenentwurf mit VP im CC anlegen.
- EFH/MFH, Anzahl abgeschlossener Wohneinheiten, Eigennutzung, WEG/ungeteiltes MFH und gegebenenfalls Miteigentumsanteil müssen belegt sein. Unsicherheit steht in der Notiz; es wird nicht geraten.
- MFH: Förderhöchstbetrag 28.000 Euro für die erste, je 15.000 Euro für die zweite bis sechste und je 8.000 Euro ab der siebten Wohneinheit. Grundförderung auf das Gebäude; persönliche Boni nur für eine selbst genutzte Wohneinheit. Beim ungeteilten MFH gleichmäßige Verteilung, bei WEG Miteigentumsanteil, jeweils begrenzt durch den gleichmäßig verteilten Förderhöchstbetrag.
- Grundförderung 30 %, Klimageschwindigkeitsbonus derzeit 16 %, Einkommensbonus 10/30/40 % nach aktuellem KfW-Regelwerk. Grund- und Bonusförderung grundsätzlich maximal 70 %, im höchsten Einkommensbonus-Bereich maximal 80 %.
- EFH-Notiz: Prozentsatz zuerst. MFH-Notiz: Zuschussbetrag in Euro zuerst. Danach Rechenweg, Quellen, Regelstand, offene Punkte und Ampel. Abschluss immer `(Notiz von Nadine via KI)`.
- Eine endgültige GRÜNE Zahl setzt widerspruchsfreie Angaben und bestätigte BzA-förderfähige Kosten voraus. Angebotspreis ohne BzA bleibt ausdrücklich GELB/vorläufig.

## Förderung 3 – KfW-Zusagen prüfen

1. Alle Deals in `Förderung beantragt` prüfen.
2. Nur ein eindeutig lesbares offizielles KfW-Zusageschreiben im richtigen Deal akzeptieren. Allgemeine KfW-Mails, Antragsbestätigungen oder Zugangsdaten sind keine Zusage.
3. Deal über `Gewonnen` und das anschließende Speichern bestätigen.
4. Status erneut lesen. Erwartetes Ergebnis ist `Gewonnen` beziehungsweise die daraus ausgelöste Phase `Montage einplanen`. Bei abweichendem Ergebnis keine Wiederholung auf Verdacht, sondern konkreten Blocker melden.

## Tagesbericht

Nach jedem vollständigen 05:00-Lauf wird ein kurzer, kontrollierbarer Telegram-Bericht erzeugt und im Heat-Hero-Projektprotokoll gespeichert. Er enthält je Workflow Status und je Deal: Kunde/Deal, geprüfte Quellen, Uploads, Feldänderungen, Entwürfe, Phasenwechsel, WhatsApp-/Tabellenaktion, Förderergebnis beziehungsweise Zusage sowie offene Punkte. Auch ein Lauf ohne Änderung wird gemeldet. Geheimnisse und vollständige Steuerdaten sind ausgeschlossen.
