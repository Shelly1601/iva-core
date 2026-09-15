# Gemeinsame Kundenbetreuung

Der Kern in `customer-care/service.js` erzeugt projektgebundene Jahreschecks, Vertragsanlässe, freie Kampagnen und monatliche Beraterübersichten. Er startet beim Import keine Arbeit und enthält keinen direkten Netzwerk- oder E-Mail-Zugriff. HTTP-Autorisierung, die autoritative Kundenquelle, Geräteaufträge und Scheduler werden vom IVA-Core angebunden.

## Service

`createCustomerCareService({ dataDir, getCustomers, getProject, deliver, getOptimizationQuote, publicOrigin, now })` liefert:

- `getDashboard({projectId,workspaceId?,customerId?,month?})`
- `updateSettings(scope,settings)`, `updateCustomerCare(scope,customerCare)`
- `addContract(scope,contract)`, `createCampaign(scope,campaign)`, `updateCampaign(scope,id,patch)`
- `runDue({projectId})`
- `listPendingDeliveries({projectId?})`, `getDeliveryEnvelope(outboxId,{projectId?})`, `completeDelivery(outboxId,receipt,{projectId?})`
- `getPublicCheckup(token)`, `submitPublicCheckup(token,input)`, `revokePublicCheckup(scope,tokenId)`

Projekt- und Kundenkennungen stammen aus autorisierten serverseitigen Daten. `getProject(projectId)` liefert das vorhandene Projekt oder null. `getCustomers(scope)` liefert vollständig gelesene Kunden `{id,workspaceId?,projectId?,name,email,emailAuthorized,topics,care?}`. Eine Adresse allein erteilt keine Versandfreigabe. Identische IDs in verschiedenen Projekten bleiben getrennt. `dataDir` ist ein absoluter, vom Server festgelegter Pfad.

## Regeln und Oberfläche

Einstellungen:

```json
{
  "enabled": false,
  "deliveryMode": "auto",
  "annualCheckup": {"enabled": true, "month": 1, "day": 15},
  "optimization": {"enabled": true, "leadDays": 60},
  "monthlySummary": {"enabled": true, "day": 1},
  "senderEmail": "",
  "advisorEmail": "",
  "bookingUrl": "",
  "landingUrl": "",
  "signature": "",
  "imprint": ""
}
```

Kundenoverrides: `enabled`, `annualCheckupEnabled`, `optimizationEnabled`, `preferredMonth`, `emailAuthorized`, `topics`. `null` bei den beiden Fachregeln erbt die Projektregel. Ein explizit leeres Themenarray löscht die bisherige Themenzuordnung. Die gesamte Kundenbetreuung und die Projektregel müssen aktiv sein; eine individuelle Aktivierung übergeht keine ausgeschaltete Projektregel.

Ein Vertrag besitzt `id?`, `product`, `provider`, `topic`, `renewalDate` (`YYYY-MM-DD`), `noticeDays`, `monthlyCost?`, `idempotencyKey?`. Der gewählte Kunde wird serverseitig eingesetzt. Der Optimierungsanlass liegt **Kündigungsfrist plus Vorlauf vor dem Verlängerungsdatum**: `renewalDate - noticeDays - leadDays`. Nach der Kündigungsfrist wird kein aktueller Wechselanlass mehr erzeugt. Das ist Terminplanung, keine Behauptung, dass eine konkrete Kündigung fachlich oder rechtlich wirksam wäre.

Kampagnen: `name`, `subject`, `body`, `topics:[]`, `recipientIds:[]`, `workspaceId?`, `enabled`, `idempotencyKey?`, `schedule`. Leere Filter bedeuten alle freigegebenen Kunden dieses Projekts. Root kann denselben Text mit demselben Idempotency-Key ausdrücklich an mehrere ausgewählte Projekte übergeben; die Deduplizierung gilt pro Projekt.

Zeitpläne:

- `{"type":"once","at":"2026-10-01T08:00:00Z","from":"2026-10-01","to":"2026-10-07"}`
- `{"type":"annual","month":10,"day":1}`
- `{"type":"contract","leadDays":45}`

