import { spawn } from 'node:child_process';
import {
  countPlanbarFreeWorkweekCapacity,
  PLANBAR_CAPACITY_RULE_VERSION,
  PLANBAR_ENTER_BLOCK_TEXT,
  PLANBAR_MINIMUM_BLOCK_DAYS,
} from '../operations/customer-scheduling.js';

const PLANBAR_HOST = 'heathero-partner-a.planbar365.com';
const MAX_OUTPUT_BYTES = 1024 * 1024;

function runAppleScript(script, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Die Planbar-Auslesung hat das Zeitlimit überschritten.'));
    }, timeoutMs);
    child.stdout.on('data', chunk => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error((stderr || stdout || `osascript beendet mit Code ${code}`).trim()));
    });
    child.stdin.end(script);
  });
}

export async function executePlanbarJavaScript(javascript, { timeoutMs = 120000 } = {}) {
  const script = `tell application "Google Chrome"
repeat with w in windows
  repeat with t in tabs of w
    if (URL of t) contains "${PLANBAR_HOST}/resource/list" then return (execute t javascript ${JSON.stringify(String(javascript))})
  end repeat
end repeat
return "NO_TAB"
end tell`;
  const output = await runAppleScript(script, { timeoutMs });
  if (output === 'NO_TAB') throw new Error('Planbar ist in Chrome nicht auf der Plantafel geöffnet.');
  return output;
}

export async function diagnosePlanbarDom() {
  return JSON.parse(await executePlanbarJavaScript(String.raw`(() => JSON.stringify({
    titleCount: document.querySelectorAll('.fc-timeline-body .fc-event-title-booking').length,
    resourceCount: document.querySelectorAll('.fc-datagrid-body [data-resource-id]').length,
    dialogCount: document.querySelectorAll('[role="dialog"]').length,
    dayCellCount: document.querySelectorAll('th.fc-timeline-slot-label[data-date][colspan="1"]').length,
    firstTitle: document.querySelector('.fc-timeline-body .fc-event-title-booking')?.textContent || '',
    firstResourceId: document.querySelector('.fc-timeline-body .fc-event-title-booking')?.closest('[data-resource-id]')?.getAttribute('data-resource-id') || '',
  }))()`));
}

// Called only inside the central agent's UI lock and wake guard. Reload first,
// then wait for a NEW document and actual resource configuration, not a timer.
export async function refreshPlanbarPage({ execute = executePlanbarJavaScript, login,
  timeoutMs = 60_000, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const ensureLogin = login || (await import('./portal-auth.mjs')).ensurePortalLogin;
  await ensureLogin('planbar');
  const oldOrigin = Number(await execute('String(performance.timeOrigin)'));
  await execute('location.reload(); "RELOADING"');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await wait(500);
    try {
      const state = JSON.parse(await execute(`JSON.stringify({origin:performance.timeOrigin,ready:document.readyState==='complete'&&!!document.querySelector('[data-planboard-config]')&&!!document.querySelector('.fc-datagrid-body [data-resource-id]')})`));
      if (state.ready && state.origin !== oldOrigin) return { refreshedAt: new Date().toISOString(), verified: true };
    } catch { /* A document is unavailable briefly during navigation. */ }
  }
  throw new Error('Planbar wurde neu geladen, die aktuelle Plantafel ist aber noch nicht prüfbar. Keine Terminfreigabe.');
}

