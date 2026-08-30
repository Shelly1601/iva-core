import { executePlanbarJavaScript } from './planbar.mjs';

export const PLANBAR_FORECAST_YEAR = 2026;
export const PLANBAR_FORECAST_FIRST_WEEK = 36;
export const PLANBAR_FORECAST_LAST_WEEK = 45;

const MANUFACTURERS = Object.freeze([
  { name: 'Johnson Controls York', pattern: /\b(?:johnson(?:\s+controls?)?|york)\b/i },
  { name: 'Stiebel Eltron', pattern: /\bstiebel(?:\s+eltron)?\b/i },
  { name: 'Alpha Innotec', pattern: /\balpha\s*innotec\b/i },
  { name: 'Mitsubishi Electric', pattern: /\bmitsubishi(?:\s+electric)?\b/i },
  { name: 'Panasonic', pattern: /\bpanasonic\b/i },
  { name: 'Vaillant', pattern: /\bvaillant\b/i },
  { name: 'Viessmann', pattern: /\bviessmann\b/i },
  { name: 'Buderus', pattern: /\bbuderus\b/i },
  { name: 'Bosch', pattern: /\bbosch\b/i },
  { name: 'Midea', pattern: /\bmidea\b/i },
  { name: 'Wolf', pattern: /\bwolf\b/i },
  { name: 'Daikin', pattern: /\bdaikin\b/i },
  { name: 'Samsung', pattern: /\bsamsung\b/i },
  { name: 'NIBE', pattern: /\bnibe\b/i },
  { name: 'Lambda', pattern: /\blambda\b/i },
  { name: 'Solarfocus', pattern: /\bsolarfocus\b/i },
  { name: 'LG', pattern: /\blg\b/i },
]);

const EXCLUDED_RESOURCE_PATTERN = /^(?:team\s+)?(?:dawid|david)\s+service$|^antonio\s+lausi(?:c|ch|tsch)$/i;
const INTERNAL_BLOCK_PATTERN = /\b(?:urlaub|nicht\s+verf(?:ü|ue)gbar|geb(?:lockt|lockt)|blocker|gel(?:ö|oe)scht)\b/i;
const EXTRA_PATTERN = /(?:\s*[,;]\s*|\s{2,})(?:zwei\s+einzelspeicher|einzel[- ]?speicher|kombi(?:speicher)?|warmwasser|puffer(?:speicher)?|außenverrohrung|aussenverrohrung|extra\s+verrohrung|neu[- ]?isolierung|zusätzlicher\s+heizkreis|frostschutz|hauptstrom|fußboden|fussboden|pflaster|doyma|entsorgung|heizstab|weitere\s+wanddurchbr|my[- ]?pv|frischwasser|speicher|materialannahme|diebstahl|geprüft|gepr\*ft|in\s+prüfung)\b/i;

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function dateOnly(value) {
  return clean(value).slice(0, 10);
}

function addDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizedComparable(value) {
  return clean(value).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

export function isoWeekMonday(isoYear, week) {
  const fourthJanuary = new Date(Date.UTC(Number(isoYear), 0, 4));
  const monday = new Date(fourthJanuary);
  monday.setUTCDate(fourthJanuary.getUTCDate() - ((fourthJanuary.getUTCDay() + 6) % 7) + ((Number(week) - 1) * 7));
  return monday.toISOString().slice(0, 10);
}

export function normalizePlanbarCustomerName(value) {
  return clean(value).replace(/^(?:HH|EN|DW)\s+/i, '').trim();
}

export function normalizePlanbarAddress(address = {}) {
  const street = clean(address.street);
  const place = clean([address.zipcode, address.city].filter(Boolean).join(' '));
  return [street, place].filter(Boolean).join(', ') || 'Nicht angegeben';
}

export function normalizePlanbarManufacturer(task) {
  const value = clean(task);
  return MANUFACTURERS.find(item => item.pattern.test(value))?.name || 'Nicht angegeben';
}

function productLineStart(line, manufacturer) {
  const value = clean(line);
  if (!value) return '';
  const brandPattern = MANUFACTURERS.find(item => item.name === manufacturer)?.pattern;
  const brandMatch = brandPattern ? value.match(brandPattern) : null;
  const brandIndex = brandMatch?.index ?? value.search(/\bwärmepumpe\b/i);
  if (brandIndex < 0) return '';
  const before = value.slice(0, brandIndex);
  const powerMatches = [...before.matchAll(/(?:\d+\s*x\s*)?\d+(?:[,.]\d+)?\s*kW\s*(?:[-–]\s*)?/gi)];
  const powerStart = powerMatches.at(-1)?.index;
  if (Number.isInteger(powerStart)) return value.slice(powerStart);
  if (/heat\s*\|?\s*hero\s+wärmepumpenpaket/i.test(before)) {
    return value.slice(Math.max(0, before.toLowerCase().lastIndexOf('wärmepumpenpaket')) + 'wärmepumpenpaket'.length).trim();
  }
  return value.slice(brandIndex);
}

export function extractPlanbarSystem(task) {
  const originalLines = String(task || '').split(/\r?\n|;/).map(clean).filter(Boolean);
  const manufacturer = normalizePlanbarManufacturer(task);
  const matchIndex = originalLines.findIndex(line => {
    if (manufacturer === 'Nicht angegeben') return /\bwärmepumpe\b/i.test(line);
    return MANUFACTURERS.find(item => item.name === manufacturer)?.pattern.test(line);
  });
  if (matchIndex < 0) return 'Nicht angegeben';

  let system = productLineStart(originalLines[matchIndex], manufacturer);
  const nextLine = originalLines[matchIndex + 1] || '';
  if (manufacturer === 'Vaillant' && /\barotherm\b/i.test(nextLine)) {
    system = `${system} ${nextLine.split(/\bmit\s+(?:hydraulik|regelung)/i)[0]}`;
  }
  system = system
    .split(EXTRA_PATTERN)[0]
    .split(/,\s*(?!(?:\d+(?:[,.]\d+)?\s*kW\b))/i)[0]
    .split(/\b(?:heizkreis(?:e|-gemi(?:sch|s)cht)?|pufferspeicher|warmwasserspeicher|außenverrohrung|aussenverrohrung|extra\s+verrohrung|mit\s+hydraulikstation|mit\s+e-heizelement)\b/i)[0];
  system = clean(system)
    .replace(/^[-–,:]+\s*/, '')
    .replace(/(\d)\s*kw\b/gi, '$1 kW')
    .replace(/\bJohnson(?:\s+Controls?)?\b|\bYork\b/gi, 'Johnson Controls York')
    .replace(/\bJohnson Controls York(?:\s+Johnson Controls York)+\b/gi, 'Johnson Controls York')
    .replace(/\bPanasonic\b/gi, 'Panasonic')
    .replace(/\bVaillant\b/gi, 'Vaillant')
    .replace(/\bBosch\b/gi, 'Bosch')
    .replace(/\bMidea\b/gi, 'Midea')
    .replace(/\bWolf\b/gi, 'Wolf')
    .replace(/\s*\((?:bei|bestellt|vorrätig)\b.*$/i, '')
    .replace(/\s+auf\s+Abruf\.?$/i, '')
    .replace(/\s+-\s+/g, ' - ')
    .trim();
  return system || 'Nicht angegeben';
}

export function isExcludedPlanbarForecastEntry(entry = {}) {
  if (EXCLUDED_RESOURCE_PATTERN.test(clean(entry.team))) return true;
  const text = [entry.entryCustomerName, entry.customerName, entry.task].map(clean).join(' ');
  return INTERNAL_BLOCK_PATTERN.test(text);
}

function eventEndExclusive(entry) {
  const start = dateOnly(entry.start);
  const end = dateOnly(entry.end);
  if (!start) return '';
  if (!end || end < start) return addDays(start, 1);
  return addDays(end, 1);
}

export function buildPlanbarForecast(rawEntries, {
  isoYear = PLANBAR_FORECAST_YEAR,
  firstWeek = PLANBAR_FORECAST_FIRST_WEEK,
  lastWeek = PLANBAR_FORECAST_LAST_WEEK,
} = {}) {
  const rows = [];
  const sourceRows = [];
  const excluded = [];
  for (const entry of Array.isArray(rawEntries) ? rawEntries : []) {
    const startDate = dateOnly(entry.start);
    const endDateExclusive = eventEndExclusive(entry);
    const customer = normalizePlanbarCustomerName(entry.customerName || entry.entryCustomerName);
    const address = normalizePlanbarAddress(entry.workAddress);
    const manufacturer = normalizePlanbarManufacturer(entry.task);
    const system = extractPlanbarSystem(entry.task);
    if (!startDate || !customer) {
      excluded.push({
        id: clean(entry.id),
        team: clean(entry.team),
        customer: customer || clean(entry.entryCustomerName),
        reason: 'interner Termin',
      });
      continue;
    }
    const excludedResource = EXCLUDED_RESOURCE_PATTERN.test(clean(entry.team));
    const internalEntry = INTERNAL_BLOCK_PATTERN.test([entry.entryCustomerName, entry.customerName, entry.task].map(clean).join(' '));
    const excludedEntry = excludedResource || internalEntry;
    let overlapsForecast = false;
    for (let week = Number(firstWeek); week <= Number(lastWeek); week += 1) {
      const monday = isoWeekMonday(isoYear, week);
      const followingMonday = addDays(monday, 7);
      if (startDate >= followingMonday || endDateExclusive <= monday) continue;
      overlapsForecast = true;
      const row = {
        kalenderwoche: `KW ${week}`,
        kalenderwocheNummer: week,
        kunde: customer,
        adresse: address,
        anlage: system,
        hersteller: manufacturer,
        planbarColumn: clean(entry.team),
        sourceId: clean(entry.id),
      };
      if (!internalEntry) {
        sourceRows.push({
          calendarWeek: row.kalenderwoche,
          customer: row.kunde,
          address: row.adresse,
          system: row.anlage,
          manufacturer: row.hersteller,
          planbarColumn: row.planbarColumn,
          sourceId: row.sourceId,
        });
      }
      if (!excludedEntry) rows.push(row);
    }
    if (excludedEntry && overlapsForecast) {
      excluded.push({
        id: clean(entry.id),
        team: clean(entry.team),
        customer,
        reason: excludedResource ? 'ausgeschlossene Ressource' : 'interner Termin',
      });
    }
  }

  const deduplicated = new Map();
  for (const row of rows) {
    const key = [row.kalenderwocheNummer, normalizedComparable(row.kunde), normalizedComparable(row.adresse)].join('|');
    const existing = deduplicated.get(key);
    if (!existing || (existing.anlage === 'Nicht angegeben' && row.anlage !== 'Nicht angegeben')) deduplicated.set(key, row);
  }
  const finalRows = [...deduplicated.values()].sort((left, right) => (
    left.kalenderwocheNummer - right.kalenderwocheNummer
    || left.kunde.localeCompare(right.kunde, 'de')
    || left.adresse.localeCompare(right.adresse, 'de')
  ));
  const byManufacturer = Object.fromEntries([...new Set(finalRows.map(row => row.hersteller))]
    .sort((a, b) => a.localeCompare(b, 'de'))
    .map(manufacturer => [manufacturer, finalRows.filter(row => row.hersteller === manufacturer)]));
  return {
    generatedAt: new Date().toISOString(),
    isoYear: Number(isoYear),
    firstWeek: Number(firstWeek),
    lastWeek: Number(lastWeek),
    rowCount: finalRows.length,
    excludedCount: excluded.length,
    rows: finalRows,
    sourceRows,
    byManufacturer,
    excluded,
  };
}

export async function collectPlanbarForecastSource({
  isoYear = PLANBAR_FORECAST_YEAR,
  firstWeek = PLANBAR_FORECAST_FIRST_WEEK,
  lastWeek = PLANBAR_FORECAST_LAST_WEEK,
  timeoutMs = 120000,
} = {}) {
  const rangeStart = isoWeekMonday(isoYear, firstWeek);
  const rangeEndExclusive = addDays(isoWeekMonday(isoYear, lastWeek), 7);
  const raw = await executePlanbarJavaScript(String.raw`(() => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const configElement = document.querySelector('[data-planboard-config]');
    if (!configElement) throw new Error('Die Planbar-Konfiguration wurde nicht gefunden.');
    const config = JSON.parse(configElement.dataset.planboardConfig || '{}');
    if (!config.routes?.resourceDataForTooltips) throw new Error('Die Planbar-Lesequelle wurde nicht gefunden.');
    const url = new URL(config.routes.resourceDataForTooltips);
    url.searchParams.set('start', ${JSON.stringify(rangeStart)});
    url.searchParams.set('end', ${JSON.stringify(rangeEndExclusive)});
    url.searchParams.set('globalEdit', 'true');
    url.searchParams.set('_ivaForecastFresh', String(Date.now()));
    const request = new XMLHttpRequest();
    request.open('GET', url.toString(), false);
    request.setRequestHeader('Accept', 'application/json');
    request.setRequestHeader('Cache-Control', 'no-cache, no-store, max-age=0');
    request.setRequestHeader('Pragma', 'no-cache');
    request.send(null);
    if (request.status < 200 || request.status >= 300) throw new Error('Planbar HTTP ' + request.status);
    const payload = JSON.parse(request.responseText || '{}');
    const teams = new Map();
    const addTeam = (id, name) => {
      const key = clean(id);
      const value = clean(name);
      if (key && value) teams.set(key, value);
    };
    for (const row of (config.planboardEmployeeCrew || [])) addTeam(row?.[0], row?.[1]);
    for (const row of (config.planboardEquipmentInGroup || [])) addTeam(row?.[0], row?.[1]);
    for (const row of (config.planboardUsers || [])) addTeam(row?.id, row?.name);
    for (const row of (config.planboardEquipments || [])) addTeam(row?.id, row?.name);
    for (const cell of document.querySelectorAll('.fc-datagrid-body [data-resource-id]')) addTeam(cell.getAttribute('data-resource-id'), cell.innerText);
    return JSON.stringify({
      collectedAt: new Date().toISOString(),
      cacheBypass: true,
      rangeStart: ${JSON.stringify(rangeStart)},
      rangeEndExclusive: ${JSON.stringify(rangeEndExclusive)},
      entries: (Array.isArray(payload.entries) ? payload.entries : []).map(entry => ({
        id: clean(entry.id),
        resourceId: clean(entry.resourceId),
        team: teams.get(clean(entry.resourceId)) || '',
        start: clean(entry.start),
        end: clean(entry.end),
        entryCustomerName: clean(entry.customer_name),
        customerName: clean([entry.tooltipdata?.customer?.firstname, entry.tooltipdata?.customer?.lastname].filter(Boolean).join(' ') || entry.tooltipdata?.customer?.name || entry.customer_name),
        workAddress: entry.tooltipdata?.work_address || {},
        task: String(entry.tooltipdata?.task || '').trim(),
      })),
    });
  })()`, { timeoutMs });
  const source = JSON.parse(raw);
  if (!Array.isArray(source.entries) || !source.entries.length) throw new Error('Planbar hat keine Forecast-Einträge geliefert.');
  return source;
}

export async function collectAndBuildPlanbarForecast(options = {}) {
  const source = await collectPlanbarForecastSource(options);
  return { source, forecast: buildPlanbarForecast(source.entries, options) };
}
