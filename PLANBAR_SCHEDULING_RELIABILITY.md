# Planbar: dauerhafte Terminierung und offene Ergänzungen

Stand: 15. September 2026. Diese Regeln ergänzen den Workflow „Kunde terminieren“ auf dem zentralen Mac Mini. Der Auftrag aus IVA ist die Freigabe zur dort beschriebenen Durchführung. Ein angenommener Geräteauftrag oder ein beendeter Prozess ist kein Buchungsbeleg.

## Tatsächlicher Ausführungsweg

Chat und Projektformular speichern eine Terminanfrage über `projects/store.js`. Die dauerhafte Outbox übergibt `planbar.customer.schedule` an den Mac Mini. Der Gerätehelfer startet `startPlanbarCustomerSchedulingTask`; der bestehende Browserworkflow prüft Identität, Partner, Zielwoche, Dubletten und die aktuelle Belegung und speichert den zulässigen Termin in Planbar. Erst das erneute Öffnen und Rücklesen des gespeicherten Kundentermins erlaubt `planbar-progress` mit einem Reservierungsnachweis.

`local-mac-helper/planbar.mjs` enthielt bei dieser Prüfung ausschließlich Lesefunktionen. Es wurde kein Schreib-API-Endpunkt erfunden und kein neuer Planbar-Schreibadapter hinzugefügt. Die Reparatur betrifft die dauerhafte Weiterbearbeitung und den korrekten fachlichen Status des bestehenden Buchungswegs. Eine echte Buchung wurde durch die automatisierten Tests nicht ausgeführt.

## Reservierung und Nachweis

- Kunde, Termin-ID, Ressource und Montag-bis-Freitag-Zeitraum müssen tatsächlich erneut gelesen werden. Eine Prozessmeldung wie „erfolgreich“ reicht nicht.
- Vor jeder weiteren Anlage einen vorhandenen Termin prüfen. Ein unklarer Speicherausgang verlangt zuerst das Rücklesen; er erlaubt keine blinde Wiederholung.
- Ein bereits verifizierter Termin darf in Folgebelegen nicht ersetzt oder verschoben werden. Fehlende Beschreibung, Angebotsnummer, Unterlagen oder optionale Kontaktdaten löschen die Reservierung nicht.
- `firstVerifiedAt` bewahrt den ersten geprüften Reservierungszeitpunkt. Ein späteres Rücklesen darf `verifiedAt` aktualisieren, ohne einen bereits geprüften Bestätigungs-Mailnachweis ungültig zu machen. Eine Mail vor dem ersten Reservierungsnachweis bleibt unzulässig.
- `completed` erfordert leere `missingDetails` und `remainingActions` sowie `completionVerified: true`. Offene Ergänzungen bleiben als konkrete Einträge gespeichert.

## Vertrag für die tägliche Heat-Hero-Ergänzung

`buildPlanbarSchedulingFollowup(request, progress)` aus `operations/customer-scheduling.js` ist eine reine Ableitung des vorhandenen Belegs. Der lokale Ergänzungsdienst persistiert die Rückgabe; diese Funktion führt keine Schreib- oder Netzwerkaktion aus.

Die Rückgabe enthält:

- `caseId`: stabil aus Heat Hero, Kunden-ID und Termin-ID; ein neuer Worker erzeugt keinen zweiten Fall.
- `revision`: stabiler Hash des Bearbeitungsumfangs und der gesicherten Zuordnung; gleiche Belege ergeben die gleiche Revision.
- `jobId`, `requestId`, `schedulingKey` und die tatsächlich gesicherten Kunden-/Termin-/Ressourcen-IDs samt Woche und Zeitraum.
- `missingDetails`, `remainingActions` und `status: pending | completed`.
- `customerSegment`, `requiresPrivateCustomerCheck` und gegebenenfalls den vorhandenen `sourceCheck`.

Nur `partnerId: heat-hero` mit Präfix `HH` wird übernommen. Enter und D Warmte werden ausgeschlossen. Eine als Geschäftskunde bestätigte Quelle liefert ebenfalls keine Aufgabe für den reinen Heat-Hero-Privatkundenlauf. Im bisherigen Formular existiert kein verifiziertes Privatkundenmerkmal: Ein frei übergebenes Formularfeld ist deshalb kein Nachweis. Das Merkmal kann ausschließlich aus `sourceCheck.customerSegment` mit `customerSegmentVerified: true` stammen; `customerSegmentSource` hält die konkrete beobachtete Quelle fest. Unbekannte Fälle bleiben mit `requiresPrivateCustomerCheck: true` offen. Der tägliche Lauf muss sie vor jeder Änderung anhand einer echten Primärquelle einordnen.

Der reine Ergänzungslauf arbeitet am vorhandenen Termin. Er erfindet weder Angebotswerte noch Kundendaten und legt keinen Ersatztermin an. `remainingActions` können Pipedrive-Abschluss, WhatsApp oder Bestätigungs-Mail enthalten; diese Aktionen sind keine automatische Erweiterung des reinen täglichen Ergänzungsumfangs. Sie bleiben getrennt nachvollziehbar offen.

## Technische Wiederanläufe und Status

`classifyPlanbarSchedulingFailure` trennt technische Störungen, echte fachliche Hindernisse, externe Kontohindernisse und bewusste Abbrüche. Browser-, Verbindungs-, Worker- oder unklare Speicherfehler werden als offene technische Nachprüfung angezeigt. Die Anzeige ist keine Behauptung, dass bereits ein Wiederanlauf stattgefunden hat. Jeder weitere Schreibversuch verlangt zunächst den echten Planbar-Zielzustand.

Die Operations-Protokollierung akzeptiert eine Fortsetzung eines fehlgeschlagenen, blockierten, abgelaufenen oder unvollständigen Laufs nur bei:

1. gleicher Job-ID, gleicher Projekt-/Workflow-Zuordnung und unverändertem bereits gesetztem Scheduling-Schlüssel;
2. strikt neuerem Zeitstempel und höherem ganzzahligem `recoveryAttempts`;
3. expliziter Phase `recovering` und aktivem Zielstatus `queued` oder `running`;
4. unveränderter Identität eines vorhandenen Reservierungsbelegs.

Abgeschlossene oder bewusst gestoppte Läufe werden dadurch nicht geöffnet. Alte Meldungen und normale verspätete Lebenszeichen können einen terminalen Zustand weiterhin nicht zurücksetzen. Nach einer zulässigen Wiederaufnahme werden spätere Lebenszeichen regulär übernommen. Die Anzahl und Ausführung begrenzter Reparaturversuche steuert der lokale Task-Worker.

## Prüfung

`scripts/verify-planbar-scheduling-reliability.mjs` verwendet ausschließlich temporäre Stores und synthetische Belege. Es prüft stabile Nachzieh-Aufgaben, Privatkunden-/B2B-Abgrenzung, Pflicht zur echten Reservierung, Erhalt von Mailbelegen, technische Statusdarstellung, sichere Wiederaufnahme und Schutz vor veralteten oder abweichenden Meldungen. Zusätzlich wurden `verify-customer-scheduling.mjs`, `verify-planbar-reservation.mjs` und `verify-scheduling-dispatch.mjs` ausgeführt. Alle Prüfungen bestanden; keine echten Buchungen oder Nachrichten wurden ausgelöst.
