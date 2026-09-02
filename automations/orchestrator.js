import {
  AUTOMATION_DEFINITIONS,
  beginAutomationRun,
  finishAutomationRun,
  getAutomation,
} from './store.js';
import {
  findPreventiveLessons,
  markPreventiveLessonUsed,
  recordIncident,
} from '../operations/incident-memory.js';

const TIME_ZONE = 'Europe/Berlin';

function localParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(now);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function dateKey(parts) {
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isoWeekKey(parts) {
  const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const year = date.getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((date - start) / 86_400_000) + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function lastWeeklyOccurrence(definition, parts) {
  const weekday = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[parts.weekday];
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const scheduled = Number(definition.hour || 0) * 60 + Number(definition.minute || 0);
  let daysBack = (weekday - Number(definition.weekday) + 7) % 7;
  if (daysBack === 0 && minutes < scheduled) daysBack = 7;
  const occurrence = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) - daysBack));
  return {
    year: String(occurrence.getUTCFullYear()),
    month: String(occurrence.getUTCMonth() + 1).padStart(2, '0'),
    day: String(occurrence.getUTCDate()).padStart(2, '0'),
  };
}

export function automationSlotKey(definition, now = new Date()) {
  const parts = localParts(now);
  if (definition.cadence === 'monthly') return `${definition.id}:monthly:${parts.year}-${parts.month}`;
  if (definition.cadence === 'weekly') return `${definition.id}:weekly:${isoWeekKey(lastWeeklyOccurrence(definition, parts))}`;
  if (definition.cadence === 'interval') {
    const minute = Math.floor(Number(parts.minute) / Number(definition.intervalMinutes || 5)) * Number(definition.intervalMinutes || 5);
    return `${definition.id}:interval:${dateKey(parts)}T${parts.hour}:${String(minute).padStart(2, '0')}`;
  }
  return `${definition.id}:daily:${dateKey(parts)}`;
}

function isDue(definition, now) {
  if (definition.cadence === 'interval') return false;
  const parts = localParts(now);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const scheduled = Number(definition.hour || 0) * 60 + Number(definition.minute || 0);
  if (definition.cadence === 'monthly') {
    const day = Number(parts.day);
    return day > Number(definition.day || 1) || (day === Number(definition.day || 1) && minutes >= scheduled);
  }
  if (definition.cadence === 'weekly') return true;
  return minutes >= scheduled;
}

export function createAutomationOrchestrator(handlers = {}) {
  async function runAutomation(id, { trigger = 'schedule', now = new Date(), slotKey = '', allowDisabled = false } = {}) {
    const automation = await getAutomation(id);
    if (!automation) throw new Error('Automation nicht gefunden.');
    if (!automation.enabled && !allowDisabled) return { automationId: id, skipped: true, reason: 'disabled' };
    const handler = handlers[id];
    if (typeof handler !== 'function') throw new Error(`Kein Handler für Automation ${id}.`);
    const started = await beginAutomationRun(id, { trigger, slotKey: slotKey || automationSlotKey(automation, now) });
    if (started.duplicate) return { automationId: id, skipped: true, reason: started.exhausted ? 'attempts-exhausted' : 'duplicate', run: started.run };
    let timeout;
    try {
      const preventiveLessons = await findPreventiveLessons({
        system: 'railway', workflowId: id, action: 'automation.run', step: 'execute', runId: started.run.id,
      });
      const result = await Promise.race([
        handler({
          automation,
          now,
          trigger,
          slotKey: started.run.slotKey,
          attempt: started.run.attempt,
          previousResult: started.resumed ? started.run.result || {} : {},
          preventiveLessons,
        }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Zeitlimit nach ${automation.timeoutMs} ms überschritten.`)), automation.timeoutMs); }),
      ]);
      const requestedStatus = ['blocked', 'skipped', 'waiting'].includes(result?.status) ? result.status : 'completed';
      const run = await finishAutomationRun(started.run.id, {
        status: requestedStatus,
        summary: result?.summary || (requestedStatus === 'completed' ? 'Automatischer Lauf erfolgreich abgeschlossen.' : requestedStatus === 'waiting' ? 'Automatischer Lauf wartet auf das bestätigte Endergebnis.' : 'Automatischer Lauf nicht ausgeführt.'),
        error: result?.error || '', result: result || {},
      });
      for (const incident of Array.isArray(result?.incidents) ? result.incidents : []) {
        await recordIncident({
          ...incident,
          system: incident.system || 'railway',
          workflowId: incident.workflowId || id,
          action: incident.action || 'automation.run',
          runId: started.run.id,
          source: 'railway-automation',
        });
      }
      for (const prevention of Array.isArray(result?.preventionsApplied) ? result.preventionsApplied : []) {
        await markPreventiveLessonUsed(prevention.fingerprint, {
          runId: started.run.id,
          prevented: prevention.prevented === true,
          evidence: prevention.evidence || result?.summary || '',
        }).catch(() => null);
      }
      return { automationId: id, skipped: requestedStatus === 'skipped', run, result };
    } catch (error) {
      const run = await finishAutomationRun(started.run.id, { status: 'failed', summary: 'Automatischer Lauf fehlgeschlagen.', error: error.message });
      await recordIncident({
        system: 'railway', workflowId: id, action: 'automation.run', step: 'execute', runId: started.run.id,
        source: 'railway-automation', error: error.message, status: 'open', severity: 'high',
      }).catch(() => null);
      throw Object.assign(error, { automationRun: run });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function runDueAutomations(now = new Date()) {
    const due = AUTOMATION_DEFINITIONS.filter(definition => isDue(definition, now));
    const results = [];
    for (const definition of due) {
      try { results.push(await runAutomation(definition.id, { trigger: 'catch-up', now })); }
      catch (error) { results.push({ automationId: definition.id, error: error.message }); }
    }
    return results;
  }

  return { runAutomation, runDueAutomations };
}
