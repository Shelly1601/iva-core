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
    name: 'grundriss.pdf', mime: 'application/pdf', kind: 'floorplan', buffer: Buffer.from('%PDF-test'),
  });
  assert.equal(file.kind, 'floorplan');
  const read = await store.readWorkspaceFile(created.id, file.id);
  assert.equal(read.buffer.toString(), '%PDF-test');
  const payroll = await store.storeWorkspaceFile(created.id, {
    name: 'musterabrechnung.pdf', mime: 'application/pdf', kind: 'payroll-sample', buffer: Buffer.from('%PDF-payroll'),
  });
  assert.equal(payroll.kind, 'payroll-sample');

  const list = await store.listWorkspaces({ mode: 'energie' });
  assert.equal(list.length, 1);
  assert.equal(list[0].notes.length, 1);
  assert.equal(list[0].files.length, 2);
  assert.equal('storageName' in list[0].files[0], false);
  console.log('PASS workspaces: CRUD, verschachtelte Daten, Notizen, Dateien und Musterabrechnungs-Upload');
} finally {
  await fs.rm(testDir, { recursive: true, force: true });
}
