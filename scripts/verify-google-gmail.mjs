import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-google-gmail-'));
process.env.GOOGLE_GMAIL_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.GOOGLE_GMAIL_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_GMAIL_REDIRECT_URI = 'https://iva.example.test/oauth/google/callback';
process.env.GMAIL_ALLOWED_ACCOUNT = 'nadine.iva.inbox@gmail.com';
process.env.GOOGLE_GMAIL_TOKEN_KEY = 'test-token-encryption-key-with-enough-entropy';

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.href === 'https://oauth2.googleapis.com/token') {
    const body = new URLSearchParams(String(options.body || ''));
    if (body.get('grant_type') === 'authorization_code') {
      return json({ access_token: 'access-token-plain', refresh_token: 'refresh-token-plain', expires_in: 3600, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/gmail.modify' });
    }
    return json({ access_token: 'refreshed-access-token-plain', expires_in: 3600, token_type: 'Bearer' });
  }
  if (url.pathname.endsWith('/users/me/profile')) {
    return json({ emailAddress: 'nadine.iva.inbox@gmail.com', messagesTotal: 100, threadsTotal: 80 });
  }
  if (url.pathname.endsWith('/users/me/labels')) {
    return json({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_1', name: 'Heat Hero', type: 'user' }] });
  }
  if (url.pathname.endsWith('/users/me/messages')) {
    const query = url.searchParams.get('q') || '';
    if (query.includes('foerderung@heat-hero.com')) return json({ resultSizeEstimate: 3, messages: [{ id: 'funding-1' }] });
    if (query.includes('n.sell@heat-hero.com')) return json({ resultSizeEstimate: 9, messages: [{ id: 'heat-1' }] });
    return json({ resultSizeEstimate: 1, messages: [{ id: 'message-1', threadId: 'thread-1' }] });
  }
  if (url.pathname.includes('/users/me/messages/')) {
    return json({
      id: url.pathname.split('/').pop(),
      threadId: 'thread-1',
      labelIds: ['INBOX'],
      snippet: 'Testnachricht',
      payload: { headers: [
        { name: 'From', value: 'Förderung <foerderung@heat-hero.com>' },
        { name: 'To', value: 'nadine.iva.inbox@gmail.com' },
        { name: 'Subject', value: 'Förderungs-Test' },
        { name: 'Date', value: 'Fri, 21 Aug 2026 18:00:00 +0200' },
      ] },
    });
  }
  return new Response(JSON.stringify({ error: { message: `Unerwarteter Testaufruf: ${url.href}` } }), { status: 500 });
};

const {
  completeGoogleGmailOAuth,
  createGoogleGmailAuthUrl,
  googleGmailScope,
  googleGmailStatus,
  listGoogleGmailLabels,
  listGoogleGmailMessages,
} = await import('../integrations/google-gmail.js');

try {
  const authUrl = new URL(await createGoogleGmailAuthUrl());
  assert.equal(authUrl.origin, 'https://accounts.google.com');
  assert.equal(authUrl.searchParams.get('scope'), googleGmailScope());
  assert.equal(authUrl.searchParams.get('access_type'), 'offline');
  assert.equal(authUrl.searchParams.get('login_hint'), 'nadine.iva.inbox@gmail.com');
  assert.ok(authUrl.searchParams.get('state'));

  const connected = await completeGoogleGmailOAuth({ code: 'one-time-code', state: authUrl.searchParams.get('state') });
  assert.equal(connected.connected, true);
  assert.equal(connected.probe.heatHeroMessages30d, 9);
  assert.equal(connected.probe.fundingMessages30d, 3);
  assert.equal(connected.probe.labels, 2);

  const encrypted = await fs.readFile(path.join(process.env.DATA_DIR, 'google-gmail-oauth.enc.json'), 'utf8');
  assert.equal(encrypted.includes('refresh-token-plain'), false);
  assert.equal(encrypted.includes('access-token-plain'), false);

  const status = await googleGmailStatus();
  assert.equal(status.ready, true);
  assert.equal(status.authorized, true);
  assert.equal(status.lastProbe.fundingMessages30d, 3);

  const labels = await listGoogleGmailLabels();
  assert.equal(labels[1].name, 'Heat Hero');

  const messages = await listGoogleGmailMessages({ limit: 5, query: 'in:inbox' });
  assert.equal(messages.messages.length, 1);
  assert.equal(messages.messages[0].subject, 'Förderungs-Test');
  assert.equal(messages.messages[0].labelIds[0], 'INBOX');

  console.log('Google-Gmail-OAuth erfolgreich verifiziert.');
} finally {
  globalThis.fetch = realFetch;
}
