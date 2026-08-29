import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = `${DATA_DIR}/automation-control.json`;
const RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const STALE_RUN_GRACE_MS = 60_000;
let writeQueue = Promise.resolve();

export const AUTOMATION_DEFINITIONS = Object.freeze([
  { id: 'report-email-daily', name: 'Täglicher Workflow-Report: E-Mail mit Telegram-Ersatz', category: 'Reporting', schedule: 'Täglich · 06:45 Uhr', cron: '45 6 * * *', cadence: 'daily', hour: 6, minute: 45, defaultEnabled: true, maxSlotAttempts: 3, timeoutMs: 30_000, description: 'Sendet den Vortagsreport bevorzugt per E-Mail an Nadines HeatHero-Postfach; bei nicht möglicher E-Mail-Zustellung folgt genau ein Telegram-Ersatzreport.' },
  { id: 'report-email-weekly', name: 'Wöchentlicher Workflow-Report: E-Mail mit Telegram-Ersatz', category: 'Reporting', schedule: 'Montag · 06:50 Uhr', cron: '50 6 * * 1', cadence: 'weekly', weekday: 1, hour: 6, minute: 50, defaultEnabled: true, maxSlotAttempts: 3, timeoutMs: 30_000, description: 'Sendet den Wochenreport bevorzugt per E-Mail; bei nicht möglicher E-Mail-Zustellung folgt genau ein Telegram-Ersatzreport.' },
  { id: 'funding-daily-sequence', name: 'Förderung – Tageslauf 1 → 2 → 3 auf dem iMac', category: 'Heat Hero', schedule: 'Täglich · 05:00 Uhr', cron: '0 5 * * *', cadence: 'daily', hour: 5, minute: 0, defaultEnabled: true, maxSlotAttempts: 6, timeoutMs: 120_000, description: 'Führt den geordneten iMac-Auftrag für Vollständigkeit, Förderhöhe und KfW-Zusagen aus und bleibt bis zum echten lokalen Endstatus offen. Verpasste Slots werden nachgeholt.' },
  { id: 'planbar-weekly-export', name: 'Planbar-Forecast als Excel-Listen', category: 'Heat Hero', schedule: 'Freitag · 18:00 Uhr', cron: '0 18 * * 5', cadence: 'weekly', weekday: 5, hour: 18, minute: 0, defaultEnabled: true, maxSlotAttempts: 6, timeoutMs: 120_000, description: 'Erstellt den rollierenden Zehn-Wochen-Forecast auf dem iMac und gilt erst nach verifiziertem Outlook-Versand als erfolgreich. Pro Freitags-Slot gibt es höchstens einen automatischen Versand; manuelle Läufe werden getrennt protokolliert.' },
  { id: 'montage-required-fields-morning', name: 'Montage-Pflichtfelder morgens prüfen', category: 'Heat Hero', schedule: 'Täglich · 07:00 Uhr', cron: '0 7 * * *', cadence: 'daily', hour: 7, minute: 0, defaultEnabled: true, maxSlotAttempts: 6, timeoutMs: 120_000, description: 'Prüft offene Montage-Deals auf dem iMac und bleibt bis zum echten lokalen Endstatus offen. Verpasste Slots werden nachgeholt.' },
  { id: 'planbar-completion-morning', name: 'Planbar Vervollständigung', category: 'Heat Hero', schedule: 'Täglich · 08:00 Uhr', cron: '0 8 * * *', cadence: 'daily', hour: 8, minute: 0, defaultEnabled: true, maxSlotAttempts: 6, timeoutMs: 120_000, description: 'Vervollständigt bestehende Planbar-Termine auf dem iMac und bleibt bis zum echten lokalen Endstatus offen. Verpasste Slots werden nachgeholt.' },
  { id: 'daily-briefing', name: 'IVA Morning-Briefing', category: 'Kommunikation', schedule: 'Täglich · 07:00 Uhr', cron: '0 7 * * *', cadence: 'daily', hour: 7, minute: 0, defaultEnabled: true, maxSlotAttempts: 2, timeoutMs: 120_000, description: 'Termine, Todos und CRM-Handlungsbedarf als täglicher Telegram-Überblick.' },
  { id: 'marketing-morning-report', name: 'Marketing-Morgenreport', category: 'Marketing', schedule: 'Täglich · 07:10 Uhr', cron: '10 7 * * *', cadence: 'daily', hour: 7, minute: 10, defaultEnabled: true, maxSlotAttempts: 2, timeoutMs: 60_000, description: 'Erzeugt den aktuellen Marketing-Entscheidungsreport und stellt ihn separat per Telegram zu.' },
  { id: 'heat-hero-too-often-replies', name: 'HeatHero-Rückmeldungen „Zu oft n.e.“', category: 'Kunden & CRM', schedule: 'Täglich · 08:15 Uhr', cron: '15 8 * * *', cadence: 'daily', hour: 8, minute: 15, defaultEnabled: true, maxSlotAttempts: 2, timeoutMs: 300_000, description: 'Liest Kundenantworten aus dem Gmail-Label, reklamiert eindeutige Absagen im eigenständigen großen HeatHero CRM mit Sonstiges-Anmerkung und Mail-PDF oder setzt konkrete Rückrufwünsche als Wiedervorlage an den Setter.' },
  { id: 'report-telegram-morning', name: 'Separater Workflow-Report per Telegram', category: 'Reporting', schedule: 'Täglich · 07:20 Uhr', cron: '20 7 * * *', cadence: 'daily', hour: 7, minute: 20, defaultEnabled: false, maxSlotAttempts: 3, timeoutMs: 30_000, description: 'Zusätzlicher Telegram-Direktreport; standardmäßig aus, weil Telegram bereits automatisch einspringt, wenn der bevorzugte E-Mail-Versand scheitert.' },
  { id: 'opportunity-weekly', name: 'Chancenradar-Wochenlauf', category: 'Chancenradar', schedule: 'Montag · 08:30 Uhr', cron: '30 8 * * 1', cadence: 'weekly', weekday: 1, hour: 8, minute: 30, defaultEnabled: true, maxSlotAttempts: 2, timeoutMs: 300_000, description: 'Sammelt öffentliche Signale, bewertet Chancen und sendet den Wochenpitch höchstens einmal je Kalenderwoche.' },
  { id: 'integration-checkup-monthly', name: 'Monatlicher KI- & Integrations-Check-up', category: 'Systempflege', schedule: 'Am 1. des Monats · 09:00 Uhr', cron: '0 9 1 * *', cadence: 'monthly', day: 1, hour: 9, minute: 0, defaultEnabled: true, maxSlotAttempts: 3, timeoutMs: 180_000, description: 'Prüft KI-Modelle und wichtige externe Dienste, ersetzt ein abgeschaltetes Gemini-Flash-Modell nach erfolgreichem Live-Test automatisch und meldet das Ergebnis per Telegram.' },
  { id: 'crm-qonekto-sync', name: 'CRM → Qonekto Abgleich', category: 'Kunden & CRM', schedule: 'Alle 5 Minuten', cron: '*/5 * * * *', cadence: 'interval', intervalMinutes: 5, defaultEnabled: false, maxSlotAttempts: 1, timeoutMs: 180_000, description: 'Gleicht freigegebene Strategiegespräch-Kunden über den bestehenden engen Qonekto-Automationsweg ab.' },
  { id: 'project-protocol-daily', name: 'Projekt-Tagesprotokolle', category: 'Projekte', schedule: 'Täglich · 23:55 Uhr', cron: '55 23 * * *', cadence: 'daily', hour: 23, minute: 55, defaultEnabled: true, maxSlotAttempts: 3, timeoutMs: 120_000, description: 'Verdichtet die gemeldeten Workflow-Ergebnisse zu Tagesprotokollen und markiert fehlende Läufe.' },
  { id: 'project-protocol-weekly', name: 'Projekt-Wochenprotokolle', category: 'Projekte', schedule: 'Sonntag · 23:58 Uhr', cron: '58 23 * * 0', cadence: 'weekly', weekday: 0, hour: 23, minute: 58, defaultEnabled: true, maxSlotAttempts: 3, timeoutMs: 120_000, description: 'Finalisiert den Wochenüberblick genau einmal je Kalenderwoche.' },
  { id: 'project-protocol-cleanup', name: 'Protokoll-Aufbewahrung bereinigen', category: 'Projekte', schedule: 'Täglich · 00:20 Uhr', cron: '20 0 * * *', cadence: 'daily', hour: 0, minute: 20, defaultEnabled: true, maxSlotAttempts: 3, timeoutMs: 120_000, description: 'Entfernt abgelaufene Tages- und Wochenprotokolle nach den hinterlegten Fristen.' },
]);

