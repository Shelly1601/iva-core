import { createInvestmentStore } from './store.js';
import { analyzePortfolio, LEVERAGED_ASSET_TYPES } from './risk.js';
import { createSaxoClient } from './saxo.js';
import { createInvestmentIntelligence } from './intelligence.js';

const clean = (value, max = 2000) => String(value ?? '').trim().slice(0, max);

function performanceSeries(performance = {}) {
  const rows = performance?.Balance?.AccountValue;
  if (!Array.isArray(rows)) return [];
  return rows.map(item => ({ date: item.Date, value: Number(item.Value) || 0 })).filter(item => item.date).slice(-370);
}

function normalizeOrders(items = []) {
  return items.map(item => ({
    orderId: String(item.OrderId || ''), accountId: String(item.AccountId || ''), accountKey: String(item.AccountKey || ''),
    uic: Number(item.Uic) || 0, assetType: String(item.AssetType || ''),
    symbol: String(item.DisplayAndFormat?.Symbol || ''), description: String(item.DisplayAndFormat?.Description || ''),
    direction: String(item.BuySell || ''), amount: Number(item.Amount) || 0, type: String(item.OpenOrderType || ''),
    price: Number(item.Price) || 0, marketPrice: Number(item.MarketPrice) || 0, status: String(item.Status || ''),
    createdAt: item.OrderTime || null, duration: item.Duration || null,
  }));
}

