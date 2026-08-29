export const AIRTABLE_HWP_LAYOUT = Object.freeze({
  baseId: 'appBsUeEsjEBzIMDc',
  interfaceId: 'pbdt3FMtYOHgD4m0G',
  pageId: 'pagyBs7hOhHp6u3gh',
  pageName: 'Überblick',
  tableId: 'tblGcYRzV0X9i6dqc',
  stage: Object.freeze({
    fieldName: 'Stage',
    installationQueueName: 'Installation Queue',
    installationQueueChoiceId: 'selAsWptav4Fc64UN',
  }),
  fields: Object.freeze({
    customer: 'Kunde',
    projectAddress: 'Projektanschrift',
    plannedInstallationDate: 'Installationsdatum (geplant)',
    correctedOffer: 'Angebot korrigiert',
    heroId: 'ID (HERO)',
    mobile: 'Mobiltelefon',
    phone: 'Festnetz',
    email: 'Emailadresse',
    soldProduct: 'Verkauftes Produkt',
  }),
});

export function compareAirtableLayout(table = {}) {
  const fields = Array.isArray(table.fields) ? table.fields : [];
  const byName = new Map(fields.map(field => [field.name, field]));
  const warnings = [];
  if (String(table.id || '') !== AIRTABLE_HWP_LAYOUT.tableId) warnings.push('Die erwartete Heat-Hero-Tabelle wurde nicht gefunden.');
  for (const fieldName of [AIRTABLE_HWP_LAYOUT.stage.fieldName, ...Object.values(AIRTABLE_HWP_LAYOUT.fields)]) {
    if (!byName.has(fieldName)) warnings.push(`Airtable-Feld fehlt oder wurde umbenannt: ${fieldName}`);
  }
  const stageField = byName.get(AIRTABLE_HWP_LAYOUT.stage.fieldName);
  const choices = stageField?.options?.choices || [];
  const stageChoice = choices.find(choice => choice.id === AIRTABLE_HWP_LAYOUT.stage.installationQueueChoiceId);
  if (!stageChoice || stageChoice.name !== AIRTABLE_HWP_LAYOUT.stage.installationQueueName) {
    warnings.push('Die Auswahl „Installation Queue“ stimmt nicht mehr mit der freigegebenen Airtable-ID überein.');
  }
  return { matches: warnings.length === 0, warnings };
}
