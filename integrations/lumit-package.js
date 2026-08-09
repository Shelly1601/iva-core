import crypto from 'crypto';
import fs from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { defaultLumitTrustBadges } from './lumit-trust-assets.js';

const A4 = [595.28, 841.89];
const NAVY = rgb(14 / 255, 27 / 255, 48 / 255);
const BLUE = rgb(79 / 255, 143 / 255, 247 / 255);
const PALE_BLUE = rgb(232 / 255, 240 / 255, 253 / 255);
const PAPER = rgb(249 / 255, 247 / 255, 240 / 255);
const PAPER_DEEP = rgb(241 / 255, 236 / 255, 224 / 255);
const GOLD = rgb(190 / 255, 155 / 255, 80 / 255);
const COPPER = rgb(214 / 255, 153 / 255, 70 / 255);
const GOLD_DARK = rgb(128 / 255, 96 / 255, 42 / 255);
const BURGUNDY = rgb(103 / 255, 25 / 255, 38 / 255);
const SAGE = rgb(63 / 255, 105 / 255, 91 / 255);
const WHITE = rgb(1, 1, 1);
const INK = rgb(29 / 255, 43 / 255, 63 / 255);
const MUTED = rgb(92 / 255, 108 / 255, 130 / 255);
const LINE = rgb(214 / 255, 222 / 255, 233 / 255);
const SOFT = rgb(247 / 255, 249 / 255, 252 / 255);

