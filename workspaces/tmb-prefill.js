import { generateObject } from 'ai';
import { z } from 'zod';
import { checkBudget, chooseModel, recordUsage } from '../core/router.js';

export const TMB_PREFILL_FIELDS = [
  ['assessment.visitDate', 'visitDate', ['besichtigungsdatum', 'vororttermin', 'visitdate', 'appointmentdate']],
  ['assessment.adviser', 'adviser', ['berater', 'beraterin', 'adviser', 'consultant']],
  ['assessment.recorderEmail', 'recorderEmail', ['aufzeichnungsgeraetemail', 'recorderemail', 'plaudemail']],
  ['assessment.leadSource', 'leadSource', ['leadquelle', 'leadsource', 'quelle', 'source']],
  ['assessment.salesRep', 'salesRep', ['vertriebsmitarbeiter', 'vertriebler', 'salesrep', 'salesrepresentative']],
  ['building.type', 'buildingType', ['gebaeudetyp', 'objekttyp', 'buildingtype', 'haustyp']],
  ['building.year', 'buildingYear', ['baujahr', 'gebaeudebaujahr', 'buildingyear', 'yearbuilt']],
  ['building.floors', 'buildingFloors', ['geschosse', 'etagen', 'floors', 'anzahlgeschosse']],
  ['building.floorHeight', 'floorHeight', ['raumhoehe', 'geschosshoehe', 'floorheight', 'deckenhoehe']],
  ['building.heatedArea', 'heatedArea', ['beheizteflaeche', 'wohnflaeche', 'heatedarea', 'livingarea']],
  ['building.units', 'buildingUnits', ['wohneinheiten', 'anzahlwohneinheiten', 'buildingunits', 'units']],
  ['building.occupants', 'occupants', ['bewohner', 'personenimhaushalt', 'occupants', 'haushaltsgroesse']],
  ['building.construction', 'construction', ['bauweise', 'construction', 'bauart']],
  ['building.glazing', 'glazing', ['verglasung', 'fenster', 'glazing', 'windowtype']],
  ['building.roof', 'roof', ['dach', 'dachform', 'roof']],
  ['building.basement', 'basement', ['keller', 'unterkellerung', 'basement']],
  ['building.exteriorInsulation', 'exteriorInsulation', ['fassadendaemmung', 'aussendaemmung', 'exteriorinsulation']],
  ['building.roofInsulation', 'roofInsulation', ['dachdaemmung', 'roofinsulation']],
  ['building.basementInsulation', 'basementInsulation', ['kellerdeckendaemmung', 'basementinsulation']],
  ['building.designOutdoorTemperature', 'designOutdoorTemperature', ['normaussentemperatur', 'designoutdoortemperature']],
  ['building.thermalBridgePercent', 'thermalBridgePercent', ['waermebrueckenzuschlag', 'thermalbridgepercent']],
  ['existingHeating.energySource', 'energySource', ['energietraeger', 'heizart', 'energysource', 'brennstoff']],
  ['existingHeating.manufacturer', 'heatingManufacturer', ['heizungshersteller', 'herstellerheizung', 'heatingmanufacturer']],
  ['existingHeating.model', 'heatingModel', ['heizungsmodell', 'modellheizung', 'heatingmodel']],
  ['existingHeating.installationYear', 'heatingYear', ['heizungsbaujahr', 'baujahrheizung', 'installationyear']],
  ['existingHeating.nominalPower', 'nominalPower', ['nennleistung', 'heizleistung', 'nominalpower']],
  ['existingHeating.boilerLocation', 'boilerLocation', ['aufstellortheizung', 'heizungsstandort', 'boilerlocation']],
  ['existingHeating.systemType', 'systemType', ['heizsystem', 'waermeverteilung', 'systemtype']],
  ['existingHeating.pipeSystem', 'pipeSystem', ['rohrsystem', 'pipesystem']],
  ['existingHeating.pipeDiameter', 'pipeDiameter', ['rohrdurchmesser', 'pipediameter']],
  ['existingHeating.flowTemperature', 'flowTemperature', ['vorlauftemperatur', 'flowtemperature']],
  ['existingHeating.hotWater', 'hotWater', ['warmwasserbereitung', 'warmwasser', 'hotwater']],
  ['existingHeating.tanks', 'tanks', ['tank', 'lager', 'speicherbestand', 'tanks']],
  ['existingHeating.annualConsumption', 'annualConsumption', ['jahresverbrauch', 'energieverbrauch', 'annualconsumption', 'verbrauch']],
  ['existingHeating.consumptionUnit', 'consumptionUnit', ['verbrauchseinheit', 'consumptionunit']],
  ['existingHeating.consumptionPeriod', 'consumptionPeriod', ['verbrauchszeitraum', 'verbrauchsjahr', 'consumptionperiod']],
  ['existingHeating.billAvailable', 'billAvailable', ['verbrauchsnachweisvorhanden', 'abrechnungvorhanden', 'billavailable']],
  ['heatPump.desiredPosition', 'desiredPosition', ['aussenstandort', 'waermepumpenstandort', 'desiredposition']],
  ['heatPump.indoorPosition', 'indoorPosition', ['innenstandort', 'inneneinheitstandort', 'indoorposition']],
  ['heatPump.distance', 'hpDistance', ['leitungslaenge', 'entfernungausseninnen', 'waermepumpenentfernung', 'distance']],
  ['heatPump.accessWidth', 'accessWidth', ['zugangsbreite', 'accesswidth']],
  ['heatPump.levelDifference', 'levelDifference', ['hoehenunterschied', 'leveldifference']],
  ['heatPump.route', 'hpRoute', ['leitungsweg', 'trassenverlauf', 'route']],
  ['heatPump.refrigerantPreference', 'refrigerantPreference', ['kaeltemittelwunsch', 'kaeltemittel', 'refrigerantpreference']],
  ['heatPump.manufacturerPreference', 'manufacturerPreference', ['herstellerwunsch', 'manufacturerpreference']],
  ['heatPump.notes', 'hpNotes', ['hinweiseaufstellung', 'waermepumpenhinweise', 'heatpumpnotes']],
  ['site.protectedBuilding', 'protectedBuilding', ['denkmalschutz', 'protectedbuilding']],
  ['site.noiseSensitive', 'noiseSensitive', ['geraeuschsensibel', 'laermsensibel', 'noisesensitive']],
  ['site.craneRequired', 'craneRequired', ['kranerforderlich', 'cranerequired']],
  ['site.accessNotes', 'accessNotes', ['zufahrt', 'zugangmontage', 'accessnotes']],
  ['hydraulics.underfloorHeating', 'underfloorHeating', ['fussbodenheizung', 'underfloorheating']],
  ['hydraulics.circulationPumps', 'circulationPumps', ['umwaelzpumpen', 'circulationpumps']],
  ['hydraulics.bufferTank', 'bufferTank', ['pufferspeicher', 'buffertank']],
  ['hydraulics.notes', 'hydraulicNotes', ['hydraulischehinweise', 'hydraulicsnotes']],
  ['electrical.serviceAmps', 'serviceAmps', ['hausanschluss', 'absicherung', 'serviceamps']],
  ['electrical.meterType', 'meterType', ['zaehlerart', 'metertype']],
  ['electrical.freeSlots', 'freeSlots', ['freieplaetze', 'freeslots']],
  ['electrical.upgradeNeeded', 'upgradeNeeded', ['elektroumbaunoetig', 'upgradeneeded']],
  ['electrical.cabinetNotes', 'cabinetNotes', ['hinweiseelektroverteilung', 'cabinetnotes']],
  ['pv.present', 'pvPresent', ['pvanlagevorhanden', 'photovoltaikvorhanden', 'pvpresent']],
  ['pv.power', 'pvPower', ['pvleistung', 'photovoltaikleistung', 'pvpower']],
  ['pv.batteryPresent', 'batteryPresent', ['batteriespeichervorhanden', 'batterypresent']],
  ['pv.batteryCapacity', 'batteryCapacity', ['speicherkapazitaet', 'batterycapacity']],
  ['pv.solarThermal', 'solarThermal', ['solarthermie', 'solarthermal']],
  ['funding.existingBuildingAgeYears', 'existingBuildingAgeYears', ['gebaeudealter', 'existingbuildingageyears']],
  ['funding.projectCosts', 'fundingProjectCosts', ['projektkosten', 'foerderfaehigekosten', 'projectcosts']],
  ['funding.householdIncome', 'householdIncome', ['haushaltseinkommen', 'zvE', 'householdincome']],
];

