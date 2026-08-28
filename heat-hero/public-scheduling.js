import crypto from 'node:crypto';
import { isoWeekRange } from '../operations/customer-scheduling.js';
import { addCustomerSchedulingRequest, getProject } from '../projects/store.js';
import { deviceAgentStatus, enqueueDeviceCommand, listDeviceCommands } from '../device-control/store.js';
import { listAgentRuns } from '../operations/store.js';
import { buildPlanbarCapacityReadTask, PLANBAR_CAPACITY_TASK_TITLE } from '../local-mac-helper/planbar-browser-capacity.mjs';

export const PUBLIC_SCHEDULING_RELEASE = 'imac-central-v7';
export const PUBLIC_SCHEDULING_PATH = '/heat-hero/termin';
export const PUBLIC_SCHEDULING_API = '/heat-hero-termin-api';
const MAX_AGE = 5 * 60_000;
const TOKEN_AGE = 2 * 60 * 60_000;
const ACK = {
  accepted: true,
  nextUrl: '/heat-hero/termin/anfrage-erhalten',
  message: 'Ihre Terminanfrage ist eingegangen. Dies ist noch keine verbindliche Terminbestätigung.',
};

function failure(message, status = 400) { return Object.assign(new Error(message), { status }); }
function field(value, name, max, required = true) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw failure(`Bitte „${name}“ gültig ausfüllen.`);
  }
  const text = value.trim().replace(/\s+/g, ' ');
  if (required && !text) throw failure(`Bitte „${name}“ ausfüllen.`);
  return text;
}

export function validatePublicSchedulingInput(input = {}, now = Date.now()) {
  const firstName = field(input.firstName, 'Vorname', 100);
  const lastName = field(input.lastName, 'Nachname', 100);
  const objectLocation = field(input.objectLocation, 'Standort des Objekts', 180);
  const additionalInfo = field(input.additionalInfo ?? '', 'Sonstige Hinweise', 2000, false);
  if (input.website) throw failure('Die Anfrage konnte nicht übermittelt werden.');
  const isoYear = Number(input.isoYear), week = Number(input.week);
  let range;
  try { range = isoWeekRange(isoYear, week); } catch { throw failure('Bitte eine gültige Kalenderwoche auswählen.'); }
  const monday = Date.parse(`${range.startDate}T00:00:00Z`);
  if (monday <= now || monday > now + 370 * 86400_000) throw failure('Bitte eine zukünftige Kalenderwoche auswählen.');
  if (typeof input.materialDeliverySpace !== 'boolean' || typeof input.theftWeatherProtected !== 'boolean') {
    throw failure('Bitte beide Materialfragen mit Ja oder Nein beantworten.');
  }
  return { firstName, lastName, customerName: `${firstName} ${lastName}`, objectLocation, additionalInfo, isoYear, week,
    materialDeliverySpace: input.materialDeliverySpace, theftWeatherProtected: input.theftWeatherProtected };
}

