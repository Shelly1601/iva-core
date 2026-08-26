import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || '/data';
const STORE_FILE = path.join(DATA_DIR, 'device-commands.json');
const MAX_COMMANDS = 500;
const DEFAULT_TTL_MS = 15 * 60_000;
const LEASE_MS = 5 * 60_000;

export const IVA_IMAC_DEVICE_ID = 'imac-nadine';
export const DEVICE_ACTIONS = Object.freeze({
  'computer.status': Object.freeze({ description: 'Status des iMac-Helfers prüfen', mutating: false }),
  'funding.monitor.status': Object.freeze({ description: 'Fördermonitor-Status prüfen', mutating: false }),
  'funding.monitor.run': Object.freeze({ description: 'Fördermonitor einmal im gesperrten Review-Modus ausführen', mutating: false }),
  'funding.reviews.list': Object.freeze({ description: 'Lokale Förder-Prüfwarteschlange zusammenfassen', mutating: false }),
  'planbar.search.refresh': Object.freeze({ description: 'Sichtbaren Planbar-Terminindex rein lesend aktualisieren', mutating: false }),
  'planbar.customer.schedule': Object.freeze({ description: 'Einen eindeutig belegten Kunden über den lokalen iMac-Workflow in Planbar terminieren', mutating: true }),
  'project.workflow.run': Object.freeze({ description: 'Einen freigegebenen Projekt-Workflow einmalig manuell starten', mutating: true }),
  'portal.credentials.status': Object.freeze({ description: 'Nur die Belegung von IVAs lokalem macOS-Schlüsselbund prüfen', mutating: false }),
  'portal.login': Object.freeze({ description: 'Bei einem vorab freigegebenen Portal mit lokalem Schlüsselbund anmelden', mutating: false }),
  'app.open': Object.freeze({ description: 'Eine freigegebene App auf dem iMac öffnen', mutating: true }),
  'codex.task.start': Object.freeze({ description: 'Einen ausdrücklich beauftragten IVA-Bauauftrag im lokalen Codex starten', mutating: true }),
  'codex.task.status': Object.freeze({ description: 'Status eines lokalen Codex-Bauauftrags lesen', mutating: false }),
});

async function loadStore() {
  try {
    const value = JSON.parse(await fs.readFile(STORE_FILE, 'utf8'));
    return { version: 1, commands: Array.isArray(value.commands) ? value.commands : [] };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { version: 1, commands: [] };
  }
}

