import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument as ParsedPdfDocument } from 'pdf-lib';
import {
  TOO_OFTEN_FOLLOW_UP_OWNER,
  TOO_OFTEN_LABEL_NAME,
  TOO_OFTEN_LEGACY_GOODWILL_NOTE,
  buildReplyNote,
  buildReclamationOtherText,
  buildTooOftenGatewayRequest,
  classifyTooOftenReplyRules,
  createEmailPdfBuffer,
  createTooOftenReplyStore,
  extractCallbackSchedule,
  resolveReplyLead,
  runTooOftenReplyWorkflow,
  stripQuotedHistory,
} from '../heat-hero/too-often-replies.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-too-often-replies-'));

const noInterest = {
  id: 'mail-no-interest', threadId: 'thread-1',
  from: 'Willi Beispiel <willi@example.test>', to: 'info@heathero.app',
  subject: 'Re: Ihre Anfrage zum Thema Wärmepumpe', date: '2026-08-17T21:11:00+02:00',
  bodyText: 'Es besteht kein Interesse an Ihrer Info. Mit freundlichen Grüßen\n\nAm 17.08.2026 schrieb Heat Hero:\nGuten Tag ...',
};
const callback = {
  id: 'mail-callback', threadId: 'thread-2',
  from: 'Manfred Beispiel <manfred@example.test>', to: 'info@heathero.app',
  subject: 'Re: Ihre Anfrage zum Thema Wärmepumpe', date: '2026-08-22T17:08:00+02:00',
  bodyText: 'Hier meine Handynummer: 0171 3164063. Montag, 24.8. wäre ok!\n\nAm 21.08.2026 schrieb Heat Hero:\nGuten Tag ...',
};

assert.equal(stripQuotedHistory(noInterest.bodyText), 'Es besteht kein Interesse an Ihrer Info. Mit freundlichen Grüßen');
assert.equal(classifyTooOftenReplyRules(noInterest).decision, 'reclamation');
assert.equal(classifyTooOftenReplyRules({ bodyText: 'Vielen Dank. Das Thema hat sich bereits erledigt.' }).decision, 'reclamation');
assert.equal(classifyTooOftenReplyRules({ bodyText: 'Ich habe weiterhin Interesse. Rufen Sie mich morgen ab 15:00 Uhr an.', date: '2026-08-22T10:00:00+02:00' }).decision, 'follow_up');
assert.equal(classifyTooOftenReplyRules({ bodyText: 'Ich habe weiterhin Interesse und bin unter 0151 23456789 erreichbar.', date: '2026-08-22T10:00:00+02:00' }).decision, 'manual_review');
assert.equal(classifyTooOftenReplyRules({ bodyText: 'Ich bin ab 17.08. wieder unter 0152 01766313 erreichbar.', date: '2026-08-06T19:44:00+02:00' }).callbackAt, '2026-08-17T07:00:00.000Z');
assert.equal(classifyTooOftenReplyRules({ bodyText: 'Wir übernehmen die Immobilie erst ab dem 15.10. Vorher ist kein Vor-Ort-Termin möglich. Ich melde mich dann noch einmal.', date: '2026-08-06T17:57:00+02:00' }).decision, 'manual_review');
assert.equal(classifyTooOftenReplyRules({ bodyText: 'Kein Interesse mehr. Bitte löschen Sie meine kompletten Kontaktdaten.' }).privacyRequest, true);

const callbackSchedule = extractCallbackSchedule(callback.bodyText, { messageDate: callback.date });
assert.equal(callbackSchedule.callbackAt, '2026-08-24T07:00:00.000Z');
assert.equal(classifyTooOftenReplyRules(callback).decision, 'follow_up');
assert.equal(TOO_OFTEN_FOLLOW_UP_OWNER, 'setter');
assert.equal(TOO_OFTEN_LABEL_NAME, 'Heat Hero/Zu oft n.e.');

const note = buildReplyNote(noInterest, classifyTooOftenReplyRules(noInterest));
assert.match(note, /E-Mail vom Kunden/);
assert.match(note, /Kundenrückmeldung:/);
assert.match(note, /Kulanzhinweis zum Altbestand:/);
assert.match(note, /Julia Zollner/);
assert.match(note, /Thomas Sommer/);
assert.doesNotMatch(note, /Guten Tag \.\.\./);
assert.equal(buildReclamationOtherText(noInterest), `Siehe Anhang. ${TOO_OFTEN_LEGACY_GOODWILL_NOTE}`);
assert.equal(buildReclamationOtherText({ ...noInterest, date: '2026-08-23T10:00:00+02:00' }), 'Siehe Anhang.');
assert.deepEqual(buildTooOftenGatewayRequest('lead/1', { action: 'reclamation' }), { path: '/lead%2F1/reklamation', method: 'POST', body: { action: 'reclamation' } });
assert.deepEqual(buildTooOftenGatewayRequest('lead-2', { action: 'follow_up' }), { path: '/lead-2/wiedervorlage', method: 'PATCH', body: { action: 'follow_up' } });

