import crypto from 'crypto';

function configured(value) { return Boolean(String(value || '').trim()); }

export function whatsappStatus() {
  const checks = {
    accessToken: configured(process.env.WHATSAPP_ACCESS_TOKEN),
    phoneNumberId: configured(process.env.WHATSAPP_PHONE_NUMBER_ID),
    verifyToken: configured(process.env.WHATSAPP_VERIFY_TOKEN),
    appSecret: configured(process.env.WHATSAPP_APP_SECRET),
    graphVersion: configured(process.env.WHATSAPP_GRAPH_VERSION),
  };
  return {
    configured: Object.values(checks).every(Boolean),
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
          || '';
        if (!text) continue;
        out.push({
          id: String(message.id || ''),
          sender: String(message.from || ''),
          phoneNumberId,
          timestamp: String(message.timestamp || ''),
          type: String(message.type || 'text'),
          text: String(text).trim(),
        });
      }
    }
  }
  return out;
}

export async function sendWhatsAppText({ to, text, phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID } = {}) {
  const status = whatsappStatus();
  if (!status.outboundReady) throw new Error('WhatsApp-Ausgang ist noch nicht vollständig konfiguriert.');
  const safeText = String(text || '').trim().slice(0, 4096);
  if (!safeText || !to) throw new Error('Empfänger oder Nachricht fehlt.');
  const url = `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: safeText } }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`WhatsApp API ${response.status}: ${body?.error?.message || 'Nachricht konnte nicht gesendet werden.'}`);
  return body;
}
