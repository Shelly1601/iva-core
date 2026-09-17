# IVA-Ausführung, Kosten und unveränderte Qualität

Nadines Vorgabe vom 17.09.2026: Workflows sollen direkt in IVA laufen; vorhandene KI-Anbieter nur gezielt einsetzen. Insgesamt höchstens 30 EUR zusätzliche KI-Kosten pro Monat. Keine automatischen ChatGPT-Nachkäufe. Sämtliche fachlichen Workflowregeln bleiben verbindlich.

## Verbindliche Abnahme

- Originalquellen, menschliche Notizen und Dokumentinhalte vollständig im vorgesehenen Umfang prüfen; ab bestätigter Erstprüfung nur relevante Änderungen und fällige Schritte.
- Identität, Berechtigungen, richtige Empfänger, Entwurfs-/Versandgrenzen und bestehende Fach-Gates unverändert übernehmen.
- Jede Schreibaktion am Ziel zurücklesen, ungewisse Aktionen vor Wiederholung abgleichen und dauerhafte Abschlussbelege nutzen.
- Modellantwort, Prozessende, Warteschlangenaufnahme oder ein erzeugtes Bild allein sind kein fachlicher Abschlussnachweis.
- Neue Modellrouten zuerst fachlich qualifizieren. Keine stillen Modellwechsel oder gestrichenen Pflichtprüfungen als Sparmaßnahme.
- Bei Budgetmangel den gespeicherten Stand erhalten und den konkreten Engpass melden. Das Kostenlimit erlaubt keinen Qualitätsabbau.

## Umgesetzte Kostenkontrolle

Der zentrale Router reserviert jeden tatsächlichen Textmodellaufruf einschließlich Werkzeugschritten, SDK-Wiederholungen und Streaming persistent vor dem Versand. Maximal 30 EUR Monatsbudget, Warnschwelle 24 EUR. Parallelität und Neustarts teilen dieselbe Abrechnung; ungewisser Verbrauch bleibt reserviert. Fehlende oder widersprüchliche Abrechnung und ungeprüfte Preise erlauben keinen neuen kostenpflichtigen Aufruf. Gemini-Denktokens und Anthropic-Cachetokens werden mitgerechnet. Bereits abgerechnete Aufrufe werden durch alte Aufrufer nicht doppelt berechnet.

Status: geschützter Endpunkt `/api/ai-budget/status`. Beträge sind konservative interne EUR-Werte mit Preisgültigkeit und Wechselkurs-/Steuerpuffer; historische Untererfassung wird ausdrücklich gekennzeichnet. Sie sind kein Abgleich mit Anbieterrechnungen. Bestehende Abonnements und Medien-/Sprachanbieter sind noch nicht Teil dieser Textmodellabrechnung. Vor zusätzlichen kostenpflichtigen Schritten darüber müssen passende Kostenadapter ergänzt werden.

## Tatsächlicher Stand der Workflowmigration

Die vollständige Migration ist noch nicht abgeschlossen. Die elf vorhandenen `PROJECT_WORKFLOW_TASKS` starten weiterhin den bisherigen Codex-Executor. Produktive laufende Aufträge werden während des Umbaus erhalten. Eine bloße Weiterleitung zu `askIva` wäre kein gleichwertiger Ersatz: dauerhafter Ablauf, projektgebundene Fachwerkzeuge, lokale UI-Schritte und fachliche Abschlussprüfung fehlen dort.

`local-mac-helper/native-workflows.mjs` enthält eine getestete, noch nicht in den Dispatch integrierte native Fortsetzung bestehender Forecast-Versandbelege. Sie kann nur einen passenden belegten Abschluss übernehmen oder einen ungewissen ursprünglichen Versand rücklesen; erneutes Senden ist technisch ausgeschlossen. Neue Forecasts sind damit noch nicht ausführbar.

Für die vollständige Umstellung müssen die vorhandenen Fachfunktionen zu dauerhaften ausführbaren Rezepten verbunden werden: Förderfallbearbeitung samt KfW-Test und belegter Übergabe; Forecast-Erstellung samt echter Excel-/Bildprüfung; Planbar-Feldbearbeitung samt Rücklesung; Herstellerportal-/CRM-Aktionen; belegte Materiallisten und gerenderte Sprachfassungen. Erst ein vollständiger repräsentativer Lauf mit unveränderten Fachnachweisen qualifiziert die jeweilige Ersatzroute.
