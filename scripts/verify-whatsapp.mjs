import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { classifyWhatsAppIntent } from '../integrations/whatsapp-agent.js';
import { extractWhatsAppMessages, verifyWhatsAppSignature } from '../integrations/whatsapp.js';
import { listWhatsAppHubChats, whatsappHubStatus } from '../integrations/whatsapp-hub.js';

const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }));
const secret = 'test-app-secret';
const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
assert.equal(verifyWhatsAppSignature(body, signature, secret), true);
assert.equal(verifyWhatsAppSignature(body, signature.replace(/.$/, '0'), secret), false);

const messages = extractWhatsAppMessages({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'pn-1' }, messages: [{ id: 'wamid-1', from: '49170', type: 'text', text: { body: 'Hallo' } }] } }] }] });
assert.deepEqual(messages, [{ id: 'wamid-1', sender: '49170', phoneNumberId: 'pn-1', timestamp: '', type: 'text', text: 'Hallo' }]);

assert.equal(classifyWhatsAppIntent('Ist mein Fahrraddiebstahl versichert?').coverage, true);
assert.equal(classifyWhatsAppIntent('Ich habe einen Wasserschaden').claim, true);
assert.equal(classifyWhatsAppIntent('Ich möchte einen Termin').appointment, true);

const previousHubKey = process.env.WHATSAPP_HUB_API_KEY;
const previousHubUrl = process.env.WHATSAPP_HUB_BASE_URL;
process.env.WHATSAPP_HUB_API_KEY = 'test-hub-key';
process.env.WHATSAPP_HUB_BASE_URL = 'https://hub.example.test/api/public/v1';
let hubRequest;
const hubChats = await listWhatsAppHubChats({
  accountId: 'account-1',
  search: 'Nadine',
  limit: 999,
  fetchImpl: async (url, options) => {
    hubRequest = { url: String(url), options };
    return { ok: true, json: async () => ({ chats: [{ id: 'chat-1' }] }) };
  },
});
assert.deepEqual(hubChats, { chats: [{ id: 'chat-1' }] });
assert.match(hubRequest.url, /account_id=account-1/);
assert.match(hubRequest.url, /search=Nadine/);
assert.match(hubRequest.url, /limit=250/);
assert.equal(hubRequest.options.headers['X-API-Key'], 'test-hub-key');
assert.equal(whatsappHubStatus().outboundEnabled, false);
if (previousHubKey === undefined) delete process.env.WHATSAPP_HUB_API_KEY; else process.env.WHATSAPP_HUB_API_KEY = previousHubKey;
if (previousHubUrl === undefined) delete process.env.WHATSAPP_HUB_BASE_URL; else process.env.WHATSAPP_HUB_BASE_URL = previousHubUrl;

console.log('PASS WhatsApp: Meta-HMAC, Sicherheits-Intents und Hub-Leseconnector');