const PATHS = TMB_PREFILL_FIELDS.map(([path]) => path);
const FIELD_BY_PATH = new Map(TMB_PREFILL_FIELDS.map(([path, fieldId]) => [path, fieldId]));
const AI_SCHEMA = z.object({
  fields: z.array(z.object({
    path: z.enum(PATHS),
    value: z.union([z.string().max(1000), z.boolean()]),
    source: z.enum(['CRM', 'PLAUD', 'Qonekto']),
    evidence: z.string().max(500),
  })).max(PATHS.length),
});

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeKey(value) {
  return String(value || '')
    .toLocaleLowerCase('de')
    .replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
}

function cleanValue(value) {
  if (typeof value === 'boolean') return value;
  if (!['string', 'number'].includes(typeof value)) return '';
  return String(value).trim().slice(0, 1000);
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  const normalized = normalizeKey(value);
  if (['ja', 'yes', 'true', 'vorhanden', 'erforderlich'].includes(normalized)) return true;
  if (['nein', 'no', 'false', 'nichtvorhanden', 'nichterforderlich'].includes(normalized)) return false;
  return null;
}

function isBooleanPath(path) {
  return new Set([
    'existingHeating.billAvailable', 'site.protectedBuilding', 'site.noiseSensitive', 'site.craneRequired',
    'hydraulics.underfloorHeating', 'pv.present', 'pv.batteryPresent', 'pv.solarThermal',
  ]).has(path);
}

