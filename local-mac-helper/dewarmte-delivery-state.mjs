import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

const STATE_DIR = process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper');
const STATE_FILE = path.join(STATE_DIR, 'dewarmte-deliveries.json');
let queue = Promise.resolve();

function clean(value, max = 500) {
  return String(value || '').replace(/\u0000/g, '').trim().slice(0, max);
}

async function load() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    return { version: 1, deliveries: parsed?.deliveries && typeof parsed.deliveries === 'object' ? parsed.deliveries : {} };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { version: 1, deliveries: {} };
  }
}

async function save(state) {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${STATE_FILE}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, STATE_FILE);
}

function transaction(work) {
  const current = queue.then(work);
  queue = current.catch(() => {});
  return current;
}

export async function beginDewarmteDelivery({ jobId, deliveryMode, recipientEmail, fileName }) {
  const id = clean(jobId, 100);
  if (!/^[a-f0-9-]{36}$/i.test(id) || !['email-draft', 'email-send'].includes(deliveryMode)) throw new Error('Ungültiger DeWarmte-Mailauftrag.');
  return transaction(async () => {
    const state = await load();
    const existing = state.deliveries[id];
    if (existing) {
      throw new Error(`DeWarmte-Mail wurde für diesen Auftrag bereits begonnen (${existing.status}). Zur Sicherheit erfolgt kein zweiter Entwurf oder Versand.`);
    }
    const entry = {
      jobId: id,
      deliveryMode,
      recipientEmail: clean(recipientEmail, 320).toLowerCase(),
      fileName: path.basename(clean(fileName, 240)),
      status: deliveryMode === 'email-send' ? 'send-attempting' : 'draft-attempting',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    state.deliveries[id] = entry;
    await save(state);
    return entry;
  });
}

export async function finishDewarmteDelivery(jobId, patch = {}) {
  const id = clean(jobId, 100);
  return transaction(async () => {
    const state = await load();
    const existing = state.deliveries[id];
    if (!existing) throw new Error('DeWarmte-Mailstatus kann ohne vorherigen Start nicht gespeichert werden.');
    const entry = {
      ...existing,
      status: clean(patch.status, 80) || existing.status,
      detail: clean(patch.detail, 700),
      updatedAt: new Date().toISOString(),
    };
    state.deliveries[id] = entry;
    await save(state);
    return entry;
  });
}

export async function readDewarmteDelivery(jobId) {
  return (await load()).deliveries[clean(jobId, 100)] || null;
}
