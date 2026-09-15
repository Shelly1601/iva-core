import { randomUUID } from 'node:crypto';
import { careError, careId } from './store.js';

export const CUSTOMER_CARE_TOPICS = Object.freeze(['pv', 'heat-pump', 'insurance', 'energy', 'finance']);
export const DEFAULT_CARE_SETTINGS = Object.freeze({ enabled: false, annualCheckup: { enabled: true, month: 1, day: 15 }, optimization: { enabled: true, leadDays: 60 }, monthlySummary: { enabled: true, day: 1 }, bookingUrl: '', senderEmail: '', advisorEmail: '', deliveryMode: 'auto' });
export const cleanCareText = (value, max = 2000) => String(value ?? '').replace(/\0/g, '').trim().slice(0, max);
export function email(value, optional = false) { const text = cleanCareText(value, 254).toLowerCase(); if (optional && !text) return ''; if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(text)) throw careError('Eine eindeutige gültige E-Mail-Adresse ist erforderlich.'); return text; }
export function topics(value = []) { if (!Array.isArray(value) || value.length > 30) throw careError('Die Themenauswahl ist ungültig.'); return [...new Set(value.map(item => careId(item, 'Thema')))]; }
const integer = (value, min, max, label) => { if (!Number.isInteger(value) || value < min || value > max) throw careError(`${label} ist ungültig.`); return value; };
export function dateOnly(value, optional = false) { if (optional && !value) return ''; const text = String(value || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(`${text}T00:00:00Z`)) || new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) !== text) throw careError('Das Datum ist ungültig.'); return text; }
export function berlinDate(now) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now)); }
export function addDays(date, days) { return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10); }
export function contractCareDates(contract, leadDays) { const deadline = addDays(contract.renewalDate, -contract.noticeDays); return { deadline, due: addDays(deadline, -leadDays) }; }
export function annualDate(year, month, day) { const last = new Date(Date.UTC(year, month, 0)).getUTCDate(); return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`; }
function httpsUrl(value) { if (!value) return ''; let parsed; try { parsed = new URL(value); } catch { throw careError('Die Buchungsadresse ist ungültig.'); } if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port && parsed.port !== '443') throw careError('Die Buchungsadresse muss eine HTTPS-Adresse ohne Zugangsdaten sein.'); return parsed.href; }
export function normalizeSettings(patch = {}, previous = DEFAULT_CARE_SETTINGS) {
  const result = { ...structuredClone(DEFAULT_CARE_SETTINGS), ...structuredClone(previous) };
  if (patch.enabled !== undefined) { if (typeof patch.enabled !== 'boolean') throw careError('Aktivierung muss true/false sein.'); result.enabled = patch.enabled; }
  for (const name of ['annualCheckup', 'optimization', 'monthlySummary']) if (patch[name] !== undefined) {
    if (!patch[name] || typeof patch[name] !== 'object') throw careError('Ungültige Betreuungsregel.');
    result[name] = { ...result[name], ...patch[name] };
    if (typeof result[name].enabled !== 'boolean') throw careError('Die Regelaktivierung ist ungültig.');
  }
  integer(result.annualCheckup.month, 1, 12, 'Checkup-Monat'); integer(result.annualCheckup.day, 1, 31, 'Checkup-Tag'); integer(result.optimization.leadDays, 0, 365, 'Vorlauf');
  result.annualCheckup = { enabled: result.annualCheckup.enabled, month: result.annualCheckup.month, day: result.annualCheckup.day };
  result.optimization = { enabled: result.optimization.enabled, leadDays: result.optimization.leadDays };
  result.monthlySummary = { enabled: result.monthlySummary.enabled, day: integer(result.monthlySummary.day, 1, 31, 'Tag der Monatsübersicht') };
  for (const key of ['bookingUrl', 'landingUrl']) if (patch[key] !== undefined) result[key] = httpsUrl(patch[key]);
  for (const key of ['signature','imprint']) if (patch[key] !== undefined) result[key] = cleanCareText(patch[key], 4000);
  for (const key of ['senderEmail', 'advisorEmail']) if (patch[key] !== undefined) result[key] = email(patch[key], true);
  result.deliveryMode = 'auto'; return result;
}
export function normalizeCustomerCare(patch = {}, previous = {}) {
  const result = { enabled: true, annualCheckupEnabled: null, optimizationEnabled: null, preferredMonth: null, topics: [], ...previous };
  for (const key of ['enabled', 'annualCheckupEnabled', 'optimizationEnabled', 'emailAuthorized']) if (patch[key] !== undefined) { if (patch[key] === null && ['annualCheckupEnabled','optimizationEnabled'].includes(key)) result[key] = null;
    else { if (typeof patch[key] !== 'boolean') throw careError('Kundenfreigaben müssen true/false sein.'); result[key] = patch[key]; } }
  if (patch.preferredMonth !== undefined) result.preferredMonth = patch.preferredMonth === null || patch.preferredMonth === '' ? null : integer(patch.preferredMonth, 1, 12, 'Wunschmonat');
  if (patch.topics !== undefined) result.topics = topics(patch.topics);
  return result;
}
export function normalizeContract(input, customer, now) {
  const renewalDate = dateOnly(input.renewalDate); const cost = input.monthlyCost;
  if (cost !== undefined && cost !== null && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 || cost > 1000000)) throw careError('Die monatlichen Vertragskosten sind ungültig.');
  return { id: careId(input.id || randomUUID()), customerId: customer.id, workspaceId: customer.workspaceId || '', product: cleanCareText(input.product, 160), provider: cleanCareText(input.provider, 160), topic: careId(input.topic || 'energy'), renewalDate, noticeDays: integer(input.noticeDays ?? 0, 0, 730, 'Kündigungsfrist'), monthlyCost: cost ?? null, createdAt: new Date(now).toISOString() };
}
export const DEFAULT_CHECKUP_QUESTIONS = Object.freeze([
  { id: 'changes', label: 'Hat sich seit unserem letzten Gespräch etwas verändert?', type: 'single', options: [{ value: 'yes', label: 'Ja' }, { value: 'no', label: 'Nein' }, { value: 'unsure', label: 'Ich bin unsicher' }], required: true },
  { id: 'interest', label: 'Möchten Sie Ihre bestehenden Lösungen überprüfen lassen?', type: 'single', options: [{ value: 'yes', label: 'Ja, gerne' }, { value: 'later', label: 'Vielleicht später' }, { value: 'no', label: 'Aktuell nicht' }], required: true },
  { id: 'topics', label: 'Welche Themen sind für Sie interessant?', type: 'multi', options: [{ value: 'pv', label: 'Photovoltaik' }, { value: 'heat-pump', label: 'Wärmepumpe' }, { value: 'insurance', label: 'Versicherungen' }, { value: 'energy', label: 'Energie' }, { value: 'finance', label: 'Finanzen' }], required: false },
  { id: 'comment', label: 'Was möchten Sie uns noch mitteilen?', type: 'text', options: [], required: false },
]);
export function validateAnswers(questions, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw careError('Die Antworten sind ungültig.');
  const answers = {}; if (Object.keys(input).some(key => !questions.some(question => question.id === key))) throw careError('Eine unbekannte Frage wurde beantwortet.');
  for (const question of questions) {
    const value = input[question.id];
    if (value === undefined || value === '' || Array.isArray(value) && !value.length) { if (question.required) throw careError(`Bitte beantworten: ${question.label}`); continue; }
    if (question.type === 'text') { if (typeof value !== 'string' || value.length > 4000) throw careError('Die Freitextantwort ist zu lang.'); answers[question.id] = cleanCareText(value, 4000); }
    else if (question.type === 'single') { if (!question.options.some(item => item.value === value)) throw careError('Eine Antwortoption ist ungültig.'); answers[question.id] = value; }
    else { if (!Array.isArray(value) || value.length > question.options.length || value.some(entry => !question.options.some(item => item.value === entry))) throw careError('Die Themenantwort ist ungültig.'); answers[question.id] = [...new Set(value)]; }
  }
  return answers;
}
export function normalizeCampaign(input, now, previous) {
  const merged = { ...previous, ...input }, schedule = { ...previous?.schedule, ...input.schedule };
  if (!['once', 'annual', 'contract'].includes(schedule.type)) throw careError('Der Kampagnenzeitplan ist ungültig.');
  const normalized = { type: schedule.type, from: dateOnly(schedule.from, true), to: dateOnly(schedule.to, true) };
  if (normalized.from && normalized.to && normalized.from > normalized.to) throw careError('Das Kampagnenzeitfenster ist vertauscht.');
  if (schedule.type === 'once') { if (!Number.isFinite(Date.parse(schedule.at))) throw careError('Der Kampagnentermin fehlt.'); normalized.at = new Date(schedule.at).toISOString(); }
  if (schedule.type === 'annual') { normalized.month = integer(schedule.month, 1, 12, 'Monat'); normalized.day = integer(schedule.day, 1, 31, 'Tag'); }
  if (schedule.type === 'contract') normalized.leadDays = integer(schedule.leadDays ?? 30, 0, 365, 'Vertragsvorlauf');
  const name = cleanCareText(merged.name, 160), subject = cleanCareText(merged.subject, 200), body = cleanCareText(merged.body, 16000);
  if (!name || !subject || /[\r\n]/.test(subject) || !body) throw careError('Name, Betreff und Nachrichtentext sind erforderlich.');
  if (merged.recipientIds && (!Array.isArray(merged.recipientIds) || merged.recipientIds.length > 10000)) throw careError('Die Empfängerauswahl ist ungültig.');
  return { id: previous?.id || randomUUID(), name, subject, body, topics: topics(merged.topics), recipientIds: [...new Set((merged.recipientIds || []).map(value => careId(value, 'Kunde')))],
    workspaceId: cleanCareText(merged.workspaceId, 160), schedule: normalized, enabled: merged.enabled !== false, createdAt: previous?.createdAt || new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
}
export function matchingCustomer(customer, campaign) { return (campaign.schedule?.type !== 'once' || !campaign.audienceCapturedAt || (campaign.audienceSnapshot || []).includes(`${customer.workspaceId || ''}:${customer.id}`)) && (!campaign.workspaceId || customer.workspaceId === campaign.workspaceId) && (!campaign.recipientIds.length || campaign.recipientIds.includes(customer.id)) && (!campaign.topics.length || campaign.topics.some(topic => customer.topics.includes(topic))); }
export function dueAnnual(now, month, day, createdAt) { const today = berlinDate(now), year = Number(today.slice(0, 4)), due = annualDate(year, month, day); return due <= today && (!createdAt || due >= berlinDate(createdAt)) ? { due, key: String(year) } : null; }
export function usableQuote(quote, contract, customer, now) {
  const document = quote?.sourceType === 'verified-document', checkedAt = quote?.checkedAt || quote?.reviewedAt;
  const provenanceVerified = document
    ? Boolean(quote.sourceDocumentId && /^[a-f0-9]{64}$/i.test(quote.sourceSha256 || '') && quote.reviewedBy === 'admin' && Number.isFinite(Date.parse(quote.reviewedAt)) && Date.parse(quote.reviewedAt) <= now + 60000 && cleanCareText(quote.conditions, 4000))
    : quote?.providerVerified === true && (!quote.sourceType || quote.sourceType === 'provider-api');
  if (!quote || quote.verified !== true || !provenanceVerified || !quote.id || !quote.provider || quote.contractId !== contract.id || quote.customerId !== customer.id || quote.currency !== 'EUR'
    || typeof quote.monthlyCost !== 'number' || !Number.isFinite(quote.monthlyCost) || quote.monthlyCost < 0 || !Number.isFinite(Date.parse(checkedAt)) || Date.parse(checkedAt) > now + 60000
    || !document && now - Date.parse(checkedAt) > 7 * 86400000 || !Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= now) return null;
  return { id: String(quote.id).slice(0, 160), provider: cleanCareText(quote.provider, 160), monthlyCost: quote.monthlyCost, currency: 'EUR', checkedAt, expiresAt: quote.expiresAt, verified: true, providerVerified: !document,
    sourceType: document ? 'verified-document' : 'provider-api', sourceLabel: document ? 'Geprüftes Originalangebot' : 'Verifiziertes Anbieterangebot', conditions: cleanCareText(quote.conditions, 4000),
    ...(document ? { sourceDocumentId: cleanCareText(quote.sourceDocumentId, 200), sourceSha256: quote.sourceSha256.toLowerCase(), reviewedBy: 'admin', reviewedAt: quote.reviewedAt } : {}) };
}
