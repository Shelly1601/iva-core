export const PIPEDRIVE_COMPANY_DOMAIN = 'simplegategmbh.pipedrive.com';

// Live aus der angemeldeten Pipedrive-Session am 29.08.2026 gelesen. Namen
// dienen nur der Anzeige und Drift-Erkennung; operative Zuordnungen verwenden
// immer die stabilen numerischen IDs beziehungsweise Feldschluessel.
export const PIPEDRIVE_LAYOUT = Object.freeze({
  pipelines: Object.freeze({
    orderFeasibility: Object.freeze({ id: 1, name: 'Auftragsmachbarkeit' }),
    orderPlanning: Object.freeze({ id: 2, name: 'Auftragsplanung' }),
    installationClosing: Object.freeze({ id: 3, name: 'Montage/Abschluss' }),
  }),
  stages: Object.freeze({
    customerInterest: Object.freeze({ id: 1, pipelineId: 1, name: 'Kunden Intresse' }),
    assessTmb: Object.freeze({ id: 2, pipelineId: 1, name: 'TMB bewerten' }),
    sendOffer: Object.freeze({ id: 3, pipelineId: 1, name: 'Angebot senden' }),
    offerSent: Object.freeze({ id: 20, pipelineId: 1, name: 'Angebot gesendet' }),
    submitOrderDocuments: Object.freeze({ id: 19, pipelineId: 1, name: 'Auftrag eingereicht / Förderunterlagen einreichen' }),
    applyFunding: Object.freeze({ id: 18, pipelineId: 1, name: 'Förderung beantragen' }),
    scheduleInstallation: Object.freeze({ id: 8, pipelineId: 2, name: 'Montage einplanen' }),
    installationScheduled: Object.freeze({ id: 9, pipelineId: 2, name: 'Montage Terminiert, RG+AB senden' }),
    checkPayment: Object.freeze({ id: 10, pipelineId: 2, name: 'Zahlungseingang prüfen' }),
    prepareSite: Object.freeze({ id: 21, pipelineId: 2, name: 'Baustellenplanung / Material bestellen' }),
    confirmFinalDate: Object.freeze({ id: 13, pipelineId: 3, name: 'Final Termin bestätigen' }),
    installation: Object.freeze({ id: 15, pipelineId: 3, name: 'Montage' }),
    finalInvoice: Object.freeze({ id: 16, pipelineId: 3, name: 'Abschlussrechnung senden' }),
    submitKfwDocuments: Object.freeze({ id: 17, pipelineId: 3, name: 'KFW Dokumente einreichen' }),
    closing: Object.freeze({ id: 22, pipelineId: 3, name: 'Abschluss' }),
  }),
  dealFields: Object.freeze({
    salesPartner: Object.freeze({ id: 43, key: '15637bc4fae069b23d740b759d4e5d230980c8e9', name: 'Vertriebspartner' }),
    leadId: Object.freeze({ id: 62, key: 'bb72f9e58023ce098b9deed0da24b28410caf5c5', name: 'LEAD ID' }),
    salesStructure: Object.freeze({ id: 63, key: '9fba0906ec4697d64d795a7f3521c257bbd06635', name: 'Vertriebsstruktur' }),
    salesId: Object.freeze({ id: 44, key: 'c0e55a017818b08381b687c74315bf7fb2f902b6', name: 'Vertriebs ID' }),
    installationWeek: Object.freeze({ id: 67, key: '2be19a1920fe05421776f595eb5cec3281b21a76', name: 'Einbautermin Kalenderwoche' }),
    orderNumber: Object.freeze({ id: 53, key: '6bf51a1b7f67a92da3de9d1d309e9268d2f9d4a1', name: 'Auftragsnummer' }),
    plant: Object.freeze({ id: 71, key: '6601d80cfa2cd41f47fdfa58f86fc6b057d0efd4', name: 'Anlage' }),
    projectManager: Object.freeze({ id: 69, key: 'c11a2731c7c8d7f0959c3fa9390dfb6d8c524b96', name: 'Projektmanager' }),
    installationTeam: Object.freeze({ id: 65, key: '323900400549fbc1cd0a879c782795725b25d863', name: 'Einbau Team' }),
    transferredToHero: Object.freeze({ id: 68, key: 'fe79e665eabe090a837fa1bf370120cfb842b71d', name: 'An HERO übertragen' }),
  }),
});

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function comparePipedriveLayout({ pipelines = [], stages = [], dealFields = [] } = {}) {
  const warnings = [];
  const pipelineById = new Map(pipelines.map(item => [Number(item.id), item]));
  const stageById = new Map(stages.map(item => [Number(item.id), item]));
  const fieldById = new Map(dealFields.map(item => [Number(item.id), item]));

  for (const expected of Object.values(PIPEDRIVE_LAYOUT.pipelines)) {
    const actual = pipelineById.get(expected.id);
    if (!actual) warnings.push(`Pipeline ${expected.id} fehlt (${expected.name}).`);
    else if (text(actual.name) !== expected.name) warnings.push(`Pipeline ${expected.id} heißt jetzt „${text(actual.name)}“ statt „${expected.name}“.`);
  }
  for (const expected of Object.values(PIPEDRIVE_LAYOUT.stages)) {
    const actual = stageById.get(expected.id);
    if (!actual) warnings.push(`Phase ${expected.id} fehlt (${expected.name}).`);
    else {
      if (Number(actual.pipeline_id ?? actual.pipelineId) !== expected.pipelineId) warnings.push(`Phase ${expected.id} liegt nicht mehr in Pipeline ${expected.pipelineId}.`);
      if (text(actual.name) !== expected.name) warnings.push(`Phase ${expected.id} heißt jetzt „${text(actual.name)}“ statt „${expected.name}“.`);
    }
  }
  for (const expected of Object.values(PIPEDRIVE_LAYOUT.dealFields)) {
    const actual = fieldById.get(expected.id);
    if (!actual) warnings.push(`Deal-Feld ${expected.id} fehlt (${expected.name}).`);
    else {
      if (text(actual.key) !== expected.key) warnings.push(`Deal-Feld ${expected.id} hat einen unerwarteten Schlüssel.`);
      if (text(actual.name) !== expected.name) warnings.push(`Deal-Feld ${expected.id} heißt jetzt „${text(actual.name)}“ statt „${expected.name}“.`);
    }
  }
  return { matches: warnings.length === 0, warnings, checkedAt: new Date().toISOString() };
}
