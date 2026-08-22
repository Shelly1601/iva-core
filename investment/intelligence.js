import { analyzePriceSeries } from './indicators.js';
import { INVESTMENT_PLAYBOOK, playbookFor } from './playbook.js';

const clean = (value, max = 2000) => String(value ?? '').trim().slice(0, max);
const number = value => Number.isFinite(Number(value)) ? Number(value) : null;
const round = (value, digits = 2) => value === null || !Number.isFinite(Number(value)) ? null : Number(Number(value).toFixed(digits));

function normalizeInstrument(input = {}) {
  const uic = Math.round(Number(input.uic ?? input.Uic));
  const assetType = clean(input.assetType ?? input.AssetType, 80);
  if (!Number.isInteger(uic) || uic <= 0) throw new Error('Gueltige Saxo-UIC fehlt.');
  if (!assetType) throw new Error('Saxo-Anlageklasse fehlt.');
  return {
    uic,
    assetType,
    symbol: clean(input.symbol ?? input.Symbol, 120),
    description: clean(input.description ?? input.Description, 300),
    exchangeId: clean(input.exchangeId ?? input.ExchangeId, 100),
    currency: clean(input.currency ?? input.CurrencyCode, 3).toUpperCase(),
  };
}

function publicDetails(raw = {}, fallback = {}) {
  return {
    uic: Number(raw.Uic) || fallback.uic,
    assetType: raw.AssetType || fallback.assetType,
    symbol: clean(raw.Symbol || fallback.symbol, 120),
    description: clean(raw.Description || fallback.description, 300),
    currency: clean(raw.CurrencyCode || raw.PriceCurrency || fallback.currency, 3).toUpperCase(),
    exchange: {
      id: clean(raw.Exchange?.ExchangeId || fallback.exchangeId, 100),
      name: clean(raw.Exchange?.Name, 200),
      countryCode: clean(raw.Exchange?.CountryCode, 10),
    },
    isTradable: raw.IsTradable === true,
    tradingStatus: clean(raw.TradingStatus, 100),
    nonTradableReason: clean(raw.NonTradableReason, 200),
    primaryListingUic: Number(raw.PrimaryListing) || null,
    minimumTradeSize: number(raw.MinimumTradeSize),
    minimumOrderValue: number(raw.MinimumOrderValue),
    tickSize: number(raw.TickSize),
    supportedOrderTypes: Array.isArray(raw.SupportedOrderTypes) ? raw.SupportedOrderTypes.slice(0, 20) : [],
    distributionPolicy: clean(raw.DistributionPolicy, 100),
    coupon: number(raw.Coupon),
    expiryDate: raw.ExpiryDate || null,
    source: 'Saxo OpenAPI Instrument Details',
  };
}

function portfolioContext(raw = {}, instrument) {
  const positions = (raw.netPositions || []).filter(item => Number(item.NetPositionBase?.Uic) === instrument.uic && item.NetPositionBase?.AssetType === instrument.assetType);
  const exposure = positions.reduce((sum, item) => sum + Math.abs(Number(item.NetPositionView?.ExposureInBaseCurrency) || 0), 0);
  const amount = positions.reduce((sum, item) => sum + (Number(item.NetPositionBase?.Amount) || 0), 0);
  const totalValue = Math.abs(Number(raw.balance?.TotalValue) || 0);
  return {
    alreadyHeld: positions.length > 0,
    amount,
    exposureInBaseCurrency: round(exposure),
    currentWeightPct: totalValue ? round((exposure / totalValue) * 100) : null,
    totalPortfolioValue: round(totalValue),
    cashAvailableForTrading: round(Number(raw.balance?.CashAvailableForTrading) || 0),
    source: 'Saxo OpenAPI Portfolio',
  };
}

