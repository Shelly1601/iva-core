# IVA Mac Helper

Der lokale Helper bedient Programme, die nur auf Nadines Mac angemeldet sind. Phase 1 erstellt ausschließlich Outlook-Entwürfe. Es existiert bewusst kein Versand-Endpunkt.

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
  "to": ["patrick@example.com"],
  "cc": ["vertriebspartner@example.com"],
  "missingDocumentIds": [
    "signed_offer",
    "identity_card",
    "land_register"
  ],
  "attachments": []
}
```

Der Absender muss in Falldateien nicht mehr eingetragen werden. Er wird für diesen Workflow immer fest als `foerderung@heat-hero.com` gesetzt. Ein abweichender übergebener Absender führt zum Abbruch.

Die Anrede lautet unabhängig von den verfügbaren VP-Daten immer `Hallo Patrick,`. Patrick steht im Feld **An**. Die eindeutig zugeordnete E-Mail-Adresse des Vertriebspartners wird optional ins **CC** gesetzt. Ist sie nicht vorhanden oder nicht eindeutig, wird keine Adresse geraten.

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
- `POST /v1/funding/drafts/preview`
- `POST /v1/funding/drafts` mit `confirmCreateDraft: true`

Als nächster Schritt kommt ein ausgehender, gepaarter Jobkanal zu IVA-Core hinzu. Dadurch muss Railway niemals eine eingehende Verbindung zum MacBook öffnen.
