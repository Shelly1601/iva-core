import fs from 'fs/promises';
import { createHash } from 'crypto';

const MAX_PER_RUN = 25;
const RETRY_DELAY_MS = 15 * 60_000;

function normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase();
}

function clean(value, max = 320) {
  if (value === undefined || value === null || typeof value === 'object') return '';
  return String(value).trim().slice(0, max);
}

function nodes(value, maxDepth = 6) {
  const queue = [{ value, depth: 0 }];
  const result = [];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current?.value || typeof current.value !== 'object' || current.depth > maxDepth || seen.has(current.value)) continue;
    seen.add(current.value);
    result.push(current.value);
    for (const child of Array.isArray(current.value) ? current.value : Object.values(current.value)) {
      if (child && typeof child === 'object') queue.push({ value: child, depth: current.depth + 1 });
    }
  }
  return result;
}

function valueFor(source, aliases) {
  const objects = nodes(source);
  for (const alias of aliases.map(normalize)) {
    for (const object of objects) {
      if (Array.isArray(object)) continue;
      const entry = Object.entries(object).find(([key]) => normalize(key) === alias);
      const value = entry?.[1];
      if (value !== undefined && value !== null && value !== '' && typeof value !== 'object') return value;
    }
  }
  return undefined;
}

function splitName(firstName, lastName, fullName) {
  if (lastName) return { firstName, lastName };
  const parts = clean(fullName, 320).split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName, lastName };
  if (parts.length === 1) return { firstName, lastName: parts[0] };
  return { firstName: firstName || parts.slice(0, -1).join(' '), lastName: parts.at(-1) };
}

function crmNotes(source) {
  const noteKeys = new Set(['notiz', 'notizen', 'note', 'notes', 'kommentar', 'kommentare', 'comment', 'comments', 'bemerkung', 'bemerkungen', 'description', 'beschreibung'].map(normalize));
  const textKeys = ['text', 'inhalt', 'content', 'notiz', 'note', 'kommentar', 'comment', 'beschreibung', 'description'];
  const collected = [];
  const add = value => {
    if (['string', 'number'].includes(typeof value)) {
      const text = clean(value, 10000);
      if (text) collected.push(text);
      return;
    }
    if (Array.isArray(value)) return value.forEach(add);
    if (!value || typeof value !== 'object') return;
    const direct = valueFor(value, textKeys);
    if (direct) add(direct);
  };
  for (const object of nodes(source)) {
    if (Array.isArray(object)) continue;
    for (const [key, value] of Object.entries(object)) if (noteKeys.has(normalize(key))) add(value);
  }
  return [...new Set(collected)].slice(0, 100);
}

function salutationProfile(lead, values) {
  const raw = clean(valueFor(lead, ['anrede', 'salutation', 'geschlecht', 'gender']), 100);
  const normalized = normalize(raw);
  const id = clean(valueFor(lead, ['anrede_id', 'salutation_id']), 100);
  if (values.firma || id === '7' || /firma|company|unternehmen/.test(normalized)) return { key: 'company', label: 'Firma' };
  if (id === '2' || /frau|female|weiblich/.test(normalized)) return { key: 'female', label: 'Frau' };
  if (id === '1' || /herr|mann|^male$|maennlich/.test(normalized)) return { key: 'male', label: 'Mann' };
  if (/divers|diverse|nichtbinaer|nonbinary/.test(normalized)) return { key: 'diverse', label: 'Divers' };
  return { key: '', label: raw };
}

