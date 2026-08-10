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
  'app.open': Object.freeze({ description: 'Eine freigegebene App auf dem iMac öffnen', mutating: true }),
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
  if (action === 'app.open') {
    const app = cleanText(payload.app, 80);
    if (!['Microsoft Outlook', 'Google Chrome', 'WhatsApp', 'Codex'].includes(app)) {
      throw new Error('Diese App ist für die iMac-Fernsteuerung nicht freigegeben.');
    }
    return { app };
  }
  return {};
}

export async function enqueueDeviceCommand({ deviceId = IVA_IMAC_DEVICE_ID, action, payload = {}, requestedBy = 'iva', requestText = '' } = {}) {
  const device = cleanText(deviceId, 80);
  const actionName = cleanText(action, 100);
  if (device !== IVA_IMAC_DEVICE_ID) throw new Error('Unbekanntes IVA-Gerät.');
  if (!DEVICE_ACTIONS[actionName]) throw new Error('Diese iMac-Aktion ist nicht freigegeben.');
  const now = new Date();
  const command = {
    id: crypto.randomUUID(),
    deviceId: device,
    action: actionName,
    payload: validatePayload(actionName, payload),
    status: 'queued',
    requestedBy: cleanText(requestedBy, 120) || 'iva',
    requestText: cleanText(requestText, 500),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DEFAULT_TTL_MS).toISOString(),
    attempts: 0,
  };
  const store = await loadStore();
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
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
    .map(({ leaseToken, ...command }) => command);
}

export async function deviceCommandStatus(commandId) {
  const store = await loadStore();
  const command = store.commands.find(item => item.id === String(commandId));
  if (!command) return null;
  const { leaseToken, ...safe } = command;
  return safe;
}
