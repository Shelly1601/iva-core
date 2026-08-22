const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const round = (value, digits = 2) => Number(number(value).toFixed(digits));

const LEVERAGED_ASSET_TYPES = new Set([
  'CfdOnStock', 'CfdOnIndex', 'CfdOnFutures', 'CfdOnEtf', 'FxSpot', 'FxForwards', 'FxVanillaOption',
  'ContractFutures', 'StockIndexOption', 'StockOption', 'FuturesOption', 'CertificateBarrierReverseConvertibles',
]);

export function normalizeSaxoPosition(item = {}) {
  const base = item.NetPositionBase || {};
  const view = item.NetPositionView || {};
  const display = item.DisplayAndFormat || {};
  const amount = number(base.Amount);
  const openingDirection = base.OpeningDirection || (amount < 0 ? 'Sell' : 'Buy');
  return {
    id: String(item.NetPositionId || ''),
    uic: number(base.Uic),
    assetType: String(base.AssetType || ''),
    symbol: String(display.Symbol || display.DisplaySymbol || ''),
    description: String(display.Description || item.NetPositionId || ''),
    currency: String(display.Currency || display.CurrencyCode || ''),
    accountId: String(base.AccountId || base.PositionsAccount || ''),
    amount,
    direction: openingDirection,
    averageOpenPrice: number(view.AverageOpenPriceIncludingCosts || view.AverageOpenPrice),
    currentPrice: number(view.CurrentPrice),
    currentPriceDelayMinutes: number(view.CurrentPriceDelayMinutes),
    dayChangePct: round(view.InstrumentPriceDayPercentChange),
    exposure: round(view.Exposure),
    exposureInBaseCurrency: round(view.ExposureInBaseCurrency),
    profitLoss: round(view.ProfitLossOnTrade),
    positionCount: number(view.PositionCount),
    marketOpen: base.IsMarketOpen === true,
    status: String(view.Status || base.SinglePositionStatus || ''),
  };
}

export function analyzePortfolio({ balance = {}, positions = [], settings = {} } = {}) {
  const normalized = positions.map(normalizeSaxoPosition);
  const totalValue = Math.abs(number(balance.TotalValue));
  const exposureBase = normalized.reduce((sum, item) => sum + Math.abs(item.exposureInBaseCurrency), 0);
  const denominator = totalValue || exposureBase || 1;
  const cash = number(balance.CashBalance);
  const cashPct = denominator ? (cash / denominator) * 100 : 0;
  const marginUtilizationPct = number(balance.MarginUtilizationPct || balance.MarginAndCollateralUtilizationPct);
  const maxPositionPct = number(settings.maxPositionPct || 15);
  const minCashPct = number(settings.minCashPct || 5);
  const allowed = new Set(settings.allowedAssetTypes || []);
  const warnings = [];

  const weighted = normalized.map(item => ({
    ...item,
    weightPct: round((Math.abs(item.exposureInBaseCurrency) / denominator) * 100),
  })).sort((a, b) => b.weightPct - a.weightPct);

  for (const item of weighted) {
    if (item.weightPct > maxPositionPct) warnings.push({
      severity: item.weightPct > maxPositionPct * 1.5 ? 'red' : 'yellow',
      code: 'position-concentration',
      title: `${item.description || item.symbol || item.id}: ${item.weightPct} %`,
      detail: `Die Position liegt ueber der festgelegten Einzelpositionsgrenze von ${maxPositionPct} %.`,
    });
    if (LEVERAGED_ASSET_TYPES.has(item.assetType) && settings.allowMargin !== true) warnings.push({
      severity: 'red', code: 'leveraged-product', title: `Hebelprodukt: ${item.description || item.id}`,
      detail: `${item.assetType} ist laut Strategie nicht freigegeben.`,
    });
    if ((item.amount < 0 || item.direction === 'Sell') && settings.allowShorting !== true) warnings.push({
      severity: 'red', code: 'short-position', title: `Short-Position: ${item.description || item.id}`,
      detail: 'Short-Positionen sind in den aktuellen Risikoregeln nicht freigegeben.',
    });
    if (allowed.size && !allowed.has(item.assetType)) warnings.push({
      severity: 'yellow', code: 'asset-outside-policy', title: `Nicht freigegebene Anlageklasse: ${item.assetType}`,
      detail: `${item.description || item.id} liegt ausserhalb der hinterlegten Anlageklassen.`,
    });
    if (item.currentPriceDelayMinutes > 0) warnings.push({
      severity: 'info', code: 'delayed-price', title: `Verzoegerter Kurs: ${item.description || item.id}`,
      detail: `Der von Saxo gelieferte Kurs ist ${item.currentPriceDelayMinutes} Minuten verzoegert.`,
    });
  }

  if (cashPct < minCashPct) warnings.push({
    severity: cashPct < Math.max(0, minCashPct / 2) ? 'red' : 'yellow', code: 'cash-buffer',
    title: `Liquiditaet ${round(cashPct)} %`, detail: `Der hinterlegte Mindestpuffer betraegt ${minCashPct} %.`,
  });
  if (marginUtilizationPct > 0 && settings.allowMargin !== true) warnings.push({
    severity: 'red', code: 'margin-use', title: `Margin-Nutzung ${round(marginUtilizationPct)} %`,
    detail: 'Margin-Nutzung ist in den aktuellen Risikoregeln nicht freigegeben.',
  });

  const red = warnings.filter(item => item.severity === 'red').length;
  const yellow = warnings.filter(item => item.severity === 'yellow').length;
  return {
    status: red ? 'red' : yellow ? 'yellow' : 'green',
    metrics: {
      totalValue: round(totalValue), cashBalance: round(cash), cashPct: round(cashPct),
      totalExposure: round(exposureBase), marginUtilizationPct: round(marginUtilizationPct),
      positionCount: weighted.length, largestPositionPct: weighted[0]?.weightPct || 0,
    },
    positions: weighted,
    warnings,
    methodology: 'Gewichte basieren auf Saxo ExposureInBaseCurrency relativ zum aktuellen Saxo-Gesamtwert. Fehlende Werte werden offen als Datenluecke behandelt.',
  };
}

export { LEVERAGED_ASSET_TYPES };
