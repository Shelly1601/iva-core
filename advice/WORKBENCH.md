# Finanzplanung und belegter Versicherungsvergleich

Prüfstand: 16. September 2026. Die Arbeitsfläche `/advice-workbench` enthält einen lokalen Finanz-Szenariorechner und dokumentbasierte Versicherungsvergleiche. Sie ruft derzeit **keine Live-Versicherungstarife** ab und stellt keine Anträge. Projektfavoriten ändern niemals Bewertung oder Rang.

## Daten und Abgrenzung

- Projekt und Kunde werden serverseitig über `getProject` und den projektgebundenen `getCustomer(projectId, customerId)` geprüft. Die Routen müssen hinter der vorhandenen Owner-Autorisierung liegen. Die Oberfläche lädt nur `/api/advice/workbench/context`; der Root-Adapter liefert Projekte und die zum ausgewählten Projekt gehörenden Kunden.
- Original-PDFs und Textunterlagen werden bis 8 MB eingelesen. Scans ohne lesbaren Text werden mit `ADVICE_OCR_REQUIRED` zurückgewiesen. Extraktionsvorschläge sind unbestätigte, wörtlich belegte Kandidaten. Sie werden nicht als geprüfte Vertragsleistung übernommen.
- Belege verlangen Dokument-ID, SHA-256, exakten Textauszug und Fundstelle. Ein nachträglich geändertes Dokument oder ein erfundener Auszug zählt nicht als Nachweis. Ein Mensch muss die Übereinstimmung von Vertragswert und Fundstelle bestätigen; die Software behauptet keine semantische Vollprüfung des gesamten Bedingungswerks.
- Versicherungsvergleiche unterstützen Sach, KV, LV und Kfz. Die Kriterienbibliothek liefert je 20 konkrete Prüffragen für Privathaftpflicht, Hausrat, Wohngebäude, Krankenversicherung, Leben/Vorsorge und Kfz. Es werden nur ausdrücklich ausgewählte Fragen mit stabilen IDs ergänzt; bereits vorhandene IDs oder gleiche Bezeichnungen werden nicht doppelt eingefügt. Bestehende Ziele, Gewichtungen und Vertragsnachweise bleiben erhalten. Gewicht 0 nimmt ein Nicht-Muss-Kriterium aus der Bewertung, ohne die Daten zu löschen. Es bleiben höchstens 30 aktive oder inaktive Kriterien je Vergleich möglich. Es gibt keine spartenspezifische Risikoprüfung, Gesundheitsprüfung oder Annahmeentscheidung. Solche Bedingungen müssen anhand der Originalunterlagen in die Kriterien aufgenommen werden.
- Unbekannte oder ungeprüfte Kriterien bleiben offen. Für ein Ranking braucht ein Dokumentangebot gültige Datumsangaben, bestätigten Bezug zum Kundenrisiko, geprüfte Bruttobeiträge und alle Zusatzkosten (auch 0), belegte gewichtete Kriterien und erfüllte Muss-Kriterien. Erst Qualität, dann der Jahrespreis als Gleichstandsentscheidung. Ein Szenario ist nicht rankingfähig.
- Das Ranking vergleicht nur die ausgewählten Kriterien und erfassten Angebote; es ist keine Marktvollständigkeits- oder Eignungsbestätigung.

## Finanzmathematik

`public/advice-finance.js` ist dieselbe reine Implementierung für Browser, Backend und PDF. Jährliche Rendite wird effektiv auf Monate umgerechnet: `(1+r)^(1/12)-1`. Die jährliche laufende Kostenquote wird als monatlich gleichwertiger Kapitalabzug angewandt. Einzahlungen kommen am Monatsende; Einzahlungs-/Entnahme-Dynamik steigt nach jeweils zwölf Phasenmonaten. Einmalkosten, Einzahlungskosten und feste Monatskosten sind separat. Nicht zahlbare feste Kosten werden ausgewiesen statt zu negativem Kapital verrechnet.

Die konfigurierbare Steuerquote wird ausschließlich als Modellannahme einmal am Ende der Ansparphase auf einen positiven modellierten Gewinn angewandt. Freibeträge, Teilfreistellungen, Vorabpauschalen, Kirchensteuer, Produktregeln und individuelle Steuerfolgen sind nicht berechnet. Die Kaufkraft diskontiert mit der angenommenen Inflation über die gesamten vergangenen Monate. Die Entnahmephase weist tatsächlich gezahlte und nicht mehr finanzierbare Entnahmen aus. Nullwerte bleiben erhalten; fehlende, nicht endliche, außerhalb der Grenzen liegende oder gebrochene Monatsangaben werden abgelehnt.

Kunden-PDFs enthalten Eingaben, Kapital- und Kaufkraftverlauf, Jahreswerte, Kosten, Modellsteuer und Grenzen. Ein Kunden-PDF belegt eine Modellrechnung und ist keine Garantie, Produktempfehlung oder Antragsfreigabe.

## Anbieter und Formulare

Die offiziellen Anbieterinformationen wurden am Prüfstand gelesen:

