const DEFAULT_BASE_URL = 'https://whatapphub.lovable.app/api/public/v1';

function configured(value) {
  return Boolean(String(value || '').trim());
}

function baseUrl() {
  return String(process.env.WHATSAPP_HUB_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

function safeLimit(value, fallback = 100) {
  return Math.min(Math.max(Number(value) || fallback, 1), 250);
}

export function whatsappHubStatus() {
  const checks = {
    baseUrl: configured(baseUrl()),
    apiKey: configured(process.env.WHATSAPP_HUB_API_KEY),
  };
  return {
    configured: checks.baseUrl && checks.apiKey,
    readReady: checks.baseUrl && checks.apiKey,
    outboundAvailable: checks.baseUrl && checks.apiKey,
    outboundEnabled: false,
    inboundWebhookReady: false,
    provider: 'evolution-bridge',
    baseUrl: baseUrl(),
    checks,
    capabilities: {
      accounts: 'read',
      chats: 'read-summary',
      templates: 'read',
      messages: 'available-but-not-exposed-by-iva',
    },
    gaps: [
      'Der Hub braucht einen geschuetzten Nachrichtenverlauf-Endpunkt pro Chat.',
      'Der Hub braucht einen signierten Webhook fuer neue Nachrichten.',
      'Versand bleibt in IVA gesperrt, bis Vorschau und Bestaetigungsablauf eingebaut sind.',
    ],
  };
}

async function requestHub(pathname, { method = 'GET', query = {}, body, fetchImpl = fetch } = {}) {
  const status = whatsappHubStatus();
  if (!status.configured) throw new Error('WhatsApp Hub ist noch nicht mit WHATSAPP_HUB_API_KEY konfiguriert.');

  const url = new URL(status.baseUrl + '/' + String(pathname || '').replace(/^\/+/, ''));
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && String(value).trim() !== '') url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        'X-API-Key': String(process.env.WHATSAPP_HUB_API_KEY),
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload?.error || payload?.message || `HTTP ${response.status}`;
      throw new Error(`WhatsApp Hub: ${detail}`);
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('WhatsApp Hub antwortet nicht innerhalb von 15 Sekunden.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function getWhatsAppHubMe(options = {}) {
  return requestHub('me', options);
}

export function listWhatsAppHubAccounts(options = {}) {
  return requestHub('accounts', options);
}

export function listWhatsAppHubChats({ accountId = '', search = '', limit = 100, ...options } = {}) {
  return requestHub('chats', {
    ...options,
    query: { account_id: String(accountId || ''), search: String(search || ''), limit: safeLimit(limit) },
  });
}

export function listWhatsAppHubTemplates(options = {}) {
  return requestHub('templates', options);
}

