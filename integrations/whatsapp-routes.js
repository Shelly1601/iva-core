// Mount only after the owner API guard. This module performs no setup calls,
// sends, or bookings while registering routes.
export function registerWhatsAppAutomationRoutes(app, { engine, listProjects }) {
  const base = '/api/whatsapp/automation';
  const wrap = fn => async (req, res) => { res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); try { await fn(req, res); } catch (e) { res.status(e.status || 400).json({ error: e.status || /^Ungültig|^Eine |^Für |^Diese |^Ein aktives/.test(e.message) ? String(e.message).slice(0, 600) : 'Der WhatsApp-Vorgang konnte nicht bestätigt werden. Der gespeicherte Stand bleibt erhalten.', code: e.code || 'WHATSAPP_ERROR' }); } };
  app.get(base + '/config', wrap(async (_q, r) => r.json({ profiles: await engine.listProfiles(), projects: (await listProjects()).map(p => ({ id: p.id, name: p.name })), status: await engine.status() })));
  app.post(base + '/profiles', wrap(async (q, r) => r.status(201).json(await engine.saveProfile(null, q.body || {}))));
  app.patch(base + '/profiles/:id', wrap(async (q, r) => r.json(await engine.saveProfile(q.params.id, q.body || {}))));
  app.delete(base + '/profiles/:id', wrap(async (q, r) => r.json(await engine.removeProfile(q.params.id))));
  app.post(base + '/profiles/:id/verify', wrap(async (q, r) => r.json(await engine.verifyProfile(q.params.id))));
  app.get(base + '/calendly-events', wrap(async (_q, r) => r.json(await engine.listCalendlyEventTypes())));
  app.get(base + '/conversations', wrap(async (q, r) => r.json({ conversations: await engine.listConversations({ projectId: String(q.query.projectId || ''), simulate: q.query.simulate === 'true' }) })));
  app.patch(base + '/conversations/:id/handoff', wrap(async (q, r) => r.json(await engine.updateHandoff(String(q.body.projectId || ''), q.params.id, q.body))));
  app.post(base + '/simulate', wrap(async (q, r) => r.json(await engine.receive({ profileId: String(q.body.profileId || ''), sender: String(q.body.sender || ''), text: String(q.body.message || ''), messageId: String(q.body.messageId || ''), simulate: true }, { simulate: true }))));
}