`from`/`to` sind optional und gelten inklusive als Berliner Kalendertage. Vertragskampagnen verwenden ebenfalls die Kündigungsfrist. Einmalige Kampagnen fixieren beim ersten fälligen Lauf ihre damalige autorisierte Empfängerliste; später hinzugefügte Kunden werden nicht nachträglich angeschrieben. POST-Wiederholungen mit gleichem Idempotency-Key erzeugen keinen zweiten Vertrag oder keine zweite Kampagne; abweichende Daten unter demselben Schlüssel werden zurückgewiesen.

Das Dashboard liefert die vereinbarten Felder `settings`, `customer:{id,name,care}`, `readiness`, `contracts`, `monthly`, `notifications`, `recent`, `campaigns` sowie `responses`. `monthly` enthält zwölf Monatsgruppen `{month,label,count,items}` ab dem angefragten Monat. Anlässe tragen echten `sent`/`queued`/`uncertain`/`cancelled`-Status aus dem Versandjournal, soweit vorhanden. `responses` enthält nur kundenbezogene Antworten und Fragen, Beratungswunsch und Zeitpunkt, niemals den Bearer-Token oder dessen Hash.

## Persönlicher Checkup

Einladungen enthalten einen zufälligen 256-Bit-Token und gelten 30 Tage. Die Tokenauflösung verwendet SHA-256. Die Versandhülle enthält naturgemäß den persönlichen Link und ist ausschließlich dem autorisierten internen Versandadapter zugänglich. Projekt- und Kundensperren, Ablauf und Widerruf werden bei jedem öffentlichen Abruf geprüft.

Standardlink: `${publicOrigin}/checkup/${token}`. Bei einer konfigurierten HTTPS-Landingpage: `${landingUrl}#${token}`. Der Fragmenttoken gehört ausschließlich in die lokale Einbettung des persönlichen Formulars; externe Analytik oder Drittanbieter dürfen ihn nicht erhalten.

GET liefert `{status:'active',project:{name,accentColor},intro,kind,questions,offer}`. Es gibt vier feste Fragen, Typen `single`, `multi`, `text`, Antwortoptionen `{value,label}`. Es werden keine E-Mail-Adressen oder fremde Kundeninformationen ausgegeben. Nach Abschluss ist `status:'submitted'`, einschließlich gespeichertem `interest`/`bookingRequested` und gegebenenfalls `bookingUrl`.

Antworten: `{answers:{changes:'yes',interest:'yes',topics:['energy'],comment:'…'},interest?,bookingRequested?,idempotencyKey}`. Ein identischer erneuter POST ist idempotent; ein abweichender erneuter Antwortsatz wird nicht über die erste Antwort geschrieben. Positives Interesse oder eine Terminanfrage erzeugt exakt einen Beraterhinweis mit hoher Priorität und eine Beratermail in derselben dauerhaften Outbox. Ohne konfigurierte Berateradresse bleibt zumindest der sichtbare priorisierte Hinweis erhalten.

Abmelden: `{unsubscribe:true,idempotencyKey}` funktioniert auch nach bereits eingereichter Antwort. Es setzt ausschließlich im zugehörigen Projekt `emailAuthorized:false`, verwirft noch nicht versandte Kundennachrichten und liefert `{status:'unsubscribed',unsubscribed:true}`. Erneutes Abmelden ist unschädlich. Jede Kundenmail enthält diesen persönlichen Zugangs-/Abmeldelink. Es gibt keine automatische Nachfassserie.

## Versand und Rücklesen

`runDue` reserviert jede logische Nachricht atomar und ruft `deliver(envelope)` höchstens einmal auf. Die Hülle ist `{id,outboxId,projectId,from,to:[email],subject,body,idempotencyKey}`. Sie ist die verbindliche Nachricht; keine frei eingegebenen Empfänger werden anstelle der Kundenquelle verwendet.

