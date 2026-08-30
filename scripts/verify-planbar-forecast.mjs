import assert from 'node:assert/strict';
import {
  buildPlanbarForecast,
  extractPlanbarSystem,
  isExcludedPlanbarForecastEntry,
  isoWeekMonday,
  normalizePlanbarCustomerName,
  normalizePlanbarManufacturer,
} from '../local-mac-helper/planbar-forecast.mjs';
import { verifyOutlookXlsxComposeSnapshot } from '../local-mac-helper/macos-ui.mjs';
import { buildSentVerificationAppleScript, buildVerifiedSendAppleScript } from '../local-mac-helper/outlook.mjs';
import { assertPlanbarForecastRowsCurrent } from '../local-mac-helper/planbar-forecast-mail.mjs';

assert.equal(isoWeekMonday(2026, 36), '2026-08-31');
assert.equal(isoWeekMonday(2026, 45), '2026-11-02');
assert.equal(normalizePlanbarCustomerName('HH Peter Galle'), 'Peter Galle');
assert.equal(normalizePlanbarCustomerName('EN Elke Hacker'), 'Elke Hacker');
assert.equal(normalizePlanbarManufacturer('9 KW York'), 'Johnson Controls York');
assert.equal(normalizePlanbarManufacturer('Johnson Controls Wärmepumpe'), 'Johnson Controls York');
assert.equal(normalizePlanbarManufacturer('10 kW Midea'), 'Midea');
assert.equal(extractPlanbarSystem('10 kW Midea, zwei Einzelspeicher, Außenverrohrung 2 m'), '10 kW Midea');
assert.equal(extractPlanbarSystem('Midea M-Thermal Nature Mono R290 8 kW - MHC-V8WD2RN7-BER90\nMaterialannahme: Nein'), 'Midea M-Thermal Nature Mono R290 8 kW - MHC-V8WD2RN7-BER90');
assert.equal(extractPlanbarSystem('2x 14kW - Johnson Controls York, zwei Einzelspeicher'), '2x 14 kW - Johnson Controls York');
assert.equal(extractPlanbarSystem('16 kW Midea ,100L Pufferspeicher'), '16 kW Midea');
assert.match(extractPlanbarSystem('HEAT|HERO Wärmepumpenpaket 10kW - Vaillant\naroTHERM plus (NEU) VWL 105/8.1 A mit Hydraulikstation'), /^10 kW - Vaillant aroTHERM plus/);
assert.equal(isExcludedPlanbarForecastEntry({ team: 'Antonio Lausic', task: '8 kW Midea' }), true);
assert.equal(isExcludedPlanbarForecastEntry({ team: 'Antonio Lausitsch', task: '8 kW Midea' }), true);
assert.equal(isExcludedPlanbarForecastEntry({ team: 'David Service', task: '8 kW Midea' }), true);
assert.equal(isExcludedPlanbarForecastEntry({ team: 'Dawid Service', task: '8 kW Midea' }), true);
assert.equal(isExcludedPlanbarForecastEntry({ team: 'Team Vitalij 1', task: 'URLAUB' }), true);

const base = {
  team: 'Team Vitalij 1',
  start: '2026-09-07 08:00:00',
  end: '2026-09-11 18:00:00',
  customerName: 'HH Peter Galle',
  entryCustomerName: 'HH Peter Galle',
  workAddress: { street: 'Holsteiner Straße 7a', zipcode: '06493', city: 'Ballenstedt' },
  task: 'Midea M-Thermal Nature Mono R290 8 kW - MHC-V8WD2RN7-BER90',
};
const forecast = buildPlanbarForecast([
  { ...base, id: 'peter' },
  { ...base, id: 'peter-duplicate', task: 'Midea 8 kW' },
  { ...base, id: 'overlap', start: '2026-08-26 08:00:00', end: '2026-09-01 18:00:00', customerName: 'Sonja Lewenhagen', entryCustomerName: 'Sonja Lewenhagen', task: '7 kW Vaillant' },
  { ...base, id: 'vacation', customerName: 'gelöscht', entryCustomerName: 'URLAUB', task: 'URLAUB' },
  { ...base, id: 'antonio', team: 'Antonio Lausich', customerName: 'Manfred Ulrich' },
]);
assert.equal(forecast.rowCount, 2);
assert.equal(forecast.rows[0].kalenderwoche, 'KW 36');
assert.equal(forecast.rows[1].kunde, 'Peter Galle');
assert.equal(forecast.rows[1].adresse, 'Holsteiner Straße 7a, 06493 Ballenstedt');
assert.equal(forecast.rows[1].anlage, 'Midea M-Thermal Nature Mono R290 8 kW - MHC-V8WD2RN7-BER90');
assert.equal(forecast.excludedCount, 2);
assert.equal(forecast.sourceRows.some(row => row.planbarColumn === 'Antonio Lausich'), true);
assert.equal(forecast.rows.some(row => row.planbarColumn === 'Antonio Lausich'), false);

