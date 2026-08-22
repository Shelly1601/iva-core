const DEFAULT_REST_BASE = 'https://qqyoqshjwpkmerilhjus.supabase.co/rest/v1';
const PANASONIC_SOURCE = 'Panasonic';
const SALES_ADVISOR = Object.freeze({
  name: 'Vertrieb Innendienst',
  email: 'n.sell@heat-hero.com',
});

function clean(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
}

function emailKey(value) {
  return clean(value, 320).toLowerCase();
}

function phoneKey(value) {
  return clean(value, 80).replace(/\D/g, '');
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean(value, 100));
}

function safeErrorText(text) {
  try {
    const parsed = JSON.parse(text);
    return clean(parsed?.message || parsed?.error || text, 500);
  } catch {
    return clean(text, 500);
  }
}

function restHeaders(serviceKey, extra = {}) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function restRequest({ restBase, serviceKey, table, query = {}, method = 'GET', body, fetchImpl }) {
  const url = new URL(`${restBase.replace(/\/$/, '')}/${table}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const response = await fetchImpl(url, {
    method,
    headers: restHeaders(serviceKey, method === 'GET' ? {} : { Prefer: 'return=representation' }),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Mein CRM ${table} HTTP ${response.status}: ${safeErrorText(text)}`);
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { throw new Error(`Mein CRM ${table}: ungueltige JSON-Antwort.`); }
}

function normalizeLead(input) {
  const lead = {
    name: clean(input?.name, 300),
    email: emailKey(input?.email),
    telefon: clean(input?.telefon, 80),
    strasse: clean(input?.strasse, 300),
    hausnummer: clean(input?.hausnummer, 80),
    plz: clean(input?.plz, 20),
    ort: clean(input?.ort, 200),
    promatchId: clean(input?.promatchId, 100),
    impRequestId: clean(input?.impRequestId, 100),
    details: clean(input?.details, 6000),
  };
  if (!lead.name) throw new Error('Panasonic-Lead ohne Namen abgelehnt.');
  if (!lead.promatchId || !/^[a-f0-9]{24,64}$/i.test(lead.promatchId)) {
    throw new Error(`Panasonic-Lead ${lead.name}: ungueltige ProMatch-ID.`);
  }
  if (!lead.email && !phoneKey(lead.telefon)) {
    throw new Error(`Panasonic-Lead ${lead.name}: E-Mail oder Telefon fehlt.`);
  }
  return lead;
}

function duplicateMatch(existing, lead) {
  const targetEmail = emailKey(lead.email);
  const targetPhone = phoneKey(lead.telefon);
  for (const row of existing) {
    if (clean(row.notizen, 20_000).includes(lead.promatchId)) return { id: row.id, matchedOn: 'ProMatch-ID' };
    if (targetEmail && emailKey(row.email) === targetEmail) return { id: row.id, matchedOn: 'E-Mail' };
    if (targetPhone && phoneKey(row.telefon) === targetPhone) return { id: row.id, matchedOn: 'Telefon' };
  }
  return null;
}

function buildNotes(lead) {
  return [
    'Panasonic ProMatch',
    `ProMatch-ID: ${lead.promatchId}`,
    lead.impRequestId ? `IMP-Anfragenummer: ${lead.impRequestId}` : '',
    lead.details,
  ].filter(Boolean).join(' | ');
}

async function ensureSalesAdvisor({ restBase, serviceKey, fetchImpl }) {
  const reps = await restRequest({
    restBase, serviceKey, fetchImpl, table: 'vertriebler',
    query: { select: 'id,user_id,name,email', email: `ilike.${SALES_ADVISOR.email}`, limit: 2 },
  }) || [];
  if (reps.length > 1) throw new Error('Mein CRM: Vertrieb Innendienst ist mehrfach angelegt.');

  let profiles = [];
  try {
    profiles = await restRequest({
      restBase, serviceKey, fetchImpl, table: 'profiles',
      query: { select: 'id,email', email: `ilike.${SALES_ADVISOR.email}`, limit: 2 },
    }) || [];
  } catch (error) {
    // Manche Mein-CRM-Projekte halten Nutzerprofile in der zentralen App-
    // Datenbank und ausschließlich Leads/Vertriebler in der Projektdatenbank.
    // In diesem Fall bleibt die eindeutige E-Mail-Verknüpfung erhalten; nur
    // die optionale user_id kann dort nicht gesetzt werden.
    if (!/profiles HTTP 404|public\.profiles/i.test(error.message)) throw error;
  }
  if (profiles.length > 1) throw new Error('Mein CRM: Nutzerprofil Vertrieb Innendienst ist nicht eindeutig.');
  const userId = profiles[0]?.id || null;

  if (reps[0]) {
    const rep = reps[0];
    if (rep.name !== SALES_ADVISOR.name || emailKey(rep.email) !== SALES_ADVISOR.email || (!rep.user_id && userId)) {
      const updated = await restRequest({
        restBase, serviceKey, fetchImpl, table: 'vertriebler', method: 'PATCH',
        query: { id: `eq.${rep.id}` },
        body: { name: SALES_ADVISOR.name, email: SALES_ADVISOR.email, ...(userId ? { user_id: userId } : {}) },
      });
      return updated?.[0] || { ...rep, name: SALES_ADVISOR.name, email: SALES_ADVISOR.email, user_id: userId || rep.user_id };
    }
    return rep;
  }

  const created = await restRequest({
    restBase, serviceKey, fetchImpl, table: 'vertriebler', method: 'POST',
    body: { name: SALES_ADVISOR.name, email: SALES_ADVISOR.email, ...(userId ? { user_id: userId } : {}) },
  });
  if (!created?.[0]?.id) throw new Error('Mein CRM: Vertrieb Innendienst konnte nicht angelegt werden.');
  return created[0];
}