export function normalizeCrmLeadForQonekto(lead = {}) {
  const id = clean(valueFor(lead, ['id', 'lead_id', 'leadId', 'uuid']), 160);
  const stage = clean(valueFor(lead, [
    'status_detail', 'pipeline_stage', 'pipelineStage', 'stage', 'phase',
    'lead_status', 'leadStatus', 'pipeline_status', 'status',
  ]), 200);
  const names = splitName(
    clean(valueFor(lead, ['vorname', 'first_name', 'firstName', 'given_name']), 160),
    clean(valueFor(lead, ['nachname', 'last_name', 'lastName', 'surname']), 200),
    valueFor(lead, ['kundenname', 'customer_name', 'contact_name', 'full_name', 'name']),
  );
  const email = clean(valueFor(lead, ['email', 'e_mail', 'mail', 'email_address']), 320);
  const phone = clean(valueFor(lead, ['telefon', 'phone', 'phone_number', 'festnetz']), 120);
  const mobile = clean(valueFor(lead, ['mobil', 'mobile', 'mobile_phone', 'handy']), 120);
  const values = {
    anrede_id: clean(valueFor(lead, ['anrede_id', 'salutation_id']) || process.env.CRM_QONEKTO_DEFAULT_SALUTATION_ID, 100),
    vermittler_id: clean(valueFor(lead, ['vermittler_id', 'broker_id']) || process.env.CRM_QONEKTO_DEFAULT_BROKER_ID, 100),
    vorname: names.firstName,
    nachname: names.lastName,
    firma: clean(valueFor(lead, ['firma', 'unternehmen', 'company', 'company_name']), 240),
    rechtsform: clean(valueFor(lead, ['rechtsform', 'legal_form', 'legalForm', 'company_type']), 160),
    strasse: clean(valueFor(lead, ['strasse', 'straße', 'street', 'address_line_1']), 240),
    plz: clean(valueFor(lead, ['plz', 'postleitzahl', 'zip', 'postal_code']), 40),
    ort: clean(valueFor(lead, ['ort', 'stadt', 'city']), 160),
    geburtsdatum: clean(valueFor(lead, ['geburtsdatum', 'birth_date', 'date_of_birth']), 80),
    beruf: clean(valueFor(lead, ['beruf', 'profession', 'occupation']), 200),
    kommunikation: { email, telefon: mobile || phone, mobil: mobile },
  };
  const compactValues = Object.fromEntries(Object.entries(values)
    .filter(([, value]) => value !== '' && value !== undefined && (typeof value !== 'object' || Object.values(value).some(Boolean))));
  return {
    id,
    stage,
    values: compactValues,
    missing: [!id && 'CRM-ID', !names.lastName && 'Nachname'].filter(Boolean),
  };
}

export function normalizeCrmLeadForIvaWorkspace(lead = {}, { project = 'CRM' } = {}) {
  const normalized = normalizeCrmLeadForQonekto(lead);
  const values = normalized.values;
  const profile = salutationProfile(lead, values);
  const company = clean(values.firma, 240);
  const name = company || [values.vorname, values.nachname].filter(Boolean).join(' ') || 'Neue Kundenakte';
  const sourceId = normalized.id || clean(values.kommunikation?.email, 320) || normalize(name);
  const address = [values.strasse, [values.plz, values.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return {
    mode: 'kunde',
    status: 'active',
    title: `${name} · Kundenakte`,
    customer: {
      name,
      salutationKey: profile.key,
      salutation: profile.label,
      firstName: values.vorname || '',
      lastName: values.nachname || '',
      company,
      legalForm: values.rechtsform || '',
      email: values.kommunikation?.email || '',
      phone: values.kommunikation?.telefon || values.kommunikation?.mobil || '',
      street: values.strasse || '',
      zip: values.plz || '',
      city: values.ort || '',
      address,
      brokerId: values.vermittler_id || '009T7N',
    },
    data: {
      project,
      company,
      relationship: 'Aus CRM in IVA übernommen · noch nicht an Qonekto übertragen',
      nextStep: 'Kontaktdaten prüfen; bei Bedarf an Blau Direkt übertragen',
      crm: { project, sourceId, sourceKey: `${project}:${sourceId}`, importedAt: new Date().toISOString() },
      qonektoDraft: values,
      qonektoLabels: { salutation: profile.label, salutationKey: profile.key, broker: values.vermittler_id === '009T7N' || !values.vermittler_id ? 'Nadine Sell' : '' },
      qonektoSync: { requested: false, status: 'local-only', updatedAt: new Date().toISOString() },
    },
    notes: crmNotes(lead).map(text => ({ text, source: `crm:${project}` })),
  };
}

export function isStrategyConversationLead(stage) {
  const wanted = normalize(process.env.CRM_QONEKTO_SYNC_STAGE || 'Strategiegespräch');
  const actual = normalize(stage);
  return Boolean(actual && (actual === wanted || actual.includes(wanted) || actual.includes('strategiegesprach')));
}

function stateFile() {
  return `${process.env.DATA_DIR || '/data'}/crm-qonekto-sync.json`;
}

async function loadState() {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { version: 1, records: {} };
  } catch {
    return { version: 1, records: {} };
  }
}

async function saveState(state) {
  const file = stateFile();
  const directory = file.slice(0, file.lastIndexOf('/')) || '.';
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
}

function fingerprint(values) {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

function safeError(error) {
  return String(error?.message || error || 'Unbekannter Fehler')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[E-Mail]')
    .replace(/\+?[0-9][0-9\s()/.-]{6,}/g, '[Telefon]')
    .slice(0, 240);
}

function leadsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.leads)) return payload.leads;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.leads?.data)) return payload.leads.data;
  return [];
}