function nodes(value, maxDepth = 7) {
  const queue = [{ value, depth: 0 }];
  const result = [];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current?.value || typeof current.value !== 'object' || current.depth > maxDepth || seen.has(current.value)) continue;
    seen.add(current.value);
    result.push(current.value);
    for (const child of Object.values(current.value)) if (child && typeof child === 'object') queue.push({ value: child, depth: current.depth + 1 });
  }
  return result;
}

function valueFor(source, aliases) {
  const wanted = aliases.map(normalizeKey);
  const objects = nodes(source);
  for (const alias of wanted) {
    for (const object of objects) {
      if (Array.isArray(object)) continue;
      const entry = Object.entries(object).find(([key]) => normalizeKey(key) === alias);
      const value = cleanValue(entry?.[1]);
      if (value !== '') return { value, evidence: `${entry[0]}: ${String(value).slice(0, 180)}` };
    }
  }
  return null;
}

function setPath(target, path, value) {
  const parts = path.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] ||= {};
  cursor[parts.at(-1)] = value;
}

function getPath(target, path) {
  return path.split('.').reduce((value, key) => value?.[key], target);
}

function textEvidence(sourceText, aliases, path) {
  const wanted = aliases.map(normalizeKey);
  for (const line of String(sourceText || '').split(/\n+/)) {
    const match = line.match(/^\s*([^:=]{2,80})\s*(?::|=)\s*(.+?)\s*$/);
    if (!match) continue;
    const label = normalizeKey(match[1]);
    if (!wanted.some(alias => label === alias || label.includes(alias))) continue;
    const raw = match[2].trim().slice(0, 1000);
    const withoutUnit = path === 'building.heatedArea'
      ? raw.replace(/\s*(?:m²|m2|qm)\s*$/i, '')
      : path === 'existingHeating.annualConsumption'
        ? raw.replace(/\s*(?:kWh|Liter|l|m³|m3|kg)\s*$/i, '')
        : raw;
    if (withoutUnit) return { value: withoutUnit, evidence: line.trim().slice(0, 300) };
  }
  const aliasPattern = aliases
    .map(alias => String(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ae/g, '(?:ä|ae)').replace(/oe/g, '(?:ö|oe)').replace(/ue/g, '(?:ü|ue)'))
    .join('|');
  const unit = path === 'building.heatedArea' ? '\\s*(?:m²|m2|qm)?'
    : path === 'existingHeating.annualConsumption' ? '\\s*(?:kWh|Liter|l|m³|m3|kg)?'
      : path.endsWith('year') || path.endsWith('Year') ? '' : '';
  const expression = new RegExp(`(?:${aliasPattern})\\s*(?:ist|beträgt|:|=|ca\\.)?\\s*([^\\n,;]{1,90}?)${unit}(?=\\s*(?:[,.!?;]|$|\\n))`, 'i');
  const match = sourceText.match(expression);
  if (!match?.[1]) return null;
  const value = match[1].trim().replace(/\s+/g, ' ');
  return value ? { value, evidence: match[0].trim().slice(0, 300) } : null;
}

