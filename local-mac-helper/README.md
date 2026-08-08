# IVA Mac Helper

Der lokale Helper bedient Programme, die nur auf Nadines Mac angemeldet sind. Er liest Förderfälle aus Pipedrive, wertet lokale Förder-PDFs aus und erstellt Outlook-Entwürfe. Es existiert bewusst kein Versand-Endpunkt.

## Sicherheitsgrenzen

- hört nur auf `127.0.0.1`
- jede fachliche Route verlangt `IVA_MAC_HELPER_TOKEN` mit mindestens 32 Zeichen
- Originaldateien werden weder verändert noch gelöscht
- Entwürfe erhalten einen Fingerprint; identische Entwürfe werden nicht doppelt erzeugt
- Aktionen und Fehler werden lokal unter `~/Library/Application Support/IVA Mac Helper/` protokolliert
- ohne eindeutig aufgelöstes `from`-Konto wird kein Entwurf mehr erzeugt; ein lokaler oder privater Fallback ist gesperrt
- Förderentwürfe sind fest auf `foerderung@heat-hero.com` begrenzt; eine abweichende Eingabe wird verworfen
- die Mailvorlage wird als HTML mit echten Absätzen und Aufzählungen angelegt
- jede Fördermail enthält die feste HEAT-HERO-Signatur von Nadine Sell inklusive Logo, Funktionsbezeichnung, Kontaktdaten und direktem Link auf `https://www.heat-hero.com`
- für das neue Outlook kann der sichtbare Konto-Wähler zusätzlich geprüft werden; akzeptiert wird nur der exakte Wert `Förderung | HEAT HERO (foerderung@heat-hero.com)`
- Versand bleibt deaktiviert

## Diagnose

```bash
node local-mac-helper/cli.mjs doctor
```

Wenn `accessibility.enabled` noch `false` ist, muss der später verpackte Helper einmal unter **Systemeinstellungen → Datenschutz & Sicherheit → Bedienungshilfen** erlaubt werden. Die native Outlook-Schnittstelle wird bevorzugt; die Bedienungshilfe ist der Fallback für die neue Outlook-Oberfläche und geteilte Absender.

Der Oberflächen-Fallback arbeitet absichtlich nach dem Prinzip „im Zweifel abbrechen“: Er prüft den sichtbaren Absender vor und nach dem Befüllen und überschreibt keinen Entwurf, der bereits einen Betreff enthält. Die Swift-Bridge wird lokal nach `~/Library/Application Support/IVA Mac Helper/bin/iva-ax` kompiliert.

## Förderentwurf vorbereiten

Beispielstruktur für `fall.json`:

```json
{
  "customerName": "Max Mustermann",
  "orderNumber": "A-4711",
  "vpName": "Maria Muster",
  "vpEmail": "maria.muster@example.com",
  "missingDocumentIds": [
    "signed_offer",
    "identity_card",
    "land_register"
  ],
  "attachments": []
}
```

Der Absender muss in Falldateien nicht mehr eingetragen werden. Er wird für diesen Workflow immer fest als `foerderung@heat-hero.com` gesetzt. Ein abweichender übergebener Absender führt zum Abbruch.

Patrick steht fest mit `p.germer@heat-hero.com` im Feld **An**. Die eindeutig zugeordnete E-Mail-Adresse des Vertriebspartners wird ins **CC** gesetzt. Ist zusätzlich ein belastbarer Personenname vorhanden, lautet die Anrede beispielsweise `Hallo Patrick, hallo Holger,`. Ist nur die VP-E-Mail vorhanden, bleibt es bei `Hallo Patrick,`. Fehlende oder uneindeutige Adressen werden nicht geraten.

Die Fallreferenz wird in dieser Reihenfolge gebildet: **Kundenname + Auftragsnummer**, ersatzweise **Kundenname + Ort**, ansonsten nur **Kundenname**. Eine fehlende Auftragsnummer verhindert damit weder den Förderentwurf noch die spätere interne Fertigmeldung.

## Pipedrive-Förderprüfung

IVA prüft ausschließlich die Pipeline **Auftragsmachbarkeit** und darin diese beiden Stufen:

- **Antrag eingereicht / Förderunterlagen einreichen:** vollständige Prüfung aller benötigten Unterlagen in Pipedrive und in den zugeordneten Förder-E-Mails. Fehlende, eindeutig zugeordnete Mail-Anlagen werden zuerst korrekt benannt und in den Deal hochgeladen. Erst wenn anschließend jede Pflichtunterlage in Pipedrive als vollständig bestätigt ist, darf der Deal nach **Förderung beantragt** verschoben werden.
- **Förderung beantragt:** dieselbe vollständige Prüfung und gegebenenfalls Nachpflege aus den Förder-E-Mails. Der Deal bleibt aber immer in dieser Stufe und wird von IVA nicht weitergeschoben.

