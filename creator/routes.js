import { exportCreatorProduct } from './export.js';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const scope = req => {
  if (req.body?.projectId && req.query.projectId && req.body.projectId !== req.query.projectId) throw fail('Projektangaben widersprechen sich.');
  const projectId = req.query.projectId || req.body?.projectId;
  if (typeof projectId !== 'string' || !projectId) throw fail('Bitte ein Projekt auswählen.');
  return { projectId };
};
const wrap = fn => async (q, r) => {
  r.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  try { await fn(q, r); }
  catch (error) { r.status(error.status || error.statusCode || 500).json({ error: error.status || error.statusCode ? String(error.message).slice(0, 1200) : 'Der Creator-Auftrag konnte nicht abgeschlossen werden. Der gespeicherte Stand bleibt erhalten.', code: error.code || 'CREATOR_ERROR' }); }
};

// Register after the owner API guard; never mount on the external project portal.
export function registerCreatorRoutes(app, { service, context, landing }) {
  const base = '/api/creator';
  app.get(base + '/context', wrap(async (q, r) => r.json(await context(q.query.projectId))));
  app.get(base + '/jobs/:jobId', wrap(async (q, r) => r.json(await service.getJob(scope(q), q.params.jobId))));
  app.post(base + '/jobs/:jobId/cancel', wrap(async (q, r) => r.json(await service.cancelJob(scope(q), q.params.jobId))));
  app.get(base, wrap(async (q, r) => r.json({ products: await service.list(scope(q)) })));
  app.post(base, wrap(async (q, r) => r.status(201).json(await service.create(scope(q), q.body || {}))));
  app.get(base + '/:id', wrap(async (q, r) => r.json(await service.get(scope(q), q.params.id))));
  app.patch(base + '/:id', wrap(async (q, r) => r.json(await service.update(scope(q), q.params.id, q.body || {}))));
  app.post(base + '/:id/sources', wrap(async (q, r) => r.json(await service.addSources(scope(q), q.params.id, q.body || {}))));
  app.post(base + '/:id/snippets', wrap(async (q, r) => r.json(await service.addExactSnippet(scope(q), q.params.id, q.body || {}))));
  app.post(base + '/:id/jobs', wrap(async (q, r) => r.status(202).json(await service.startJob(scope(q), q.params.id, q.body || {}))));
  app.post(base + '/:id/landing', wrap(async (q, r) => r.status(201).json(await landing(scope(q), q.params.id, q.body || {}))));
  app.get(base + '/:id/export', wrap(async (q, r) => {
    const result = await exportCreatorProduct({ ...await service.exportData(scope(q), q.params.id, { versionId: q.query.versionId }), format: q.query.format || 'pdf' });
    r.set({ 'Content-Type': result.contentType, 'Content-Disposition': 'attachment; filename="' + result.filename.replace(/[^a-zA-Z0-9_.-]/g, '_') + '"' }).send(result.buffer);
  }));
}
