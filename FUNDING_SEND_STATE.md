# Fördermails: dauerhafter Versandstatus

`local-mac-helper/funding-send-state.mjs` führt keine Sendeaktion aus. Es prüft konkrete Vorlagen/Empfänger, reserviert genau eine Sendefreigabe vor dem Klick und gleicht echte native Outlook-Gesendet-Belege ab. JSON-Persistenz mit Modus 0600, Datei- und Verzeichnis-fsync, atomarem Rename sowie `withFundingFileLock` für parallele Prozesse.

## Vier CLI-Schritte für den Worker

Der Worker verwendet diese vier Aufrufe:

```sh
node local-mac-helper/cli.mjs funding-send prepare /absoluter/pfad/entwurf-pruefung.json
node local-mac-helper/cli.mjs funding-send before-submit <intentId> /absoluter/pfad/aktuelle-pruefung.json
node local-mac-helper/cli.mjs funding-send complete <intentId> '<echte-Outlook-Nachrichten-ID>'
node local-mac-helper/cli.mjs funding-send resume <intentId>
```

- `prepare` → `prepareFundingSend(payload)`.
- `before-submit` → `markFundingSendSubmitted(intentId, payload)`.
- `complete` → `completeFundingSend(intentId, {messageId})`; ohne ID erfolgt die eindeutige Suche nach dem unveränderten Brief.
- `resume` → `reviewFundingSendResumption(intentId)`.

`before-submit` gibt `maySend:true` genau einmal zurück. Nur dann darf der beauftragte Worker unmittelbar den bereits geprüften Sendeknopf betätigen. **Vor diesem Aufruf nochmals tatsächlich Entwurf, Konto, An/CC/BCC, Inhalt/Signatur und aktuelle Quellen prüfen.** Niemals auf Basis einer früheren Freigabe später ungeprüft senden.

## Payload

```js
{
  type: 'missing-documents', // alternativ no-response
  input: { dealId, customerName, customerEmail, vpEmail, orderNumber, missingDocumentIds },
  prepared: { from, to, cc, bcc: [], subject, body },
  evidence: {
    sourceReviewComplete: true, identityVerified: true,
    pipedriveFilesReadbackVerified: true, pipedriveNotesReadbackVerified: true,
    customerAddressVerified: true, partnerAddressVerified: true
  },
  reviewedAt: 'tatsächlicher ISO-Prüfzeitpunkt',
  // Nur before-submit: exakt aus prepare übernehmen.
  envelopeHash: 'hash aus prepare'
}
```

`reviewedAt` muss höchstens fünf Minuten alt sein. `before-submit` verlangt den vollständigen aktuellen Payload; Hash allein reicht nicht. `validateFundingSendEnvelope` rendert die bekannte Vorlage erneut und vergleicht Text einschließlich Signatur sowie die exakten Empfänger. Die Flags dürfen ausschließlich aus der tatsächlich vorgenommenen Prüfung stammen. Zusätzliche Anlagen benötigen eine eigene freigegebene Versandvorlage.

`no-response`: Eingabe und Entwurf wie `renderFundingNoResponseEscalationDraft`; insbesondere `originalMessageId`, echter `requestSentAt`, `originalSubject`, geprüfte Vertriebsstruktur und vollständig gelesene `responses`. `prepared.originalMessageId` muss übereinstimmen; `evidence.originalMessageForwarded` und `responseThreadReadComplete` sind Pflicht. Der 7-Tage-Abstand und neue Antworten werden vor der Sendefreigabe erneut geprüft.

## Zustände und Wiederaufnahme

- `prepared`: vollständige Vorprüfung und eindeutige negative Gesendet-Suche. Noch keine Sendefreigabe.
- `submitted_unverified`: die einmalige Freigabe wurde bereits ausgegeben. Der echte Sendeausgang bleibt bis zum Rücklesen offen.
- `sent_verified`: konkrete Nachricht, Absender, An/CC/BCC, Betreff, Body-Hash beziehungsweise Forward-Einleitung/Original-ID und Anlagen passen zum Intent.

Der natürliche Schlüssel ist Typ + Deal + sortierte Dokumentmenge, für Eskalationen Typ + Deal + Original-Outlook-ID. Zufällige neue Job-/Versuchsschlüssel ändern ihn nicht. Änderungen an demselben gespeicherten Brief werden zurückgewiesen. Eine spätere ausdrücklich beauftragte erneute Anfrage mit identischer Dokumentmenge benötigt eine gesonderte fachliche Erweiterung, keinen umbenannten Versuch.

Ein schon vorhandener passender Gesendet-Beleg wird als `alreadySent:true` übernommen. Fehlgeschlagene, unvollständige oder mehrdeutige Suche erlaubt keine Erstsendung. Förder-Anfragen werden mindestens seit 01.08.2026 geprüft, Eskalationen seit dem ursprünglichen Versand. Ein `submitted_unverified`-Vorgang wird bei „nicht gefunden“ niemals automatisch zurückgesetzt. Auch ein Absturz zwischen Markierung und Klick verlangt zuerst eine konkrete Ausgangsklärung; eine spätere manuelle Entsperrung ist noch nicht implementiert. Kein neuer Intent als Umgehung.

## Native Nachweise und Tests

Default-Verifier: `verifyFundingSentMessage` aus `outlook-ui-mailbox.mjs`, ohne Sendeaktion. Eindeutig negativ: `{verified:false,reason:'not_found',searchComplete:true,checkedAt}`. Erfolg benötigt `{verified:true,folder:'Gesendet',messageId,sentAt,sender,recipients,cc,bcc,subject,bodyHash,attachments}`. Plaintext-Hash: SHA256, CRLF → LF, `trim()`. Weiterleitung zusätzlich `originalMessageId` und `introductionHash`. `complete` akzeptiert keine selbst übergebenen Erfolgsflags; der Verifier liest nach.

Tests injizieren `verifySent`/`readSentById`, eigenes `filePath` und `now`: `node scripts/verify-funding-send-state.mjs`. Sie senden keine Mail und prüfen auch konkurrierende Prozesse, Abstürze, korrupten Zustand und abweichende Empfänger/Inhalte.
