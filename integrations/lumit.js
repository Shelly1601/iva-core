import fs from 'fs/promises';
import crypto from 'crypto';

const STORE_VERSION = 1;
const MAX_RECORDS = 2000;
let writeQueue = Promise.resolve();

export const LUMIT_CONFIG = Object.freeze({
  product: 'LUMIT HOME',
  insurer: 'Mannheimer Versicherung AG',
  pool: 'blau direkt',
  calculatorUrl: 'https://energietechnikrechner.mannheimer.de/start/-/lumsr/antragsprozess?context=mp&md=162&asnr=58556&firmierung=blaudirekt&isFromStart=true',
  agency: Object.freeze({
    display: '162-58556',
    maklerdirektion: '162',
    agenturNummer: '58556',
    firmierung: 'blaudirekt',
  }),
  brokerNumber: '009T7N',
  servicedApplicationLabel: 'servicierter Antrag',
  submissionEmail: 'mdpool@mannheimer.de',
  trackingOwner: 'Hauswertschutz',
  policyDelivery: Object.freeze({
    mode: 'digital-via-broker',
    automaticCustomerForwardingAllowed: false,
    manualReviewRequired: true,
    customerPackageApprovalRequired: true,
    originalPolicyAttachmentRequired: true,
    customerEmailRequiredInApplication: true,
    insurerConfirmationRequired: true,
    specialAgreement: 'Police ausschliesslich digital ueber blau direkt/BiPRO an den Vermittler bereitstellen. Die Weiterleitung an den Versicherungsnehmer uebernimmt Hauswertschutz. Bitte bestaetigen, dass kein zusaetzlicher postalischer Policenversand erfolgt.',
  }),
  customerPackage: Object.freeze({
    primaryBrand: 'Hauswertschutz',
    presentation: 'compact-branded-package',
    totalPriceMayLead: true,
    readableContractAndPriceBreakdownRequired: true,
    originalMannheimerPolicyMustRemainUnchanged: true,
    insurerLogoOnBrandedPagesAllowed: false,
    priceConcealmentAllowed: false,
    defaultTrustBadges: Object.freeze([
      Object.freeze({ name: 'ProvenExpert-Top-Dienstleister-2025.jpg', year: 2025, source: 'supplied-by-user' }),
      Object.freeze({ name: 'ProvenExpert-Top-Empfehlung-2025.jpg', year: 2025, source: 'supplied-by-user' }),
    ]),
  }),
  servicePricing: Object.freeze({
    version: 'hauswertschutz-lumit-service-2026-08-06',
    currency: 'EUR',
    billingPeriod: 'annual',
    minimumStandaloneServiceFee: 99,
    photovoltaic: Object.freeze([
      Object.freeze({ id: 'compact', label: 'Kompakt', maxCapacity: 10, unit: 'kWp', annualServiceFee: 149 }),
      Object.freeze({ id: 'comfort', label: 'Komfort', maxCapacity: 20, unit: 'kWp', annualServiceFee: 199 }),
      Object.freeze({ id: 'premium', label: 'Premium', maxCapacity: 30, unit: 'kWp', annualServiceFee: 249 }),
    ]),
    batteryStandalone: Object.freeze([
      Object.freeze({ id: 'compact', label: 'Kompakt', maxCapacity: 10, unit: 'kWh', annualServiceFee: 99 }),
      Object.freeze({ id: 'comfort', label: 'Komfort', maxCapacity: 15, unit: 'kWh', annualServiceFee: 149 }),
      Object.freeze({ id: 'premium', label: 'Premium', maxCapacity: 20, unit: 'kWh', annualServiceFee: 199 }),
    ]),
    heatPump: Object.freeze([
      Object.freeze({ id: 'compact', label: 'Kompakt', maxCapacity: 10, unit: 'kW', annualServiceFee: 99 }),
      Object.freeze({ id: 'comfort', label: 'Komfort', maxCapacity: 20, unit: 'kW', annualServiceFee: 149 }),
      Object.freeze({ id: 'premium', label: 'Premium', maxCapacity: 30, unit: 'kW', annualServiceFee: 199 }),
    ]),
    batteryIncludedWithPhotovoltaic: true,
    missingBatteryDiscountAllowed: false,
    combinationRule: 'sum-active-service-components',
    exactMannheimerPremiumRequiredForTotal: true,
    offerSelection: Object.freeze({
      label: 'Hauswertschutz Energietechnik-Schutzpaket mit separat vermitteltem LUMIT-Versicherungsschutz hinzufügen',
      selectedState: 'requested',
      selectionConcludesInsuranceContract: false,
      paidConclusionRequiresSeparateCheckout: true,
    }),
  }),
  partnerIntake: Object.freeze({
    multipleOfferUploadAllowed: true,
    ivaCreatesApplicationDraft: true,
    partnerReviewRequired: true,
    officialPremiumSource: 'mannheimer-online-calculator',
    exactPremiumRequiredBeforePaidConclusion: true,
    automaticExternalPrefillAvailable: false,
    automaticExternalSubmissionAllowed: false,
    advisoryDocumentationFromReviewedData: true,
    checkoutButtonLabel: 'Jetzt kostenpflichtig abschliessen',
    checkoutConfirmations: Object.freeze([
      Object.freeze({
        id: 'insurance-documents',
        required: true,
        purpose: 'Bestaetigung, dass AVB, Produkt- und Pflichtinformationen vor der Vertragserklaerung bereitgestellt wurden.',
      }),
      Object.freeze({
        id: 'application-data',
        required: true,
        purpose: 'Bestaetigung der geprueften Antragsangaben und der fuer den Abschluss erforderlichen Datenuebermittlung.',
      }),
    ]),
    privacyNoticeSeparateFromOptionalConsent: true,
  }),
  startDate: Object.freeze({
    recommendedBasis: 'operational-readiness-date',
    modes: Object.freeze(['immediate', 'specified-date']),
    defaultMode: 'immediate',
    selectableByPartner: true,
    forceFirstOfMonth: false,
    calculatorAcceptsArbitraryDay: true,
    planningDefaultsDays: Object.freeze({
      photovoltaic: 14,
      heatPump: 42,
      combined: 42,
    }),
    planningDefaultsAreNonBinding: true,
    partnerConfirmationRequired: true,
    propertyCoverNotBeforeOperationalReadiness: true,
    montageCoverRequiresSeparateReview: true,
  }),
  homePdfSubmissionAllowed: false,
  homeSubmissionNote: 'LUMIT HOME wird ausschliesslich ueber den Mannheimer-Online-Rechner eingereicht. Das nach Abschluss erzeugte Antrags-PDF dient dem Nachprozess.',
});

