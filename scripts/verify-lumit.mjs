import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const oldDataDir = process.env.DATA_DIR;
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-lumit-'));
process.env.DATA_DIR = directory;

const {
  attachLumitCustomerPackage,
  calculateLumitPriceQuote,
  createLumitServicedApplication,
  getLumitApplication,
  listLumitApplications,
  lumitWorkflowConfig,
  markLumitApplicationStep,
  suggestLumitStartDate,
  validateLumitStartDate,
} = await import('../integrations/lumit.js');
const { createLumitCustomerPackagePdf } = await import('../integrations/lumit-package.js');

const config = lumitWorkflowConfig();
assert.equal(config.agency.display, '162-58556');
assert.equal(config.agency.maklerdirektion, '162');
assert.equal(config.agency.agenturNummer, '58556');
assert.equal(config.brokerNumber, '009T7N');
assert.equal(config.submissionEmail, 'mdpool@mannheimer.de');
assert.equal(config.servicedApplicationLabel, 'servicierter Antrag');
assert.equal(config.homePdfSubmissionAllowed, false);
assert.equal(config.policyDelivery.mode, 'digital-via-broker');
assert.equal(config.policyDelivery.automaticCustomerForwardingAllowed, false);
assert.equal(config.policyDelivery.manualReviewRequired, true);
assert.equal(config.policyDelivery.customerPackageApprovalRequired, true);
assert.equal(config.policyDelivery.insurerConfirmationRequired, true);
assert.equal(config.customerPackage.primaryBrand, 'Hauswertschutz');
assert.equal(config.customerPackage.totalPriceMayLead, true);
assert.equal(config.customerPackage.readableContractAndPriceBreakdownRequired, true);
assert.equal(config.customerPackage.priceConcealmentAllowed, false);
assert.equal(config.customerPackage.insurerLogoOnBrandedPagesAllowed, false);
assert.equal(config.customerPackage.defaultTrustBadges.length, 2);
assert.equal(config.servicePricing.minimumStandaloneServiceFee, 99);
assert.equal(config.servicePricing.missingBatteryDiscountAllowed, false);
assert.equal(config.servicePricing.offerSelection.selectionConcludesInsuranceContract, false);
assert.equal(config.partnerIntake.multipleOfferUploadAllowed, true);
assert.equal(config.partnerIntake.partnerReviewRequired, true);
assert.equal(config.partnerIntake.exactPremiumRequiredBeforePaidConclusion, true);
assert.equal(config.partnerIntake.automaticExternalSubmissionAllowed, false);
assert.equal(config.partnerIntake.checkoutConfirmations.length, 2);
assert.equal(config.startDate.recommendedBasis, 'operational-readiness-date');
assert.equal(config.startDate.forceFirstOfMonth, false);
assert.equal(config.startDate.planningDefaultsDays.photovoltaic, 14);
assert.equal(config.startDate.planningDefaultsDays.heatPump, 42);
assert.match(config.calculatorUrl, /md=162/);
assert.match(config.calculatorUrl, /asnr=58556/);

const pvQuote = calculateLumitPriceQuote({ photovoltaicKwp: 8, batteryKwh: 8, mannheimerAnnualPremium: '148,75', offerSelected: true });
assert.equal(pvQuote.annual.serviceFee, 149);
assert.equal(pvQuote.annual.total, 297.75);
assert.equal(pvQuote.offerSelection.state, 'requested');
assert.equal(pvQuote.offerSelection.insuranceContractConcluded, false);

const heatPumpQuote = calculateLumitPriceQuote({ heatPumpKw: 8, mannheimerAnnualPremium: '113,05' });
assert.equal(heatPumpQuote.annual.serviceFee, 99);
assert.equal(heatPumpQuote.annual.total, 212.05);

const standaloneBatteryQuote = calculateLumitPriceQuote({ batteryKwh: 18, mannheimerAnnualPremium: '89,25' });
assert.equal(standaloneBatteryQuote.annual.serviceFee, 199);
assert.equal(standaloneBatteryQuote.annual.total, 288.25);

const combinedQuote = calculateLumitPriceQuote({ photovoltaicKwp: 15, batteryKwh: 15, heatPumpKw: 15, mannheimerAnnualPremium: '321,30' });
assert.equal(combinedQuote.annual.serviceFee, 348);
assert.equal(combinedQuote.annual.total, 669.3);
assert.equal(combinedQuote.components.length, 2);

