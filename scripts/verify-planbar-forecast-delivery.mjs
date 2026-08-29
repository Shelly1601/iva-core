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
  const result = await deliverValidatedPlanbarForecast(run, {
    ...store,
    runMode: 'automatic',
    automationSlotKey: 'planbar-weekly-export:weekly:2026-W35',
    send: async () => { sends += 1; throw new Error('darf nicht senden'); },
    verify: async () => ({ verified: true, folder: 'Gesendet' }),
  });
  assert.equal(sends, 0, 'ein bereits in Gesendet gefundener Forecast wird niemals erneut verschickt');
  assert.equal(result.recoveredFromSentFolder, true);
  assert.equal(store.log.entries[0].runMode, 'automatic');
  assert.equal(store.log.entries[0].automationSlotKey, 'planbar-weekly-export:weekly:2026-W35');
}

{
  const store = memoryLog();
  let sends = 0;
  let verifications = 0;
  const verify = async () => {
    verifications += 1;
    if (verifications === 1) throw new Error('Gesendet-Prüfung: Die Nachricht wurde nicht eindeutig im Gesendet-Ordner gefunden. (562)');
    return { verified: true, folder: 'Gesendet' };
  };
  const result = await deliverValidatedPlanbarForecast(run, {
    ...store,
    runMode: 'manual',
    send: async () => { sends += 1; throw new Error('macOS-Oberflächenautomation hat nach 15000 ms abgebrochen.'); },
    verify,
  });
  assert.equal(sends, 1);
  assert.equal(result.recoveredAfterUncertainSubmission, true);
  assert.equal(store.log.entries[0].status, 'sent_verified');

  const automatic = await deliverValidatedPlanbarForecast(run, {
    ...store,
    runMode: 'automatic',
    automationSlotKey: 'planbar-weekly-export:weekly:2026-W35',
    send: async () => { sends += 1; throw new Error('darf nicht erneut senden'); },
    verify,
  });
  assert.equal(sends, 1, 'manueller und automatischer Lauf bleiben getrennt, der identische tatsächliche Versand bleibt dedupliziert');
  assert.equal(automatic.duplicateVerified, true);
  assert.equal(store.log.entries[0].runMode, 'manual', 'der manuelle Lauf wird nicht nachträglich zum Automatiklauf umetikettiert');
}

{
  const store = memoryLog();
  let sends = 0;
  await assert.rejects(
    deliverValidatedPlanbarForecast(run, {
      ...store,
      runMode: 'manual',
      send: async () => { sends += 1; },
      verify: async () => { throw new Error('Outlook-Automation hat das Zeitlimit überschritten.'); },
    }),
    /Gesendet-Ordner konnte vor dem Versand nicht sicher geprüft/,
  );
  assert.equal(sends, 0, 'bei einer technisch fehlgeschlagenen Vorprüfung wird nicht gesendet');
}

await assert.rejects(
  deliverValidatedPlanbarForecast(run, { ...memoryLog(), runMode: 'automatic' }),
  /Wochen-Slot/,
);

console.log('PASS Planbar-Forecast trennt manuelle und automatische Läufe und verhindert Doppelversand.');