const ALLOWED_STEPS = new Set([
  'emailSent',
  'qonektoServicedApplicationCreated',
  'qonektoDocumentUploaded',
  'trackingHandedOff',
  'policyDeliveryConfirmed',
  'policyReceivedDigitally',
  'policyReviewedByHauswertschutz',
  'customerPackageApproved',
  'customerPackageDelivered',
]);

function storeFile() {
  return `${process.env.DATA_DIR || '/data'}/lumit-applications.json`;
}

function emptyStore() {
  return { version: STORE_VERSION, applications: [] };
}

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function decimalNumber(value, label, { optional = false } = {}) {
  if ((value === '' || value === null || value === undefined) && optional) return null;
  const raw = String(value ?? '').trim().replace(/[^0-9,.-]/g, '');
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  const number = Number(normalized);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} fehlt oder ist ungueltig.`);
  return Math.round(number * 100) / 100;
}

function tierFor(capacity, tiers, label) {
  if (!(capacity > 0)) return null;
  const tier = tiers.find(item => capacity <= item.maxCapacity);
  if (!tier) throw new Error(`${label} liegt ausserhalb der fuer LUMIT HOME hinterlegten Produktgrenze.`);
  return tier;
}

function parseDateOnly(value, label) {
  const normalized = clean(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new Error(`${label} muss im Format JJJJ-MM-TT angegeben werden.`);
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new Error(`${label} ist kein gueltiges Datum.`);
  }
  return parsed;
}

function dateInBerlin(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

function normalizedTechnologies(input) {
  const values = Array.isArray(input) ? input : [input];
  const normalized = new Set();
  for (const value of values) {
    const item = clean(value, 80).toLocaleLowerCase('de-DE');
    if (/waermepumpe|w.rmepumpe|heat.?pump|\bwp\b/.test(item)) normalized.add('heatPump');
    if (/photovoltaik|solar|\bpv\b/.test(item)) normalized.add('photovoltaic');
  }
  return [...normalized];
}

function publicConfig() {
  return structuredClone(LUMIT_CONFIG);
}

async function loadStore() {
  try {
    const parsed = JSON.parse(await fs.readFile(storeFile(), 'utf8'));
    return {
      ...emptyStore(),
      ...parsed,
      applications: Array.isArray(parsed.applications) ? parsed.applications : [],
    };
  } catch {
    return emptyStore();
  }
}

async function saveStore(store) {
  const file = storeFile();
  const directory = file.slice(0, file.lastIndexOf('/')) || '.';
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(temporary, JSON.stringify(store, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function mutate(mutator) {
  let result;
  const job = writeQueue.catch(() => {}).then(async () => {
    const store = await loadStore();
    result = await mutator(store);
    store.applications = store.applications.slice(-MAX_RECORDS);
    await saveStore(store);
  });
  writeQueue = job.catch(() => {});
  await job;
  return result;
}

function deriveStatus(steps) {
  if (steps.customerPackageDelivered) return 'customer-package-delivered';
  if (steps.customerPackageApproved) return 'customer-delivery-approved';
  if (steps.policyReviewedByHauswertschutz) return 'customer-package-approval-required';
  if (steps.policyReceivedDigitally) return 'policy-review-required';
  if (steps.trackingHandedOff) return 'awaiting-policy';
  if (steps.emailSent && steps.qonektoServicedApplicationCreated && steps.qonektoDocumentUploaded) return 'ready-for-tracking';
  return 'post-processing';
}

function handoffFor(application) {
  const subject = `LUMIT Antrag ${application.customerName}${application.applicationNumber ? ` - ${application.applicationNumber}` : ''}`;
  const requestedStartLabel = application.requestedStartMode === 'immediate'
    ? 'sofort / naechstmoeglich'
    : application.requestedStartDate || 'nicht dokumentiert';
  const body = [
    'Guten Tag,',
    '',
    'anbei erhalten Sie den abgeschlossenen LUMIT-Antrag zur weiteren Bearbeitung.',
    '',
    `Versicherungsnehmer: ${application.customerName}`,
    `Blau-direkt-Agenturnummer: ${LUMIT_CONFIG.agency.display}`,
    `Vermittlernummer: ${LUMIT_CONFIG.brokerNumber}`,
    ...(application.applicationNumber ? [`Antragsnummer: ${application.applicationNumber}`] : []),
    `Gewuenschter Versicherungsbeginn: ${requestedStartLabel}`,
    ...(application.operationalReadinessDate ? [`Betriebsfertigkeit / Inbetriebnahme: ${application.operationalReadinessDate}`] : []),
    '',
    'Gewuenschter Policenversand:',
    LUMIT_CONFIG.policyDelivery.specialAgreement,
    '',
    'Der Vorgang wird bei blau direkt als servicierter Antrag zur zugehoerigen Kundenakte angelegt.',
    '',
    'Freundliche Gruesse',
    'Hauswertschutz',
  ].join('\n');
  return {
    to: LUMIT_CONFIG.submissionEmail,
    subject,
    body,
    mailto: `mailto:${encodeURIComponent(LUMIT_CONFIG.submissionEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
    qonekto: {
      customerId: application.customerId,
      label: LUMIT_CONFIG.servicedApplicationLabel,
      documentId: application.applicationDocumentId,
      documentName: application.applicationFileName,
      agencyNumber: LUMIT_CONFIG.agency.display,
      brokerNumber: LUMIT_CONFIG.brokerNumber,
      requestedStartMode: application.requestedStartMode || '',
      requestedStartDate: application.requestedStartDate || '',
      operationalReadinessDate: application.operationalReadinessDate || '',
      policyDeliveryMode: LUMIT_CONFIG.policyDelivery.mode,
      automaticCustomerForwardingAllowed: false,
      customerPackageApprovalRequired: true,
    },
  };
}

