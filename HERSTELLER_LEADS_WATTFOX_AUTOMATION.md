# Hersteller-Leads und Wattfox – vorbereiteter Ablauf

Status: **vorbereitet, nicht scharfgestellt**.

## Hersteller-Leads um 21:00 Uhr

1. Exaktes Outlook-Konto `n.sell@heat-hero.com` prüfen.
2. Neue Panasonic-ProMatch- und Bosch-Hersteller-Leads erfassen.
3. Adresse vor jeder Portalaktion gegen die freigegebenen PLZ/Orte prüfen.
4. Bei eindeutig passendem Gebiet annehmen. Außerhalb nur dann automatisch ablehnen, wenn `outsideAreaAction` nach Test ausdrücklich auf `reject` gestellt wurde. Unvollständige oder mehrdeutige Adressen gehen immer in die manuelle Prüfliste.
5. Bereits protokollierte Leads überspringen. Zusätzlich vor der CRM-Anlage nach einem vorhandenen Lead suchen, soweit die Oberfläche dies eindeutig erlaubt.
6. Angenommenen Lead vollständig öffnen und den sichtbaren Lead-Inhalt übernehmen.
7. Im HeatHero CRM unter „Alle Leads“ über „Neuer Lead“ und „Text einfügen“ anlegen.
8. Anlage und Vertriebszuordnung danach sichtbar verifizieren. Fehlende Zuordnungen werden gemeldet, aber nicht eigenmächtig ergänzt.

## Panasonic und Ente Auth

- Ausschließlich Ente-Eintrag `ProMatch` mit Konto `n.sell@heat-hero.com` verwenden.
- Einen ähnlich benannten Eintrag mit `A.Lausig` niemals verwenden.
- Einmalcode nur direkt in die echte Panasonic-Domain eingeben; nie speichern, protokollieren oder in einen Bericht kopieren.
- Bei gesperrter App, unklarem Eintrag, abweichender Domain oder uneindeutigem Login abbrechen und melden.
- Die in Chat-Bildern sichtbaren alten Passwörter werden nicht verwendet. Vor Aktivierung müssen beide Passwörter geändert und anschließend ausschließlich im Browser-Passwortmanager hinterlegt werden.

## Wattfox

- Täglich neue passende Nachrichten von `Datenschutz@Wattfox`, mit Betreff „Bestätigung des Widerrufs“, sowie den Outlook-Unterordner `Posteingang/Lisa Wattfox/Regler` auswerten.
- Tagesreport: neue Vorgänge, Rückmeldung, offener Handlungsbedarf.
- Freitags zusätzlich ein Sieben-Tage-Abgleich: reklamierte Fälle, bestätigte Rückmeldungen und weiterhin offene Fälle.
- CRM-Statusänderungen sind in dieser Stufe ausdrücklich ausgeschaltet.

## Phase 2: CRM-Fortschritt an Panasonic und Bosch zurückmelden

Zielbild: Das HeatHero CRM ist die führende Arbeitsquelle. Vertriebspartner pflegen den Vorgang nur dort; IVA überträgt anschließend ausschließlich die für den Hersteller erforderlichen Fortschritte in das jeweilige Portal. Diese Rücksynchronisierung ist vorbereitetes Zielbild, aber noch nicht aktiv.

- Beim Import werden Hersteller, Hersteller-Lead-ID beziehungsweise Portal-ID und HeatHero-CRM-ID dauerhaft miteinander verknüpft. Name allein reicht niemals als Zuordnung.
- Vor der Aktivierung werden die tatsächlich auswählbaren Statuswerte beider Herstellerportale rein lesend aufgenommen. Panasonic und Bosch erhalten getrennte Mappingtabellen, weil Bezeichnungen und erlaubte Übergänge abweichen können.
- Ein Herstellerstatus wird nur bei belastbarem CRM-Beleg fortgeschrieben und nach dem Speichern im Portal sichtbar verifiziert. Unbekannte Statuswerte, widersprüchliche Daten und fehlende Zuordnungen gehen in die manuelle Prüfliste.
- Keine Rückstufung eines Herstellerstatus und kein erneutes Schreiben desselben Status. Jede Änderung erhält alten/neuen Status, CRM-Beleg, Zeitpunkt und Ergebnis im lokalen Audit-Protokoll.
- Entwurfslogik für die gemeinsame fachliche Abnahme:
  - ausdrücklich gesetzter Ersttermin → Kunde terminiert;
  - ausdrücklich als durchgeführt markierter Ersttermin → Beratung/Ersttermin erfolgt;
  - CRM-Angebot erstellt oder versendet → Angebot erstellt/versendet;
  - zweiter Termin → nur dann Angebot/Besprechung, wenn diese Ersatzregel ausdrücklich freigegeben wurde oder das CRM einen passenden Beleg enthält;
  - Auftrag/gewonnen → verkauft beziehungsweise Auftrag erteilt;
  - verloren/storniert → nur mit passendem Herstellerstatus und dokumentiertem Grund;
  - bloß vergangenes Termindatum, Freitext oder Vermutung → keine automatische Statusänderung.
- Die Rücksynchronisierung kann im täglichen 21-Uhr-Lauf nach der Leadübernahme erfolgen. Im Report stehen jede erfolgreiche Herstellerrückmeldung, unveränderte Fälle und alle manuellen Klärungen.

## Bericht und Fehlerverhalten

- Tages- und Wochenresultat erscheinen in der Codex-Aufgabe und werden lokal unter `iva-core/outputs/hersteller-leads/` abgelegt.
- Enthalten: Quelle, Kunde/Adresse soweit vorhanden, Annahme/Ablehnung/manuelle Prüfung, CRM-Anlage, Vertriebszuordnung und Fehler.
- Keine OTPs oder Passwörter in Bericht, Zwischenablage oder Statusdatei.
- Bei veränderter Oberfläche, unbekannter Schaltfläche oder fehlender Bestätigung keine weitere Schreibaktion ausführen.

## Vor der Aktivierung erforderlich

- beide in den Bildern offengelegten Passwörter ändern;
- richtige PLZ/Orte und Regel für außerhalb liegende Leads eintragen;
- Ente Auth auf dem tatsächlichen iMac einrichten und exakten Eintrag prüfen;
- Outlook, Panasonic, Bosch und HeatHero CRM auf diesem iMac vorbereiten;
- einmaligen Beobachtungs- und Trockenlauf prüfen;
- reale Panasonic-/Bosch-Statuslisten aufnehmen, CRM-Felder prüfen und Mapping gemeinsam freigeben;
- erst danach Konfiguration und geplante Aufgabe aktivieren.
