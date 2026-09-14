import express from 'express';
import { createHash } from 'node:crypto';
import { PROJECT_MODULES } from './store.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const COOKIE = 'iva_portal_session';
const customerValue = value => Array.isArray(value) ? value.map(customerValue) : value && typeof value === 'object' && !Buffer.isBuffer(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => !['github','domain'].includes(key)).map(([key,child]) => [key,customerValue(child)])) : value;
const bucketKey = value => createHash('sha256').update(String(value || '').trim().toLowerCase().slice(0,512)).digest('hex');
const roles = { viewer: 0, editor: 1, publisher: 2 };
const cookieToken = req => {
  const value = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || '';
  return /^[A-Za-z0-9_-]{32,150}$/.test(value) ? value : '';
};
const wrap = fn => async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  try { await fn(req, res); }
  catch (error) { const status = Number(error.status || error.statusCode) || 500; res.status(status).json({ error: status >= 500 ? 'Die Anfrage konnte nicht abgeschlossen werden. Bitte erneut versuchen.' : error.message || 'Zugriff nicht möglich.' }); }
};

export function registerProjectAccessAdminRoutes(app, { access, coreOrigin }) {
  app.get('/api/project-modules', wrap(async (_q, r) => r.json({ catalog: PROJECT_MODULES })));
  app.get('/api/projects/:id/access', wrap(async (q, r) => r.json(await access.getProjectAccess(q.params.id))));
  app.post('/api/projects/:id/access', wrap(async (q, r) => r.json(await access.configure(q.params.id, q.body || {}))));
  app.post('/api/projects/:id/access/invites', wrap(async (q, r) => {
    const result = await access.createInvite(q.params.id, q.body || {});
    r.status(201).json({ inviteUrl: `${coreOrigin}/portal#invite=${encodeURIComponent(result.token)}`, email: result.email, expiresAt: result.expiresAt });
  }));
  app.delete('/api/projects/:id/access/members/:userId', wrap(async (q, r) => r.json(await access.revokeProjectAccess(q.params.id, q.params.userId))));
}