export function lumitWorkflowConfig() {
  return publicConfig();
}

export function calculateLumitPriceQuote(input = {}) {
  const photovoltaicKwp = decimalNumber(input.photovoltaicKwp, 'PV-Nennleistung', { optional: true }) || 0;
  const batteryKwh = decimalNumber(input.batteryKwh, 'Speicherkapazitaet', { optional: true }) || 0;
  const heatPumpKw = decimalNumber(input.heatPumpKw, 'Waermepumpen-Nennleistung', { optional: true }) || 0;
  if (!(photovoltaicKwp > 0 || batteryKwh > 0 || heatPumpKw > 0)) {
    throw new Error('Fuer die Preisberechnung muss mindestens eine Energietechnik angegeben werden.');
  }

  const pricing = LUMIT_CONFIG.servicePricing;
  const components = [];
  if (photovoltaicKwp > 0) {
    const tier = tierFor(photovoltaicKwp, pricing.photovoltaic, 'PV-Nennleistung');
    components.push({
      technology: 'photovoltaic',
      label: batteryKwh > 0 ? 'Photovoltaik inklusive Batteriespeicher-Service' : 'Photovoltaik',
      capacity: photovoltaicKwp,
      unit: tier.unit,
      tier: tier.id,
      tierLabel: tier.label,
      annualServiceFee: tier.annualServiceFee,
    });
    if (batteryKwh > pricing.batteryStandalone.at(-1).maxCapacity) {
      throw new Error('Speicherkapazitaet liegt ausserhalb der fuer LUMIT HOME hinterlegten Produktgrenze.');
    }
  } else if (batteryKwh > 0) {
    const tier = tierFor(batteryKwh, pricing.batteryStandalone, 'Speicherkapazitaet');
    components.push({
      technology: 'battery',
      label: 'Alleinstehender Batteriespeicher',
      capacity: batteryKwh,
      unit: tier.unit,
      tier: tier.id,
      tierLabel: tier.label,
      annualServiceFee: tier.annualServiceFee,
    });
  }
  if (heatPumpKw > 0) {
    const tier = tierFor(heatPumpKw, pricing.heatPump, 'Waermepumpen-Nennleistung');
    components.push({
      technology: 'heatPump',
      label: 'Waermepumpe',
      capacity: heatPumpKw,
      unit: tier.unit,
      tier: tier.id,
      tierLabel: tier.label,
      annualServiceFee: tier.annualServiceFee,
    });
  }

  const annualServiceFee = Math.round(components.reduce((sum, item) => sum + item.annualServiceFee, 0) * 100) / 100;
  const annualInsurancePremium = decimalNumber(input.mannheimerAnnualPremium, 'Mannheimer-Jahresbeitrag', { optional: true });
  const annualTotal = annualInsurancePremium === null
    ? null
    : Math.round((annualInsurancePremium + annualServiceFee) * 100) / 100;
  const selected = input.offerSelected === true;
  return {
    pricingVersion: pricing.version,
    currency: pricing.currency,
    billingPeriod: pricing.billingPeriod,
    components,
    storageRule: photovoltaicKwp > 0
      ? 'Ein Speicher am selben Versicherungsort ist im PV-Service enthalten. Fehlt der Speicher, reduziert sich das Serviceentgelt nicht.'
      : 'Ein alleinstehender Speicher wird nach seiner nutzbaren Kapazitaet berechnet.',
    combinationRule: 'Aktive Servicebausteine werden addiert; der Speicher wird bei vorhandener PV nicht doppelt berechnet.',
    annual: {
      insurancePremium: annualInsurancePremium,
      serviceFee: annualServiceFee,
      total: annualTotal,
    },
    monthlyEquivalent: annualTotal === null ? null : Math.round((annualTotal / 12) * 100) / 100,
    exactPremiumRequired: annualInsurancePremium === null,
    offerSelection: {
      label: pricing.offerSelection.label,
      selected,
      state: selected ? pricing.offerSelection.selectedState : 'not-selected',
      insuranceContractConcluded: false,
      nextStep: selected
        ? 'Antragsdaten, Vertragsunterlagen und Einwilligungen pruefen; danach separater kostenpflichtiger Abschluss.'
        : 'Kein LUMIT-Abschlussprozess gestartet.',
    },
  };
}

