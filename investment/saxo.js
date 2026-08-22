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

function safeErrorPayload(text) {
  try {
    const parsed = JSON.parse(text);
    return clean(parsed?.ErrorInfo?.Message || parsed?.Message || parsed?.error_description || parsed?.error || text, 500);
  } catch { return clean(text, 500); }
}

export function createSaxoClient({ dataDir = process.env.DATA_DIR || '/data', env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const environment = clean(env.SAXO_ENVIRONMENT || 'sim', 10).toLowerCase() === 'live' ? 'live' : 'sim';
  const endpoints = environmentConfig(environment);
  const appKey = clean(env.SAXO_APP_KEY, 300);
  const appSecret = clean(env.SAXO_APP_SECRET, 1000);
  const redirectUri = clean(env.SAXO_REDIRECT_URI, 1000);
  const tokenKey = clean(env.SAXO_TOKEN_KEY, 1000);
  const tokenFile = path.join(dataDir, `saxo-${environment}-oauth.enc.json`);
  let refreshQueue = Promise.resolve();

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

  async function writeToken(token) {
    await fs.mkdir(dataDir, { recursive: true });
    const temporary = `${tokenFile}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(encryptJson(token, tokenKey)), { mode: 0o600 });
    await fs.rename(temporary, tokenFile);
  }

  function signedState() {
    if (missing().length) throw new Error(`Saxo ist noch nicht konfiguriert: ${missing().join(', ')}`);
    const payload = Buffer.from(JSON.stringify({ nonce: crypto.randomBytes(18).toString('base64url'), issuedAt: Date.now(), environment })).toString('base64url');
    const signature = crypto.createHmac('sha256', tokenKey).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  function verifyState(state) {
    const [payload, supplied] = String(state || '').split('.');
    if (!payload || !supplied) throw new Error('Saxo-OAuth-State fehlt.');
    const expected = crypto.createHmac('sha256', tokenKey).update(payload).digest();
    const actual = Buffer.from(supplied, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error('Saxo-OAuth-State ist ungueltig.');
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (parsed.environment !== environment || Date.now() - Number(parsed.issuedAt) > 10 * 60_000) throw new Error('Saxo-OAuth-State ist abgelaufen.');
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
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Saxo-Tokenfehler (${response.status}): ${safeErrorPayload(text)}`);
    const token = JSON.parse(text);
    const now = Date.now();
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenType: token.token_type || 'Bearer',
      expiresAt: now + Math.max(60, Number(token.expires_in) || 1200) * 1000,
      refreshExpiresAt: now + Math.max(60, Number(token.refresh_token_expires_in) || 2400) * 1000,
      environment,
      updatedAt: new Date(now).toISOString(),
    };
  }

  async function completeOAuth({ code, state }) {
    verifyState(state);
    if (!clean(code, 2000)) throw new Error('Saxo-Autorisierungscode fehlt.');
    const token = await tokenRequest({ grant_type: 'authorization_code', code: clean(code, 2000), redirect_uri: redirectUri });
    await writeToken(token);
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
      refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: latest.refreshToken, redirect_uri: redirectUri });
      await writeToken(refreshed);
    });
    refreshQueue = job.catch(() => {});
    await job;
    return refreshed;
  }

  async function request(apiPath, { method = 'GET', body } = {}) {
    const token = await validToken();
    const response = await fetchImpl(`${endpoints.apiBaseUrl}/${String(apiPath).replace(/^\/+/, '')}`, {
      method,
      headers: { Authorization: `${token.tokenType} ${token.accessToken}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Saxo OpenAPI (${response.status}): ${safeErrorPayload(text)}`);
    return text ? JSON.parse(text) : {};
  }

  async function status({ probe = false } = {}) {
    const problems = missing();
    const token = await readToken();
    const result = {
      provider: 'Saxo OpenAPI', environment, configured: problems.length === 0,
      authorized: Boolean(token), ready: problems.length === 0 && Boolean(token), missing: problems,
      expiresAt: token?.expiresAt || null, refreshExpiresAt: token?.refreshExpiresAt || null,
      tradingEnabled: false,
      mode: 'read-analyze-precheck',
      setup: environment === 'sim'
        ? 'SIM-App testen; danach LIVE-App bei Saxo beantragen.'
        : 'LIVE-App verbunden. Orderausfuehrung bleibt in IVA weiterhin gesperrt.',
    };
    if (probe && result.ready) {
      try {
        const user = await request('port/v1/users/me');
        result.reachable = user.Active === true;
        result.connectedName = clean(user.Name, 200);
      } catch (error) { result.reachable = false; result.error = error.message; }
    }
    return result;
  }

  async function disconnect() {
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

  return { status, createAuthUrl, completeOAuth, disconnect, portfolio, searchInstruments, precheckOrder, request };
}

export { environmentConfig };
