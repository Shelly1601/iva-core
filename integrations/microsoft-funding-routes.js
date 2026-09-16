import * as fundingMail from './microsoft-funding-mail.js';

const safeFailure = (res, error) => res.status(Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 409)
  .json({ error: 'Der direkte Förderpostfach-Zugriff konnte nicht abgeschlossen werden. Verbindung und gespeicherten Auftragsstand prüfen.' });
const noStore = res => res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');

// This exact callback is public; the connector consumes short-lived single-use
// state and PKCE before it can store a grant. No caller credentials go into HTML.
export function registerMicrosoftFundingCallback(app, service = fundingMail) {
  app.get('/oauth/microsoft-funding/callback', async (req, res) => {
    noStore(res);
    if (req.query?.error || typeof req.query?.code !== 'string' || typeof req.query?.state !== 'string') {
      return res.status(400).type('text/plain').send('Die Microsoft-Freigabe wurde nicht abgeschlossen. Bitte in IVA erneut verbinden.');
    }
    try {
      await service.completeMicrosoftFundingOAuth({ code: req.query.code, state: req.query.state });
      res.type('text/plain').send('Das Förderpostfach ist direkt mit IVA verbunden und der Postfachzugriff wurde geprüft. Dieses Fenster kann geschlossen werden.');
    } catch {
      res.status(400).type('text/plain').send('Die Microsoft-Freigabe konnte nicht bestätigt werden. Bitte in IVA den Verbindungsstatus prüfen.');
    }
  });
}

// Register after the normal authenticated /api middleware.
export function registerMicrosoftFundingConnectionRoutes(app, service = fundingMail) {
  app.get('/api/funding-mail/connection/status', async (req, res) => {
    noStore(res);
    try { res.json(await service.microsoftFundingMailStatus({ probe: req.query?.probe === '1' })); }
    catch (error) { safeFailure(res, error); }
  });
  app.post('/api/funding-mail/connection/start', async (_req, res) => {
    noStore(res);
    try { res.json({ url: await service.createMicrosoftFundingAuthUrl() }); }
    catch (error) { safeFailure(res, error); }
  });
}

export function registerMicrosoftFundingDeviceRoutes(app, { authorized, deviceId = 'macmini-nadine', service = fundingMail }) {
  const wrap = handler => async (req, res) => {
    noStore(res);
    if (req.params.deviceId !== deviceId || !authorized(req)) return res.sendStatus(401);
    try { await handler(req, res); } catch (error) { safeFailure(res, error); }
  };
  const prefix = '/device-agent/:deviceId/background/funding-mail';
  app.get(`${prefix}/status`, wrap(async (req, res) => res.json(await service.microsoftFundingMailStatus({ probe: req.query?.probe === '1' }))));
  for (const [route, method, fields] of [
    ['page', 'readMicrosoftFundingPage', ['from', 'folder', 'since', 'cursor', 'limit', 'mode']],
    ['message', 'readMicrosoftFundingMessage', ['from', 'folder', 'messageId']],
    ['resolve', 'resolveMicrosoftFundingIdentity', ['from', 'folder', 'messageId']],
    ['move', 'moveMicrosoftFundingMessage', ['from', 'messageId', 'destinationFolder', 'receipt', 'reconcileOnly']],
  ]) app.post(`${prefix}/${route}`, wrap(async (req, res) => {
    const input = Object.fromEntries(fields.filter(key => Object.hasOwn(req.body || {}, key)).map(key => [key, req.body[key]]));
    res.json(await service[method](input));
  }));
  app.post(`${prefix}/attachment`, wrap(async (req, res) => {
    const { from, folder, messageId, attachmentId } = req.body || {};
    const file = await service.downloadMicrosoftFundingAttachment({ from, folder, messageId, attachmentId });
    if (!Buffer.isBuffer(file.buffer) || !file.buffer.length || file.buffer.length > 50 * 1024 * 1024) throw new Error('Invalid attachment size');
    if (file.verified !== true || file.size !== file.buffer.length || !/^[a-f0-9]{64}$/.test(file.sha256 || '') || !/^[a-f0-9]{64}$/.test(file.sourceHash || '')) throw new Error('Missing attachment proof');
    res.set('X-IVA-Verified', 'true').set('X-IVA-Content-SHA256', file.sha256).set('X-IVA-Attachment-Size', String(file.size)).set('X-IVA-Source-Hash', file.sourceHash);
    const filename = String(file.filename || file.name || 'Anlage').replace(/[\r\n\u0000]/g, '').slice(0, 240);
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())}`);
    // Always download: untrusted HTML/SVG must not execute on the IVA origin.
    res.set('X-Content-Type-Options', 'nosniff').type('application/octet-stream').send(file.buffer);
  }));
}