export function suggestLumitStartDate(input = {}) {
  const technologies = normalizedTechnologies(input.technologies);
  const explicitReadiness = clean(input.operationalReadinessDate, 10);
  const today = clean(input.today, 10) || dateInBerlin();
  parseDateOnly(today, 'Heutiges Datum');

  if (explicitReadiness) {
    parseDateOnly(explicitReadiness, 'Betriebsfertigkeit');
    return {
      suggestedDate: explicitReadiness,
      source: 'confirmed-operational-readiness',
      provisional: false,
      forceFirstOfMonth: false,
      partnerConfirmationRequired: true,
      note: 'Der bestaetigte Termin der Betriebsfertigkeit ist die fachliche Grundlage. Ein Beginn zum Monatsersten ist nicht vorgeschrieben.',
    };
  }

  if (input.alreadyOperational === true) {
    return {
      suggestedDate: today,
      source: 'already-operational-earliest-current-date',
      provisional: true,
      forceFirstOfMonth: false,
      partnerConfirmationRequired: true,
      note: 'Die Anlage ist bereits betriebsfertig. IVA schlaegt das aktuelle Datum vor; der im Mannheimer-Rechner zulaessige Beginn ist vor Abschluss zu kontrollieren. Keine rueckwirkende Deckung unterstellen.',
    };
  }

  const referenceValue = clean(input.referenceDate, 10) || today;
  const reference = parseDateOnly(referenceValue, 'Bezugsdatum');
  const hasHeatPump = technologies.includes('heatPump');
  const hasPhotovoltaic = technologies.includes('photovoltaic');
  if (!hasHeatPump && !hasPhotovoltaic) {
    return {
      suggestedDate: '',
      source: 'missing-technology-or-readiness-date',
      provisional: true,
      forceFirstOfMonth: false,
      partnerConfirmationRequired: true,
      note: 'Fuer einen Beginnvorschlag fehlen Technikart und bestaetigter Termin der Betriebsfertigkeit.',
    };
  }

  const offsetDays = hasHeatPump
    ? LUMIT_CONFIG.startDate.planningDefaultsDays.heatPump
    : LUMIT_CONFIG.startDate.planningDefaultsDays.photovoltaic;
  return {
    suggestedDate: addDays(reference, offsetDays),
    source: hasHeatPump && hasPhotovoltaic
      ? 'combined-non-binding-planning-default'
      : hasHeatPump
        ? 'heat-pump-non-binding-planning-default'
        : 'photovoltaic-non-binding-planning-default',
    offsetDays,
    provisional: true,
    forceFirstOfMonth: false,
    partnerConfirmationRequired: true,
    note: `Unverbindlicher Planwert: ${offsetDays} Tage nach dem Bezugsdatum. Vor Abschluss muss der Vertriebspartner den tatsaechlichen Termin der Betriebsfertigkeit bestaetigen oder korrigieren.`,
  };
}

