import { createHash } from 'node:crypto';
import { INSURANCE_CRITERIA_PROFILES } from '../public/advice-criteria.js';
export { INSURANCE_CRITERIA_PROFILES, appendInsuranceCriteria } from '../public/advice-criteria.js';

export const INSURANCE_CATEGORIES = [
  { id: 'sach', label: 'Sachversicherung', criteria: ['Gewünschter Deckungsumfang', 'Versicherungssumme ausreichend', 'Selbstbehalt passend', 'Ausschlüsse mit dem Bedarf vereinbar'] },
  { id: 'kv', label: 'Krankenversicherung', criteria: ['Ambulante Leistungen passend', 'Stationäre Leistungen passend', 'Zahnleistungen passend', 'Annahmebedingungen und Wartezeiten passend'] },
  { id: 'lv', label: 'Lebensversicherung / Vorsorge', criteria: ['Gewünschte Leistung passend', 'Kosten vollständig bekannt', 'Beitragsflexibilität passend', 'Garantien und Ausschlüsse geprüft'] },
  { id: 'kfz', label: 'Kfz-Versicherung', criteria: ['Gewünschter Deckungsumfang', 'Selbstbehalt passend', 'Fahrerkreis und Nutzung passend', 'Werkstattbindung und Einschränkungen passend'] },
].map(category => ({ ...category, profiles: INSURANCE_CRITERIA_PROFILES.filter(profile => profile.category === category.id) }));
export const adviceError = (message, status = 422, code = 'ADVICE_INVALID') => Object.assign(new Error(message), { status, code });
export const cleanText = (value, label, max = 500, optional = false) => {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw adviceError(`${label} fehlt oder ist ungültig.`);
  return value.trim();
};
export const adviceId = value => { const id = cleanText(value, 'Kennung', 160); if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw adviceError('Ungültige Kennung.'); return id; };
export const digest = value => createHash('sha256').update(value).digest('hex');
const number = (value, name, min = 0, max = 1e12) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw adviceError(`${name}: Zahl von ${min} bis ${max} erforderlich.`); return value; };
export function safeAdviceUrl(value) {
  if (!value) return '';
  let url; try { url = new URL(value); } catch { throw adviceError('Vollständige HTTPS-Adresse erforderlich.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 3000 || [...url.searchParams.keys()].some(key => /token|secret|password|api.?key|authorization/i.test(key))) throw adviceError('HTTPS-Adresse ohne Zugangsdaten oder geheime URL-Parameter erforderlich.');
  return url.href;
}
const timestamp = (value, name, optional = false) => { if (!value && optional) return null; if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value.slice(0, 10) + 'T12:00:00Z').toISOString().slice(0, 10) !== value.slice(0, 10)) throw adviceError(`${name}: gültiger ISO-Zeitpunkt erforderlich.`); return new Date(value).toISOString(); };
export function defaultCriteria(category) {
  const spec = INSURANCE_CATEGORIES.find(item => item.id === category); if (!spec) throw adviceError('Sparte muss sach, kv, lv oder kfz sein.');
  return spec.criteria.map((label, i) => ({ id: `criterion-${i + 1}`, label, weight: 25, type: 'boolean', mandatory: false }));
}
export function normalizeCriteria(values) {
  if (!Array.isArray(values) || !values.length || values.length > 30) throw adviceError('Ein bis dreißig Kriterien erforderlich.');
  const criteria = values.map(item => {
    const type = item.type || 'boolean'; if (!['boolean', 'higher', 'lower'].includes(type)) throw adviceError('Unbekannte Kriterienart.');
    return { id: adviceId(item.id), label: cleanText(item.label, 'Kriterium', 200), type, weight: number(item.weight, 'Gewicht', 0, 100), mandatory: item.mandatory === true, ...(type !== 'boolean' ? { target: number(item.target, 'Zielwert', 0.000001), unit: cleanText(item.unit, 'Einheit', 50) } : {}) };
  });
  if (new Set(criteria.map(item => item.id)).size !== criteria.length || !criteria.some(item => item.weight > 0)) throw adviceError('Eindeutige Kriterien mit positivem Gesamtgewicht erforderlich.');
  return criteria;
}
function evidence(input, documents, { optional = false } = {}) {
  if (!input && optional) return null;
  const documentId = adviceId(input?.documentId), document = documents.find(row => row.id === documentId);
  const excerpt = cleanText(input?.excerpt, 'Belegter Wortlaut', 3000), locator = cleanText(input?.locator, 'Fundstelle / Seite', 200);
  if (!document || !document.text?.includes(excerpt)) throw adviceError('Der angegebene Wortlaut ist in diesem eingelesenen Dokument nicht nachgewiesen.', 422, 'ADVICE_EVIDENCE_MISSING');
  return { documentId, sha256: document.sha256, locator, excerpt, reviewed: input.reviewed === true };
}
export function normalizeContract(input, criteria, documents, { old = false } = {}) {
  if (!input && old) return null;
  const facts = {};
  for (const criterion of criteria) {
    const fact = input?.facts?.[criterion.id]; if (!fact || fact.value === null || fact.value === undefined) continue;
    if (criterion.type === 'boolean' && typeof fact.value !== 'boolean') throw adviceError('Ja/Nein-Kriterium benötigt einen booleschen Wert.');
    const value = criterion.type === 'boolean' ? fact.value : number(fact.value, criterion.label);
    facts[criterion.id] = { value, evidence: evidence(fact.evidence, documents) };
  }
  const premium = input?.premium;
  const frequency = premium?.frequency || 'annual';
  if (premium && !['monthly', 'quarterly', 'half-yearly', 'annual'].includes(frequency)) throw adviceError('Ungültige Zahlweise.');
  const normalizedPremium = premium ? { amount: number(premium.amount, 'Bruttobeitrag'), frequency, annualFees: number(premium.annualFees ?? 0, 'Jährliche Zusatzkosten'), includesTax: premium.includesTax === true, feesConfirmed: premium.feesConfirmed === true, evidence: evidence(premium.evidence, documents) } : null;
  const issuedAt = timestamp(input?.issuedAt, 'Angebotsdatum', true), validUntil = timestamp(input?.validUntil, 'Angebotsgültigkeit', true);
  if (!old && issuedAt && validUntil && Date.parse(validUntil) <= Date.parse(issuedAt)) throw adviceError('Angebotsgültigkeit muss nach dem Angebotsdatum liegen.');
  return { id: adviceId(input?.id), provider: cleanText(input.provider, 'Versicherer', 160), tariff: cleanText(input.tariff, 'Tarif', 200),
    origin: input.origin === 'scenario' ? 'scenario' : 'document', liveQuote: false, issuedAt, validUntil, premium: normalizedPremium, facts,
    riskConfirmed: input.riskConfirmed === true, notes: cleanText(input.notes, 'Hinweise', 4000, true) };
}
function score(fact, criterion) {
  if (!fact?.evidence?.reviewed) return null;
  if (criterion.type === 'boolean') return fact.value ? 100 : 0;
  if (criterion.type === 'higher') return Math.min(100, fact.value / criterion.target * 100);
  return fact.value <= criterion.target ? 100 : Math.min(100, criterion.target / fact.value * 100);
}
export function evaluateInsuranceCase(record, { now = new Date().toISOString(), favorites = [] } = {}) {
  const date = timestamp(now, 'Prüfzeitpunkt'), criteria = normalizeCriteria(record.criteria), weight = criteria.reduce((n, row) => n + row.weight, 0);
  const assess = (contract, old = false) => {
    if (!contract) return null;
    const rows = criteria.map(criterion => {
      const fact = contract.facts?.[criterion.id], document = record.documents.find(row => row.id === fact?.evidence?.documentId);
      const validEvidence = document && document.sha256 === fact.evidence.sha256 && document.text.includes(fact.evidence.excerpt);
      const rating = validEvidence ? score(fact, criterion) : null;
      return { ...criterion, value: fact?.value ?? null, score: rating, evidence: fact?.evidence || null, status: rating === null ? 'unknown' : rating === 100 ? 'meets-target' : 'below-target' };
    });
    const knownWeight = rows.filter(row => row.score !== null).reduce((n, row) => n + row.weight, 0);
    const weightedScore = rows.reduce((n, row) => n + (row.score ?? 0) * row.weight, 0) / weight;
    const premium = contract.premium, premiumDocument = record.documents.find(row => row.id === premium?.evidence?.documentId);
    const premiumValid = premium?.includesTax && premium.feesConfirmed && premium.evidence.reviewed && premiumDocument?.sha256 === premium.evidence.sha256 && premiumDocument?.text.includes(premium.evidence.excerpt);
    const annualGross = premiumValid ? Math.round((premium.amount * ({ monthly: 12, quarterly: 4, 'half-yearly': 2, annual: 1 }[premium.frequency]) + premium.annualFees) * 100) / 100 : null;
    const reasons = [rows.some(row => row.score === null && (row.weight > 0 || row.mandatory)) ? 'Gewichtete oder notwendige Leistungen sind noch nicht belegt und geprüft.' : null,
      rows.some(row => row.mandatory && row.score !== null && row.score < 100) ? 'Mindestens ein Muss-Kriterium wird nicht erfüllt.' : null,
      annualGross === null ? 'Bruttobeitrag und Zusatzkosten sind noch nicht vollständig belegt und geprüft.' : null,
      !old && contract.origin === 'scenario' ? 'Manuelles Szenario, kein dokumentiertes Angebot.' : null,
      !old && (!contract.issuedAt || Date.parse(contract.issuedAt) > Date.parse(date) || !contract.validUntil || Date.parse(contract.validUntil) <= Date.parse(date)) ? 'Das Angebot ist noch nicht gültig oder bereits abgelaufen.' : null,
      !old && !contract.riskConfirmed ? 'Das Angebot wurde noch nicht demselben Kundenrisiko zugeordnet.' : null].filter(Boolean);
    return { id: contract.id, provider: contract.provider, tariff: contract.tariff, origin: contract.origin, liveQuote: false, annualGross, score: weightedScore, scoreRange: [weightedScore, weightedScore + (weight - knownWeight) / weight * 100], coveragePercent: knownWeight / weight * 100, eligible: reasons.length === 0, reasons, rows,
      favorite: favorites.some(row => row.category === record.category && row.provider === contract.provider && row.tariff === contract.tariff), validUntil: contract.validUntil };
  };
  const oldContract = assess(record.oldContract, true), offers = record.offers.map(offer => assess(offer));
  const ranking = offers.filter(row => row.eligible).sort((a, b) => b.score - a.score || a.annualGross - b.annualGross || a.id.localeCompare(b.id)).map((offer, index) => ({ ...offer, rank: index + 1, annualDifferenceFromOld: oldContract?.annualGross == null ? null : oldContract.annualGross - offer.annualGross,
    changes: offer.rows.map(row => ({ criterionId: row.id, label: row.label, oldValue: oldContract?.rows.find(old => old.id === row.id)?.value ?? null, newValue: row.value, scoreChange: oldContract?.rows.find(old => old.id === row.id)?.score == null ? null : row.score - oldContract.rows.find(old => old.id === row.id).score })) }));
  return { status: ranking.length ? 'document-comparison' : 'incomplete', checkedAt: date, liveQuotes: false, automaticProposalEligible: false, oldContract, offers, ranking,
    method: 'Gewichtete Zielerfüllung (0 bis 100). Fehlende Nachweise bleiben unbekannt. Nur vollständig belegte, manuell geprüfte und aktuell gültige Angebote für dasselbe Risiko werden gereiht. Bei Gleichstand entscheidet der belegte jährliche Bruttogesamtpreis. Projektfavoriten verändern die Bewertung nicht.',
    limitations: ['Dokumentangebote wurden manuell erfasst und geprüft; ihre Echtheit ist nicht durch einen Live-Anbieterrücklauf bestätigt.', 'Das Ranking gilt nur für die ausgewählten Kriterien und Angebote. Ungeprüfte Ausschlüsse, Gesundheitsprüfung und Annahmeentscheidung bleiben offen.'] };
}
