const FETCH_TIMEOUT = 12_000;

function configured(...keys) { return keys.every(key => Boolean(String(process.env[key] || '').trim())); }

export function marketingConnectorStatus() {
  const connectors = [
    { id: 'google-places', label: 'Google Unternehmenssuche', configured: configured('GOOGLE_PLACES_API_KEY'), capabilities: ['Branche + Region suchen', 'öffentliche Geschäftsadresse', 'Website und Geschäftsnummer'], requires: ['GOOGLE_PLACES_API_KEY'] },
    { id: 'apify', label: 'Apify Social Research', configured: configured('APIFY_TOKEN'), capabilities: ['Instagram-Referenzen scannen', 'weitere Plattform-Actoren vorbereiten'], requires: ['APIFY_TOKEN'] },
    { id: 'meta', label: 'Meta Ads & Publishing', configured: configured('META_ACCESS_TOKEN', 'META_AD_ACCOUNT_ID', 'META_GRAPH_VERSION'), capabilities: ['eigene Ads-Kennzahlen live synchronisieren', 'Optimierungen mit Freigabe vorbereiten', 'Publishing-Connector vorbereitet'], requires: ['META_ACCESS_TOKEN', 'META_AD_ACCOUNT_ID', 'META_GRAPH_VERSION', 'META_PAGE_ID', 'INSTAGRAM_BUSINESS_ACCOUNT_ID'] },
    { id: 'linkedin', label: 'LinkedIn Organisation', configured: configured('LINKEDIN_ACCESS_TOKEN', 'LINKEDIN_ORGANIZATION_ID'), capabilities: ['eigene Organisationsposts', 'eigene Social-Kennzahlen'], requires: ['LINKEDIN_ACCESS_TOKEN', 'LINKEDIN_ORGANIZATION_ID'] },
    { id: 'heygen', label: 'HeyGen UGC-Video', configured: configured('HEYGEN_API_KEY'), capabilities: ['Avatar-/UGC-Video aus freigegebenem Skript'], requires: ['HEYGEN_API_KEY', 'HEYGEN_AVATAR_ID', 'HEYGEN_VOICE_ID'] },
    { id: 'email', label: 'E-Mail-Versand', configured: configured('BREVO_API_KEY') || configured('RESEND_API_KEY'), capabilities: ['freigegebene Kampagnen versenden', 'Bounces/Abmeldungen'], requires: ['BREVO_API_KEY oder RESEND_API_KEY', 'verifizierte Absenderdomain'] },
    { id: 'whatsapp', label: 'WhatsApp Business', configured: configured('WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'), capabilities: ['Lead-Follow-up', 'Terminvereinbarung', 'Kundenservice'], requires: ['WHATSAPP_* Variablen'] },
  ];
  return { connectors, ready: connectors.filter(item => item.configured).length, total: connectors.length };
}

function clean(value, max = 500) { return String(value || '').trim().slice(0, max); }

export async function discoverGoogleBusinesses({ industry, region, pageSize = 20 } = {}) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return { ok: false, error: 'GOOGLE_PLACES_API_KEY fehlt', companies: [] };
  const textQuery = [clean(industry, 160), clean(region, 160)].filter(Boolean).join(' in ');
  if (!textQuery) return { ok: false, error: 'Branche oder Suchbegriff fehlt', companies: [] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST', signal: controller.signal,
      headers: {
        'Content-Type': 'application/json', 'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.businessStatus,places.googleMapsUri,places.websiteUri,places.nationalPhoneNumber,places.rating,places.userRatingCount,places.primaryTypeDisplayName',
      },
      body: JSON.stringify({ textQuery, pageSize: Math.max(1, Math.min(20, Number(pageSize) || 20)), languageCode: 'de', regionCode: 'DE' }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: `Google Places ${response.status}: ${payload?.error?.message || 'Fehler'}`, companies: [] };
    return {
      ok: true, query: textQuery,
      companies: (payload.places || []).map(place => ({
        externalId: place.id, name: place.displayName?.text || '', address: place.formattedAddress || '',
        phone: place.nationalPhoneNumber || '', website: place.websiteUri || '', mapsUrl: place.googleMapsUri || '',
        rating: Number(place.rating || 0), reviewCount: Number(place.userRatingCount || 0), businessStatus: place.businessStatus || '',
        category: place.primaryTypeDisplayName?.text || '', source: 'google-places', sourceUrl: place.googleMapsUri || '',
      })),
    };
  } catch (error) {
    return { ok: false, error: error.name === 'AbortError' ? 'Google Places Timeout' : error.message, companies: [] };
  } finally { clearTimeout(timer); }
}

function isPublicHttpUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '[::1]' || host === '::1' || host.endsWith('.local')) return false;
    if (/^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(host)) return false;
    const private172 = host.match(/^172\.(\d{1,3})\./);
    if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return false;
    if (/^(?:fc|fd)[0-9a-f]{2}:|^fe[89ab][0-9a-f]:/i.test(host.replace(/^\[|\]$/g, ''))) return false;
    return true;
  } catch { return false; }
}

async function fetchPage(value) {
  if (!isPublicHttpUrl(value)) return null;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    let url = value;
    for (let redirects = 0; redirects <= 4; redirects += 1) {
      if (!isPublicHttpUrl(url)) return null;
      const response = await fetch(url, { signal: controller.signal, redirect: 'manual', headers: { 'User-Agent': 'IVA-Marketing-Research/1.0 (+public business research)' } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return null;
        url = new URL(location, url).toString();
        continue;
      }
      const type = response.headers.get('content-type') || '';
      if (!response.ok || !type.includes('text/html')) return null;
      const html = (await response.text()).slice(0, 1_000_000);
      return { url: response.url || url, html };
    }
    return null;
  } catch { return null; } finally { clearTimeout(timer); }
}

function decodeHtml(value) { return String(value || '').replace(/&amp;/gi, '&').replace(/&#64;|&commat;/gi, '@').replace(/&nbsp;/gi, ' '); }
function visibleText(html) { return decodeHtml(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function unique(values) { return [...new Set(values.map(value => clean(value, 500)).filter(Boolean))]; }

function extractPage(page) {
  const html = page.html; const text = visibleText(html);
  const emails = unique([...(html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])].filter(value => !/example\.|sentry\.|wixpress\.|domain\./i.test(value)));
  const phones = unique([...(text.match(/(?:\+49|0)[\d\s()\/-]{7,20}/g) || [])].map(value => value.replace(/\s+/g, ' ').trim()));
  const executives = [];
  for (const match of text.matchAll(/(?:Geschäftsführer(?:in)?|Vertretungsberechtigt|Inhaber(?:in)?)[\s:,-]+([A-ZÄÖÜ][\p{L}'’-]+(?:\s+[A-ZÄÖÜ][\p{L}'’-]+){1,3})/giu)) executives.push(match[1]);
  const socials = {};
  for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const href = decodeHtml(match[1]);
    if (/instagram\.com\//i.test(href)) socials.instagram ||= href;
    if (/linkedin\.com\/(company|in)\//i.test(href)) socials.linkedin ||= href;
    if (/facebook\.com\//i.test(href)) socials.facebook ||= href;
  }
  return { url: page.url, emails, phones, executives: unique(executives), socials, excerpt: text.slice(0, 1600) };
}

export async function crawlPublicBusinessContacts(website) {
  const root = await fetchPage(website);
  if (!root) return { ok: false, website, error: 'Website nicht öffentlich abrufbar', contacts: [] };
  const pages = [root];
  const base = new URL(root.url);
  const candidates = [];
  for (const match of root.html.matchAll(/href=["']([^"']+)["']/gi)) {
    try {
      const url = new URL(decodeHtml(match[1]), base);
      if (url.hostname === base.hostname && /(impressum|kontakt|contact|about|ueber-uns|über-uns)/i.test(url.pathname)) candidates.push(url.toString());
    } catch { /* unbrauchbarer Link */ }
  }
  for (const url of unique(candidates).slice(0, 2)) { const page = await fetchPage(url); if (page) pages.push(page); }
  const extracted = pages.map(extractPage);
  return {
    ok: true, website: root.url,
    emails: unique(extracted.flatMap(page => page.emails)), phones: unique(extracted.flatMap(page => page.phones)),
    executives: unique(extracted.flatMap(page => page.executives)), socials: Object.assign({}, ...extracted.map(page => page.socials)),
    sources: extracted.map(page => page.url), excerpts: extracted.map(page => ({ url: page.url, text: page.excerpt })),
    compliance: { contactType: 'public-business-contact', outreachApproved: false, note: 'Nur öffentlich genannte Geschäftskontakte. Versand bleibt bis Rechtsgrundlage/Opt-in geprüft gesperrt.' },
  };
}

export function metaAdLibrarySearchUrl(query, country = 'DE') {
  const params = new URLSearchParams({ active_status: 'active', ad_type: 'all', country: clean(country, 2).toUpperCase() || 'DE', q: clean(query, 180), search_type: 'keyword_unordered' });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

function actionValue(actions, names) {
  return (actions || []).filter(item => names.includes(item.action_type)).reduce((sum, item) => sum + Number(item.value || 0), 0);
}

export async function fetchMetaAdsInsights({ datePreset = 'yesterday', level = 'adset', limit = 100 } = {}) {
  const token = process.env.META_ACCESS_TOKEN; const rawAccount = clean(process.env.META_AD_ACCOUNT_ID, 120);
  if (!token || !rawAccount) return { ok: false, error: 'META_ACCESS_TOKEN oder META_AD_ACCOUNT_ID fehlt', snapshots: [] };
  const account = rawAccount.startsWith('act_') ? rawAccount : `act_${rawAccount}`;
  const version = clean(process.env.META_GRAPH_VERSION || process.env.WHATSAPP_GRAPH_VERSION, 20);
  if (!/^v\d+\.\d+$/.test(version)) return { ok: false, error: 'META_GRAPH_VERSION fehlt (z. B. v23.0)', snapshots: [] };
  const params = new URLSearchParams({
    access_token: token, date_preset: clean(datePreset, 40) || 'yesterday', level: ['campaign', 'adset', 'ad'].includes(level) ? level : 'adset',
    limit: String(Math.max(1, Math.min(500, Number(limit) || 100))),
    fields: 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,frequency,actions,action_values,date_start,date_stop',
  });
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(`https://graph.facebook.com/${version}/${account}/insights?${params.toString()}`, { signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: `Meta ${response.status}: ${payload?.error?.message || 'Insights-Fehler'}`, snapshots: [] };
    return {
      ok: true, source: 'meta-insights', period: datePreset,
      snapshots: (payload.data || []).map(row => ({
        externalId: row.ad_id || row.adset_id || row.campaign_id || '', campaignExternalId: row.campaign_id || '', campaignName: row.campaign_name || '',
        adSet: row.ad_name || row.adset_name || row.campaign_name || '', period: `${row.date_start || ''} – ${row.date_stop || ''}`,
        metrics: {
          spend: Number(row.spend || 0), impressions: Number(row.impressions || 0), clicks: Number(row.clicks || 0), frequency: Number(row.frequency || 0),
          leads: actionValue(row.actions, ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead']),
          purchases: actionValue(row.actions, ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase']),
          revenue: actionValue(row.action_values, ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase']),
        },
      })),
      paging: { hasNext: Boolean(payload.paging?.next) },
    };
  } catch (error) {
    return { ok: false, error: error.name === 'AbortError' ? 'Meta Insights Timeout' : error.message, snapshots: [] };
  } finally { clearTimeout(timer); }
}