export function validateLumitStartDate(input = {}) {
  const selected = parseDateOnly(input.selectedDate, 'Versicherungsbeginn');
  const todayValue = clean(input.today, 10) || dateInBerlin();
  const today = parseDateOnly(todayValue, 'Heutiges Datum');
  const readinessValue = clean(input.operationalReadinessDate, 10);
  const errors = [];
  const warnings = [];

  if (selected < today) errors.push('Ein rueckwirkender Versicherungsbeginn wird nicht automatisch zugelassen. Der Fall muss fachlich geprueft werden.');
  if (readinessValue) {
    const readiness = parseDateOnly(readinessValue, 'Betriebsfertigkeit');
    if (selected < readiness) {
      errors.push('Der Sachversicherungsschutz beginnt laut LUMIT-AVB nicht vor der Betriebsfertigkeit. Beginn auf den bestaetigten Termin oder spaeter setzen.');
    }
  } else {
    warnings.push('Der Termin der Betriebsfertigkeit ist noch nicht bestaetigt. Der Beginn bleibt ein Planwert.');
  }
  if (input.montageCoverRequested === true) {
    warnings.push('Montageschutz beginnt nach eigener Regel fruehestens mit dem Abladen am Versicherungsort und muss separat fachlich geprueft werden.');
  }

  return {
    valid: errors.length === 0,
    selectedDate: selected.toISOString().slice(0, 10),
    forceFirstOfMonth: false,
    errors,
    warnings,
  };
}

