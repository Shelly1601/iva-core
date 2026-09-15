// Shared browser/server scenario calculations. Money inputs are EUR; rates are percent.
export const ADVICE_CALCULATION_VERSION = 'iva-advice-scenarios-2';

export function parseAdviceNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  let text = value.trim().replace(/\s/g, '');
  if (!text || !/^[+-]?(?:\d+(?:[.,]\d+)?|\d{1,3}(?:\.\d{3})+(?:,\d+)?)$/.test(text)) return null;
  if (text.includes(',')) text = text.replace(/\./g, '').replace(',', '.');
  else if (/^[+-]?\d{1,3}(?:\.\d{3})+$/.test(text)) text = text.replace(/\./g, '');
  const result = Number(text);
  return Number.isFinite(result) ? result : null;
}

const euro = value => value === null ? 'Noch offen' : new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(value);
const percentage = value => value === null ? '–' : new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 }).format(value) + ' %';
const present = value => value !== undefined && value !== null && value !== '';

function reader(data) {
  const issues = [];
  return { issues, get(key, label, { min = 0, max = 1e12, optional = false, integer = false } = {}) {
    const value = present(data[key]) ? parseAdviceNumber(data[key]) : optional ? 0 : null;
    if (value === null || value < min || value > max || (integer && !Number.isInteger(value))) {
      issues.push({ field: key, label, reason: value === null ? 'Wert fehlt oder ist ungültig.' : `Wert muss zwischen ${min} und ${max}${integer ? ' und ganzzahlig' : ''} liegen.` });
      return 0;
    }
    return value;
  } };
}

function monthsFor(years, issues) {
  const months = Math.round(years * 12);
  if (Math.abs(years * 12 - months) > 1e-7) issues.push({ field: 'years', label: 'Laufzeit', reason: 'Bitte eine Laufzeit in ganzen Monaten verwenden.' });
  return months;
}

// Effective annual return, end-of-month contributions; stable near a zero rate.
export function adviceFutureValue(initial, monthly, annualRate, months) {
  if (![initial, monthly, annualRate, months].every(Number.isFinite) || initial < 0 || monthly < 0 || annualRate <= -100 || annualRate > 100 || !Number.isInteger(months) || months < 0 || months > 1200) throw new RangeError('Ungültige Eingaben zur Kapitalentwicklung.');
  if (!months) return initial;
  const logRate = Math.log1p(annualRate / 100) / 12;
  const growth = Math.exp(logRate * months);
  const factor = logRate === 0 ? months : Math.expm1(logRate * months) / Math.expm1(logRate);
  const value = initial * growth + monthly * factor;
  if (!Number.isFinite(value)) throw new RangeError('Kapitalentwicklung liegt außerhalb des berechenbaren Bereichs.');
  return value;
}

export function adviceRemainingLoan(principal, annualInterest, annualRepayment, months) {
  if (![principal, annualInterest, annualRepayment, months].every(Number.isFinite) || principal < 0 || annualInterest < 0 || annualInterest > 100 || annualRepayment < 0 || annualRepayment > 100 || !Number.isInteger(months) || months < 0 || months > 1200) throw new RangeError('Ungültige Finanzierungseingaben.');
  const payment = principal * (annualInterest + annualRepayment) / 1200;
  let remaining = principal, interestPaid = 0, paymentsPaid = 0, paidOffAtMonth = principal === 0 ? 0 : null;
  for (let month = 1; month <= months && remaining > 0; month++) {
    const interest = remaining * annualInterest / 1200;
    const actualPayment = Math.min(payment, remaining + interest);
    interestPaid += interest;
    paymentsPaid += actualPayment;
    remaining = Math.max(0, remaining + interest - actualPayment);
    if (remaining < 1e-7) { remaining = 0; paidOffAtMonth = month; }
  }
  return { payment, remaining, interestPaid, paymentsPaid, paidOffAtMonth };
}

function finish(title, r, values, items, note = '') {
  if (r.issues.length) return { title, status: 'data-required', rulesVersion: ADVICE_CALCULATION_VERSION, values: null, items: [], issues: r.issues, automaticProposalEligible: false, note: 'Für eine belastbare Rechnung bitte ergänzen: ' + r.issues.map(issue => `${issue.label}: ${issue.reason}`).join(' ') };
  return { title, status: 'scenario', rulesVersion: ADVICE_CALCULATION_VERSION, values, items, issues: [], automaticProposalEligible: false, note };
}

