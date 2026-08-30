import crypto from 'node:crypto';
import { isoWeekRange, PLANBAR_CAPACITY_RULE_VERSION } from '../operations/customer-scheduling.js';
import { addCustomerSchedulingRequest, getProject } from '../projects/store.js';
import { deviceAgentStatus, enqueueDeviceCommand, listDeviceCommands } from '../device-control/store.js';
import { listAgentRuns } from '../operations/store.js';
import { buildPlanbarCapacityReadTask, PLANBAR_CAPACITY_TASK_TITLE } from '../local-mac-helper/planbar-browser-capacity.mjs';

export const PUBLIC_SCHEDULING_RELEASE = 'imac-central-v7';
export const PUBLIC_SCHEDULING_PATH = '/heat-hero/termin';
export const PUBLIC_SCHEDULING_API = '/heat-hero-termin-api';
const MAX_AGE = 5 * 60_000;
const REFRESH_ATTEMPT_MAX_AGE = 20 * 60_000;
// A dated proposal is not a booking or a claim of live availability. Never use
// this longer display window in the actual Planbar reservation/receipt gate.
export const PUBLIC_SCHEDULING_PREVIEW_MAX_AGE = 24 * 60 * 60_000;
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
  const refreshAttempts = new Map();
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
  function snapshotResult(snapshot) {
    const refreshed = Date.parse(snapshot?.pageRefreshedAt || '');
    const observed = Date.parse(snapshot?.updatedAt || '');
    if (!Number.isFinite(refreshed) || !Number.isFinite(observed) || observed < refreshed
      || observed > now() + 60_000 || refreshed > now() + 60_000
      || snapshot.minimumBlockDays !== 5 || snapshot.countingRuleVersion !== PLANBAR_CAPACITY_RULE_VERSION
      || now() - refreshed > PUBLIC_SCHEDULING_PREVIEW_MAX_AGE) return null;
    const weeks = (snapshot.weeks || []).filter(item => {
      try { return Number.isInteger(item.freeSlots) && item.freeSlots > 0 && item.freeSlots <= 500
        && Date.parse(isoWeekRange(item.isoYear, item.week).startDate) > now(); }
      catch { return false; }
    }).map(({ isoYear, week, freeSlots }) => {
      const range = isoWeekRange(isoYear, week);
      const endDate = new Date(`${range.endDateExclusive}T00:00:00Z`);
      endDate.setUTCDate(endDate.getUTCDate() - 1);
      return { isoYear, week, startDate: range.startDate, endDate: endDate.toISOString().slice(0, 10), availableBlocks: freeSlots };
    });
    const fresh = now() - refreshed <= MAX_AGE;
    return { status: fresh ? 'ready' : 'preview', weeks, updatedAt: snapshot.updatedAt,
      expiresAt: new Date(refreshed + MAX_AGE).toISOString(),
      requestExpiresAt: new Date(refreshed + PUBLIC_SCHEDULING_PREVIEW_MAX_AGE).toISOString(),
      refreshing: false };
  }
  function snapshotTimes(snapshot) {
    const refreshedAt = Date.parse(snapshot?.pageRefreshedAt || '');
    const updatedAt = Date.parse(snapshot?.updatedAt || '');
    return { refreshedAt: Number.isFinite(refreshedAt) ? refreshedAt : 0, updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0 };
  }
  function pruneRefreshAttempts() {
    for (const [nonce, attempt] of refreshAttempts) if (now() - attempt.startedAt > REFRESH_ATTEMPT_MAX_AGE) refreshAttempts.delete(nonce);
  }
  function hasNewSnapshot(snapshot, attempt) {
    const times = snapshotTimes(snapshot);
    return snapshotResult(snapshot) && times.refreshedAt > attempt.baselineRefreshedAt
      && times.updatedAt > attempt.baselineUpdatedAt && times.refreshedAt >= attempt.startedAt - 5_000;
  }
  function previewResult(snapshot, phase = 'queued') {
    const visible = snapshotResult(snapshot);
    return { ...(visible ? { ...visible, status: 'preview' } : { status: 'refreshing', weeks: [], updatedAt: null }),
      refreshing: true, phase };
  }
  function failedRefreshResult(snapshot) {
    const visible = snapshotResult(snapshot);
    return { ...(visible ? { ...visible, status: 'preview' } : { weeks: [], updatedAt: null }), status: 'error', refreshing: false,
      message: 'Die aktuelle Planbar-Prüfung konnte nicht abgeschlossen werden. Der angezeigte ältere Stand ist nur vorläufig. Bitte erneut prüfen.' };
  }
  const isActive = item => ['queued', 'running'].includes(item?.status) && Date.parse(item.expiresAt) > now();
  const isFailed = item => ['failed', 'expired', 'canceled'].includes(item?.status);
  async function availability(formToken) {
    const token = verifyToken(formToken);
    pruneRefreshAttempts();
    const rawSnapshot = (await project())?.planbarCapacity;
    const snapshot = snapshotResult(rawSnapshot);
    const refreshes = await refreshStates();
    const attempt = refreshAttempts.get(token.nonce);
    if (attempt) {
      if (hasNewSnapshot(rawSnapshot, attempt)) {
        refreshAttempts.delete(token.nonce);
        return { ...snapshot, refreshing: false, refreshState: 'completed' };
      }
      const own = refreshes.find(item => item.id === attempt.commandId);
      if (isActive(own)) return previewResult(rawSnapshot, own.status === 'queued' ? 'queued' : 'checking');
      if (isFailed(own) || own?.status === 'completed') {
        refreshAttempts.delete(token.nonce);
        return failedRefreshResult(rawSnapshot);
      }
      return previewResult(rawSnapshot, 'queued');
    }
    const active = refreshes.find(isActive);
    if (active) return previewResult(rawSnapshot, active.status === 'queued' ? 'queued' : 'checking');
    const failed = refreshes.find(item => isFailed(item)
      && Date.parse(item.createdAt) >= token.iat - 30_000);
    if (failed) return failedRefreshResult(rawSnapshot);
    if (snapshot) return snapshot;
    if (refreshes.some(item => item.status === 'completed' && Date.parse(item.createdAt) >= token.iat - 30_000)) {
      return failedRefreshResult(rawSnapshot);
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
    }).sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
  }
  async function refresh(formToken, { force = false } = {}) {
    const token = verifyToken(formToken);
    return transaction(async () => {
      // Fast path: don't wait for the Mac, its queue or a new browser worker
      // when a fully checked, still-fresh snapshot already exists.
      const rawSnapshot = (await project())?.planbarCapacity;
      const snapshot = snapshotResult(rawSnapshot);
      if (snapshot?.status === 'ready' && !force) return snapshot;
      await readyAgent();
      const existing = (await refreshStates()).find(isActive);
      let command = existing;
      if (!command) {
        rateLimit('refresh:global', 8, 60_000);
        command = await enqueue({ action: 'codex.task.start', payload: buildPlanbarCapacityReadTask(), requestedBy: 'heat-hero-public-availability', requestText: 'Montagewochen für den Heat-Hero-Terminlink aktuell prüfen' });
      }
      const baseline = snapshotTimes(rawSnapshot);
      refreshAttempts.set(token.nonce, { startedAt: now(), baselineRefreshedAt: baseline.refreshedAt,
        baselineUpdatedAt: baseline.updatedAt, commandId: command?.id });
      return previewResult(rawSnapshot, command?.status === 'running' ? 'checking' : 'queued');
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
      // This only accepts a non-binding request. The existing iMac workflow
      // MUST reload Planbar before reserving and prove that fresh source check.
      // The public form may submit only while its verified proposal is fresh;
      // the later reservation still performs its independent operational read.
      const proposal = snapshotResult(current?.planbarCapacity);
      if (proposal?.status !== 'ready' || !proposal.weeks.some(item => item.isoYear === data.isoYear && item.week === data.week)) {
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
    app.get(`${PUBLIC_SCHEDULING_API}/session`, handle(async () => ({ formToken: issueToken(),
      availability: snapshotResult((await project())?.planbarCapacity) || { status: 'refreshing', weeks: [], updatedAt: null } })));
    app.post(`${PUBLIC_SCHEDULING_API}/availability`, handle(req => refresh(req.headers['x-form-token'], { force: req.body?.force === true })));
    app.get(`${PUBLIC_SCHEDULING_API}/availability`, handle(req => availability(req.headers['x-form-token'])));
    app.post(`${PUBLIC_SCHEDULING_API}/requests`, handle(req => submit(req.body, req.headers['x-form-token'], req.ip)));
  }
  return { issueToken, verifyToken, refresh, availability, submit, registerRoutes };
}
