import { AIRTABLE_HWP_LAYOUT, compareAirtableLayout } from './airtable-layout.js';

const AIRTABLE_API_ORIGIN = 'https://api.airtable.com';
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function clean(value, max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function config() {
  return {
    token: clean(process.env.AIRTABLE_TOKEN, 2000),
    baseId: clean(process.env.AIRTABLE_HWP_BASE_ID || AIRTABLE_HWP_LAYOUT.baseId, 100),
    tableId: clean(process.env.AIRTABLE_HWP_TABLE_ID || AIRTABLE_HWP_LAYOUT.tableId, 100),
  };
}

function requireConfig() {
  const current = config();
  if (!current.token) throw new Error('Airtable ist noch nicht konfiguriert: AIRTABLE_TOKEN fehlt.');
  if (!/^app[a-zA-Z0-9]+$/.test(current.baseId) || !/^tbl[a-zA-Z0-9]+$/.test(current.tableId)) throw new Error('Ungueltige Airtable-Base- oder Tabellen-ID.');
  return current;
}

function safeError(payload, response) {
  return clean(payload?.error?.message || payload?.error?.type || payload?.message || `Airtable API HTTP ${response.status}`, 600);
}

export async function airtableRequest(pathname, { method = 'GET', searchParams } = {}) {
  const verb = String(method || 'GET').toUpperCase();
  if (verb !== 'GET') throw new Error('Airtable-Schreib- und Loeschaktionen sind in dieser IVA-Schnittstelle gesperrt.');
  const current = requireConfig();
  const url = new URL(pathname, AIRTABLE_API_ORIGIN);
  if (url.origin !== AIRTABLE_API_ORIGIN) throw new Error('Unerwartete Airtable-API-Domain.');
  for (const [key, value] of Object.entries(searchParams || {})) {
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
    else if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method: verb,
    headers: { Authorization: `Bearer ${current.token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(safeError(payload, response));
  return payload;
}

export async function getAirtableHwpSchema() {
  const current = requireConfig();
  const payload = await airtableRequest(`/v0/meta/bases/${encodeURIComponent(current.baseId)}/tables`);
  const table = (payload.tables || []).find(item => item.id === current.tableId);
  if (!table) throw new Error('Die freigegebene Heat-Hero-Tabelle ist im Airtable-Schema nicht sichtbar.');
  return { baseId: current.baseId, table, layout: AIRTABLE_HWP_LAYOUT, drift: compareAirtableLayout(table) };
}

function fieldMap(table) {
  return new Map((table.fields || []).map(field => [field.name, field]));
}

function compactAttachment(value = {}) {
  return {
    id: clean(value.id, 100),
    filename: clean(value.filename, 500),
    size: Number(value.size || 0),
    type: clean(value.type, 200),
    width: Number(value.width || 0) || null,
    height: Number(value.height || 0) || null,
  };
}

function displayValue(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join(', ');
  if (typeof value === 'object') return value.name || value.value || value.label || value.id || '';
  return value;
}

function normalizeRecord(record, table) {
  const byName = fieldMap(table);
  const value = name => record.fields?.[byName.get(name)?.id] ?? null;
  const stageValue = value(AIRTABLE_HWP_LAYOUT.stage.fieldName);
  const attachments = value(AIRTABLE_HWP_LAYOUT.fields.correctedOffer);
  return {
    id: clean(record.id, 100),
    createdTime: clean(record.createdTime, 100),
    stage: typeof stageValue === 'object' ? clean(stageValue?.name, 300) : clean(stageValue, 300),
    customer: clean(displayValue(value(AIRTABLE_HWP_LAYOUT.fields.customer)), 500),
    projectAddress: clean(displayValue(value(AIRTABLE_HWP_LAYOUT.fields.projectAddress)), 1000),
    plannedInstallationDate: clean(displayValue(value(AIRTABLE_HWP_LAYOUT.fields.plannedInstallationDate)), 100),
    heroId: clean(displayValue(value(AIRTABLE_HWP_LAYOUT.fields.heroId)), 200),
    mobile: clean(displayValue(value(AIRTABLE_HWP_LAYOUT.fields.mobile)), 200),
    phone: clean(displayValue(value(AIRTABLE_HWP_LAYOUT.fields.phone)), 200),
    email: clean(displayValue(value(AIRTABLE_HWP_LAYOUT.fields.email)), 500),
    soldProduct: clean(displayValue(value(AIRTABLE_HWP_LAYOUT.fields.soldProduct)), 1000),
    correctedOfferAttachments: Array.isArray(attachments) ? attachments.map(compactAttachment) : [],
  };
}

function requiredFieldNames() {
  return [AIRTABLE_HWP_LAYOUT.stage.fieldName, ...Object.values(AIRTABLE_HWP_LAYOUT.fields)];
}

async function listRecords({ stage = '', maxRecords = 500 } = {}) {
  const current = requireConfig();
  const schema = await getAirtableHwpSchema();
  const requestedStage = clean(stage, 300);
  const stageField = fieldMap(schema.table).get(AIRTABLE_HWP_LAYOUT.stage.fieldName);
  const stageChoices = stageField?.options?.choices || [];
  const resolvedStage = requestedStage
    ? stageChoices.find(choice => choice.id === requestedStage || choice.name.toLocaleLowerCase('de-DE') === requestedStage.toLocaleLowerCase('de-DE'))
    : null;
  if (requestedStage && !resolvedStage) throw new Error(`Unbekannte Airtable-Stage: ${requestedStage}`);
  const safeMax = Math.max(1, Math.min(2000, Number(maxRecords) || 500));
  const records = [];
  let offset = '';
  do {
    const payload = await airtableRequest(`/v0/${encodeURIComponent(current.baseId)}/${encodeURIComponent(current.tableId)}`, {
      searchParams: {
        pageSize: Math.min(100, safeMax - records.length),
        offset,
        returnFieldsByFieldId: 'true',
        'fields[]': requiredFieldNames(),
        filterByFormula: resolvedStage
          ? `{${AIRTABLE_HWP_LAYOUT.stage.fieldName}}='${String(resolvedStage.name).replace(/'/g, "\\'")}'`
          : '',
      },
    });
    records.push(...(payload.records || []));
    offset = clean(payload.offset, 500);
  } while (offset && records.length < safeMax);
  return {
    records: records.slice(0, safeMax).map(record => normalizeRecord(record, schema.table)),
    truncated: Boolean(offset || records.length > safeMax),
    layout: AIRTABLE_HWP_LAYOUT,
    drift: schema.drift,
  };
}

