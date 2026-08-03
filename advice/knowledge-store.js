import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = process.env.DATA_DIR || '/data';
const STORE_FILE = path.join(DATA_DIR, 'advice-knowledge.json');
let writeQueue = Promise.resolve();

const REFERENCE_SOURCES = [
  { id: 'ref-din-77230', kind: 'norm-reference', category: 'finanzanalyse', provider: 'DIN', title: 'DIN 77230 · Basis-Finanzanalyse für Privathaushalte', url: 'https://www.din.de/resource/blob/280724/841131a8ca827346a7b4fac55ba2b801/20180608-pi-din-77230-data.pdf', verified: true, scope: 'Öffentliche Einordnung, nicht das lizenzierte Normregelwerk' },
  { id: 'ref-din-77235', kind: 'norm-reference', category: 'finanzanalyse', provider: 'DIN Media', title: 'DIN 77235:2021-10 · Selbstständige und KMU', url: 'https://www.dinmedia.de/de/norm/din-77235/343467665', verified: true, scope: 'Öffentliche Einordnung, nicht das lizenzierte Normregelwerk' },
  { id: 'ref-capitalflow', kind: 'benchmark', category: 'beratung', provider: 'CapitalFlow', title: 'Beratungssoftware und Finanzrechner', url: 'https://www.capital-flow.de/', verified: true, scope: 'Funktionsbenchmark' },
  { id: 'ref-finanzportal24', kind: 'benchmark', category: 'beratung', provider: 'FinanzPortal24', title: 'etops FinanzPortal · DIN-Analyse und Dokumentation', url: 'https://finanzportal24.de/', verified: true, scope: 'Funktionsbenchmark' },
];

const STARTER_PRODUCT_SOURCES = [
  { id: 'product-barmenia-hausrat-top', kind: 'terms', category: 'hausrat', provider: 'Barmenia', product: 'Hausratversicherung', tariff: 'Top-Schutz', title: 'Barmenia Hausrat Top-Schutz · Leistungsübersicht und Bedingungen', url: 'https://media.barmenia.de/media/global_media/dokumente/dokumentencenter/ba/bedingungen/A3642.pdf', verified: true, status: 'source-linked', scope: 'Originalquelle des Versicherers; Tarifstand im Dokument prüfen' },
  { id: 'product-huk-hausrat-2024', kind: 'terms', category: 'hausrat', provider: 'HUK-COBURG', product: 'Hausratversicherung', tariff: 'VHB 2024', year: '2026', title: 'HUK-COBURG Hausrat · Allgemeine Versicherungsbedingungen', url: 'https://www.huk.de/content/dam/hukde/dokumente/produkte/allgemeine_versicherungsbedingungen_hausratversicherung.pdf', verified: true, status: 'source-linked', scope: 'Originalquelle des Versicherers; Dokumentstand 06/2026' },
  { id: 'product-allianz-hausrat-docs', kind: 'product-document', category: 'hausrat', provider: 'Allianz', product: 'PrivatSchutz Hausrat', title: 'Allianz Hausrat · Bedingungen und Produktinformationsblätter', url: 'https://www.allianz.de/service/dokumente/', verified: true, status: 'source-linked', scope: 'Offizielles Dokumentencenter mit Basis, Smart, Komfort und Premium' },
  { id: 'product-axa-hausrat-docs', kind: 'product-document', category: 'hausrat', provider: 'AXA', product: 'Privat-Schutz Hausrat', title: 'AXA Hausrat · Bedingungen und Produktkurzinformationen', url: 'https://www.axa.de/kontakt/formulare-download', verified: true, status: 'source-linked', scope: 'Offizielles Dokumentencenter; konkreten Tarifstand im PDF prüfen' },
];

function clean(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function safeClone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function loadStore() {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE_FILE, 'utf8'));
    return { version: 1, sources: Array.isArray(parsed?.sources) ? parsed.sources : [] };
  } catch {
    return { version: 1, sources: [] };
  }
}

async function saveStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temp = STORE_FILE + '.tmp';
  await fs.writeFile(temp, JSON.stringify(store, null, 2));
  await fs.rename(temp, STORE_FILE);
}

function searchable(source) {
  return [source.provider, source.product, source.tariff, source.title, source.category, source.year, source.documentType, source.notes]
    .map(value => clean(value).toLowerCase())
    .join(' ');
}

export async function listAdviceKnowledge({ search = '', category = '', limit = 50 } = {}) {
  const store = await loadStore();
  const query = clean(search, 200).toLowerCase();
  const wantedCategory = clean(category, 100).toLowerCase();
  const combined = [...REFERENCE_SOURCES, ...STARTER_PRODUCT_SOURCES, ...store.sources];
  const sources = combined
    .filter(source => !wantedCategory || clean(source.category).toLowerCase() === wantedCategory)
    .filter(source => !query || query.split(/\s+/).filter(Boolean).every(term => searchable(source).includes(term)))
    .slice(0, Math.min(Math.max(Number(limit) || 50, 1), 200))
    .map(safeClone);
  return {
    sources,
    total: combined.length,
    productDocumentCount: [...STARTER_PRODUCT_SOURCES, ...store.sources].filter(source => ['product-document', 'ipid', 'terms'].includes(source.kind)).length,
    referenceCount: REFERENCE_SOURCES.length,
    policy: 'Vergleiche duerfen nur belegte Originalquellen verwenden; fehlende Tarifdaten werden nicht erfunden.',
  };
}

export async function addAdviceKnowledgeSource(input = {}) {
  const kind = clean(input.kind, 80) || 'product-document';
  if (!['product-document', 'terms', 'ipid', 'benchmark', 'norm-reference'].includes(kind)) throw new Error('Unbekannter Quellentyp.');
  const title = clean(input.title, 300);
  const url = clean(input.url, 1500);
  if (!title || !url) throw new Error('Titel und Quellen-URL sind erforderlich.');
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { throw new Error('Die Quellen-URL ist ungueltig.'); }
  if (!['https:', 'http:'].includes(parsedUrl.protocol)) throw new Error('Nur HTTP- oder HTTPS-Quellen sind erlaubt.');
  const now = new Date().toISOString();
  const source = {
    id: crypto.randomUUID(), kind, category: clean(input.category, 120), provider: clean(input.provider, 240), product: clean(input.product, 240),
    tariff: clean(input.tariff, 240), year: clean(input.year, 40), documentType: clean(input.documentType, 120), title, url,
    validFrom: clean(input.validFrom, 80), validTo: clean(input.validTo, 80), notes: clean(input.notes, 3000), verified: false,
    status: 'pending-review', createdAt: now, updatedAt: now,
  };
  const operation = writeQueue.then(async () => {
    const store = await loadStore();
    store.sources.push(source);
    await saveStore(store);
    return safeClone(source);
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

export async function adviceKnowledgeStatus() {
  const result = await listAdviceKnowledge({ limit: 1 });
  return { total: result.total, productDocumentCount: result.productDocumentCount, referenceCount: result.referenceCount };
}