async function saveStore(store) {
  await fs.mkdir(path.dirname(STORE_FILE), { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const compact = {
    version: 1,
    commands: store.commands
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .slice(-MAX_COMMANDS),
  };
  try {
    await fs.writeFile(temporary, JSON.stringify(compact, null, 2));
    await fs.rename(temporary, STORE_FILE);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

function cleanText(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function validatePayload(action, payload = {}) {
  if (action === 'planbar.customer.schedule') {
    const customerName = cleanText(payload.customerName, 220);
    const partnerId = cleanText(payload.partnerId, 80).toLowerCase();
    const partnerName = cleanText(payload.partnerName, 80);
    const partnerPrefix = cleanText(payload.partnerPrefix, 6).toUpperCase();
    const schedulingMode = payload.schedulingMode === 'enter-block-first' ? 'enter-block-first' : 'free-resource';
    const allowFreeResourceFallback = schedulingMode === 'enter-block-first' && payload.allowFreeResourceFallback === true;
    const isoYear = Number(payload.isoYear);
    const week = Number(payload.week);
    if (customerName.length < 3) throw new Error('Für die Planbar-Terminierung fehlt der vollständige Kundenname.');
    if (!partnerId || !partnerName || !/^[A-Z0-9]{1,6}$/.test(partnerPrefix)) {
      throw new Error('Für die Planbar-Terminierung fehlt ein gültiger Partner mit Planbar-Kürzel.');
    }
    if (!Number.isInteger(isoYear) || isoYear < 2000 || isoYear > 2100) throw new Error('Ungültiges ISO-Kalenderjahr.');
    if (!Number.isInteger(week) || week < 1 || week > 53) throw new Error('Ungültige ISO-Kalenderwoche.');
    if (typeof payload.materialDeliverySpace !== 'boolean' || typeof payload.theftWeatherProtected !== 'boolean') {
      throw new Error('Die beiden Materialfragen müssen vor der Planbar-Terminierung eindeutig mit Ja oder Nein beantwortet sein.');
    }
    return {
      customerName,
      partnerId,
      partnerName,
      partnerPrefix,
      schedulingMode,
      allowFreeResourceFallback,
      isoYear,
      week,
      materialDeliverySpace: payload.materialDeliverySpace,
      theftWeatherProtected: payload.theftWeatherProtected,
      additionalInfo: cleanText(payload.additionalInfo, 2000),
    };
  }
  if (action === 'project.workflow.run') {
    const projectId = cleanText(payload.projectId, 100);
    const workflowId = cleanText(payload.workflowId, 140);
    const allowed = new Set(['funding-monitor', 'planbar-weekly-export', 'planbar-completion-morning', 'montage-required-fields-morning']);
    if (projectId !== 'heat-hero' || !allowed.has(workflowId)) throw new Error('Dieser Projekt-Workflow ist für den manuellen iMac-Start nicht freigegeben.');
    return { projectId, workflowId, displayName: cleanText(payload.displayName, 220) || workflowId };
  }
  if (action === 'portal.credentials.status' || action === 'portal.login') {
    const service = cleanText(payload.service, 40).toLowerCase();
    if (!['panasonic', 'bosch', 'pipedrive', 'airtable', 'planbar'].includes(service)) {
      throw new Error('Dieser Portalzugang ist für die iMac-Anmeldung nicht freigegeben.');
    }
    return { service };
  }
  if (action === 'app.open') {
    const app = cleanText(payload.app, 80);
    if (!['Microsoft Outlook', 'Google Chrome', 'WhatsApp', 'Codex'].includes(app)) {
      throw new Error('Diese App ist für die iMac-Fernsteuerung nicht freigegeben.');
    }
    return { app };
  }
  if (action === 'codex.task.start') {
    const prompt = cleanText(payload.prompt, 12_000);
    if (prompt.length < 10) throw new Error('Der Codex-Bauauftrag ist zu kurz.');
    return {
      prompt,
      title: cleanText(payload.title || 'IVA-Bauauftrag', 180),
      requestId: cleanText(payload.requestId, 100),
      acceptanceCriteria: (Array.isArray(payload.acceptanceCriteria) ? payload.acceptanceCriteria : [])
        .map(value => cleanText(value, 500)).filter(Boolean).slice(0, 12),
    };
  }
  if (action === 'codex.task.status') {
    const jobId = cleanText(payload.jobId, 80);
    if (!/^[a-f0-9-]{20,80}$/i.test(jobId)) throw new Error('Ungültige Codex-Auftrags-ID.');
    return { jobId };
  }
  return {};
}

export async function enqueueDeviceCommand({ deviceId = IVA_IMAC_DEVICE_ID, action, payload = {}, requestedBy = 'iva', requestText = '' } = {}) {
  const device = cleanText(deviceId, 80);
  const actionName = cleanText(action, 100);
  if (device !== IVA_IMAC_DEVICE_ID) throw new Error('Unbekanntes IVA-Gerät.');
  if (!DEVICE_ACTIONS[actionName]) throw new Error('Diese iMac-Aktion ist nicht freigegeben.');
  const normalizedPayload = validatePayload(actionName, payload);
  const now = new Date();
  const store = await loadStore();
  if (actionName === 'planbar.customer.schedule') {
    const fingerprint = JSON.stringify(normalizedPayload);
    const existing = store.commands.find(item => item.deviceId === device
      && item.action === actionName
      && ['queued', 'running'].includes(item.status)
      && Date.parse(item.expiresAt) > now.getTime()
      && JSON.stringify(item.payload) === fingerprint);
    if (existing) return { ...existing };
  }
  const command = {
    id: crypto.randomUUID(),
    deviceId: device,
    action: actionName,
    payload: normalizedPayload,
    status: 'queued',
    requestedBy: cleanText(requestedBy, 120) || 'iva',
    requestText: cleanText(requestText, 500),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DEFAULT_TTL_MS).toISOString(),
    attempts: 0,
  };
  store.commands.push(command);
  await saveStore(store);
  return command;
}

export async function claimNextDeviceCommand(deviceId = IVA_IMAC_DEVICE_ID) {
  const store = await loadStore();
  const now = Date.now();
  let changed = false;
  for (const command of store.commands) {
    if (command.status === 'queued' && Date.parse(command.expiresAt) <= now) {
      command.status = 'expired';
      command.completedAt = new Date().toISOString();
      changed = true;
    }
    if (command.status === 'running' && Date.parse(command.leaseExpiresAt || 0) <= now) {
      command.status = command.attempts >= 3 ? 'failed' : 'queued';
      delete command.leaseToken;
      delete command.leaseExpiresAt;
      changed = true;
    }
  }
  const command = store.commands.find(item => item.deviceId === deviceId && item.status === 'queued');
  if (!command) {
    if (changed) await saveStore(store);
    return null;
  }
  command.status = 'running';
  command.startedAt = new Date().toISOString();
  command.attempts = Number(command.attempts || 0) + 1;
  command.leaseToken = crypto.randomBytes(24).toString('hex');
  command.leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
  await saveStore(store);
  return { ...command };
}

export async function completeDeviceCommand({ deviceId, commandId, leaseToken, ok, result = null, error = '' } = {}) {
  const store = await loadStore();
  const command = store.commands.find(item => item.id === String(commandId) && item.deviceId === String(deviceId));
  if (!command || command.status !== 'running') throw new Error('Aktiver iMac-Befehl wurde nicht gefunden.');
  if (!leaseToken || leaseToken !== command.leaseToken) throw new Error('iMac-Befehlslease ist ungültig.');
  command.status = ok === true ? 'completed' : 'failed';
  command.completedAt = new Date().toISOString();
  command.result = ok === true ? result : null;
  command.error = ok === true ? null : cleanText(error, 1000);
  delete command.leaseToken;
  delete command.leaseExpiresAt;
  await saveStore(store);
  return { ...command };
}

export async function listDeviceCommands({ deviceId = IVA_IMAC_DEVICE_ID, limit = 50 } = {}) {
  const store = await loadStore();
  return store.commands
    .filter(command => !deviceId || command.deviceId === deviceId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(MAX_COMMANDS, Number(limit) || 50)))
    .map(({ leaseToken, ...command }) => command);
}

export async function deviceCommandStatus(commandId) {
  const store = await loadStore();
  const command = store.commands.find(item => item.id === String(commandId));
  if (!command) return null;
  const { leaseToken, ...safe } = command;
  return safe;
}
