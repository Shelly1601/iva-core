import path from 'node:path';
import os from 'node:os';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { extractImages, extractText, getDocumentProxy } from 'unpdf';

const MAX_PDF_BYTES = 30 * 1024 * 1024;
const MIN_TEXT_CHARS = 16;

const FIELD_SPECS = Object.freeze({
  orderNumber: Object.freeze({
    targetField: 'Auftragsnummer',
    label: 'Auftrags-/Angebotsnummer',
    regex: /\b(Auftrags(?:nummer|[- ]?Nr\.?|[- ]?Nummer)|Angebots(?:nummer|[- ]?Nr\.?|[- ]?Nummer))\s*[:#]?\s*([A-Z0-9][A-Z0-9./_-]{2,39})\b/giu,
    valueGroup: 2,
    normalize: value => String(value || '').replace(/\s+/g, '').toUpperCase(),
  }),
  customerNumber: Object.freeze({
    targetField: 'Kundennummer',
    label: 'Kundennummer',
    regex: /\b(Kunden(?:nummer|[- ]?Nr\.?|[- ]?Nummer))\s*[:#]?\s*([A-Z0-9][A-Z0-9./_-]{2,39})\b/giu,
    valueGroup: 2,
    normalize: value => String(value || '').replace(/\s+/g, '').toUpperCase(),
  }),
  phoneNumber: Object.freeze({
    targetField: 'Telefonnummer',
    label: 'Telefonnummer',
    regex: /\b(Telefon(?:nummer)?|Tel\.?|Mobil(?:nummer)?|Handy)\s*[:#]?\s*((?:\+|00)?\d[\d ()/.-]{5,24}\d)\b/giu,
    valueGroup: 2,
    normalize: normalizePhoneForComparison,
  }),
});

const PLANT_SPEC = Object.freeze({
  targetField: 'Anlage',
  label: 'Anlage',
  normalize: value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase(),
});

const PLANT_MANUFACTURERS = Object.freeze(['Bosch', 'Buderus', 'Midea', 'Panasonic', 'Vaillant', 'Wolf']);
const OCR_PAGE_LIMIT = 20;

function compact(value, max = 260) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizePhoneForComparison(value) {
  let digits = String(value || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  if (digits.startsWith('0')) digits = `+49${digits.slice(1)}`;
  return digits;
}

function evidenceExcerpt(text, index, length) {
  const start = Math.max(0, index - 70);
  const end = Math.min(text.length, index + length + 90);
  return compact(text.slice(start, end));
}

function collectCandidates(pages, fieldKey, spec) {
  const candidates = [];
  pages.forEach((pageText, pageIndex) => {
    const text = String(pageText || '');
    for (const match of text.matchAll(new RegExp(spec.regex.source, spec.regex.flags))) {
      const value = compact(match[spec.valueGroup], 80).replace(/[.,;:]$/, '');
      const normalizedValue = spec.normalize(value);
      if (!normalizedValue) continue;
      if (['orderNumber', 'customerNumber'].includes(fieldKey) && !/\d/.test(normalizedValue)) continue;
      candidates.push({
        field: fieldKey,
        value,
        normalizedValue,
        page: pageIndex + 1,
        excerpt: evidenceExcerpt(text, match.index || 0, match[0].length),
        evidenceLabel: compact(match[1], 60),
        confidence: 0.98,
      });
    }

    if (fieldKey === 'orderNumber') {
      for (const match of text.matchAll(/\bHH-(?:AN|AB)-[A-Z0-9-]{4,30}\b/giu)) {
        const value = compact(match[0], 80).toUpperCase();
        if (candidates.some(candidate => candidate.page === pageIndex + 1 && candidate.normalizedValue === spec.normalize(value))) continue;
        candidates.push({
          field: fieldKey,
          value,
          normalizedValue: spec.normalize(value),
          page: pageIndex + 1,
          excerpt: evidenceExcerpt(text, match.index || 0, match[0].length),
          evidenceLabel: 'erkanntes HH-Auftragsnummernformat',
          confidence: 0.9,
        });
      }
      for (const match of text.matchAll(/\bHH-\s*.{0,80}?\b(AN-\d+(?:-\d+){2,})\b/giu)) {
        const value = `HH-${match[1].toUpperCase()}`;
        if (candidates.some(candidate => candidate.page === pageIndex + 1 && candidate.normalizedValue === spec.normalize(value))) continue;
        candidates.push({
          field: fieldKey,
          value,
          normalizedValue: spec.normalize(value),
          page: pageIndex + 1,
          excerpt: evidenceExcerpt(text, match.index || 0, match[0].length),
          evidenceLabel: 'rekonstruierte HH-Auftragsnummer aus Scan-Spalten',
          confidence: 0.86,
        });
      }
    }
  });
  return candidates;
}

function collectPlantCandidates(pages) {
  const candidates = [];
  const manufacturerPattern = PLANT_MANUFACTURERS.join('|');
  const patterns = [
    new RegExp(`W(?:ä|a)rmepumpenpaket\\s*(\\d+(?:[.,]\\d+)?)\\s*kW\\s*[-–]\\s*(${manufacturerPattern})`, 'giu'),
    new RegExp(`(${manufacturerPattern})\\s+W(?:ä|a)rmepumpenpaket\\s*(\\d+(?:[.,]\\d+)?)\\s*kW`, 'giu'),
  ];
  pages.forEach((pageText, pageIndex) => {
    const text = String(pageText || '');
    patterns.forEach((pattern, patternIndex) => {
      for (const match of text.matchAll(pattern)) {
        const manufacturerRaw = patternIndex === 0 ? match[2] : match[1];
        const powerRaw = patternIndex === 0 ? match[1] : match[2];
        const manufacturer = PLANT_MANUFACTURERS.find(item => item.toLowerCase() === String(manufacturerRaw).toLowerCase());
        const powerKw = Number(String(powerRaw).replace(',', '.'));
        if (!manufacturer || !Number.isFinite(powerKw)) continue;
        const value = `${manufacturer} ${String(powerKw).replace('.', ',')} kW`;
        const nearby = text.slice(match.index || 0, (match.index || 0) + 320);
        const model = nearby.match(/\bWH-[A-Z0-9-]{4,}\b/i)?.[0] || null;
        candidates.push({
          field: 'plant',
          value,
          normalizedValue: PLANT_SPEC.normalize(value),
          manufacturer,
          powerKw,
          model,
          page: pageIndex + 1,
          excerpt: evidenceExcerpt(text, match.index || 0, match[0].length),
          evidenceLabel: 'Wärmepumpenpaket mit Hersteller und Leistung',
          confidence: 0.99,
        });
      }
    });
  });
  return candidates;
}

function commandOutput(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { if (stdout.length < 2 * 1024 * 1024) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 64 * 1024) stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(compact(stderr || `OCR beendet mit Code ${code}`, 500))));
  });
}

