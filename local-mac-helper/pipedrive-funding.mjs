import { FUNDING_DOCUMENTS } from './funding.mjs';
import { missingFundingRequiredFields } from './funding-required-fields.mjs';

export const PIPEDRIVE_FUNDING_CONFIG = Object.freeze({
  host: 'simplegategmbh.pipedrive.com',
  pipeline: 'Auftragsmachbarkeit',
  partnerField: 'Vertriebspartner',
  orderNumberFields: ['Auftragsnummer', 'Angebotsnummer'],
  customerNumberFields: ['Kundennummer', 'Kunden-Nr.'],
  phoneNumberFields: ['Telefonnummer', 'Telefon', 'Mobilnummer'],
  emailFields: ['E-Mail', 'E-Mail-Adresse', 'Email'],
  locationFields: ['Ort', 'Stadt', 'Kundenort'],
  stages: Object.freeze({
    offerPublished: Object.freeze({
      label: 'Angebot veröffentlicht',
      aliases: ['Angebot veröffentlicht'],
      checkMode: 'signed-offer-gate',
      moveWhenCompleteTo: 'Auftrag eingereicht / Förderunterlagen einreichen',
      stayInStage: false,
    }),
    documents: Object.freeze({
      label: 'Auftrag eingereicht / Förderunterlagen einreichen',
      aliases: [
        'Antrag eingereicht / Förderunterlagen',
        'Antrag eingereicht / Förderunterlagen einreichen',
        'Auftrag eingereicht / Förderunterlagen',
        'Auftrag eingereicht / Förderunterlagen einreichen',
      ],
      checkMode: 'complete-document-review',
      moveWhenCompleteTo: 'Förderung beantragen',
      stayInStage: false,
    }),
    fundingRequested: Object.freeze({
      label: 'Förderung beantragen',
      aliases: ['Förderung beantragt', 'Förderung beantragen'],
      checkMode: 'complete-document-review',
      moveWhenCompleteTo: null,
      stayInStage: true,
    }),
  }),
});

