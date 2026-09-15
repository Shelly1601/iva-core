import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractText } from 'unpdf';
import { createAdviceWorkbench } from '../advice/workbench.js';
import { registerAdviceWorkbenchRoutes } from '../advice/routes.js';

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-advice-files-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const service = createAdviceWorkbench({ dataDir, getProject: async id => ['alpha', 'beta'].includes(id) ? { id } : null, getCustomer: async (projectId, customerId) => customerId === projectId + '-client' ? { id: customerId, name: 'Synthetische Kundin' } : null });
  const saved = [], saveCustomerFile = async file => { saved.push(file); const id = randomUUID(); await fs.writeFile(path.join(dataDir, id + '.pdf'), file.buffer); return { id, name: file.filename, mime: file.contentType, bytes: file.buffer.length }; };
  const app = express(); app.use(express.json()); registerAdviceWorkbenchRoutes(app, { service: options.wrapService ? options.wrapService(service) : service, saveCustomerFile: options.noAdapter ? undefined : options.saveCustomerFile || saveCustomerFile });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/advice/workbench`, post = async (id, input, projectId = 'alpha') => { const response = await fetch(`${base}/cases/${id}/file?projectId=${projectId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') }; };
  return { service, saved, post, scope: { projectId: 'alpha' }, dataDir };
}
async function formPdf() {
  const pdf = await PDFDocument.create(), page = pdf.addPage(), font = await pdf.embedFont(StandardFonts.Helvetica); page.drawText('Synthetische Originalvorlage - kein echter Antrag', { x: 40, y: 760, size: 12, font });
  const field = pdf.getForm().createTextField('customerName'); field.addToPage(page, { x: 40, y: 690, width: 400, height: 24 }); pdf.getForm().updateFieldAppearances(font); return Buffer.from(await pdf.save());
}

test('report filing renders actual case snapshot and returns a confirmed workspace file ID', async t => {
  const f = await fixture(t), row = await f.service.create(f.scope, { kind: 'finance', customerId: 'alpha-client', title: 'Synthetischer Aktenbericht' });
  const result = await f.post(row.id, { kind: 'report', expectedRevision: row.revision, customerId: 'beta-client', filename: 'attacker.txt', buffer: 'not-a-pdf', url: 'https://invalid.test/ignored' });
  assert.equal(result.status, 201); assert.equal(result.cache, 'no-store'); assert.ok(result.body.fileId); assert.equal(result.body.file.id, result.body.fileId); assert.equal(result.body.submitted, false); assert.equal(result.body.revision, row.revision);
  assert.equal(f.saved.length, 1); assert.equal(f.saved[0].projectId, 'alpha'); assert.equal(f.saved[0].customerId, 'alpha-client'); assert.match(f.saved[0].filename, /fassung-1\.pdf$/); assert.equal(f.saved[0].buffer.subarray(0, 5).toString(), '%PDF-'); const text = await extractText(new Uint8Array(f.saved[0].buffer), { mergePages: true }); assert.match(text.text, /Synthetischer Aktenbericht/);
});

test('form filing uses only case original, verifies field values, and never submits', async t => {
  const f = await fixture(t), created = await f.service.create(f.scope, { kind: 'insurance', category: 'sach', customerId: 'alpha-client', title: 'Formularablage' });
  const row = await f.service.addDocument(f.scope, created.id, { expectedRevision: created.revision, filename: 'original.pdf', contentType: 'application/pdf', buffer: await formPdf() });
  const result = await f.post(row.id, { kind: 'form', expectedRevision: row.revision, docId: row.documents[0].id, values: { customerName: 'Test Anna' } }); assert.equal(result.status, 201); assert.equal(result.body.submitted, false);
  const parsed = await PDFDocument.load(f.saved[0].buffer); assert.equal(parsed.getForm().getTextField('customerName').getText(), 'Test Anna'); assert.match(parsed.getSubject(), /Nicht eingereicht/);
  const original = await PDFDocument.load((await f.service.document(f.scope, row.id, row.documents[0].id)).buffer); assert.equal(original.getForm().getTextField('customerName').getText(), undefined);
  assert.equal((await f.post(row.id, { kind: 'form', expectedRevision: row.revision, docId: row.documents[0].id, values: { unrecognized: 'value' } })).status, 422); assert.equal(f.saved.length, 1);
});

test('wrong project, conflicting scope, missing revision and stale revision perform no file write', async t => {
  const f = await fixture(t), row = await f.service.create(f.scope, { kind: 'finance', customerId: 'alpha-client', title: 'Isolation' });
  assert.equal((await f.post(row.id, { kind: 'report', expectedRevision: 1 }, 'beta')).status, 404);
  assert.equal((await f.post(row.id, { kind: 'report', expectedRevision: 1, projectId: 'beta' })).status, 400);
  assert.equal((await f.post(row.id, { kind: 'report' })).status, 409);
  await f.service.update(f.scope, row.id, { expectedRevision: 1, notes: 'Neue Fassung' }); assert.equal((await f.post(row.id, { kind: 'report', expectedRevision: 1 })).status, 409); assert.equal(f.saved.length, 0);
});

test('revision changed during rendering is rejected before the workspace callback', async t => {
  let change = true; const f = await fixture(t, { wrapService: service => ({ ...service, get: async (scope, id) => { if (change) { change = false; await service.update(scope, id, { expectedRevision: 1, notes: 'Parallel geändert' }); } return service.get(scope, id); } }) });
  const row = await f.service.create(f.scope, { kind: 'finance', customerId: 'alpha-client', title: 'Parallel' }); const result = await f.post(row.id, { kind: 'report', expectedRevision: 1 }); assert.equal(result.status, 409); assert.equal(f.saved.length, 0);
});

test('unconfigured or unconfirmed workspace writes cannot be presented as saved', async t => {
  const f = await fixture(t, { noAdapter: true }), row = await f.service.create(f.scope, { kind: 'finance', customerId: 'alpha-client', title: 'Offline' }); assert.equal((await f.post(row.id, { kind: 'report', expectedRevision: 1 })).status, 503);
  let calls = 0; const g = await fixture(t, { saveCustomerFile: async () => { calls++; return null; } }), second = await g.service.create(g.scope, { kind: 'finance', customerId: 'alpha-client', title: 'Unklar' }); const result = await g.post(second.id, { kind: 'report', expectedRevision: 1 }); assert.equal(result.status, 502); assert.equal(result.body.code, 'ADVICE_FILE_UNCERTAIN'); assert.equal(calls, 1);
});
