import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const queues = new Map();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const copy = value => JSON.parse(JSON.stringify(value));
const money = value => Math.round((value + Number.EPSILON) * 100) / 100;
const defaults = () => ({
  version: 1, revision: 0,
  config: { enabled: false, mode: 'observe', currency: 'EUR', pollIntervalSeconds: 30, maxQuoteAgeSeconds: 90,
    monthlyDepositLimit: null, capitalLimit: null, maxOrderValue: null, maxPositionValue: null, maxDailyLoss: null, maxDrawdownPct: null, feePerOrder: null, slippageBps: null },
  rules: [], quotes: [], connection: { status: 'disabled', lastSuccessAt: null, lastAttemptAt: null, error: null, retryAt: null },
  paper: { cash: 0, contributed: 0, realizedProfitLoss: 0, feesPaid: 0, positions: [], orders: [], monthlyDeposits: {}, day: null, dayStartEquity: 0, highWaterMark: 0, lastEquity: 0 }, journal: [],
});
const dayKey = time => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));
const quotePrice = quote => quote?.bid > 0 ? quote.bid : quote?.mid > 0 ? quote.mid : quote?.last > 0 ? quote.last : null;

export function assessInvestmentQuote(quote, config, timestamp = Date.now()) {
  const at = Date.parse(quote?.updatedAt), received = Date.parse(quote?.receivedAt);
  const ageSeconds = Number.isFinite(at) ? Math.max(0, (timestamp - at) / 1000) : null;
  const receiptAgeSeconds = Number.isFinite(received) ? Math.max(0, (timestamp - received) / 1000) : null;
  const reasons = [];
  if (!quote) reasons.push('Kein Kurs verfügbar.');
  if (quote?.errorCode && quote.errorCode !== 'None') reasons.push('Saxo-Kursstatus: ' + quote.errorCode);
  if (ageSeconds === null) reasons.push('Saxo-Kurszeitpunkt fehlt.');
  else if (ageSeconds > config.maxQuoteAgeSeconds || at > timestamp + 5000) reasons.push('Kurszeitpunkt ist zu alt oder ungültig.');
  if (receiptAgeSeconds === null || receiptAgeSeconds > config.maxQuoteAgeSeconds || received > timestamp + 5000) reasons.push('Kein aktueller Abruf bestätigt.');
  if (quote?.delayedByMinutes !== 0) reasons.push(quote?.delayedByMinutes > 0 ? `Kurs ist ${quote.delayedByMinutes} Minuten verzögert.` : 'Marktdatenverzögerung ist unbekannt.');
  if (quote?.marketOpen !== true) reasons.push('Geöffneter Markt nicht bestätigt.');
  if (!(quote?.bid > 0 && quote?.ask > 0 && quote.ask >= quote.bid)) reasons.push('Gültiger Geld-/Briefkurs fehlt.');
  if ([quote?.priceTypeBid, quote?.priceTypeAsk].some(value => !['Indicative', 'Tradable'].includes(value))) reasons.push('Verwendbarer Saxo-Preistyp fehlt.');
  return { ageSeconds, receiptAgeSeconds, usable: reasons.length === 0, status: reasons.length ? 'unavailable' : 'current', reasons };
}