export function createInvestmentModule({ dataDir = process.env.DATA_DIR || '/data', env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const store = createInvestmentStore({ dataDir });
  const saxo = createSaxoClient({ dataDir, env, fetchImpl });
  const intelligence = createInvestmentIntelligence({ saxo, store });
  let monitorRunning = false;

  function berlinClock() {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    return { weekday: parts.find(part => part.type === 'weekday')?.value || '', hour: Number(parts.find(part => part.type === 'hour')?.value) || 0 };
  }

  async function runScheduledOpportunityMonitor() {
    if (monitorRunning) return;
    monitorRunning = true;
    try {
      const [mandate, connection, latest] = await Promise.all([store.getMandate(), saxo.status({ probe: false }), store.latestOpportunityScan()]);
      if (mandate.monthlyAmount <= 0 || !connection.ready) return;
      const clock = berlinClock();
      if (clock.hour < 18) return;
      if (mandate.analysisCadence === 'weekdays' && ['Sat', 'Sun'].includes(clock.weekday)) return;
      const elapsed = latest?.scannedAt ? Date.now() - Date.parse(latest.scannedAt) : Infinity;
      const minimumGap = mandate.analysisCadence === 'weekly' ? 6 * 86_400_000 : 20 * 3_600_000;
      if (Number.isFinite(elapsed) && elapsed < minimumGap) return;
      await intelligence.screenOpportunities({ limit: 20, trigger: 'scheduled', persist: true });
    } catch (error) {
      console.error('Investment-Chancenmonitor:', clean(error.message, 400));
    } finally { monitorRunning = false; }
  }

  const monitorTimer = setInterval(() => { void runScheduledOpportunityMonitor(); }, 30 * 60_000);
  monitorTimer.unref?.();
  const monitorStartup = setTimeout(() => { void runScheduledOpportunityMonitor(); }, 60_000);
  monitorStartup.unref?.();

  async function status(options = {}) {
    const [connection, local] = await Promise.all([saxo.status(options), store.summary()]);
    return {
      connection,
      local,
      capabilities: [
        'Saxo OAuth', 'Depot und Konten lesen', 'Performance', 'Positions- und Konzentrationsrisiken',
        'Multi-Timeframe-Chartanalyse und Mustererkennung', 'Automatischer Chancenmonitor nach Mandats-Takt', 'Quellengepruefter Investment-Research',
        'Chancen-Ranking der Watchlist', 'Monatliches Investment-Mandat', 'Prognose- und Kalibrierungsjournal',
        'Watchlist', 'Orderentwuerfe', 'Saxo Order-Precheck',
      ],
      safeguards: [
        connection.saxoAppTradingPermission
          ? 'Saxo-App hat Handelsberechtigung; IVA-Orderausfuehrung bleibt separat gesperrt'
          : 'Keine Orderausfuehrung',
        'Keine ungepruefte LIVE-Autonomie', 'Keine Hebelprodukte ausserhalb der Risikoregeln',
        'Verschluesselte OAuth-Tokens', 'Jeder Entwurf mit Investmentthese',
        'LIVE-Autonomie erst nach dokumentierter SIM-Bewaehrung, Quellenabdeckung und Kalibrierung',
      ],
      nextStep: connection.configured
        ? connection.authorized
          ? local.mandate?.monthlyAmount > 0 ? 'Watchlist scannen, Top-Kandidaten quellenbasiert pruefen und die SIM-Bewaehrung messen.' : 'Monatlichen Betrag X und harte Mandatsgrenzen festlegen.'
          : 'Saxo ueber OAuth verbinden.'
        : 'SIM-App im Saxo Developer Portal anlegen und die fehlenden Railway-Variablen setzen.',
    };
  }

  async function portfolio() {
    const [raw, settings] = await Promise.all([saxo.portfolio(), store.getSettings()]);
    const risk = analyzePortfolio({ balance: raw.balance, positions: raw.netPositions, settings });
    return {
      fetchedAt: raw.fetchedAt,
      environment: raw.environment,
      user: raw.user,
      client: raw.client,
      accounts: raw.accounts,
      balance: {
        currency: raw.balance.Currency || raw.client.currency || settings.referenceCurrency,
        totalValue: Number(raw.balance.TotalValue) || 0,
        cashBalance: Number(raw.balance.CashBalance) || 0,
        cashAvailableForTrading: Number(raw.balance.CashAvailableForTrading) || 0,
        unrealizedProfitLoss: Number(raw.balance.UnrealizedMarginProfitLoss || raw.balance.UnrealizedMarginOpenProfitLoss) || 0,
        costToClosePositions: Number(raw.balance.CostToClosePositions) || 0,
        calculationReliability: raw.balance.CalculationReliability || 'Unknown',
      },
      positions: risk.positions,
      openOrders: normalizeOrders(raw.orders),
      risk,
      performance: { series: performanceSeries(raw.performance), unavailable: raw.performance?.unavailable === true, reason: raw.performance?.reason || '' },
      settings,
      source: 'Saxo OpenAPI',
      caveat: 'Kurse und Performance stammen direkt von Saxo; Boersenrechte koennen verzoegerte Kurse verursachen. IVA sendet keine Orders.',
    };
  }

  async function riskReport() {
    const snapshot = await portfolio();
    return { fetchedAt: snapshot.fetchedAt, environment: snapshot.environment, risk: snapshot.risk, balance: snapshot.balance, source: snapshot.source };
  }

  async function precheckOrderDraft(id) {
    const draft = await store.getOrderDraft(id);
    if (!draft) return null;
    const settings = await store.getSettings();
    const policyBlocks = [];
    if (!settings.allowedAssetTypes.includes(draft.instrument.assetType)) policyBlocks.push(`Anlageklasse ${draft.instrument.assetType} ist nicht freigegeben.`);
    if (LEVERAGED_ASSET_TYPES.has(draft.instrument.assetType) && settings.allowMargin !== true) policyBlocks.push(`Hebelprodukt ${draft.instrument.assetType} ist nicht freigegeben.`);
    if (policyBlocks.length) {
      return store.savePrecheck(id, { PreCheckResult: 'IvaRiskLimit', SaxoPreCheckResult: 'NotRun', IvaChecks: { ok: false, blocks: policyBlocks } });
    }

    const snapshot = await saxo.portfolio();
    if (draft.direction === 'Sell' && settings.allowShorting !== true) {
      const availableAmount = snapshot.netPositions
        .filter(item => Number(item.NetPositionBase?.Uic) === draft.instrument.uic
          && item.NetPositionBase?.AssetType === draft.instrument.assetType)
        .reduce((sum, item) => sum + Math.max(0, Number(item.NetPositionBase?.Amount) || 0), 0);
      if (draft.amount > availableAmount) {
        policyBlocks.push(`Verkaufsmenge ${draft.amount} uebersteigt den vorhandenen Bestand ${availableAmount}; Shorting ist nicht freigegeben.`);
        return store.savePrecheck(id, {
          PreCheckResult: 'IvaRiskLimit', SaxoPreCheckResult: 'NotRun',
          IvaChecks: { ok: false, blocks: policyBlocks, availableAmount },
        });
      }
    }

    const saxoResult = await saxo.precheckOrder(draft);
    const totalValue = Math.abs(Number(snapshot.balance?.TotalValue) || 0);
    const estimate = Math.abs(Number(saxoResult.EstimatedTotalCostInAccountCurrency || saxoResult.EstimatedCashRequired) || 0);
    const estimatedOrderPct = totalValue ? (estimate / totalValue) * 100 : null;
    if (estimatedOrderPct !== null && estimatedOrderPct > Number(settings.maxOrderValuePct)) {
      policyBlocks.push(`Geschaetzter Orderwert ${estimatedOrderPct.toFixed(2)} % uebersteigt die Grenze von ${settings.maxOrderValuePct} %.`);
    }
    if (draft.direction === 'Buy' && settings.allowMargin !== true) {
      const availableCash = Math.max(0, Number(snapshot.balance?.CashAvailableForTrading) || 0);
      if (estimate > availableCash) policyBlocks.push(`Geschaetzter Kapitalbedarf uebersteigt die frei verfuegbare Liquiditaet; Margin ist nicht freigegeben.`);

      const account = snapshot.accounts.find(item => item.accountKey === draft.accountKey);
      if (totalValue && estimate && account?.currency === snapshot.client?.currency) {
        const currentExposure = snapshot.netPositions
          .filter(item => Number(item.NetPositionBase?.Uic) === draft.instrument.uic
            && item.NetPositionBase?.AssetType === draft.instrument.assetType)
          .reduce((sum, item) => sum + Math.abs(Number(item.NetPositionView?.ExposureInBaseCurrency) || 0), 0);
        const resultingPositionPct = ((currentExposure + estimate) / totalValue) * 100;
        if (resultingPositionPct > Number(settings.maxPositionPct)) {
          policyBlocks.push(`Position waere danach voraussichtlich ${resultingPositionPct.toFixed(2)} % gross und laege ueber der Grenze von ${settings.maxPositionPct} %.`);
        }
      }
    }
    const result = {
      ...saxoResult,
      SaxoPreCheckResult: saxoResult.PreCheckResult,
      PreCheckResult: policyBlocks.length ? 'IvaRiskLimit' : saxoResult.PreCheckResult,
      IvaChecks: { ok: !policyBlocks.length, blocks: policyBlocks, estimatedOrderPct: estimatedOrderPct === null ? null : Number(estimatedOrderPct.toFixed(2)), maxOrderValuePct: settings.maxOrderValuePct },
    };
    return store.savePrecheck(id, result);
  }

  function registerRoutes(app) {
    app.get('/oauth/saxo/callback', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (req.query?.error) return res.redirect('/investment?saxo=denied');
      try {
        await saxo.completeOAuth({ code: String(req.query?.code || ''), state: String(req.query?.state || '') });
        res.redirect('/investment?saxo=connected');
      } catch (error) {
        console.error('Saxo OAuth Callback:', clean(error.message, 300));
        res.redirect('/investment?saxo=error');
      }
    });

    app.get('/health/investment', async (_req, res) => {
      const result = await saxo.status({ probe: false });
      res.status(result.configured ? 200 : 503).json({
        configured: result.configured, authorized: result.authorized, environment: result.environment,
        saxoAppTradingPermission: result.saxoAppTradingPermission,
        tradingEnabled: false, orderExecutionEnabled: false, missing: result.missing,
      });
    });

    app.get('/api/investment/status', async (_req, res) => {
      try { res.json(await status({ probe: false })); }
      catch (error) { res.status(500).json({ error: error.message }); }
    });
    app.get('/api/investment/saxo/auth-url', (_req, res) => {
      try { res.json({ url: saxo.createAuthUrl() }); }
      catch (error) { res.status(503).json({ error: error.message }); }
    });
    app.post('/api/investment/saxo/disconnect', async (req, res) => {
      if (req.body?.confirmation !== 'SAXO VERBINDUNG TRENNEN') return res.status(400).json({ error: 'Exakte Bestaetigung fehlt.' });
      try { res.json(await saxo.disconnect()); }
      catch (error) { res.status(500).json({ error: error.message }); }
    });
    app.get('/api/investment/portfolio', async (_req, res) => {
      try { res.json(await portfolio()); }
      catch (error) { res.status(503).json({ error: error.message }); }
    });
    app.get('/api/investment/risk', async (_req, res) => {
      try { res.json(await riskReport()); }
      catch (error) { res.status(503).json({ error: error.message }); }
    });
    app.get('/api/investment/settings', async (_req, res) => res.json(await store.getSettings()));
    app.patch('/api/investment/settings', async (req, res) => {
      try { res.json(await store.updateSettings(req.body || {})); }
      catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.get('/api/investment/instruments', async (req, res) => {
      try { res.json({ instruments: await saxo.searchInstruments({ query: req.query?.q, accountKey: req.query?.accountKey || '' }) }); }
      catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.get('/api/investment/knowledge', async (req, res) => {
      res.json({ status: intelligence.knowledgeStatus(), playbook: intelligence.playbook(String(req.query?.assetType || '')) });
    });
    app.post('/api/investment/analysis', async (req, res) => {
      try { res.status(201).json(await intelligence.snapshot(req.body || {})); }
      catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.post('/api/investment/research', async (req, res) => {
      if (req.body?.confirmation !== 'QUELLENRESEARCH STARTEN') return res.status(400).json({ error: 'Exakte Research-Bestaetigung fehlt.' });
      try { res.status(201).json(await intelligence.researchInstrument(req.body || {})); }
      catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.get('/api/investment/analyses', async (req, res) => res.json({ items: await store.listAnalyses({ limit: req.query?.limit, key: String(req.query?.key || '') }) }));
    app.get('/api/investment/analyses/:id', async (req, res) => {
      const item = await store.getAnalysis(req.params.id);
      res.status(item ? 200 : 404).json(item || { error: 'Analyse nicht gefunden.' });
    });
    app.post('/api/investment/opportunities/scan', async (req, res) => {
      try { res.json(await intelligence.screenOpportunities({ limit: req.body?.limit })); }
      catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.get('/api/investment/opportunities/latest', async (_req, res) => res.json({ item: await store.latestOpportunityScan() }));
    app.get('/api/investment/mandate', async (_req, res) => res.json(await store.getMandate()));
    app.patch('/api/investment/mandate', async (req, res) => {
      try { res.json(await store.updateMandate(req.body || {})); }
      catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.get('/api/investment/autonomy-readiness', async (_req, res) => res.json(await intelligence.autonomyReadiness()));
    app.get('/api/investment/journal', async (req, res) => res.json({
      items: await store.listJournal({ status: String(req.query?.status || ''), limit: req.query?.limit }),
      calibration: await store.calibrationSummary(),
    }));
    app.post('/api/investment/journal', async (req, res) => {
      try { res.status(201).json(await store.createJournalEntry(req.body || {})); }
      catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.post('/api/investment/journal/:id/review', async (req, res) => {
      try {
        const item = await store.reviewJournalEntry(req.params.id, req.body || {});
        res.status(item ? 200 : 404).json(item || { error: 'Journal-Eintrag nicht gefunden.' });
      } catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.get('/api/investment/watchlist', async (_req, res) => res.json({ items: await store.listWatchlist() }));
    app.post('/api/investment/watchlist', async (req, res) => {
      try { res.status(201).json(await store.addWatchlist(req.body || {})); }
      catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.delete('/api/investment/watchlist/:key', async (req, res) => {
      const item = await store.removeWatchlist(req.params.key);
      res.status(item ? 200 : 404).json(item || { error: 'Watchlist-Eintrag nicht gefunden.' });
    });
    app.get('/api/investment/order-drafts', async (req, res) => res.json({ items: await store.listOrderDrafts({ status: String(req.query?.status || '') }) }));
    app.post('/api/investment/order-drafts', async (req, res) => {
      try { res.status(201).json(await store.createOrderDraft(req.body || {})); }
      catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.patch('/api/investment/order-drafts/:id', async (req, res) => {
      try {
        const item = await store.updateOrderDraft(req.params.id, req.body || {});
        res.status(item ? 200 : 404).json(item || { error: 'Orderentwurf nicht gefunden.' });
      } catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.post('/api/investment/order-drafts/:id/precheck', async (req, res) => {
      try {
        const item = await precheckOrderDraft(req.params.id);
        res.status(item ? 200 : 404).json(item || { error: 'Orderentwurf nicht gefunden.' });
      } catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.get('/api/investment/audit', async (req, res) => res.json({ items: await store.listAudit({ limit: req.query?.limit }) }));
  }

  return {
    registerRoutes, status, portfolio, riskReport, precheckOrderDraft,
    analyzeInstrument: intelligence.snapshot,
    researchInstrument: intelligence.researchInstrument,
    screenOpportunities: intelligence.screenOpportunities,
    latestOpportunityScan: store.latestOpportunityScan,
    autonomyReadiness: intelligence.autonomyReadiness,
    getInvestmentKnowledge: intelligence.knowledgeStatus,
    getInvestmentPlaybook: intelligence.playbook,
    searchInstruments: saxo.searchInstruments,
    getSettings: store.getSettings,
    updateSettings: store.updateSettings,
    getMandate: store.getMandate,
    updateMandate: store.updateMandate,
    listWatchlist: store.listWatchlist,
    addWatchlist: store.addWatchlist,
    listAnalyses: store.listAnalyses,
    listJournal: store.listJournal,
    createJournalEntry: store.createJournalEntry,
    reviewJournalEntry: store.reviewJournalEntry,
    calibrationSummary: store.calibrationSummary,
    listOrderDrafts: store.listOrderDrafts,
    createOrderDraft: store.createOrderDraft,
  };
}
