import {
  QONEKTO_CONFIRMATION_PHRASE,
  callQonektoReadTool,
  listQonektoTools,
  prepareQonektoWriteAction,
} from './qonekto.js';

const CATALOG_TTL_MS = 60_000;
const CUSTOMER_CACHE_TTL_MS = 2 * 60_000;
const DETAIL_CACHE_TTL_MS = 5 * 60_000;
const MAX_CUSTOMERS = 100;

let catalogCache = null;
const resultCache = new Map();

function normalizeName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase();
}

function cleanText(value, max = 1000) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

function parseJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return '';
  try { return parseJson(JSON.parse(trimmed)); }
  catch { return value; }
}

export function unwrapQonektoResult(value, depth = 0) {
  if (depth > 8 || value === undefined || value === null) return value;
  const parsed = parseJson(value);
  if (parsed !== value) return unwrapQonektoResult(parsed, depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 1) return unwrapQonektoResult(value[0], depth + 1);
    if (value.every(item => item?.type === 'text' && typeof item.text === 'string')) {
      return value.map(item => unwrapQonektoResult(item.text, depth + 1));
    }
    return value;
  }
  if (typeof value !== 'object') return value;
  if ('readOnly' in value && 'result' in value) return unwrapQonektoResult(value.result, depth + 1);
  if (value.structuredContent !== undefined) return unwrapQonektoResult(value.structuredContent, depth + 1);
  if (Array.isArray(value.content)) {
    const content = value.content
      .map(item => item?.text !== undefined ? unwrapQonektoResult(item.text, depth + 1) : unwrapQonektoResult(item, depth + 1));
    return content.length === 1 ? content[0] : content;
  }
  if (value.content && typeof value.content === 'object') return unwrapQonektoResult(value.content, depth + 1);
  if (value.text !== undefined && Object.keys(value).every(key => ['type', 'text', 'annotations', '_meta'].includes(key))) {
    return unwrapQonektoResult(value.text, depth + 1);
  }
  return value;
}

function arrayFromPayload(payload, keys = []) {
  const value = unwrapQonektoResult(payload);
  if (Array.isArray(value)) {
    if (value.length === 1 && Array.isArray(value[0])) return value[0];
    return value;
  }
  if (!value || typeof value !== 'object') return [];
  for (const key of [...keys, 'data', 'items', 'results']) {
    if (Array.isArray(value[key])) return value[key];
    if (value[key] && typeof value[key] === 'object') {
      const nested = arrayFromPayload(value[key], keys);
      if (nested.length) return nested;
    }
  }
  return [];
}

function communicationValue(raw, types) {
  for (const key of types) {
    if (raw?.[key]) return cleanText(raw[key], 320);
  }
  const communications = Array.isArray(raw?.kommunikationen) ? raw.kommunikationen : [];
  const wanted = types.map(normalizeName);
  for (const item of communications) {
    const type = normalizeName(item?.art || item?.typ || item?.type || item?.bezeichnung || item?.key);
    if (!wanted.some(candidate => type.includes(candidate))) continue;
    const value = item?.wert || item?.value || item?.inhalt || item?.adresse;
    if (value) return cleanText(value, 320);
  }
  return '';
}

