import { parseAdviceNumber } from '../public/advice-calculators.js';

// Narrow, literal candidates only. No insurer or benefit is inferred from a name
// or a missing phrase; the reviewer must confirm context, gross status and page.
export function suggestContractEvidence(document) {
  const candidates = [], amount = '(\\d[\\d.,]*)\\s*(?:EUR|€)';
  for (const [field, label, prefix, frequency] of [
    ['premium', 'Möglicher Jahresbeitrag', '(?:Jahresbeitrag|jährlicher\\s+(?:Brutto)?beitrag)', 'annual'],
    ['premium', 'Möglicher Monatsbeitrag', '(?:Monatsbeitrag|monatlicher\\s+(?:Brutto)?beitrag)', 'monthly'],
    ['deductible', 'Möglicher Selbstbehalt', '(?:Selbstbehalt|Selbstbeteiligung)', null],
    ['coverage', 'Mögliche Versicherungssumme', '(?:Versicherungssumme|Deckungssumme)', null],
  ]) {
    const regex = new RegExp(`${prefix}\\s*[:=-]?\\s*${amount}`, 'gi');
    for (const match of document.text.matchAll(regex)) {
      const value = parseAdviceNumber(match[1]); if (value === null || value < 0) continue;
      candidates.push({ field, label, value, unit: 'EUR', ...(frequency ? { frequency } : {}), confirmed: false,
        evidence: { documentId: document.id, sha256: document.sha256, excerpt: match[0], locator: `Textposition ${match.index + 1}; Dokumentseite bitte prüfen`, reviewed: false } });
      if (candidates.length >= 30) return candidates;
    }
  }
  return candidates;
}