// Mount before the IVA admin guard. Each route below has its own customer
// session and project/module/operation authorization; admin credentials are
// deliberately not accepted here.
export function registerPortalRoutes(app, { access, websites, coreOrigin, env = process.env }) {
  const router = express.Router();
  router.use(express.json({ limit: '32kb' }));
  const secure = new URL(coreOrigin).protocol === 'https:';
  const attempts = new Map();
  function rate(req, key, max = 12) {
    const address = req.socket?.remoteAddress || 'unknown';
    const bucket = key + '/' + address;
    const old = attempts.get(bucket);
    const value = old && old.until > Date.now() ? old : { count: 0, until: Date.now() + 15 * 60000 };
    if (++value.count > max) throw fail('Zu viele Anfragen. Bitte in einigen Minuten erneut versuchen.', 429);
    if (attempts.size >= 1000) for (const [id, row] of attempts) if (row.until <= Date.now()) attempts.delete(id);
    if (attempts.size >= 2000 && !attempts.has(bucket)) throw fail('Bitte später erneut versuchen.', 429);
    attempts.set(bucket, value);
  }
  function sameOrigin(req) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (req.headers.origin && req.headers.origin !== coreOrigin || req.headers['sec-fetch-site'] === 'cross-site') throw fail('Diese Anfrage gehört nicht zu deinem Kundenzugang.', 403);
    if (!req.headers.origin && req.headers['sec-fetch-site'] !== 'same-origin') throw fail('Die Herkunft der Anfrage konnte nicht geprüft werden.', 403);
  }
  router.use((req, res, next) => { try { sameOrigin(req); next(); } catch (error) { res.status(error.status).json({ error: error.message }); } });
  const sessionCookie = (res, token) => res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/api/portal; HttpOnly; SameSite=Strict; Max-Age=28800${secure ? '; Secure' : ''}`);
  router.post('/login', wrap(async (q, r) => {
    rate(q, 'login/' + bucketKey(q.body?.email));
    rate(q, 'login-total', 300);
    const result = await access.login({ email: q.body?.email, password: q.body?.password });
    sessionCookie(r, result.sessionToken);
    r.json({ user: result.user, projects: result.projects });
  }));
  router.post('/accept', wrap(async (q, r) => {
    rate(q, 'accept/' + bucketKey(q.body?.token));
    rate(q, 'accept-total', 300);
    const result = await access.acceptInvite({ token: q.body?.token, password: q.body?.password });
    sessionCookie(r, result.sessionToken);
    r.json({ user: result.user, projects: result.projects });
  }));
  router.get('/session', wrap(async (q, r) => { const result = await access.session(cookieToken(q)); if (!result) throw fail('Bitte anmelden.', 401); r.json(result); }));
  router.post('/logout', wrap(async (q, r) => {
    await access.logout(cookieToken(q));
    r.setHeader('Set-Cookie', `${COOKIE}=; Path=/api/portal; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
    r.json({ ok: true });
  }));
  const p = q => {
    if (q.body?.projectId && q.query.projectId && q.body.projectId !== q.query.projectId) throw fail('Widersprüchlicher Projektzugriff.', 403);
    return q.body?.projectId || q.query.projectId;
  };
  async function permit(q, action = 'read') {
    const projectId = p(q);
    if (typeof projectId !== 'string' || !projectId) throw fail('Bitte ein freigegebenes Projekt wählen.', 403);
    await access.requireAccess(cookieToken(q), projectId, { module: 'websites', action });
    return projectId;
  }
  const contextFor = (q, projectId) => ({active:true,controller:new AbortController(),authorizeOperation:async action=>{if(['github','domain','connections'].includes(action))throw fail('Diese Aktion ist ausschließlich in der Admin-Ansicht verfügbar.',403);await access.requireAccess(cookieToken(q),projectId,{module:'websites',action});}});
  const base = '/website-studio';
  router.get(base + '/projects', wrap(async (q, r) => {
    const session = await access.session(cookieToken(q));
    if (!session) throw fail('Bitte anmelden.', 401);
    r.json(session.projects.filter(p => p.modules.includes('websites')).map(({ projectId, name }) => ({ id: projectId, name })));
  }));
  router.get(base + '/status', wrap(async (q, r) => {
    const session = await access.session(cookieToken(q));
    if (!session) throw fail('Bitte anmelden.', 401);
    if (q.query.projectId) await permit(q);
    const grant = session.projects.find(project => project.projectId === q.query.projectId && project.modules.includes('websites'));
    if (!grant) return r.json({models:[],github:{configured:false},hosting:{configured:false},capabilities:{role:'viewer',canEdit:false,canPublish:false,canExport:false,dailyBuildLimit:0}});
    const status = await websites.status();
    const role = grant?.role || 'viewer';
    r.json({ models: status.models, github: { configured: false }, hosting: { configured: status.hosting.configured }, capabilities: { role, canEdit: roles[role] >= 1, canPublish: role === 'publisher', canExport: roles[role] >= 1, dailyBuildLimit: grant?.dailyBuildLimit || 0 } });
  }));
  router.get(base + '/sites', wrap(async (q, r) => r.json(customerValue(await websites.list(await permit(q))))));
  router.post(base + '/sites', wrap(async (q, r) => { const projectId = await permit(q, 'edit'); r.status(201).json(await websites.create({ projectId, name: q.body?.name, sourceUrl: q.body?.sourceUrl })); }));
  router.get(base + '/sites/:id', wrap(async (q, r) => { const site = await websites.site(await permit(q), q.params.id); r.json({ ...site, github: null, domain: null }); }));
  router.get(base + '/sites/:id/preview', wrap(async (q, r) => r.json(await websites.preview(await permit(q), q.params.id, q.query.revisionId))));
  router.get(base + '/sites/:id/revisions/:rev', wrap(async (q, r) => r.json(await websites.revision(await permit(q, 'export'), q.params.id, q.params.rev))));
  router.post(base + '/sites/:id/chat', wrap(async (q, r) => {
    const projectId = await permit(q, 'build');
    rate(q, 'chat/' + bucketKey(cookieToken(q)), 60);
    // Verify site binding before consuming the customer's quota.
    await websites.site(projectId, q.params.id);
    let quotaCounted = false;
    const authorizeOperation = async action => {
      if (['github', 'domain', 'connections'].includes(action)) throw fail('Diese Aktion ist ausschließlich in der Admin-Ansicht verfügbar.', 403);
      await access.requireAccess(cookieToken(q), projectId, { module: 'websites', action });
      if (!quotaCounted && ['read', 'build'].includes(action)) { await access.consumeBuildQuota(cookieToken(q), projectId); quotaCounted = true; }
    };
    const result = await websites.chat(projectId, q.params.id, { message: q.body?.message, model: q.body?.model, baseRevisionId: q.body?.baseRevisionId }, { authorizeOperation });
    r.status(202).json(result);
  }));
  router.post(base + '/sites/:id/import', wrap(async (q, r) => {
    const projectId = await permit(q, 'edit');
    if (q.body?.kind !== 'url') throw fail('Repository-Verbindungen werden durch den Projektadmin verwaltet.', 403);
    r.json(customerValue(await websites.importSite(projectId, q.params.id, { kind: 'url', url: q.body.url }, false, contextFor(q,projectId))));
  }));
  router.post(base + '/sites/:id/import-zip', express.raw({ type: ['application/zip', 'application/octet-stream', 'application/x-zip-compressed'], limit: '25mb' }), wrap(async (q, r) => {
    const projectId = await permit(q, 'edit');
    if (!Buffer.isBuffer(q.body)) throw fail('ZIP als Binärdatei hochladen.');
    r.json(customerValue(await websites.importZip(projectId, q.params.id, q.body)));
  }));
  router.post(base + '/sites/:id/assets', express.raw({ type: '*/*', limit: '3mb' }), wrap(async (q, r) => {
    const projectId = await permit(q, 'edit');
    if (!Buffer.isBuffer(q.body)) throw fail('Datei als Binärdaten hochladen.');
    r.json(customerValue(await websites.asset(projectId, q.params.id, q.query.name, q.body)));
  }));
  router.post(base + '/sites/:id/restore', wrap(async (q, r) => r.json(customerValue(await websites.restore(await permit(q, 'edit'), q.params.id, { revisionId: q.body?.revisionId, baseRevisionId: q.body?.baseRevisionId })))));
  router.post(base + '/sites/:id/publish', wrap(async (q,r)=>{const projectId=await permit(q,'publish');r.json(await websites.publish(projectId,q.params.id,{revisionId:q.body?.revisionId},false,contextFor(q,projectId)));}));
  router.get(base + '/sites/:id/export', wrap(async (q, r) => {
    const bytes = await websites.exportZip(await permit(q, 'export'), q.params.id);
    r.set({ 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="website.zip"' }).send(bytes);
  }));
  router.use((_q, r) => r.status(404).json({ error: 'Dieser Bereich ist im Kundenzugang nicht verfügbar.' }));
  router.use((error,_q,r,_next)=>r.status(error.status===413?413:400).json({error:'Die Eingabe konnte nicht verarbeitet werden.'}));
  app.use('/api/portal', router);
}
