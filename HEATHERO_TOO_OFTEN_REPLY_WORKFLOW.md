# HeatHero-Rückmeldungen „Zu oft n.e.“

_Vorbereitet und zur Liveschaltung freigegeben am 22.08.2026._

## Ziel

IVA liest einmal täglich das Gmail-Label `Heat Hero/Zu oft n.e.` im verbundenen Konto `nadine.iva.inbox@gmail.com` und verarbeitet Kundenantworten aus der „zu oft nicht erreicht“-Nachfassmail nachvollziehbar im großen HeatHero CRM.

Der Slot ist **täglich um 08:15 Uhr (Europe/Berlin)**. Die zentrale Railway-Automation heißt `heat-hero-too-often-replies`.

## Entscheidungslogik

1. Nur eingehende Kundenmails werden verarbeitet. Eigene HeatHero-/IVA-Antworten im selben Gmail-Thread werden ignoriert.
2. Die aktuelle Kundenantwort wird für die Entscheidung vom zitierten alten Mailverlauf getrennt. Die erzeugte PDF enthält dagegen die vollständige, von Gmail gelieferte Nachricht.
3. Der CRM-Lead muss eindeutig über die Absender-E-Mail, eine belegte Telefonnummer oder zuletzt den gespeicherten Namen gefunden werden. Bei Mehrdeutigkeit wird nichts geschrieben.
4. Eindeutige Absagen, „kein Interesse“, „erledigt“, anderweitiger Kauf oder ausdrücklicher Abschlusswunsch werden als **Reklamation** vorbereitet:
   - Reklamieren öffnen beziehungsweise den dafür bestätigten Gateway-Aktionsweg verwenden.
   - Grund `Sonstiges` setzen.
   - In die sichtbare Reklamationsanmerkung `Siehe Anhang.` schreiben.
   - Für alle bereits vor der Liveschaltung am 23.08.2026 vorhandenen Mails zusätzlich dokumentieren, dass die Kundenrückmeldung von Julia Zollner nicht übermittelt wurde, erst seit dem kürzlichen Austausch mit Thomas Sommer bekannt ist und deshalb um Kulanz gebeten wird.
   - Maildatum, Betreff, Absender und möglichst vollständige aktuelle Kundenrückmeldung zusätzlich als interne CRM-Notiz speichern.
   - Die vollständige E-Mail als A4-PDF anhängen.
5. Eindeutiges Interesse mit konkretem Datum beziehungsweise Zeitfenster wird als **Wiedervorlage** vorbereitet:
   - Status `wiedervorlage`.
   - `wiedervorlage_fuer = setter` - niemals Fachberater.
   - Datum und Zeit ausschließlich aus der Kundenmail; bei einem genannten Tag ohne Uhrzeit gilt der bereits im CRM verwendete Standard 09:00 Uhr.
6. Interesse ohne konkreten Zeitpunkt, Fragen, Zurückstellungen ohne Datum, Widersprüche und nicht sicher zuordenbare Mails bleiben als `needs_review` offen.
7. Eine Bitte um Datenlöschung wird sichtbar in der Anmerkung markiert. IVA löscht keine Kundendaten automatisch.

## Dubletten- und Fehlerregel

- Jede Gmail-Nachrichten-ID wird als stabiler Idempotenzschlüssel `gmail-too-often:<messageId>` verwendet.
- Der CRM-Aktionsweg muss denselben Schlüssel dauerhaft deduplizieren und die gespeicherte Aktion rückprüfen.
- IVA markiert eine Mail erst dann als abgeschlossen, wenn das CRM `verified: true` oder einen bestätigten `idempotentReplay` zurückliefert.
- Vorbereitete, unklare oder fehlgeschlagene Fälle gelten nicht als abgeschlossen und dürfen in einem späteren Lauf erneut geprüft werden.
- Der lokale Zustand liegt auf dem Railway-Volume in `/data/heat-hero-too-often-replies.json`. Kundentexte und PDFs werden dort nicht dauerhaft dupliziert; gespeichert werden nur IDs, Ergebnisstatus, CRM-Lead-ID und Zeitpunkte.

## CRM-Vertrag

IVA verwendet ausschließlich das eigenständige große HeatHero-Gateway auf `api-gateway/v1/leads` - niemals „Mein CRM“. Reklamationen laufen über `POST /v1/leads/:id/reklamation`, Wiedervorlagen über `PATCH /v1/leads/:id/wiedervorlage`.

```json
{
  "idempotencyKey": "gmail-too-often:<gmail-id>",
  "action": "reclamation | follow_up",
  "source": {
    "provider": "gmail",
    "messageId": "...",
    "threadId": "...",
    "label": "Heat Hero/Zu oft n.e.",
    "occurredAt": "..."
  },
  "note": "E-Mail vom Kunden ...",
  "customerReply": "...",
  "reclamation": {
    "reason": "Sonstiges",
    "reasons": ["Sonstiges"],
    "otherText": "Siehe Anhang. ...",
    "setStatusReklamiert": true
  },
  "attachment": {
    "filename": "...-kundenmail.pdf",
    "mimeType": "application/pdf",
    "bytes": 12345,
    "base64": "..."
  },
  "followUp": {
    "at": "ISO-8601",
    "assignedTo": "setter",
    "statusDetail": "wiedervorlage"
  }
}
```

Für `reclamation` sind `reclamation` und `attachment` Pflicht; für `follow_up` ist `followUp` Pflicht. Die Antwort muss die tatsächlich gespeicherte und rückgelesene Aktion mit `verified: true` bestätigen. Ein schon vorhandener Idempotenzschlüssel antwortet mit `idempotentReplay: true`.

## Livegang

1. HeatHero-Gateway-Endpunkt für Reklamation mit PDF-Anhang veröffentlichen.
2. Einen klaren Absagefall und einen konkreten Rückruffall kontrolliert testen.
3. CRM-Ergebnis, PDF-Anhang, Kulanzanmerkung und Setter-Zuordnung sichtbar rückprüfen.
4. Workflow committen, pushen, auf Railway deployen und den Altbestand einmalig abarbeiten.
5. Danach läuft die Automation täglich um 08:15 Uhr und wird in den Heat-Hero-Tagesprotokollen erwartet.