assert.deepEqual(assertPlanbarForecastRowsCurrent(forecast.rows, structuredClone(forecast.rows)), { rowCount: forecast.rows.length, exactMatch: true });
assert.throws(
  () => assertPlanbarForecastRowsCurrent(forecast.rows, forecast.rows.map(row => row.kunde === 'Peter Galle' ? { ...row, kalenderwoche: 'KW 38', kalenderwocheNummer: 38 } : row)),
  /Planbar wurde nach der Exporterstellung geändert.*Peter Galle/,
);
assert.throws(
  () => assertPlanbarForecastRowsCurrent(forecast.rows, forecast.rows.filter(row => row.kunde !== 'Peter Galle')),
  /nicht mehr aktuell: Peter Galle/,
);

const attachmentNames = [
  'Planbar_Gesamtliste_KW36-45_2026.xlsx',
  'Planbar_Midea_KW36-45_2026.xlsx',
];
const composeExpectation = {
  from: 'n.sell@heat-hero.com',
  subject: 'Planbar-Listen KW 36-45 / 2026',
  to: ['a.keller@heat-hero.com'],
  attachments: attachmentNames,
};
const composeSnapshot = {
  account: 'Nadine Sell (n.sell@heat-hero.com)',
  subject: composeExpectation.subject,
  recipientEmails: ['n.sell@heat-hero.com', 'a.keller@heat-hero.com'],
  attachmentNames,
};
assert.deepEqual(verifyOutlookXlsxComposeSnapshot(composeSnapshot, composeExpectation).attachments, attachmentNames);
assert.throws(
  () => verifyOutlookXlsxComposeSnapshot({ ...composeSnapshot, attachmentNames: [...attachmentNames, 'Peter_Galle_Angebot.xlsx'] }, composeExpectation),
  /stimmen nicht exakt/,
);
assert.throws(
  () => verifyOutlookXlsxComposeSnapshot({ ...composeSnapshot, recipientEmails: ['n.sell@heat-hero.com'] }, composeExpectation),
  /An-Empfänger/,
);
const sentVerification = buildSentVerificationAppleScript({
  ...composeExpectation,
  attachments: attachmentNames.map(name => `/tmp/${name}`),
});
assert.match(sentVerification.script, /sent items of senderAccount/);
assert.match(sentVerification.script, /was sent of candidate/);
assert.deepEqual(sentVerification.expected.attachments, attachmentNames);
const nativeSend = buildVerifiedSendAppleScript({
  from: composeExpectation.from,
  to: composeExpectation.to,
  subject: composeExpectation.subject,
  body: 'Hallo Angelo,\n\nanbei die Planbar-Listen.\n',
  attachments: attachmentNames.map(name => `/tmp/${name}`),
});
assert.match(nativeSend.script, /email address of accountCandidate as text\) is requestedSender/);
assert.match(nativeSend.script, /email address of default account as text\) is requestedSender/);
assert.match(nativeSend.script, /make new outgoing message with properties/);
assert.match(nativeSend.script, /set sender of draftMessage to \{address:requestedSender\}/);
assert.match(nativeSend.script, /address of sender of draftMessage as text/);
assert.match(nativeSend.script, /set expectedTo to \{"a\.keller@heat-hero\.com"\}/);
assert.match(nativeSend.script, /set expectedAttachmentNames to \{"Planbar_Gesamtliste_KW36-45_2026\.xlsx", "Planbar_Midea_KW36-45_2026\.xlsx"\}/);
assert.match(nativeSend.script, /if senderAccount is not missing value then save draftMessage[\s\S]+send draftMessage/);
assert.match(nativeSend.script, /IVA_SEND_ATTEMPTED\|/);
assert.equal(nativeSend.expectedAttachmentNames.length, 2);
assert.throws(
  () => buildVerifiedSendAppleScript({
    from: composeExpectation.from,
    to: composeExpectation.to,
    subject: composeExpectation.subject,
    body: 'Hallo Angelo',
    attachments: ['/tmp/Planbar.pdf'],
  }),
  /ausschließlich eine oder mehrere XLSX-Anlagen/,
);

console.log('Planbar-Forecast: Regeln, Ausschlüsse, Wochenüberlappung, Dubletten und exakt verifizierter Outlook-Versand geprüft.');