function clean(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function moneyNumber(value, label) {
  const raw = String(value ?? '').trim().replace(/[^0-9,.-]/g, '');
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  const number = Number(normalized);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} fehlt oder ist ungueltig.`);
  return Math.round(number * 100) / 100;
}

function euro(value) {
  return `${value.toFixed(2).replace('.', ',')} EUR`;
}

function wrap(text, font, size, maxWidth) {
  const words = clean(text, 5000).split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (!line || font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawWrapped(page, text, options) {
  const { x, y, width, font, size, color = INK, lineHeight = size * 1.35, maxLines = 20 } = options;
  const lines = wrap(text, font, size, width).slice(0, maxLines);
  lines.forEach((line, index) => page.drawText(line, { x, y: y - index * lineHeight, font, size, color }));
  return y - lines.length * lineHeight;
}

function drawFooter(page, regular, label) {
  page.drawLine({ start: { x: 48, y: 40 }, end: { x: A4[0] - 48, y: 40 }, thickness: 0.7, color: LINE });
  page.drawText(label, { x: 48, y: 23, font: regular, size: 8.5, color: MUTED });
}

function drawShieldCheck(page, x, y, size, color = GOLD, mutedFill = null) {
  const points = [
    [x, y + size * 0.48],
    [x + size * 0.36, y + size * 0.31],
    [x + size * 0.34, y - size * 0.08],
    [x + size * 0.22, y - size * 0.31],
    [x, y - size * 0.49],
    [x - size * 0.22, y - size * 0.31],
    [x - size * 0.34, y - size * 0.08],
    [x - size * 0.36, y + size * 0.31],
  ];
  if (mutedFill) {
    page.drawRectangle({
      x: x - size * 0.28,
      y: y - size * 0.31,
      width: size * 0.56,
      height: size * 0.58,
      color: mutedFill,
      opacity: 0.22,
    });
  }
  for (let index = 0; index < points.length; index += 1) {
    const next = (index + 1) % points.length;
    page.drawLine({
      start: { x: points[index][0], y: points[index][1] },
      end: { x: points[next][0], y: points[next][1] },
      thickness: Math.max(1.2, size * 0.045),
      color,
    });
  }
  page.drawLine({
    start: { x: x - size * 0.17, y: y - size * 0.01 },
    end: { x: x - size * 0.04, y: y - size * 0.15 },
    thickness: Math.max(1.4, size * 0.055),
    color,
  });
  page.drawLine({
    start: { x: x - size * 0.04, y: y - size * 0.15 },
    end: { x: x + size * 0.2, y: y + size * 0.14 },
    thickness: Math.max(1.4, size * 0.055),
    color,
  });
}

function drawBrandWordmark(page, x, y, font, size, options = {}) {
  const light = options.light === true;
  const mainColor = light ? WHITE : NAVY;
  const goldColor = light ? COPPER : GOLD_DARK;
  page.drawText('Haus', { x, y, font, size, color: mainColor });
  let cursor = x + font.widthOfTextAtSize('Haus', size);
  page.drawText('Wert', { x: cursor, y, font, size, color: goldColor });
  cursor += font.widthOfTextAtSize('Wert', size);
  page.drawText('Schutz', { x: cursor, y, font, size, color: mainColor });
}

function drawValueCard(page, x, y, width, height, kicker, value, text, regular, bold, accent = GOLD_DARK) {
  page.drawRectangle({ x, y, width, height, color: WHITE, borderColor: rgb(0.84, 0.8, 0.69), borderWidth: 0.65 });
  page.drawRectangle({ x, y: y + height - 4, width, height: 4, color: accent });
  page.drawText(clean(kicker, 80).toUpperCase(), { x: x + 16, y: y + height - 26, font: bold, size: 7.5, color: accent });
  const valueText = clean(value, 80);
  const valueSize = valueText.length > 14 || width < 180 ? 14 : 20;
  page.drawText(valueText, { x: x + 16, y: y + height - 57, font: bold, size: valueSize, color: NAVY });
  drawWrapped(page, text, { x: x + 16, y: y + height - 78, width: width - 32, font: regular, size: 8.4, color: MUTED, lineHeight: 11.2, maxLines: 4 });
}

function drawCentered(page, text, { y, font, size, color = INK }) {
  const value = clean(text, 1000);
  const x = (A4[0] - font.widthOfTextAtSize(value, size)) / 2;
  page.drawText(value, { x, y, font, size, color });
}

function drawCertificateFrame(page) {
  page.drawRectangle({ x: 21, y: 21, width: A4[0] - 42, height: A4[1] - 42, borderColor: GOLD_DARK, borderWidth: 1.25 });
  page.drawRectangle({ x: 27, y: 27, width: A4[0] - 54, height: A4[1] - 54, borderColor: GOLD, borderWidth: 0.55 });
  const corners = [
    [27, A4[1] - 27, 1, -1], [A4[0] - 27, A4[1] - 27, -1, -1],
    [27, 27, 1, 1], [A4[0] - 27, 27, -1, 1],
  ];
  for (const [x, y, dx, dy] of corners) {
    page.drawLine({ start: { x, y }, end: { x: x + dx * 23, y }, thickness: 2.2, color: GOLD_DARK });
    page.drawLine({ start: { x, y }, end: { x, y: y + dy * 23 }, thickness: 2.2, color: GOLD_DARK });
  }
}

function drawHouseSeal(page, serifBold) {
  const cx = A4[0] / 2;
  const cy = 728;
  page.drawCircle({ x: cx, y: cy, size: 32, color: PAPER, borderColor: GOLD, borderWidth: 1.5 });
  page.drawCircle({ x: cx, y: cy, size: 27, borderColor: GOLD, borderWidth: 0.65 });
  page.drawLine({ start: { x: cx - 14, y: cy + 1 }, end: { x: cx, y: cy + 13 }, thickness: 1.5, color: GOLD_DARK });
  page.drawLine({ start: { x: cx, y: cy + 13 }, end: { x: cx + 14, y: cy + 1 }, thickness: 1.5, color: GOLD_DARK });
  page.drawRectangle({ x: cx - 10, y: cy - 13, width: 20, height: 15, borderColor: GOLD_DARK, borderWidth: 1.2 });
  page.drawText('H', { x: cx - 6.8, y: cy - 8, font: serifBold, size: 13, color: BURGUNDY });
}

function drawServiceMedallion(page, x, y, title, subtitle, regular, bold, color) {
  page.drawCircle({ x, y, size: 18, color: PAPER, borderColor: color, borderWidth: 1.1 });
  page.drawCircle({ x, y, size: 12, borderColor: color, borderWidth: 0.65 });
  page.drawLine({ start: { x: x - 5, y }, end: { x: x - 1, y: y - 5 }, thickness: 1.6, color });
  page.drawLine({ start: { x: x - 1, y: y - 5 }, end: { x: x + 7, y: y + 6 }, thickness: 1.6, color });
  page.drawText(title, { x: x + 28, y: y + 3, font: bold, size: 8.5, color: INK });
  page.drawText(subtitle, { x: x + 28, y: y - 9, font: regular, size: 7.4, color: MUTED });
}

async function drawTrustBadges(pdf, page, badges, regular, bold) {
  const valid = (Array.isArray(badges) ? badges : [])
    .filter(item => Buffer.isBuffer(item?.buffer) && item.buffer.length)
    .slice(0, 3);
  if (!valid.length) {
    drawServiceMedallion(page, 106, 112, 'PERSÖNLICH', 'Zentrale Betreuung', regular, bold, GOLD_DARK);
    drawServiceMedallion(page, 267, 112, 'DOKUMENTIERT', 'Geordnete Kundenakte', regular, bold, SAGE);
    drawServiceMedallion(page, 432, 112, 'SCHADENHILFE', 'Strukturierte Aufnahme', regular, bold, BURGUNDY);
    return;
  }
  const box = valid.length === 1 ? 104 : 88;
  const gap = 17;
  const total = valid.length * box + (valid.length - 1) * gap;
  let x = (A4[0] - total) / 2;
  for (const badge of valid) {
    const mime = clean(badge.mime, 80).toLowerCase();
    const image = mime.includes('png') ? await pdf.embedPng(badge.buffer) : await pdf.embedJpg(Uint8Array.from(badge.buffer));
    const scale = Math.min((box - 8) / image.width, (box - 8) / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    page.drawRectangle({ x, y: 66, width: box, height: box, color: WHITE, borderColor: rgb(0.83, 0.79, 0.67), borderWidth: 0.55 });
    page.drawImage(image, { x: x + (box - width) / 2, y: 66 + (box - height) / 2, width, height });
    x += box + gap;
  }
}

function normalizeList(value, fallback = []) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[,;\n]/);
  const cleaned = values.map(item => clean(item, 140)).filter(Boolean).slice(0, 8);
  return cleaned.length ? cleaned : fallback;
}

function customerGreeting(customerName, salutation) {
  const normalized = clean(salutation, 60).toLowerCase();
  if (normalized === 'frau') return `Sehr geehrte Frau ${customerName},`;
  if (normalized === 'herr') return `Sehr geehrter Herr ${customerName},`;
  return `Guten Tag ${customerName},`;
}

function drawPageHeader(page, title, kicker, regular, bold, options = {}) {
  page.drawRectangle({ x: 0, y: 0, width: A4[0], height: A4[1], color: PAPER });
  page.drawRectangle({ x: 0, y: 739, width: A4[0], height: 103, color: NAVY });
  page.drawRectangle({ x: 0, y: 733, width: A4[0], height: 6, color: GOLD });
  drawShieldCheck(page, 60, 805, 22, GOLD);
  drawBrandWordmark(page, 80, 798, bold, 12, { light: true });
  page.drawText(clean(kicker, 80).toUpperCase(), { x: 80, y: 778, font: bold, size: 7.2, color: rgb(0.7, 0.77, 0.87) });
  page.drawText(clean(title, 120), { x: 48, y: 754, font: regular, size: 24, color: WHITE });
  if (options.isSample === true) page.drawText('MUSTER - NICHT ZUM VERSAND', { x: 394, y: 805, font: bold, size: 7.8, color: rgb(1, 0.74, 0.45) });
}

function drawCheckItem(page, text, { x, y, width, regular, bold, included = true, detail = '' }) {
  const color = included ? SAGE : MUTED;
  page.drawCircle({ x: x + 8, y: y + 3, size: 8, color: included ? rgb(0.91, 0.95, 0.92) : SOFT, borderColor: color, borderWidth: 0.8 });
  if (included) {
    page.drawLine({ start: { x: x + 4.5, y: y + 3 }, end: { x: x + 7, y: y }, thickness: 1.3, color });
    page.drawLine({ start: { x: x + 7, y }, end: { x: x + 12.5, y: y + 7 }, thickness: 1.3, color });
  } else {
    page.drawLine({ start: { x: x + 4.5, y: y + 3 }, end: { x: x + 11.5, y: y + 3 }, thickness: 1.2, color });
  }
  const lines = wrap(text, bold, 9.5, width - 28).slice(0, 2);
  lines.forEach((line, index) => page.drawText(line, { x: x + 26, y: y - index * 12, font: bold, size: 9.5, color: INK }));
  if (detail) page.drawText(clean(detail, 120), { x: x + 26, y: y - lines.length * 12 - 1, font: regular, size: 7.8, color });
}

function drawNumberedStep(page, number, title, text, y, regular, bold) {
  page.drawCircle({ x: 73, y: y + 12, size: 17, color: NAVY });
  const numberText = String(number);
  page.drawText(numberText, { x: 73 - bold.widthOfTextAtSize(numberText, 11) / 2, y: y + 8, font: bold, size: 11, color: WHITE });
  page.drawText(title, { x: 105, y: y + 14, font: bold, size: 11, color: NAVY });
  drawWrapped(page, text, { x: 105, y: y - 3, width: 420, font: regular, size: 9.5, color: INK, lineHeight: 13, maxLines: 3 });
}

export async function createLumitCustomerPackagePdf(input = {}) {
  const originalPolicyBuffer = Buffer.isBuffer(input.originalPolicyBuffer) ? input.originalPolicyBuffer : null;
  if (!originalPolicyBuffer?.length || originalPolicyBuffer.subarray(0, 4).toString() !== '%PDF') {
    throw new Error('Die unveraenderte Mannheimer-Originalpolice als PDF fehlt.');
  }

  const customerName = clean(input.customerName, 200);
  if (!customerName) throw new Error('Der Name des Versicherungsnehmers fehlt.');
  const totalPrice = moneyNumber(input.totalPrice, 'Gesamtpreis');
  const insurancePremium = moneyNumber(input.insurancePremium, 'Versicherungsbeitrag');
  const serviceFee = moneyNumber(input.serviceFee, 'Serviceentgelt');
  if (Math.abs(totalPrice - insurancePremium - serviceFee) > 0.02) {
    throw new Error('Gesamtpreis, Versicherungsbeitrag und Serviceentgelt stimmen rechnerisch nicht ueberein.');
  }
  const rawBillingPeriod = clean(input.billingPeriod, 80) || 'monatlich';
  const billingPeriod = rawBillingPeriod === 'jaehrlich' ? 'jährlich' : rawBillingPeriod;
  const servicePackageName = clean(input.servicePackageName, 160) || 'Hauswertschutz Servicepaket';
  const policyNumber = clean(input.policyNumber, 120) || 'wird nach Policierung ergaenzt';
  const generatedAt = clean(input.generatedAt, 50) || new Date().toISOString();
  const startDate = clean(input.insuranceStartDate, 80) || 'laut Originalpolice';
  const insuredTechnologies = normalizeList(input.insuredTechnologies, ['Energietechnik laut Originalpolice']);
  const customerSalutation = clean(input.customerSalutation, 60);
  const propertyInsuranceIncluded = input.propertyInsuranceIncluded === true;
  const propertyHazardsIncluded = input.propertyHazardsIncluded === true;
  const yieldLossIncluded = input.yieldLossIncluded === true;
  const operatorLiabilityIncluded = input.operatorLiabilityIncluded === true;
  const assemblyCoverIncluded = input.assemblyCoverIncluded === true;
  const officialScopeConfirmed = input.officialScopeConfirmed === true;
  const servicePhone = clean(input.servicePhone, 80);
  const serviceEmail = clean(input.serviceEmail, 160);
  const serviceAddress = clean(input.serviceAddress, 240);
  const claimsWhatsapp = clean(input.claimsWhatsapp, 80) || '+49 XXX XXXXXXX';
  const claimsEmail = clean(input.claimsEmail, 160) || 'schaden@IHRE-DOMAIN.de';
  const claimsAvailability = clean(input.claimsAvailability, 120) || 'Digital rund um die Uhr einreichen';
  const claimsServiceHours = clean(input.claimsServiceHours, 140) || 'Persönliche Rückmeldung: [SERVICEZEITEN]';
  const claimsChannelsReady = input.claimsChannelsReady === true;
  const originalHash = crypto.createHash('sha256').update(originalPolicyBuffer).digest('hex');
  if (!officialScopeConfirmed) {
    throw new Error('Der konkrete Versicherungsumfang muss vor Erstellung des Kundenpakets mit Police und besonderen Vereinbarungen abgeglichen und bestaetigt werden.');
  }

  const original = await PDFDocument.load(originalPolicyBuffer, { updateMetadata: false });
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const serif = regular;
  const serifBold = bold;
  const serifItalic = await pdf.embedFont(StandardFonts.TimesRomanItalic);

  pdf.setTitle(`Hauswertschutz Kundenpaket - ${customerName}`);
  pdf.setAuthor('Hauswertschutz');
  pdf.setSubject('Willkommensmappe, Schutzurkunde, Leistungsuebersicht und unveraenderte Mannheimer-Originalpolice');
  pdf.setKeywords(['Hauswertschutz', 'Mannheimer', 'LUMIT', 'Energietechnik']);
  pdf.setCreationDate(new Date(generatedAt));

  let heroBuffer = Buffer.isBuffer(input.heroImageBuffer) ? input.heroImageBuffer : null;
  if (!heroBuffer?.length) {
    try {
      heroBuffer = await fs.readFile(new URL('../assets/hauswertschutz/hero-energietechnik-v1.png', import.meta.url));
    } catch {
      heroBuffer = null;
    }
  }

  const titlePage = pdf.addPage(A4);
  titlePage.drawRectangle({ x: 0, y: 0, width: A4[0], height: A4[1], color: NAVY });
  if (heroBuffer?.length) {
    const hero = await pdf.embedPng(heroBuffer);
    const heroWidth = A4[0];
    const heroHeight = hero.height * (heroWidth / hero.width);
    titlePage.drawImage(hero, { x: 0, y: (A4[1] - heroHeight) / 2, width: heroWidth, height: heroHeight });
  }
  titlePage.drawRectangle({ x: 0, y: 0, width: 388, height: A4[1], color: NAVY, opacity: heroBuffer ? 0.74 : 1 });
  titlePage.drawRectangle({ x: 388, y: 0, width: 13, height: A4[1], color: NAVY, opacity: 0.42 });
  titlePage.drawRectangle({ x: 0, y: 0, width: A4[0], height: 170, color: NAVY, opacity: 0.93 });
  titlePage.drawRectangle({ x: 0, y: 166, width: A4[0], height: 4, color: COPPER });
  drawShieldCheck(titlePage, 66, 775, 41, COPPER);
  drawBrandWordmark(titlePage, 98, 765, serifBold, 20, { light: true });
  titlePage.drawText('SCHÜTZT, WAS WIRKLICH WERTVOLL IST.', { x: 99, y: 746, font: bold, size: 6.8, color: rgb(0.82, 0.87, 0.94) });
  titlePage.drawText('CLEVER WOHNEN.', { x: 48, y: 623, font: bold, size: 28, color: COPPER });
  titlePage.drawText('WERTE SCHÜTZEN.', { x: 48, y: 584, font: bold, size: 28, color: WHITE });
  drawWrapped(titlePage, 'Sie haben Ihr Zuhause aufgewertet. Wir helfen dabei, Ihre moderne Energietechnik abzusichern und begleiten Sie persönlich, wenn es darauf ankommt.', { x: 48, y: 531, width: 291, font: serif, size: 12.5, color: rgb(0.92, 0.94, 0.97), lineHeight: 18, maxLines: 7 });
  titlePage.drawLine({ start: { x: 48, y: 394 }, end: { x: 105, y: 394 }, thickness: 2.2, color: COPPER });
  titlePage.drawText('IHRE PERSÖNLICHE SCHUTZMAPPE', { x: 48, y: 364, font: bold, size: 8, color: COPPER });
  drawWrapped(titlePage, customerName, { x: 48, y: 323, width: 285, font: serifBold, size: 22, color: WHITE, lineHeight: 27, maxLines: 2 });
  const titleTech = insuredTechnologies.join(' · ');
  drawWrapped(titlePage, titleTech, { x: 48, y: 258, width: 283, font: regular, size: 9.2, color: rgb(0.78, 0.84, 0.91), lineHeight: 13, maxLines: 4 });
  const titleBenefits = [
    ['SCHUTZ', 'für Ihre Technik'],
    ['SERVICE', 'persönlich begleitet'],
    ['KLARHEIT', 'alles in einer Mappe'],
  ];
  titleBenefits.forEach(([headline, copy], index) => {
    const x = 48 + index * 179;
    titlePage.drawText(headline, { x, y: 139, font: bold, size: 7.5, color: COPPER });
    titlePage.drawText(copy, { x, y: 121, font: regular, size: 8.6, color: WHITE });
  });
  titlePage.drawLine({ start: { x: 48, y: 100 }, end: { x: 547, y: 100 }, thickness: 0.55, color: rgb(0.28, 0.36, 0.47) });
  titlePage.drawText('SCHADEN DIGITAL MELDEN', { x: 48, y: 76, font: bold, size: 7.8, color: COPPER });
  titlePage.drawText(claimsAvailability, { x: 48, y: 57, font: regular, size: 8.4, color: WHITE });
  titlePage.drawText('WHATSAPP', { x: 246, y: 76, font: bold, size: 7.2, color: COPPER });
  titlePage.drawText(claimsWhatsapp, { x: 246, y: 57, font: regular, size: 9.1, color: WHITE });
  titlePage.drawText('SCHADEN-E-MAIL', { x: 407, y: 76, font: bold, size: 7.2, color: COPPER });
  drawWrapped(titlePage, claimsEmail, { x: 407, y: 57, width: 140, font: regular, size: 8.3, color: WHITE, lineHeight: 10, maxLines: 2 });
  titlePage.drawText(claimsServiceHours, { x: 48, y: 28, font: regular, size: 7.6, color: rgb(0.75, 0.82, 0.9) });
  if (!claimsChannelsReady) {
    titlePage.drawText('PLATZHALTER - SCHADENKANÄLE NOCH NICHT AKTIV', { x: 333, y: 28, font: bold, size: 6.8, color: rgb(1, 0.74, 0.45) });
  }
  if (input.isSample === true) titlePage.drawText('MUSTER - NICHT ZUM VERSAND', { x: 421, y: 810, font: bold, size: 7.8, color: rgb(1, 0.74, 0.45) });

  const welcome = pdf.addPage(A4);
  welcome.drawRectangle({ x: 0, y: 0, width: A4[0], height: A4[1], color: PAPER });
  welcome.drawRectangle({ x: 0, y: 666, width: A4[0], height: 176, color: NAVY });
  welcome.drawRectangle({ x: 0, y: 658, width: A4[0], height: 8, color: GOLD });
  welcome.drawText('HAUSWERTSCHUTZ', { x: 48, y: 800, font: bold, size: 10, color: GOLD });
  welcome.drawText('WILLKOMMEN', { x: 48, y: 731, font: serif, size: 36, color: WHITE });
  welcome.drawText('Gut geschützt. Persönlich begleitet.', { x: 50, y: 702, font: serifItalic, size: 13, color: rgb(0.82, 0.87, 0.94) });
  if (input.isSample === true) welcome.drawText('MUSTER - NICHT ZUM VERSAND', { x: 394, y: 804, font: bold, size: 7.8, color: rgb(1, 0.74, 0.45) });
  welcome.drawText(customerGreeting(customerName, customerSalutation), { x: 58, y: 607, font: serifBold, size: 15, color: NAVY });
  let letterY = drawWrapped(welcome, 'herzlich willkommen bei Hauswertschutz. Wir freuen uns, dass Sie uns Ihr Vertrauen schenken. Mit diesem Kundenpaket erhalten Sie alle wichtigen Informationen zu Ihrem Schutz für Ihre Energietechnik - verständlich geordnet und an einem Ort.', { x: 58, y: 571, width: 479, font: regular, size: 11.3, color: INK, lineHeight: 17, maxLines: 6 });
  letterY = drawWrapped(welcome, 'Unser Anspruch ist einfach: Wir möchten im Alltag klar informieren, im Schadenfall ansprechbar sein und Sie bei den nächsten Schritten unterstützen.', { x: 58, y: letterY - 17, width: 479, font: regular, size: 11.3, color: INK, lineHeight: 17, maxLines: 4 });
  welcome.drawText('In Ihrer persönlichen Mappe finden Sie', { x: 58, y: letterY - 27, font: serifBold, size: 14, color: NAVY });
  const welcomeCards = [
    ['01', 'Ihre Schutzurkunde', 'Die wichtigsten Vertragsdaten auf einen Blick.'],
    ['02', 'Ihre Leistungsübersicht', 'Was bestätigt enthalten ist - und was nicht automatisch dazugehört.'],
    ['03', 'Ihre Servicebegleitung', 'Wie Hauswertschutz Sie bei Fragen und im Schadenfall unterstützt.'],
    ['04', 'Ihre Originalunterlagen', 'Die unveränderte Police und die verbindlichen Versicherungsdokumente.'],
  ];
  welcomeCards.forEach((card, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 58 + column * 247;
    const y = letterY - 119 - row * 91;
    welcome.drawRectangle({ x, y, width: 226, height: 72, color: WHITE, borderColor: rgb(0.84, 0.8, 0.69), borderWidth: 0.65 });
    welcome.drawText(card[0], { x: x + 14, y: y + 45, font: serifBold, size: 16, color: GOLD_DARK });
    welcome.drawText(card[1], { x: x + 48, y: y + 47, font: bold, size: 9.5, color: NAVY });
    drawWrapped(welcome, card[2], { x: x + 48, y: y + 30, width: 163, font: regular, size: 7.9, color: MUTED, lineHeight: 10.5, maxLines: 3 });
  });
  welcome.drawText('Schön, dass Sie bei uns sind.', { x: 58, y: 125, font: serifItalic, size: 14, color: BURGUNDY });
  welcome.drawText('Ihr Hauswertschutz-Team', { x: 58, y: 96, font: serifBold, size: 11, color: NAVY });
  drawFooter(welcome, regular, 'Hauswertschutz Kundenpaket | Seite 2');

  const cover = pdf.addPage(A4);
  cover.drawRectangle({ x: 0, y: 0, width: A4[0], height: A4[1], color: PAPER });
  drawCertificateFrame(cover);
  cover.drawRectangle({ x: 42, y: 58, width: 11, height: 710, color: NAVY });
  cover.drawRectangle({ x: 45, y: 58, width: 5, height: 710, color: GOLD });
  cover.drawCircle({ x: A4[0] / 2, y: 728, size: 34, color: PAPER, borderColor: GOLD, borderWidth: 1.3 });
  drawShieldCheck(cover, A4[0] / 2, 728, 48, GOLD_DARK);
  const certificateBrandWidth = serifBold.widthOfTextAtSize('HausWertSchutz', 12);
  drawBrandWordmark(cover, (A4[0] - certificateBrandWidth) / 2, 674, serifBold, 12);
  drawCentered(cover, 'SCHUTZURKUNDE', { y: 622, font: serif, size: 31, color: NAVY });
  cover.drawLine({ start: { x: 150, y: 608 }, end: { x: 445, y: 608 }, thickness: 0.8, color: GOLD });
  drawCentered(cover, 'FÜR ENERGIETECHNIK', { y: 586, font: bold, size: 8.5, color: MUTED });
  if (input.isSample === true) drawCentered(cover, 'MUSTER - NICHT ZUM VERSAND', { y: 557, font: bold, size: 8.5, color: BURGUNDY });
  drawWrapped(cover, 'Diese Urkunde bestätigt das für Sie eingerichtete Schutz- und Servicepaket.', { x: 111, y: 522, width: 383, font: serif, size: 13, color: INK, lineHeight: 18, maxLines: 2 });
  drawCentered(cover, customerName, { y: 454, font: serifItalic, size: 23, color: BURGUNDY });
  cover.drawLine({ start: { x: 137, y: 440 }, end: { x: 458, y: 440 }, thickness: 0.65, color: GOLD_DARK });
  drawCentered(cover, 'Hauswertschutz Energietechnik-Schutzpaket', { y: 413, font: regular, size: 9.2, color: MUTED });
  drawCentered(cover, 'Persönlicher Service und zentrale Betreuung', { y: 396, font: regular, size: 9.2, color: MUTED });

  cover.drawRectangle({ x: 128, y: 281, width: 339, height: 86, color: PAPER_DEEP, borderColor: GOLD, borderWidth: 0.7 });
  drawCentered(cover, 'IHR GESAMTPREIS', { y: 342, font: bold, size: 8, color: GOLD_DARK });
  drawCentered(cover, euro(totalPrice), { y: 306, font: serifBold, size: 25, color: NAVY });
  drawCentered(cover, billingPeriod, { y: 290, font: regular, size: 8.5, color: MUTED });
  const detailLine = [startDate ? `Gewünschter Beginn: ${startDate}` : '', `Police: ${policyNumber}`].filter(Boolean).join('  |  ');
  drawCentered(cover, detailLine, { y: 251, font: regular, size: 8.2, color: MUTED });
  drawCentered(cover, 'Maßgeblich für den Versicherungsumfang sind Police und Versicherungsbedingungen.', { y: 223, font: regular, size: 7.8, color: MUTED });
  const trustBadges = Array.isArray(input.trustBadges) && input.trustBadges.length
    ? input.trustBadges
    : defaultLumitTrustBadges();
  await drawTrustBadges(pdf, cover, trustBadges, regular, bold);
  drawCentered(cover, 'Persönlich begleitet. Klar dokumentiert. Verlässlich erreichbar.', { y: 46, font: serifItalic, size: 8.6, color: GOLD_DARK });

  const coverage = pdf.addPage(A4);
  drawPageHeader(coverage, 'Ihr Schutz auf einen Blick', 'Verständlich zusammengefasst', serif, bold, input);
  coverage.drawRectangle({ x: 48, y: 565, width: 499, height: 133, color: WHITE, borderColor: rgb(0.85, 0.81, 0.7), borderWidth: 0.7 });
  coverage.drawText('DAS HABEN SIE ABGESCHLOSSEN', { x: 68, y: 672, font: bold, size: 8.5, color: GOLD_DARK });
  coverage.drawText('Hauswertschutz', { x: 68, y: 643, font: serifBold, size: 15.5, color: NAVY });
  coverage.drawText('Energietechnik-Schutzpaket', { x: 68, y: 623, font: serifBold, size: 13.5, color: NAVY });
  coverage.drawText('Versicherungsschutz gemäß geprüfter Originalpolice', { x: 68, y: 599, font: regular, size: 8.1, color: MUTED });
  coverage.drawText(`Police: ${policyNumber}  |  Beginn: ${startDate}`, { x: 68, y: 580, font: regular, size: 7.8, color: MUTED });
  coverage.drawText('Versicherte Technik', { x: 365, y: 649, font: bold, size: 8.5, color: NAVY });
  drawWrapped(coverage, insuredTechnologies.join(' · '), { x: 365, y: 628, width: 157, font: regular, size: 8.6, color: INK, lineHeight: 12, maxLines: 5 });

  coverage.drawText('Leistungsbausteine laut geprüfter Police', { x: 48, y: 527, font: serifBold, size: 17, color: NAVY });
  drawCheckItem(coverage, 'Sachschutz für Ihre Energietechnik', { x: 48, y: 494, width: 240, regular, bold, included: propertyInsuranceIncluded, detail: propertyInsuranceIncluded ? 'als enthalten bestätigt' : 'nicht als enthalten bestätigt' });
  drawCheckItem(coverage, 'Feuer, Leitungswasser, Sturm und Hagel', { x: 306, y: 494, width: 240, regular, bold, included: propertyHazardsIncluded, detail: propertyHazardsIncluded ? 'als Sachgefahren mitversichert' : 'nicht als mitversichert bestätigt' });
  drawCheckItem(coverage, 'Ertragsausfall-Deckung', { x: 48, y: 439, width: 240, regular, bold, included: yieldLossIncluded, detail: yieldLossIncluded ? 'laut Police eingeschlossen' : 'nur, wenn ausdrücklich vereinbart' });
  drawCheckItem(coverage, 'Betreiber-Haftpflicht', { x: 306, y: 439, width: 240, regular, bold, included: operatorLiabilityIncluded, detail: operatorLiabilityIncluded ? 'laut Police eingeschlossen' : 'nicht automatisch enthalten' });
  drawCheckItem(coverage, 'Montageschutz', { x: 48, y: 384, width: 240, regular, bold, included: assemblyCoverIncluded, detail: assemblyCoverIncluded ? 'laut Police eingeschlossen' : 'separater Baustein, falls vereinbart' });

  coverage.drawRectangle({ x: 48, y: 172, width: 499, height: 167, color: PALE_BLUE, borderColor: rgb(0.72, 0.8, 0.9), borderWidth: 0.6 });
  coverage.drawText('WAS DER ENERGIETECHNIK-SACHSCHUTZ TYPISCH AUFGREIFT', { x: 68, y: 312, font: bold, size: 8.5, color: NAVY });
  const causes = [
    'Bedienungsfehler und Ungeschicklichkeit',
    'Kurzschluss, Überspannung und Überstrom',
    'Konstruktions-, Material- und Ausführungsfehler',
    'Sturm, Frost, Eis sowie Wasser und Feuchtigkeit',
    'Marderbiss und weitere Tierbisse',
    'Vorsätzliche Beschädigung durch Dritte',
  ];
  causes.forEach((cause, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    coverage.drawCircle({ x: 73 + col * 245, y: 278 - row * 38, size: 3.4, color: GOLD_DARK });
    drawWrapped(coverage, cause, { x: 84 + col * 245, y: 282 - row * 38, width: 205, font: regular, size: 8.7, color: INK, lineHeight: 11, maxLines: 2 });
  });
  drawWrapped(coverage, 'Diese Beispiele beschreiben den Produktcharakter. Sie gelten für Ihren Vertrag nur im Rahmen der ausgewählten Bausteine. Maßgeblich sind immer Originalpolice, besondere Vereinbarungen und Versicherungsbedingungen.', { x: 48, y: 133, width: 499, font: regular, size: 8.5, color: MUTED, lineHeight: 12, maxLines: 4 });
  drawFooter(coverage, regular, 'Hauswertschutz Kundenpaket | Seite 4');

  const valueScope = pdf.addPage(A4);
  drawPageHeader(valueScope, 'Mehr Schutz, als man auf den ersten Blick sieht', 'Ihre konkreten Mehrwerte', serif, bold, input);
  drawWrapped(valueScope, 'Moderne Energietechnik besteht nicht nur aus dem Hauptgerät. Deshalb berücksichtigt Ihr bestätigter Versicherungsumfang auch Zubehör, Folgekosten und besondere Situationen rund um Ihre Anlage.', { x: 48, y: 692, width: 499, font: serif, size: 12.2, color: INK, lineHeight: 17.5, maxLines: 5 });
  drawValueCard(valueScope, 48, 493, 241, 135, 'Zubehör & Sonderausstattung', 'bis 5.000 EUR', 'Zum Beispiel Überwachungstechnik, technische Gebäude, anlagendienliche Leitungen und - bei Photovoltaik - eine Ladestation bis 22 kW.', regular, bold, GOLD_DARK);
  drawValueCard(valueScope, 306, 493, 241, 135, 'Wichtige Nebenkosten', 'bis 25.000 EUR', 'Unter anderem Such-, Erd-, Pflaster-, Aufräum-, Gerüst-, Bergungs-, Feuerlösch- und Entsorgungskosten.', regular, bold, SAGE);
  drawValueCard(valueScope, 48, 335, 241, 135, 'Datenwiederherstellung', 'bis 5.000 EUR', 'Kosten für die Wiederherstellung von Daten sind innerhalb des bestätigten Umfangs auf erstes Risiko mitversichert.', regular, bold, BURGUNDY);
  drawValueCard(valueScope, 306, 335, 241, 135, 'Finanzierungsschutz', 'GAP-Deckung', 'Die Finanzierungsrestschuld kann im Rahmen der vereinbarten GAP-Deckung berücksichtigt werden.', regular, bold, NAVY);

  valueScope.drawRectangle({ x: 48, y: 151, width: 499, height: 152, color: PAPER_DEEP, borderColor: GOLD, borderWidth: 0.65 });
  valueScope.drawText('WEITERE BESTÄTIGTE BESONDERHEITEN', { x: 68, y: 277, font: bold, size: 8.2, color: GOLD_DARK });
  const specialScopeItems = [
    'Erweiterter Versicherungsort bei Werkstattaufenthalten',
    'Streik und Aussperrung, innere Unruhen sowie Erdbeben',
    assemblyCoverIncluded ? 'Montageversicherung auf Bauherrenrisiko-Basis' : 'Montageschutz nur, wenn in Ihrer Police ausdrücklich vereinbart',
    'Weitere Kostenpositionen bis 2.500 EUR, zum Beispiel Rückruf-, Abbruch- oder Gebäudewiederherstellungskosten',
  ];
  specialScopeItems.forEach((item, index) => {
    drawShieldCheck(valueScope, 75, 242 - index * 27, 13, index === 2 && !assemblyCoverIncluded ? MUTED : SAGE);
    drawWrapped(valueScope, item, { x: 94, y: 245 - index * 27, width: 429, font: regular, size: 8.4, color: INK, lineHeight: 10.5, maxLines: 2 });
  });
  drawWrapped(valueScope, 'Die genannten Entschädigungsgrenzen gelten laut dem abgeglichenen Versicherungsumfang teilweise auf erstes Risiko. Maßgeblich bleiben die individuelle Police, besondere Vereinbarungen und die Versicherungsbedingungen.', { x: 48, y: 116, width: 499, font: regular, size: 8.2, color: MUTED, lineHeight: 11, maxLines: 4 });
  drawFooter(valueScope, regular, 'Hauswertschutz Kundenpaket | Seite 5');

  const yieldPage = pdf.addPage(A4);
  drawPageHeader(yieldPage, 'Wenn Ihre Technik stillsteht', 'Ertragsausfall & Selbstbehalt', serif, bold, input);
  drawWrapped(yieldPage, yieldLossIncluded
    ? 'Ein technischer Schaden betrifft nicht nur die Anlage selbst. Fällt Ihre Energieerzeugung aus, ist für Ihren Vertrag auch eine Ertragsausfall-Deckung bestätigt.'
    : 'Eine Ertragsausfall-Deckung ist für Ihren Vertrag nicht als enthalten bestätigt. Die nachfolgenden Produktwerte gelten deshalb nicht automatisch für Sie.', { x: 48, y: 692, width: 499, font: serif, size: 12.4, color: INK, lineHeight: 18, maxLines: 5 });

  const yieldAccent = yieldLossIncluded ? SAGE : MUTED;
  drawValueCard(yieldPage, 48, 474, 153, 151, 'Haftzeit', yieldLossIncluded ? '12 Monate' : 'nicht bestätigt', 'So lange kann der versicherte Ertragsausfall im bestätigten Umfang berücksichtigt werden.', regular, bold, yieldAccent);
  drawValueCard(yieldPage, 221, 474, 153, 151, 'Zeitlicher Selbstbehalt', yieldLossIncluded ? '2 Tage' : 'nicht bestätigt', 'Der zeitliche Selbstbehalt der Ertragsausfall-Deckung beträgt laut Umfang zwei Tage.', regular, bold, yieldAccent);
  drawValueCard(yieldPage, 394, 474, 153, 151, 'Erweiterter Ausfall', yieldLossIncluded ? 'bis 2.500 EUR' : 'nicht bestätigt', 'Zusätzliche Ausfallschäden können bis zur genannten Grenze berücksichtigt werden.', regular, bold, yieldAccent);

  yieldPage.drawRectangle({ x: 48, y: 300, width: 499, height: 128, color: WHITE, borderColor: rgb(0.85, 0.81, 0.7), borderWidth: 0.7 });
  drawShieldCheck(yieldPage, 82, 371, 30, GOLD_DARK);
  yieldPage.drawText('PV-ERTRAG REALISTISCH NACHWEISEN', { x: 116, y: 390, font: bold, size: 8.3, color: GOLD_DARK });
  drawWrapped(yieldPage, yieldLossIncluded
    ? 'Bei Photovoltaikanlagen kann ein höherer Ertragsausfall durch geeignete Unterlagen belegt werden. Liegt der nachgewiesene Verlust über der Tagespauschale, kann dieser im Rahmen der Bedingungen berücksichtigt werden.'
    : 'Dieser Vorteil ist nur relevant, wenn die Ertragsausfall-Deckung in Ihrer Police ausdrücklich eingeschlossen ist.', { x: 116, y: 367, width: 404, font: regular, size: 9.3, color: INK, lineHeight: 13.5, maxLines: 5 });

  yieldPage.drawRectangle({ x: 48, y: 149, width: 499, height: 111, color: PAPER_DEEP, borderColor: GOLD, borderWidth: 0.65 });
  yieldPage.drawText('SELBSTBEHALT IM SACHSCHADEN', { x: 68, y: 232, font: bold, size: 8.3, color: GOLD_DARK });
  yieldPage.drawText('150 EUR je Schadenfall', { x: 68, y: 198, font: serifBold, size: 19, color: NAVY });
  drawWrapped(yieldPage, 'Der Selbstbehalt kann entfallen, wenn die im Versicherungsumfang vorgesehenen Prüfungen nachgewiesen werden. Ob die Voraussetzungen im konkreten Fall erfüllt sind, wird anhand der Unterlagen geprüft.', { x: 272, y: 224, width: 249, font: regular, size: 8.6, color: INK, lineHeight: 12, maxLines: 6 });
  drawWrapped(yieldPage, 'Hinweis: Die Ertragsausfall-Deckung gilt laut Versicherungsumfang nicht für Ladestationen von Elektrofahrzeugen. Verbindlich sind stets Police und Bedingungen.', { x: 48, y: 112, width: 499, font: regular, size: 8.3, color: MUTED, lineHeight: 11.5, maxLines: 4 });
  drawFooter(yieldPage, regular, 'Hauswertschutz Kundenpaket | Seite 6');

  const service = pdf.addPage(A4);
  drawPageHeader(service, 'Wenn etwas passiert', 'Ihre Hauswertschutz-Begleitung', serif, bold, input);
  drawWrapped(service, 'Sie müssen sich im Schadenfall nicht allein durch Formulare und Unterlagen arbeiten. Hauswertschutz ist Ihre zentrale Anlaufstelle und unterstützt Sie dabei, den Vorgang vollständig und geordnet aufzunehmen.', { x: 48, y: 692, width: 499, font: serif, size: 12.5, color: INK, lineHeight: 18, maxLines: 5 });
  service.drawText('So gehen Sie am besten vor', { x: 48, y: 599, font: serifBold, size: 18, color: NAVY });
  drawNumberedStep(service, 1, 'Schaden begrenzen', 'Bringen Sie sich nicht in Gefahr. Treffen Sie nur zumutbare Sofortmaßnahmen, um Folgeschäden zu vermeiden.', 548, regular, bold);
  drawNumberedStep(service, 2, 'Situation dokumentieren', 'Fotografieren Sie Schadenstelle, betroffene Technik und Typenschilder. Notieren Sie Datum und den beobachteten Ablauf.', 469, regular, bold);
  drawNumberedStep(service, 3, 'Schaden digital melden', 'Senden Sie Ihre Angaben und Fotos über den Hauswertschutz-WhatsApp-Kanal oder die Schaden-E-Mail. Sie erhalten eine digitale Eingangsbestätigung.', 390, regular, bold);
  drawNumberedStep(service, 4, 'Weitere Schritte abstimmen', 'Reparaturen oder Entsorgung bitte - außer bei notwendigen Sofortmaßnahmen - erst nach gemeinsamer Abstimmung veranlassen.', 311, regular, bold);
  service.drawRectangle({ x: 48, y: 215, width: 499, height: 60, color: NAVY });
  service.drawText('WHATSAPP', { x: 65, y: 255, font: bold, size: 7.2, color: COPPER });
  service.drawText(claimsWhatsapp, { x: 65, y: 238, font: regular, size: 8.8, color: WHITE });
  service.drawText('SCHADEN-E-MAIL', { x: 225, y: 255, font: bold, size: 7.2, color: COPPER });
  service.drawText(claimsEmail, { x: 225, y: 238, font: regular, size: 8.4, color: WHITE });
  service.drawText('ERREICHBARKEIT', { x: 397, y: 255, font: bold, size: 7.1, color: COPPER });
  drawWrapped(service, claimsAvailability, { x: 397, y: 239, width: 132, font: regular, size: 7.2, color: WHITE, lineHeight: 8.5, maxLines: 2 });
  drawWrapped(service, claimsServiceHours, { x: 65, y: 224, width: 300, font: regular, size: 6.8, color: rgb(0.75, 0.82, 0.9), lineHeight: 8, maxLines: 2 });
  if (!claimsChannelsReady) service.drawText('PLATZHALTER - NOCH NICHT AKTIV', { x: 397, y: 220, font: bold, size: 5.8, color: rgb(1, 0.74, 0.45) });
  service.drawRectangle({ x: 48, y: 105, width: 499, height: 96, color: WHITE, borderColor: rgb(0.85, 0.81, 0.7), borderWidth: 0.7 });
  service.drawText('WAS WIR FÜR SIE TUN', { x: 68, y: 177, font: bold, size: 8.5, color: GOLD_DARK });
  const serviceItems = [
    'Vertrags- und Dokumentenfragen einordnen',
    'Schadenangaben und Nachweise strukturiert zusammenstellen',
    'Kommunikation und Bearbeitungsstand nachvollziehbar begleiten',
  ];
  serviceItems.forEach((item, index) => {
    service.drawCircle({ x: 74, y: 151 - index * 20, size: 4.5, color: SAGE });
    service.drawText(item, { x: 88, y: 147 - index * 20, font: regular, size: 8.9, color: INK });
  });
  drawWrapped(service, 'Wichtig: Hauswertschutz unterstützt bei der Abwicklung. Ob und in welcher Höhe Versicherungsschutz besteht, entscheidet sich nach Police, Bedingungen und Prüfung des konkreten Schadenfalls.', { x: 48, y: 81, width: 499, font: regular, size: 7.8, color: MUTED, lineHeight: 10, maxLines: 3 });
  drawFooter(service, regular, 'Hauswertschutz Kundenpaket | Seite 7');

  const summary = pdf.addPage(A4);
  drawPageHeader(summary, 'Verträge, Preis und Unterlagen', 'Transparent dokumentiert', serif, bold, input);
  summary.drawRectangle({ x: 48, y: 565, width: 499, height: 133, color: WHITE, borderColor: rgb(0.85, 0.81, 0.7), borderWidth: 0.7 });
  summary.drawText('VERTRAGLICHE ZUORDNUNG', { x: 68, y: 672, font: bold, size: 8.5, color: GOLD_DARK });
  const contractFacts = [
    ['Serviceanbieter', 'Hauswertschutz'],
    ['Risikoträger', 'Mannheimer Versicherung AG'],
    ['Versicherungsprodukt', 'LUMIT HOME'],
  ];
  contractFacts.forEach(([label, value], index) => {
    const y = 637 - index * 27;
    summary.drawText(label, { x: 68, y, font: regular, size: 8.8, color: MUTED });
    summary.drawText(value, { x: 218, y, font: index === 0 ? bold : regular, size: 10.2, color: INK });
  });

  summary.drawText('Ihr Gesamtpreis', { x: 48, y: 527, font: serifBold, size: 18, color: NAVY });
  summary.drawText('Der Gesamtpreis setzt sich aus zwei rechtlich getrennten Verträgen zusammen.', { x: 48, y: 493, font: regular, size: 10, color: MUTED });
  const rows = [
    ['Versicherungsvertrag', 'Energietechnik-Sachschutz', euro(insurancePremium)],
    ['Servicevereinbarung', servicePackageName, euro(serviceFee)],
  ];
  let rowY = 435;
  rows.forEach(([kind, name, price]) => {
    summary.drawLine({ start: { x: 48, y: rowY + 24 }, end: { x: 547, y: rowY + 24 }, thickness: 0.7, color: LINE });
    summary.drawText(kind, { x: 48, y: rowY + 3, font: bold, size: 9.5, color: INK });
    summary.drawText(name, { x: 190, y: rowY + 3, font: regular, size: 9.5, color: INK });
    summary.drawText(price, { x: 455, y: rowY + 3, font: regular, size: 9.5, color: INK });
    rowY -= 43;
  });
  summary.drawLine({ start: { x: 48, y: rowY + 24 }, end: { x: 547, y: rowY + 24 }, thickness: 1.2, color: NAVY });
  summary.drawText('Gesamtpreis', { x: 48, y: rowY - 1, font: bold, size: 11, color: NAVY });
  summary.drawText(`${euro(totalPrice)} ${billingPeriod}`, { x: 402, y: rowY - 1, font: bold, size: 11, color: NAVY });

  summary.drawText('Rechtlich wichtig', { x: 48, y: 289, font: serifBold, size: 17, color: NAVY });
  drawWrapped(summary, 'Das Hauswertschutz-Servicepaket und der Versicherungsvertrag sind rechtlich getrennte Verträge. Serviceanbieter ist Hauswertschutz; Risikoträger des Versicherungsvertrags ist die Mannheimer Versicherung AG. Beide Preisbestandteile sind oben nachvollziehbar ausgewiesen.', { x: 48, y: 261, width: 499, font: regular, size: 10.2, color: INK, lineHeight: 15, maxLines: 5 });
  drawWrapped(summary, 'Für den verbindlichen Versicherungsumfang gelten ausschließlich die Originalpolice, besondere Vereinbarungen und die Versicherungsbedingungen des Risikoträgers. Die folgenden Originalunterlagen wurden nicht inhaltlich verändert.', { x: 48, y: 174, width: 499, font: regular, size: 10.2, color: INK, lineHeight: 15, maxLines: 5 });
  summary.drawRectangle({ x: 48, y: 78, width: 499, height: 57, color: PAPER_DEEP, borderColor: GOLD, borderWidth: 0.6 });
  drawWrapped(summary, 'Bitte bewahren Sie dieses Gesamtdokument auf. Die Originalpolice bleibt zusätzlich separat in Ihrer Kundenakte gespeichert.', { x: 66, y: 111, width: 465, font: regular, size: 9.2, color: INK, lineHeight: 13, maxLines: 3 });
  drawFooter(summary, regular, 'Hauswertschutz Kundenpaket | Seite 8');

  const divider = pdf.addPage(A4);
  divider.drawRectangle({ x: 0, y: 0, width: A4[0], height: A4[1], color: NAVY });
  divider.drawRectangle({ x: 27, y: 27, width: A4[0] - 54, height: A4[1] - 54, borderColor: GOLD, borderWidth: 0.8 });
  divider.drawText('IHRE ORIGINALUNTERLAGEN', { x: 48, y: 701, font: bold, size: 10, color: GOLD });
  drawWrapped(divider, 'Versicherungsvertrag und Bedingungen', { x: 48, y: 655, width: 480, font: serif, size: 27, color: WHITE, lineHeight: 34, maxLines: 2 });
  drawWrapped(divider, 'Die folgenden Seiten wurden unverändert aus der bereitgestellten Originalpolice übernommen.', { x: 48, y: 552, width: 455, font: regular, size: 13, color: rgb(0.82, 0.87, 0.94), lineHeight: 19, maxLines: 4 });
  divider.drawText('Risikoträger: Mannheimer Versicherung AG', { x: 48, y: 497, font: regular, size: 9.5, color: rgb(0.68, 0.75, 0.84) });
  divider.drawText(`Originaldatei: ${clean(input.originalPolicyFileName, 120) || 'Mannheimer-Police.pdf'}`, { x: 48, y: 167, font: regular, size: 9, color: rgb(0.68, 0.75, 0.84) });
  divider.drawText(`SHA-256: ${originalHash}`, { x: 48, y: 148, font: regular, size: 7.6, color: rgb(0.68, 0.75, 0.84) });
  divider.drawText('Das Original bleibt zusätzlich separat in der Kundenakte gespeichert.', { x: 48, y: 111, font: regular, size: 9.5, color: rgb(0.82, 0.87, 0.94) });

  const copiedPages = await pdf.copyPages(original, original.getPageIndices());
  copiedPages.forEach(page => pdf.addPage(page));
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