async function resolveTesseract() {
  const candidates = ['/opt/homebrew/bin/tesseract', '/usr/local/bin/tesseract'];
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; }
    catch {}
  }
  return 'tesseract';
}

function imageToPortablePixmap(image) {
  const { width, height, channels } = image;
  if (channels === 1) return Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), Buffer.from(image.data)]);
  const source = image.data;
  const rgb = channels === 3 ? Buffer.from(source) : Buffer.alloc(width * height * 3);
  if (channels === 4) {
    for (let input = 0, output = 0; input < source.length; input += 4, output += 3) {
      rgb[output] = source[input];
      rgb[output + 1] = source[input + 1];
      rgb[output + 2] = source[input + 2];
    }
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), rgb]);
}

async function ocrMissingPdfPages(pdf, pageTexts) {
  const missingPages = pageTexts
    .map((text, index) => ({ index, chars: compact(text, Number.MAX_SAFE_INTEGER).length }))
    .filter(item => item.chars < MIN_TEXT_CHARS)
    .slice(0, OCR_PAGE_LIMIT);
  if (!missingPages.length) return { pageTexts, appliedPages: [], failedPages: [], engine: null };
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'iva-funding-ocr-'));
  const appliedPages = [];
  const failedPages = [];
  let engine = null;
  try {
    engine = await resolveTesseract();
    for (const page of missingPages) {
      try {
        const images = await extractImages(pdf, page.index + 1);
        const image = images.sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
        if (!image || image.width < 500 || image.height < 500 || ![1, 3, 4].includes(image.channels)) throw new Error('Keine ganzseitige Scan-Grafik gefunden.');
        const fileName = `page-${page.index + 1}.ppm`;
        await writeFile(path.join(temporaryDirectory, fileName), imageToPortablePixmap(image));
        const text = compact(await commandOutput(engine, [fileName, 'stdout', '-l', process.env.IVA_TESSERACT_LANG || 'eng', '--psm', '6'], { cwd: temporaryDirectory }), Number.MAX_SAFE_INTEGER);
        if (text.length < MIN_TEXT_CHARS) throw new Error('OCR lieferte keinen ausreichend lesbaren Text.');
        pageTexts[page.index] = text;
        appliedPages.push(page.index + 1);
      } catch (error) {
        failedPages.push({ page: page.index + 1, reason: compact(error.message, 220) });
      }
    }
  } catch (error) {
    for (const page of missingPages) failedPages.push({ page: page.index + 1, reason: compact(error.message, 220) });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
  return { pageTexts, appliedPages, failedPages, engine: engine ? path.basename(engine) : null };
}

