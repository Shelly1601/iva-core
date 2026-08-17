import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import assert from 'assert/strict';

const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-workspaces-'));
process.env.DATA_DIR = testDir;

try {
  const store = await import('../workspaces/store.js?verify=' + Date.now());
  for (const kind of ['lumit-application', 'lumit-policy-original', 'lumit-brand-asset', 'lumit-customer-package']) {
    assert.ok(store.FILE_KINDS.includes(kind), `LUMIT-Dateityp fehlt: ${kind}`);
  }
  const created = await store.createWorkspace({
    mode: 'energie',
    title: 'Test Energieplanung',
    customer: { name: 'Testkunde' },
    data: { building: { floorHeight: '2.50' }, rooms: [{ name: 'Wohnzimmer' }] },
  });
  assert.equal(created.mode, 'energie');
  assert.equal(created.customer.name, 'Testkunde');
  assert.equal(created.data.building.floorHeight, '2.50');
  assert.equal(created.data.rooms[0].name, 'Wohnzimmer');

  const updated = await store.updateWorkspace(created.id, {
    visit: { consent: { granted: true, method: 'digital' }, plaud: { recordingId: 'rec-test' } },
  });
  assert.equal(updated.visit.consent.granted, true);
  assert.equal(updated.visit.plaud.recordingId, 'rec-test');

  await store.addWorkspaceNote(created.id, 'Heizkoerper Typ 22 bestaetigt.', 'test');
  const file = await store.storeWorkspaceFile(created.id, {
    name: 'grundriss.pdf', mime: 'application/pdf', kind: 'floorplan', category: 'floorplan', buffer: Buffer.from('%PDF-test'),
  });
  assert.equal(file.kind, 'floorplan');
  assert.equal(file.category, 'floorplan');
  const read = await store.readWorkspaceFile(created.id, file.id);
  assert.equal(read.buffer.toString(), '%PDF-test');
  const payroll = await store.storeWorkspaceFile(created.id, {
    name: 'musterabrechnung.pdf', mime: 'application/pdf', kind: 'payroll-sample', buffer: Buffer.from('%PDF-payroll'),
  });
  assert.equal(payroll.kind, 'payroll-sample');
  assert.equal(payroll.category, 'general');

  const list = await store.listWorkspaces({ mode: 'energie' });
  assert.equal(list.length, 1);
  assert.equal(list[0].notes.length, 1);
  assert.equal(list[0].files.length, 2);
  assert.equal('storageName' in list[0].files[0], false);

  const customer = await store.createWorkspace({
    mode: 'kunde',
    title: 'Mara Muster · Kundenakte',
    customer: {
      name: 'Mara Muster', salutationKey: 'female', salutation: 'Frau', firstName: 'Mara', lastName: 'Muster',
      email: 'mara@example.test', phone: '+49 170 1234567', street: 'Testweg 1', zip: '12345', city: 'Berlin', brokerId: '009T7N',
    },
    data: { crm: { project: 'Goals & Concepts', sourceId: 'L-1', sourceKey: 'Goals & Concepts:L-1' } },
    notes: [{ text: 'CRM-Notiz eins', source: 'crm:Goals & Concepts' }],
  });
  assert.equal(customer.status, 'active', 'Kundenakte darf nicht pauschal als Entwurf markiert werden');
  assert.equal(customer.customer.salutation, 'Frau');
  assert.equal(customer.notes.length, 1);

  const importedAgain = await store.createWorkspace({
    mode: 'kunde',
    title: 'Mara Muster · Kundenakte',
    customer: { name: 'Mara Muster', phone: '+49 170 7654321' },
    data: { crm: { project: 'Goals & Concepts', sourceId: 'L-1', sourceKey: 'Goals & Concepts:L-1' } },
    notes: [
      { text: 'CRM-Notiz eins', source: 'crm:Goals & Concepts' },
      { text: 'CRM-Notiz zwei', source: 'crm:Goals & Concepts' },
    ],
  });
  assert.equal(importedAgain.id, customer.id, 'derselbe CRM-Datensatz darf keine zweite Kundenakte erzeugen');
  assert.equal(importedAgain.customer.email, 'mara@example.test', 'nicht erneut gelieferte Felder bleiben erhalten');
  assert.equal(importedAgain.customer.phone, '+49 170 7654321');
  assert.equal(importedAgain.notes.length, 2, 'CRM-Notizen werden ergänzt und dedupliziert');
  assert.equal((await store.listWorkspaces({ mode: 'kunde' })).length, 1);

  await assert.rejects(
    store.addWorkspaceMeeting(customer.id, { title: 'Ohne Einwilligung', internalSummary: 'Test' }),
    /Einwilligung/,
  );
  const meetingResult = await store.addWorkspaceMeeting(customer.id, {
    source: 'plaud', externalId: 'plaud-rec-1', title: 'Strategiegespräch', occurredAt: '2026-08-13T10:00:00.000Z',
    internalSummary: 'Die Ruhestandsplanung wurde besprochen.', customerSummary: 'Wir haben Ihre Ruhestandsplanung und die nächsten Schritte besprochen.',
    decisions: ['Versorgungslücke berechnen'], actionItems: ['Unterlagen bis Freitag bereitstellen'],
    consent: { granted: true, method: 'mündlich vor Gespräch' },
  });
  assert.equal(meetingResult.duplicate, false);
  assert.equal(meetingResult.meeting.source, 'plaud');
  const duplicateMeeting = await store.addWorkspaceMeeting(customer.id, {
    source: 'plaud', externalId: 'plaud-rec-1', title: 'Doppelt', internalSummary: 'Doppelt',
    consent: { granted: true },
  });
  assert.equal(duplicateMeeting.duplicate, true, 'PLAUD-Aufnahmen werden über die externe ID dedupliziert');

  const draftResult = await store.createWorkspaceFollowUpDraft(customer.id, { meetingIds: [meetingResult.meeting.id] });
  assert.equal(draftResult.draft.status, 'draft');
  assert.equal(draftResult.draft.to, 'mara@example.test');
  assert.match(draftResult.draft.body, /Ruhestandsplanung/);
  assert.match(draftResult.draft.body, /Unterlagen bis Freitag/);
  const editedDraft = await store.updateWorkspaceFollowUpDraft(customer.id, draftResult.draft.id, { subject: 'Unser Gespräch', status: 'opened' });
  assert.equal(editedDraft.draft.subject, 'Unser Gespräch');
  assert.equal(editedDraft.draft.status, 'opened');

  const deleted = await store.deleteWorkspace(customer.id, { mode: 'kunde' });
  assert.equal(deleted.id, customer.id);
  assert.equal(await store.getWorkspace(customer.id), null);
  assert.equal((await store.listWorkspaces({ mode: 'kunde' })).length, 0);
  console.log('PASS workspaces: CRUD, Notizen, Dateien, Meetings und Follow-up-Entwürfe');
} finally {
  await fs.rm(testDir, { recursive: true, force: true });
}
