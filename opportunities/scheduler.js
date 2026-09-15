import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getOpportunitySettings } from './store.js';
import { runOpportunityScout } from './scout.js';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const FILE = /^\d{4}-\d{2}-\d{2}-(?:daily|weekly)\.json$/;
const queues = new Map();
const fail = message => new Error(message);
function berlinTime(timestamp) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, time: `${parts.hour}:${parts.minute}`, dayIndex: (new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7 };
}
function shifted(date, count) { const value = new Date(date + 'T12:00:00Z'); value.setUTCDate(value.getUTCDate() + count); return value.toISOString().slice(0, 10); }
export function opportunityScheduleSlot(settings, timestamp = Date.now()) {
  if (settings?.weeklyEnabled !== true) return null;
  const cadence = settings.cadence === 'weekly' ? 'weekly' : 'daily';
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(settings.weeklyTime || '') ? settings.weeklyTime : '08:30';
  const local = berlinTime(timestamp);
  let date = local.date;
  if (cadence === 'weekly') {
    const day = DAYS.indexOf(settings.weeklyDay);
    if (day < 0) throw fail('Ungültiger Wochentag im Chancenradar.');
    if (local.dayIndex < day || local.dayIndex === day && local.time < time) return null;
    date = shifted(local.date, day - local.dayIndex);
  } else if (local.time < time) return null;
  return { id: `${date}-${cadence}`, date, cadence, time, timeZone: 'Europe/Berlin', scheduledLocal: `${date} ${time}` };
}
function nextLocal(settings, timestamp) {
  if (settings?.weeklyEnabled !== true) return null;
  const local = berlinTime(timestamp), time = /^([01]\d|2[0-3]):[0-5]\d$/.test(settings.weeklyTime || '') ? settings.weeklyTime : '08:30';
  let days = settings.cadence === 'weekly' ? (DAYS.indexOf(settings.weeklyDay) - local.dayIndex + 7) % 7 : 0;
  if (days === 0 && local.time >= time) days = settings.cadence === 'weekly' ? 7 : 1;
  return `${shifted(local.date, days)} ${time}`;
}

