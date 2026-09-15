import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const clean = (value, max = 2000) => String(value ?? '').trim().slice(0, max);

function environmentConfig(environment) {
  if (environment === 'live') return {
    environment: 'live', authBaseUrl: 'https://live.logonvalidation.net', apiBaseUrl: 'https://gateway.saxobank.com/openapi',
  };
  return {
    environment: 'sim', authBaseUrl: 'https://sim.logonvalidation.net', apiBaseUrl: 'https://gateway.saxobank.com/sim/openapi',
  };
}

function encryptionKey(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest();
}

function encryptJson(value, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
}

function decryptJson(payload, secret) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(payload.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
}

function saxoError(status, response) {
  const retry = Number(response?.headers?.get('retry-after') || response?.headers?.get('x-ratelimit-session-reset'));
  const message = status === 401 ? 'Saxo-Sitzung abgelaufen. Bitte erneut verbinden.' : status === 403 ? 'Saxo-Zugriff nicht freigegeben. App- und Marktdatenrechte bei Saxo prüfen.' : status === 429 ? 'Saxo begrenzt die Abfragen. IVA wartet vor dem nächsten Versuch.' : `Saxo konnte die Anfrage nicht abschließen (HTTP ${status}).`;
  return Object.assign(new Error(message), { status: status === 429 ? 429 : 503, providerStatus: status, retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? Math.min(retry, 3600) : 60 });
}

