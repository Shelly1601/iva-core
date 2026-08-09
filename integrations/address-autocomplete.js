const DEFAULT_ENDPOINT = 'https://photon.komoot.io/api/';
const CACHE_TTL_MS = 15 * 60_000;
const MAX_CACHE_ENTRIES = 250;
const cache = new Map();

function cleanText(value, max = 300) {
  return value === undefined || value === null ? '' : String(value).trim().slice(0, max);
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value) {
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

export function normalizePhotonFeature(feature = {}) {
  const properties = feature?.properties || {};
  const countryCode = cleanText(properties.countrycode, 8).toUpperCase();
  if (countryCode && countryCode !== 'DE') return null;
  const street = cleanText(properties.street || (properties.osm_key === 'highway' ? properties.name : ''), 180);
  const houseNumber = cleanText(properties.housenumber, 40);
  const postcode = cleanText(properties.postcode, 20);
  const city = cleanText(properties.city || properties.town || properties.village || properties.municipality || properties.locality, 140);
  if (!street || !city) return null;
  const streetLine = [street, houseNumber].filter(Boolean).join(' ');
  const cityLine = [postcode, city].filter(Boolean).join(' ');
  return {
    id: [streetLine, postcode, city].join('|').toLocaleLowerCase('de'),
    label: [streetLine, cityLine].filter(Boolean).join(', '),
    street,
    houseNumber,
    streetLine,
    postcode,
    city,
    district: cleanText(properties.district || properties.locality, 140),
    state: cleanText(properties.state, 140),
    country: cleanText(properties.country, 80) || 'Deutschland',
  };
}

export function normalizePhotonResponse(payload = {}, limit = 6) {
  const suggestions = [];
  const seen = new Set();
  for (const feature of Array.isArray(payload?.features) ? payload.features : []) {
    const suggestion = normalizePhotonFeature(feature);
    if (!suggestion || seen.has(suggestion.id)) continue;
    seen.add(suggestion.id);
    suggestions.push(suggestion);
    if (suggestions.length >= limit) break;
  }
  return suggestions;
}

export function addressAutocompleteStatus() {
  return {
    enabled: process.env.ADDRESS_AUTOCOMPLETE_ENABLED !== 'false',
    provider: 'photon',
    dataSource: 'OpenStreetMap',
    endpointConfigured: Boolean(process.env.ADDRESS_AUTOCOMPLETE_URL),
  };
}

export async function suggestGermanAddresses(query, { limit = 6, fetchImpl = fetch } = {}) {
  const status = addressAutocompleteStatus();
  if (!status.enabled) return { ...status, query: '', suggestions: [] };
  const safeQuery = cleanText(query, 180).replace(/\s+/g, ' ');
  if (safeQuery.length < 4) return { ...status, query: safeQuery, suggestions: [] };
  const safeLimit = Math.min(Math.max(Number(limit) || 6, 1), 8);
  const cacheKey = `${safeQuery.toLocaleLowerCase('de')}:${safeLimit}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };

  const endpoint = new URL(process.env.ADDRESS_AUTOCOMPLETE_URL || DEFAULT_ENDPOINT);
  endpoint.searchParams.set('q', /deutschland/i.test(safeQuery) ? safeQuery : `${safeQuery}, Deutschland`);
  endpoint.searchParams.set('lang', 'de');
  endpoint.searchParams.set('limit', String(Math.min(safeLimit * 3, 24)));
  const response = await fetchImpl(endpoint, {
    headers: { Accept: 'application/json', 'User-Agent': 'IVA-Adresssuche/1.0' },
    signal: AbortSignal.timeout(6_000),
  });
  if (!response.ok) throw new Error(`Adressdienst antwortet mit HTTP ${response.status}.`);
  const payload = await response.json();
  return cacheSet(cacheKey, {
    ...status,
    query: safeQuery,
    suggestions: normalizePhotonResponse(payload, safeLimit),
    attribution: '© OpenStreetMap-Mitwirkende',
  });
}