function sourceDocuments({ customerWorkspace = {}, crmLead = null, qonektoDetail = null } = {}) {
  const meetings = Array.isArray(customerWorkspace.data?.meetings) ? customerWorkspace.data.meetings : [];
  const notes = Array.isArray(customerWorkspace.notes) ? customerWorkspace.notes : [];
  return [
    crmLead ? { source: 'CRM', structured: crmLead, text: '' } : null,
    qonektoDetail ? { source: 'Qonekto', structured: qonektoDetail, text: '' } : null,
    notes.length ? { source: 'CRM', structured: null, text: notes.map(note => note.text).filter(Boolean).join('\n') } : null,
    ...meetings.map(meeting => ({
      source: meeting.source === 'plaud' ? 'PLAUD' : 'CRM',
      structured: null,
      text: [meeting.internalSummary, meeting.customerSummary, meeting.transcript, ...(meeting.topics || []), ...(meeting.decisions || []), ...(meeting.actionItems || [])].filter(Boolean).join('\n'),
      meeting,
    })),
  ].filter(Boolean);
}

export function buildDeterministicTmbPrefill(input = {}) {
  const documents = sourceDocuments(input);
  const data = { schemaVersion: 'iva-tmb-1.0' };
  const fields = [];
  for (const [path, fieldId, aliases] of TMB_PREFILL_FIELDS) {
    let found = null;
    for (const document of documents) {
      if (document.structured) found = valueFor(document.structured, aliases);
      if (!found && document.text) found = textEvidence(document.text, aliases, path);
      if (!found) continue;
      let value = found.value;
      if (isBooleanPath(path)) {
        value = parseBoolean(value);
        if (value === null) { found = null; continue; }
      }
      setPath(data, path, value);
      fields.push({ path, fieldId, source: document.source, evidence: found.evidence, method: 'belegt übernommen' });
      break;
    }
  }
  return { data, fields, documents };
}

function modelInput(documents = []) {
  return documents.map((document, index) => {
    const payload = document.structured ? JSON.stringify(document.structured) : document.text;
    return `QUELLE ${index + 1} · ${document.source}\n${String(payload || '').slice(0, 24_000)}`;
  }).join('\n\n').slice(0, 48_000);
}

async function buildAiTmbPrefill(documents, existingData) {
  if (!process.env.ANTHROPIC_API_KEY || !documents.length) return { fields: [], skipped: 'kein Modellzugang oder keine Quelldaten' };
  const routed = chooseModel({ task: 'classification' });
  await checkBudget(routed);
  const { object, usage } = await generateObject({
    model: routed.model,
    schema: AI_SCHEMA,
    temperature: 0,
    system: `Du übernimmst ausschließlich ausdrücklich belegte Angaben aus CRM-, Qonekto- und PLAUD-Quellen in eine technische Machbarkeitsbewertung (TMB). Erfinde und schätze nichts. Lass ein Feld weg, wenn der Wert nicht eindeutig belegt ist. evidence muss eine kurze wörtliche Belegstelle oder bei strukturierten Daten den exakten Feldnamen und Wert enthalten. Maße bleiben als Originalwert ohne Umrechnung.`,
    prompt: `Bereits deterministisch gefüllte Werte (nicht erneut ausgeben):\n${JSON.stringify(existingData)}\n\nZulässige Zielfelder:\n${PATHS.join('\n')}\n\nQuellen:\n${modelInput(documents)}`,
  });
  await recordUsage(routed, usage);
  return { fields: object.fields || [], model: routed.modelId };
}