export async function listAirtableInstallationQueue(options = {}) {
  const result = await listRecords({ stage: AIRTABLE_HWP_LAYOUT.stage.installationQueueChoiceId, maxRecords: options.maxRecords || 500 });
  return { ...result, count: result.records.length };
}

export async function listAirtableWorkflowStage({ stage, maxRecords = 500 } = {}) {
  const result = await listRecords({ stage, maxRecords });
  return { ...result, stage: clean(stage, 300) || 'alle', count: result.records.length };
}

export async function searchAirtableWorkflowRecords(term, { installationQueueOnly = false, limit = 20 } = {}) {
  const query = clean(term, 500).toLocaleLowerCase('de-DE');
  if (query.length < 2) throw new Error('Airtable-Suchbegriff ist zu kurz.');
  const result = await listRecords({ stage: installationQueueOnly ? AIRTABLE_HWP_LAYOUT.stage.installationQueueChoiceId : '', maxRecords: 2000 });
  const matches = result.records.filter(record => [record.customer, record.projectAddress, record.heroId, record.email, record.mobile, record.phone]
    .some(value => String(value || '').toLocaleLowerCase('de-DE').includes(query)));
  return { term: clean(term, 500), records: matches.slice(0, Math.max(1, Math.min(100, Number(limit) || 20))), totalMatches: matches.length, truncated: result.truncated, drift: result.drift };
}

