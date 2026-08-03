import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { classifyWhatsAppIntent } from '../integrations/whatsapp-agent.js';
import { extractWhatsAppMessages, verifyWhatsAppSignature } from '../integrations/whatsapp.js';

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

console.log('PASS WhatsApp: Webhook-Signatur, Nachrichtenerkennung und Sicherheits-Intents');