export const FUNDING_DOCUMENT_STATE = Object.freeze({
  presentInPipedrive: 'present_in_pipedrive',
  availableInEmail: 'available_in_email',
  missing: 'missing',
  invalid: 'invalid',
  ambiguous: 'ambiguous',
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
  if (stage.key === 'offerPublished') {
    return {
      pipeline: PIPEDRIVE_FUNDING_CONFIG.pipeline,
      stage,
      requiredDocuments: [{ id: 'signed_offer', label: FUNDING_DOCUMENTS.signed_offer }],
      scanSources: ['Pipedrive-Dateien'],
      requireCompleteReview: true,
      movementRule: 'Der Deal darf erst bei eindeutig erkanntem unterschriebenem Angebot nach „Auftrag eingereicht / Förderunterlagen einreichen“ verschoben werden.',
      stayInStage: false,
      moveWhenCompleteTo: stage.moveWhenCompleteTo,
      canCreateFinalDraftAutomatically: false,
      openQuestions: [],
    };
  }
  const requiredDocumentIds = [
    'signed_offer',
    'identity_card',
    'registration_certificate',
    'land_register',
    'kfw_account_confirmation',
  ];
  const openQuestions = [];
  if (incomeBonusRequested === true) requiredDocumentIds.push('tax_assessment_2023', 'tax_assessment_2024');
  // An absent bonus request is not a missing document. Only an explicit
  // positive source instruction adds income evidence to this checklist.

  return {
    pipeline: PIPEDRIVE_FUNDING_CONFIG.pipeline,
    stage,
    requiredDocuments: requiredDocumentIds.map(id => ({ id, label: FUNDING_DOCUMENTS[id] })),
    scanSources: ['Pipedrive-Dateien', 'zugeordnete Förder-E-Mails'],
    requireCompleteReview: true,
    movementRule: stage.stayInStage
      ? 'Der Deal bleibt unabhängig vom Dokumentenstatus in „Förderung beantragen“. '
      : 'Der Deal darf erst nach bestätigter Vollständigkeit nach „Förderung beantragen“ verschoben werden.',
    stayInStage: stage.stayInStage,
    moveWhenCompleteTo: stage.moveWhenCompleteTo,
    canCreateFinalDraftAutomatically: openQuestions.length === 0,
    openQuestions,
  };
}

function normalizeDocumentEvidence(value) {
  const raw = typeof value === 'string' ? value : value?.status;
  return Object.values(FUNDING_DOCUMENT_STATE).includes(raw) ? raw : FUNDING_DOCUMENT_STATE.missing;
}

export function decideFundingDealAction(stageValue, { incomeBonusRequested, documentEvidence = {}, snapshot = {} } = {}) {
  const checklist = buildFundingStageChecklist(stageValue, { incomeBonusRequested });
  const documents = checklist.requiredDocuments.map(document => ({
    ...document,
    status: normalizeDocumentEvidence(documentEvidence[document.id]),
  }));
  const completeInPipedrive = documents.filter(document => document.status === FUNDING_DOCUMENT_STATE.presentInPipedrive);
  const uploadFromEmail = documents.filter(document => document.status === FUNDING_DOCUMENT_STATE.availableInEmail);
  const blockingDocuments = documents.filter(document => ![
    FUNDING_DOCUMENT_STATE.presentInPipedrive,
    FUNDING_DOCUMENT_STATE.availableInEmail,
  ].includes(document.status));
  const hasOpenQuestions = checklist.openQuestions.length > 0;
  const documentsCompleteInPipedrive = completeInPipedrive.length === documents.length && !hasOpenQuestions;
  const missingRequiredFields = missingFundingRequiredFields(snapshot);

  let action = 'prepare_missing_documents_draft';
  if (hasOpenQuestions) action = 'resolve_open_questions';
  else if (uploadFromEmail.length) action = 'upload_email_documents_then_recheck';
  else if (!blockingDocuments.length && documentsCompleteInPipedrive && missingRequiredFields.length) action = 'complete_required_fields_then_recheck';
  else if (!blockingDocuments.length && documentsCompleteInPipedrive) {
    action = checklist.stage.stayInStage
      ? 'keep_in_funding_requested'
      : checklist.stage.key === 'offerPublished'
        ? 'move_to_documents'
        : 'move_to_funding_requested';
  }

  return {
    action,
    stage: checklist.stage,
    requiredDocuments: documents,
    completeInPipedrive,
    uploadFromEmail,
    blockingDocuments,
    openQuestions: checklist.openQuestions,
    documentsCompleteInPipedrive,
    missingRequiredFields,
    requiredFieldsComplete: missingRequiredFields.length === 0,
    moveAllowed: ['move_to_documents', 'move_to_funding_requested'].includes(action),
    targetStage: ['move_to_documents', 'move_to_funding_requested'].includes(action) ? checklist.stage.moveWhenCompleteTo : null,
    stageLocked: checklist.stage.stayInStage,
    rules: [
      'Ein Dokument aus einer E-Mail gilt erst nach erfolgreichem Upload in den richtigen Pipedrive-Deal als vollständig.',
      'Nach jedem Upload wird die vollständige Checkliste erneut geprüft.',
      'Telefonnummer, Kunden-E-Mail, Anlage und Auftragsnummer müssen in den kanonischen CRM-Feldern gespeichert und rückgelesen sein.',
      checklist.movementRule,
    ],
  };
}

export function validatePipedriveFundingSnapshot(snapshot = {}) {
  const pipeline = String(snapshot.pipeline || '').trim();
  if (normalize(pipeline) !== normalize(PIPEDRIVE_FUNDING_CONFIG.pipeline)) {
    throw new Error(`Falsche Pipedrive-Pipeline: erwartet wird „${PIPEDRIVE_FUNDING_CONFIG.pipeline}“.`);
  }
  const stage = resolveFundingStage(snapshot.stage);
  if (!String(snapshot.customerName || '').trim()) throw new Error('Im Pipedrive-Snapshot fehlt der Kundenname.');
  return { ...snapshot, pipeline: PIPEDRIVE_FUNDING_CONFIG.pipeline, stage: stage.label };
}