// No IVA credential, customer list, job ID, contact address or internal result is
// ever returned here. A token is only short-lived CSRF/replay protection, not a
// claim that the anonymous visitor has been identified as the CRM customer.
export function createPublicScheduling({
  project = () => getProject('heat-hero'), addRequest = addCustomerSchedulingRequest,
  agentStatus = deviceAgentStatus, enqueue = enqueueDeviceCommand, commands = listDeviceCommands, runs = listAgentRuns,
  now = () => Date.now(), secret = crypto.randomBytes(32),
} = {}) {
  const limits = new Map();
  let serial = Promise.resolve();
  const transaction = work => { const next = serial.then(work); serial = next.catch(() => {}); return next; };
  const sign = value => crypto.createHmac('sha256', secret).update(value).digest('base64url');
  function issueToken() {
    const body = Buffer.from(JSON.stringify({ nonce: crypto.randomUUID(), iat: now() })).toString('base64url');
    return `${body}.${sign(body)}`;
  }
  function verifyToken(token) {
    if (typeof token !== 'string' || token.length > 400) throw failure('Bitte die Seite neu öffnen.', 403);
    const [body, mac, extra] = token.split('.');
    const expected = sign(body || '');
    if (extra || !mac || mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
      throw failure('Bitte die Seite neu öffnen.', 403);
    }
    let value;
    try { value = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { throw failure('Bitte die Seite neu öffnen.', 403); }
    if (!Number.isFinite(value.iat) || value.iat > now() || now() - value.iat > TOKEN_AGE || !/^[a-f0-9-]{36}$/.test(value.nonce)) {
      throw failure('Die Sitzung ist abgelaufen. Bitte die Seite neu öffnen.', 403);
    }
    return value;
  }
  function rateLimit(key, maximum, duration = 3600_000) {
    for (const [id, value] of limits) if (value.until <= now()) limits.delete(id);
    if (limits.size > 10_000) throw failure('Bitte versuchen Sie es später erneut.', 429);
    const value = limits.get(key) || { count: 0, until: now() + duration };
    if (++value.count > maximum) throw failure('Zu viele Anfragen. Bitte versuchen Sie es später erneut.', 429);
    limits.set(key, value);
  }
  async function readyAgent() {
    const agent = await agentStatus();
    if (!agent.online || (!agent.dispatchReady && !agent.uiBusy) || agent.release !== PUBLIC_SCHEDULING_RELEASE) {
      throw failure('Die Terminprüfung ist gerade nicht erreichbar. Bitte versuchen Sie es in Kürze erneut.', 503);
    }
  }
  function availableWeeks(snapshot, token) {
    const refreshed = Date.parse(snapshot?.pageRefreshedAt || '');
    const observed = Date.parse(snapshot?.updatedAt || '');
    if (!Number.isFinite(refreshed) || !Number.isFinite(observed) || observed < refreshed
      || observed > now() + 60_000 || refreshed > now() + 60_000
      || now() - refreshed > MAX_AGE || refreshed < token.iat - 30_000) return [];
    return (snapshot.weeks || []).filter(item => {
      try { return item.freeSlots > 0 && Date.parse(isoWeekRange(item.isoYear, item.week).startDate) > now(); }
      catch { return false; }
    }).map(({ isoYear, week }) => ({ isoYear, week, ...isoWeekRange(isoYear, week) }));
  }
  async function availability(formToken) {
    const token = verifyToken(formToken);
    const snapshot = (await project())?.planbarCapacity;
    const weeks = availableWeeks(snapshot, token);
    const fresh = Number.isFinite(Date.parse(snapshot?.pageRefreshedAt))
      && now() - Date.parse(snapshot.pageRefreshedAt) <= MAX_AGE
      && Date.parse(snapshot.pageRefreshedAt) >= token.iat - 30_000
      && Date.parse(snapshot.updatedAt) >= Date.parse(snapshot.pageRefreshedAt);
    if (fresh) return { status: 'ready', weeks, updatedAt: snapshot.updatedAt,
      expiresAt: new Date(Date.parse(snapshot.pageRefreshedAt) + MAX_AGE).toISOString() };
    const refreshes = await refreshStates();
    const active = refreshes.find(item => ['queued', 'running'].includes(item.status) && Date.parse(item.expiresAt) > now());
    if (active) return { status: 'refreshing', phase: active.status === 'queued' ? 'queued' : 'checking', weeks: [], updatedAt: null };
    const failed = refreshes.find(item => ['failed', 'expired', 'canceled'].includes(item.status)
      && Date.parse(item.createdAt) >= token.iat - 30_000);
    if (failed) return { status: 'unavailable', weeks: [], updatedAt: null,
      message: 'Die aktuellen Montagewochen konnten noch nicht geprüft werden. Bitte starten Sie die Verfügbarkeitsprüfung erneut.' };
    // A visitor may join after an in-flight reader already reloaded Planbar.
    // Its valid result belongs to earlier visitors, not to this new session.
    // Start a fresh read automatically instead of presenting that as a failure.
    const recentSnapshot = Date.parse(snapshot?.updatedAt) >= Date.parse(snapshot?.pageRefreshedAt)
      && Date.parse(snapshot?.updatedAt) <= now() && Date.parse(snapshot?.pageRefreshedAt) <= now()
      && now() - Date.parse(snapshot?.pageRefreshedAt) <= MAX_AGE;
    if (recentSnapshot) return { status: 'refresh_required', weeks: [], updatedAt: null };
    if (refreshes.some(item => item.status === 'completed' && Date.parse(item.createdAt) >= token.iat - 30_000)) {
      return { status: 'unavailable', weeks: [], updatedAt: null,
        message: 'Die aktuellen Montagewochen konnten noch nicht geprüft werden. Bitte starten Sie die Verfügbarkeitsprüfung erneut.' };
    }
    return { status: 'refreshing', phase: 'checking', weeks: [], updatedAt: null };
  }
  async function refreshStates() {
    const [items, jobRuns] = await Promise.all([commands({ limit: 500 }), runs({ limit: 500 })]);
    return items.filter(item => item.action === 'planbar.search.refresh'
      || (item.action === 'codex.task.start' && item.requestedBy === 'heat-hero-public-availability'
        && item.payload?.title === PLANBAR_CAPACITY_TASK_TITLE)).map(item => {
      if (item.action !== 'codex.task.start' || item.status !== 'completed') return item;
      const run = jobRuns.find(run => run.jobId === item.result?.jobId);
      // Handoff is not completion. A missing run after handoff remains pending
      // only until the original command expiry, never forever.
      const status = !run || ['queued', 'starting'].includes(run.status) ? 'queued'
        : run.status === 'running' ? 'running' : run.status === 'completed' ? 'completed' : 'failed';
      return { ...item, status };
    });
  }
  async function refresh(formToken) {
    verifyToken(formToken);
    return transaction(async () => {
      await readyAgent();
      const existing = (await refreshStates()).find(item => ['queued', 'running'].includes(item.status) && Date.parse(item.expiresAt) > now());
      if (!existing) {
        const state = await availability(formToken);
        if (state.status === 'ready') return state;
        rateLimit('refresh:global', 8, 60_000);
        await enqueue({ action: 'codex.task.start', payload: buildPlanbarCapacityReadTask(), requestedBy: 'heat-hero-public-availability', requestText: 'Montagewochen für den Heat-Hero-Terminlink aktuell prüfen' });
      }
      return { status: 'refreshing', phase: existing?.status === 'running' ? 'checking' : 'queued', weeks: [], updatedAt: null };
    });
  }
  async function submit(input, formToken, client = 'unknown') {
    const token = verifyToken(formToken);
    const data = validatePublicSchedulingInput(input, now());
    return transaction(async () => {
      const current = await project();
      const id = `public-${token.nonce}`;
      const previous = current?.customerSchedulingRequests?.find(item => item.id === id);
      const payloadHash = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
      if (previous) {
        if (previous.publicPayloadHash !== payloadHash) throw failure('Diese Anfrage wurde bereits übermittelt. Bitte für eine neue Anfrage die Seite neu öffnen.', 409);
        return ACK;
      }
      const weeks = availableWeeks(current?.planbarCapacity, token);
      if (!weeks.some(item => item.isoYear === data.isoYear && item.week === data.week)) {
        throw failure('Bitte die freien Kalenderwochen erneut prüfen und eine verfügbare Woche auswählen.', 409);
      }
      rateLimit(`submit:${crypto.createHash('sha256').update(client).digest('hex')}`, 12);
      rateLimit('submit:global', 100);
      const pending = (current?.customerSchedulingRequests || []).filter(item => item.source === 'public-heat-hero'
        && ['requested', 'queued', 'retrying', 'starting', 'running'].includes(item.status));
      if (pending.length >= 25) throw failure('Aktuell werden viele Anfragen geprüft. Bitte versuchen Sie es später erneut.', 503);
      const result = await addRequest('heat-hero', { ...data, partnerId: 'heat-hero' },
        { publicRequest: { id, payloadHash } });
      if (!result) throw failure('Die Anfrage konnte nicht gespeichert werden. Bitte erneut versuchen.', 503);
      return ACK;
    });
  }
  function registerRoutes(app) {
    app.use(PUBLIC_SCHEDULING_API, (req, res, next) => {
      res.set({ 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow' });
      // Requests from the public form are same-origin; do not inherit /api CORS.
      if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Bitte den Terminlink direkt öffnen.' });
      const expectedOrigin = `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'iva-core-production.up.railway.app'}`;
      if (req.headers.origin && req.headers.origin !== expectedOrigin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(req.headers.origin)) {
        return res.status(403).json({ error: 'Bitte den Terminlink direkt öffnen.' });
      }
      try { rateLimit(`http:${req.ip}`, 180, 60_000); next(); }
      catch (error) { res.status(error.status).json({ error: error.message }); }
    });
    const handle = work => async (req, res) => {
      try { res.json(await work(req)); }
      catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : 'Die Terminprüfung ist gerade nicht erreichbar. Bitte später erneut versuchen.' }); }
    };
    app.get(`${PUBLIC_SCHEDULING_API}/session`, handle(() => ({ formToken: issueToken() })));
    app.post(`${PUBLIC_SCHEDULING_API}/availability`, handle(req => refresh(req.headers['x-form-token'])));
    app.get(`${PUBLIC_SCHEDULING_API}/availability`, handle(req => availability(req.headers['x-form-token'])));
    app.post(`${PUBLIC_SCHEDULING_API}/requests`, handle(req => submit(req.body, req.headers['x-form-token'], req.ip)));
  }
  return { issueToken, verifyToken, refresh, availability, submit, registerRoutes };
}