- [blau direkt CaaS](https://docs.blaudirekt.dev/caas/), [Vergleichsrechner-Start](https://docs.blaudirekt.dev/vergleichsrechner/) und [AMEISE OAuth](https://docs.blaudirekt.dev/ameise-apis/auth/) beschreiben unterschiedliche Integrationswege. Ein Portalstart oder ein AMEISE-Zugang belegt keinen funktionierenden CaaS-/Partner-Tarifrücklauf.
- [blau direkt Marketplace](https://www.blaudirekt.de/marketplace/) führt spartenspezifische Partnerlösungen. Die tatsächlichen Freischaltungen, Schnittstellenverträge und Testfälle müssen je Projekt nachgewiesen werden.
- [NAFI Portale](https://www.nafi.de/Produkte/Portale) und [Schnittstellen](https://www.nafi.de/Dienstleistungen/Schnittstellen) beschreiben APIs und MVP-Übergaben für Kfz und Sachsparten. Daraus wird keine KV-/LV-Liveanbindung abgeleitet.

IVA speichert hier nur Portaladresse und beschreibende Projekt-/Vermittlerzuordnung. Passwörter, Tokens und API-Schlüssel gehören nicht in diese Konfiguration. URLs mit typischen geheimen Query-Parametern werden abgelehnt. Es gibt noch keinen implementierten Live-Adapter für diese drei Anbietergruppen; `liveQuotes` und `adapterImplemented` bleiben `false`.

Vorhandene separate EnergyPartner-Integration bereitet Anfragen vor, liefert aber keine erfundenen Tarife. Der GKV-Portalstart ist als Link gekennzeichnet. Die bestehende Mannheimer-PV-Versicherungsvorbereitung ist kein allgemeiner KV/LV/Sach/Kfz-Vergleich.

Anbieterübergaben exportieren ausschließlich lokal die ausgewählten Kunden-/Risikodaten, Notizen und Anforderungen. Interaktive Original-PDFs können über ausdrücklich zugeordnete Felder befüllt werden. Feldwerte werden nach dem Speichern erneut gelesen; Formularinteraktivität bleibt erhalten. Aktive, eingebettete oder bereits signierte Inhalte werden zurückgewiesen. Es gibt keine Einreichungs- oder Versandaktion. Kundenbericht und vorbereitetes Originalformular können zusätzlich ausdrücklich in der zugehörigen IVA-Kundenakte abgelegt werden; erst eine bestätigte Datei-ID gilt als Erfolg.

## API und Speicherung

`createAdviceWorkbench({dataDir,getProject,getCustomer})`; `registerAdviceWorkbenchRoutes(app,{service})`. Alle Beratungsrouten unter `/api/advice/workbench` benötigen `projectId`. Kundenzuordnung ist bei einer bestehenden Akte unveränderlich. Mutationen einer Akte benötigen die aktuelle `expectedRevision`; Konflikte liefern HTTP 409.

Wesentliche Ressourcen: `/catalog`, `/cases`, `/cases/:id`, `/cases/:id/documents`, `/cases/:id/documents/:documentId`, `.../form-fields`, `.../prepare.pdf`, `/cases/:id/report.pdf`, `/cases/:id/preparation/:providerId`, `/favorites`, `/providers/:providerId` und `POST /cases/:id/file` mit `{kind:"report"|"form", expectedRevision, docId?, values?}`. Die optionale `saveCustomerFile`-Dependency speichert erzeugte PDFs über den Root-Adapter in der zugehörigen Kundenakte; ohne diese Dependency wird keine Ablage behauptet. Der ursprüngliche JSON-Upload kann wegen Base64 bis ungefähr 11 MB benötigen; der übergeordnete Server muss diese eine authentifizierte Uploadroute mit 12 MB vor seinem kleineren Standardparser registrieren.

Ablage: `dataDir/advice-workbench/<projectId>.json`, private Dateirechte, Originalbytes und Text nur serverseitig. Öffentliche Aktenantworten enthalten weder Originalbase64 noch Volltext; der Eigentümer kann gezielt den Dokumenttext abrufen. Limits: 200 Akten/Projekt, 30 Dokumente/30 Angebote pro Akte, 150.000 extrahierte Textzeichen pro Dokument und 32 MB Projektablage. Die Ablage ist durch Prozess-Claim und atomaren Dateiaustausch geschützt; sie ist kein Ersatz für eine verschlüsselte Dokumentenablage oder das zentrale Backup.

## Nachweise

- `scripts/verify-advice-workbench.mjs`: 15 Tests zu effektiven Renditen, Kosten, Steuerannahme, Dynamik, Kaufkraft, Entnahme, Cashflow-Identität, Grenzen; Ranking, unbekannten/ungeprüften/ungültigen Angeboten, Muss-Kriterien, Quellen, Scope, Revisionen, Prozessabbruch, Originalformularen, HTTP/PDF sowie der vollständigen Zuordnung der 120 Vorlagen und dem Erhalt vorhandener Nachweise beim Ergänzen/Deaktivieren von Kriterien.
- Bestehende Suiten `verify-advice`, `verify-advice-calculator-audit`, `verify-corporate-benefits`, `verify-energy-calculations`, `verify-pv-price-calculator`, `verify-energy-tariffs` wurden zusätzlich erfolgreich ausgeführt. Die 15 numerischen/Readiness-Untertests sind Teil von `verify-advice-calculator-audit`.
- Isolierter Playwright/Chrome-Test mit synthetischen Kunden: Projekt-/Kundenkontext, Finanzplan speichern und PDF herunterladen, Originaltext hochladen, unbestätigten Beitragsvorschlag übernehmen, Nachweis prüfen, Altvertrag speichern, unbekannte Leistungen offenhalten, Desktop und 390-Pixel-Mobilansicht ohne Überlauf und ohne Browserfehler.
- Synthetische Finanz- und Vergleichs-PDFs wurden gerendert und visuell geprüft; ausgefüllte Original-PDF zusätzlich mit pypdf auf Feldwerte und Widget-AP/AS geprüft. QA-Dateien liegen außerhalb des Repos unter `work/advice-qa` des aktuellen Codex-Tasks. Keine Kundendaten, Providerzugänge, echten Tarifabrufe oder Übermittlungen wurden hierfür verwendet.