function sourceSummary(input, fields) {
  const meetings = Array.isArray(input.customerWorkspace?.data?.meetings) ? input.customerWorkspace.data.meetings : [];
  const sources = [];
  if (input.crmLead || input.customerWorkspace?.data?.crm?.sourceId || input.customerWorkspace?.notes?.length) sources.push({ kind: 'CRM', label: input.customerWorkspace?.data?.crm?.project || 'CRM-Kundenakte' });
  if (input.qonektoDetail) sources.push({ kind: 'Qonekto', label: 'Qonekto / Blau Direkt' });
  const plaudMeetings = meetings.filter(meeting => meeting.source === 'plaud');
  if (plaudMeetings.length) sources.push({ kind: 'PLAUD', label: `${plaudMeetings.length} Gespräch${plaudMeetings.length === 1 ? '' : 'e'}` });
  return { sources, appliedCount: fields.length, plaudMeetings };
}

export async function prepareTmbPrefill(input = {}, { useAi = true } = {}) {
  const deterministic = buildDeterministicTmbPrefill(input);
  const fields = [...deterministic.fields];
  let ai = { fields: [], skipped: 'deaktiviert' };
  if (useAi) {
    try { ai = await buildAiTmbPrefill(deterministic.documents, deterministic.data); }
    catch (error) { ai = { fields: [], error: String(error?.message || error).slice(0, 300) }; }
  }
  for (const item of ai.fields || []) {
    if (getPath(deterministic.data, item.path) !== undefined) continue;
    let value = item.value;
    if (isBooleanPath(item.path)) {
      value = parseBoolean(value);
      if (value === null) continue;
    }
    setPath(deterministic.data, item.path, value);
    fields.push({ path: item.path, fieldId: FIELD_BY_PATH.get(item.path), source: item.source, evidence: item.evidence, method: 'belegt aus Quelle erkannt' });
  }
  const summary = sourceSummary(input, fields);
  const latestPlaud = summary.plaudMeetings.sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || '')))[0] || null;
  deterministic.data.prefill = {
    sourceWorkspaceId: input.customerWorkspace?.id || '',
    preparedAt: new Date().toISOString(),
    sources: summary.sources,
    fields,
    appliedCount: fields.length,
    aiModel: ai.model || '',
    aiFallback: ai.error || ai.skipped || '',
  };
  return {
    data: deterministic.data,
    visit: latestPlaud ? {
      consent: latestPlaud.consent || {},
      plaud: { recordingId: latestPlaud.externalId || '', status: latestPlaud.externalId ? 'linked' : 'not-linked', importedAt: latestPlaud.updatedAt || latestPlaud.createdAt || '' },
    } : {},
    summary: { sources: summary.sources, appliedCount: fields.length, latestPlaudId: latestPlaud?.externalId || '' },
  };
}

function shouldUsePrefill(current, next, { reviewed = false, previouslySourced = false } = {}) {
  if (current === undefined || current === null || current === '') return true;
  if (Array.isArray(current)) return current.length === 0 && Array.isArray(next) && next.length > 0;
  if (typeof current === 'boolean') return !reviewed && !previouslySourced && current === false && next === true;
  return false;
}

export function mergeTmbPrefillPreservingExisting(existingData = {}, prefillData = {}) {
  const merged = structuredClone(existingData || {});
  const oldSources = new Set((existingData.prefill?.fields || []).map(item => item.path));
  const reviewed = existingData.declaration?.reviewed === true || existingData.tmbReview?.status === 'reviewed';
  for (const [path] of TMB_PREFILL_FIELDS) {
    const next = getPath(prefillData, path);
    if (next === undefined || next === '') continue;
    const current = getPath(existingData, path);
    if (shouldUsePrefill(current, next, { reviewed, previouslySourced: oldSources.has(path) })) setPath(merged, path, next);
  }
  if ((!Array.isArray(existingData.rooms) || !existingData.rooms.length) && Array.isArray(prefillData.rooms) && prefillData.rooms.length) merged.rooms = prefillData.rooms;
  merged.prefill = {
    ...(existingData.prefill || {}),
    ...(prefillData.prefill || {}),
    fields: [...(existingData.prefill?.fields || []), ...(prefillData.prefill?.fields || [])]
      .filter((item, index, all) => all.findIndex(other => other.path === item.path) === index),
  };
  return merged;
}
