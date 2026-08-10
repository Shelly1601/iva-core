import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readdir, readFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { analyzeFundingPdf, classifyFundingDocumentName } from './funding-document-extractor.mjs';
import { FUNDING_DOCUMENTS } from './funding.mjs';

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_PAGES_PER_OUTPUT = 80;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.heic', '.tif', '.tiff']);
const ALLOWED_EXTENSIONS = new Set(['.pdf', ...IMAGE_EXTENSIONS]);
const AUTO_DOCUMENT_TYPES = new Set([
  'signed_offer',
  'identity_card',
  'registration_certificate',
  'land_register',
  'tax_assessment_2023',
  'tax_assessment_2024',
  'kfw_account_confirmation',
]);

const OUTPUT_NAMES = Object.freeze({
  signed_offer: 'Unterschriebenes Angebot',
  identity_card: 'Personalausweis Vorder- und Rueckseite',
  registration_certificate: 'Meldebescheinigung',
  land_register: 'Grundbuchauszug',
  tax_assessment_2023: 'Einkommensteuerbescheid 2023',
  tax_assessment_2024: 'Einkommensteuerbescheid 2024',
  kfw_account_confirmation: 'KfW-Kontobestaetigung',
});

function run(command, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${path.basename(command)} hat nach ${Math.round(timeoutMs / 1000)} Sekunden abgebrochen.`));
    }, timeoutMs);
    child.stdout.on('data', chunk => { if (stdout.length < 2 * 1024 * 1024) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 256 * 1024) stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(String(stderr || stdout || `${path.basename(command)} endete mit Code ${code}`).replace(/\s+/g, ' ').trim().slice(0, 600)));
    });
  });
}

function safeSegment(value, fallback = 'Kunde') {
  return String(value || fallback)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || fallback;
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function validateInputFile(filePath) {
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES) {
    throw new Error(`${path.basename(filePath)} ist leer, kein reguläres Dokument oder größer als 50 MB.`);
  }
  const extension = path.extname(filePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error(`${path.basename(filePath)} besitzt kein unterstütztes PDF- oder Bildformat.`);
  return { extension, size: metadata.size };
}

async function imageToPdf(inputPath, outputPath) {
  await run('/usr/bin/sips', ['-s', 'format', 'pdf', inputPath, '--out', outputPath]);
  const bytes = await readFile(outputPath);
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error(`${path.basename(inputPath)} konnte nicht sicher in PDF umgewandelt werden.`);
  return outputPath;
}

async function normalizedPdf(inputPath, temporaryDirectory) {
  const { extension } = await validateInputFile(inputPath);
  if (extension === '.pdf') {
    const bytes = await readFile(inputPath);
    if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error(`${path.basename(inputPath)} besitzt keinen gültigen PDF-Dateikopf.`);
    return inputPath;
  }
  const outputPath = path.join(temporaryDirectory, `${safeSegment(path.basename(inputPath, extension), 'Bild')}.pdf`);
  return imageToPdf(inputPath, outputPath);
}

async function mergePdfFiles(files, outputPath) {
  const output = await PDFDocument.create();
  for (const filePath of files) {
    const source = await PDFDocument.load(await readFile(filePath), { ignoreEncryption: false, updateMetadata: false });
    if (!source.getPageCount()) throw new Error(`${path.basename(filePath)} enthält keine PDF-Seite.`);
    if (output.getPageCount() + source.getPageCount() > MAX_PAGES_PER_OUTPUT) throw new Error('Das zusammengeführte Förder-PDF würde mehr als 80 Seiten enthalten.');
    const pages = await output.copyPages(source, source.getPageIndices());
    for (const page of pages) output.addPage(page);
  }
  output.setProducer('IVA Mac Helper');
  output.setCreator('IVA Fördermonitor');
  await writeFile(outputPath, await output.save({ useObjectStreams: false }));
  return output.getPageCount();
}

async function renderAndVerifyPdf(filePath, expectedPages) {
  const renderDirectory = await mkdtemp(path.join(os.tmpdir(), 'iva-funding-render-'));
  try {
    const prefix = path.join(renderDirectory, 'page');
    await run('/opt/homebrew/bin/pdftoppm', ['-png', '-r', '120', filePath, prefix]);
    const renders = (await readdir(renderDirectory)).filter(name => /^page-\d+\.png$/i.test(name)).sort();
    const metadata = await Promise.all(renders.map(async name => ({ name, size: (await stat(path.join(renderDirectory, name))).size })));
    const invalid = metadata.filter(item => item.size < 2500);
    return {
      renderedPages: metadata.length,
      expectedPages,
      renderComplete: metadata.length === expectedPages,
      suspiciouslySmallPages: invalid.map(item => item.name),
      visuallyRenderable: metadata.length === expectedPages && invalid.length === 0,
    };
  } finally {
    await rm(renderDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

function documentSpecificReview(type, pageCount, sourceCount) {
  const reasons = [];
  if (type === 'identity_card' && pageCount < 2 && sourceCount < 2) {
    reasons.push('Personalausweis umfasst nur eine Seite; Vorder- und Rückseite sind nicht sicher bestätigt.');
  }
  if (type === 'land_register' && pageCount < 5) {
    reasons.push('Grundbuchauszug besitzt weniger als fünf Seiten und muss auf Vollständigkeit geprüft werden.');
  }
  return reasons;
}

function parseGermanDate(value) {
  const match = String(value || '').match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  if (date.getUTCFullYear() !== Number(match[3]) || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[1])) return null;
  return date;
}

export function assessRegistrationCertificateDate(text, now = new Date()) {
  const normalized = String(text || '').replace(/\s+/g, ' ');
  const candidates = [];
  for (const match of normalized.matchAll(/(?:ausgestellt(?:\s+am)?|ausstellungsdatum|\bden)\s*[:,-]?\s*(\d{1,2}\.\d{1,2}\.\d{4})/giu)) {
    const date = parseGermanDate(match[1]);
    if (date) candidates.push({ date, evidence: match[0].slice(0, 80) });
  }
  if (!candidates.length) return { status: 'manual_review', issueDate: null, reason: 'Ausstellungsdatum der Meldebescheinigung konnte nicht eindeutig gelesen werden.' };
  candidates.sort((a, b) => b.date - a.date);
  const selected = candidates[0];
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const threshold = new Date(today);
  threshold.setUTCMonth(threshold.getUTCMonth() - 3);
  if (selected.date > new Date(today.getTime() + 24 * 60 * 60 * 1000)) {
    return { status: 'invalid', issueDate: selected.date.toISOString().slice(0, 10), reason: 'Ausstellungsdatum der Meldebescheinigung liegt in der Zukunft.' };
  }
  if (selected.date < threshold) {
    return { status: 'invalid', issueDate: selected.date.toISOString().slice(0, 10), reason: 'Meldebescheinigung ist älter als drei Monate.' };
  }
  return { status: 'valid', issueDate: selected.date.toISOString().slice(0, 10), reason: null };
}

async function extractedPdfText(filePath) {
  try {
    return await run('/opt/homebrew/bin/pdftotext', ['-layout', filePath, '-']);
  } catch {
    return '';
  }
}

export async function prepareFundingAttachments({ inputDirectory, outputDirectory, customerName, orderNumber } = {}) {
  const sourceDirectory = path.resolve(String(inputDirectory || ''));
  const targetDirectory = path.resolve(String(outputDirectory || path.join(sourceDirectory, 'prepared')));
  const entries = (await readdir(sourceDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort();
  if (!entries.length) throw new Error('Der Outlook-Downloadordner enthält keine Anlagen.');
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  if ((await readdir(targetDirectory)).length) throw new Error('Der Ausgabeordner für Förder-PDFs ist nicht leer.');

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'iva-funding-normalize-'));
  const inputs = [];
  try {
    for (const name of entries) {
      const inputPath = path.join(sourceDirectory, name);
      const metadata = await validateInputFile(inputPath);
      const classification = classifyFundingDocumentName(name);
      const pdfPath = await normalizedPdf(inputPath, temporaryDirectory);
      inputs.push({
        name,
        inputPath,
        pdfPath,
        size: metadata.size,
        sha256: await sha256(inputPath),
        classification,
      });
    }

    const grouped = new Map();
    const manualReview = [];
    for (const input of inputs) {
      if (!AUTO_DOCUMENT_TYPES.has(input.classification.type) || input.classification.confidence < 0.9) {
        manualReview.push({
          fileName: input.name,
          reason: input.classification.type === 'offer'
            ? 'Angebot erkannt, vorhandene Unterschrift aber nicht sicher aus Dateiname oder Metadaten ableitbar.'
            : 'Dokumenttyp ist nicht eindeutig einem Förder-Pflichtdokument zuzuordnen.',
          classification: input.classification,
        });
        continue;
      }
      const values = grouped.get(input.classification.type) || [];
      values.push(input);
      grouped.set(input.classification.type, values);
    }

    const outputs = [];
    const reference = safeSegment(orderNumber || customerName, 'Foerderfall');
    for (const [type, documents] of grouped.entries()) {
      const outputName = `${OUTPUT_NAMES[type]} - ${reference}.pdf`;
      const outputPath = path.join(targetDirectory, outputName);
      const pageCount = await mergePdfFiles(documents.map(document => document.pdfPath), outputPath);
      const analysis = await analyzeFundingPdf(outputPath, { includePageText: true });
      const render = await renderAndVerifyPdf(outputPath, pageCount);
      const documentText = [...(analysis.extractedPageTexts || []), await extractedPdfText(outputPath)].join('\n');
      delete analysis.extractedPageTexts;
      const validity = type === 'registration_certificate' ? assessRegistrationCertificateDate(documentText) : null;
      const reviewReasons = [
        ...documentSpecificReview(type, pageCount, documents.length),
        ...(validity?.status !== 'valid' ? [validity?.reason].filter(Boolean) : []),
        ...(analysis.ocr?.failedPages || []).map(item => `OCR auf Seite ${item.page} fehlgeschlagen: ${item.reason}`),
        ...(!render.visuallyRenderable ? ['Mindestens eine PDF-Seite konnte nicht zuverlässig gerendert werden.'] : []),
      ];
      outputs.push({
        type,
        label: FUNDING_DOCUMENTS[type],
        fileName: outputName,
        outputPath,
        pageCount,
        sourceFiles: documents.map(document => document.name),
        sourceHashes: documents.map(document => document.sha256),
        sha256: await sha256(outputPath),
        analysis: {
          textLayer: analysis.textLayer,
          ocrAppliedPages: analysis.ocr?.appliedPages || [],
          ocrFailedPages: analysis.ocr?.failedPages || [],
          render,
        },
        validity,
        autoUploadSafe: reviewReasons.length === 0,
        reviewReasons,
      });
    }

    return {
      inputDirectory: sourceDirectory,
      outputDirectory: targetDirectory,
      inputCount: inputs.length,
      outputCount: outputs.length,
      outputs,
      manualReview,
      allInputsClassified: manualReview.length === 0,
      allOutputsAutoUploadSafe: outputs.length > 0 && outputs.every(item => item.autoUploadSafe),
      sourceFilesPreserved: true,
      pipedriveMutated: false,
      sent: false,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

export function fundingDocumentPipelinePolicy() {
  return Object.freeze({
    autoUploadRequiresRecognizedType: true,
    autoUploadRequiresSuccessfulRender: true,
    identityFrontBackCombined: true,
    differentDocumentTypesRemainSeparate: true,
    originalDownloadsPreservedUntilReviewed: true,
    manualReviewTypes: ['signed_offer', 'registration_certificate', 'single-page identity_card', 'short land_register'],
  });
}
