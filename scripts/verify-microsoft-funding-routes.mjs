import assert from 'node:assert/strict';
import express from 'express';
import { createHash } from 'node:crypto';
import { macMiniAccessMiddleware } from '../device-control/macmini-access.js';
import { registerMicrosoftFundingCallback, registerMicrosoftFundingConnectionRoutes, registerMicrosoftFundingDeviceRoutes } from '../integrations/microsoft-funding-routes.js';

const oldToken = process.env.API_TOKEN;
process.env.API_TOKEN = 'mock-cockpit-credential-for-test-only';
let calls = 0;
const service = {
  microsoftFundingMailStatus: async () => ({ ready: false, configured: false }),
  createMicrosoftFundingAuthUrl: async () => { calls++; return 'https://login.microsoftonline.com/test'; },
  completeMicrosoftFundingOAuth: async ({ code, state }) => { calls++; assert.equal(code, 'valid-code'); if (state !== 'valid-state') throw new Error('secret-do-not-expose'); return { ready: true }; },
  readMicrosoftFundingPage: async input => { calls++; assert.equal(input.untrustedGraphUrl, undefined); return { source: 'microsoft-graph', messages: [], complete: false }; },
  readMicrosoftFundingMessage: async () => { calls++; return { messageId: '<test@example.com>' }; },
  resolveMicrosoftFundingIdentity: async () => ({ identityVerified: true }),
  moveMicrosoftFundingMessage: async input => { calls++; if (!input.receipt) throw new Error('secret-do-not-expose'); return { moved: true }; },
  downloadMicrosoftFundingAttachment: async () => { const buffer=Buffer.from('<html>untrusted</html>'); return { filename: '../Anlage.html', buffer, verified:true, size:buffer.length, sha256:createHash('sha256').update(buffer).digest('hex'), sourceHash:'a'.repeat(64) }; },
};
const app = express();
app.use(macMiniAccessMiddleware);
registerMicrosoftFundingCallback(app, service);
app.use(express.json());
registerMicrosoftFundingDeviceRoutes(app, { authorized: req => req.headers.authorization === 'Bearer test-device-only', service });
registerMicrosoftFundingConnectionRoutes(app, service);
const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
const base = `http://127.0.0.1:${server.address().port}`;
const request = (pathname, { token, method = 'GET', body } = {}) => fetch(base + pathname, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
try {
  for (const [pathname, method] of [
    ['/api/funding-mail/connection/start', 'POST'], ['/api/funding-mail/connection/status', 'GET'],
    ['/oauth/microsoft-funding/callback', 'POST'], ['/oauth/microsoft-funding/callback/extra', 'GET'],
    ['/oauth/microsoft-funding/callback/', 'GET'],
  ]) assert.ok([401, 403].includes((await request(pathname, { method })).status));
  assert.equal(calls, 0);
  let response = await request('/oauth/microsoft-funding/callback?error=access_denied');
  assert.equal(response.status, 400); assert.equal(calls, 0);
  response = await request('/oauth/microsoft-funding/callback?code=valid-code&state=wrong');
  assert.equal(response.status, 400); assert.ok(!(await response.text()).includes('secret'));
  response = await request('/oauth/microsoft-funding/callback?code=valid-code&state=valid-state');
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const token = process.env.API_TOKEN;
  assert.equal((await (await request('/api/funding-mail/connection/status', { token })).json()).ready, false);
  assert.match((await (await request('/api/funding-mail/connection/start', { token, method: 'POST' })).json()).url, /^https:\/\/login\.microsoftonline\.com/);
  for (const suffix of ['status', 'page', 'message', 'attachment', 'resolve', 'move']) {
    const method = suffix === 'status' ? 'GET' : 'POST';
    assert.equal((await request(`/device-agent/macmini-nadine/background/funding-mail/${suffix}`, { token, method, body: method === 'POST' ? {} : undefined })).status, 401, 'cockpit cannot impersonate device');
    assert.equal((await request(`/device-agent/other-device/background/funding-mail/${suffix}`, { token: 'test-device-only', method, body: method === 'POST' ? {} : undefined })).status, 401);
  }
  response = await request('/device-agent/macmini-nadine/background/funding-mail/page', { token: 'test-device-only', method: 'POST', body: { untrustedGraphUrl: 'https://example.com/private' } });
  assert.equal(response.status, 200); assert.equal((await response.json()).source, 'microsoft-graph');
  response = await request('/device-agent/macmini-nadine/background/funding-mail/move', { token: 'test-device-only', method: 'POST', body: {} });
  assert.equal(response.status, 409); assert.ok(!(await response.text()).includes('secret'));
  response = await request('/device-agent/macmini-nadine/background/funding-mail/attachment', { token: 'test-device-only', method: 'POST', body: {} });
  assert.equal(response.headers.get('x-iva-verified'), 'true'); assert.equal(response.headers.get('x-iva-source-hash'), 'a'.repeat(64));
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /^application\/octet-stream/); assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.match(response.headers.get('content-disposition'), /^attachment;/); assert.equal(await response.text(), '<html>untrusted</html>');
  console.log('Microsoft funding routes verified: exact callback, cockpit/device separation, redacted errors, binary attachment fidelity, no public mail access.');
} finally {
  await new Promise(resolve => server.close(resolve));
  if (oldToken === undefined) delete process.env.API_TOKEN; else process.env.API_TOKEN = oldToken;
}