const clean = (value, max = 2000) => String(value ?? '').trim().slice(0, max);
const clone = value => structuredClone(value);

function compactResult(value) {
  if (!value || typeof value !== 'object') return {};
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= 12_000) return JSON.parse(serialized);
    return { truncated: true, preview: serialized.slice(0, 11_500) };
  } catch {
    return { truncated: true, preview: '[Ergebnis konnte nicht serialisiert werden]' };
  }
}

function emptyStore() {
  return { version: 1, overrides: {}, runs: [], reports: [], deliveries: [] };
}

async function load() {
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, 'utf8'));
    return {
      ...emptyStore(), ...parsed, version: 1,
      overrides: parsed.overrides && typeof parsed.overrides === 'object' ? parsed.overrides : {},
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      reports: Array.isArray(parsed.reports) ? parsed.reports : [],
      deliveries: Array.isArray(parsed.deliveries) ? parsed.deliveries : [],
    };
  } catch { return emptyStore(); }
}

async function save(store) {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, FILE);
}

async function mutate(action) {
  let result;
  const job = writeQueue.catch(() => {}).then(async () => {
    const store = await load();
    result = await action(store);
    const cutoff = Date.now() - RETENTION_MS;
    store.runs = store.runs.filter(item => Date.parse(item.startedAt || 0) >= cutoff).slice(-5000);
    store.reports = store.reports.filter(item => Date.parse(item.createdAt || 0) >= cutoff).slice(-500);
    store.deliveries = store.deliveries.filter(item => Date.parse(item.createdAt || 0) >= cutoff).slice(-3000);
    await save(store);
  });
  writeQueue = job.catch(() => {});
  await job;
  return result;
}

