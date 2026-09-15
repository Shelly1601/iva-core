import { adviceError } from './comparison.js';
import { exportAdviceCasePdf } from './report.js';
import { fillAdviceForm, inspectAdviceForm } from './form-pdf.js';

const scope = req => {
  if (req.body?.projectId && req.query.projectId && req.body.projectId !== req.query.projectId) throw adviceError('Projektangaben widersprechen sich.', 400);
  return { projectId: req.query.projectId || req.body?.projectId };
};
const wrap = fn => async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  try { await fn(req, res); } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Die Beratungsaktion konnte nicht abgeschlossen werden. Der gespeicherte Stand bleibt erhalten.', code: error.code || 'ADVICE_ERROR' }); }
};
const download = (res, file) => res.set({ 'Content-Type': file.contentType, 'Content-Disposition': `attachment; filename="${file.filename.replace(/[^a-zA-Z0-9_.-]/g, '_')}"` }).send(file.buffer);

// Mount only behind the owner guard. The service additionally checks both the
// project and the customer's project membership for every case operation.
export function registerAdviceWorkbenchRoutes(app, { service, saveCustomerFile }) {
  const base = '/api/advice/workbench';
  app.get(base + '/catalog', wrap(async (q, r) => r.json(await service.catalog(scope(q)))));
  app.get(base + '/cases', wrap(async (q, r) => r.json({ cases: await service.list(scope(q)) })));
  app.post(base + '/cases', wrap(async (q, r) => r.status(201).json(await service.create(scope(q), q.body || {}))));
  app.get(base + '/cases/:id', wrap(async (q, r) => r.json(await service.get(scope(q), q.params.id))));
  app.patch(base + '/cases/:id', wrap(async (q, r) => r.json(await service.update(scope(q), q.params.id, q.body || {}))));
  app.post(base + '/cases/:id/documents', wrap(async (q, r) => r.json(await service.addDocument(scope(q), q.params.id, q.body || {}))));
  app.get(base + '/cases/:id/documents/:documentId', wrap(async (q, r) => { const { buffer, ...document } = await service.document(scope(q), q.params.id, q.params.documentId); r.json(document); }));
  app.get(base + '/cases/:id/documents/:documentId/form-fields', wrap(async (q, r) => r.json({ fields: await inspectAdviceForm((await service.document(scope(q), q.params.id, q.params.documentId)).buffer), submitted: false })));
  app.post(base + '/cases/:id/documents/:documentId/prepare.pdf', wrap(async (q, r) => {
    const record = await service.get(scope(q), q.params.id); if (q.body?.expectedRevision !== record.revision) throw adviceError('Die Beratungsakte wurde inzwischen geändert.', 409, 'ADVICE_REVISION_CONFLICT');
    const original = await service.document(scope(q), q.params.id, q.params.documentId); download(r, await fillAdviceForm({ buffer: original.buffer, values: q.body?.values }));
  }));
  app.get(base + '/cases/:id/report.pdf', wrap(async (q, r) => download(r, await exportAdviceCasePdf(await service.exportRecord(scope(q), q.params.id)))));
  app.post(base + '/cases/:id/file', wrap(async (q, r) => {
    const currentScope = scope(q), input = q.body || {};
    if (!['report', 'form'].includes(input.kind)) throw adviceError('Ablageart muss Bericht oder vorbereitetes Formular sein.');
    if (typeof saveCustomerFile !== 'function') throw adviceError('Die Ablage in der Kundenakte ist noch nicht verbunden.', 503, 'ADVICE_FILE_NOT_CONFIGURED');
    const record = await service.exportRecord(currentScope, q.params.id);
    const sameRevision = value => { if (!Number.isInteger(input.expectedRevision) || value.revision !== input.expectedRevision) throw adviceError('Die Beratungsakte wurde inzwischen geändert. Bitte die aktuelle Fassung laden.', 409, 'ADVICE_REVISION_CONFLICT'); };
    sameRevision(record);
    let file;
    if (input.kind === 'report') file = await exportAdviceCasePdf(record);
    else { const docId = input.docId || input.documentId; if (typeof docId !== 'string' || !docId) throw adviceError('Das Originalformular fehlt.'); const original = await service.document(currentScope, record.id, docId); if (original.contentType !== 'application/pdf') throw adviceError('Nur eine Original-PDF kann als Formular vorbereitet werden.'); file = await fillAdviceForm({ buffer: original.buffer, values: input.values }); }
    // Rendering can take time. Recheck revision and project/customer membership
    // before the separate workspace write; never accept a client PDF or URL.
    const fresh = await service.get(currentScope, record.id); sameRevision(fresh);
    if (fresh.customerId !== record.customerId || fresh.projectId !== record.projectId) throw adviceError('Die Kundenzuordnung hat sich geändert.', 409, 'ADVICE_REVISION_CONFLICT');
    const filename = file.filename.replace(/\.pdf$/i, '') + `-fassung-${record.revision}.pdf`;
    const saved = await saveCustomerFile({ projectId: record.projectId, customerId: record.customerId, filename, contentType: file.contentType, buffer: file.buffer });
    if (!saved || typeof saved.id !== 'string' || !saved.id) throw adviceError('Die Kundenakte hat keine eindeutige Dateiablage bestätigt. Bitte dort prüfen, bevor erneut abgelegt wird.', 502, 'ADVICE_FILE_UNCERTAIN');
    r.status(201).json({ status: 'saved', file: saved, fileId: saved.id, customerId: record.customerId, projectId: record.projectId, caseId: record.id, revision: record.revision, kind: input.kind, submitted: false });
  }));
  app.get(base + '/cases/:id/preparation/:providerId', wrap(async (q, r) => r.json(await service.preparation(scope(q), q.params.id, q.params.providerId))));
  app.put(base + '/favorites', wrap(async (q, r) => r.json({ favorites: await service.setFavorite(scope(q), q.body || {}) })));
  app.put(base + '/providers/:providerId', wrap(async (q, r) => r.json(await service.configureProvider(scope(q), q.params.providerId, q.body || {}))));
}