export function normalizeQonektoCustomer(raw = {}) {
  const firstName = cleanText(raw.vorname ?? raw.first_name ?? raw.firstName, 160);
  const lastName = cleanText(raw.nachname ?? raw.last_name ?? raw.lastName, 200);
  const company = cleanText(raw.firma ?? raw.unternehmen ?? raw.company, 240);
  const title = cleanText(raw.titel ?? raw.title, 80);
  const id = cleanText(raw.ameise_id ?? raw.kunde_ameise_id ?? raw.customer_id ?? raw.id, 160);
  const name = cleanText(raw.name, 320) || company || [title, firstName, lastName].filter(Boolean).join(' ') || `Kunde ${id}`;
  const street = cleanText(raw.strasse ?? raw.street, 240);
  const zip = cleanText(raw.plz ?? raw.postleitzahl ?? raw.zip, 40);
  const city = cleanText(raw.ort ?? raw.city, 160);
  return {
    id,
    name,
    firstName,
    lastName,
    company,
    email: communicationValue(raw, ['email', 'e_mail', 'mail']),
    phone: communicationValue(raw, ['telefon', 'phone', 'festnetz']),
    mobile: communicationValue(raw, ['mobil', 'mobile', 'handy']),
    street,
    zip,
    city,
    address: [street, [zip, city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    birthDate: cleanText(raw.geburtsdatum ?? raw.birth_date, 80),
    profession: cleanText(raw.beruf ?? raw.profession, 200),
    brokerId: cleanText(raw.vermittler_id ?? raw.broker_id, 100),
    salutation: cleanText(raw.anrede ?? raw.salutation, 100),
    legalForm: cleanText(raw.rechtsform ?? raw.legal_form, 160),
    simplrUsername: cleanText(raw.benutzername_simplr ?? raw.simplr_username, 200),
    perDu: Boolean(raw.per_du ?? raw.perDu),
    deceased: Boolean(raw.verstorben ?? raw.deceased),
    raw,
  };
}

export function normalizeQonektoContract(raw = {}) {
  return {
    id: cleanText(raw.ameise_id ?? raw.vertrag_ameise_id ?? raw.contract_id ?? raw.id, 160),
    customerId: cleanText(raw.kunde_id ?? raw.customer_id, 160),
    category: cleanText(raw.sparte ?? raw.category, 200) || 'Sonstige',
    company: cleanText(raw.gesellschaft ?? raw.company ?? raw.insurer, 240),
    companyId: cleanText(raw.gesellschaft_id ?? raw.company_id, 120),
    policyNumber: cleanText(raw.versicherungsscheinnummer ?? raw.vertragsnummer ?? raw.policy_number, 200),
    status: cleanText(raw.status ?? raw.status_id, 120),
    start: cleanText(raw.beginn ?? raw.start_date, 80),
    end: cleanText(raw.ablauf ?? raw.end_date, 80),
    paymentFrequency: cleanText(raw.zahlweise ?? raw.payment_frequency, 120),
    netPremium: raw.beitrag_netto ?? raw.tarifbeitrag ?? raw.net_premium ?? null,
    risk: cleanText(raw.risiko ?? raw.risk, 500),
    raw,
  };
}

function publicTool(tool) {
  return {
    name: tool.name,
    description: tool.description || '',
    inputSchema: tool.inputSchema || { type: 'object', properties: {} },
    mode: tool.mode,
  };
}

async function getCatalog({ force = false } = {}) {
  if (!force && catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.tools;
  const catalog = await listQonektoTools();
  const tools = Array.isArray(catalog?.tools) ? catalog.tools.map(publicTool) : [];
  catalogCache = { at: Date.now(), tools };
  return tools;
}

function scoreTool(tool, { candidates = [], words = [], mode = 'read' }) {
  if (tool.mode !== mode) return -1;
  const normalized = normalizeName(tool.name);
  const exact = candidates.map(normalizeName).indexOf(normalized);
  if (exact >= 0) return 1000 - exact;
  const haystack = normalizeName(`${tool.name} ${tool.description || ''}`);
  return words.reduce((score, word) => score + (haystack.includes(normalizeName(word)) ? 10 : 0), 0);
}

function findTool(tools, spec) {
  return tools
    .map(tool => ({ tool, score: scoreTool(tool, spec) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.tool || null;
}

const TOOL_SPECS = {
  customerList: { candidates: ['listKunden', 'list_kunden', 'list_customers'], words: ['list', 'kunden'] },
  customerShow: { candidates: ['showKunde', 'show_kunde', 'get_customer', 'customer_details'], words: ['show', 'kunde', 'detail'] },
  contracts: { candidates: ['listVertraege', 'list_vertraege', 'list_contracts'], words: ['list', 'vertraege'] },
  notes: { candidates: ['listCustomerNotes', 'list_customer_notes'], words: ['list', 'kunde', 'notiz'] },
  addresses: { candidates: ['listCustomerAdditionalAddresses', 'list_customer_additional_addresses'], words: ['list', 'kunde', 'adresse'] },
  relations: { candidates: ['listCustomerRelations', 'list_customer_relations'], words: ['list', 'kunde', 'beziehung'] },
  claims: { candidates: ['listClaimsByCustomer', 'list_claims_by_customer'], words: ['list', 'schaden', 'kunde'] },
  salutations: { candidates: ['anreden', 'listAnreden', 'list_salutations'], words: ['anreden'] },
  brokers: { candidates: ['vermittler', 'listVermittler', 'list_brokers'], words: ['vermittler'] },
  createCustomer: { candidates: ['createKunde', 'create_kunde', 'create_customer'], words: ['create', 'kunde'], mode: 'write-with-confirmation' },
  updateCustomer: { candidates: ['updateKunde', 'update_kunde', 'update_customer'], words: ['update', 'kunde'], mode: 'write-with-confirmation' },
};

async function customerTools() {
  const tools = await getCatalog();
  return Object.fromEntries(Object.entries(TOOL_SPECS).map(([key, spec]) => [key, findTool(tools, spec)]));
}

function schemaProperties(tool) {
  return tool?.inputSchema?.properties && typeof tool.inputSchema.properties === 'object'
    ? tool.inputSchema.properties
    : {};
}

function matchingProperty(tool, aliases) {
  const properties = schemaProperties(tool);
  const aliasNames = aliases.map(normalizeName);
  return Object.keys(properties).find(key => aliasNames.includes(normalizeName(key)))
    || Object.keys(properties).find(key => aliasNames.some(alias => normalizeName(key).includes(alias)))
    || null;
}

function setKnownArgument(args, tool, aliases, value) {
  if (value === undefined || value === null || value === '') return;
  const key = matchingProperty(tool, aliases);
  if (key) args[key] = value;
}

function customerIdArguments(tool, customerId) {
  const args = {};
  setKnownArgument(args, tool, ['kunde_ameise_id', 'kunde_id', 'customer_id', 'customerId', 'id'], customerId);
  return args;
}

function writeBody(tool, values) {
  const properties = schemaProperties(tool);
  const wrapper = Object.keys(properties).find(key => ['body', 'data', 'customer', 'kunde', 'payload', 'request'].includes(normalizeName(key)));
  if (wrapper && properties[wrapper]?.type === 'object') return { [wrapper]: values };
  return values;
}

function cacheGet(key) {
  const entry = resultCache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    resultCache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value, ttl) {
  resultCache.set(key, { value, expiresAt: Date.now() + ttl });
  return value;
}

async function optionalRead(tool, args, arrayKeys = []) {
  if (!tool) return { available: false, data: [] };
  try {
    const raw = await callQonektoReadTool(tool.name, args);
    return { available: true, data: arrayFromPayload(raw, arrayKeys), raw: unwrapQonektoResult(raw) };
  } catch (error) {
    return { available: true, data: [], error: error.message };
  }
}

export async function qonektoCustomerCapabilityStatus() {
  const selected = await customerTools();
  return {
    customers: Boolean(selected.customerList),
    customerDetails: Boolean(selected.customerShow),
    contracts: Boolean(selected.contracts),
    notes: Boolean(selected.notes),
    additionalAddresses: Boolean(selected.addresses),
    relations: Boolean(selected.relations),
    claims: Boolean(selected.claims),
    createWithConfirmation: Boolean(selected.createCustomer),
    updateWithConfirmation: Boolean(selected.updateCustomer),
  };
}

function normalizeReference(item = {}) {
  const id = cleanText(item.ameise_id ?? item.id ?? item.value ?? item.code, 160);
  const label = cleanText(item.bezeichnung ?? item.name ?? item.label ?? item.titel ?? item.anrede, 240) || id;
  return { id, label, raw: item };
}

export async function getQonektoCustomerReferences({ force = false } = {}) {
  const cacheKey = 'customer-references';
  if (!force) {
    const cached = cacheGet(cacheKey);
    if (cached) return { ...cached, cached: true };
  }
  const selected = await customerTools();
  const [salutationsResult, brokersResult] = await Promise.all([
    optionalRead(selected.salutations, {}, ['anreden', 'salutations']),
    optionalRead(selected.brokers, {}, ['vermittler', 'brokers']),
  ]);
  const result = {
    salutations: salutationsResult.data.map(normalizeReference).filter(item => item.id),
    brokers: brokersResult.data.map(normalizeReference).filter(item => item.id),
    warnings: [salutationsResult, brokersResult].filter(entry => entry.error).map(entry => entry.error),
  };
  return cacheSet(cacheKey, result, 60 * 60_000);
}

export async function listQonektoCustomers({ search = '', limit = 50, force = false } = {}) {
  const safeSearch = cleanText(search, 160);
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), MAX_CUSTOMERS);
  const cacheKey = `customers:${safeSearch}:${safeLimit}`;
  if (!force) {
    const cached = cacheGet(cacheKey);
    if (cached) return { ...cached, cached: true };
  }
  const selected = await customerTools();
  if (!selected.customerList) throw new Error('Qonekto stellt kein freigegebenes Werkzeug fuer die Kundenliste bereit.');
  const args = {};
  setKnownArgument(args, selected.customerList, ['search', 'query', 'q', 'suchbegriff'], safeSearch);
  setKnownArgument(args, selected.customerList, ['per_page', 'limit', '_limit', 'page_size'], safeLimit);
  const raw = await callQonektoReadTool(selected.customerList.name, args);
  const customers = arrayFromPayload(raw, ['kunden', 'customers'])
    .map(normalizeQonektoCustomer)
    .filter(customer => customer.id)
    .slice(0, safeLimit);
  const payload = unwrapQonektoResult(raw);
  const result = {
    source: 'qonekto',
    connected: true,
    tool: selected.customerList.name,
    customers,
    total: Number(payload?.meta?.total ?? payload?.total ?? customers.length),
    fetchedAt: new Date().toISOString(),
  };
  return cacheSet(cacheKey, result, CUSTOMER_CACHE_TTL_MS);
}

export async function getQonektoCustomerDetail(customerId, { force = false } = {}) {
  const id = cleanText(customerId, 160);
  if (!id) throw new Error('Kunden-ID fehlt.');
  const cacheKey = `customer:${id}`;
  if (!force) {
    const cached = cacheGet(cacheKey);
    if (cached) return { ...cached, cached: true };
  }
  const selected = await customerTools();
  if (!selected.customerShow) throw new Error('Qonekto stellt kein freigegebenes Werkzeug fuer Kundendetails bereit.');
  const detailArgs = customerIdArguments(selected.customerShow, id);
  setKnownArgument(detailArgs, selected.customerShow, ['with-kommunikationen', 'with_kommunikationen', 'withCommunications'], true);
  setKnownArgument(detailArgs, selected.customerShow, ['with-details', 'with_details', 'withDetails'], true);
  const detailRaw = await callQonektoReadTool(selected.customerShow.name, detailArgs);
  const customerPayload = unwrapQonektoResult(detailRaw);
  const customerRaw = customerPayload?.data && !Array.isArray(customerPayload.data) ? customerPayload.data : customerPayload;

  const [contractsResult, notesResult, addressesResult, relationsResult, claimsResult] = await Promise.all([
    optionalRead(selected.contracts, (() => {
      const args = customerIdArguments(selected.contracts, id);
      setKnownArgument(args, selected.contracts, ['kunde_id', 'customer_id', 'kunde_ameise_id'], id);
      setKnownArgument(args, selected.contracts, ['per_page', 'limit', '_limit'], 100);
      return args;
    })(), ['vertraege', 'contracts']),
    optionalRead(selected.notes, customerIdArguments(selected.notes, id), ['notes', 'notizen']),
    optionalRead(selected.addresses, customerIdArguments(selected.addresses, id), ['addresses', 'adressen']),
    optionalRead(selected.relations, customerIdArguments(selected.relations, id), ['relations', 'beziehungen']),
    optionalRead(selected.claims, customerIdArguments(selected.claims, id), ['claims', 'schaeden']),
  ]);

  const result = {
    source: 'qonekto',
    connected: true,
    customer: normalizeQonektoCustomer(customerRaw || {}),
    contracts: contractsResult.data.map(normalizeQonektoContract).filter(contract => contract.id),
    archiveNotes: notesResult.data,
    additionalAddresses: addressesResult.data,
    relations: relationsResult.data,
    claims: claimsResult.data,
    availability: {
      contracts: contractsResult.available,
      archiveNotes: notesResult.available,
      additionalAddresses: addressesResult.available,
      relations: relationsResult.available,
      claims: claimsResult.available,
    },
    warnings: [contractsResult, notesResult, addressesResult, relationsResult, claimsResult]
      .filter(entry => entry.error)
      .map(entry => entry.error),
    fetchedAt: new Date().toISOString(),
  };
  return cacheSet(cacheKey, result, DETAIL_CACHE_TTL_MS);
}

export async function prepareQonektoCustomerAction({ sessionId, kind, customerId, values = {} }) {
  const selected = await customerTools();
  const safeValues = Object.fromEntries(Object.entries(values || {}).filter(([, value]) => value !== '' && value !== undefined && value !== null));
  let tool;
  let args;
  if (kind === 'create-customer') {
    tool = selected.createCustomer;
    if (!tool) throw new Error('Qonekto stellt die bestaetigte Kundenanlage nicht bereit.');
    args = writeBody(tool, safeValues);
  } else if (kind === 'update-customer') {
    tool = selected.updateCustomer;
    if (!tool) throw new Error('Qonekto stellt die bestaetigte Kundenaenderung nicht bereit.');
    args = { ...customerIdArguments(tool, cleanText(customerId, 160)), ...writeBody(tool, safeValues) };
  } else {
    throw new Error('Unbekannte Kundenaktion.');
  }
  const prepared = await prepareQonektoWriteAction({ sessionId, toolName: tool.name, args });
  return {
    ...prepared,
    kind,
    confirmationPhrase: QONEKTO_CONFIRMATION_PHRASE,
  };
}

export function invalidateQonektoCustomerCache() {
  resultCache.clear();
}