export function createInvestmentMonitor({ dataDir, saxo, store, now = () => Date.now(), autoStart = true } = {}) {
  const file = path.join(dataDir, 'investment-monitor.json');
  let running = null, timer = null, stopped = false;
  async function load() {
    try {
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw fail('Investment-Monitor-Speicher ist ungültig.'); return JSON.parse(await handle.readFile('utf8')); }
      finally { await handle.close(); }
    } catch (error) { if (error.code === 'ENOENT') return defaults(); throw error; }
  }
  async function mutate(fn) {
    const previous = queues.get(file) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const data = await load();
      const result = await fn(data);
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
      const temporary = file + '.' + randomUUID() + '.tmp';
      await fs.writeFile(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
      return copy(result);
    });
    queues.set(file, pending);
    try { return await pending; } finally { if (queues.get(file) === pending) queues.delete(file); }
  }
  function event(data, type, message, detail = {}) {
    const value = { id: randomUUID(), createdAt: new Date(now()).toISOString(), type, message: String(message).slice(0, 1600), ...detail };
    data.journal.push(value);
    data.journal = data.journal.slice(-1000);
    return value;
  }
  function configuration(input, current) {
    const allowed = new Set(Object.keys(defaults().config));
    for (const name of Object.keys(input)) if (!allowed.has(name)) throw fail('Unbekannte Monitor-Einstellung: ' + name);
    const value = { ...current };
    for (const [name, item] of Object.entries(input)) {
      if (name === 'enabled') { if (typeof item !== 'boolean') throw fail('Aktivierung muss ausdrücklich gewählt werden.'); value.enabled = item; }
      else if (name === 'mode') { if (!['observe', 'paper'].includes(item)) throw fail('Nur Beobachten oder lokaler Paper-Handel sind verfügbar.'); value.mode = item; }
      else if (name === 'currency') { if (!/^[A-Z]{3}$/.test(item)) throw fail('Währung als dreistelliges Kürzel angeben.'); value.currency = item; }
      else if (['pollIntervalSeconds', 'maxQuoteAgeSeconds'].includes(name)) { if (!Number.isInteger(item) || item < (name === 'pollIntervalSeconds' ? 15 : 5) || item > 300) throw fail('Abfrageintervall: 15–300 Sekunden; Kursalter: 5–300 Sekunden.'); value[name] = item; }
      else { if (item !== null && (typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 10_000_000)) throw fail('Kapital- und Risikogrenzen müssen gültige Zahlen sein.'); value[name] = item; }
    }
    if (value.maxDrawdownPct !== null && !(value.maxDrawdownPct > 0 && value.maxDrawdownPct <= 100)) throw fail('Drawdown-Grenze muss über 0 und höchstens 100 Prozent liegen.');
    if (value.slippageBps !== null && value.slippageBps > 1000) throw fail('Für die Simulation höchstens 1000 Basispunkte Slippage angeben.');
    if (value.enabled && value.mode === 'paper') for (const name of ['monthlyDepositLimit', 'capitalLimit', 'maxOrderValue', 'maxPositionValue', 'maxDailyLoss', 'maxDrawdownPct', 'feePerOrder', 'slippageBps']) {
      if (value[name] === null || !['feePerOrder', 'slippageBps'].includes(name) && value[name] <= 0) throw fail('Vor dem Paper-Handel alle Kapital-, Verlust- und Kostenannahmen festlegen.');
    }
    return value;
  }
  function valuation(data) {
    let equity = data.paper.cash;
    let current = data.paper.positions.length === 0 || data.connection.status === 'connected';
    for (const position of data.paper.positions) {
      const quote = data.quotes.find(item => item.key === position.key);
      const assessment = assessInvestmentQuote(quote, data.config, now());
      if (!assessment.usable || !quotePrice(quote)) current = false;
      equity += position.amount * (quotePrice(quote) || position.averagePrice);
    }
    return { equity: money(equity), current };
  }
  function risk(data, update = false) {
    const mark = valuation(data), day = dayKey(now());
    if (update && mark.current) {
      if (data.paper.day !== day) { data.paper.day = day; data.paper.dayStartEquity = data.paper.lastEquity || mark.equity; }
      data.paper.highWaterMark = Math.max(data.paper.highWaterMark, mark.equity);
      data.paper.lastEquity = mark.equity;
    }
    const dailyLoss = data.paper.day === day ? Math.max(0, data.paper.dayStartEquity - mark.equity) : 0;
    const drawdownPct = data.paper.highWaterMark > 0 ? Math.max(0, (1 - mark.equity / data.paper.highWaterMark) * 100) : 0;
    const reasons = [];
    if (!mark.current) reasons.push('Mindestens eine Paper-Position hat keinen aktuellen, verwendbaren Saxo-Kurs.');
    if (data.config.maxDailyLoss !== null && dailyLoss >= data.config.maxDailyLoss) reasons.push('Paper-Tagesverlustgrenze erreicht.');
    if (data.config.maxDrawdownPct !== null && drawdownPct >= data.config.maxDrawdownPct) reasons.push('Paper-Drawdown-Grenze erreicht.');
    return { ...mark, dailyLoss: money(dailyLoss), drawdownPct: Math.round(drawdownPct * 100) / 100, halted: reasons.length > 0, reasons };
  }
  function publicState(data) {
    const timestamp = now();
    const last = Date.parse(data.connection.lastSuccessAt);
    const connection = { ...data.connection };
    if (!data.config.enabled) connection.status = 'disabled';
    else if (connection.status === 'connected' && (!Number.isFinite(last) || timestamp - last > data.config.maxQuoteAgeSeconds * 1000)) connection.status = 'stale';
    const reviewed = new Set(data.journal.filter(item => item.type === 'review').map(item => item.reviewOf));
    const paperRisk = risk(data);
    return { revision: data.revision, config: data.config, rules: data.rules, connection,
      quotes: data.quotes.map(quote => { const assessment = assessInvestmentQuote(quote, data.config, timestamp); if (connection.status !== 'connected') { assessment.usable = false; assessment.status = 'unavailable'; assessment.reasons.push('Die Verbindung ist nicht als aktuell bestätigt.'); } return { ...quote, ...assessment }; }),
      paper: { ...data.paper, orders: data.paper.orders.slice(-100), ...paperRisk, netProfitLoss: money(paperRisk.equity - data.paper.contributed) },
      journal: data.journal.slice(-100).reverse(), learning: { events: data.journal.length, errors: data.journal.filter(item => ['connection-error', 'rule-blocked'].includes(item.type)).length, reviewed: reviewed.size, principle: 'Reviews dokumentieren Fehler und Verbesserungen. Sie verändern weder Limits noch Regeln automatisch.' },
      liveOrderExecutionEnabled: false, depositsEnabled: false, streamingConnected: false, transport: 'REST-Polling',
      assumptions: 'Paper-Fills verwenden Geld-/Briefkurse mit deinen Kostenannahmen. Keine Börsenfills, Liquiditätsgarantie oder Renditeprognose. Reale Einzahlungen werden nicht ausgeführt oder automatisch gegen dieses lokale Limit abgeglichen.' };
  }
  async function status() { await queues.get(file)?.catch(() => {}); return publicState(await load()); }
  async function configure({ baseRevision, config, rules } = {}, { actor = 'owner' } = {}) {
    if (actor !== 'owner') throw fail('Automatische Regeln dürfen die Grenzen nicht verändern.', 403);
    const watchlist = await store.listWatchlist();
    return mutate(data => {
      if (baseRevision !== data.revision) throw fail('Einstellungen wurden geändert. Bitte neu laden.', 409);
      const next = configuration(config || {}, data.config);
      if (next.currency !== data.config.currency && data.paper.contributed > 0) throw fail('Die Währung des bereits finanzierten Paper-Depots kann nicht umgestellt werden.');
      if (rules !== undefined) {
        if (!Array.isArray(rules) || rules.length > 20) throw fail('Höchstens 20 Regeln anlegen.');
        const ids = new Set();
        data.rules = rules.map(input => {
          if (!input || typeof input !== 'object') throw fail('Regel muss ein gültiger Eintrag sein.');
          if (input.id) { if (ids.has(input.id)) throw fail('Eine vorhandene Regel darf nicht doppelt übergeben werden.'); ids.add(input.id); }
          const item = watchlist.find(value => value.key === input.key);
          if (!item || !['at-or-below', 'at-or-above'].includes(input.condition) || !['alert', 'paper-buy', 'paper-sell'].includes(input.action) || !(typeof input.price === 'number' && input.price > 0 && Number.isFinite(input.price))) throw fail('Regel benötigt einen Watchlist-Wert, Bedingung und gültigen Kurs.');
          if (input.action !== 'alert' && (!['Stock', 'Etf'].includes(item.assetType) || !Number.isSafeInteger(input.amount) || input.amount <= 0 || input.amount > 1_000_000)) throw fail('Paper-Regeln unterstützen ganze, positive Aktien-/ETF-Stückzahlen ohne Hebel.');
          const existing = data.rules.find(rule => rule.id === input.id);
          return { id: existing?.id || randomUUID(), key: item.key, instrument: { uic: item.uic, assetType: item.assetType, currency: item.currency, symbol: item.symbol }, condition: input.condition, price: input.price, action: input.action, amount: input.action === 'alert' ? 0 : input.amount, enabled: input.enabled === true, triggeredAt: existing?.triggeredAt || null };
        });
      }
      data.config = next; data.revision++;
      event(data, 'configuration', 'Monitor-Einstellungen wurden durch den Admin gespeichert.', { revision: data.revision, config: copy(next) });
      return publicState(data);
    });
  }
  async function deposit({ amount } = {}) {
    return mutate(data => {
      if (!(typeof amount === 'number' && Number.isFinite(amount) && amount > 0)) throw fail('Gültigen virtuellen Betrag angeben.');
      amount = money(amount);
      if (!amount || !data.config.monthlyDepositLimit || !data.config.capitalLimit) throw fail('Zuerst Monats- und Kapitalgrenze festlegen.');
      const month = dayKey(now()).slice(0, 7), used = data.paper.monthlyDeposits[month] || 0;
      if (used + amount > data.config.monthlyDepositLimit || data.paper.contributed + amount > data.config.capitalLimit) throw fail('Virtuelle Einzahlung überschreitet Monats- oder Kapitalgrenze.');
      risk(data, true);
      data.paper.cash = money(data.paper.cash + amount); data.paper.contributed = money(data.paper.contributed + amount);
      data.paper.monthlyDeposits[month] = money(used + amount);
      data.paper.dayStartEquity = money(data.paper.dayStartEquity + amount); data.paper.highWaterMark = money(data.paper.highWaterMark + amount); data.paper.lastEquity = money(data.paper.lastEquity + amount);
      event(data, 'paper-deposit', 'Virtuelles Paper-Kapital eingebucht. Es wurde kein Geld an Saxo überwiesen.', { amount, currency: data.config.currency });
      return publicState(data);
    });
  }
  function fill(data, rule, quote) {
    const assessment = assessInvestmentQuote(quote, data.config, now()), currentRisk = risk(data, true);
    if (!assessment.usable) throw fail(assessment.reasons.join(' '));
    if (!data.config.enabled || data.config.mode !== 'paper') throw fail('Paper-Modus ist nicht aktiv.');
    if (quote.currency !== data.config.currency || rule.instrument.currency !== data.config.currency) throw fail('Paper-Handel unterstützt nur Instrumente in der festgelegten Depotwährung; keine geschätzte Währungsumrechnung.');
    const buy = rule.action === 'paper-buy';
    if (buy && currentRisk.halted) throw fail(currentRisk.reasons.join(' '));
    const price = (buy ? quote.ask : quote.bid) * (1 + (buy ? 1 : -1) * data.config.slippageBps / 10000);
    const value = money(price * rule.amount), fee = data.config.feePerOrder;
    if (!Number.isFinite(value) || !(value > 0) || value > data.config.maxOrderValue) throw fail('Paper-Order überschreitet die Einzelordergrenze.');
    let position = data.paper.positions.find(item => item.key === rule.key);
    if (buy) {
      if (data.paper.cash < value + fee) throw fail('Nicht genug virtuelles Guthaben; keine Margin.');
      if ((position?.amount || 0) * price + value > data.config.maxPositionValue) throw fail('Paper-Position überschreitet die Positionsgrenze.');
      if (data.config.maxDailyLoss !== null && currentRisk.dailyLoss + fee + Math.max(0, price - quote.bid) * rule.amount >= data.config.maxDailyLoss) throw fail('Paper-Order würde die Tagesverlustgrenze bereits durch Spread/Kosten erreichen.');
      const projectedEquity = currentRisk.equity - fee - Math.max(0, price - quote.bid) * rule.amount;
      if (data.paper.highWaterMark > 0 && (1 - projectedEquity / data.paper.highWaterMark) * 100 >= data.config.maxDrawdownPct) throw fail('Paper-Order würde die Drawdown-Grenze bereits durch Spread/Kosten erreichen.');
      if (!position) { position = { key: rule.key, amount: 0, averagePrice: 0, symbol: quote.symbol }; data.paper.positions.push(position); }
      position.averagePrice = (position.averagePrice * position.amount + value + fee) / (position.amount + rule.amount);
      position.amount += rule.amount; data.paper.cash = money(data.paper.cash - value - fee);
    } else {
      if (!position || position.amount < rule.amount) throw fail('Keine ausreichende Paper-Position; Leerverkauf ist gesperrt.');
      if (data.paper.cash + value < fee) throw fail('Verkaufsgebühr überschreitet Erlös und virtuelles Guthaben; keine Margin.');
      data.paper.realizedProfitLoss = money(data.paper.realizedProfitLoss + value - fee - position.averagePrice * rule.amount);
      position.amount -= rule.amount; data.paper.cash = money(data.paper.cash + value - fee);
      data.paper.positions = data.paper.positions.filter(item => item.amount > 0);
    }
    data.paper.feesPaid = money(data.paper.feesPaid + fee);
    const order = { id: randomUUID(), ruleId: rule.id, key: rule.key, direction: buy ? 'Buy' : 'Sell', amount: rule.amount, price, value, fee, quoteUpdatedAt: quote.updatedAt, source: quote.source, environment: quote.environment, createdAt: new Date(now()).toISOString(), execution: 'local-paper-only' };
    data.paper.orders.push(order); data.paper.orders = data.paper.orders.slice(-1000);
    event(data, 'paper-fill', 'Lokale Paper-Regel simuliert; keine Saxo-Order gesendet.', { order });
    risk(data, true);
  }
  async function poll({ manual = false } = {}) {
    if (running) return running;
    running = (async () => {
      const start = await load();
      if (!start.config.enabled) return publicState(start);
      if (Date.parse(start.connection.retryAt) > now()) return publicState(start);
      if (!manual && now() - Date.parse(start.connection.lastAttemptAt) < start.config.pollIntervalSeconds * 1000) return publicState(start);
      const attemptedAt = new Date(now()).toISOString();
      try {
        const connection = await saxo.status({ probe: false });
        const watchlist = (await store.listWatchlist()).slice(0, 20);
        if (!connection.ready) throw fail('Saxo ist nicht verbunden oder die Sitzung ist abgelaufen.');
        if (!watchlist.length) return mutate(data => {
          data.connection = { ...data.connection, status: 'waiting', lastAttemptAt: attemptedAt, error: 'Zuerst Instrumente zur Watchlist hinzufügen. Noch keine Kursverbindung geprüft.', retryAt: null };
          return publicState(data);
        });
        const quotes = await saxo.quotes(watchlist);
        return await mutate(data => {
          if (!data.config.enabled) return publicState(data);
          data.quotes = quotes;
          data.connection = { status: 'connected', lastAttemptAt: attemptedAt, lastSuccessAt: new Date(now()).toISOString(), error: null, retryAt: null, environment: connection.environment };
          risk(data, true);
          // A settings change during the network call invalidates this decision
          // cycle. Quotes remain visible, but new rules wait for another sample.
          if (data.revision === start.revision) for (const rule of data.rules) {
            if (!rule.enabled || rule.triggeredAt) continue;
            const quote = quotes.find(item => item.key === rule.key), price = quotePrice(quote);
            if (!price || !(rule.condition === 'at-or-below' ? price <= rule.price : price >= rule.price)) continue;
            try {
              const assessment = assessInvestmentQuote(quote, data.config, now());
              if (!assessment.usable) throw fail(assessment.reasons.join(' '));
              if (rule.action === 'alert') event(data, 'price-alert', 'Deine Kursbedingung wurde erreicht.', { key: rule.key, ruleId: rule.id, price, quoteUpdatedAt: quote.updatedAt });
              else fill(data, rule, quote);
              rule.triggeredAt = new Date(now()).toISOString();
              rule.lastBlocked = null;
            } catch (error) {
              const reason = String(error.message).slice(0, 1000);
              if (rule.lastBlocked !== reason) event(data, 'rule-blocked', reason, { key: rule.key, ruleId: rule.id });
              rule.lastBlocked = reason;
            }
          }
          return publicState(data);
        });
      } catch (error) {
        return mutate(data => {
          const message = error.providerStatus ? `Saxo-Verbindung nicht verfügbar (HTTP ${error.providerStatus}).` : 'Saxo-Kurse konnten nicht bestätigt werden. Verbindung und Marktdatenrechte prüfen.';
          if (data.connection.error !== message) event(data, 'connection-error', message);
          data.connection = { ...data.connection, status: 'disconnected', error: message, lastAttemptAt: attemptedAt, retryAt: new Date(now() + Math.max(15, Math.min(error.retryAfterSeconds || 30, 3600)) * 1000).toISOString() };
          return publicState(data);
        });
      }
    })();
    try { return await running; } finally { running = null; }
  }
  async function review(id, { lesson } = {}) {
    if (typeof lesson !== 'string' || lesson.trim().length < 5 || lesson.length > 3000) throw fail('Eine nachvollziehbare Erkenntnis mit 5–3000 Zeichen angeben.');
    return mutate(data => {
      if (!data.journal.some(item => item.id === id)) throw fail('Journal-Eintrag nicht gefunden.', 404);
      event(data, 'review', lesson.trim(), { reviewOf: id });
      return publicState(data);
    });
  }
  async function pause() {
    return mutate(data => {
      data.config.enabled = false; data.revision++;
      data.connection = { ...data.connection, status: 'disabled', error: null, retryAt: null };
      event(data, 'paused', 'Saxo-Verbindung getrennt; Kursmonitor und Paper-Regeln sind ausgeschaltet.');
      return publicState(data);
    });
  }
  async function tick() { if (stopped) return; try { await poll(); } catch {} finally { if (!stopped) { timer = setTimeout(tick, 15_000); timer.unref?.(); } } }
  if (autoStart) { timer = setTimeout(tick, 1000); timer.unref?.(); }
  return { status, configure, deposit, poll, review, pause, close() { stopped = true; clearTimeout(timer); } };
}