function freshness(chart = {}, technical = {}) {
  const lastTime = technical.to ? Date.parse(technical.to) : NaN;
  const ageHours = Number.isFinite(lastTime) ? Math.max(0, (Date.now() - lastTime) / 3_600_000) : null;
  const delayMinutes = Number(chart.ChartInfo?.DelayedByMinutes) || 0;
  return {
    lastSampleAt: technical.to,
    ageHours: round(ageHours, 1),
    delayedByMinutes: delayMinutes,
    exchangeId: clean(chart.ChartInfo?.ExchangeId, 100),
    status: ageHours === null ? 'unknown' : ageHours > 120 ? 'stale' : delayMinutes > 0 ? 'delayed' : 'current-for-daily-analysis',
    note: 'Taegliche Kursdaten koennen an Wochenenden und Feiertagen mehrere Kalendertage alt sein. Saxos ausgewiesene Verzoegerung wird separat gezeigt.',
  };
}

function researchAudit(result = {}) {
  const claims = Array.isArray(result.claims) ? result.claims : [];
  const sources = claims.flatMap(claim => Array.isArray(claim.sources) ? claim.sources : []);
  const domains = [...new Set(sources.map(source => {
    try { return new URL(source.url).hostname.replace(/^www\./, ''); } catch { return ''; }
  }).filter(Boolean))];
  const verifiedClaims = claims.filter(claim => claim.verified === true || ['high', 'medium'].includes(claim.confidence)).length;
  const disagreements = claims.reduce((sum, claim) => sum + (Array.isArray(claim.disagreements) ? claim.disagreements.length : 0), 0);
  return {
    claimCount: claims.length,
    verifiedClaims,
    primarySourceCount: sources.filter(source => source.sourceKind === 'primary-fetch').length,
    uniqueDomains: domains,
    disagreements,
    overallConfidence: result.overallConfidence || 'unknown',
    sufficientForDecision: verifiedClaims >= 3 && domains.length >= 2 && !result.unverifiedNotice,
  };
}

function decisionGate({ technical, sourceResearch, audit }) {
  const blockers = [];
  if ((technical?.sampleCount || 0) < 60) blockers.push('Zu wenig Saxo-Kurshistorie fuer eine robuste Marktregime-Einordnung.');
  if (!sourceResearch) blockers.push('Aktuelle Fundamental-, Ereignis- und Makroquellen wurden noch nicht recherchiert.');
  if (sourceResearch && !audit?.sufficientForDecision) blockers.push('Quellenabdeckung oder Claim-Verifikation reicht noch nicht fuer eine belastbare Entscheidungsvorlage.');
  if (sourceResearch?.unverifiedNotice) blockers.push(sourceResearch.unverifiedNotice);
  return {
    status: blockers.length ? 'research-required' : 'evidence-supported',
    blockers,
    passed: blockers.length === 0,
    note: 'Bestandene Datenpruefungen sind keine Anlageempfehlung. These, Gegenhypothese, Szenarien, Positionsgroesse und persoenliche Entscheidung bleiben separat.',
  };
}

function timeframeAgreement(daily, weekly) {
  if (!weekly) return { status: 'unknown', note: 'Wochenchart nicht verfuegbar.' };
  const dailyTrend = daily?.state?.trend;
  const weeklyTrend = weekly?.state?.trend;
  const aligned = dailyTrend && weeklyTrend && dailyTrend === weeklyTrend && ['uptrend', 'downtrend'].includes(dailyTrend);
  return {
    status: aligned ? 'aligned' : dailyTrend === 'insufficient' || weeklyTrend === 'insufficient' ? 'insufficient' : 'divergent',
    dailyTrend,
    weeklyTrend,
    note: aligned ? 'Tages- und Wochenregime zeigen in dieselbe Richtung.' : 'Zeitebenen sind nicht eindeutig ausgerichtet; das erhoeht die Unsicherheit.',
  };
}

