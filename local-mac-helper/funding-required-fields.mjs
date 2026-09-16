export const FUNDING_REQUIRED_FIELDS = Object.freeze([
  Object.freeze({ key: 'customerEmail', label: 'E-Mail' }),
  Object.freeze({ key: 'phoneNumber', label: 'Telefonnummer' }),
  Object.freeze({ key: 'plant', label: 'Anlage' }),
  Object.freeze({ key: 'orderNumber', label: 'Auftragsnummer' }),
]);

// Values must be read from the canonical CRM fields, never inferred from a title.
export function missingFundingRequiredFields(snapshot = {}) {
  return FUNDING_REQUIRED_FIELDS.filter(({ key }) => !String(snapshot?.[key] ?? '').trim()).map(({ label }) => label);
}
