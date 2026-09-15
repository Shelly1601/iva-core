import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractText } from 'unpdf';
import { financialPlanDefaults, calculateFinancialPlan, FINANCIAL_PLAN_FIELDS } from '../public/advice-finance.js';
import { adviceError, adviceId, cleanText, digest, INSURANCE_CATEGORIES, defaultCriteria, normalizeCriteria, normalizeContract, evaluateInsuranceCase } from './comparison.js';
import { providerCatalog, normalizeProviderSetup, buildProviderPreparation, ADVICE_PROVIDER_SOURCES } from './providers.js';
import { suggestContractEvidence } from './extract.js';

const queues = new Map();
export function createAdviceWorkbench({ dataDir, getProject, getCustomer } = {}) {
  if (!path.isAbsolute(dataDir || '') || typeof getProject !== 'function' || typeof getCustomer !== 'function') throw new TypeError('Advice workbench requires absolute dataDir, getProject and project-scoped getCustomer.');
  const directory = path.join(dataDir, 'advice-workbench');
  const scopeId = scope => adviceId(scope?.projectId);
  async function project(scope) { const id = scopeId(scope); if (!await getProject(id)) throw adviceError('Projekt nicht verfügbar.', 404); return id; }
  async function customer(projectId, id) { const row = await getCustomer(projectId, adviceId(id)); if (!row || (row.projectId && row.projectId !== projectId)) throw adviceError('Kunde ist diesem Projekt nicht zugeordnet.', 404); return row; }
  async function ready() { await fs.mkdir(directory, { recursive: true, mode: 0o700 }); const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw adviceError('Beratungsablage nicht verfügbar.', 503); }
  async function load(id) {
    await ready(); const file = path.join(directory, `${id}.json`);
    try { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32e6) throw adviceError('Beratungsablage nicht sicher lesbar.', 503); const value = JSON.parse(await fs.readFile(file, 'utf8')); if (value.projectId !== id || !Array.isArray(value.cases)) throw adviceError('Beratungsablage beschädigt.', 503); return value; }
    catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, projectId: id, cases: [], favorites: [], providers: {} }; throw adviceError('Beratungsablage nicht verfügbar.', 503); }
  }
  async function locked(id, fn) {
    await ready(); const lock = path.join(directory, `${id}.lock`), nonce = randomUUID(), deadline = Date.now() + 5000;
    while (true) {
      try { const handle = await fs.open(lock, 'wx', 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); await handle.close(); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const owner = await fs.readFile(lock, 'utf8').then(JSON.parse).catch(() => null);
        if (Number.isInteger(owner?.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); }
          catch (probe) { if (probe.code === 'ESRCH') { try { await fs.mkdir(`${lock}.recovery`); try { const current = await fs.readFile(lock, 'utf8').then(JSON.parse); if (current.nonce === owner.nonce) await fs.unlink(lock); } finally { await fs.rmdir(`${lock}.recovery`); } } catch (recovery) { if (!['ENOENT', 'EEXIST'].includes(recovery.code)) throw recovery; } continue; } }
        }
        if (Date.now() > deadline) throw adviceError('Beratung wird gerade gespeichert. Bitte unverändert erneut versuchen.', 409, 'ADVICE_BUSY'); await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    try { return await fn(); } finally { const current = await fs.readFile(lock, 'utf8').then(JSON.parse).catch(() => null); if (current?.nonce === nonce) await fs.unlink(lock).catch(() => {}); }
  }
  async function mutate(scope, fn) {
    const id = await project(scope), key = path.join(directory, `${id}.json`);
    const pending = (queues.get(key) || Promise.resolve()).catch(() => {}).then(() => locked(id, async () => {
      const state = await load(id), result = await fn(state); if (state.cases.length > 200) throw adviceError('Projekt hat die maximale Anzahl Beratungsfälle erreicht.', 413);
      const body = JSON.stringify(state); if (Buffer.byteLength(body) > 32e6) throw adviceError('Beratungsablage ist voll.', 413);
      const temporary = `${key}.${randomUUID()}.tmp`; await fs.writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
      try { await fs.rename(temporary, key); } finally { await fs.unlink(temporary).catch(() => {}); } return structuredClone(result);
    }));
    const tail = pending.catch(() => {}); queues.set(key, tail); void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); }); return pending;
  }
  const caseIn = (state, id) => { const record = state.cases.find(row => row.id === adviceId(id)); if (!record) throw adviceError('Beratungsfall nicht gefunden.', 404); return record; };
  const checkRevision = (record, revision) => { if (!Number.isInteger(revision) || record.revision !== revision) throw adviceError('Die Beratungsakte wurde inzwischen geändert. Bitte neu laden.', 409, 'ADVICE_REVISION_CONFLICT'); };
  const documentPublic = ({ text, base64, ...row }) => ({ ...row, preview: text.slice(0, 600), textCharacters: text.length });
  const publicRecord = (record, state) => ({ ...record, documents: record.documents.map(documentPublic), evaluation: record.kind === 'finance' ? calculateFinancialPlan(record.financeInput) : evaluateInsuranceCase(record, { favorites: state.favorites }) });
  async function catalog(scope) { const state = await load(await project(scope)); return { categories: INSURANCE_CATEGORIES, financeFields: FINANCIAL_PLAN_FIELDS, providers: providerCatalog(state.providers), sources: ADVICE_PROVIDER_SOURCES, favorites: state.favorites }; }
  async function list(scope) { const id = await project(scope), state = await load(id), rows = []; for (const row of state.cases) { if (await getCustomer(id, row.customerId)) rows.push({ id: row.id, projectId: id, customerId: row.customerId, title: row.title, kind: row.kind, category: row.category, revision: row.revision, updatedAt: row.updatedAt }); } return rows; }
  async function raw(scope, id) { const projectId = await project(scope), state = await load(projectId), record = caseIn(state, id); await customer(projectId, record.customerId); return { record, state }; }
  async function get(scope, id) { const { record, state } = await raw(scope, id); return publicRecord(record, state); }
  async function create(scope, input) {
    const projectId = await project(scope); await customer(projectId, input.customerId);
    if (!['finance', 'insurance'].includes(input.kind)) throw adviceError('Beratungsart muss finance oder insurance sein.');
    const criteria = input.kind === 'insurance' ? defaultCriteria(input.category) : [];
    return mutate(scope, state => {
      const now = new Date().toISOString(), record = { id: randomUUID(), projectId, customerId: adviceId(input.customerId), title: cleanText(input.title, 'Titel', 200), kind: input.kind, category: input.kind === 'insurance' ? input.category : null, revision: 1, createdAt: now, updatedAt: now, financeInput: financialPlanDefaults(), criteria, oldContract: null, offers: [], documents: [], notes: '', riskProfile: '' };
      state.cases.unshift(record); return publicRecord(record, state);
    });
  }
  async function update(scope, id, input) {
    return mutate(scope, async state => {
      const record = caseIn(state, id); await customer(state.projectId, record.customerId); checkRevision(record, input.expectedRevision);
      if ('title' in input) record.title = cleanText(input.title, 'Titel', 200);
      for (const key of ['notes', 'riskProfile']) if (key in input) record[key] = cleanText(input[key], key, 6000, true);
      if (record.kind === 'finance' && 'financeInput' in input) {
        const result = calculateFinancialPlan(input.financeInput); if (result.status !== 'scenario') throw adviceError(result.issues.map(issue => issue.message).join(' ')); record.financeInput = result.input;
      }
      if (record.kind === 'insurance') {
        const criteria = 'criteria' in input ? normalizeCriteria(input.criteria) : record.criteria;
        const offers = input.offers ?? record.offers; if (!Array.isArray(offers) || offers.length > 30 || new Set(offers.map(row => row.id)).size !== offers.length) throw adviceError('Bis zu dreißig eindeutig benannte Angebote möglich.');
        record.oldContract = normalizeContract('oldContract' in input ? input.oldContract : record.oldContract, criteria, record.documents, { old: true });
        record.offers = offers.map(row => normalizeContract(row, criteria, record.documents)); record.criteria = criteria;
      }
      record.revision++; record.updatedAt = new Date().toISOString(); return publicRecord(record, state);
    });
  }
  async function addDocument(scope, id, { filename, contentType, buffer, base64, expectedRevision }) {
    const bytes = buffer ?? (typeof base64 === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(base64) ? Buffer.from(base64, 'base64') : null);
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 8e6) throw adviceError('PDF oder Textdatei mit maximal 8 MB erforderlich.', 413);
    if (!['application/pdf', 'text/plain'].includes(contentType)) throw adviceError('Nur PDF und UTF-8-Text werden eingelesen.');
    const { record: original } = await raw(scope, id); checkRevision(original, expectedRevision);
    let text;
    try { text = contentType === 'application/pdf' ? (await extractText(new Uint8Array(bytes), { mergePages: true })).text : bytes.toString('utf8'); } catch { throw adviceError('Das Dokument kann nicht zuverlässig gelesen werden.'); }
    if (typeof text !== 'string' || text.trim().length < 5 || text.includes('\uFFFD')) throw adviceError('Kein ausreichend lesbarer Text. Ein Scan benötigt zuerst Texterkennung.', 422, 'ADVICE_OCR_REQUIRED');
    if (text.length > 150000) throw adviceError('Bitte einen kleineren konkreten Dokumentabschnitt hochladen.', 413);
    return mutate(scope, async state => { const record = caseIn(state, id); await customer(state.projectId, record.customerId); checkRevision(record, expectedRevision);
      const sha256 = digest(bytes), duplicate = record.documents.find(row => row.sha256 === sha256); if (duplicate) return publicRecord(record, state);
      if (record.documents.length >= 30) throw adviceError('Höchstens dreißig Dokumente je Beratungsfall.');
      // Preserve original bytes for user-requested form preparation; never expose
      // them in list responses or to another project/customer.
      record.documents.push({ id: randomUUID(), filename: cleanText(filename, 'Dateiname', 200), contentType, sha256, addedAt: new Date().toISOString(), text: text.trim(), base64: bytes.toString('base64'), status: 'text-readable', provenance: 'user-upload' });
      record.revision++; record.updatedAt = new Date().toISOString(); return publicRecord(record, state);
    });
  }
  async function document(scope, id, documentId) { const { record } = await raw(scope, id), row = record.documents.find(row => row.id === adviceId(documentId)); if (!row) throw adviceError('Dokument nicht gefunden.', 404); return { ...documentPublic(row), text: row.text, suggestions: suggestContractEvidence(row), buffer: Buffer.from(row.base64, 'base64') }; }
  async function setFavorite(scope, input) {
    defaultCriteria(input.category); const favorite = { category: input.category, provider: cleanText(input.provider, 'Versicherer', 160), tariff: cleanText(input.tariff, 'Tarif', 200) };
    return mutate(scope, state => { state.favorites = state.favorites.filter(row => !Object.keys(favorite).every(key => row[key] === favorite[key])); if (input.favorite === true) state.favorites.push(favorite); if (state.favorites.length > 100) throw adviceError('Höchstens hundert Projektfavoriten möglich.'); return state.favorites; });
  }
  async function configureProvider(scope, id, input) { const configuration = normalizeProviderSetup(id, input); return mutate(scope, state => { state.providers[id] = configuration; return providerCatalog(state.providers).find(row => row.id === id); }); }
  async function preparation(scope, id, providerId) { const { record, state } = await raw(scope, id); if (record.kind !== 'insurance') throw adviceError('Nur Versicherungsfälle können übergeben werden.'); return buildProviderPreparation(record, await customer(record.projectId, record.customerId), providerCatalog(state.providers).find(row => row.id === providerId)); }
  async function exportRecord(scope, id) { const { record, state } = await raw(scope, id); return { ...record, customer: await customer(record.projectId, record.customerId), evaluation: record.kind === 'finance' ? calculateFinancialPlan(record.financeInput) : evaluateInsuranceCase(record, { favorites: state.favorites }) }; }
  return { catalog, list, create, get, update, addDocument, document, setFavorite, configureProvider, preparation, exportRecord };
}
