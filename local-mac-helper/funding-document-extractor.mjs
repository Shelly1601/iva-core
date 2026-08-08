import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { extractText, getDocumentProxy } from 'unpdf';

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
    }
  });
  return candidates;
}

function resolveCandidates(candidates, { sourceFile, ocrRequiredPages }) {
  const unique = new Map();
  for (const candidate of candidates) {
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
  return {
    sourceFile,
    totalPages: pages.length,
    textLayer: ocrRequiredPages.length === 0 ? 'readable' : ocrRequiredPages.length === pages.length ? 'ocr_required' : 'partly_readable',
    ocrRequiredPages,
    fields,
  };
}

export async function analyzeFundingPdf(filePath) {
  const absolutePath = path.resolve(String(filePath || ''));
  if (!filePath || path.extname(absolutePath).toLowerCase() !== '.pdf') throw new Error('Für die Dokumentauswertung wird eine PDF-Datei benötigt.');
  const file = await stat(absolutePath);
  if (!file.isFile()) throw new Error('Der PDF-Pfad verweist nicht auf eine Datei.');
  if (file.size > MAX_PDF_BYTES) throw new Error('Die PDF ist größer als 30 MB und wird nicht automatisch ausgewertet.');
  const bytes = await readFile(absolutePath);
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('Die Datei besitzt keinen gültigen PDF-Dateikopf.');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const extracted = await extractText(pdf, { mergePages: false });
  return {
    ...parseFundingDocumentPages(extracted.text, { sourceFile: path.basename(absolutePath) }),
    absolutePath,
    fileSize: file.size,
  };
}

function normalizeExisting(fieldKey, value) {
  const spec = FIELD_SPECS[fieldKey];
  return spec?.normalize(value) || compact(value).toLowerCase();
}

export function buildPipedriveFieldProposals(snapshot = {}, analysis = {}) {
  const mappings = [
    ['orderNumber', 'orderNumber'],
    ['customerNumber', 'customerNumber'],
    ['phoneNumber', 'phoneNumber'],
  ];
  const proposals = mappings.map(([fieldKey, snapshotKey]) => {
    const targetField = FIELD_SPECS[fieldKey].targetField;
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

