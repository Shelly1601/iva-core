import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createLumitCustomerPackagePdf } from '../integrations/lumit-package.js';

async function createOriginalPolicySample() {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const page = pdf.addPage([595.28, 841.89]);
  page.drawText('MANNHEIMER VERSICHERUNG AG', { x: 54, y: 770, font: bold, size: 18, color: rgb(29 / 255, 43 / 255, 63 / 255) });
  page.drawText('LUMIT Versicherungsschein - MUSTER, keine echte Police', { x: 54, y: 744, font: regular, size: 11, color: rgb(92 / 255, 108 / 255, 130 / 255) });
  page.drawText('Versicherungsnehmer: Erika Mustermann', { x: 54, y: 680, font: regular, size: 10.5 });
  page.drawText('Versicherungsscheinnummer: VS-MUSTER-2026', { x: 54, y: 661, font: regular, size: 10.5 });
  page.drawText('Versicherungsbeitrag: 19,90 EUR monatlich', { x: 54, y: 642, font: regular, size: 10.5 });
  page.drawText('Diese Seite simuliert ausschließlich eine unveränderte Gesellschaftspolice für die visuelle Prüfung.', { x: 54, y: 585, font: regular, size: 9, color: rgb(92 / 255, 108 / 255, 130 / 255) });
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

const outputDirectory = path.resolve('output/pdf');
await fs.mkdir(outputDirectory, { recursive: true });
const outputFile = path.join(outputDirectory, 'Hauswertschutz-Energietechnik-Kundenpaket-Muster.pdf');
const originalPolicyBuffer = await createOriginalPolicySample();
const packageBuffer = await createLumitCustomerPackagePdf({
  customerName: 'Erika Mustermann',
  policyNumber: 'VS-MUSTER-2026',
  totalPrice: '29,90',
  insurancePremium: '19,90',
  serviceFee: '10,00',
  billingPeriod: 'monatlich',
  servicePackageName: 'Hauswertschutz Komfort-Service',
  customerSalutation: 'frau',
  insuredTechnologies: ['Photovoltaikanlage', 'Batteriespeicher', 'Wärmepumpe'],
  propertyInsuranceIncluded: true,
  propertyHazardsIncluded: true,
  yieldLossIncluded: true,
  operatorLiabilityIncluded: false,
  assemblyCoverIncluded: true,
  officialScopeConfirmed: true,
  servicePhone: '02183 3989753',
  serviceEmail: 'info@hauswertschutz.de',
  serviceAddress: 'Olfenweg 12, 41569 Rommerskirchen',
  claimsWhatsapp: '+49 XXX XXXXXXX',
  claimsEmail: 'schaden@IHRE-DOMAIN.de',
  claimsAvailability: 'Digital rund um die Uhr einreichen',
  claimsServiceHours: 'Persönliche Rückmeldung: [SERVICEZEITEN]',
  claimsChannelsReady: false,
  insuranceStartDate: 'sofort / nächstmöglich',
  originalPolicyBuffer,
  originalPolicyFileName: 'Mannheimer-LUMIT-Police-Muster.pdf',
  isSample: true,
});
await fs.writeFile(outputFile, packageBuffer);
console.log(outputFile);
