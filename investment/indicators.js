const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const round = (value, digits = 2) => value === null || !Number.isFinite(Number(value)) ? null : Number(Number(value).toFixed(digits));

function midpoint(left, right) {
  const a = finite(left);
  const b = finite(right);
  if (a !== null && b !== null) return (a + b) / 2;
  return a ?? b;
}

function price(sample, direct, bid, ask) {
  return finite(sample?.[direct]) ?? midpoint(sample?.[bid], sample?.[ask]);
}

export function normalizeChartSamples(samples = []) {
  const byTime = new Map();
  for (const sample of Array.isArray(samples) ? samples : []) {
    const time = String(sample?.Time || sample?.time || '').trim();
    const close = price(sample, 'Close', 'CloseBid', 'CloseAsk');
    if (!time || close === null || close <= 0) continue;
    byTime.set(time, {
      time,
      open: price(sample, 'Open', 'OpenBid', 'OpenAsk') ?? close,
      high: price(sample, 'High', 'HighBid', 'HighAsk') ?? close,
      low: price(sample, 'Low', 'LowBid', 'LowAsk') ?? close,
      close,
      volume: finite(sample?.Volume),
      marketState: String(sample?.MarketTradingState || ''),
    });
  }
  return [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function sma(values, periods) {
  return values.length >= periods ? mean(values.slice(-periods)) : null;
}

function returnPct(values, periods) {
  if (values.length <= periods) return null;
  const start = values.at(-(periods + 1));
  const end = values.at(-1);
  return start > 0 ? ((end / start) - 1) * 100 : null;
}

function rsi(values, periods = 14) {
  if (values.length <= periods) return null;
  const deltas = values.slice(-(periods + 1)).slice(1).map((value, index) => value - values.slice(-(periods + 1))[index]);
  const gains = mean(deltas.map(value => Math.max(0, value))) ?? 0;
  const losses = mean(deltas.map(value => Math.max(0, -value))) ?? 0;
  if (losses === 0) return gains === 0 ? 50 : 100;
  return 100 - (100 / (1 + gains / losses));
}

function atr(rows, periods = 14) {
  if (rows.length <= periods) return null;
  const window = rows.slice(-(periods + 1));
  const ranges = window.slice(1).map((row, index) => {
    const previousClose = window[index].close;
    return Math.max(row.high - row.low, Math.abs(row.high - previousClose), Math.abs(row.low - previousClose));
  });
  return mean(ranges);
}

function annualizedVolatility(values, periods) {
  if (values.length <= periods) return null;
  const window = values.slice(-(periods + 1));
  const returns = window.slice(1).map((value, index) => Math.log(value / window[index])).filter(Number.isFinite);
  const avg = mean(returns);
  if (avg === null || returns.length < 2) return null;
  const variance = returns.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

function maxDrawdown(values) {
  let peak = null;
  let worst = 0;
  for (const value of values) {
    peak = peak === null ? value : Math.max(peak, value);
    if (peak > 0) worst = Math.min(worst, (value / peak) - 1);
  }
  return worst * 100;
}

function range(values, periods) {
  const window = values.slice(-Math.min(periods, values.length));
  return window.length ? { low: Math.min(...window), high: Math.max(...window) } : { low: null, high: null };
}

function stateFrom(metrics) {
  const trendVotes = [
    metrics.latestPrice !== null && metrics.sma20 !== null ? metrics.latestPrice > metrics.sma20 : null,
    metrics.sma20 !== null && metrics.sma50 !== null ? metrics.sma20 > metrics.sma50 : null,
    metrics.sma50 !== null && metrics.sma200 !== null ? metrics.sma50 > metrics.sma200 : null,
  ].filter(value => value !== null);
  const positive = trendVotes.filter(Boolean).length;
  const trend = trendVotes.length < 2 ? 'insufficient'
    : positive === trendVotes.length ? 'uptrend'
      : positive === 0 ? 'downtrend' : 'mixed';
  const momentum = metrics.rsi14 === null ? 'insufficient'
    : metrics.rsi14 >= 70 ? 'overbought'
      : metrics.rsi14 <= 30 ? 'oversold'
        : metrics.return20dPct > 0 ? 'positive' : metrics.return20dPct < 0 ? 'negative' : 'neutral';
  const volatility = metrics.realizedVol20Pct === null ? 'insufficient'
    : metrics.realizedVol60Pct !== null && metrics.realizedVol20Pct > metrics.realizedVol60Pct * 1.25 ? 'rising'
      : metrics.realizedVol60Pct !== null && metrics.realizedVol20Pct < metrics.realizedVol60Pct * 0.75 ? 'falling' : 'stable';
  return { trend, momentum, volatility };
}

function transparentScore(metrics) {
  let score = 0;
  const signals = [];
  const add = (points, label) => { score += points; signals.push({ points, label }); };
  if (metrics.latestPrice !== null && metrics.sma20 !== null) add(metrics.latestPrice >= metrics.sma20 ? 12 : -12, 'Kurs relativ zum SMA 20');
  if (metrics.sma20 !== null && metrics.sma50 !== null) add(metrics.sma20 >= metrics.sma50 ? 14 : -14, 'SMA 20 relativ zum SMA 50');
  if (metrics.sma50 !== null && metrics.sma200 !== null) add(metrics.sma50 >= metrics.sma200 ? 18 : -18, 'SMA 50 relativ zum SMA 200');
  if (metrics.return20dPct !== null) add(metrics.return20dPct >= 0 ? 10 : -10, '20-Tage-Momentum');
  if (metrics.return60dPct !== null) add(metrics.return60dPct >= 0 ? 10 : -10, '60-Tage-Momentum');
  if (metrics.rsi14 !== null && metrics.rsi14 >= 70) add(-8, 'RSI zeigt ueberhitztes Momentum');
  if (metrics.rsi14 !== null && metrics.rsi14 <= 30) add(8, 'RSI zeigt stark negatives Momentum');
  return { value: Math.max(-100, Math.min(100, score)), signals };
}

function averageRange(rows) {
  return mean(rows.map(row => row.high - row.low));
}

function detectPatterns(rows, metrics) {
  if (rows.length < 3) return [];
  const patterns = [];
  const latest = rows.at(-1);
  const previous = rows.at(-2);
  const add = (id, state, label, evidence, weight = 'context') => patterns.push({ id, state, label, evidence, weight });
  const previous20 = rows.slice(-21, -1);
  if (previous20.length >= 10) {
    const priorHigh = Math.max(...previous20.map(row => row.high));
    const priorLow = Math.min(...previous20.map(row => row.low));
    if (latest.close > priorHigh) add('breakout-20', 'active', '20-Perioden-Ausbruch', `Schlusskurs ${round(latest.close, 6)} ueber vorherigem 20-Perioden-Hoch ${round(priorHigh, 6)}.`, 'signal');
    else if (latest.close < priorLow) add('breakdown-20', 'active', '20-Perioden-Durchbruch', `Schlusskurs ${round(latest.close, 6)} unter vorherigem 20-Perioden-Tief ${round(priorLow, 6)}.`, 'signal');
  }

  if (rows.length >= 40) {
    const recent = rows.slice(-20);
    const earlier = rows.slice(-40, -20);
    const recentHigh = Math.max(...recent.map(row => row.high));
    const recentLow = Math.min(...recent.map(row => row.low));
    const earlierHigh = Math.max(...earlier.map(row => row.high));
    const earlierLow = Math.min(...earlier.map(row => row.low));
    if (recentHigh > earlierHigh && recentLow > earlierLow) add('higher-highs-lows', 'active', 'Steigende Marktstruktur', `Jüngstes Hoch/Tief ${round(recentHigh, 6)}/${round(recentLow, 6)} ueber Vorperiode ${round(earlierHigh, 6)}/${round(earlierLow, 6)}.`, 'trend');
    if (recentHigh < earlierHigh && recentLow < earlierLow) add('lower-highs-lows', 'active', 'Fallende Marktstruktur', `Jüngstes Hoch/Tief ${round(recentHigh, 6)}/${round(recentLow, 6)} unter Vorperiode ${round(earlierHigh, 6)}/${round(earlierLow, 6)}.`, 'trend');
  }

  if (rows.length >= 55) {
    const closes = rows.map(row => row.close);
    const previous20Sma = sma(closes.slice(0, -5), 20);
    const previous50Sma = sma(closes.slice(0, -5), 50);
    if (previous20Sma !== null && previous50Sma !== null && metrics.sma20 !== null && metrics.sma50 !== null) {
      if (previous20Sma <= previous50Sma && metrics.sma20 > metrics.sma50) add('bullish-ma-cross', 'recent', 'Bullische SMA-Kreuzung', 'SMA 20 hat den SMA 50 innerhalb der letzten fuenf Perioden von unten gekreuzt.', 'trend');
      if (previous20Sma >= previous50Sma && metrics.sma20 < metrics.sma50) add('bearish-ma-cross', 'recent', 'Bearische SMA-Kreuzung', 'SMA 20 hat den SMA 50 innerhalb der letzten fuenf Perioden von oben gekreuzt.', 'trend');
    }
  }

  if (rows.length >= 60) {
    const shortRange = averageRange(rows.slice(-10));
    const baselineRange = averageRange(rows.slice(-60, -10));
    if (shortRange !== null && baselineRange) {
      if (shortRange < baselineRange * 0.65) add('volatility-compression', 'active', 'Volatilitaetskompression', `10-Perioden-Handelsspanne liegt bei ${round((shortRange / baselineRange) * 100)} % der vorangegangenen Basis.`, 'setup');
      if (shortRange > baselineRange * 1.5) add('volatility-expansion', 'active', 'Volatilitaetsexpansion', `10-Perioden-Handelsspanne liegt bei ${round((shortRange / baselineRange) * 100)} % der vorangegangenen Basis.`, 'risk');
    }
  }

  if (latest.volume !== null) {
    const baselineVolume = mean(rows.slice(-21, -1).map(row => row.volume).filter(Number.isFinite));
    if (baselineVolume && latest.volume > baselineVolume * 1.5) add('volume-confirmation', 'active', 'Erhoehtes Volumen', `Letztes Volumen liegt bei ${round((latest.volume / baselineVolume) * 100)} % des 20-Perioden-Durchschnitts.`, 'confirmation');
  }

  const latestRange = latest.high - latest.low;
  const previousRange = previous.high - previous.low;
  if (latest.high < previous.high && latest.low > previous.low) add('inside-bar', 'active', 'Inside Bar', `Letzte Spanne ${round(latestRange, 6)} liegt vollstaendig innerhalb der Vorperiode ${round(previousRange, 6)}.`, 'setup');
  if (latest.high > previous.high && latest.low < previous.low) add('outside-bar', 'active', 'Outside Bar', `Letzte Periode umfasst Hoch und Tief der Vorperiode; Richtung ist ohne Folgeperiode offen.`, 'setup');
  return patterns;
}

export function analyzePriceSeries(samples = [], { horizonMinutes = 1440 } = {}) {
  const rows = normalizeChartSamples(samples);
  const closes = rows.map(row => row.close);
  const latestPrice = closes.at(-1) ?? null;
  const oneYear = range(closes, 252);
  const atr14 = atr(rows, 14);
  const metrics = {
    latestPrice: round(latestPrice, 6),
    return1dPct: round(returnPct(closes, 1)),
    return5dPct: round(returnPct(closes, 5)),
    return20dPct: round(returnPct(closes, 20)),
    return60dPct: round(returnPct(closes, 60)),
    return252dPct: round(returnPct(closes, 252)),
    sma20: round(sma(closes, 20), 6),
    sma50: round(sma(closes, 50), 6),
    sma200: round(sma(closes, 200), 6),
    rsi14: round(rsi(closes, 14)),
    atr14: round(atr14, 6),
    atr14Pct: round(atr14 !== null && latestPrice ? (atr14 / latestPrice) * 100 : null),
    realizedVol20Pct: round(annualizedVolatility(closes, 20)),
    realizedVol60Pct: round(annualizedVolatility(closes, 60)),
    maxDrawdownPct: round(maxDrawdown(closes)),
    high252: round(oneYear.high, 6),
    low252: round(oneYear.low, 6),
    distanceFromHigh252Pct: round(latestPrice && oneYear.high ? ((latestPrice / oneYear.high) - 1) * 100 : null),
    averageVolume20: round(mean(rows.slice(-20).map(row => row.volume).filter(Number.isFinite)), 0),
  };
  const score = transparentScore(metrics);
  const patterns = detectPatterns(rows, metrics);
  const missing = [];
  if (rows.length < 20) missing.push('Mindestens 20 gueltige Samples fuer kurzfristige Indikatoren erforderlich.');
  if (rows.length < 60) missing.push('Mindestens 60 gueltige Samples fuer robustere Volatilitaet erforderlich.');
  if (rows.length < 200) missing.push('SMA 200 noch nicht belastbar.');
  if (rows.length < 253) missing.push('Keine vollstaendige 252-Perioden-Rendite.');
  return {
    sampleCount: rows.length,
    horizonMinutes,
    from: rows[0]?.time || null,
    to: rows.at(-1)?.time || null,
    metrics,
    state: stateFrom(metrics),
    patterns,
    levels: {
      support20: round(range(closes, 20).low, 6), resistance20: round(range(closes, 20).high, 6),
      support60: round(range(closes, 60).low, 6), resistance60: round(range(closes, 60).high, 6),
    },
    technicalScore: score,
    dataQuality: { status: missing.length ? (rows.length >= 60 ? 'partial' : 'insufficient') : 'complete', missing },
    methodology: 'Deterministische Auswertung von Saxo-OHLC-Daten: einfache Renditen, gleitende Durchschnitte, RSI(14), ATR(14), annualisierte historische Volatilitaet, maximaler Drawdown, Marktstruktur, Ausbrueche, SMA-Kreuzungen, Volatilitaetswechsel und Volumenbestaetigung. Der technische Score ist eine transparente Zustandsverdichtung, keine Kauf- oder Verkaufsempfehlung.',
  };
}
