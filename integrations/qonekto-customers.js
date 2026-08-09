import {
  QONEKTO_CONFIRMATION_PHRASE,
  callQonektoCustomerUpsertAutomation,
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

function objectValuesAsArray(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const entries = Object.entries(value);
  if (!entries.length) return [];
  if (entries.every(([, item]) => item && typeof item === 'object')) return entries.map(([, item]) => item);
  if (entries.every(([, item]) => ['string', 'number'].includes(typeof item))) {
    return entries.map(([id, label]) => ({ id, label }));
  }
  return [];
}

export function arrayFromPayload(payload, keys = [], depth = 0) {
  if (depth > 10) return [];
  const value = unwrapQonektoResult(payload);
  if (Array.isArray(value)) {
    if (value.length === 1 && Array.isArray(value[0])) return value[0];
    return value;
  }
  if (!value || typeof value !== 'object') return [];
  const domainKeys = keys.map(normalizeName);
  const wanted = [...domainKeys, 'data', 'items', 'results'];
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = normalizeName(key);
    if (!wanted.includes(normalizedKey)) continue;
    if (Array.isArray(item)) return item;
    if (domainKeys.includes(normalizedKey)) {
      const mapped = objectValuesAsArray(item);
      if (mapped.length) return mapped;
    }
    if (item && typeof item === 'object') {
      const nested = arrayFromPayload(item, keys, depth + 1);
      if (nested.length) return nested;
    }
  }
  // Qonekto kapselt Nutzdaten je nach Connector-Version zusätzlich in
  // response/result/payload oder in einer einzelnen Inhalts-Eigenschaft.
  for (const item of Object.values(value)) {
    if (!item || typeof item !== 'object') continue;
    const nested = arrayFromPayload(item, keys, depth + 1);
    if (nested.length) return nested;
  }
  return [];
}

function objectNodes(value, maxDepth = 7) {
  const root = unwrapQonektoResult(value);
  const queue = [{ value: root, depth: 0 }];
  const seen = new Set();
  const nodes = [];
  while (queue.length) {
    const current = queue.shift();
    if (!current?.value || typeof current.value !== 'object' || current.depth > maxDepth || seen.has(current.value)) continue;
    seen.add(current.value);
    nodes.push(current.value);
    for (const child of Array.isArray(current.value) ? current.value : Object.values(current.value)) {
      if (child && typeof child === 'object') queue.push({ value: child, depth: current.depth + 1 });
    }
  }
  return nodes;
}

function deepValue(raw, aliases, { allowObject = false } = {}) {
  const nodes = objectNodes(raw);
  for (const alias of aliases.map(normalizeName)) {
    for (const node of nodes) {
      if (Array.isArray(node)) continue;
      const entry = Object.entries(node).find(([key]) => normalizeName(key) === alias);
      if (!entry) continue;
      const value = entry[1];
      if (value === undefined || value === null || value === '') continue;
      if (!allowObject && typeof value === 'object') continue;
      return value;
    }
  }
  return undefined;
}

function entityValue(entity, aliases) {
  if (entity && typeof entity === 'object' && !Array.isArray(entity)) {
    for (const alias of aliases.map(normalizeName)) {
      const entry = Object.entries(entity).find(([key]) => normalizeName(key) === alias);
      if (entry && entry[1] !== undefined && entry[1] !== null && entry[1] !== '' && typeof entry[1] !== 'object') return entry[1];
    }
  }
  return deepValue(entity, aliases);
}

function referenceLabel(entity, containerAliases) {
  const container = deepValue(entity, containerAliases, { allowObject: true });
  if (!container || typeof container !== 'object') return '';
  return cleanText(deepValue(container, ['bezeichnung', 'name', 'label', 'titel', 'kurzbezeichnung']), 240);
}

function extractEntityObject(raw, aliases) {
  const value = unwrapQonektoResult(raw);
  if (!value || typeof value !== 'object') return {};
  const wanted = aliases.map(normalizeName);
  for (const node of objectNodes(value, 5)) {
    if (Array.isArray(node)) continue;
    for (const [key, item] of Object.entries(node)) {
      if (!wanted.includes(normalizeName(key)) || !item || typeof item !== 'object') continue;
      return Array.isArray(item) ? (item[0] || {}) : item;
    }
  }
  return Array.isArray(value) ? (value[0] || {}) : value;
}

