# Ergebnisbudget und Ressourcen-Orchestrierung

Stand 17.09.2026. Ergebnisbudget: 30 Minuten ab ursprünglichem Eingang, Terminierungs-Minimalstrecke: 30 Sekunden. Ein Timer, Queue-Ack oder Prozessende ist kein fachlicher Abschluss. Überschrittene Fristen bleiben als Fehler sichtbar; Recovery setzt die Uhr nicht zurück.

## Ausführung

Der Geräteagent pollt die dringende Terminierungslane jede Sekunde unabhängig von bis zu vier normalen laufenden Gerätebefehlen. Der Server claimt atomar nach Lane und ursprünglicher Eingangszeit. Ein noch ungeklärter Gerätebefehl bleibt aktiv; ein Watchdog räumt seinen Ausführungsplatz nicht für eine Doppelaktion frei.

Neue Codex-Aufträge verwenden Ressourcenprotokoll 2. Sie halten während Analyse, API-Lesen, Dateien und Codearbeit keine globale UI-Lease. `ui-access JOB acquire SCOPE` öffnet eine kurze Critical Section; `ui-access JOB release` bestätigt den tatsächlich rückgelesenen Ausgang. Scopes: `planbar-write`, `pipedrive-write`, `outlook-write`, `native-whatsapp`, `browser-read`. Gleiche Write-Scopes werden serialisiert. `operational-checkpoint JOB JSON` unterstützt `safeToYield`, `activeScope` und Fallcheckpoint. Ein lebender oder unklarer Besitzer wird nie anhand von Heartbeat-Alter entfernt.

Bestehende Altworker ohne Ressourcenprotokoll behalten ihre Sperre bis zum sicheren Ende. Dies ist eine reale Übergangsgrenze, keine behauptete Parallelitätsgarantie für bereits laufende Altworker.

## Deterministische Terminierung

`scheduling-runtime.mjs` persistiert qualifizierte Aufträge vor dem Ack und führt sie im vorhandenen Geräteagenten aus. Kein zusätzlicher Daemon. Queue, Claims, Absichten und Zielbelege sind dauerhaft. Maximal drei automatische Wiederanläufe, unveränderte Ursprungsfrist. Unklare Writes werden ausschließlich rückgelesen.

Reihenfolge: vorhandenen Planbar-Termin übernehmen oder belegten freien Slot anlegen/rücklesen; KW zweistellig speichern/rücklesen; gespeichertes Von-/Ziel-Phasenpaar genau einmal anwenden/rücklesen; native Community-Gruppe prüfen, exakt eine Nachricht mit belegter Angebotsnummer senden/rücklesen. Fehlende Angebotsnummer hält nur WhatsApp/Details offen. Details bleiben ein gesonderter Scope; die Schnellspur meldet niemals den ganzen Workflow als completed.

Die produktive Schnellspur setzt einen frischen, eindeutig verifizierten Vorindex aus Kunde, Partner, Objekt, Deal und vorhandenem Planbar-Kunden-/Task-Datensatz voraus. Unqualifizierte Eingaben, öffentliche Requests mit zusätzlicher Bestätigungsmail sowie ENTER-Blockersubstitution bleiben beim bestehenden Workflow. Diese nicht migrierten Pfade besitzen noch keine belegte 30-Sekunden-Garantie. Neue Kunden-/Task-Anlage wird nicht über geratene Endpunkte ausgeführt.

Request `a788fb1e-d23b-48e2-91c7-d48ac18d967f` ist dauerhaft Adopt-only. Kein Ersatztermin nach manuell erfolgter Anlage. Der bestehende Fall hat einen Slot-/KW-Beleg, aber keine rechte Nachbarphase. Ohne fachliche Zielzuordnung keine alternative Pipeline und keine WhatsApp.

## Shards und echte parallele Arbeit

`operations/workflow-orchestrator.js` persistiert explizite Fall-Shards mit idempotenten Schritten, Rückwärtsbudgets, Completion-Barriere, priorisierten Lanes, reservierter Urgent-Kapazität, adaptiver Parallelität, gemeinsamem Arbeitsvorrat und Deltaindex. Nur verifizierte vollständige Shards zählen fertig. Unterbrochene Writer brauchen Reconciliation. Einzelne externe Blocker isolieren nur ihren Fall.