function resolveCandidates(candidates, { sourceFile, ocrRequiredPages }) {
  let selectedCandidates = candidates;
  if (candidates.some(candidate => candidate.field === 'phoneNumber')) {
    const explicitlyLabeled = candidates.filter(candidate => candidate.evidenceLabel.toLowerCase() === 'telefonnummer');
    if (explicitlyLabeled.length) selectedCandidates = explicitlyLabeled;
  }
  const unique = new Map();
  for (const candidate of selectedCandidates) {
    const current = unique.get(candidate.normalizedValue);
    if (!current || candidate.confidence > current.confidence) unique.set(candidate.normalizedValue, candidate);
  }
  const uniqueCandidates = [...unique.values()].map(candidate => ({ ...candidate, sourceFile }));
  if (uniqueCandidates.length === 1) return {
    status: 'proposed',
    ...uniqueCandidates[0],
    candidates: uniqueCandidates,
  };
  if (uniqueCandidates.length > 1) return {
    status: 'ambiguous',
    value: null,
    sourceFile,
    candidates: uniqueCandidates,
    reason: 'Mehrere unterschiedliche Werte wurden gefunden.',
  };
  if (ocrRequiredPages.length) return {
    status: 'ocr_required',
    value: null,
    sourceFile,
    candidates: [],
    reason: 'Mindestens eine PDF-Seite besitzt keine ausreichend lesbare Textschicht.',
  };
  return { status: 'not_found', value: null, sourceFile, candidates: [] };
}

export function parseFundingDocumentPages(pageTexts, { sourceFile = 'Dokument.pdf' } = {}) {
  const pages = Array.isArray(pageTexts) ? pageTexts.map(value => String(value || '')) : [];
  if (!pages.length) throw new Error('Die PDF enthält keine Seiten.');
  const ocrRequiredPages = pages
    .map((text, index) => ({ page: index + 1, chars: compact(text, Number.MAX_SAFE_INTEGER).length }))
    .filter(item => item.chars < MIN_TEXT_CHARS)
    .map(item => item.page);
  const fields = Object.fromEntries(Object.entries(FIELD_SPECS).map(([fieldKey, spec]) => [
    fieldKey,
    resolveCandidates(collectCandidates(pages, fieldKey, spec), { sourceFile, ocrRequiredPages }),
  ]));
  fields.plant = resolveCandidates(collectPlantCandidates(pages), { sourceFile, ocrRequiredPages });
  return {
    sourceFile,
    totalPages: pages.length,
    textLayer: ocrRequiredPages.length === 0 ? 'readable' : ocrRequiredPages.length === pages.length ? 'ocr_required' : 'partly_readable',
    ocrRequiredPages,
    fields,
  };
}

export async function analyzeFundingPdf(filePath, { includePageText = false } = {}) {
  const absolutePath = path.resolve(String(filePath || ''));
  if (!filePath || path.extname(absolutePath).toLowerCase() !== '.pdf') throw new Error('Für die Dokumentauswertung wird eine PDF-Datei benötigt.');
  const file = await stat(absolutePath);
  if (!file.isFile()) throw new Error('Der PDF-Pfad verweist nicht auf eine Datei.');
  if (file.size > MAX_PDF_BYTES) throw new Error('Die PDF ist größer als 30 MB und wird nicht automatisch ausgewertet.');
  const bytes = await readFile(absolutePath);
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('Die Datei besitzt keinen gültigen PDF-Dateikopf.');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const extracted = await extractText(pdf, { mergePages: false });
  const ocr = await ocrMissingPdfPages(pdf, [...extracted.text]);
  const result = {
    ...parseFundingDocumentPages(ocr.pageTexts, { sourceFile: path.basename(absolutePath) }),
    absolutePath,
    fileSize: file.size,
    document: classifyFundingDocumentName(absolutePath),
    ocr: {
      appliedPages: ocr.appliedPages,
      failedPages: ocr.failedPages,
      engine: ocr.engine,
    },
  };
  if (includePageText) result.extractedPageTexts = ocr.pageTexts;
  return result;
}

function normalizeExisting(fieldKey, value) {
  const spec = FIELD_SPECS[fieldKey] || (fieldKey === 'plant' ? PLANT_SPEC : null);
  return spec?.normalize(value) || compact(value).toLowerCase();
}

