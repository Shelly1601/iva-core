// Register behind the existing IVA /api authentication middleware.
export function registerKnowledgeResearchRoutes(app, { service, onError = () => {} }) {
  const handle = action => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await action(req, res); }
    catch (error) {
      const status = Number(error.status || error.statusCode);
      res.status(status >= 400 && status < 600 ? status : 500).json({ error: error.code?.startsWith('KNOWLEDGE_RESEARCH_') ? error.message : 'Die Selbstrecherche konnte gerade nicht verarbeitet werden. Bitte erneut versuchen.' });
    }
  };
  let timer;
  const wake = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; void service.tick().catch(onError); }, 100);
    timer.unref?.();
  };
  app.get('/api/knowledge/research', handle(async (_req, res) => {
    const [plans, capabilities] = await Promise.all([service.list(), service.capabilities()]);
    res.json({ plans, capabilities });
  }));
  app.post('/api/knowledge/research', handle(async (req, res) => {
    const plan = await service.create(req.body || {});
    res.status(201).json({ plan }); wake();
  }));
  app.patch('/api/knowledge/research/:id', handle(async (req, res) => {
    const plan = await service.update(req.params.id, req.body || {});
    res.json({ plan }); wake();
  }));
  app.post('/api/knowledge/research/:id/run', handle(async (req, res) => {
    const plan = await service.runNow(req.params.id);
    res.status(202).json({ plan }); wake();
  }));
}
