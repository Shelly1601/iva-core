import express from 'express';

export function registerWebsiteRoutes(app, service) {
  const route = fn => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await fn(req, res); }
    catch (error) { const status = Number(error.status || error.statusCode) || 500; res.status(status === 401 ? 424 : status).json({ error: String(error.message || 'Website-Auftrag fehlgeschlagen.').slice(0, 2000), code: error.code || 'WEBSITE_ERROR' }); }
  };
  const p = req => req.body?.projectId || req.query.projectId;
  const base = '/api/website-studio';
  app.get(base + '/status', route(async (_q, r) => r.json(await service.status())));
  app.get(base + '/projects', route(async (_q, r) => r.json(await service.listProjects())));
  app.post(base + '/connections', route(async (q, r) => r.json(await service.connections.save(q.body || {}))));
  app.get(base + '/sites', route(async (q, r) => r.json(await service.list(p(q)))));
  app.post(base + '/sites', route(async (q, r) => r.status(201).json(await service.create(q.body || {}))));
  app.get(base + '/sites/:id', route(async (q, r) => r.json(await service.site(p(q), q.params.id))));
  app.get(base + '/sites/:id/revisions/:rev', route(async (q, r) => { const revision = await service.revision(p(q), q.params.id, q.params.rev); if (!revision) return r.status(404).json({ error: 'Version nicht gefunden.' }); r.json(revision); }));
  app.get(base + '/sites/:id/preview', route(async (q, r) => r.json(await service.preview(p(q), q.params.id, q.query.revisionId))));
  app.post(base + '/sites/:id/chat', route(async (q, r) => r.status(202).json(await service.chat(p(q), q.params.id, q.body || {}))));
  app.post(base + '/sites/:id/import', route(async (q, r) => r.json(await service.importSite(p(q), q.params.id, q.body || {}))));
  app.post(base + '/sites/:id/import-zip', express.raw({ type: ['application/zip', 'application/octet-stream', 'application/x-zip-compressed'], limit: '25mb' }), route(async (q, r) => {
    if (!Buffer.isBuffer(q.body)) return r.status(400).json({ error: 'ZIP als Binärdatei hochladen.' });
    r.json(await service.importZip(p(q), q.params.id, q.body));
  }));
  app.get(base + '/sites/:id/export', route(async (q, r) => { const bytes = await service.exportZip(p(q), q.params.id); r.set({ 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="iva-website.zip"' }).send(bytes); }));
  app.post(base + '/sites/:id/github', route(async (q, r) => r.json(await service.exportGitHub(p(q), q.params.id, q.body || {}))));
  app.post(base + '/sites/:id/publish', route(async (q, r) => r.json(await service.publish(p(q), q.params.id, q.body || {}))));
  app.post(base + '/sites/:id/restore', route(async (q, r) => r.json(await service.restore(p(q), q.params.id, q.body || {}))));
  app.get(base + '/sites/:id/domain', route(async (q, r) => r.json(await service.domains(p(q), q.params.id))));
  app.post(base + '/sites/:id/domain', route(async (q, r) => r.json(await service.domains(p(q), q.params.id, q.body?.hostname))));
  app.post(base + '/sites/:id/assets', express.raw({ type: '*/*', limit: '3mb' }), route(async (q, r) => {
    if (!Buffer.isBuffer(q.body)) return r.status(400).json({ error: 'Datei als Binärdaten hochladen.' });
    r.json(await service.asset(p(q), q.params.id, q.query.name, q.body));
  }));
}

// Register before the cockpit API guard. This narrow endpoint accepts a separate,
// read-only publication key; it cannot access drafts, accounts or project files.
export function registerWebsitePublicationRoute(app, service) {
  app.get('/_website-published', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const bearer = String(req.headers.authorization || '');
      const value = await service.publishedArtifact({ siteId: req.query.siteId, hostname: req.query.hostname }, bearer.startsWith('Bearer ') ? bearer.slice(7) : '');
      res.json(value);
    } catch (error) { res.status(Number(error.status) || 500).json({ error: error.status === 401 ? 'Unauthorized' : 'Published website unavailable' }); }
  });
}