export async function listLumitApplications({ customerId = '', status = '', limit = 100 } = {}) {
  const store = await loadStore();
  return store.applications
    .filter(item => !customerId || item.customerId === clean(customerId, 180))
    .filter(item => !status || item.status === clean(status, 80))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)))
    .map(item => ({ ...structuredClone(item), handoff: handoffFor(item) }));
}

export async function getLumitApplication(id) {
  const store = await loadStore();
  const item = store.applications.find(entry => entry.id === clean(id, 180));
  return item ? { ...structuredClone(item), handoff: handoffFor(item) } : null;
}

export async function createLumitServicedApplication(input = {}) {
  if (input.completionConfirmed !== true) throw new Error('Der Mannheimer-Onlineabschluss muss zuerst ausdruecklich als abgeschlossen bestaetigt werden.');
  if (input.agencyNumberConfirmed !== true) throw new Error(`Die Blau-direkt-Agenturnummer ${LUMIT_CONFIG.agency.display} muss im Antrag kontrolliert werden.`);
  if (input.brokerNumberConfirmed !== true) throw new Error(`Die Vermittlernummer ${LUMIT_CONFIG.brokerNumber} muss im Antrag kontrolliert werden.`);
  if (input.policyDigitalDeliveryConsentConfirmed !== true) throw new Error('Die Einwilligung des Kunden zur digitalen Policenzustellung und Bereitstellung der Vertragsunterlagen muss dokumentiert werden.');

  const customerId = clean(input.customerId, 180);
  const customerName = clean(input.customerName, 300);
  const workspaceId = clean(input.workspaceId, 180);
  const applicationDocumentId = clean(input.applicationDocumentId, 180);
  const applicationFileName = clean(input.applicationFileName, 300);
  const applicationNumber = clean(input.applicationNumber, 180);
  const requestedStartMode = clean(input.requestedStartMode, 40);
  if (!LUMIT_CONFIG.startDate.modes.includes(requestedStartMode)) {
    throw new Error('Bitte Versicherungsbeginn als sofort / naechstmoeglich oder als bestimmtes Datum waehlen.');
  }
  const requestedStartDate = requestedStartMode === 'immediate'
    ? dateInBerlin()
    : clean(input.requestedStartDate, 10);
  const operationalReadinessDate = clean(input.operationalReadinessDate, 10);
  const startValidation = validateLumitStartDate({
    selectedDate: requestedStartDate,
    operationalReadinessDate,
  });
  if (!startValidation.valid) throw new Error(startValidation.errors.join(' '));
  if (!customerId) throw new Error('Die Qonekto-/Blau-direkt-Kunden-ID fehlt.');
  if (!customerName) throw new Error('Der Name des Versicherungsnehmers fehlt.');
  if (!workspaceId) throw new Error('Die IVA-Kundenakte fehlt.');
  if (!applicationDocumentId || !applicationFileName) throw new Error('Das nach Abschluss erzeugte Antrags-PDF muss zuerst in der IVA-Kundenakte abgelegt werden.');
  if (!/\.pdf$/i.test(applicationFileName)) throw new Error('Als LUMIT-Antrag wird ausschliesslich das erzeugte PDF akzeptiert.');

  return mutate(store => {
    const duplicate = store.applications.find(item =>
      item.customerId === customerId
      && (item.applicationDocumentId === applicationDocumentId || (applicationNumber && item.applicationNumber === applicationNumber))
    );
    if (duplicate) return { ...structuredClone(duplicate), duplicate: true, handoff: handoffFor(duplicate) };

    const now = new Date().toISOString();
    const item = {
      id: crypto.randomUUID(),
      type: 'lumit-serviced-application',
      label: LUMIT_CONFIG.servicedApplicationLabel,
      product: LUMIT_CONFIG.product,
      customerId,
      customerName,
      workspaceId,
      partnerId: clean(input.partnerId, 180),
      applicationNumber,
      applicationDocumentId,
      applicationFileName,
      requestedStartMode,
      requestedStartDate,
      operationalReadinessDate,
      startDateWarnings: startValidation.warnings,
      agencyNumber: LUMIT_CONFIG.agency.display,
      brokerNumber: LUMIT_CONFIG.brokerNumber,
      submissionEmail: LUMIT_CONFIG.submissionEmail,
      policyDeliveryMode: LUMIT_CONFIG.policyDelivery.mode,
      policyDeliveryInstruction: LUMIT_CONFIG.policyDelivery.specialAgreement,
      automaticCustomerForwardingAllowed: false,
      customerPackageApprovalRequired: true,
      originalPolicyAttachmentRequired: true,
      status: 'post-processing',
      steps: {
        onlineApplicationCompleted: true,
        agencyNumberChecked: true,
        brokerNumberChecked: true,
        applicationPdfStoredInIva: true,
        emailSent: false,
        qonektoServicedApplicationCreated: false,
        qonektoDocumentUploaded: false,
        trackingHandedOff: false,
        policyDeliveryConfirmed: false,
        policyReceivedDigitally: false,
        policyReviewedByHauswertschutz: false,
        customerPackageApproved: false,
        customerPackageDelivered: false,
      },
      note: clean(input.note, 1200),
      createdAt: now,
      updatedAt: now,
    };
    store.applications.push(item);
    return { ...structuredClone(item), duplicate: false, handoff: handoffFor(item) };
  });
}

