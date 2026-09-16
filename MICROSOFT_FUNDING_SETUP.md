# Förderpostfach einmalig mit IVA verbinden

Der Adapter ist für Nadines Microsoft-365-Anmeldung `n.sell@heat-hero.com` und das bereits freigegebene Postfach `foerderung@heat-hero.com` vorgesehen. Er liest Mails und Anlagen und verschiebt vollständig abgelegte Nachrichten nach `Posteingang/Fertig`. Er besitzt keinen Mailversand.

## Einmalige Einrichtung im HEAT-HERO-Mandanten

1. Im [Microsoft-Entra-Portal](https://entra.microsoft.com/) **Entra ID → App-Registrierungen → Neue Registrierung** öffnen. Wenn die Registrierung für Nadines Konto gesperrt ist, muss die HEAT-HERO-IT diesen Schritt übernehmen.
2. Name **IVA Förderpostfach**, Kontotyp **nur dieser Organisationsmandant**, Plattform **Web**. Exakte Rücksprungadresse: `https://iva-core-production.up.railway.app/oauth/microsoft-funding/callback`.
3. Unter **API-Berechtigungen → Microsoft Graph → Delegierte Berechtigungen** `User.Read`, `Mail.ReadWrite.Shared` und `offline_access` einrichten. Keine Anwendungsberechtigungen und kein `Mail.Send`. Falls der Mandant eine Administratorfreigabe verlangt, diese durch die zuständige IT erteilen lassen.
4. Unter **Zertifikate & Geheimnisse** ein Clientgeheimnis für diese App erstellen. Tenant-ID, Client-ID und Geheimnis direkt in die vorhandenen geschützten Railway-Variablen eintragen; keine Geheimnisse in Chat, Quelltext oder Bericht kopieren.
5. Die Variablen heißen `MICROSOFT_FUNDING_TENANT_ID`, `MICROSOFT_FUNDING_CLIENT_ID`, `MICROSOFT_FUNDING_CLIENT_SECRET`, `MICROSOFT_FUNDING_REDIRECT_URI` und `MICROSOFT_FUNDING_TOKEN_KEY`. Für den Token-Schlüssel einen eigenen kryptografisch zufälligen Wert mit mindestens 32 Zeichen verwenden. Nach Verbindungsaufbau nicht unbeabsichtigt ändern: Er verschlüsselt die gespeicherte Freigabe und Cursor.
6. In IVA **Steuerzentrale → Anbindungen → Förderpostfach · Microsoft 365 → Mit Microsoft verbinden** wählen. Mit `n.sell@heat-hero.com` anmelden und die angezeigte Freigabe prüfen. Der Zugriff nutzt die schon vorhandene Postfachdelegation.
7. **Verbindung prüfen** muss den tatsächlichen Zugriff bestätigen. Erst danach den gespeicherten einmaligen Rücklauf fortsetzen. Ein fremder Outlook-Cursor wird absichtlich nicht automatisch überschrieben.

## Abnahme

Mit einer echten freigegebenen Fördermail vollständig prüfen: Nachricht lesen, sämtliche Anlagen übernehmen und als PDF im richtigen Deal rücklesen, relevanten Mailtext als kurze Notiz sichern, Abschlussbeleg einschließlich Quellhash speichern, Mail nach Fertig verschieben und dort erneut identifizieren. Danach denselben Beleg wiederholen: keine weitere Kopie und kein zweiter Move. Den direkten Weg zusätzlich bei gesperrtem Bildschirm prüfen. Bis zu dieser Abnahme ist kein vollständiger Live-Förderlauf bestätigt.

Die übrigen Schritte können weiterhin Outlook oder andere Oberflächen benötigen. Display-Ruhezustand, Passwortsperre und ein ausgeschalteter Mac sind verschiedene Zustände. Ein direkter Mailadapter allein macht den gesamten Förderlauf noch nicht unabhängig vom Bildschirm.

Referenzen: [Microsoft-App registrieren](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app), [Zugriff auf freigegebene Postfächer](https://learn.microsoft.com/en-us/graph/outlook-share-messages-folders).