Eine nur in Outlook gefundene Datei zählt nicht als vollständig. Reihenfolge: richtigen Deal und Dokumenttyp bestätigen → gegebenenfalls Bilder je Unterlage zu einer PDF zusammenfügen → eindeutig benennen → in Pipedrive hochladen → Upload verifizieren → gesamte Checkliste erneut prüfen → erst dann gegebenenfalls die erlaubte Stufenänderung ausführen.

Der Kontakt hinter dem Pipedrive-Feld **Vertriebspartner** liefert Anzeigenamen und E-Mail-Adresse für Anrede und CC. Zum strukturierten, rein lokalen Auslesen der bereits angemeldeten Chrome-Sitzung muss einmal **Chrome → Ansicht → Entwickler → JavaScript von Apple Events erlauben** aktiviert werden. Zugangsdaten werden nicht in IVA-Dateien geschrieben.

Unterschriebene Angebote und TMB-PDFs können seitenweise auf eindeutig beschriftete Auftrags-, Kunden- und Telefonnummern geprüft werden. Jeder Treffer enthält Quelldatei, Seitenzahl, Textausschnitt und Confidence. IVA schlägt nur die Befüllung leerer Pipedrive-Felder vor. Ein vorhandener abweichender Wert, mehrere Treffer oder eine Scan-Seite ohne lesbare Textschicht führen zur manuellen Prüfung; bestehende Werte werden nicht still überschrieben.

```bash
node local-mac-helper/cli.mjs analyze-funding-pdf /pfad/dokument.pdf
```

## Übergabe an Viktoria per WhatsApp

Für diesen internen Abschluss-Hinweis nutzt IVA zunächst die lokal installierte WhatsApp-Mac-App. Der WhatsApp-Hub bleibt für diesen Schritt ungeeignet, solange dessen Versand in IVA noch gesperrt ist.

1. WhatsApp Business auf dem iPhone unter **Einstellungen → Verknüpfte Geräte → Gerät hinzufügen** öffnen.
2. `/Applications/WhatsApp.app` auf dem Mac starten und den dort angezeigten QR-Code scannen.
3. Viktoria Lambels exakte Mobilnummer einmalig verifizieren und einen kontrollierten Test durchführen.
4. Erst nach vollständig verifizierten Pipedrive-Unterlagen und gegebenenfalls erfolgreich bestätigter Verschiebung nach **Förderung beantragt** wird die feste Nachricht vorbereitet. Referenz: Auftragsnummer, sonst Ort, sonst Kundenname.

Bei einem Deal, der bereits in **Förderung beantragt** steht, ist keine weitere Stufenänderung erforderlich. Die Nachricht bleibt trotzdem gesperrt, bis alle Pflichtunterlagen tatsächlich in Pipedrive vorhanden sind. Doppelte Übergaben werden beim späteren Live-Versand über Deal-ID und Abschlussstand verhindert.

Viktorias verifizierte Nummer liegt ausschließlich im macOS-Schlüsselbund unter dem Dienst `de.iva.funding.whatsapp`; sie wird nicht in Git, Railway oder Falldateien gespeichert. Das Vorhandensein des Eintrags darf diagnostiziert werden, die Nummer selbst wird in Statusausgaben nicht angezeigt.

Nur ansehen:

```bash
node local-mac-helper/cli.mjs preview-funding /pfad/fall.json
```

Nach ausdrücklicher Bestätigung als Outlook-Entwurf anlegen:

```bash
node local-mac-helper/cli.mjs create-funding-draft /pfad/fall.json --commit
```

## Lokaler Dienst

```bash
IVA_MAC_HELPER_TOKEN=<zufälliger-langer-wert> node local-mac-helper/cli.mjs serve
```

Routen:

- `GET /health`
- `GET /v1/doctor`
- `GET /v1/pipedrive/deals/:id/funding-snapshot` liest Pipeline, aktive Stufe, Kunde, Ort, Auftrags-/Kunden-/Telefonnummer, VP-Kontakt und sichtbare Dateinamen ohne Änderung aus dem geöffneten Chrome-Deal
- `POST /v1/funding/pipedrive/decision` für eine rein lesende Workflow-Entscheidung ohne Pipedrive-Änderung
- `POST /v1/funding/documents/analyze` wertet eine lokale PDF aus und liefert optional konfliktgeprüfte Pipedrive-Feldvorschläge; die Route schreibt nichts
- `POST /v1/funding/pipedrive/fields/apply` liest Deal und PDF erneut, befüllt mit `confirmApply: true` ausschließlich leere, sichtbare Felder und verifiziert jeden gespeicherten Wert; vorhandene Werte werden nie überschrieben
- `POST /v1/funding/drafts/preview`
- `POST /v1/funding/drafts` mit `confirmCreateDraft: true`

Als nächster Schritt kommt ein ausgehender, gepaarter Jobkanal zu IVA-Core hinzu. Dadurch muss Railway niemals eine eingehende Verbindung zum MacBook öffnen.