export async function attachLumitCustomerPackage(id, input = {}) {
  const policyDocumentId = clean(input.policyDocumentId, 180);
  const policyFileName = clean(input.policyFileName, 300);
  const policySha256 = clean(input.policySha256, 80);
  const packageDocumentId = clean(input.packageDocumentId, 180);
  const packageFileName = clean(input.packageFileName, 300);
  if (!policyDocumentId || !/\.pdf$/i.test(policyFileName)) throw new Error('Die unveraenderte Mannheimer-Originalpolice fehlt.');
  if (!packageDocumentId || !/\.pdf$/i.test(packageFileName)) throw new Error('Das Hauswertschutz-Kundenpaket fehlt.');
  if (input.policyReviewedByHauswertschutz !== true) throw new Error('Die Police muss vor der Paketerstellung durch Hauswertschutz geprueft werden.');

  return mutate(store => {
    const item = store.applications.find(entry => entry.id === clean(id, 180));
    if (!item) return null;
    item.originalPolicy = {
      documentId: policyDocumentId,
      fileName: policyFileName,
      sha256: policySha256,
      storedUnchanged: true,
    };
    item.customerPackage = {
      documentId: packageDocumentId,
      fileName: packageFileName,
      totalPrice: clean(input.totalPrice, 80),
      insurancePremium: clean(input.insurancePremium, 80),
      serviceFee: clean(input.serviceFee, 80),
      billingPeriod: clean(input.billingPeriod, 80),
      customerSalutation: clean(input.customerSalutation, 60),
      insuredTechnologies: clean(input.insuredTechnologies, 500),
      coverageProfile: {
        propertyInsuranceIncluded: input.propertyInsuranceIncluded === true,
        propertyHazardsIncluded: input.propertyHazardsIncluded === true,
        yieldLossIncluded: input.yieldLossIncluded === true,
        operatorLiabilityIncluded: input.operatorLiabilityIncluded === true,
        assemblyCoverIncluded: input.assemblyCoverIncluded === true,
        officialScopeConfirmed: input.officialScopeConfirmed === true,
      },
      claimsContact: {
        whatsapp: clean(input.claimsWhatsapp, 80),
        email: clean(input.claimsEmail, 160),
        availability: clean(input.claimsAvailability, 120),
        serviceHours: clean(input.claimsServiceHours, 140),
        channelsReady: input.claimsChannelsReady === true,
      },
      insurerLogoIncluded: input.insurerLogoIncluded === true,
      insurerLogoUsageApproved: input.insurerLogoIncluded === true && input.insurerLogoUsageApproved === true,
      trustBadgeFileNames: Array.isArray(input.trustBadgeFileNames)
        ? input.trustBadgeFileNames.map(name => clean(name, 240)).filter(Boolean).slice(0, 3)
        : LUMIT_CONFIG.customerPackage.defaultTrustBadges.map(item => item.name),
      originalPolicyIncludedUnchanged: true,
      generatedAt: new Date().toISOString(),
    };
    item.steps.policyReceivedDigitally = true;
    item.steps.policyReviewedByHauswertschutz = true;
    item.steps.customerPackageApproved = false;
    item.steps.customerPackageDelivered = false;
    item.status = deriveStatus(item.steps);
    item.updatedAt = new Date().toISOString();
    return { ...structuredClone(item), handoff: handoffFor(item) };
  });
}

