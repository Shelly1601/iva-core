# Kundenbetreuung: verifizierter Outlook-Textversand

`createCustomerCareMailExecutor({getEnvelope, ...optionalTestDependencies})` verarbeitet `{projectId,outboxId}`. Der Geräte-Agent hält währenddessen die bestehende UI-Sperre. `getEnvelope(outboxId)` muss eine **wiederholbar lesbare** aktuelle Regelauswertung mit `{outboxId,projectId,from,to:[email],subject,body}` liefern; diese Abfrage darf keinen Versand auslösen.

Der Executor speichert pro Projekt und Ausgangs-ID ein fsync-gesichertes Journal unter `customer-care-delivery/` und sperrt es pro Prozess über eine atomare Claim-Datei. Bei beschädigtem Journal wird niemals ein neuer Versand angenommen. Die Vorlage darf genau einen An-Empfänger, reinen Text und keine Cc/Bcc/Anlagen enthalten.

Ablauf: aktuelle Regeln → persistierte Vorlage → Entwurf vorbereiten/prüfen → Regeln direkt vor Versand erneut lesen → **attempted dauerhaft speichern** → höchstens eine native Sendeaktion → Original-MIME im Gesendet-Ordner überprüfen. Betreff, vollständiger normalisierter Text, Absender, sämtliche Empfänger, Anlagen, RFC-Message-ID und ein begrenztes unveränderliches Zeitfenster müssen übereinstimmen. Windowschließen oder AXPress-Erfolg alleine sind kein Versandbeleg.

Nach `attempted` ist jeder weitere Aufruf ausschließlich ein Gesendet-Rücklesen; selbst geänderte Regeln, ein Timeout oder ein erneuter Geräteauftrag führen zu keiner zweiten Sendeaktion. Liefert der erste Rücklauf noch keine eindeutige Originalmail, wird `{receipt:{status:'uncertain',retryReadbackOnly:true,...}}` zurückgegeben. Die Zentrale darf denselben Auftrag später zum Rücklesen erneut aufrufen. Bei Erfolg enthält der Beleg `status:'sent',verified:true,messageId,recipient,from,sentAt,checkedAt,outboxId,envelopeHash,bodyHash`. Ein endgültiger Beleg wird lokal wiederverwendet. Bei Widerruf vor dem Sendeversuch wird `canceled` dauerhaft gespeichert.

Native Befehle:

- `verify-text-compose <expectation.json>`: vollständige Prüfung des fokussierten Entwurfs, keine Sendeaktion. Bei Wiederaufnahme kann ein exakt passender bereits vorbereiteter Entwurf weiterverwendet werden.
- `send-verified-text-compose <expectation.json>`: dieselbe Prüfung und genau ein `AXPress`. Kein nachgeschalteter Maus-/Tastatur-Fallback bei unklarem Ergebnis.
- `validate-text-compose-snapshot <expectation.json> <snapshot.json>`: rein synthetische Prüffunktion; startet Outlook nicht und sendet nichts. Dient den Regressionen.

Der vorhandene XLSX-Forecast-Sender bleibt unverändert. Neue native Erkennung wurde per Swift-Typecheck und synthetischen Positiv-/Negativfällen geprüft. Ein realer Kundenversand wurde für diese Entwicklung nicht ausgelöst; die erste tatsächliche Ausführung muss deshalb zusätzlich den echten MIME-Erfolgsbeleg liefern. Nicht eindeutig auslesbare Outlook-Felder werden als technischer Fehler behandelt, nicht als versendet.

Tests: `node scripts/verify-customer-care-mail.mjs` (einschließlich temporär gebauter nativer Snapshot-Prüfung auf macOS). Test-Binaries und Fixtures werden nur in temporären Testverzeichnissen angelegt und anschließend entfernt; der produktive Helper wird dadurch nicht ersetzt.
