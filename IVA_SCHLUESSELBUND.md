# IVA-Schlüsselbund auf Nadines Mac

Stand: 25. August 2026

## Ziel

IVA meldet sich bei den dauerhaft freigegebenen Arbeitsportalen selbstständig wieder an. Nadine wird nicht wegen normaler Loginseiten, abgelaufener Sitzungen oder wiederkehrender TOTP-Codes unterbrochen. Ein echter Blocker ist erst ein CAPTCHA, eine Kontosperre, eine technisch erzwungene externe Bestätigung oder ein tatsächlich fehlender beziehungsweise abgelehnter Schlüsselbund-Eintrag.

Passwörter und Benutzernamen liegen ausschließlich im macOS-Anmeldeschlüsselbund. Panasonic bleibt beim bereits eingerichteten Ente Auth: IVA erkennt dort ausschließlich den richtigen Eintrag und tippt den aktuellen Code direkt in die echte Panasonic-Seite. TOTP-Code und Seed werden weder gespeichert noch über die Zwischenablage bewegt. Geheimnisse erscheinen niemals in Projektdateien, Railway, Chat, Gerätebefehlen, Statusantworten oder Audit-Logs.

## Freigegebene Portale

| ID | Portal | Primärer Loginweg | Einmalig im IVA-Schlüsselbund nötig |
| --- | --- | --- | --- |
| `panasonic` | Panasonic ProMatch | vorhandenes Browser-Passwort + Ente Auth `phvaceu-prod / Panasonic` | kein zusätzlicher Schlüsselbund-Eintrag |
| `bosch` | Bosch/Thernovo | vorhandene Browser-/SSO-Sitzung | optional `username`, `password`, `totp` |
| `pipedrive` | Pipedrive Heat Hero | lokaler IVA-Schlüsselbund | `username`, `password`; `totp` optional |
| `airtable` | Airtable Heat Hero | vorhandene Sitzung oder verbundener Airtable-Connector | optional `username`, `password`, `totp` |
| `planbar` | Planbar365 Heat Hero | vorhandene Sitzung, Schlüsselbund als Wiederanmeldeweg | `username`, `password`; `totp` optional |

Neue Portale werden ausschließlich durch ein weiteres festes Profil in `local-mac-helper/credential-broker.mjs` ergänzt. Freie Domains, freie JavaScript-Befehle und Remote-Secret-Lesen bleiben gesperrt.

## Einmalige lokale Einrichtung

Status ohne Secret-Ausgabe:

```bash
node local-mac-helper/cli.mjs credential-status
```

Ein Feld sicher hinterlegen:

```bash
node local-mac-helper/cli.mjs credential-setup pipedrive username --commit
node local-mac-helper/cli.mjs credential-setup pipedrive password --commit
node local-mac-helper/cli.mjs credential-setup planbar username --commit
node local-mac-helper/cli.mjs credential-setup planbar password --commit
```

`security` fragt den Wert verdeckt direkt im lokalen Terminal ab. Der Wert darf nicht als zusätzlicher Befehlsparameter, per Chat oder über eine Datei übergeben werden. Panasonic-TOTP wird ausdrücklich nicht in diesen Schlüsselbund kopiert; dafür bleibt Ente Auth die Quelle.

## Nutzung

Lokaler Test eines bereits eingerichteten Portals:

```bash
node local-mac-helper/cli.mjs portal-login pipedrive
```

Im IVA-Chat verwendet das Modell `ensureImacPortalLogin`. Railway legt nur einen Befehl mit der Portal-ID in den ausgehenden Gerätekanal. Der iMac liest den Befehl, holt die passenden Werte lokal aus dem Schlüsselbund und gibt ausschließlich `authenticated`, `setup_required` oder einen konkreten Blocker zurück.

## Sicherheitsgrenzen

- Domains und Portal-IDs sind fest positiv gelistet.
- Secrets werden nicht an Railway oder das Sprachmodell zurückgegeben.
- AppleScript wird über Standard-Eingabe statt über Prozessargumente ausgeführt.
- CAPTCHA wird weder umgangen noch automatisch gelöst.
- Login bedeutet keine Freigabe für fachliche Schreibaktionen im Portal.
- Bestehende Pipedrive-, Airtable-, Planbar- und Herstellerregeln bleiben unverändert.
- Vor jeder lokalen UI-Arbeit wird der vorhandene Mac-Wachschutz verwendet; nach dem Lauf werden die Displays gemäß Projektregel wieder schlafen gelegt.
