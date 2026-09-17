// Durable admission control for paid model calls. A reservation is an upper
// bound supplied by a caller with an enforced request/output limit, not a quote.
// Unknown outcomes stay reserved until reconciled against real provider usage.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ceilMicros = value => Math.ceil(value - Math.max(1, Math.abs(value)) * Number.EPSILON * 4);
const money = value => ceilMicros(value * 1e6);
const euros = value => value / 1e6;
const fault = (code, message) => Object.assign(new Error(message), { code });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const monthKey = date => date.toISOString().slice(0, 7);

export function normalizeModelUsage(usage) {
  const inputTokens = usage?.inputTokens ?? usage?.promptTokens;
  const outputTokens = usage?.outputTokens ?? usage?.completionTokens;
  if (![inputTokens, outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw fault('budget_usage_unknown', 'Modellverbrauch fehlt oder ist ungueltig; Abrechnung muss geklaert werden.');
  }
  return { inputTokens, outputTokens };
}

export function priceModelUsage(usage, pricing) {
  if (!pricing || ![pricing.eurPerMTokIn, pricing.eurPerMTokOut].every(nonnegative)) {
    throw fault('budget_pricing_unknown', 'Keine bestaetigte EUR-Preisobergrenze fuer dieses Modell.');
  }
  const counts = normalizeModelUsage(usage);
  const micros = ceilMicros(counts.inputTokens * pricing.eurPerMTokIn + counts.outputTokens * pricing.eurPerMTokOut);
  if (!Number.isSafeInteger(micros)) throw fault('budget_usage_unknown', 'Modellverbrauch ausserhalb des unterstuetzten Bereichs.');
  return { ...counts, eur: euros(micros) };
}

function validateLedger(ledger) {
  if (!object(ledger) || !object(ledger.months) || (ledger.version != null && ledger.version !== 2)) throw new Error('ledger');
  for (const [key, month] of Object.entries(ledger.months)) {
    if (!/^\d{4}-\d{2}$/.test(key) || !object(month) || !object(month.byModel) || !object(month.byTask)) throw new Error('month');
    for (const map of [month.byModel, month.byTask]) for (const item of Object.values(map)) {
      if (!object(item) || !['tokensIn', 'tokensOut', 'eur', 'calls'].every(key => nonnegative(item[key])) ||
          !Number.isSafeInteger(money(item.eur)) || !['tokensIn', 'tokensOut', 'calls'].every(key => Number.isSafeInteger(item[key]))) throw new Error('usage');
    }
  }
  ledger.reservations ??= {};
  ledger.closed ??= {};
  ledger.accounting ??= {
    basis: 'conservative-eur-upper-bound',
    legacyTotalsUnverified: Object.values(ledger.months).some(month => Object.values(month.byModel).some(value => value.calls > 0 || value.eur > 0)),
    migratedAt: new Date().toISOString(),
  };
  if (!object(ledger.accounting) || typeof ledger.accounting.legacyTotalsUnverified !== 'boolean') throw new Error('accounting');
  if (!object(ledger.reservations) || !object(ledger.closed)) throw new Error('reservations');
  for (const reservation of Object.values(ledger.reservations)) {
    if (!object(reservation) || !Number.isSafeInteger(reservation.micros) || reservation.micros < 0 ||
        !['reserved', 'dispatched', 'uncertain'].includes(reservation.status) || typeof reservation.key !== 'string' ||
        typeof reservation.task !== 'string' || !/^\d{4}-\d{2}$/.test(reservation.monthKey)) throw new Error('reservation');
  }
  ledger.version = 2;
  return ledger;
}

export function createModelBudget({ file, monthlyLimitEUR = 30, warnAtEUR = 24, pricingFor, now = () => new Date(), onWarn = () => {}, lockWaitMs = 3000 } = {}) {
  if (!file || typeof pricingFor !== 'function' || !nonnegative(monthlyLimitEUR) || !nonnegative(warnAtEUR)) throw fault('budget_config_invalid', 'Budget-Konfiguration ungueltig.');
  // A stale/high environment value cannot silently exceed the approved limit.
  const limitMicros = money(Math.min(30, monthlyLimitEUR));
  const warnMicros = money(Math.min(24, warnAtEUR, euros(limitMicros)));
  const lock = `${file}.lock`;
  const initialized = `${file}.initialized`;
  let queue = Promise.resolve();

  async function transaction(action, { write = true } = {}) {
    const pending = queue.then(async () => {
      let acquired = false;
      const until = Date.now() + lockWaitMs;
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        while (!acquired) {
          try { await fs.mkdir(lock, { mode: 0o700 }); acquired = true; }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            if (Date.now() >= until) throw fault('budget_storage_locked', 'Budgetdatei gesperrt; gegebenenfalls unterbrochenen Vorgang pruefen.');
            await new Promise(resolve => setTimeout(resolve, 15));
          }
        }
        let ledger;
        try { ledger = validateLedger(JSON.parse(await fs.readFile(file, 'utf8'))); }
        catch (error) {
          if (error.code !== 'ENOENT') throw fault('budget_storage_invalid', 'Budgetdatei unlesbar oder beschaedigt; neue Modellaufrufe sind gesperrt.');
          try {
            await fs.access(initialized);
            throw fault('budget_storage_invalid', 'Bereits initialisierte Budgetdatei fehlt; Verbrauch darf nicht auf null gesetzt werden.');
          } catch (markerError) { if (markerError.code !== 'ENOENT') throw markerError; }
          ledger = { version: 2, months: {}, reservations: {}, closed: {}, accounting: { basis: 'conservative-eur-upper-bound', legacyTotalsUnverified: false, startedAt: now().toISOString() } };
        }
        const outcome = await action(ledger);
        if (write) {
          const temporary = `${file}.${randomUUID()}.tmp`;
          try {
            const handle = await fs.open(temporary, 'wx', 0o600);
            try { await handle.writeFile(JSON.stringify(ledger, null, 2)); await handle.sync(); }
            finally { await handle.close(); }
            await fs.rename(temporary, file);
            // A separately durable marker distinguishes first use from deletion
            // of a previously populated ledger, including after a restart.
            try {
              const marker = await fs.open(initialized, 'wx', 0o600);
              try { await marker.writeFile('IVA model budget v2\n'); await marker.sync(); }
              finally { await marker.close(); }
            } catch (error) { if (error.code !== 'EEXIST') throw error; }
            const directory = await fs.open(path.dirname(file), 'r');
            try { await directory.sync(); } finally { await directory.close(); }
          } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
        }
        if (outcome?.error) throw outcome.error;
        return outcome?.value;
      } catch (error) {
        if (String(error?.code).startsWith('budget_')) throw error;
        throw fault('budget_storage_unavailable', 'Budget konnte nicht sicher gelesen oder gespeichert werden; Modellaufruf gestoppt.');
      } finally {
        if (acquired) await fs.rmdir(lock);
      }
    });
    queue = pending.catch(() => {});
    return pending;
  }

  function snapshot(ledger, mk = monthKey(now())) {
    const month = ledger.months[mk];
    const spent = Object.values(month?.byModel || {}).reduce((sum, value) => sum + money(value.eur), 0);
    // Outstanding reservations also cross a month boundary conservatively.
    const reservations = Object.entries(ledger.reservations).map(([id, entry]) => ({ id, ...entry, eur: euros(entry.micros) }));
    const reserved = reservations.reduce((sum, entry) => sum + entry.micros, 0);
    if (!Number.isSafeInteger(spent) || !Number.isSafeInteger(reserved)) throw fault('budget_storage_invalid', 'Budgetsumme ausserhalb des unterstuetzten Bereichs.');
    const unresolved = reservations.some(entry => entry.status === 'uncertain' && (entry.reason !== 'budget_outcome_unknown' || entry.micros <= 0));
    return { monthKey: mk, totalEUR: euros(spent), reservedEUR: euros(reserved), availableEUR: euros(Math.max(0, limitMicros - spent - reserved)), monthlyLimitEUR: euros(limitMicros), warnAtEUR: euros(warnMicros), accounting: ledger.accounting, unresolved, reservations, byModel: month?.byModel || {}, byTask: month?.byTask || {} };
  }

  function ensureAvailable(ledger, additional = 0) {
    const state = snapshot(ledger);
    if (state.unresolved) throw fault('budget_unreconciled', 'Ungeklaerter Modellverbrauch: neue kostenpflichtige Aufrufe sind bis zur Klaerung gesperrt.');
    if (money(state.totalEUR) + money(state.reservedEUR) + additional > limitMicros || (!additional && state.availableEUR === 0)) {
      throw fault('budget_exceeded', `IVA-Monatsbudget von ${euros(limitMicros)} EUR erreicht oder fuer diesen Aufruf nicht ausreichend.`);
    }
  }

  function charge(ledger, routed, usage, pricing, mk) {
    const counts = priceModelUsage(usage, pricing);
    const month = ledger.months[mk] ||= { byModel: {}, byTask: {} };
    for (const [map, key] of [[month.byModel, routed.key], [month.byTask, routed.task]]) {
      const item = map[key] ||= { tokensIn: 0, tokensOut: 0, eur: 0, calls: 0 };
      item.tokensIn += counts.inputTokens; item.tokensOut += counts.outputTokens;
      item.eur = euros(money(item.eur) + money(counts.eur)); item.calls++;
    }
    const totalEUR = snapshot(ledger, mk).totalEUR;
    if (money(totalEUR) >= warnMicros && !month._warnedAt) {
      month._warnedAt = now().toISOString();
      // Notify only after the transaction commits (outside this function).
      return { ...counts, warning: { monthKey: mk, totalEUR, warnAtEUR: euros(warnMicros) } };
    }
    return counts;
  }

  async function notify(promise) {
    const result = await promise;
    if (result?.warning) {
      try { onWarn(result.warning); } catch { /* committed usage stays authoritative */ }
    }
    return result;
  }

  function uncertain(ledger, id, error) {
    ledger.reservations[id].status = 'uncertain';
    ledger.reservations[id].reason = error.code;
    return { error };
  }

  const api = {
    limits: { monthly: euros(limitMicros), warnAt: euros(warnMicros) },
    currentSpend: mk => transaction(ledger => ({ value: snapshot(ledger, mk) }), { write: false }),
    check: () => transaction(ledger => { ensureAvailable(ledger); return {}; }),
    reserve: (routed, upperBoundEUR) => transaction(ledger => {
      if (typeof routed?.key !== 'string' || !routed.key || typeof routed?.task !== 'string' || !routed.task) throw fault('budget_bound_invalid', 'Modell und Aufgabenprofil fehlen.');
      const pricing = pricingFor(routed);
      priceModelUsage({ inputTokens: 0, outputTokens: 0 }, pricing);
      if (!nonnegative(upperBoundEUR) || !Number.isSafeInteger(money(upperBoundEUR)) || upperBoundEUR <= 0) throw fault('budget_bound_invalid', 'Ein positiver, begrenzter Hoechstbetrag ist vor dem Modellaufruf erforderlich.');
      ensureAvailable(ledger, money(upperBoundEUR));
      const id = randomUUID();
      ledger.reservations[id] = { key: routed.key, task: routed.task, monthKey: monthKey(now()), micros: money(upperBoundEUR), pricing, status: 'reserved', createdAt: now().toISOString() };
      return { value: id };
    }),
    markDispatched: id => transaction(ledger => {
      const entry = ledger.reservations[id];
      if (!entry || entry.status !== 'reserved') throw fault('budget_reservation_invalid', 'Budgetreservierung ist nicht versandbereit.');
      const currentPrice = pricingFor(entry);
      if (currentPrice.eurPerMTokIn > entry.pricing.eurPerMTokIn || currentPrice.eurPerMTokOut > entry.pricing.eurPerMTokOut) throw fault('budget_pricing_changed', 'Preisobergrenze hat sich seit der Reservierung erhoeht; neue Reservierung erforderlich.');
      entry.status = 'dispatched'; entry.dispatchedAt = now().toISOString();
      return {};
    }),
    settle: (id, usage) => notify(transaction(ledger => {
      if (ledger.closed[id]) {
        if (ledger.closed[id].status !== 'settled') throw fault('budget_reservation_invalid', 'Bereits freigegebene Reservierung kann nicht als abgerechnet bestaetigt werden.');
        return { value: ledger.closed[id] };
      }
      const entry = ledger.reservations[id];
      if (!entry) throw fault('budget_reservation_invalid', 'Budgetreservierung nicht gefunden.');
      let counts;
      try { counts = charge(ledger, entry, usage, entry.pricing, entry.monthKey); }
      catch (error) { return uncertain(ledger, id, error); }
      delete ledger.reservations[id];
      const result = { ...counts, status: 'settled', settledAt: now().toISOString(), exceededReservation: money(counts.eur) > entry.micros };
      ledger.closed[id] = result;
      if (result.exceededReservation) {
        // Never hide a provider charge above the caller's declared bound.
        ledger.reservations[id] = { ...entry, micros: 0, status: 'uncertain', reason: 'budget_bound_exceeded' };
        return { error: fault('budget_bound_exceeded', 'Tatsaechlicher Verbrauch ueber Reservierung; weitere Aufrufe bis zur Klaerung gesperrt.') };
      }
      return { value: result };
    })),
    release: (id, { confirmedNotSent = false } = {}) => transaction(ledger => {
      if (ledger.closed[id]) return { value: ledger.closed[id] };
      const entry = ledger.reservations[id];
      if (!entry) throw fault('budget_reservation_invalid', 'Budgetreservierung nicht gefunden.');
      if (entry.status !== 'reserved' && !confirmedNotSent) {
        // A verified positive upper bound remains budget-consuming without
        // freezing the unused balance after a network timeout. Invalid usage or
        // an exceeded bound continues to block globally until reconciliation.
        if (entry.status !== 'uncertain') {
          entry.status = 'uncertain'; entry.reason = 'budget_outcome_unknown';
        }
        return { error: fault('budget_usage_unknown', 'Versand erfolgt oder unklar: Reservierung bleibt bis zur Verbrauchsklaerung erhalten.') };
      }
      delete ledger.reservations[id];
      const result = { status: 'released', releasedAt: now().toISOString() };
      ledger.closed[id] = result;
      return { value: result };
    }),
    // Compatibility accounting for callers which have not migrated. It records
    // real charges but cannot retroactively provide admission control.
    record: (routed, usage) => notify(transaction(ledger => {
      try { return { value: charge(ledger, routed, usage, pricingFor(routed), monthKey(now())) }; }
      catch (error) {
        const id = randomUUID();
        ledger.reservations[id] = { key: routed.key, task: routed.task, monthKey: monthKey(now()), micros: 0, status: 'uncertain', reason: error.code, createdAt: now().toISOString() };
        return { error };
      }
    })),
  };
  return api;
}
