export const FUNDING_BASE_REQUIRED_DOCUMENTS = Object.freeze([
  'signed_offer', 'identity_card', 'registration_certificate', 'land_register', 'kfw_account_confirmation',
]);

export const FUNDING_APPLICATION_OWNERSHIP_LABEL = 'Vollständiger und leserlicher Grundbuchauszug oder eindeutige Eintragungsbekanntmachung (zur Beantragung)';

// These alternatives apply to the application only. A notification never
// proves that the complete land register needed for payout is present.
export function fundingApplicationOwnershipDocument(documentEvidence = {}) {
  for (const status of ['present_in_pipedrive', 'available_in_email']) {
    for (const type of ['land_register', 'land_register_notification']) {
      const evidence = documentEvidence[type];
      if ((typeof evidence === 'string' ? evidence : evidence?.status) === status) return type;
    }
  }
  return 'land_register';
}

export function fundingApplicationRequiredDocumentIds({ incomeBonusRequested, documentEvidence = {} } = {}) {
  return [
    ...FUNDING_BASE_REQUIRED_DOCUMENTS.map(type => type === 'land_register' ? fundingApplicationOwnershipDocument(documentEvidence) : type),
    ...(incomeBonusRequested === true ? ['tax_assessment_2023', 'tax_assessment_2024'] : []),
  ];
}