export function automationDefinition(id) {
  return AUTOMATION_DEFINITIONS.find(item => item.id === clean(id, 100)) || null;
}

export async function listAutomations() {
  const store = await load();
  return AUTOMATION_DEFINITIONS.map(definition => {
    const override = store.overrides[definition.id] || {};
    const runs = store.runs.filter(item => item.automationId === definition.id);
    const lastRun = runs.slice().sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0] || null;
    return { ...clone(definition), enabled: override.enabled ?? definition.defaultEnabled, updatedAt: override.updatedAt || '', lastRun: lastRun ? clone(lastRun) : null };
  });
}

export async function getAutomation(id) {
  return (await listAutomations()).find(item => item.id === clean(id, 100)) || null;
}

export async function setAutomationEnabled(id, enabled) {
  const definition = automationDefinition(id);
  if (!definition) throw new Error('Automation nicht gefunden.');
  return mutate(store => {
    const now = new Date().toISOString();
    store.overrides[definition.id] = { ...(store.overrides[definition.id] || {}), enabled: enabled === true, updatedAt: now };
    return { ...clone(definition), enabled: enabled === true, updatedAt: now };
  });
}

export async function beginAutomationRun(automationId, input = {}) {
  const definition = automationDefinition(automationId);
  if (!definition) throw new Error('Automation nicht gefunden.');
  return mutate(store => {
    const nowMs = Date.now();
    const completedAt = new Date(nowMs).toISOString();
    for (const run of store.runs) {
      if (run.status !== 'running') continue;
      const runDefinition = automationDefinition(run.automationId);
      const timeoutMs = Math.max(30_000, Number(runDefinition?.timeoutMs) || 300_000);
      const startedAtMs = Date.parse(run.startedAt || '');
      if (!Number.isFinite(startedAtMs) || startedAtMs + timeoutMs + STALE_RUN_GRACE_MS >= nowMs) continue;
      run.status = 'failed';
      run.summary = 'Automationslauf nach Serverneustart als abgebrochen erkannt.';
      run.error = `Der Lauf blieb länger als ${Math.ceil((timeoutMs + STALE_RUN_GRACE_MS) / 1000)} Sekunden ohne Abschluss und wurde für einen sicheren Wiederholungsversuch freigegeben.`;
      run.result = {};
      run.completedAt = completedAt;
      run.durationMs = Math.max(0, nowMs - startedAtMs);
    }
    const slotKey = clean(input.slotKey, 160);
    const sameSlot = store.runs.filter(item => item.automationId === definition.id && slotKey && item.slotKey === slotKey);
    const waiting = sameSlot.find(item => item.status === 'waiting');
    if (waiting) {
      waiting.status = 'running';
      waiting.updatedAt = completedAt;
      return { duplicate: false, resumed: true, exhausted: false, run: clone(waiting) };
    }
    const existing = sameSlot.find(item => ['running', 'completed', 'blocked', 'skipped'].includes(item.status));
    if (existing) return { duplicate: true, exhausted: false, run: clone(existing) };
    if (sameSlot.length >= Number(definition.maxSlotAttempts || 1)) {
      return { duplicate: true, exhausted: true, run: clone(sameSlot.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0]) };
    }
    const now = new Date().toISOString();
    const run = {
      id: crypto.randomUUID(), automationId: definition.id, automationName: definition.name,
      slotKey, trigger: clean(input.trigger || 'schedule', 80), attempt: sameSlot.length + 1,
      status: 'running', summary: '', error: '', startedAt: now, completedAt: '', durationMs: null,
    };
    store.runs.push(run);
    return { duplicate: false, exhausted: false, run: clone(run) };
  });
}