const quoteWithoutPremium = calculateLumitPriceQuote({ photovoltaicKwp: 30, batteryKwh: 20 });
assert.equal(quoteWithoutPremium.annual.serviceFee, 249);
assert.equal(quoteWithoutPremium.annual.total, null);
assert.equal(quoteWithoutPremium.exactPremiumRequired, true);

assert.throws(() => calculateLumitPriceQuote({}), /mindestens eine Energietechnik/);
assert.throws(() => calculateLumitPriceQuote({ photovoltaicKwp: 31 }), /Produktgrenze/);

assert.deepEqual(
  suggestLumitStartDate({ technologies: ['PV'], referenceDate: '2026-08-06', today: '2026-08-06' }),
  {
    suggestedDate: '2026-08-20',
    source: 'photovoltaic-non-binding-planning-default',
    offsetDays: 14,
    provisional: true,
    forceFirstOfMonth: false,
    partnerConfirmationRequired: true,
    note: 'Unverbindlicher Planwert: 14 Tage nach dem Bezugsdatum. Vor Abschluss muss der Vertriebspartner den tatsaechlichen Termin der Betriebsfertigkeit bestaetigen oder korrigieren.',
  },
);
assert.equal(suggestLumitStartDate({ technologies: ['Waermepumpe'], referenceDate: '2026-08-06', today: '2026-08-06' }).suggestedDate, '2026-09-17');
assert.equal(suggestLumitStartDate({ technologies: ['PV', 'WP'], referenceDate: '2026-08-06', today: '2026-08-06' }).offsetDays, 42);
assert.equal(suggestLumitStartDate({ technologies: ['PV'], operationalReadinessDate: '2026-09-15', today: '2026-08-06' }).suggestedDate, '2026-09-15');
assert.equal(validateLumitStartDate({ selectedDate: '2026-09-15', operationalReadinessDate: '2026-09-15', today: '2026-08-06' }).valid, true);
assert.equal(validateLumitStartDate({ selectedDate: '2026-09-01', operationalReadinessDate: '2026-09-15', today: '2026-08-06' }).valid, false);

await assert.rejects(
  () => createLumitServicedApplication({}),
  /Onlineabschluss/,
);

const input = {
  customerId: 'K-100',
  customerName: 'Testkundin Muster',
  workspaceId: 'W-100',
  applicationDocumentId: 'D-100',
  applicationFileName: 'LUMIT-Antrag-Testkundin.pdf',
  applicationNumber: 'A-100',
  requestedStartMode: 'specified-date',
  requestedStartDate: '2099-09-15',
  operationalReadinessDate: '2099-09-15',
  completionConfirmed: true,
  agencyNumberConfirmed: true,
  brokerNumberConfirmed: true,
  policyDigitalDeliveryConsentConfirmed: true,
};

const created = await createLumitServicedApplication(input);
assert.equal(created.duplicate, false);
assert.equal(created.status, 'post-processing');
assert.equal(created.agencyNumber, '162-58556');
assert.equal(created.brokerNumber, '009T7N');
assert.equal(created.handoff.to, 'mdpool@mannheimer.de');
assert.equal(created.handoff.qonekto.label, 'servicierter Antrag');
assert.match(created.handoff.body, /009T7N/);
assert.match(created.handoff.body, /Policenversand/);
assert.equal(created.policyDeliveryMode, 'digital-via-broker');
assert.equal(created.automaticCustomerForwardingAllowed, false);
assert.equal(created.customerPackageApprovalRequired, true);
assert.equal(created.requestedStartMode, 'specified-date');
assert.equal(created.requestedStartDate, '2099-09-15');

const duplicate = await createLumitServicedApplication(input);
assert.equal(duplicate.duplicate, true);
assert.equal(duplicate.id, created.id);

const immediate = await createLumitServicedApplication({
  ...input,
  customerId: 'K-101',
  customerName: 'Testkunde Sofort',
  applicationDocumentId: 'D-101',
  applicationFileName: 'LUMIT-Antrag-Sofort.pdf',
  applicationNumber: 'A-101',
  requestedStartMode: 'immediate',
  requestedStartDate: '',
  operationalReadinessDate: '',
});
assert.equal(immediate.requestedStartMode, 'immediate');
assert.match(immediate.requestedStartDate, /^\d{4}-\d{2}-\d{2}$/);
assert.match(immediate.handoff.body, /sofort \/ naechstmoeglich/);

