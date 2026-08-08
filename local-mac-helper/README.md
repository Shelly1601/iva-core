# IVA Mac Helper

Der lokale Helper bedient Programme, die nur auf Nadines Mac angemeldet sind. Phase 1 erstellt ausschließlich Outlook-Entwürfe. Es existiert bewusst kein Versand-Endpunkt.

## Sicherheitsgrenzen

- hört nur auf `127.0.0.1`
- jede fachliche Route verlangt `IVA_MAC_HELPER_TOKEN` mit mindestens 32 Zeichen
- Originaldateien werden weder verändert noch gelöscht
- Entwürfe erhalten einen Fingerprint; identische Entwürfe werden nicht doppelt erzeugt
- Aktionen und Fehler werden lokal unter `~/Library/Application Support/IVA Mac Helper/` protokolliert
- ohne eindeutig aufgelöstes `from`-Konto wird kein Entwurf mehr erzeugt; ein lokaler oder privater Fallback ist gesperrt
- die Mailvorlage wird als HTML mit echten Absätzen und Aufzählungen angelegt
- Versand bleibt deaktiviert

## Diagnose

```bash
node local-mac-helper/cli.mjs doctor
```

Wenn `accessibility.enabled` noch `false` ist, muss der später verpackte Helper einmal unter **Systemeinstellungen → Datenschutz & Sicherheit → Bedienungshilfen** erlaubt werden. Die native Outlook-Schnittstelle wird bevorzugt; die Bedienungshilfe ist der Fallback für die neue Outlook-Oberfläche und geteilte Absender.

## Förderentwurf vorbereiten

Beispielstruktur für `fall.json`:

```json
{
  "customerName": "Max Mustermann",
  "orderNumber": "A-4711",
  "vpName": "Maria",
  "to": ["vertriebspartner@example.com"],
  "cc": [],
  "from": "foerderung@heat-hero.com",
  "missingDocumentIds": [
    "signed_offer",
    "identity_card",
    "land_register"
  ],
  "attachments": []
}
```

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