Der Adapter kann `{status:'queued',queueId}` liefern. Geräteaufträge speichern ausschließlich Vorgangs- und Projektkennung; die aktuelle Hülle wird unmittelbar vor dem tatsächlichen Schreiben mit `getDeliveryEnvelope` geladen. Dieser Aufruf ist wiederholbar und prüft erneut Kunde, Versandfreigabe, unveränderte Adresse, Projekt, Kampagne, Zeitfenster und gegebenenfalls das aktuelle Originalangebot. Die native Ausführung besitzt zusätzlich ihr eigenes prozessübergreifendes Journal und markiert den Versandversuch vor der externen Aktion. Ein erneuter Hüllenabruf ist keine Erlaubnis für einen zweiten Versandversuch.

Ein bestätigter Versand braucht:

```json
{"status":"sent","verified":true,"messageId":"provider-id","recipient":"kunde@example.com","from":"team@example.com","sentAt":"2026-10-01T08:00:00Z","queueId":"optional-device-command"}
```

Absender, Empfänger, Zeitpunkt und gegebenenfalls Geräteauftrag müssen übereinstimmen. Derselbe Mailbeleg darf nicht zwei Vorgänge abschließen. `completeDelivery` akzeptiert auch `status:'uncertain'` und `status:'canceled'`/`'cancelled'`; diese zählen niemals als Versand. Unklare Vorgänge werden nicht erneut durch `runDue` zugestellt. Der lokale Geräteauftrag kann mit derselben ID ausschließlich zur Gesendet-Prüfung fortgesetzt werden. Ein späterer echter Versandbeleg kann `uncertain` abschließen.

`runDue` meldet `planned`, `dispatched`, `queued`, `sent`, `delivered` und `quoteGaps`; `delivered` zählt ausschließlich bestätigte `sent`-Belege. Die monatliche Beraterübersicht hat einen eigenen dauerhaften Schlüssel aus Projekt und `YYYY-MM`, sodass ein minütlicher Scheduler sie nicht mehrfach erzeugt.

## Konkrete Anbieterangebote

`getOptimizationQuote({projectId,customer,contract})` liefert nur tatsächlich erhaltene und zugeordnete Daten. Erforderlich sind `id`, `provider`, `customerId`, `contractId`, `monthlyCost`, `currency:'EUR'`, `verified:true`, `expiresAt` und die Quellenbelege.

- API-Angebot: `sourceType:'provider-api'`, `providerVerified:true`, `checkedAt`; höchstens sieben Tage alt und nicht abgelaufen.
- Originaldokument: `sourceType:'verified-document'`, `sourceDocumentId`, `sourceSha256` (64 Hexzeichen), `reviewedBy:'admin'`, `reviewedAt`, `conditions`. Dies wird als **Geprüftes Originalangebot** dargestellt und erhält `providerVerified:false`. Die Ablaufgrenze des tatsächlichen Angebots gilt; es wird keine Live-API-Prüfung vorgetäuscht.

Der Originaldokument-Adapter prüft das PDF und seinen aktuellen SHA-256 selbst. Unmittelbar vor Versand wird er erneut abgefragt; verschwundene Dokumente, andere SHA-256, Preise, Bedingungen oder Ablaufdaten verwerfen die alte Versandhülle. Eine gespeicherte Metadatenbehauptung genügt dafür nicht. Ohne gültiges Angebot bleibt ein sichtbarer `quote-required`-Hinweis. Fehlende Angebote werden höchstens alle 15 Minuten erneut angefragt; neue oder geänderte Angebotsbelege können diesen Negativcache invalidieren. Ein fehlender Treffer bedeutet keine vollständige Marktprüfung und es werden keine erfundenen Ersparnisse angegeben.

## Persistenz und Nachweis

Alle Zustände liegen unter `${dataDir}/customer-care/state.json`, atomarer Austausch mit Dateisynchronisation, Rechte 0600 und prozessübergreifender Schreibsperre. Speicherschutzgrenzen werfen einen Fehler, ohne vorhandene Nachweise zu löschen. Es gibt keine zusätzlichen Tageskontingente. Tokens, Verträge, Antworten, Kampagnen, Outbox und Benachrichtigungen bleiben nach Prozessneustart erhalten.

Verifikation: `node --test scripts/verify-customer-care-engine.mjs`. Die Tests nutzen ausschließlich temporäre Daten und injizierte Provider; sie versenden keine echten Nachrichten.