await assert.rejects(
  () => createLumitServicedApplication({
    ...input,
    customerId: 'K-102',
    applicationDocumentId: 'D-102',
    applicationFileName: 'LUMIT-Antrag-Zu-Frueh.pdf',
    applicationNumber: 'A-102',
    requestedStartMode: 'immediate',
    operationalReadinessDate: '2099-12-31',
  }),
  /nicht vor der Betriebsfertigkeit/,
);

for (const step of ['emailSent', 'qonektoServicedApplicationCreated', 'qonektoDocumentUploaded']) {
  await markLumitApplicationStep(created.id, step, true);
}
const ready = await getLumitApplication(created.id);
assert.equal(ready.status, 'ready-for-tracking');

const handedOff = await markLumitApplicationStep(created.id, 'trackingHandedOff', true);
assert.equal(handedOff.status, 'awaiting-policy');
await markLumitApplicationStep(created.id, 'policyDeliveryConfirmed', true);
const policyReceived = await markLumitApplicationStep(created.id, 'policyReceivedDigitally', true);
assert.equal(policyReceived.status, 'policy-review-required');
await assert.rejects(
  () => markLumitApplicationStep(created.id, 'customerPackageApproved', true),
  /Kundenpaket/,
);

const originalPdf = await PDFDocument.create();
const originalFont = await originalPdf.embedFont(StandardFonts.Helvetica);
const originalPage = originalPdf.addPage([595.28, 841.89]);
originalPage.drawText('ORIGINALPOLICE MANNHEIMER - MUSTER', { x: 48, y: 760, font: originalFont, size: 16 });
const originalPolicyBuffer = Buffer.from(await originalPdf.save());
const packageBuffer = await createLumitCustomerPackagePdf({
  customerName: 'Testkundin Muster',
  policyNumber: 'VS-TEST-100',
  totalPrice: '29,90',
  insurancePremium: '19,90',
  serviceFee: '10,00',
  billingPeriod: 'monatlich',
  officialScopeConfirmed: true,
  originalPolicyBuffer,
  originalPolicyFileName: 'Mannheimer-Police-Muster.pdf',
});
assert.equal(packageBuffer.subarray(0, 4).toString(), '%PDF');
assert.equal((await PDFDocument.load(packageBuffer)).getPageCount(), 10);

const policyReviewed = await attachLumitCustomerPackage(created.id, {
  policyDocumentId: 'POL-100',
  policyFileName: 'Mannheimer-Police-Muster.pdf',
  policySha256: 'abc123',
  packageDocumentId: 'PKG-100',
  packageFileName: 'Hauswertschutz-LUMIT-Kundenpaket-Test.pdf',
  totalPrice: '29,90',
  insurancePremium: '19,90',
  serviceFee: '10,00',
  billingPeriod: 'monatlich',
  claimsWhatsapp: '+49 000 000000',
  claimsEmail: 'schaden@example.invalid',
  claimsAvailability: 'Digital rund um die Uhr einreichen',
  claimsServiceHours: 'Mo-Fr, 09:00-17:00 Uhr',
  claimsChannelsReady: false,
  policyReviewedByHauswertschutz: true,
});
assert.equal(policyReviewed.status, 'customer-package-approval-required');
assert.equal(policyReviewed.originalPolicy.storedUnchanged, true);
assert.equal(policyReviewed.customerPackage.originalPolicyIncludedUnchanged, true);
assert.equal(policyReviewed.customerPackage.claimsContact.whatsapp, '+49 000 000000');
assert.equal(policyReviewed.customerPackage.claimsContact.channelsReady, false);
assert.equal(policyReviewed.customerPackage.trustBadgeFileNames.length, 2);
const packageApproved = await markLumitApplicationStep(created.id, 'customerPackageApproved', true);
assert.equal(packageApproved.status, 'customer-delivery-approved');
const packageDelivered = await markLumitApplicationStep(created.id, 'customerPackageDelivered', true);
assert.equal(packageDelivered.status, 'customer-package-delivered');
assert.equal((await listLumitApplications({ customerId: 'K-100' })).length, 1);

await assert.rejects(
  () => markLumitApplicationStep(created.id, 'sendEverything', true),
  /nicht freigegeben/,
);

await fs.rm(directory, { recursive: true, force: true });
if (oldDataDir === undefined) delete process.env.DATA_DIR;
else process.env.DATA_DIR = oldDataDir;

console.log('✓ LUMIT-Konfiguration, Idempotenz und Nachprozess verifiziert');
