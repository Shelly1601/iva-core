import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEWARMTE_MATERIAL_STANDARD } from '../projects/dewarmte-material-standard.js';

const MODULE_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(MODULE_PATH), '..');
const OUTPUT_ROOT = path.join(REPO_ROOT, 'output', 'pdf');
const A4 = Object.freeze([595.28, 841.89]);
const requireBase = process.env.IVA_NODE_MODULES_DIR
  ? path.join(path.resolve(process.env.IVA_NODE_MODULES_DIR), 'package.json')
  : import.meta.url;
const { PDFDocument, StandardFonts, rgb } = createRequire(requireBase)('pdf-lib');

function clean(value, max = 500) {
  return String(value || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function wrapText(text, font, size, maxWidth) {
  const words = clean(text, 2000).split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function drawWrapped(page, text, { x, y, width, font, size, color, lineHeight = size * 1.25, maxLines = 10 }) {
  const lines = wrapText(text, font, size, width).slice(0, maxLines);
  lines.forEach((line, index) => page.drawText(line, { x, y: y - (index * lineHeight), font, size, color }));
  return lines.length;
}

function drawMetaLine(page, label, value, y, fonts) {
  page.drawText(label, { x: 48, y, font: fonts.bold, size: 8.6, color: rgb(0.31, 0.39, 0.49) });
  page.drawText(clean(value, 240) || '-', { x: 116, y, font: fonts.regular, size: 9.4, color: rgb(0.08, 0.13, 0.20) });
}

function drawOrderPage(document, section, metadata, pageNumber, fonts) {
  const page = document.addPage(A4);
  const [pageWidth, pageHeight] = A4;
  const navy = rgb(0.035, 0.10, 0.20);
  const teal = rgb(0.10, 0.55, 0.52);
  const ink = rgb(0.08, 0.13, 0.20);
  const muted = rgb(0.31, 0.39, 0.49);
  const line = rgb(0.82, 0.86, 0.90);
  const pale = rgb(0.96, 0.98, 0.99);
  const warning = rgb(1.0, 0.97, 0.86);

  page.drawRectangle({ x: 0, y: pageHeight - 112, width: pageWidth, height: 112, color: navy });
  page.drawRectangle({ x: 0, y: pageHeight - 116, width: pageWidth, height: 4, color: teal });
  page.drawText('IVA · DEWARMTE MATERIALWORKFLOW', { x: 42, y: pageHeight - 37, font: fonts.bold, size: 8.5, color: rgb(0.55, 0.94, 0.89) });
  page.drawText(section.orderPageTitle, { x: 42, y: pageHeight - 72, font: fonts.bold, size: 24, color: rgb(1, 1, 1) });
  page.drawText('Separat versendbare Bestellseite', { x: 42, y: pageHeight - 94, font: fonts.regular, size: 10.5, color: rgb(0.78, 0.85, 0.92) });

  page.drawRectangle({ x: 40, y: 635, width: pageWidth - 80, height: 76, color: pale, borderColor: line, borderWidth: 0.7 });
  drawMetaLine(page, 'Projekt', metadata.project, 690, fonts);
  drawMetaLine(page, 'Objekt', metadata.address, 671, fonts);
  drawMetaLine(page, 'Montage', metadata.installation, 652, fonts);

  page.drawText('Bestellt durch: ____________________', { x: 40, y: 613, font: fonts.regular, size: 8.8, color: muted });
  page.drawText('am: ____________', { x: 255, y: 613, font: fonts.regular, size: 8.8, color: muted });
  page.drawText('Liefertermin: ____________', { x: 385, y: 613, font: fonts.regular, size: 8.8, color: muted });

  const x = 40;
  const widths = [62, 178, 233, 42];
  const tableWidth = widths.reduce((sum, value) => sum + value, 0);
  let y = 579;
  page.drawRectangle({ x, y: y - 25, width: tableWidth, height: 25, color: navy });
  const headers = ['Menge', 'Material / Bauteil', 'Hinweis', 'OK'];
  let cursor = x;
  headers.forEach((header, index) => {
    page.drawText(header, { x: cursor + 7, y: y - 17, font: fonts.bold, size: 8.2, color: rgb(1, 1, 1) });
    cursor += widths[index];
  });
  y -= 25;

  for (const entry of section.items) {
    const quantityLines = wrapText(entry.quantity, fonts.bold, 9, widths[0] - 13);
    const materialLines = wrapText(entry.material, fonts.bold, 9.2, widths[1] - 13);
    const noteLines = wrapText(entry.note, fonts.regular, 8.5, widths[2] - 13);
    const lines = Math.max(quantityLines.length, materialLines.length, noteLines.length);
    const rowHeight = Math.max(38, 16 + (lines * 10.8));
    if (y - rowHeight < 82) throw new Error(`${section.orderPageTitle} passt nicht vollständig auf eine einzelne Seite.`);
    page.drawRectangle({ x, y: y - rowHeight, width: tableWidth, height: rowHeight, color: entry.needsClarification ? warning : rgb(1, 1, 1), borderColor: line, borderWidth: 0.55 });
    let columnX = x;
    [quantityLines, materialLines, noteLines].forEach((linesForCell, index) => {
      const font = index < 2 ? fonts.bold : fonts.regular;
      const size = index === 2 ? 8.5 : (index === 1 ? 9.2 : 9);
      linesForCell.forEach((text, lineIndex) => page.drawText(text, {
        x: columnX + 7, y: y - 17 - (lineIndex * 10.8), font, size, color: ink,
      }));
      columnX += widths[index];
    });
    page.drawRectangle({ x: x + tableWidth - 27, y: y - 25, width: 12, height: 12, borderColor: muted, borderWidth: 0.8 });
    if (entry.needsClarification) page.drawText('!', { x: x + tableWidth - 24.3, y: y - 23.2, font: fonts.bold, size: 9, color: rgb(0.72, 0.42, 0.04) });
    y -= rowHeight;
  }

  const warningCount = section.items.filter(entry => entry.needsClarification).length;
  if (warningCount) {
    page.drawRectangle({ x: 40, y: 53, width: pageWidth - 80, height: 22, color: warning });
    page.drawText(`! ${warningCount} markierte ${warningCount === 1 ? 'Position' : 'Positionen'} vor Bestellung fachlich oder mengenmäßig klären.`, {
      x: 48, y: 61, font: fonts.bold, size: 8.1, color: rgb(0.52, 0.31, 0.03),
    });
  }
  page.drawText('Diese Seite kann einzeln aus der Gesamt-PDF entnommen und versandt werden.', { x: 40, y: 31, font: fonts.regular, size: 7.8, color: muted });
  page.drawText(`${clean(metadata.reference, 120) || 'DeWarmte Materialliste'} · Bestellseite ${pageNumber}/2`, { x: pageWidth - 250, y: 31, font: fonts.regular, size: 7.8, color: muted });
  return page;
}

export async function appendDewarmteOrderPages({ inputPath, outputPath, metadata = {}, outputRoot = OUTPUT_ROOT } = {}) {
  const source = path.resolve(clean(inputPath, 1400));
  const destination = path.resolve(clean(outputPath, 1400));
  if (path.extname(source).toLowerCase() !== '.pdf' || path.extname(destination).toLowerCase() !== '.pdf') throw new Error('Ein- und Ausgabedatei müssen PDFs sein.');
  if (source === destination) throw new Error('Die Original-PDF bleibt unverändert; bitte einen neuen Ausgabepfad verwenden.');
  const allowedOutputRoot = path.resolve(outputRoot);
  if (!destination.startsWith(`${allowedOutputRoot}${path.sep}`)) throw new Error('Die Ergebnis-PDF muss unter output/pdf gespeichert werden.');
  const bytes = await readFile(source);
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('Die Eingabedatei ist keine gültige PDF.');
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  if (/getrennte Bestellseiten/i.test(document.getSubject() || '')) throw new Error('Diese PDF enthält bereits die getrennten Bestellseiten.');
  const fonts = {
    regular: await document.embedFont(StandardFonts.Helvetica),
    bold: await document.embedFont(StandardFonts.HelveticaBold),
  };
  const sectionById = new Map(DEWARMTE_MATERIAL_STANDARD.sections.map(section => [section.id, section]));
  DEWARMTE_MATERIAL_STANDARD.orderAppendix.sectionOrder.forEach((sectionId, index) => {
    const section = sectionById.get(sectionId);
    if (!section) throw new Error(`Materialbereich ${sectionId} fehlt.`);
    drawOrderPage(document, section, {
      project: clean(metadata.project, 220) || 'nicht angegeben',
      address: clean(metadata.address, 320) || 'nicht angegeben',
      installation: clean(metadata.installation, 220) || 'nicht angegeben',
      reference: clean(metadata.reference, 160) || path.basename(source, '.pdf'),
    }, index + 1, fonts);
  });
  const previousSubject = clean(document.getSubject(), 500);
  document.setSubject(`${previousSubject}${previousSubject ? '; ' : ''}zwei getrennte Bestellseiten für HEAT|Hero und DeWarmte`);
  document.setKeywords(['DeWarmte', 'HEAT|Hero', 'Materialliste', 'Bestellung']);
  document.setModificationDate(new Date());
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, await document.save({ useObjectStreams: false }));
  return { outputPath: destination, pageCount: document.getPageCount(), appendedPages: 2 };
}

function parseArgs(argv) {
  const [inputPath, outputPath, ...rest] = argv;
  const values = { inputPath, outputPath, metadata: {} };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!value || !['--project', '--address', '--installation', '--reference'].includes(key)) throw new Error(`Unbekanntes oder unvollständiges Argument: ${key || '(leer)'}`);
    values.metadata[key.slice(2)] = value;
  }
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
  try { console.log(JSON.stringify(await appendDewarmteOrderPages(parseArgs(process.argv.slice(2))))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