function communicationValue(raw, types) {
  const direct = deepValue(raw, types);
  if (direct !== undefined) return cleanText(direct, 320);
  const communications = [];
  const communicationKeys = ['kommunikationen', 'kommunikation', 'communications', 'communication', 'contact', 'kontakte'];
  for (const node of objectNodes(raw)) {
    if (Array.isArray(node)) continue;
    for (const [key, value] of Object.entries(node)) {
      if (!communicationKeys.map(normalizeName).includes(normalizeName(key))) continue;
      if (Array.isArray(value)) communications.push(...value);
      else if (value && typeof value === 'object') communications.push(...(objectValuesAsArray(value).length ? objectValuesAsArray(value) : [value]));
    }
  }
  const wanted = types.map(normalizeName);
  for (const item of communications) {
    const type = normalizeName(item?.art || item?.typ || item?.type || item?.bezeichnung || item?.key || item?.kommunikationsart);
    if (!wanted.some(candidate => type.includes(candidate))) continue;
    const value = item?.wert || item?.value || item?.inhalt || item?.adresse || item?.kontakt;
    if (value) return cleanText(value, 320);
  }
  return '';
}

function booleanValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['1', 'true', 'ja', 'yes'].includes(normalizeName(value));
}

export function normalizeQonektoCustomer(raw = {}) {
  const entity = extractEntityObject(raw, ['kunde', 'customer', 'kundendaten', 'customerData']);
  const firstName = cleanText(deepValue(entity, ['vorname', 'first_name', 'firstName', 'given_name']), 160);
  const lastName = cleanText(deepValue(entity, ['nachname', 'last_name', 'lastName', 'surname']), 200);
  const company = cleanText(deepValue(entity, ['firma', 'unternehmen', 'company', 'firmenname']), 240);
  const title = cleanText(deepValue(entity, ['titel', 'title']), 80);
  const id = cleanText(entityValue(entity, ['kunde_ameise_id', 'customer_id', 'kunden_id', 'ameise_id', 'id']), 160);
  const name = cleanText(deepValue(entity, ['name', 'kundenname', 'display_name']), 320) || company || [title, firstName, lastName].filter(Boolean).join(' ') || `Kunde ${id}`;
  const street = cleanText(deepValue(entity, ['strasse', 'straße', 'street', 'strasse_hausnummer', 'address_line_1']), 240);
  const zip = cleanText(deepValue(entity, ['plz', 'postleitzahl', 'zip', 'postal_code']), 40);
  const city = cleanText(deepValue(entity, ['ort', 'city', 'stadt']), 160);
  const perDu = deepValue(entity, ['per_du', 'perDu']);
  const deceased = deepValue(entity, ['verstorben', 'deceased']);
  return {
    id,
    name,
    firstName,
    lastName,
    company,
    email: communicationValue(entity, ['email', 'e_mail', 'mail']),
    phone: communicationValue(entity, ['telefon', 'phone', 'festnetz']),
    mobile: communicationValue(entity, ['mobil', 'mobile', 'handy', 'mobiltelefon']),
    street,
    zip,
    city,
    address: [street, [zip, city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    birthDate: cleanText(deepValue(entity, ['geburtsdatum', 'birth_date', 'date_of_birth']), 80),
    profession: cleanText(deepValue(entity, ['beruf', 'profession', 'berufsbezeichnung']), 200),
    brokerId: cleanText(deepValue(entity, ['vermittler_id', 'broker_id', 'vermittler_ameise_id']), 100),
    salutation: cleanText(deepValue(entity, ['anrede', 'salutation', 'anrede_bezeichnung']), 100) || referenceLabel(entity, ['anrede', 'salutation']),
    legalForm: cleanText(deepValue(entity, ['rechtsform', 'legal_form']), 160),
    simplrUsername: cleanText(deepValue(entity, ['benutzername_simplr', 'simplr_username']), 200),
    perDu: booleanValue(perDu),
    deceased: booleanValue(deceased),
    raw: entity,
  };
}

export function normalizeQonektoContract(raw = {}) {
  const entity = extractEntityObject(raw, ['vertrag', 'contract', 'vertragsdaten', 'contractData']);
  return {
    id: cleanText(entityValue(entity, ['vertrag_ameise_id', 'contract_id', 'vertrags_id', 'ameise_id', 'id']), 160),
    customerId: cleanText(deepValue(entity, ['kunde_id', 'kunde_ameise_id', 'customer_id', 'kunden_id']), 160),
    category: cleanText(deepValue(entity, ['sparte', 'category', 'sparten_bezeichnung', 'produktgruppe']), 200) || referenceLabel(entity, ['sparte', 'category', 'produktgruppe']) || 'Sonstige',
    company: cleanText(deepValue(entity, ['gesellschaft', 'company', 'insurer', 'gesellschaft_name', 'versicherer']), 240) || referenceLabel(entity, ['gesellschaft', 'company', 'insurer', 'versicherer']),
    companyId: cleanText(deepValue(entity, ['gesellschaft_id', 'company_id', 'versicherer_id']), 120),
    policyNumber: cleanText(deepValue(entity, ['versicherungsscheinnummer', 'vertragsnummer', 'policy_number', 'v_schein_nummer']), 200),
    status: cleanText(deepValue(entity, ['status', 'status_bezeichnung', 'status_id']), 120),
    start: cleanText(deepValue(entity, ['beginn', 'start_date', 'vertragsbeginn']), 80),
    end: cleanText(deepValue(entity, ['ablauf', 'end_date', 'vertragsende']), 80),
    paymentFrequency: cleanText(deepValue(entity, ['zahlweise', 'payment_frequency', 'zahlungsweise']), 120),
    netPremium: deepValue(entity, ['beitrag_netto', 'tarifbeitrag', 'net_premium', 'nettobeitrag']) ?? null,
    risk: cleanText(deepValue(entity, ['risiko', 'risk', 'risikobeschreibung']), 500),
    raw: entity,
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
  contractFilter: { candidates: ['filterVertraege', 'filter_vertraege', 'filter_contracts'], words: ['filter', 'vertraege'] },
  contracts: { candidates: ['listVertraege', 'list_vertraege', 'list_contracts'], words: ['list', 'vertraege'] },
  notes: { candidates: ['listCustomerNotes', 'list_customer_notes'], words: ['list', 'kunde', 'notiz'] },
  addresses: { candidates: ['listCustomerAdditionalAddresses', 'list_customer_additional_addresses'], words: ['list', 'kunde', 'adresse'] },
  relations: { candidates: ['listCustomerRelations', 'list_customer_relations'], words: ['list', 'kunde', 'beziehung'] },
  claims: { candidates: ['listClaimsByCustomer', 'list_claims_by_customer'], words: ['list', 'schaden', 'kunde'] },
  salutations: { candidates: ['anreden', 'listAnreden', 'list_salutations'], words: ['anreden'] },
  brokers: { candidates: ['vermittler', 'listVermittler', 'list_brokers'], words: ['vermittler'] },
  upsertCustomer: { candidates: ['upsertKunde', 'upsert_kunde', 'upsert_customer'], words: ['upsert', 'kunde'], mode: 'write-with-confirmation' },
  createCustomer: { candidates: ['createKunde', 'create_kunde', 'create_customer'], words: ['create', 'kunde'], mode: 'write-with-confirmation' },
  updateCustomer: { candidates: ['updateKunde', 'update_kunde', 'update_customer'], words: ['update', 'kunde'], mode: 'write-with-confirmation' },
};

async function customerTools() {
  const tools = await getCatalog();
  return Object.fromEntries(Object.entries(TOOL_SPECS).map(([key, spec]) => [key, findTool(tools, spec)]));
}

function schemaProperties(schemaOrTool) {
  const schema = schemaOrTool?.inputSchema || schemaOrTool;
  return schema?.properties && typeof schema.properties === 'object'
    ? schema.properties
    : {};
}

function matchingPropertyPath(schemaOrTool, aliases, depth = 0) {
  if (depth > 6) return null;
  const properties = schemaProperties(schemaOrTool);
  const aliasNames = aliases.map(normalizeName);
  const direct = Object.keys(properties).find(key => aliasNames.includes(normalizeName(key)))
    || Object.keys(properties).find(key => aliasNames.some(alias => normalizeName(key).includes(alias)));
  if (direct) return [direct];
  for (const [key, property] of Object.entries(properties)) {
    const nested = matchingPropertyPath(property, aliases, depth + 1);
    if (nested) return [key, ...nested];
    if (property?.items) {
      const itemPath = matchingPropertyPath(property.items, aliases, depth + 1);
      if (itemPath) return [key, ...itemPath];
    }
  }
  return null;
}

function setKnownArgument(args, tool, aliases, value) {
  if (value === undefined || value === null || value === '') return;
  const path = matchingPropertyPath(tool, aliases);
  if (!path) return;
  let target = args;
  for (const key of path.slice(0, -1)) {
    if (!target[key] || typeof target[key] !== 'object') target[key] = {};
    target = target[key];
  }
  target[path.at(-1)] = value;
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
    contracts: Boolean(selected.contractFilter || selected.contracts),
    notes: Boolean(selected.notes),
    additionalAddresses: Boolean(selected.addresses),
    relations: Boolean(selected.relations),
    claims: Boolean(selected.claims),
    automaticUpsertReady: Boolean(selected.upsertCustomer),
    createWithConfirmation: Boolean(selected.createCustomer),
    updateWithConfirmation: Boolean(selected.updateCustomer),
    selectedTools: Object.fromEntries(Object.entries(selected).filter(([, tool]) => tool).map(([key, tool]) => [key, tool.name])),
  };
}

const KNOWN_SALUTATIONS = Object.freeze({
  1: 'Herr',
  2: 'Frau',
  7: 'Firma',
});

export function normalizeReference(item = {}, kind = '') {
  const scalar = ['string', 'number'].includes(typeof item) ? item : '';
  const id = cleanText(scalar || deepValue(item, [
    'ameise_id', 'id', 'code', 'key', 'value',
    'anrede_ameise_id', 'anrede_id', 'salutation_id',
    'vermittler_ameise_id', 'vermittler_id', 'broker_id',
  ]), 160);
  const firstName = cleanText(deepValue(item, ['vorname', 'first_name', 'given_name']), 120);
  const lastName = cleanText(deepValue(item, ['nachname', 'last_name', 'surname']), 160);
  let label = cleanText(deepValue(item, [
    'bezeichnung', 'kurzbezeichnung', 'label', 'name', 'titel',
    'anrede_bezeichnung', 'anrede', 'salutation', 'vermittler_bezeichnung', 'vermittler', 'broker_name',
  ]), 240) || [firstName, lastName].filter(Boolean).join(' ');
  if (!label || label === id || /^\d+$/.test(label)) {
    if (kind === 'salutation') label = KNOWN_SALUTATIONS[id] || `Weitere Anrede (ID ${id})`;
    else if (kind === 'broker' && id === '009T7N') label = 'Nadine Sell';
    else label = id;
  }
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
    salutations: salutationsResult.data.map(item => normalizeReference(item, 'salutation')).filter(item => item.id),
    brokers: brokersResult.data.map(item => normalizeReference(item, 'broker')).filter(item => item.id),
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
  const customerRaw = extractEntityObject(detailRaw, ['kunde', 'customer', 'kundendaten', 'customerData']);

  const contractTool = selected.contractFilter || selected.contracts;

  const [contractsResult, notesResult, addressesResult, relationsResult, claimsResult] = await Promise.all([
    optionalRead(contractTool, (() => {
      const args = customerIdArguments(contractTool, id);
      setKnownArgument(args, contractTool, ['kunde_id', 'customer_id', 'kunde_ameise_id', 'kunden_id'], id);
      setKnownArgument(args, contractTool, ['per_page', 'limit', '_limit'], 100);
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
    contracts: contractsResult.data
      .map(normalizeQonektoContract)
      .filter(contract => contract.id && (!contract.customerId || contract.customerId === id)),
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

export async function upsertQonektoCustomerAutomatically(values = {}) {
  const selected = await customerTools();
  if (!selected.upsertCustomer) throw new Error('Qonekto stellt kein Kunden-Upsert fuer die CRM-Automatik bereit.');
  const safeValues = Object.fromEntries(Object.entries(values || {}).filter(([, value]) => value !== '' && value !== undefined && value !== null));
  if (!cleanText(safeValues.nachname ?? safeValues.last_name ?? safeValues.name, 200)) {
    throw new Error('Nachname fuer das Qonekto-Upsert fehlt.');
  }
  const raw = await callQonektoCustomerUpsertAutomation(selected.upsertCustomer.name, writeBody(selected.upsertCustomer, safeValues));
  invalidateQonektoCustomerCache();
  return {
    tool: selected.upsertCustomer.name,
    customer: normalizeQonektoCustomer(raw),
    raw,
  };
}

export function invalidateQonektoCustomerCache() {
  resultCache.clear();
}