export async function importPanasonicLeadsToMeinCrm(inputs, options = {}) {
  const serviceKey = clean(options.serviceKey ?? process.env.MEINCRM_SERVICE_KEY, 20_000);
  const projectId = clean(options.projectId ?? process.env.HEATHERO_PROJECT_ID, 200);
  const restBase = clean(options.restBase ?? DEFAULT_REST_BASE, 1000);
  const fetchImpl = options.fetchImpl || fetch;
  if (!serviceKey) throw new Error('MEINCRM_SERVICE_KEY fehlt.');
  if (!projectId) throw new Error('HEATHERO_PROJECT_ID fehlt.');
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 100) {
    throw new Error('Panasonic-Import erwartet 1 bis 100 Leads.');
  }

  const leads = inputs.map(normalizeLead);
  // Das Heat-Hero-Projekt laeuft in Mein CRM teils noch als dedizierte
  // Projektdatenbank mit einer alten numerischen Projektkennung. In diesem
  // Modus gehoert bereits die gesamte Datenbank zu Heat Hero und die neue
  // UUID-Spalte project_id bleibt – wie bei den vorhandenen Leads – leer.
  const scopedProjectId = isUuid(projectId) ? projectId : null;
  const portalIds = new Set();
  for (const lead of leads) {
    if (portalIds.has(lead.promatchId)) throw new Error(`Doppelte ProMatch-ID im Import: ${lead.promatchId}`);
    portalIds.add(lead.promatchId);
  }

  const advisor = await ensureSalesAdvisor({ restBase, serviceKey, fetchImpl });
  const advisorId = Number(advisor.id);
  if (!Number.isSafeInteger(advisorId) || advisorId <= 0) throw new Error('Mein CRM: Vertriebspartner-ID ist ungueltig.');

  const existing = await restRequest({
    restBase, serviceKey, fetchImpl, table: 'leads',
    query: { ...(scopedProjectId ? { project_id: `eq.${scopedProjectId}` } : {}), select: 'id,name,email,telefon,notizen', limit: 1000 },
  }) || [];

  const results = [];
  for (const lead of leads) {
    const duplicate = duplicateMatch(existing, lead);
    if (duplicate) {
      results.push({ name: lead.name, promatchId: lead.promatchId, status: 'duplicate', crmLeadId: duplicate.id, matchedOn: duplicate.matchedOn });
      continue;
    }

    const payload = {
      name: lead.name,
      email: lead.email || null,
      telefon: lead.telefon || null,
      strasse: lead.strasse || null,
      hausnummer: lead.hausnummer || null,
      plz: lead.plz || null,
      ort: lead.ort || null,
      quelle: PANASONIC_SOURCE,
      status_detail: 'neuer lead',
      notizen: buildNotes(lead),
      ...(scopedProjectId ? { project_id: scopedProjectId } : {}),
      ...(isUuid(advisor.user_id) ? { assigned_user_id: advisor.user_id } : {}),
      fachberater_id: advisorId,
      fachberater_name: SALES_ADVISOR.name,
    };
    const created = await restRequest({ restBase, serviceKey, fetchImpl, table: 'leads', method: 'POST', body: payload });
    const row = created?.[0];
    if (!row?.id) throw new Error(`Mein CRM: Lead ${lead.name} wurde nicht bestaetigt.`);
    existing.push(row);
    results.push({ name: lead.name, promatchId: lead.promatchId, status: 'created', crmLeadId: row.id });
  }

  return {
    projectId: scopedProjectId,
    projectScope: scopedProjectId ? 'project_id' : 'dedicated-database',
    source: PANASONIC_SOURCE,
    advisor: { id: advisorId, name: SALES_ADVISOR.name, email: SALES_ADVISOR.email },
    created: results.filter(result => result.status === 'created').length,
    duplicates: results.filter(result => result.status === 'duplicate').length,
    results,
  };
}

export const meinCrmPanasonicPolicy = Object.freeze({
  source: PANASONIC_SOURCE,
  advisor: SALES_ADVISOR,
  dedupe: ['ProMatch-ID', 'E-Mail', 'Telefon'],
});
