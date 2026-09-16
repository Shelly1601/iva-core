import os from 'node:os';
import { isAllowedImacExecutionHost } from './imac-host-guard.mjs';

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
  executionHost: 'macmini-nadine',
  emailMode: 'verified-send',
  deleteMail: false,
  deletePipedrive: false,
  deleteFiles: false,
  deleteManagedLocalCopiesAfterVerifiedReplacement: true,
  emptyWholeUserTrash: true,
  trashCleanupExecutor: 'authorized-daily-worker',
  processedMailFolder: 'Fertig',
  noteSuffix: '(Notiz von Nadine)',
  reportChannel: 'telegram-with-project-protocol',
  sheet: Object.freeze({
    spreadsheetId: '1XPlBa5XgBixML0RquR_kwIwyxTDqRtpfXAudYimKB_8',
    columns: Object.freeze(['Kundename', 'Datum', 'Bemerkung']),
    nameColumnAliases: Object.freeze(['Kundename', 'Name']),
    remark: '',
  }),
});

const clean = (value, max = 4000) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function isImacFundingHost(hostname = os.hostname(), expectedHostname = process.env.IVA_MACMINI_HOSTNAME) {
  return isAllowedImacExecutionHost(hostname, expectedHostname);
}

export function assertImacFundingHost(hostname = os.hostname(), expectedHostname = process.env.IVA_MACMINI_HOSTNAME) {
  if (isImacFundingHost(hostname, expectedHostname)) return true;
  throw new Error(`Förderlauf gesperrt: Ausführung ist ausschließlich auf dem Mac Mini erlaubt (${clean(hostname, 200) || 'unbekannter Host'}).`);
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

function percent(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toLocaleString('de-DE', { maximumFractionDigits: 2 })} %` : 'offen';
}

export function buildFundingCalculationNote({ result = {}, openPoints = [] } = {}) {
  if (result.canUseForFundingNote !== true || typeof result.estimatedGrant !== 'number' || !Number.isFinite(result.estimatedGrant) || typeof result.eligibleCosts !== 'number' || !Number.isFinite(result.eligibleCosts)) throw new Error('Die Förderberechnung ist noch nicht vollständig belegt und darf nicht als Betragsnotiz verwendet werden.');
  const units = Math.max(1, Math.floor(Number(result.units) || 1));
  const bonuses = result.bonuses || {};
  const structured = typeof bonuses.base === 'number' && Number.isFinite(bonuses.base);
  const displayedRate = result.selfUsed === true ? result.selfUsedUnitRate : result.buildingBaseRate;
  const estimate = result.calculationComplete === false ? 'vorläufige Förderung; weitere Boni offen' : 'voraussichtliche Förderung';
  const summary = clean(result.noteSummary, 240);
  const firstLine = structured
    ? units > 1 ? `${euro(result.estimatedGrant)} ${estimate} (${units} Wohneinheiten)`
      : `${percent(displayedRate ?? result.rate)} ${estimate} (${euro(result.estimatedGrant)})`
    : units > 1 && !/^[\d.]+,\d{2}\s*€/.test(summary) ? `${euro(result.estimatedGrant)} voraussichtliche Förderung – ${summary}` : summary;
  if (!firstLine) throw new Error('Die wichtigste Förderaussage für die erste Notizzeile fehlt.');
  const details = [];
  if (structured) {
    const income = result.incomeBonusRequested === true ? percent(bonuses.income) : 'nicht beantragt';
    if (units > 1) {
      details.push(`Grundförderung: ${percent(bonuses.base)} = ${euro(result.buildingBaseGrant)}.`);
      if (result.selfUsed !== false) {
        const openBonus = bonuses.climateSpeed === null || (result.incomeBonusRequested === true && bonuses.income === null) || result.bonusStatus?.allocation === 'open';
        const additional = openBonus && !result.selfUsedUnitAdditionalGrant ? '; noch nicht eingerechnet'
          : Number.isFinite(result.selfUsedUnitAdditionalGrant) ? ` = ${euro(result.selfUsedUnitAdditionalGrant)}` : '';
        details.push(`Boni selbst genutzte Wohnung: Klima ${percent(bonuses.climateSpeed)} · Einkommen ${income}${additional}${result.unitRateCapped ? ` (insgesamt auf ${percent(result.maximumUnitRate)} begrenzt)` : ''}.`);
      }
    } else {
      details.push(`Grundförderung ${percent(bonuses.base)} · Klima ${percent(bonuses.climateSpeed)} · Einkommen ${income}${result.unitRateCapped ? `; insgesamt auf ${percent(result.maximumUnitRate)} begrenzt` : ''}.`);
    }
    if (result.incomeBonusRequested === true) {
      const child = result.eligibleMinorChild === true ? 'berücksichtigt' : result.eligibleMinorChild === false ? 'nein' : 'offen';
      details.push(`Kind unter 18: ${child}.`);
    }
  }
  // Source references and procedural approval checks stay in the calculation record.
  // The CRM note shows only the estimate, its components and actual bonus questions.
  const questions = [...(Array.isArray(result.bonusQuestions) ? result.bonusQuestions : []), ...(Array.isArray(openPoints) ? openPoints : [])]
    .map(item => clean(item, 160)).filter(Boolean)
    .filter(item => !/Antragsdatum|BzA|Regelstand|https?:\/\//i.test(item));
  const distinctQuestions = [...new Set(questions)].slice(0, 3);
  if (distinctQuestions.length) details.push(`Offen: ${distinctQuestions.join(' · ')}`);
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