export function buildPipedriveFieldProposals(snapshot = {}, analysis = {}) {
  const mappings = [
    ['orderNumber', 'orderNumber'],
    ['customerNumber', 'customerNumber'],
    ['phoneNumber', 'phoneNumber'],
    ['plant', 'plant'],
  ];
  const proposals = mappings.map(([fieldKey, snapshotKey]) => {
    const targetField = (FIELD_SPECS[fieldKey] || PLANT_SPEC).targetField;
    const extraction = analysis.fields?.[fieldKey] || { status: 'not_found' };
    const existingValue = compact(snapshot[snapshotKey], 100) || null;
    if (extraction.status !== 'proposed') return {
      field: fieldKey,
      targetField,
      action: extraction.status === 'ambiguous' || extraction.status === 'ocr_required' ? 'manual_review' : 'not_found',
      existingValue,
      proposedValue: null,
      extractionStatus: extraction.status,
      candidates: extraction.candidates || [],
    };
    const proposedValue = extraction.value;
    if (!existingValue) return {
      field: fieldKey,
      targetField,
      action: 'propose_fill',
      existingValue: null,
      proposedValue,
      evidence: {
        sourceFile: extraction.sourceFile,
        page: extraction.page,
        excerpt: extraction.excerpt,
        confidence: extraction.confidence,
      },
    };
    const equal = normalizeExisting(fieldKey, existingValue) === normalizeExisting(fieldKey, proposedValue);
    return {
      field: fieldKey,
      targetField,
      action: equal ? 'already_equal' : 'conflict',
      existingValue,
      proposedValue,
      evidence: {
        sourceFile: extraction.sourceFile,
        page: extraction.page,
        excerpt: extraction.excerpt,
        confidence: extraction.confidence,
      },
    };
  });
  return {
    dealId: snapshot.dealId || null,
    customerName: snapshot.customerName || null,
    proposals,
    canAutoFillBlankFields: proposals.some(item => item.action === 'propose_fill'),
    hasConflicts: proposals.some(item => item.action === 'conflict' || item.action === 'manual_review'),
    mutationPrepared: false,
    mutated: false,
  };
}

export function classifyFundingDocumentName(value) {
  const fileName = path.basename(String(value || '')).normalize('NFKC');
  const normalized = fileName.toLowerCase().replace(/[\s_-]+/g, ' ');
  if (/angebot.*(untersch(?:rieben|r?\.?|rift)?|unterzeichnet|signiert)|(?:untersch(?:rieben|r?\.?|rift)?|unterzeichnet|signiert).*angebot|\bHH-(?:AN|AB)-[A-Z0-9-]+.*(?:untersch(?:rieben|r?\.?|rift)?|unterzeichnet|signiert)/i.test(fileName)) {
    return { type: 'signed_offer', confidence: 0.99, fileName };
  }
  if (/(personalausweis|(?:^|\s)(?:ausweis|perso)(?:\s|\.|$)|identit[aä]tskarte|id karte)/i.test(normalized)) {
    return { type: 'identity_card', confidence: 0.96, fileName };
  }
  if (/(meldebescheinigung|meldebesch(?:einigung)?|meldebest(?:[aä]|ae)tigung|(?:^|\s)mb(?:\s|\.|$))/i.test(normalized)) {
    return { type: 'registration_certificate', confidence: 0.98, fileName };
  }
  if (/grundbuch(?:auszug)?|(?:^|\s)(?:gb|gba)(?:\s|\.|$)/i.test(normalized)) {
    return { type: 'land_register', confidence: 0.98, fileName };
  }
  if (/(einkommensteuer|steuerbescheid|est bescheid|bescheid)/i.test(normalized) && /2023/.test(normalized)) {
    return { type: 'tax_assessment_2023', confidence: 0.98, fileName };
  }
  if (/(einkommensteuer|steuerbescheid|est bescheid|bescheid)/i.test(normalized) && /2024/.test(normalized)) {
    return { type: 'tax_assessment_2024', confidence: 0.98, fileName };
  }
  if (/(kfw.{0,40}(konto|aktivierung|best(?:[aä]|ae)tigung|zugang|zuschuss)|(?:konto|aktivierung|best(?:[aä]|ae)tigung|zugang|zuschuss).{0,40}kfw|antragsbest(?:[aä]|ae)tigung.{0,30}heizungsf(?:[oö]|oe)rd)/i.test(normalized)) {
    return { type: 'kfw_account_confirmation', confidence: 0.94, fileName };
  }
  if (/(tmb|thb|moa|moreapp|registration)/i.test(normalized.replace(/\s+/g, ''))) {
    return { type: 'technical_feasibility', confidence: 0.95, fileName };
  }
  if (/\bHH-(?:AN|AB)-[A-Z0-9-]+\b/i.test(fileName) || /angebot/i.test(normalized)) {
    return { type: 'offer', confidence: 0.9, fileName };
  }
  return { type: 'unknown', confidence: 0, fileName };
}