export async function collectPlanbarSearchIndex({ timeoutMs = 120000 } = {}) {
  const raw = await executePlanbarJavaScript(String.raw`(() => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const addDays = (value, days) => {
      const date = new Date(value + 'T00:00:00Z');
      date.setUTCDate(date.getUTCDate() + days);
      return date.toISOString().slice(0, 10);
    };
    const configElement = document.querySelector('[data-planboard-config]');
    if (!configElement) throw new Error('Die Planbar-Konfiguration wurde nicht gefunden.');
    const config = JSON.parse(configElement.dataset.planboardConfig || '{}');
    if (!config.routes?.resourceDataForTooltips) throw new Error('Die Planbar-Lesequelle wurde nicht gefunden.');
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const day = today.getDay() || 7;
    today.setDate(today.getDate() - day + 1);
    const rangeStart = today.toISOString().slice(0, 10);
    const rangeEndExclusive = addDays(rangeStart, 16 * 7);
    const url = new URL(config.routes.resourceDataForTooltips);
    url.searchParams.set('start', rangeStart);
    url.searchParams.set('end', rangeEndExclusive);
    url.searchParams.set('globalEdit', 'true');
    const request = new XMLHttpRequest();
    request.open('GET', url.toString(), false);
    request.setRequestHeader('Accept', 'application/json');
    request.send(null);
    if (request.status < 200 || request.status >= 300) {
      throw new Error('Planbar hat die Leseanfrage mit Status ' + request.status + ' abgelehnt.');
    }
    const payload = JSON.parse(request.responseText || '{}');
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
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
    for (const cell of document.querySelectorAll('.fc-datagrid-body [data-resource-id]')) {
      addTeam(cell.getAttribute('data-resource-id'), cell.innerText);
    }
    const appointments = [];
    const enterBlockers = [];
    const capacityBookings = [];
    const stats = { entries: entries.length, customerEntries: 0, mappedTeams: 0 };
    for (const entry of entries) {
      const tooltip = entry?.tooltipdata || {};
      const customer = tooltip.customer || {};
      const customerName = clean([customer.firstname, customer.lastname].filter(Boolean).join(' ') || customer.name || entry.customer_name);
      const resourceId = clean(entry.resourceId);
      const team = teams.get(resourceId) || '';
      const rawStart = clean(entry.start);
      const rawEnd = clean(entry.end);
      const startDate = rawStart.slice(0, 10);
      let endDateExclusive = rawEnd.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}[ T](?!00:00(?::00)?(?:\.0+)?(?:Z|$))/.test(rawEnd)) {
        endDateExclusive = addDays(endDateExclusive, 1);
      }
      if (!endDateExclusive || endDateExclusive <= startDate) endDateExclusive = addDays(startDate, 1);
      const possibleTexts = [entry.title, entry.text, entry.description, tooltip.title, tooltip.task].map(clean);
      const isEnterBlocker = possibleTexts.includes(${JSON.stringify(PLANBAR_ENTER_BLOCK_TEXT)});
      if (resourceId && team && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
        const capacityBooking = {
          id: clean(entry.id),
          resourceId,
          startDate,
          endDateExclusive,
          text: isEnterBlocker ? ${JSON.stringify(PLANBAR_ENTER_BLOCK_TEXT)} : 'Belegt',
        };
        capacityBookings.push(capacityBooking);
        if (isEnterBlocker) enterBlockers.push(capacityBooking);
      }
      if (!customerName || !resourceId || !team || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) continue;
      stats.customerEntries += 1;
      stats.mappedTeams += 1;
      appointments.push({
        id: clean(entry.id),
        customerName,
        description: clean(tooltip.task),
        team,
        resourceId,
        startDate,
        endDateExclusive,
      });
    }
    return JSON.stringify({
      updatedAt: new Date().toISOString(),
      rangeStart,
      rangeEndExclusive,
      appointments,
      resources: [...teams].map(([id, name]) => ({ id, name })),
      enterBlockers,
      capacityBookings,
      stats,
    });
  })()`, { timeoutMs });
  const result = JSON.parse(raw);
  if (!result?.appointments?.length) {
    throw new Error(`In Planbar wurden keine eindeutig lesbaren Kundentermine erkannt (${JSON.stringify(result?.stats || {})}).`);
  }
  return result;
}

function isoWeekParts(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const isoYear = thursday.getUTCFullYear();
  const weekOne = new Date(Date.UTC(isoYear, 0, 4));
  const weekOneMonday = new Date(weekOne);
  weekOneMonday.setUTCDate(weekOne.getUTCDate() - ((weekOne.getUTCDay() + 6) % 7));
  return { isoYear, week: Math.floor((thursday - weekOneMonday) / 604800000) + 1 };
}

export function buildPlanbarCapacitySnapshot(index, { weekCount = 12 } = {}) {
  if (!index?.rangeStart || !Array.isArray(index.resources) || !index.resources.length) {
    throw new Error('Die Planbar-Kapazität kann ohne vollständig zugeordnete Ressourcen nicht verifiziert werden.');
  }
  const weeks = [];
  for (let offset = 0; offset < Math.max(1, Math.min(12, Number(weekCount) || 12)); offset += 1) {
    const monday = new Date(`${index.rangeStart}T00:00:00Z`);
    monday.setUTCDate(monday.getUTCDate() + (offset * 7));
    const { isoYear, week } = isoWeekParts(monday.toISOString().slice(0, 10));
    weeks.push({
      isoYear,
      week,
      freeSlots: countPlanbarFreeWorkweekCapacity({
        resources: index.resources,
        bookings: index.capacityBookings || index.enterBlockers || [],
        year: isoYear,
        week,
      }),
    });
  }
  return {
    updatedAt: index.updatedAt || new Date().toISOString(),
    pageRefreshedAt: index.pageRefreshedAt || null,
    minimumBlockDays: PLANBAR_MINIMUM_BLOCK_DAYS,
    countingRuleVersion: PLANBAR_CAPACITY_RULE_VERSION,
    excludedResources: ['Dawid Service', 'Antonio Lausic'],
    weeks,
  };
}

export const planbarLocalPolicy = Object.freeze({ readOnly: true, host: PLANBAR_HOST, minimumCapacityBlockDays: PLANBAR_MINIMUM_BLOCK_DAYS, storedFields: ['customerName', 'description', 'team', 'resourceId', 'startDate', 'endDateExclusive'] });
