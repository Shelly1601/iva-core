# Planbar-Nachziehqueue: Vertrag für die lokale CLI

`local-mac-helper/planbar-completion.mjs` schreibt ausschließlich die lokale, atomare Nachziehqueue. Es liest/schreibt keine Oberfläche, bucht keinen Termin und sendet keine Nachricht. Die CLI muss tatsächliche Beobachtungen aus den zugelassenen Quellen übergeben. Nachstehende Adapter sind Schnittstellenbeispiele, keine implementierten Leser.

```js
import { createPlanbarCompletionStore } from './planbar-completion.mjs';
const store = createPlanbarCompletionStore({ dataDir, tasksDir });

// Nach jedem dauerhaft gespeicherten Terminierungsfortschritt:
await store.capture(request, progress);
// Vor dem Tageslauf: Belege aus vorhandenen codex-tasks nachziehen.
await store.reconcile();
const cases = await store.list();
```

`capture` akzeptiert `request.planbar` oder einen flachen Terminierungsauftrag. Der Beleg aus `buildPlanbarSchedulingFollowup` bestimmt die stabile Fall-ID (HH/Kunde/Termin). Keine zweite Buchung. Pipedrive-/WhatsApp-/Mail-Restaktionen bleiben in `remainingActions` separat erhalten.

## Beginn und tatsächliche Bestandsprüfung

```js
const inventory = await readRealPlanbarInventory(); // vollständiger HH-Privatkundenbestand
await store.beginRun(jobId, {
  scope: 'heat-hero-private',
  refreshedAt: inventory.checkedAt,
  sourceChecks: [
    { source: 'planbar', status: 'read', observedCount: inventory.relevantCount,
      checkedAt: inventory.checkedAt, evidence: inventory.evidence },
    ...otherSourceChecks
  ]
});
```

Die erste Inventur muss beim Aufruf höchstens fünf Minuten alt sein. `observedCount` zählt relevante Bestandsfälle, auch solche ohne bisherige IVA-Buchung. Für diese:

```js
const entry = await store.enqueueObservedCase({
  identity: observed.identity,
  scopeEvidence: observed.scopeEvidence,
  missingDetails: observed.missingDetails,
  preservedNotes: observed.preservedNotes,
  remainingActions: [], runId: jobId
});
```

`identity` enthält `customerId`, `appointmentId`, `resourceId`, `resourceName`, `isoYear`, `week`, `startDate`, `endDateExclusive` (volle Montag-bis-Freitag-Woche). `scopeEvidence`: `partnerId:'heat-hero'`, `customerSegment:'private'|'unknown'`, `identityVerified:true`, `evidence`, frisches `checkedAt`, optional belegte numerische `dealId`. Bestätigte Geschäftskunden/andere Partner werden ausgeschlossen. Unbekannter Privatstatus erlaubt keinen Abschluss.

## Soll, Ist und Belege

```js
await store.recordProof(entry.caseId, {
  expected: extractedOrderDetails,
  actual: reopenedAppointment.details,
  readback: reopenedAppointment.readback,
  sourceEvidence: verifiedFieldSources,
  preservedNotes: originalAppointmentNotes,
  missingDetails: stillUnresolvedDetails,
  externalBlockers: verifiedExternalBlockers
});
```

Soll/Ist: `orderNumber`, `description`, `manufacturer`, numerisches `powerKw`; Bosch zusätzlich `model`, Vaillant `variant:'Plus'|'Pro'`. Bestehende belegte Terminnotizen bleiben Bestandteil der Sollbeschreibung. Fehlende Speicher-/Fachdaten bleiben in `missingDetails`; andere gesicherte Felder können unabhängig nachgezogen werden.

Jeder Feldbeleg: `{field,sourceId,sourceKind,evidence,verified:true,checkedAt}`. Auftragsnummer grundsätzlich `sourceKind:'signed-offer'`. Nur nach vollständiger erfolgloser Unterschriftensuche darf `original-offer` verwendet werden, zusätzlich `identityVerified:true`, `signedOfferSearchComplete:true`, `signedOfferFound:false`, `matchedDealId` identisch zur belegten Fall-Deal-ID und `matchedOfferNumber` identisch zur Soll-Auftragsnummer.

`readback` enthält vollständige unveränderte Terminidentität, `source:'planbar'`, `partnerId:'heat-hero'`, `customerSegment:'private'`, `identityVerified:true`, `firstName:'HH …'`, `checkedAt`, `evidence`. Maximal 15 Minuten alt. Kein freies `status:'completed'` kann einen fehlenden Beleg ersetzen.

## Zweite Rückprüfung und Abschluss

```js
const finalReadbackStartedAt = new Date().toISOString();
const checkedCaseIds = [];
for (const row of relevantCases) {
  const secondRead = await reopenAndReadRealAppointment(row);
  await store.recordProof(row.caseId, secondRead);
  checkedCaseIds.push(row.caseId);
}
const finalReadbackAt = new Date().toISOString();
const proof = await store.finishRun(jobId, {
  checkedCaseIds,
  inventoryComplete: inventory.complete === true,
  finalReadbackStartedAt,
  finalReadbackAt
});
const persistedProof = await store.getRun(jobId);
```

Alle abgeschlossenen Fälle müssen innerhalb dieses zweiten Rückprüfungsfensters gelesen worden sein; Fenster und Belege maximal 15 Minuten alt. Auch null Fälle benötigen die frische vollständige Planbar-Inventur mit `observedCount:0`. Eine leere Liste allein genügt nicht.

Nur das Store-Ergebnis darf als `resultProtocol:2` übernommen werden: `{protocol:2,jobId,scope:'heat-hero-private',inventoryComplete,status,...}`. `completed` entsteht ausschließlich aus passenden Belegen. `partial` ist kein Erfolg. `retryRequired:true` bedeutet technische Lücke/fehlenden Beleg → denselben Job fortsetzen. `retryRequired:false` bei `partial` bedeutet dokumentierte externe Hindernisse; nicht blind wiederholen.

Optionales WhatsApp mit QR-Hindernis: `{source:'whatsapp',status:'unavailable',external:true,reason:'QR-Anmeldung erforderlich'}`; andere Quellen und Bestandsfälle trotzdem bearbeiten. Ist Planbar selbst extern gesperrt, `refreshedAt:null`, Planbar-Quellenstatus `unavailable`, `external:true`; `finishRun` mit `inventoryComplete:false` und null Rückprüfungsdaten erzeugt ausschließlich einen Teilabschluss.

Gezielte Tests: `node scripts/verify-planbar-completion.mjs` (21 Fälle).
