import crypto from 'crypto';

function configured(value) { return Boolean(String(value || '').trim()); }

export function whatsappStatus(env = process.env) {
  const checks = {
    accessToken: configured(env.WHATSAPP_ACCESS_TOKEN),
    phoneNumberId: configured(env.WHATSAPP_PHONE_NUMBER_ID),
    verifyToken: configured(env.WHATSAPP_VERIFY_TOKEN),
    appSecret: configured(env.WHATSAPP_APP_SECRET),
    graphVersion: /^v\d+\.\d+$/.test(env.WHATSAPP_GRAPH_VERSION || ''),
  };
  return {
    configured: Object.values(checks).every(Boolean),
    verified: false,
    inboundReady: checks.verifyToken && checks.appSecret,
    outboundReady: checks.accessToken && checks.phoneNumberId && checks.graphVersion,
    checks,
    webhookPath: '/webhooks/whatsapp',
  };
}

export function verifyWhatsAppChallenge(query = {}) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  return mode === 'subscribe' && configured(process.env.WHATSAPP_VERIFY_TOKEN) && token === process.env.WHATSAPP_VERIFY_TOKEN
    ? String(challenge || '')
    : null;
}

export function verifyWhatsAppSignature(rawBody, signatureHeader, appSecret = process.env.WHATSAPP_APP_SECRET) {
  if (!Buffer.isBuffer(rawBody) || !configured(appSecret) || !String(signatureHeader || '').startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const supplied = String(signatureHeader);
  if (expected.length !== supplied.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export function extractWhatsAppMessages(payload = {}) {
  const out = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = String(value.metadata?.phone_number_id || '');
      for (const message of value.messages || []) {
        const text = message.text?.body
          || message.button?.text
          || message.interactive?.button_reply?.title
          || message.interactive?.list_reply?.title
          || (message.type ? `[${({ image: 'Bild', audio: 'Sprachnachricht', video: 'Video', document: 'Dokument', location: 'Standort', contacts: 'Kontaktdaten', sticker: 'Sticker' })[message.type] || 'Nichttext-Nachricht'} eingegangen; Inhalt noch nicht ausgewertet]${message[message.type]?.caption ? '\nBegleittext: ' + String(message[message.type].caption).slice(0, 2000) : ''}` : '');
        if (!text) continue;
        out.push({
          id: String(message.id || ''),
          sender: String(message.from || ''),
          phoneNumberId,
          timestamp: String(message.timestamp || ''),
          type: String(message.type || 'text'),
          ...(message[message.type]?.id ? { media: { id: String(message[message.type].id).slice(0, 200), mimeType: String(message[message.type].mime_type || '').slice(0, 120) } } : {}),
          text: String(text).trim(),
        });
      }
    }
  }
  return out;
}

export async function sendWhatsAppText({ to, text, phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID, lastInboundAt, replyToMessageId, env = process.env, fetchImpl = fetch } = {}) {
  const status = whatsappStatus(env);
  if (!status.checks.accessToken || !status.checks.graphVersion || !/^\d{5,30}$/.test(phoneNumberId)) throw new Error('WhatsApp-Ausgang ist noch nicht vollständig konfiguriert.');
  if (!Number.isFinite(Date.parse(lastInboundAt)) || Date.parse(lastInboundAt) > Date.now() + 60000 || Date.now() - Date.parse(lastInboundAt) >= 86400000) throw new Error('Außerhalb des bestätigten 24-Stunden-Fensters wird keine freie WhatsApp-Nachricht gesendet.');
  const safeText = String(text || '').trim().slice(0, 4096);
  if (!safeText || !/^\d{7,15}$/.test(to)) throw new Error('Empfänger oder Nachricht fehlt.');
  const url = `https://graph.facebook.com/${env.WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`;
  const response = await fetchImpl(url, {
    method: 'POST',
    redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: safeText }, ...(replyToMessageId ? { context: { message_id: replyToMessageId } } : {}) }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`WhatsApp API ${response.status}: Versand nicht bestätigt.`);
  if (!body.messages?.[0]?.id) throw new Error('WhatsApp-Versandbeleg fehlt.');
  return body;
}

export function extractWhatsAppStatuses(payload = {}) {
  const rows = [];
  for (const entry of payload.entry || []) for (const change of entry.changes || []) for (const row of change.value?.statuses || []) if (['sent', 'delivered', 'read', 'failed'].includes(row.status) && row.id) rows.push({ id: String(row.id), phoneNumberId: String(change.value.metadata?.phone_number_id || ''), recipient: String(row.recipient_id || ''), status: row.status, timestamp: String(row.timestamp || '') });
  return rows;
}

export async function verifyWhatsAppPhoneNumber(phoneNumberId, { env = process.env, fetchImpl = fetch } = {}) {
  if (!/^\d{5,30}$/.test(phoneNumberId) || !env.WHATSAPP_ACCESS_TOKEN || !/^v\d+\.\d+$/.test(env.WHATSAPP_GRAPH_VERSION || '')) throw new Error('Meta-Zugang oder Telefonnummer fehlen.');
  const response = await fetchImpl(`https://graph.facebook.com/${env.WHATSAPP_GRAPH_VERSION}/${phoneNumberId}?fields=id,display_phone_number,verified_name`, { headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Meta hat den Nummernzugriff nicht bestätigt.');
  const body = await response.json(); if (String(body.id) !== phoneNumberId) throw new Error('Meta-Nummernbeleg stimmt nicht überein.');
  return { verified: true, phoneNumberId, displayPhoneNumber: String(body.display_phone_number || ''), verifiedName: String(body.verified_name || ''), checkedAt: new Date().toISOString(), inboundVerified: false, sendVerified: false };
}
