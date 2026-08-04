import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-accounting-'));
process.env.DATA_DIR = testDir;

try {
  const accounting = await import('../accounting/store.js?test=' + Date.now());
  const entity = await accounting.createAccountingEntity({ name: 'IVA Test UG', taxMode: 'euer', vatStatus: 'regular' });
  assert.equal((await accounting.listAccountingEntities()).length, 1);

  const first = await accounting.storeAccountingDocument({
    name: 'test-rechnung.pdf', mime: 'application/pdf', entityId: entity.id, buffer: Buffer.from('%PDF-1.4 IVA Test'),
  });
  assert.equal(first.assessment.trafficLight, 'yellow');
  assert.ok(first.file.sha256);

  const reviewed = await accounting.updateAccountingDocument(first.id, {
    vendor: 'Testlieferant GmbH', invoiceDate: '2026-08-04', invoiceNumber: 'R-100',
    category: 'software', amountNet: 100, vatAmount: 19, amountGross: 119,
    businessPurpose: 'Test des internen IVA-Buchhaltungsbereichs',
  });
  assert.equal(reviewed.assessment.trafficLight, 'green');
  assert.equal(reviewed.assessment.workflowStatus, 'ready');

  const duplicate = await accounting.storeAccountingDocument({
    name: 'kopie.pdf', mime: 'application/pdf', entityId: entity.id, buffer: Buffer.from('%PDF-1.4 IVA Test'),
  });
  assert.equal(duplicate.assessment.trafficLight, 'red');
  assert.equal(duplicate.duplicateOf, first.id);

  const summary = await accounting.accountingSummary({ month: '2026-08' });
  assert.equal(summary.counts.all, 2);
  assert.equal(summary.counts.ready, 1);
  assert.equal(summary.counts.blocked, 1);
  assert.equal(summary.taxSubmissionEnabled, false);

  const csv = await accounting.exportAccountingCsv({ month: '2026-08' });
  assert.match(csv, /Testlieferant GmbH/);
  assert.match(csv, /SHA-256/);

  const original = await accounting.readAccountingFile(first.id);
  assert.equal(original.buffer.toString(), '%PDF-1.4 IVA Test');
  console.log('IVA Buchhaltung: Speicher, Originalbeleg, Ampel, Dublette, Monatsstatus und Export erfolgreich geprüft.');
} finally {
  await fs.rm(testDir, { recursive: true, force: true });
}