async function getRawRecord(recordId) {
  const current = requireConfig();
  const id = clean(recordId, 100);
  if (!/^rec[a-zA-Z0-9]+$/.test(id)) throw new Error('Ungueltige Airtable-Record-ID.');
  const schema = await getAirtableHwpSchema();
  const record = await airtableRequest(`/v0/${encodeURIComponent(current.baseId)}/${encodeURIComponent(current.tableId)}/${encodeURIComponent(id)}`, {
    searchParams: { returnFieldsByFieldId: 'true' },
  });
  return { record, schema };
}

export async function getAirtableWorkflowRecord(recordId) {
  const { record, schema } = await getRawRecord(recordId);
  return { record: normalizeRecord(record, schema.table), layout: AIRTABLE_HWP_LAYOUT, drift: schema.drift };
}

function allowedAttachmentUrl(value) {
  const url = new URL(String(value || ''));
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !(host.endsWith('.airtableusercontent.com') || host === 'airtable.com' || host.endsWith('.airtable.com'))) {
    throw new Error('Unerwartete Airtable-Anhangs-Domain.');
  }
  return url;
}

export async function downloadAirtableCorrectedOffer({ recordId, attachmentId } = {}) {
  const { record, schema } = await getRawRecord(recordId);
  const correctedOfferField = fieldMap(schema.table).get(AIRTABLE_HWP_LAYOUT.fields.correctedOffer);
  const attachments = record.fields?.[correctedOfferField?.id];
  const attachment = Array.isArray(attachments) ? attachments.find(item => String(item.id) === String(attachmentId)) : null;
  if (!attachment) throw new Error('Der korrigierte Angebotsanhang gehoert nicht zu diesem Airtable-Datensatz.');
  if (Number(attachment.size || 0) > MAX_ATTACHMENT_BYTES) throw new Error('Der Airtable-Anhang ist groesser als 25 MB.');
  const response = await fetch(allowedAttachmentUrl(attachment.url), { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Airtable-Anhang konnte nicht geladen werden (${response.status}).`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error('Der Airtable-Anhang ist groesser als 25 MB.');
  return { buffer, filename: clean(attachment.filename || 'angebot.pdf', 500), type: clean(attachment.type || response.headers.get('content-type') || 'application/octet-stream', 200) };
}

export async function probeAirtable() {
  const [schema, queue] = await Promise.all([getAirtableHwpSchema(), listAirtableInstallationQueue({ maxRecords: 500 })]);
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    baseId: schema.baseId,
    tableId: schema.table.id,
    tableName: schema.table.name,
    fields: schema.table.fields?.length || 0,
    installationQueueRecords: queue.count,
    layoutMatches: schema.drift.matches,
    layoutWarnings: schema.drift.warnings,
  };
}

export async function airtableStatus({ probe = false } = {}) {
  const current = config();
  if (!current.token) return { configured: false, readReady: false, writeEnabled: false, baseId: current.baseId, tableId: current.tableId, missing: ['AIRTABLE_TOKEN'] };
  try {
    const liveProbe = probe ? await probeAirtable() : null;
    const schema = liveProbe ? null : await getAirtableHwpSchema();
    const layoutMatches = liveProbe ? liveProbe.layoutMatches : schema.drift.matches;
    return {
      configured: true,
      readReady: layoutMatches,
      writeEnabled: false,
      baseId: current.baseId,
      tableId: current.tableId,
      lastProbe: liveProbe || { checkedAt: new Date().toISOString(), layoutMatches, layoutWarnings: schema.drift.warnings },
      missing: layoutMatches ? [] : ['Airtable-Schema-Drift pruefen'],
    };
  } catch (error) {
    return { configured: true, readReady: false, writeEnabled: false, baseId: current.baseId, tableId: current.tableId, missing: ['Airtable-Zugriff oder Scopes pruefen'], error: error.message };
  }
}