function opportunityScore(analysis, previous = null) {
  const daily = analysis.market?.technical;
  const weekly = analysis.market?.weeklyTechnical;
  const components = [];
  const add = (points, reason) => components.push({ points, reason });
  add(Math.round((Number(daily?.technicalScore?.value) || 0) * 0.25), 'Transparenter Tageschart-Zustand');
  if (daily?.state?.trend === 'uptrend') add(10, 'Aufwaertstrend im Tageschart');
  if (daily?.state?.trend === 'downtrend') add(-10, 'Abwaertstrend im Tageschart');
  if (weekly?.state?.trend === 'uptrend') add(12, 'Aufwaertstrend im Wochenchart');
  if (weekly?.state?.trend === 'downtrend') add(-12, 'Abwaertstrend im Wochenchart');
  const patternIds = new Set([...(daily?.patterns || []), ...(weekly?.patterns || [])].map(item => item.id));
  if (patternIds.has('breakout-20')) add(8, 'Ausbruch aus der vorherigen Handelsspanne');
  if (patternIds.has('breakdown-20')) add(-8, 'Durchbruch unter die vorherige Handelsspanne');
  if (patternIds.has('volume-confirmation')) add(5, 'Erhoehtes Volumen');
  if (patternIds.has('volatility-expansion')) add(-4, 'Erhoehtes kurzfristiges Schwankungsrisiko');
  if (daily?.dataQuality?.status === 'complete') add(8, 'Vollstaendige technische Datenbasis');
  else if (daily?.dataQuality?.status === 'insufficient') add(-15, 'Unzureichende technische Datenbasis');
  if (previous?.evidenceAudit?.sufficientForDecision) add(12, 'Vorhandener quellengepruefter Research-Lauf');
  else add(-8, 'Fundamental-/Ereignisresearch noch offen');
  if (analysis.portfolioContext?.currentWeightPct > 0) add(-Math.min(15, Math.round(analysis.portfolioContext.currentWeightPct)), 'Bereits vorhandene Depotkonzentration');
  const raw = 50 + components.reduce((sum, item) => sum + item.points, 0);
  const score = Math.max(0, Math.min(100, raw));
  return {
    score,
    classification: score >= 75 ? 'research-now' : score >= 55 ? 'monitor' : 'low-priority',
    components,
    caveat: 'Heuristische Research-Priorisierung, keine Renditeprognose und keine Orderfreigabe.',
  };
}

function researchQuery(instrument, details, technical) {
  const name = details.description || instrument.description || details.symbol || instrument.symbol;
  return `Aktuelle, quellenorientierte Investment-Faktenbasis zu ${name} (${details.symbol || instrument.symbol}, Saxo UIC ${instrument.uic}, AssetType ${instrument.assetType}, Boerse ${details.exchange?.id || instrument.exchangeId || 'offen'}), Stand heute. Nutze bevorzugt offizielle Unternehmensberichte/Investor-Relations, regulatorische Filings und Boersenmitteilungen; fuer Makro nur Zentralbanken oder Statistikbehoerden. Pruefe: Geschaefts-/Produktstruktur, aktuelle Ergebnis- und Bilanztreiber, Bewertungstreiber ohne erfundenes Kursziel, datierte Katalysatoren, wesentliche Risiken, staerkste Gegenhypothese und relevante Makroabhaengigkeiten. Trenne belegte Fakten, Unsicherheit und Datenluecken. Keine Kauf-/Verkaufsempfehlung und keine Renditegarantie. Saxo-Marktzustand als Kontext: letzter Kurs ${technical.metrics.latestPrice ?? 'offen'} ${details.currency || instrument.currency}, 20-Perioden-Rendite ${technical.metrics.return20dPct ?? 'offen'} %, 60-Perioden-Rendite ${technical.metrics.return60dPct ?? 'offen'} %.`;
}

