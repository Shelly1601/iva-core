import assert from 'node:assert/strict';
import { deliverValidatedPlanbarForecast } from '../local-mac-helper/planbar-forecast-mail.mjs';

const run = Object.freeze({
  period: 'KW 37-46 / 2026',
  sender: 'n.sell@heat-hero.com',
  recipient: 'a.keller@heat-hero.com',
  subject: 'Planbar-Listen KW 37-46 / 2026',
  attachments: ['/forecast/Planbar_Gesamt_KW37-46_2026.xlsx', '/forecast/Planbar_Bosch_KW37-46_2026.xlsx'],
  attachmentNames: ['Planbar_Gesamt_KW37-46_2026.xlsx', 'Planbar_Bosch_KW37-46_2026.xlsx'],
  manifest: { verification: { excludedResourceLeaks: 0 } },
});

function memoryLog(entries = []) {
  const log = { version: 1, entries };
  return { log, loadLog: async () => log, saveLog: async () => {} };
}

{
  const store = memoryLog();
  let sends = 0;
  let freshnessChecks = 0;
  const verifyCurrent = async () => {
    freshnessChecks += 1;
    return { exactMatch: true, sourceCollectedAt: '2026-08-28T16:45:00.000Z', recheckedAt: '2026-08-28T16:55:00.000Z' };
  };
  const sent = async () => {
    sends += 1;
    return { sent: true, sentFolderVerified: true, sentFolder: { folder: 'Gesendet' } };
  };

  const manualTuesday = await deliverValidatedPlanbarForecast(run, {
    ...store, runMode: 'manual', deliveryRunKey: 'manual-request-tuesday', send: sent, verifyCurrent,
  });
  const automaticFriday = await deliverValidatedPlanbarForecast(run, {
    ...store, runMode: 'automatic', automationSlotKey: 'planbar-weekly-export:weekly:2026-W35', send: sent, verifyCurrent,
  });
  const manualWednesday = await deliverValidatedPlanbarForecast(run, {
    ...store, runMode: 'manual', deliveryRunKey: 'manual-request-wednesday', send: sent, verifyCurrent,
  });

  assert.equal(sends, 3, 'zwei ausdrückliche manuelle Aufträge und der Freitagslauf dürfen trotz identischem Inhalt jeweils senden');
  assert.equal(freshnessChecks, 3, 'jeder neue Versand wird unmittelbar vorher gegen Planbar geprüft');
  assert.equal(manualTuesday.deliveryRunKey, 'manual:manual-request-tuesday');
  assert.equal(automaticFriday.deliveryRunKey, 'automatic:planbar-weekly-export:weekly:2026-W35');
  assert.equal(manualWednesday.deliveryRunKey, 'manual:manual-request-wednesday');
  assert.deepEqual(store.log.entries.map(item => item.runMode), ['manual', 'automatic', 'manual']);

  const automaticRetry = await deliverValidatedPlanbarForecast(run, {
    ...store, runMode: 'automatic', automationSlotKey: 'planbar-weekly-export:weekly:2026-W35',
    verifyCurrent: async () => { freshnessChecks += 1; throw new Error('darf bei bestätigter Dublette nicht erneut prüfen'); },
    send: async () => { sends += 1; throw new Error('darf nicht erneut senden'); },
  });
  const manualRetry = await deliverValidatedPlanbarForecast(run, {
    ...store, runMode: 'manual', deliveryRunKey: 'manual-request-tuesday',
    verifyCurrent: async () => { freshnessChecks += 1; throw new Error('darf bei bestätigter Dublette nicht erneut prüfen'); },
    send: async () => { sends += 1; throw new Error('darf nicht erneut senden'); },
  });
  assert.equal(sends, 3, 'nur Wiederholungen derselben stabilen Auftrags-ID werden dedupliziert');
  assert.equal(freshnessChecks, 3, 'bestätigte Versandwiederholungen lösen keine neue Planbar- oder Sendeaktion aus');
  assert.equal(automaticRetry.duplicateVerified, true);
  assert.equal(manualRetry.duplicateVerified, true);
}

{
  const store = memoryLog();
  let sends = 0;
  await assert.rejects(
    deliverValidatedPlanbarForecast(run, {
      ...store,
      runMode: 'manual',
      deliveryRunKey: 'manual-stale-request',
      verifyCurrent: async () => { throw new Error('Planbar wurde nach der Exporterstellung geändert: Elke Mecke verschoben'); },
      send: async () => { sends += 1; return { sent: true, sentFolderVerified: true }; },
    }),
    /Elke Mecke verschoben/,
  );
  assert.equal(sends, 0, 'bei einer Planbar-Abweichung wird Outlook nicht aufgerufen');
  assert.equal(store.log.entries.length, 0, 'vor der Frischeprüfung wird kein Versandversuch protokolliert');
}

{
  const store = memoryLog();
  let sends = 0;
  let verifications = 0;
  const result = await deliverValidatedPlanbarForecast(run, {
    ...store,
    runMode: 'manual',
    deliveryRunKey: 'manual-timeout-request',
    send: async () => { sends += 1; throw new Error('macOS-Oberflächenautomation hat nach 15000 ms abgebrochen.'); },
    verify: async input => {
      verifications += 1;
      assert.equal(input.lookbackSeconds, 120);
      return { verified: true, folder: 'Gesendet' };
    },
  });
  assert.equal(sends, 1);
  assert.equal(verifications, 1);
  assert.equal(result.recoveredAfterUncertainSubmission, true);
  assert.equal(store.log.entries[0].status, 'sent_verified');

  const retry = await deliverValidatedPlanbarForecast(run, {
    ...store,
    runMode: 'manual',
    deliveryRunKey: 'manual-timeout-request',
    send: async () => { sends += 1; throw new Error('darf nicht erneut senden'); },
  });
  assert.equal(sends, 1);
  assert.equal(retry.duplicateVerified, true);
}

await assert.rejects(
  deliverValidatedPlanbarForecast(run, { ...memoryLog(), runMode: 'automatic' }),
  /Wochen-Slot/,
);
await assert.rejects(
  deliverValidatedPlanbarForecast(run, { ...memoryLog(), runMode: 'manual' }),
  /Auftrags-ID/,
);

console.log('PASS Planbar-Forecast zählt Automatik-Slots und ausdrückliche manuelle Aufträge getrennt.');