export function createSaxoClient({ dataDir = process.env.DATA_DIR || '/data', env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const environment = clean(env.SAXO_ENVIRONMENT || 'sim', 10).toLowerCase() === 'live' ? 'live' : 'sim';
  const endpoints = environmentConfig(environment);
  const appKey = clean(env.SAXO_APP_KEY, 300);
  const appSecret = clean(env.SAXO_APP_SECRET, 1000);
  const redirectUri = clean(env.SAXO_REDIRECT_URI, 1000);
  const tokenKey = clean(env.SAXO_TOKEN_KEY, 1000);
  const saxoAppTradingPermission = clean(env.SAXO_TRADING_ENABLED, 10).toLowerCase() === 'true';
  const tokenFile = path.join(dataDir, `saxo-${environment}-oauth.enc.json`);
  let refreshQueue = Promise.resolve();
  let tokenWriteQueue = Promise.resolve();
  let sessionGeneration = 0;
  const pendingStates = new Map();
  let lastProbe = null;

  const missing = () => [
    !appKey && 'SAXO_APP_KEY',
    !appSecret && 'SAXO_APP_SECRET',
    !redirectUri && 'SAXO_REDIRECT_URI',
    tokenKey.length < 32 && 'SAXO_TOKEN_KEY (mindestens 32 Zeichen)',
  ].filter(Boolean);

  async function readToken() {
    if (tokenKey.length < 32) return null;
    try { return decryptJson(JSON.parse(await fs.readFile(tokenFile, 'utf8')), tokenKey); }
    catch { return null; }
  }

  async function writeToken(token, generation) {
    const pending = tokenWriteQueue.catch(() => {}).then(async () => {
      if (generation !== sessionGeneration) throw new Error('Saxo-Verbindung wurde zwischenzeitlich getrennt.');
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
      const temporary = `${tokenFile}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(encryptJson(token, tokenKey)), { mode: 0o600, flag: 'wx' });
        if (generation !== sessionGeneration) throw new Error('Saxo-Verbindung wurde zwischenzeitlich getrennt.');
        await fs.rename(temporary, tokenFile);
      } finally { await fs.rm(temporary, { force: true }); }
    });
    tokenWriteQueue = pending.catch(() => {});
    await pending;
  }

  function signedState() {
    if (missing().length) throw new Error(`Saxo ist noch nicht konfiguriert: ${missing().join(', ')}`);
    const payload = Buffer.from(JSON.stringify({ nonce: crypto.randomBytes(18).toString('base64url'), issuedAt: Date.now(), environment })).toString('base64url');
    const signature = crypto.createHmac('sha256', tokenKey).update(payload).digest('base64url');
    for (const [key, timestamp] of pendingStates) if (Date.now() - timestamp > 10 * 60_000) pendingStates.delete(key);
    if (pendingStates.size >= 20) pendingStates.delete(pendingStates.keys().next().value);
    pendingStates.set(payload, Date.now());
    return `${payload}.${signature}`;
  }

  function verifyState(state) {
    const [payload, supplied] = String(state || '').split('.');
    if (!payload || !supplied) throw new Error('Saxo-OAuth-State fehlt.');
    const expected = crypto.createHmac('sha256', tokenKey).update(payload).digest();
    const actual = Buffer.from(supplied, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error('Saxo-OAuth-State ist ungueltig.');
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (parsed.environment !== environment || !pendingStates.has(payload) || Date.now() - Number(parsed.issuedAt) > 10 * 60_000 || Number(parsed.issuedAt) > Date.now() + 10_000) throw new Error('Saxo-OAuth-State ist abgelaufen oder wurde bereits verwendet. Bitte Verbindung neu starten.');
    pendingStates.delete(payload);
    return parsed;
  }

  function createAuthUrl() {
    const url = new URL(`${endpoints.authBaseUrl}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', appKey);
    url.searchParams.set('state', signedState());
    url.searchParams.set('redirect_uri', redirectUri);
    return url.toString();
  }

  async function tokenRequest(body) {
    const response = await fetchImpl(`${endpoints.authBaseUrl}/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${appKey}:${appSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    const text = await response.text();
    if (!response.ok) throw saxoError(response.status, response);
    let token;
    try { token = JSON.parse(text); } catch { throw new Error('Saxo hat keine lesbare Sitzung geliefert. Bitte neu verbinden.'); }
    if (typeof token.access_token !== 'string' || !token.access_token || typeof token.refresh_token !== 'string' || !token.refresh_token || !Number.isFinite(Number(token.expires_in)) || !(Number(token.expires_in) > 0)) throw new Error('Saxo hat keine vollständige Sitzung geliefert. Bitte neu verbinden.');
    const refreshSeconds = Number(token.refresh_token_expires_in);
    const now = Date.now();
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenType: token.token_type || 'Bearer',
      expiresAt: now + Number(token.expires_in) * 1000,
      refreshExpiresAt: Number.isFinite(refreshSeconds) && refreshSeconds > 0 ? now + refreshSeconds * 1000 : now,
      environment,
      updatedAt: new Date(now).toISOString(),
    };
  }

  async function completeOAuth({ code, state }) {
    verifyState(state);
    const generation = sessionGeneration;
    if (!clean(code, 2000)) throw new Error('Saxo-Autorisierungscode fehlt.');
    const token = await tokenRequest({ grant_type: 'authorization_code', code: clean(code, 2000), redirect_uri: redirectUri });
    await writeToken(token, generation);
    return { connected: true, environment, expiresAt: token.expiresAt, refreshExpiresAt: token.refreshExpiresAt };
  }

  async function validToken() {
    const current = await readToken();
    if (!current) throw new Error('Saxo ist noch nicht verbunden.');
    if (Number(current.expiresAt) > Date.now() + 60_000) return current;
    let refreshed;
    const job = refreshQueue.catch(() => {}).then(async () => {
      const latest = await readToken();
      if (latest && Number(latest.expiresAt) > Date.now() + 60_000) { refreshed = latest; return; }
      if (!latest?.refreshToken || Number(latest.refreshExpiresAt) <= Date.now()) throw new Error('Die Saxo-Sitzung ist abgelaufen. Bitte neu verbinden.');
      const generation = sessionGeneration;
      refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: latest.refreshToken, redirect_uri: redirectUri });
      await writeToken(refreshed, generation);
    });
    refreshQueue = job.catch(() => {});
    await job;
    return refreshed;
  }

  async function request(apiPath, { method = 'GET', body } = {}) {
    // This client has no order execution, transfer or session-upgrade path.
    // Keep the existing, manually invoked order precheck as the only API write.
    const target = String(apiPath).replace(/^\/+/, '');
    if (/^[a-z]+:/i.test(target) || /[\\\x00-\x20]/.test(target) || target.split('?')[0].split('/').includes('..') || (method !== 'GET' && !(method === 'POST' && target === 'trade/v2/orders/precheck'))) throw new Error('Diese Saxo-Aktion ist in IVA gesperrt. Keine Orders, Einzahlungen oder Änderungen der Session-Rechte.');
    const token = await validToken();
    const response = await fetchImpl(`${endpoints.apiBaseUrl}/${target}`, {
      method,
      headers: { Authorization: `${token.tokenType} ${token.accessToken}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    const text = await response.text();
    if (!response.ok) throw saxoError(response.status, response);
    if (!text) return {};
    try { return JSON.parse(text); } catch { throw new Error('Saxo hat keine lesbare API-Antwort geliefert.'); }
  }

  async function status({ probe = false } = {}) {
    const problems = missing();
    const token = await readToken();
    const usable = Boolean(token && (Number(token.expiresAt) > Date.now() || token.refreshToken && Number(token.refreshExpiresAt) > Date.now()));
    const result = {
      provider: 'Saxo OpenAPI', environment, configured: problems.length === 0,
      authorized: usable, ready: problems.length === 0 && usable, needsReauthorization: Boolean(token) && !usable, missing: problems,
      expiresAt: token?.expiresAt || null, refreshExpiresAt: token?.refreshExpiresAt || null,
      saxoAppTradingPermission,
      tradingEnabled: false,
      orderExecutionEnabled: false,
      mode: 'read-analyze-precheck',
      transport: 'REST', streamingConnected: false, lastProbe,
      marketDataNotice: 'API-Marktdaten müssen bei Saxo freigegeben sein. Daten können fehlen, verzögert oder indikativ sein; SIM ist keine echte Orderausführung.',
      documentation: { setup: 'https://www.developer.saxo/openapi/learn/oauth-authorization-code-grant', marketData: 'https://www.developer.saxo/excel/user-guide/enabling-market-data', streaming: 'https://www.developer.saxo/openapi/learn/streaming' },
      setup: environment === 'sim'
        ? 'SIM-App testen; danach LIVE-App bei Saxo beantragen.'
        : 'LIVE-Umgebung ausgewählt. Orderausfuehrung bleibt in IVA weiterhin gesperrt.',
    };
    if (probe && result.ready) {
      try {
        const user = await request('port/v1/users/me');
        result.reachable = user.Active === true;
        result.connectedName = clean(user.Name, 200);
        result.marketDataTermsAccepted = user.MarketDataViaOpenApiTermsAccepted === true;
        lastProbe = { checkedAt: new Date().toISOString(), reachable: result.reachable, marketDataTermsAccepted: result.marketDataTermsAccepted };
      } catch (error) {
        result.reachable = false; result.error = 'Saxo ist nicht erreichbar oder die Sitzung muss erneuert werden.';
        if (error.providerStatus === 401) { result.needsReauthorization = true; result.ready = false; result.authorized = false; }
        lastProbe = { checkedAt: new Date().toISOString(), reachable: false };
      }
      result.lastProbe = lastProbe;
    }
    return result;
  }

  async function disconnect() {
    sessionGeneration++; pendingStates.clear();
    await tokenWriteQueue;
    await fs.rm(tokenFile, { force: true });
    return { connected: false, environment };
  }

  async function portfolio() {
    const toDate = new Date();
    const fromDate = new Date(toDate);
    fromDate.setUTCFullYear(fromDate.getUTCFullYear() - 1);
    const [user, client, balance, netPositions, orders] = await Promise.all([
      request('port/v1/users/me'),
      request('port/v1/clients/me'),
      request('port/v1/balances/me'),
      request('port/v1/netpositions/me?$top=200&FieldGroups=DisplayAndFormat,NetPositionBase,NetPositionView'),
      request('port/v1/orders/me?$top=200&FieldGroups=DisplayAndFormat&Status=All'),
    ]);
    const accounts = await request(`port/v1/accounts?ClientKey=${encodeURIComponent(client.ClientKey)}&$top=100`);
    let performance = null;
    try {
      performance = await request(`hist/v4/performance/timeseries?ClientKey=${encodeURIComponent(client.ClientKey)}&FromDate=${fromDate.toISOString().slice(0, 10)}&ToDate=${toDate.toISOString().slice(0, 10)}&FieldGroups=Balance_AccountValue,TimeWeighted_Accumulated`);
    } catch (error) {
      performance = { unavailable: true, reason: clean(error.message, 300) };
    }
    return {
      fetchedAt: new Date().toISOString(), environment,
      user: { name: clean(user.Name, 200), active: user.Active === true, marketDataTermsAccepted: user.MarketDataViaOpenApiTermsAccepted === true, legalAssetTypes: user.LegalAssetTypes || [] },
      client: { name: clean(client.Name, 200), currency: client.DefaultCurrency, defaultAccountKey: client.DefaultAccountKey, defaultAccountId: client.DefaultAccountId, marginTradingAllowed: client.IsMarginTradingAllowed === true, reduceExposureOnly: client.ReduceExposureOnly === true },
      accounts: (accounts.Data || []).map(item => ({ accountKey: item.AccountKey, accountId: item.AccountId, currency: item.Currency, accountType: item.AccountType, active: item.Active === true, displayName: item.DisplayName || item.AccountId })),
      balance,
      netPositions: netPositions.Data || [],
      orders: orders.Data || [],
      performance,
    };
  }

  async function searchInstruments({ query, assetTypes = ['Stock', 'Etf', 'MutualFund', 'Bond'], accountKey = '' } = {}) {
    const keywords = clean(query, 120);
    if (keywords.length < 2) throw new Error('Bitte mindestens zwei Zeichen suchen.');
    const params = new URLSearchParams({ Keywords: keywords, AssetTypes: assetTypes.join(','), IncludeNonTradable: 'false', '$top': '20' });
    if (accountKey) params.set('AccountKey', clean(accountKey, 200));
    const result = await request(`ref/v1/instruments?${params}`);
    return (result.Data || []).map(item => ({
      uic: item.Identifier,
      assetType: item.AssetType,
      symbol: item.Symbol || '',
      description: item.Description || '',
      exchangeId: item.ExchangeId || '',
      currency: item.CurrencyCode || '',
      tradableAs: item.TradableAs || [],
    }));
  }

  async function instrumentDetails({ uic, assetType, accountKey = '' } = {}) {
    const identifier = Math.round(Number(uic));
    const type = clean(assetType, 80);
    if (!Number.isInteger(identifier) || identifier <= 0 || !type) throw new Error('Fuer Saxo-Instrumentdetails fehlen UIC oder Anlageklasse.');
    const params = new URLSearchParams();
    if (accountKey) params.set('AccountKey', clean(accountKey, 200));
    const suffix = params.size ? `?${params}` : '';
    return request(`ref/v1/instruments/details/${identifier}/${encodeURIComponent(type)}${suffix}`);
  }

  async function chart({ uic, assetType, accountKey = '', horizon = 1440, count = 420 } = {}) {
    const identifier = Math.round(Number(uic));
    const type = clean(assetType, 80);
    const allowedHorizons = new Set([1, 2, 3, 5, 10, 15, 30, 60, 120, 180, 240, 300, 360, 480, 1440, 10080, 43200, 129600, 518400]);
    const sampleHorizon = allowedHorizons.has(Number(horizon)) ? Number(horizon) : 1440;
    if (!Number.isInteger(identifier) || identifier <= 0 || !type) throw new Error('Fuer Saxo-Chartdaten fehlen UIC oder Anlageklasse.');
    const params = new URLSearchParams({
      AssetType: type,
      Uic: String(identifier),
      Horizon: String(sampleHorizon),
      Count: String(Math.max(20, Math.min(1200, Math.round(Number(count) || 420)))),
      FieldGroups: 'Data,ChartInfo,DisplayAndFormat',
      ExtendedHoursEnabled: 'false',
    });
    if (accountKey) params.set('AccountKey', clean(accountKey, 200));
    return request(`chart/v3/charts?${params}`);
  }

  async function quotes(instruments = []) {
    if (!Array.isArray(instruments) || instruments.length > 20) throw new Error('Das Kursmonitoring unterstützt bis zu 20 Watchlist-Werte.');
    const groups = new Map();
    for (const item of instruments) {
      if (!Number.isSafeInteger(item.uic) || item.uic <= 0 || !['Stock', 'Etf', 'MutualFund', 'Bond'].includes(item.assetType)) throw new Error('Für die Kursabfrage fehlt ein unterstütztes, eindeutig identifiziertes Instrument.');
      const list = groups.get(item.assetType) || []; list.push(item); groups.set(item.assetType, list);
    }
    const rows = [];
    for (const [assetType, items] of groups) {
      const params = new URLSearchParams({ AssetType: assetType, Uics: [...new Set(items.map(item => item.uic))].join(','), FieldGroups: 'Quote,DisplayAndFormat,PriceInfo,PriceInfoDetails,InstrumentPriceDetails' });
      const result = await request(`trade/v1/infoprices/list?${params}`);
      const receivedAt = new Date().toISOString();
      for (const item of items) {
        const raw = (result.Data || []).find(row => Number(row.Uic) === item.uic && row.AssetType === assetType);
        const quote = raw?.Quote || {};
        const number = value => value !== null && value !== '' && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
        const stamp = Date.parse(raw?.LastUpdated);
        rows.push({ key: `${assetType}:${item.uic}`, uic: item.uic, assetType, symbol: clean(raw?.DisplayAndFormat?.Symbol || item.symbol, 120), currency: clean(raw?.DisplayAndFormat?.Currency || item.currency, 3).toUpperCase(),
          bid: number(quote.Bid), ask: number(quote.Ask), mid: number(quote.Mid), last: number(raw?.PriceInfoDetails?.LastTraded),
          updatedAt: Number.isFinite(stamp) && stamp > Date.UTC(2000, 0, 1) ? new Date(stamp).toISOString() : null, receivedAt,
          delayedByMinutes: number(quote.DelayedByMinutes), priceTypeBid: clean(quote.PriceTypeBid, 50), priceTypeAsk: clean(quote.PriceTypeAsk, 50),
          marketOpen: typeof raw?.InstrumentPriceDetails?.IsMarketOpen === 'boolean' ? raw.InstrumentPriceDetails.IsMarketOpen : null,
          errorCode: clean(quote.ErrorCode || (raw ? '' : 'NoData'), 80), environment, source: 'Saxo OpenAPI InfoPrices',
        });
      }
    }
    return rows;
  }

  async function precheckOrder(draft) {
    if (!draft?.accountKey) throw new Error('Fuer den Saxo-Precheck muss ein Konto ausgewaehlt sein.');
    const body = {
      AccountKey: draft.accountKey,
      Amount: draft.amount,
      AssetType: draft.instrument.assetType,
      BuySell: draft.direction,
      Uic: draft.instrument.uic,
      OrderType: draft.orderType,
      OrderDuration: { DurationType: draft.durationType },
      ExternalReference: draft.externalReference,
      FieldGroups: ['Costs', 'MarginImpactBuySell'],
      ManualOrder: true,
    };
    if (draft.orderType === 'Limit') body.OrderPrice = draft.orderPrice;
    return request('trade/v2/orders/precheck', { method: 'POST', body });
  }

  return { status, createAuthUrl, completeOAuth, disconnect, portfolio, searchInstruments, instrumentDetails, chart, quotes, precheckOrder, request };
}

export { environmentConfig };