let runInFlight = null;

export async function runCrmQonektoSync({ fetchLeads, upsertCustomer, force = false } = {}) {
  const enabled = String(process.env.CRM_QONEKTO_SYNC_ENABLED || '').toLowerCase() === 'true';
  if (!enabled) return { enabled: false, executed: false, reason: 'not-enabled' };
  if (runInFlight && !force) return runInFlight;
  const operation = (async () => {
    const startedAt = new Date().toISOString();
    const state = await loadState();
    state.records ||= {};
    const payload = await fetchLeads();
    if (payload?.fehler) throw new Error(payload.fehler);
    const candidates = leadsFromPayload(payload)
      .map(normalizeCrmLeadForQonekto)
      .filter(lead => isStrategyConversationLead(lead.stage));
    const report = { enabled: true, executed: true, startedAt, candidates: candidates.length, createdOrUpdated: 0, unchanged: 0, blocked: 0, errors: 0, limited: false };
    let attempted = 0;

    for (const lead of candidates) {
      const key = lead.id || `missing-${fingerprint(lead.values).slice(0, 16)}`;
      const previous = state.records[key];
      const currentFingerprint = fingerprint(lead.values);
      if (lead.missing.length) {
        state.records[key] = { status: 'blocked', missing: lead.missing, fingerprint: currentFingerprint, updatedAt: new Date().toISOString() };
        report.blocked += 1;
        continue;
      }
      if (previous?.status === 'synced' && previous.fingerprint === currentFingerprint) {
        report.unchanged += 1;
        continue;
      }
      if (!force && previous?.status === 'error' && Date.now() - Date.parse(previous.updatedAt || 0) < RETRY_DELAY_MS) {
        report.errors += 1;
        continue;
      }
      if (attempted >= MAX_PER_RUN) {
        report.limited = true;
        break;
      }
      attempted += 1;
      try {
        const result = await upsertCustomer(lead.values);
        state.records[key] = {
          status: 'synced',
          fingerprint: currentFingerprint,
          qonektoCustomerId: clean(result?.customer?.id, 160),
          tool: clean(result?.tool, 120),
          updatedAt: new Date().toISOString(),
        };
        report.createdOrUpdated += 1;
      } catch (error) {
        state.records[key] = { status: 'error', fingerprint: currentFingerprint, error: safeError(error), updatedAt: new Date().toISOString() };
        report.errors += 1;
      }
      await saveState(state);
    }
    state.lastRun = { ...report, finishedAt: new Date().toISOString() };
    await saveState(state);
    return state.lastRun;
  })();
  runInFlight = operation;
  try { return await operation; }
  finally { if (runInFlight === operation) runInFlight = null; }
}

export async function crmQonektoSyncStatus() {
  const state = await loadState();
  const records = Object.values(state.records || {});
  return {
    enabled: String(process.env.CRM_QONEKTO_SYNC_ENABLED || '').toLowerCase() === 'true',
    stage: process.env.CRM_QONEKTO_SYNC_STAGE || 'Strategiegespräch',
    projectConfigured: Boolean(process.env.GOALS_CONCEPTS_PROJECT_ID),
    defaultSalutationConfigured: Boolean(process.env.CRM_QONEKTO_DEFAULT_SALUTATION_ID),
    defaultBrokerConfigured: Boolean(process.env.CRM_QONEKTO_DEFAULT_BROKER_ID),
    synced: records.filter(record => record.status === 'synced').length,
    blocked: records.filter(record => record.status === 'blocked').length,
    errors: records.filter(record => record.status === 'error').length,
    lastRun: state.lastRun || null,
  };
}