Produktiv sind Förder-API-Lesungen auf sechs parallele Leser und unabhängige Automations-Catch-up-Aufträge auf vier parallele Arbeiter umgestellt. `workflow-batches.js` enthält zusätzlich abgegrenzte Förder-Pflichtfeld-Vorprüfung und Planbar-Beschreibungsprüfung. Diese Analyseadapter ersetzen ausdrücklich keine komplette Förderübergabe oder Mailhistorienbearbeitung.

Vollständige deterministische Migration aller fachlichen Förder-, Mail-, Planbar- und Bauworkflows ist noch nicht nachgewiesen. Ein generischer Shard-Scheduler oder erfolgreiche Mock-Tests erfüllen diese Abnahme allein nicht.

## Sichere Steuerung und Nachweise

`codex.task.cancel` beendet nur unbeanspruchte wartende Aufträge sofort. Bei lebender Ausführung wird der Abbruch vorgemerkt, niemals hart mitten im Write gekillt. `scheduling.request.adopt-existing` und `.supersede` verlangen einen vorhandenen validierten Reservierungsbeleg derselben Zielwoche und verbieten weitere Buchung. Sie erfinden keinen Phasen-/Versandbeleg.

Kontrollzentrum: ursprüngliche SLA-Uhr, Queuezeit, gemeldete Shards, langsamster Schritt, Ressourcensperren/Owner, Prognose und Fristverletzung. Nicht gemeldete Werte bleiben ausdrücklich unbekannt.

Automatisierte Nachweise: `npm run test:result-sla`; darunter 20-fache Deduplizierung, Lanes unter Hintergrundlast, unterschiedliche/gleiche Scopes, KW-Fehler, Crash nach Phasen-PUT, WhatsApp-Reconciliation, manuelle Übernahme, unveränderte Recovery-Frist und vollständige repräsentative Test-Shards. Geräte- und Produktionslatenzen sind gesondert live nachzuweisen; Unit-Tests sind kein Ersatz.

## Nachgewiesene Integrationsgrenzen des Vorindex und der Nacharbeit

`refreshSchedulingPreindex` kann bisher nur bereits verifizierte Zuordnungen aktualisieren. Es existiert noch kein produktiver Bootstrap-Aufruf, der neue Kunden/Deals sicher qualifiziert. Der vorhandene Planbar-Suchindex liefert Termin-ID, Kundenname, Ressource und Zeitraum, aber keinen verifizierten Kunden-/Task-ID-Verbund. Der bestehende Förder-API-Snapshot liefert CRM-Personenname und eine aus dem Deal-Titel abgeleitete Ortsangabe; er liefert keinen geprüften Partner-/Objektbezug zum Planbar-Task. Gleicher Name, HH-Präfix oder Titeltext reicht hierfür nicht. Benötigt wird ein belegter Quellvertrag aus Deal-ID, CRM-Person, Partner, eindeutigem Objekt und tatsächlicher Planbar-Kunden-/Task-ID, einschließlich Eindeutigkeitsprüfung. Ohne diesen Vertrag bleibt eine neue Eingabe beim vorhandenen Workflow. Eine automatisch befüllte oder flächendeckend einsatzfähige Schnellspur ist damit nicht nachgewiesen.

Rückgelesene Schnellspur-Reservierungen werden zusätzlich über einen dauerhaften Nacharbeits-Outbox in den bestehenden Planbar-Vervollständigungsstore übernommen. Dessen vorhandener Schlüssel aus Kunde und Termin verhindert doppelte Fälle. Die Übernahme erhält offene Details und Folgeaktionen; ohne geprüfte Privatkundenzuordnung steht der Fall zunächst auf `scope_pending`. `awaiting_details` und die erfolgreiche Fallübernahme bedeuten ausdrücklich nur dauerhaft erfasste Restarbeit. Dieser Anschluss startet keinen Vervollständigungsarbeiter, keinen Sammellauf und keinen LLM-Auftrag. Automatische fachliche Nacharbeit mit niedriger Priorität und deren Abschlussnachweis bleiben offen.
