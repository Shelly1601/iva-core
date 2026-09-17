# Terminierungspriorität auf dem Mac Mini

Stand: 17. September 2026.

`planbar.customer.schedule` verwendet weiter den vorhandenen Gerätekanal und denselben gespeicherten Auftrag. Eine atomare Admission-Sperre pro normalisiertem Kundentermin schützt die Suche und Erzeugung des Workers als eine Operation. Auch gestoppte, fehlgeschlagene oder bereits reservierte passende Aufträge werden wiedergegeben, nicht als zweiter Auftrag neu angelegt. Die bestehende Worker-Claim-Prüfung bleibt erhalten.

Bauaufträge und ausdrücklich als Hintergrundarbeit definierte Workflows halten keine globale Desktop-Sperre während Code-, Recherche- oder Testarbeit. Ein Bauauftrag fordert für tatsächliche Browser-/App-Arbeit `ui-access <Job-ID> acquire` an und gibt sie danach mit `release` zurück. Der Runner bestätigt die Freigabe erst nach Erwerb derselben Desktop-Lease, die auch operative UI-Aufträge schützt. Prozessende gibt eine gehaltene Lease frei.

Terminierungen werden mit Priorität 100 vor normalen UI-Wartenden zugelassen. Die Priorität überschreibt keinen lebenden Sperrenbesitzer. Operative Worker führen nach rückgelesenen Aktionen und vor längeren Hintergrundabschnitten `ui-checkpoint <Job-ID>` aus. Erst die ausdrückliche Erklärung eines verifizierten Schreibausgangs ermöglicht die kooperative Abgabe. Der Checkpoint kehrt erst nach neuer exklusiver UI-Zulassung zurück. Eine unklare Schreibaktion bleibt geschützt. Native Maus-/Tastaturzugriffe teilen tatsächlich denselben Desktop und dürfen nicht nur anhand unterschiedlicher App-Namen parallelisiert werden.

Bereits laufende ältere Worker beherrschen dieses Checkpointprotokoll nicht. Sie werden nicht zwangsweise gestoppt oder entsperrt. Auch ein extern belegter Bildschirm oder eine laufende ungeklärte Buchung verhindert eine garantierte Startzeit. Freie UI und ein attestierter Online-Mac sind Voraussetzung für einen schnellen Start; eine Queue-Zulassung ist weiterhin kein Reservierungsbeleg.

Die Reservierungsstrecke erledigt Slot, zweistelliges KW-Feld und einen anhand live gelesener Phasenfolge bestimmten rechten Nachbarn vor Details. Die WhatsApp verlangt native App, exakte Community/Gruppe, konkrete Nachrichtenkennung und eine aus dem unterschriebenen Angebot belegte Auftragsnummer. Fehlende rechte Nachbarphase oder Nummer werden nicht geraten. Die separate Vervollständigungsqueue bleibt zuständig für technische Details und Kontakte.

`milestones` und `steps` im dauerhaft validierten Fortschritt unterscheiden Slot, KW-Feld, Phasenschritt, WhatsApp und offene Details. Verifizierte Folgebelege sind unveränderlich. Neue Schnellspur-Aufträge erhalten `fastLaneProtocol: 1` und können ohne vollständige Folgebelege nicht als completed gemeldet werden. Alte Belege bleiben lesbar, ohne ihnen neue Nachweise zuzuschreiben.

Prüfung: `scripts/verify-scheduling-fast-lane.mjs` testet Prioritätszulassung, sichere Checkpoints, lebende Altsperren, parallele Reservierungen, atomaren Doppelstartschutz, langen Build ohne Desktop-Sperre, explizite UI-Abschnitte, Abbruchbereinigung und KW-/Phasen-/WhatsApp-Beleggates. Die Fälle sind synthetisch; sie buchen keinen echten Kundentermin. Der Test ist in der vollständigen Suite eingebunden.
