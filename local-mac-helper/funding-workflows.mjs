import os from 'node:os';

export const FUNDING_WORKFLOW_NAMES = Object.freeze({
  completeness: 'Förderung 1 – Vollständigkeit & Unterlagen',
  amount: 'Förderung 2 – Förderhöhe prüfen',
  approval: 'Förderung 3 – KfW-Zusagen prüfen',
});

export const FUNDING_WORKFLOW_ORDER = Object.freeze([
  'completeness',
  'amount',
  'approval',
]);

export const FUNDING_WORKFLOW_POLICY = Object.freeze({
  timeZone: 'Europe/Berlin',
  schedule: 'Täglich · 05:00 Uhr',
  executionHost: 'imac-nadine',
  emailMode: 'draft-only',
  deleteMail: false,
  deletePipedrive: false,
  deleteFiles: false,
  deleteManagedLocalCopiesAfterVerifiedReplacement: true,
  emptyWholeUserTrash: false,
  processedMailFolder: 'fertig',
  noteSuffix: '(Notiz von Nadine via KI)',
  reportChannel: 'telegram-with-project-protocol',
  sheet: Object.freeze({
    spreadsheetId: '1XPlBa5XgBixML0RquR_kwIwyxTDqRtpfXAudYimKB_8',
    columns: Object.freeze(['Kundename', 'Datum', 'Bemerkung']),
    nameColumnAliases: Object.freeze(['Kundename', 'Name']),
    remark: '',
  }),
});

const clean = (value, max = 4000) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function isImacFundingHost(hostname = os.hostname(), expectedHostname = process.env.IVA_IMAC_HOSTNAME) {
  const actual = clean(hostname, 200).toLocaleLowerCase('de').replace(/\.local$/, '');
  const expected = clean(expectedHostname, 200).toLocaleLowerCase('de').replace(/\.local$/, '');
  return expected ? actual === expected : actual.includes('imac');
}

export function assertImacFundingHost(hostname = os.hostname(), expectedHostname = process.env.IVA_IMAC_HOSTNAME) {
  if (isImacFundingHost(hostname, expectedHostname)) return true;
  throw new Error(`Förderlauf gesperrt: Ausführung ist ausschließlich auf dem iMac erlaubt (${clean(hostname, 200) || 'unbekannter Host'}).`);
}

export function assertFundingWorkflowOrder(sequence = FUNDING_WORKFLOW_ORDER) {
  const normalized = (Array.isArray(sequence) ? sequence : []).map(value => clean(value, 40));
  if (JSON.stringify(normalized) !== JSON.stringify(FUNDING_WORKFLOW_ORDER)) {
    throw new Error('Förderlauf gesperrt: Reihenfolge muss Vollständigkeit → Förderhöhe → KfW-Zusagen sein.');
  }
  return true;
}

function euro(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'Betrag offen';
  return `${amount.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

export function buildFundingCalculationNote({ result = {}, sources = [], openPoints = [], status = '' } = {}) {
  const units = Math.max(1, Math.floor(Number(result.units) || 1));
  const summary = clean(result.noteSummary, 1200);
  const firstLine = units > 1 && !/^[\d.]+,\d{2}\s*€/.test(summary)
    ? `${euro(result.estimatedGrant)} voraussichtliche Förderung – ${summary}`
    : summary;
  if (!firstLine) throw new Error('Die wichtigste Förderaussage für die erste Notizzeile fehlt.');
  const details = [
    `Status: ${clean(status || (result.status === 'precheck-positive' ? 'GRÜN' : 'GELB'), 40)}`,
    `Förderfähige Kosten: ${euro(result.eligibleCosts)}`,
    `Voraussichtlicher Zuschuss: ${euro(result.estimatedGrant)}`,
    `Regelstand: ${clean(result.rulesAsOf || result.rulesVersion, 120) || 'offen'}`,
    ...(Array.isArray(sources) && sources.length ? [`Geprüfte Quellen: ${sources.map(item => clean(item, 300)).filter(Boolean).join(' · ')}`] : []),
    ...(Array.isArray(openPoints) && openPoints.length ? [`Offene Prüfpunkte: ${openPoints.map(item => clean(item, 300)).filter(Boolean).join(' · ')}`] : []),
  ];
  return [firstLine, ...details, FUNDING_WORKFLOW_POLICY.noteSuffix].join('\n');
}

export function buildFundingSheetRow({ customerName, date = new Date() } = {}) {
  const name = clean(customerName, 220);
  if (!name) throw new Error('Für die Förderliste fehlt der vollständige Kundenname.');
  const parsed = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(parsed.getTime())) throw new Error('Für die Förderliste fehlt ein gültiges Eintragsdatum.');
  const formatted = new Intl.DateTimeFormat('de-DE', {
    timeZone: FUNDING_WORKFLOW_POLICY.timeZone,
    day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(parsed);
  return { Kundename: name, Datum: formatted, Bemerkung: '' };
}

export function resolveFundingSheetColumns(headers = []) {
  const values = (Array.isArray(headers) ? headers : []).map(value => clean(value, 120));
  const normalizeHeader = value => clean(value, 120).toLocaleLowerCase('de');
  const findExactlyOne = (aliases, label) => {
    const expected = aliases.map(normalizeHeader);
    const matches = values.map((value, index) => expected.includes(normalizeHeader(value)) ? index : -1).filter(index => index >= 0);
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? `Förderliste gesperrt: Spalte „${label}“ fehlt.`
        : `Förderliste gesperrt: Spalte „${label}“ ist nicht eindeutig.`);
    }
    return matches[0];
  };
  const customerName = findExactlyOne(FUNDING_WORKFLOW_POLICY.sheet.nameColumnAliases, 'Kundename/Name');
  const date = findExactlyOne(['Datum'], 'Datum');
  const remark = findExactlyOne(['Bemerkung'], 'Bemerkung');
  return {
    customerName,
    date,
    remark,
    headers: { customerName: values[customerName], date: values[date], remark: values[remark] },
  };
}

export function buildFundingDailyReport({ startedAt, completedAt, workflows = [], deals = [], blockers = [] } = {}) {
  const lines = [
    `Förderlauf ${clean(completedAt || startedAt, 40) || 'heute'}`,
    ...FUNDING_WORKFLOW_ORDER.map(key => {
      const item = workflows.find(entry => entry?.key === key) || {};
      return `${FUNDING_WORKFLOW_NAMES[key]}: ${clean(item.status || 'nicht gelaufen', 120)}`;
    }),
  ];
  for (const deal of (Array.isArray(deals) ? deals : []).slice(0, 80)) {
    const name = clean(deal.customerName || deal.dealTitle || `Deal ${deal.dealId || '?'}`, 220);
    const actions = (Array.isArray(deal.actions) ? deal.actions : [deal.action]).map(item => clean(item, 400)).filter(Boolean);
    lines.push(`- ${name}: ${actions.join(' · ') || 'geprüft, keine Änderung'}`);
  }
  if (Array.isArray(blockers) && blockers.length) {
    lines.push('Manuell zu prüfen:');
    for (const blocker of blockers.slice(0, 40)) lines.push(`- ${clean(blocker, 500)}`);
  } else lines.push('Manuell zu prüfen: keine offenen Punkte.');
  return lines.join('\n').slice(0, 12_000);
}

export function fundingWorkflowPolicy() {
  return {
    ...FUNDING_WORKFLOW_POLICY,
    names: { ...FUNDING_WORKFLOW_NAMES },
    order: [...FUNDING_WORKFLOW_ORDER],
  };
}