export function calculateAdviceScenario(module, data = {}) {
  const calculator = typeof module === 'string' ? module : module?.calculator;
  const r = reader(data), get = r.get;
  if (calculator === 'financial-summary') {
    const income = get('monthlyIncome', 'Haushaltsnetto');
    const expenses = get(present(data.monthlyExpenses) ? 'monthlyExpenses' : 'essentialExpenses', 'Monatliche Ausgaben');
    const liquid = get(present(data.liquidAssets) ? 'liquidAssets' : 'liquidityReserve', 'Liquide Rücklagen');
    const assets = get('assets', 'Vermögen', { optional: module?.id === 'din-77230' });
    const liabilities = get('liabilities', 'Verbindlichkeiten', { optional: module?.id === 'din-77230' });
    const netWorthKnown = present(data.assets) && present(data.liabilities);
    const values = { cashFlowMonthly: income - expenses, netWorth: netWorthKnown ? assets - liabilities : null, liquidityMonths: expenses > 0 ? liquid / expenses : null };
    return finish('Finanzübersicht', r, values, [{ label: 'Freier Cashflow', value: euro(values.cashFlowMonthly) + ' / Monat' }, { label: 'Nettovermögen', value: euro(values.netWorth) }, { label: 'Liquiditätsreichweite', value: values.liquidityMonths === null ? 'Bei 0 € Ausgaben nicht bestimmbar' : values.liquidityMonths.toFixed(1) + ' Monate' }]);
  }
  if (calculator === 'business-summary') {
    const employees = get('employees', 'Beschäftigte', { integer: true, max: 1000000 });
    const revenue = get('annualRevenue', 'Jahresumsatz'), liquidity = get('liquidity', 'Liquidität'), liabilities = get('liabilities', 'Verbindlichkeiten');
    const values = { liquidityLessDebt: liquidity - liabilities, revenuePerEmployee: employees ? revenue / employees : null };
    return finish('Unternehmensübersicht', r, values, [{ label: 'Liquidität abzüglich Schulden', value: euro(values.liquidityLessDebt) }, { label: 'Umsatz je Beschäftigtem', value: employees ? euro(values.revenuePerEmployee) : 'Bei 0 Beschäftigten nicht bestimmbar' }, { label: 'Erfasste Schlüsselpersonen', value: data.keyPersons ? 'Ja' : 'Noch offen' }]);
  }
  if (calculator === 'retirement-gap') {
    const currentAge = get('currentAge', 'Aktuelles Alter', { max: 120 }), retirementAge = get('retirementAge', 'Rentenalter', { max: 120 });
    const years = retirementAge - currentAge;
    if (years < 0 || years > 100) r.issues.push({ field: 'retirementAge', label: 'Rentenalter', reason: 'Rentenbeginn muss zwischen heute und 100 Jahren liegen.' });
    const months = monthsFor(Math.max(0, Math.min(100, years)), r.issues);
    const desired = get('desiredNetPension', 'Gewünschtes Netto in heutiger Kaufkraft'), expected = get('expectedPension', 'Erwartete Rente bei Rentenbeginn'), privatePension = get('existingPrivatePension', 'Private Rente bei Rentenbeginn');
    const capital = get('existingCapital', 'Vorhandenes Vorsorgekapital');
    const inflation = get('inflation', 'Inflation', { min: -99, max: 100 }), annualReturn = get('returnRate', 'Effektive Jahresrendite', { min: -99, max: 100 }), withdrawal = get('withdrawalRate', 'Entnahmerate', { min: 0.01, max: 100 });
    if (r.issues.length) return finish('Vorsorgebedarf · Modellrechnung', r);
    const desiredFuture = desired * (1 + inflation / 100) ** years;
    const gap = Math.max(0, desiredFuture - expected - privatePension);
    const capitalNeeded = gap * 1200 / withdrawal;
    const existingCapitalFuture = adviceFutureValue(capital, 0, annualReturn, months);
    const additionalCapital = Math.max(0, capitalNeeded - existingCapitalFuture);
    const savingsFactor = adviceFutureValue(0, 1, annualReturn, months);
    const monthlySavings = additionalCapital === 0 ? 0 : savingsFactor > 0 ? additionalCapital / savingsFactor : null;
    const values = { months, desiredFuture, gap, capitalNeeded, existingCapitalFuture, additionalCapital, monthlySavings };
    return finish('Vorsorgebedarf · Modellrechnung', r, values, [{ label: 'Projizierter Netto-Wunsch', value: euro(desiredFuture) + ' / Monat' }, { label: 'Versorgungslücke', value: euro(gap) + ' / Monat' }, { label: 'Vorsorgekapital bei Rentenbeginn', value: euro(existingCapitalFuture) }, { label: 'Zusätzliches Kapital bei Rentenbeginn', value: euro(additionalCapital) }, { label: 'Erforderliche Sparrate', value: monthlySavings === null ? 'Kapital fehlt bereits zum heutigen Rentenbeginn' : euro(monthlySavings) + ' / Monat' }], 'Szenario mit effektiver Jahresrendite und Sparraten am Monatsende. Der Netto-Wunsch wird inflationsbereinigt hochgerechnet; Renten sind als erwartete Beträge bei Rentenbeginn einzugeben. Vorhandenes Kapital wird mit derselben Rendite fortgeschrieben. Entnahmerate ist eine Annahme; Steuern, Krankenversicherung, Rentendynamik und Produktkosten sind nicht enthalten.');
  }
  if (calculator === 'depot-comparison') {
    const years = get('years', 'Laufzeit', { max: 100 }), tax = get('taxRate', 'Pauschale Steuer', { max: 100 });
    const months = monthsFor(years, r.issues);
    const prepare = suffix => ({ initial: get('initial' + suffix, 'Startkapital ' + suffix), monthly: get('monthly' + suffix, 'Sparrate ' + suffix), annualReturn: get('return' + suffix, 'Jahresrendite ' + suffix, { min: -99, max: 100 }), cost: get('cost' + suffix, 'Laufende Kosten ' + suffix, { max: 99 }) });
    const inputs = { a: prepare('A'), b: prepare('B') };
    if (r.issues.length) return finish('Vermögensvergleich · vereinfachte Nettobetrachtung', r);
    const scenario = input => {
      const netAnnualRate = ((1 + input.annualReturn / 100) * (1 - input.cost / 100) - 1) * 100;
      const grossAfterCosts = adviceFutureValue(input.initial, input.monthly, netAnnualRate, months);
      const paidIn = input.initial + input.monthly * months;
      const taxAmount = Math.max(0, grossAfterCosts - paidIn) * tax / 100;
      return { grossAfterCosts, paidIn, taxAmount, finalCapital: grossAfterCosts - taxAmount, netAnnualRate };
    };
    const a = scenario(inputs.a), b = scenario(inputs.b), difference = Math.abs(a.finalCapital - b.finalCapital);
    return finish('Vermögensvergleich · vereinfachte Nettobetrachtung', r, { months, a, b, difference }, [{ label: data.scenarioAName || 'Variante A', value: euro(a.finalCapital) }, { label: data.scenarioBName || 'Variante B', value: euro(b.finalCapital) }, { label: 'Differenz', value: euro(difference) }], 'Effektive Jahresrendite; laufende Kosten als jährlicher prozentualer Abzug vom Vermögen nach Wertentwicklung. Sparraten am Monatsende. Pauschale Steuer nur auf positiven Endgewinn, keine Verlustgutschrift. Teilfreistellung, Vorabpauschale, individuelle Policenbesteuerung und Abschlusskosten sind nicht enthalten; kein verbindlicher Produktvergleich.');
  }
  if (calculator === 'property-financing') {
    const price = get('purchasePrice', 'Kaufpreis', { min: 0.01 }), ancillaryPercent = get('ancillaryPercent', 'Kaufnebenkosten', { max: 100 }), equity = get('equity', 'Eigenkapital');
    const interest = get('interestRate', 'Sollzins', { max: 100 }), repayment = get('repaymentRate', 'Anfängliche Tilgung', { max: 100 }), years = get('years', 'Betrachtungszeitraum', { max: 100 });
    const rent = get('monthlyRent', 'Kaltmiete / Mietwert'), maintenance = get('maintenance', 'Instandhaltung / nicht umlagefähige Kosten');
    const months = monthsFor(years, r.issues);
    if (r.issues.length) return finish('Immobilienrechnung', r);
    const ancillary = price * ancillaryPercent / 100, loan = Math.max(0, price + ancillary - equity);
    const result = adviceRemainingLoan(loan, interest, repayment, months);
    const values = { months, ancillary, loan, ...result, grossRentalYield: rent * 1200 / price, initialCashFlowMonthly: rent - maintenance - result.payment };
    return finish('Immobilienrechnung', r, values, [{ label: 'Finanzierungsbedarf', value: euro(loan) }, { label: 'Monatliche Annuität', value: euro(result.payment) }, { label: 'Restschuld', value: euro(result.remaining) }, { label: 'Bruttomietrendite', value: percentage(values.grossRentalYield) }, { label: 'Anfänglicher Cashflow vor Steuer', value: euro(values.initialCashFlowMonthly) }], 'Monatliche Annuität aus konstantem nominalem Sollzins und anfänglicher Tilgung. Letzte Rate wird auf die Restschuld begrenzt. Anschlusszins, Leerstand, Steuern und Sondertilgungen sind nicht enthalten; kein Finanzierungsangebot.');
  }
  return null;
}
