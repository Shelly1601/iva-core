import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = process.env.DATA_DIR || '/data';
const STORE_FILE = path.join(DATA_DIR, 'accounting.json');
const FILES_DIR = path.join(DATA_DIR, 'accounting-files');
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/xml',
  'text/xml',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'application/octet-stream',
]);
const CATEGORIES = [
  'arbeitsmittel', 'software', 'telekommunikation', 'marketing', 'fortbildung',
  'versicherung', 'bank-steuerberatung', 'fremdleistung', 'reise', 'bewirtung',
  'geschenk', 'buero', 'fahrzeug', 'sonstiges', 'privat',
];
let writeQueue = Promise.resolve();

function cleanText(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function numberOrZero(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function publicDocument(document) {
  const copy = structuredClone(document);
  if (copy.file) delete copy.file.storageName;
  return copy;
}

async function loadStore() {
  try {
    const data = JSON.parse(await fs.readFile(STORE_FILE, 'utf8'));
    return {
      version: 1,
      entities: Array.isArray(data?.entities) ? data.entities : [],
      documents: Array.isArray(data?.documents) ? data.documents : [],
    };
  } catch {
    return { version: 1, entities: [], documents: [] };
  }
}

async function saveStore(data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temporary = STORE_FILE + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(data, null, 2));
  await fs.rename(temporary, STORE_FILE);
}

function mutate(fn) {
  const job = writeQueue.then(async () => {
    const data = await loadStore();
    const result = await fn(data);
    await saveStore(data);
    return result;
  });
  writeQueue = job.catch(() => {});
  return job;
}

function safeExtension(name) {
  const extension = path.extname(String(name || '')).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '';
}

function assessment(document, entities) {
  const missing = [];
  const entity = entities.find(item => item.id === document.entityId);
  if (!entity) missing.push('Firma/Rechtsträger');
  if (!document.vendor) missing.push('Aussteller');
  if (!document.invoiceDate) missing.push('Belegdatum');
  if (!(document.amountGross > 0)) missing.push('Bruttobetrag');
  if (!document.businessPurpose) missing.push('geschäftlicher Zweck');
  if (document.category === 'bewirtung') {
    if (!document.hospitality?.occasion) missing.push('Bewirtungsanlass');
    if (!document.hospitality?.participants) missing.push('Bewirtungsteilnehmer');
  }
  if (document.duplicateOf) {
    return { trafficLight: 'red', workflowStatus: 'blocked', missing, reason: 'Mögliche Dublette – Originalbeleg bereits vorhanden.' };
  }
  if (document.category === 'privat' || document.privateShare >= 100) {
    return { trafficLight: 'red', workflowStatus: 'blocked', missing, reason: 'Als privat markiert – nicht für die betriebliche Buchhaltung freigegeben.' };
  }
  if (missing.length) {
    return { trafficLight: 'yellow', workflowStatus: 'review', missing, reason: `Noch offen: ${missing.join(', ')}.` };
  }
  return { trafficLight: 'green', workflowStatus: 'ready', missing: [], reason: 'Pflichtangaben für die interne Vorprüfung sind vollständig.' };
}

function applyAssessment(document, entities) {
  document.assessment = assessment(document, entities);
  return document;
}

export const ACCOUNTING_CATEGORIES = CATEGORIES;

export async function listAccountingEntities() {
  return (await loadStore()).entities.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

export async function createAccountingEntity(input = {}) {
  const name = cleanText(input.name, 180);
  if (!name) throw new Error('Name der Firma/des Rechtsträgers fehlt.');
  return mutate(data => {
    const existing = data.entities.find(item => item.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const now = new Date().toISOString();
    const entity = {
      id: crypto.randomUUID(),
      name,
      legalForm: cleanText(input.legalForm, 80),
      taxMode: ['euer', 'bilanz', 'unknown'].includes(input.taxMode) ? input.taxMode : 'unknown',
      vatStatus: ['regular', 'small-business', 'exempt', 'unknown'].includes(input.vatStatus) ? input.vatStatus : 'unknown',
      createdAt: now,
      updatedAt: now,
    };
    data.entities.push(entity);
    return entity;
  });
}

export async function listAccountingDocuments({ month, status, entityId, search } = {}) {
  const query = cleanText(search, 200).toLowerCase();
  const data = await loadStore();
  return data.documents
    .filter(item => !month || String(item.invoiceDate || item.createdAt).startsWith(month))
    .filter(item => !status || item.assessment?.workflowStatus === status || item.assessment?.trafficLight === status)
    .filter(item => !entityId || item.entityId === entityId)
    .filter(item => !query || [item.vendor, item.invoiceNumber, item.businessPurpose, item.file?.name].some(value => String(value || '').toLowerCase().includes(query)))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map(publicDocument);
}

export async function getAccountingDocument(id) {
  const item = (await loadStore()).documents.find(document => document.id === id);
  return item ? publicDocument(item) : null;
}

export async function storeAccountingDocument({ name, mime, buffer, entityId = '' }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Leere Datei.');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('Datei ist größer als 25 MB.');
  const normalizedMime = cleanText(mime, 160).toLowerCase() || 'application/octet-stream';
  if (!ALLOWED_MIME.has(normalizedMime)) throw new Error('Erlaubt sind PDF, XML/E-Rechnung, JPG, PNG und HEIC.');
  const originalName = cleanText(name, 240) || 'beleg';
  const id = crypto.randomUUID();
  const storageName = id + safeExtension(originalName);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  await fs.mkdir(FILES_DIR, { recursive: true });
  await fs.writeFile(path.join(FILES_DIR, storageName), buffer, { flag: 'wx' });
  return mutate(data => {
    const now = new Date().toISOString();
    const duplicate = data.documents.find(item => item.file?.sha256 === sha256);
    const document = {
      id,
      entityId: data.entities.some(item => item.id === entityId) ? entityId : '',
      vendor: '',
      invoiceDate: '',
      serviceDate: '',
      invoiceNumber: '',
      amountNet: 0,
      vatAmount: 0,
      amountGross: 0,
      currency: 'EUR',
      category: 'sonstiges',
      businessPurpose: '',
      privateShare: 0,
      hospitality: { occasion: '', participants: '' },
      payment: { reference: '', paidAt: '', method: '' },
      duplicateOf: duplicate?.id || '',
      extraction: { status: 'pending', source: 'manual-review', confidence: 0 },
      file: { name: originalName, mime: normalizedMime, bytes: buffer.length, sha256, storageName, createdAt: now },
      audit: [{ at: now, action: 'document-uploaded', fields: ['file'] }],
      createdAt: now,
      updatedAt: now,
    };
    applyAssessment(document, data.entities);
    data.documents.push(document);
    return publicDocument(document);
  });
}

export async function updateAccountingDocument(id, patch = {}) {
  return mutate(data => {
    const document = data.documents.find(item => item.id === id);
    if (!document) return null;
    const changed = [];
    const textFields = ['vendor', 'invoiceDate', 'serviceDate', 'invoiceNumber', 'businessPurpose'];
    for (const field of textFields) {
      if (field in patch) { document[field] = cleanText(patch[field], field === 'businessPurpose' ? 2000 : 240); changed.push(field); }
    }
    if ('entityId' in patch) { document.entityId = data.entities.some(item => item.id === patch.entityId) ? patch.entityId : ''; changed.push('entityId'); }
    if ('category' in patch && CATEGORIES.includes(patch.category)) { document.category = patch.category; changed.push('category'); }
    for (const field of ['amountNet', 'vatAmount', 'amountGross']) {
      if (field in patch) { document[field] = Math.max(0, numberOrZero(patch[field])); changed.push(field); }
    }
    if ('privateShare' in patch) { document.privateShare = Math.min(100, Math.max(0, numberOrZero(patch.privateShare))); changed.push('privateShare'); }
    if (patch.hospitality && typeof patch.hospitality === 'object') {
      document.hospitality = {
        occasion: cleanText(patch.hospitality.occasion, 1000),
        participants: cleanText(patch.hospitality.participants, 2000),
      };
      changed.push('hospitality');
    }
    if (patch.payment && typeof patch.payment === 'object') {
      document.payment = {
        reference: cleanText(patch.payment.reference, 500),
        paidAt: cleanText(patch.payment.paidAt, 40),
        method: cleanText(patch.payment.method, 80),
      };
      changed.push('payment');
    }
    const now = new Date().toISOString();
    document.updatedAt = now;
    document.audit.push({ at: now, action: 'document-reviewed', fields: changed });
    applyAssessment(document, data.entities);
    return publicDocument(document);
  });
}

export async function readAccountingFile(id) {
  const document = (await loadStore()).documents.find(item => item.id === id);
  const storageName = document?.file?.storageName;
  if (!storageName || !/^[a-f0-9-]+(?:\.[a-z0-9]{1,8})?$/i.test(storageName)) return null;
  const buffer = await fs.readFile(path.join(FILES_DIR, storageName));
  const meta = publicDocument(document).file;
  return { meta, buffer };
}

export async function accountingSummary({ month } = {}) {
  const documents = await listAccountingDocuments({ month });
  const counts = { all: documents.length, ready: 0, review: 0, blocked: 0 };
  let gross = 0;
  let vat = 0;
  for (const document of documents) {
    const status = document.assessment?.workflowStatus || 'review';
    counts[status] = (counts[status] || 0) + 1;
    if (status !== 'blocked') { gross += numberOrZero(document.amountGross); vat += numberOrZero(document.vatAmount); }
  }
  return {
    month: month || '',
    counts,
    totals: { gross: numberOrZero(gross), vatCandidate: numberOrZero(vat), currency: 'EUR' },
    completeness: counts.all ? Math.round((counts.ready / counts.all) * 100) : 0,
    sourceOfTruth: 'IVA Buchhaltung',
    taxSubmissionEnabled: false,
  };
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

export async function exportAccountingCsv({ month } = {}) {
  const data = await loadStore();
  const documents = await listAccountingDocuments({ month });
  const entityName = id => data.entities.find(item => item.id === id)?.name || 'Nicht zugeordnet';
  const header = ['ID', 'Firma', 'Belegdatum', 'Aussteller', 'Rechnungsnummer', 'Kategorie', 'Geschäftlicher Zweck', 'Netto', 'USt', 'Brutto', 'Privatanteil %', 'Ampel', 'Status', 'Originaldatei', 'SHA-256'];
  const lines = documents.map(document => [
    document.id, entityName(document.entityId), document.invoiceDate, document.vendor, document.invoiceNumber,
    document.category, document.businessPurpose, document.amountNet, document.vatAmount, document.amountGross,
    document.privateShare, document.assessment?.trafficLight, document.assessment?.workflowStatus,
    document.file?.name, document.file?.sha256,
  ].map(csvCell).join(';'));
  return '\uFEFF' + [header.map(csvCell).join(';'), ...lines].join('\n');
}

