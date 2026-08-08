import { FUNDING_DOCUMENTS } from './funding.mjs';

export const PIPEDRIVE_FUNDING_CONFIG = Object.freeze({
  host: 'simplegategmbh.pipedrive.com',
  pipeline: 'Auftragsmachbarkeit',
  partnerField: 'Vertriebspartner',
  orderNumberFields: ['Auftragsnummer', 'Angebotsnummer'],
  stages: Object.freeze({
    documents: Object.freeze({
      label: 'Antrag eingereicht / Förderunterlagen einreichen',
      aliases: ['Antrag eingereicht / Förderunterlagen', 'Antrag eingereicht / Förderunterlagen einreichen'],
      checkMode: 'complete-document-review',
    }),
    fundingRequested: Object.freeze({
      label: 'Förderung beantragt',
      aliases: ['Förderung beantragt', 'Förderung beantragen'],
      checkMode: 'complete-document-review-plus-final-step',
    }),
  }),
});

const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

export function resolveFundingStage(value) {
  const candidate = normalize(value);
  for (const [key, stage] of Object.entries(PIPEDRIVE_FUNDING_CONFIG.stages)) {
    if (stage.aliases.some(alias => normalize(alias) === candidate)) return { key, ...stage };
  }
  throw new Error(`Unbekannte Pipedrive-Förderstufe: ${String(value || 'leer')}`);
}

export function buildFundingStageChecklist(stageValue, { incomeBonusRequested } = {}) {
  const stage = resolveFundingStage(stageValue);
  const requiredDocumentIds = [
    'signed_offer',
    'identity_card',
    'registration_certificate',
    'land_register',
    'kfw_account_confirmation',
  ];
  const openQuestions = [];
  if (incomeBonusRequested === true) requiredDocumentIds.push('tax_assessment_2023', 'tax_assessment_2024');
  if (incomeBonusRequested !== true && incomeBonusRequested !== false) {
    openQuestions.push('Ist für diesen Deal der Einkommensbonus beantragt?');
  }

  const unresolvedFinalCheck = stage.key === 'fundingRequested';
  if (unresolvedFinalCheck) {
    openQuestions.push('Bezeichnung und Nachweis des letzten Kontrollpunkts in „Förderung beantragt“ am echten Deal verifizieren.');
  }
  return {
    pipeline: PIPEDRIVE_FUNDING_CONFIG.pipeline,
    stage,
    requiredDocuments: requiredDocumentIds.map(id => ({ id, label: FUNDING_DOCUMENTS[id] })),
    scanSources: ['Pipedrive-Dateien', 'zugeordnete Förder-E-Mails'],
    requireCompleteReview: true,
    unresolvedFinalCheck,
    canCreateFinalDraftAutomatically: openQuestions.length === 0,
    openQuestions,
  };
}

export function validatePipedriveFundingSnapshot(snapshot = {}) {
  const pipeline = String(snapshot.pipeline || '').trim();
  if (normalize(pipeline) !== normalize(PIPEDRIVE_FUNDING_CONFIG.pipeline)) {
    throw new Error(`Falsche Pipedrive-Pipeline: erwartet wird „${PIPEDRIVE_FUNDING_CONFIG.pipeline}“.`);
  }
  const stage = resolveFundingStage(snapshot.stage);
  if (!String(snapshot.customerName || '').trim()) throw new Error('Im Pipedrive-Snapshot fehlt der Kundenname.');
  if (!String(snapshot.orderNumber || '').trim()) throw new Error('Im Pipedrive-Snapshot fehlt die Angebots-/Auftragsnummer.');
  return { ...snapshot, pipeline: PIPEDRIVE_FUNDING_CONFIG.pipeline, stage: stage.label };
}