export function createInvestmentIntelligence({ saxo, store }) {
  async function snapshot(input = {}, { sourceResearch = null, mode = 'market-only', persist = true, portfolioData } = {}) {
    const instrument = normalizeInstrument(input.instrument || input);
    const accountKey = clean(input.accountKey, 200);
    const [detailsResult, chartResult, weeklyChartResult, portfolioResult] = await Promise.allSettled([
      saxo.instrumentDetails({ ...instrument, accountKey }),
      saxo.chart({ ...instrument, accountKey, horizon: 1440, count: 420 }),
      saxo.chart({ ...instrument, accountKey, horizon: 10080, count: 260 }),
      portfolioData === undefined ? saxo.portfolio() : Promise.resolve(portfolioData),
    ]);
    if (chartResult.status !== 'fulfilled') throw chartResult.reason;
    const chart = chartResult.value;
    const technical = analyzePriceSeries(chart.Data || [], { horizonMinutes: Number(chart.ChartInfo?.Horizon) || 1440 });
    const weeklyTechnical = weeklyChartResult.status === 'fulfilled'
      ? analyzePriceSeries(weeklyChartResult.value.Data || [], { horizonMinutes: Number(weeklyChartResult.value.ChartInfo?.Horizon) || 10080 })
      : null;
    const details = publicDetails(detailsResult.status === 'fulfilled' ? detailsResult.value : {}, instrument);
    const audit = sourceResearch ? researchAudit(sourceResearch) : null;
    const result = {
      mode,
      instrument: { ...instrument, symbol: details.symbol || instrument.symbol, description: details.description || instrument.description, exchangeId: details.exchange.id || instrument.exchangeId, currency: details.currency || instrument.currency },
      fetchedAt: new Date().toISOString(),
      market: {
        details,
        technical,
        weeklyTechnical,
        timeframeAgreement: timeframeAgreement(technical, weeklyTechnical),
        freshness: freshness(chart, technical),
        display: chart.DisplayAndFormat || {},
        detailsUnavailable: detailsResult.status === 'rejected' ? clean(detailsResult.reason?.message, 400) : '',
        weeklyChartUnavailable: weeklyChartResult.status === 'rejected' ? clean(weeklyChartResult.reason?.message, 400) : '',
        source: 'Saxo OpenAPI Chart v3 und Instrument Details',
      },
      portfolioContext: portfolioResult.status === 'fulfilled' && portfolioResult.value
        ? portfolioContext(portfolioResult.value, instrument)
        : { unavailable: true, reason: portfolioResult.status === 'rejected' ? clean(portfolioResult.reason?.message, 400) : 'Saxo-Portfolio nicht verfuegbar.' },
      sourceResearch,
      evidenceAudit: audit,
      playbook: playbookFor(instrument.assetType),
      decisionGate: decisionGate({ technical, sourceResearch, audit }),
      caveat: 'IVA misst Daten, Quellenabdeckung und Prognosequalitaet. Das Ergebnis ist keine Garantie und keine automatisch ausfuehrbare Anlageentscheidung.',
    };
    return persist ? await store.saveAnalysis(result) : result;
  }

  async function researchInstrument(input = {}) {
    const marketOnly = await snapshot(input, { persist: false });
    const { research } = await import('../agents/web.js');
    const result = await research(researchQuery(marketOnly.instrument, marketOnly.market.details, marketOnly.market.technical), {
      fast: false,
      maxFetches: 6,
      maxSearches: 7,
      researchBudgetMs: 35_000,
      synthesisBudgetMs: 50_000,
      refutationBudgetMs: 20_000,
    });
    return snapshot(input, { sourceResearch: result, mode: 'market-and-sources', persist: true });
  }

  async function screenOpportunities({ limit = 12, trigger = 'manual', persist = true } = {}) {
    const [watchlist, analyses, mandate, portfolioData] = await Promise.all([
      store.listWatchlist(),
      store.listAnalyses({ limit: 300 }),
      store.getMandate(),
      saxo.portfolio().catch(() => null),
    ]);
    const candidates = [];
    const selected = watchlist.slice(0, Math.max(1, Math.min(20, Number(limit) || 12)));
    for (let index = 0; index < selected.length; index += 3) {
      const batch = selected.slice(index, index + 3);
      const results = await Promise.allSettled(batch.map(instrument => snapshot({ instrument }, { persist: false, portfolioData })));
      results.forEach((result, offset) => {
        const instrument = batch[offset];
        if (result.status === 'rejected') {
          candidates.push({ instrument, error: clean(result.reason?.message, 500), researchPriority: { score: 0, classification: 'unavailable', components: [] } });
          return;
        }
        const key = `${instrument.assetType}:${instrument.uic}`;
        const previous = analyses.find(item => `${item.instrument?.assetType}:${item.instrument?.uic}` === key && item.mode === 'market-and-sources');
        const analysis = result.value;
        candidates.push({
          instrument: analysis.instrument,
          market: analysis.market,
          portfolioContext: analysis.portfolioContext,
          latestEvidenceAt: previous?.createdAt || null,
          evidenceAudit: previous?.evidenceAudit || null,
          researchPriority: opportunityScore(analysis, previous),
        });
      });
    }
    candidates.sort((a, b) => Number(b.researchPriority?.score || 0) - Number(a.researchPriority?.score || 0));
    const result = {
      scannedAt: new Date().toISOString(),
      universe: 'IVA-Watchlist',
      cadence: mandate.analysisCadence,
      candidateCount: candidates.length,
      candidates,
      nextAction: candidates.some(item => item.researchPriority?.classification === 'research-now')
        ? 'Top-Kandidaten benoetigen jetzt den Quellenresearch, Gegenhypothese und Portfolio-Gate.'
        : 'Kein Kandidat erreicht aktuell die Schwelle fuer priorisierten Quellenresearch.',
      caveat: 'Charts priorisieren, was tiefer geprueft wird. Sie beweisen nicht, welches Investment kuenftig die hoechste Rendite erzielt.',
    };
    return persist ? await store.saveOpportunityScan(result, trigger) : result;
  }

  async function autonomyReadiness() {
    const [mandate, calibration, analyses, journal] = await Promise.all([
      store.getMandate(), store.calibrationSummary(), store.listAnalyses({ limit: 300 }), store.listJournal({ limit: 1000 }),
    ]);
    const researchRuns = analyses.filter(item => item.mode === 'market-and-sources' && item.evidenceAudit?.sufficientForDecision).length;
    const oldest = journal.length ? Math.min(...journal.map(item => Date.parse(item.openedAt)).filter(Number.isFinite)) : NaN;
    const observedMonths = Number.isFinite(oldest) ? Math.max(0, (Date.now() - oldest) / (30.44 * 86_400_000)) : 0;
    const blockers = [];
    if (mandate.monthlyAmount <= 0) blockers.push('Monatlicher Betrag X ist noch nicht festgelegt.');
    if (calibration.reviewedCount < mandate.simulationMinimumDecisions) blockers.push(`Erst ${calibration.reviewedCount} von ${mandate.simulationMinimumDecisions} geforderten bewerteten SIM-/Journalentscheidungen.`);
    if (observedMonths < mandate.simulationMinimumMonths) blockers.push(`Erst ${observedMonths.toFixed(1)} von ${mandate.simulationMinimumMonths} geforderten Beobachtungsmonaten.`);
    if ((calibration.calibrationScore ?? 0) < mandate.minimumCalibrationScore) blockers.push(`Kalibrierung ${calibration.calibrationScore ?? 0} unter Ziel ${mandate.minimumCalibrationScore}.`);
    if (researchRuns < 10) blockers.push(`Erst ${researchRuns} belastbare Quellenanalysen; Mindestbasis fuer LIVE-Pruefung: 10.`);
    if (mandate.allowOptionsContracts || mandate.allowLeveragedProducts) blockers.push('Optionen oder Hebelprodukte erfordern ein separates Verlust- und Eignungsmodell.');
    return {
      mandate,
      calibration,
      observedMonths: Number(observedMonths.toFixed(1)),
      evidenceSupportedResearchRuns: researchRuns,
      currentStage: mandate.autonomyStage,
      eligibleForLiveReview: blockers.length === 0,
      blockers,
      liveOrderExecutionEnabled: false,
      principle: 'Rendite maximieren unter harten Verlust-, Drawdown-, Liquiditaets- und Produktgrenzen; niemals unbegrenztes Risiko.',
    };
  }

  return {
    snapshot,
    researchInstrument,
    screenOpportunities,
    autonomyReadiness,
    playbook: assetType => playbookFor(assetType),
    knowledgeStatus: () => ({
      playbookVersion: INVESTMENT_PLAYBOOK.version,
      doctrineCount: INVESTMENT_PLAYBOOK.doctrine.length,
      lensCount: INVESTMENT_PLAYBOOK.lenses.length,
      sourceTiers: INVESTMENT_PLAYBOOK.sourceHierarchy.length,
      officialAnchors: INVESTMENT_PLAYBOOK.officialAnchors,
      deterministicAnalytics: ['Renditen', 'SMA 20/50/200', 'RSI 14', 'ATR 14', 'historische Volatilitaet', 'maximaler Drawdown', '52-Wochen-Spanne'],
      researchSafeguards: ['Fetched-Originalquellen fuer medium/high', 'Quellen-Halluzinationsfilter', 'Zahlenabgleich', 'Gegenpruefung', 'Confidence kann nur sinken'],
    }),
  };
}