/** One durable, exclusive claim per scheduled local date. Manual scans have no quota. */
export function createOpportunityScheduler({ dataDir = process.env.DATA_DIR || '/data', getSettings = getOpportunitySettings, runScout = runOpportunityScout, now = () => Date.now(), autoStart = true, timeoutMs = 360000, intervalMs = 60000, onProgress = async () => {} } = {}) {
  const directory = path.resolve(dataDir, 'opportunity-schedule');
  const owner = randomUUID();
  let timer = null, active = null, stopped = false, controller = null, lastError = null;
  const timeout = Math.max(1, Math.min(3600000, Number(timeoutMs) || 360000));
  async function safeDirectory() {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('Der Scheduler-Speicher ist nicht sicher zugänglich.');
  }
  async function read(filename) {
    if (!FILE.test(filename)) throw fail('Ungültiger Scheduler-Dateiname.');
    const handle = await fs.open(path.join(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat(); if (!stat.isFile() || stat.size > 65536) throw fail('Ungültiger Scheduler-Speicher.');
      const data = JSON.parse(await handle.readFile('utf8'));
      if (!data || data.id + '.json' !== filename || !['running', 'complete', 'failed', 'interrupted', 'skipped'].includes(data.status)) throw fail('Scheduler-Status ist beschädigt.');
      return data;
    } finally { await handle.close(); }
  }
  async function write(record) {
    const filename = record.id + '.json';
    const current = await read(filename);
    if (current.owner !== owner) throw fail('Ein anderer Scheduler besitzt diesen Termin.');
    const temporary = path.join(directory, filename + '.' + randomUUID() + '.tmp');
    try { await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, path.join(directory, filename)); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  async function history() {
    await safeDirectory();
    const names = (await fs.readdir(directory)).filter(name => FILE.test(name)).sort().reverse();
    const rows = [];
    for (const name of names.slice(0, 200)) {
      const row = await read(name);
      if (row.status === 'running' && row.owner !== owner && Date.parse(row.deadlineAt) <= now()) rows.push({ ...row, status: 'interrupted', error: 'Früherer Lauf endete ohne Abschluss. Dieser Termin wird nicht automatisch wiederholt.' });
      else rows.push(row);
    }
    return rows;
  }
  async function claim(slot) {
    await safeDirectory();
    const record = { ...slot, owner, status: 'running', startedAt: new Date(now()).toISOString(), deadlineAt: new Date(now() + timeout).toISOString(), completedAt: null, runId: null, error: null };
    try { await fs.writeFile(path.join(directory, slot.id + '.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 }); return record; }
    catch (error) { if (error.code === 'EEXIST') return null; throw error; }
  }
  async function execute() {
    if (stopped) return { status: 'stopped' };
    const settings = await getSettings(), slot = opportunityScheduleSlot(settings, now());
    if (!slot) return { status: 'not-due', nextScheduledLocal: nextLocal(settings, now()), timeZone: 'Europe/Berlin' };
    const record = await claim(slot);
    if (!record) return { status: 'already-claimed', slot, message: 'Dieser Termin ist bereits gestartet oder abgeschlossen; kein automatischer Doppelstart.' };
    const fresh = await getSettings();
    if (stopped || opportunityScheduleSlot(fresh, now())?.id !== slot.id || fresh.weeklyTime !== settings.weeklyTime || fresh.weeklyDay !== settings.weeklyDay) {
      Object.assign(record, { status: 'skipped', error: 'Zeitplan wurde vor dem Start geändert.', completedAt: new Date(now()).toISOString() }); await write(record); return record;
    }
    controller = new AbortController();
    let abortTimer, abort;
    try {
      const deadline = new Promise((_, reject) => {
        abort = () => reject(controller.signal.reason || new Error('Scheduler abgebrochen.'));
        controller.signal.addEventListener('abort', abort, { once: true });
        abortTimer = setTimeout(() => controller.abort(new Error('Chancenradar-Zeitlimit erreicht.')), timeout); abortTimer.unref?.();
      });
      const result = await Promise.race([Promise.resolve().then(() => runScout({ trigger: `scheduled-${slot.cadence}` }, { signal: controller.signal, onProgress })), deadline]);
      if (controller.signal.aborted) throw controller.signal.reason;
      Object.assign(record, { status: 'complete', runId: result?.run?.id || null, completedAt: new Date(now()).toISOString(), summary: `${Number(result?.run?.sourceCount) || 0} Quellen, ${Number(result?.opportunities?.length ?? result?.run?.ideaCount) || 0} Ideen; kein Nachrichtenversand.` });
      await write(record); lastError = null;
      return record;
    } catch (error) {
      Object.assign(record, { status: controller.signal.aborted ? 'interrupted' : 'failed', error: controller.signal.aborted ? 'Scan abgebrochen oder Zeitlimit erreicht. Kein automatischer Neustart dieses Termins.' : 'Der geplante Scan konnte nicht abgeschlossen werden. Details stehen beim Scan; keine automatische Wiederholung.', completedAt: new Date(now()).toISOString(), runId: typeof error.runId === 'string' ? error.runId : record.runId });
      await write(record); lastError = record.error;
      return record;
    } finally { clearTimeout(abortTimer); if (abort) controller.signal.removeEventListener('abort', abort); controller = null; }
  }
  async function tick() {
    if (active) return active;
    // Shared process lock avoids simultaneous checks; the exclusive file also
    // protects against another process or a freshly started instance.
    const previous = queues.get(directory) || Promise.resolve();
    const pending = previous.catch(() => {}).then(execute); queues.set(directory, pending); active = pending;
    try { return await pending; }
    finally { if (queues.get(directory) === pending) queues.delete(directory); if (active === pending) active = null; }
  }
  async function status() {
    const settings = await getSettings(), rows = await history();
    return { enabled: settings.weeklyEnabled === true, cadence: settings.cadence || 'daily', time: settings.weeklyTime, day: settings.weeklyDay, timeZone: 'Europe/Berlin', nextScheduledLocal: nextLocal(settings, now()), dueSlot: opportunityScheduleSlot(settings, now()), running: Boolean(active), lastError, runs: rows.slice(0, 30).map(({ owner: _owner, ...row }) => row), telegram: false, manualScansLimited: false };
  }
  async function loop() { if (stopped) return; try { await tick(); } catch { lastError = 'Scheduler-Speicher oder Einstellungen konnten nicht geprüft werden.'; } finally { if (!stopped) { timer = setTimeout(loop, Math.max(1000, Number(intervalMs) || 60000)); timer.unref?.(); } } }
  if (autoStart) { timer = setTimeout(loop, 1000); timer.unref?.(); }
  return { tick, status, close() { stopped = true; clearTimeout(timer); controller?.abort(new Error('Scheduler wurde beendet.')); } };
}