export async function finishAutomationRun(runId, input = {}) {
  return mutate(store => {
    const run = store.runs.find(item => item.id === clean(runId, 100));
    if (!run) return null;
    const completedAt = new Date().toISOString();
    run.status = ['completed', 'failed', 'blocked', 'skipped', 'waiting'].includes(input.status) ? input.status : 'completed';
    run.summary = clean(input.summary || 'Lauf abgeschlossen.', 4000);
    run.error = run.status === 'failed' || run.status === 'blocked' ? clean(input.error, 1200) : '';
    run.result = compactResult(input.result);
    run.updatedAt = completedAt;
    run.completedAt = run.status === 'waiting' ? '' : completedAt;
    run.durationMs = run.status === 'waiting' ? null : Math.max(0, Date.parse(completedAt) - Date.parse(run.startedAt));
    return clone(run);
  });
}

export async function skipAutomationSlot(automationId, slotKey, reason = '') {
  const definition = automationDefinition(automationId);
  const normalizedSlotKey = clean(slotKey, 160);
  if (!definition || !normalizedSlotKey) throw new Error('Automation oder Slot fehlt.');
  return mutate(store => {
    const existing = store.runs.find(item => item.automationId === definition.id
      && item.slotKey === normalizedSlotKey && ['completed', 'skipped'].includes(item.status));
    if (existing) return clone(existing);
    const now = new Date().toISOString();
    const run = {
      id: crypto.randomUUID(), automationId: definition.id, automationName: definition.name,
      slotKey: normalizedSlotKey, trigger: 'manual-safety-skip', attempt: 0,
      status: 'skipped',
      summary: clean(reason || 'Slot wurde ausdrücklich ohne erneuten Versand abgeschlossen.', 4000),
      error: '', result: { userConfirmedAlreadyDelivered: true },
      startedAt: now, updatedAt: now, completedAt: now, durationMs: 0,
    };
    store.runs.push(run);
    return clone(run);
  });
}

export async function listAutomationRuns({ automationId = '', status = '', limit = 100, since = '' } = {}) {
  const store = await load();
  return store.runs
    .filter(item => !automationId || item.automationId === automationId)
    .filter(item => !status || item.status === status)
    .filter(item => !since || String(item.startedAt) >= String(since))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, Math.max(1, Math.min(1000, Number(limit) || 100))).map(clone);
}

export async function saveAutomationReport(input = {}) {
  return mutate(store => {
    const key = clean(input.key, 220);
    const existing = store.reports.find(item => item.key === key);
    if (existing) return clone(existing);
    const report = {
      id: crypto.randomUUID(), key, type: input.type === 'weekly' ? 'weekly' : 'daily', periodKey: clean(input.periodKey, 100),
      title: clean(input.title, 300), text: clean(input.text, 30_000), html: clean(input.html, 80_000),
      counts: input.counts && typeof input.counts === 'object' ? clone(input.counts) : {}, createdAt: new Date().toISOString(),
    };
    store.reports.push(report);
    return clone(report);
  });
}

export async function listAutomationReports({ type = '', limit = 30 } = {}) {
  const store = await load();
  return store.reports.filter(item => !type || item.type === type)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 30))).map(clone);
}

export async function successfulDelivery(dedupeKey) {
  const key = clean(dedupeKey, 260);
  return clone((await load()).deliveries.find(item => item.dedupeKey === key && item.status === 'delivered') || null);
}

export async function recordAutomationDelivery(input = {}) {
  return mutate(store => {
    const item = {
      id: crypto.randomUUID(), dedupeKey: clean(input.dedupeKey, 260), reportKey: clean(input.reportKey, 220),
      channel: clean(input.channel, 50), recipient: clean(input.recipient, 320), provider: clean(input.provider, 80),
      status: input.status === 'delivered' ? 'delivered' : 'failed', providerId: clean(input.providerId, 300),
      error: clean(input.error, 1200), createdAt: new Date().toISOString(),
    };
    store.deliveries.push(item);
    return clone(item);
  });
}

export async function automationSummary() {
  const [automations, runs, reports] = await Promise.all([listAutomations(), listAutomationRuns({ limit: 1000 }), listAutomationReports({ limit: 100 })]);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
  return {
    enabled: automations.filter(item => item.enabled).length,
    disabled: automations.filter(item => !item.enabled).length,
    running: runs.filter(item => item.status === 'running').length,
    waiting: runs.filter(item => item.status === 'waiting').length,
    failedToday: runs.filter(item => item.status === 'failed' && new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(item.startedAt)) === today).length,
    reports: reports.length,
  };
}