const pdf = await createEmailPdfBuffer({ ...noInterest, attachments: [{ filename: 'foto.jpg', mimeType: 'image/jpeg', size: 1234 }] });
assert.equal(pdf.subarray(0, 4).toString('ascii'), '%PDF');
assert.ok(pdf.length > 1500);
const longPdf = await createEmailPdfBuffer({ ...noInterest, bodyText: `${'Lange Kundenmail mit vollständigem Verlauf. '.repeat(2500)}\nEnde der Nachricht.` });
assert.ok((await ParsedPdfDocument.load(longPdf)).getPageCount() >= 3);

const exactEmailResolution = await resolveReplyLead(noInterest, async query => query === 'willi@example.test'
  ? { matchStatus: 'unique', leads: [{ id: 'lead-1', email: 'willi@example.test', telefon: '0171 0000000' }] }
  : { matchStatus: 'not-found', leads: [] });
assert.equal(exactEmailResolution.matched, true);
assert.equal(exactEmailResolution.matchedBy, 'email');

const store = createTooOftenReplyStore({ dataDir: tempDir });
let submissions = 0;
const messages = [
  noInterest,
  callback,
  { id: 'mail-unclear', from: 'Frage <frage@example.test>', subject: 'Re: Anfrage', date: '2026-08-22T12:00:00+02:00', bodyText: 'Auf welcher Nummer haben Sie angerufen?' },
  { id: 'mail-internal', from: 'Heat Hero <info@heathero.app>', subject: 'Re: Anfrage', date: '2026-08-22T13:00:00+02:00', bodyText: 'Interne Antwort.' },
];
const leads = new Map([
  ['willi@example.test', { id: 'lead-no-interest', email: 'willi@example.test' }],
  ['manfred@example.test', { id: 'lead-callback', email: 'manfred@example.test', telefon: '01713164063' }],
]);
const dryRun = await runTooOftenReplyWorkflow({
  listMessages: async input => {
    assert.equal(input.query, 'label:"Heat Hero/Zu oft n.e."');
    assert.equal(input.includeBody, true);
    return { messages };
  },
  findLead: async query => leads.has(query)
    ? { matchStatus: 'unique', leads: [leads.get(query)] }
    : { matchStatus: 'not-found', leads: [] },
  submitAction: async () => { submissions += 1; return { verified: true }; },
  store,
  writeEnabled: false,
  now: new Date('2026-08-22T18:00:00+02:00'),
});
assert.equal(dryRun.status, 'prepared');
assert.equal(dryRun.counts.prepared, 2);
assert.equal(dryRun.counts.needsReview, 1);
assert.equal(dryRun.counts.ignoredInternal, 1);
assert.equal(submissions, 0);
assert.equal((await store.summary()).prepared, 2);

const submittedActions = [];
const liveRun = await runTooOftenReplyWorkflow({
  listMessages: async () => ({ messages }),
  findLead: async query => leads.has(query)
    ? { matchStatus: 'unique', leads: [leads.get(query)] }
    : { matchStatus: 'not-found', leads: [] },
  submitAction: async input => { submittedActions.push(input); return { verified: true }; },
  store,
  writeEnabled: true,
  now: new Date('2026-08-22T18:05:00+02:00'),
});
assert.equal(liveRun.status, 'completed');
assert.equal(liveRun.counts.reclamations, 1);
assert.equal(liveRun.counts.followUps, 1);
const reclamationAction = submittedActions.find(item => item.action.action === 'reclamation').action;
assert.equal(reclamationAction.reclamation.reason, 'Sonstiges');
assert.deepEqual(reclamationAction.reclamation.reasons, ['Sonstiges']);
assert.equal(reclamationAction.reclamation.setStatusReklamiert, true);
assert.match(reclamationAction.reclamation.otherText, /^Siehe Anhang\./);
assert.match(reclamationAction.reclamation.otherText, /Kulanz/);
assert.equal(reclamationAction.attachment.mimeType, 'application/pdf');
assert.equal(submittedActions.find(item => item.action.action === 'follow_up').action.followUp.assignedTo, 'setter');
assert.equal(submittedActions.find(item => item.action.action === 'follow_up').action.followUp.at, '2026-08-24T07:00:00.000Z');
assert.equal((await store.summary()).completed, 2);

await fs.rm(tempDir, { recursive: true, force: true });
console.log('HeatHero-Rückmeldungsworkflow erfolgreich verifiziert.');