export async function markLumitApplicationStep(id, step, completed = true) {
  const normalizedStep = clean(step, 100);
  if (!ALLOWED_STEPS.has(normalizedStep)) throw new Error('Dieser LUMIT-Nachprozess-Schritt ist nicht freigegeben.');
  return mutate(store => {
    const item = store.applications.find(entry => entry.id === clean(id, 180));
    if (!item) return null;
    if (completed === true && normalizedStep === 'policyReviewedByHauswertschutz' && !item.steps.policyReceivedDigitally) {
      throw new Error('Die Police muss zuerst digital eingegangen sein.');
    }
    if (completed === true && normalizedStep === 'customerPackageApproved' && (!item.steps.policyReviewedByHauswertschutz || !item.customerPackage?.documentId)) {
      throw new Error('Vor der Freigabe muss das Hauswertschutz-Kundenpaket erstellt und geprueft sein.');
    }
    if (completed === true && normalizedStep === 'customerPackageDelivered' && !item.steps.customerPackageApproved) {
      throw new Error('Das Kundenpaket muss vor der Bereitstellung ausdruecklich freigegeben sein.');
    }
    item.steps[normalizedStep] = completed === true;
    item.status = deriveStatus(item.steps);
    item.updatedAt = new Date().toISOString();
    return { ...structuredClone(item), handoff: handoffFor(item) };
  });
}
