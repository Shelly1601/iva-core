import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { initialEnergyData } from './tmb.js';

export const WORKSPACE_MODES = ['beratung', 'kunde', 'energie'];
export const FILE_KINDS = ['floorplan', 'elevation', 'photo', 'tmb-template', 'document', 'audio'];

const DATA_DIR = process.env.DATA_DIR || '/data';
const STORE_FILE = path.join(DATA_DIR, 'workspaces.json');
const FILES_DIR = path.join(DATA_DIR, 'workspace-files');
const MAX_FILE_BYTES = 25 * 1024 * 1024;
let writeQueue = Promise.resolve();

async function loadStore() {
  try {
    const data = JSON.parse(await fs.readFile(STORE_FILE, 'utf8'));
    return { version: 1, workspaces: Array.isArray(data?.workspaces) ? data.workspaces : [] };
  } catch {
    return { version: 1, workspaces: [] };
  }
}

async function saveStore(data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = STORE_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, STORE_FILE);
}

function mutate(fn) {
  const job = writeQueue.then(async () => {
    const data = await loadStore();
    const result = await fn(data);
    await saveStore(data);
    return result;
  });
  writeQueue = job.catch(() => {});
  return job;
}

function cleanText(value, max = 5000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeClone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function mergePlain(base, patch, depth = 0) {
  const out = { ...plainObject(base) };
  if (depth > 5) return out;
  for (const [key, value] of Object.entries(plainObject(patch))) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) out[key] = mergePlain(out[key], value, depth + 1);
    else if (Array.isArray(value)) out[key] = safeClone(value).slice(0, 500);
    else if (['string', 'number', 'boolean'].includes(typeof value) || value === null) out[key] = value;
  }
  return out;
}

function publicWorkspace(workspace) {
  const out = safeClone(workspace);
  out.files = (out.files || []).map(({ storageName, ...file }) => file);
  return out;
}

function initialData(mode) {
  if (mode === 'energie') {
    return initialEnergyData();
  }
  if (mode === 'beratung') return { appointmentAt: '', topic: '', goal: '', facts: '', recommendation: '' };
  return { project: '', company: '', relationship: '', nextStep: '' };
}

export async function listWorkspaces({ mode } = {}) {
  const data = await loadStore();
  return data.workspaces
    .filter(w => !mode || w.mode === mode)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map(publicWorkspace);
}

export async function getWorkspace(id) {
  const workspace = (await loadStore()).workspaces.find(w => w.id === id);
  return workspace ? publicWorkspace(workspace) : null;
}

export async function createWorkspace(input = {}) {
  return mutate(data => {
    const mode = WORKSPACE_MODES.includes(input.mode) ? input.mode : 'beratung';
    const now = new Date().toISOString();
    const customer = plainObject(input.customer);
    const workspace = {
      id: crypto.randomUUID(),
      mode,
      title: cleanText(input.title, 160) || ({ beratung: 'Neue Beratung', kunde: 'Neue Kundenakte', energie: 'Neue Energieplanung' })[mode],
      status: 'draft',
      customer: {
        id: cleanText(customer.id, 160),
        name: cleanText(customer.name, 200),
        email: cleanText(customer.email, 320),
        phone: cleanText(customer.phone, 100),
        address: cleanText(customer.address, 500),
      },
      data: mergePlain(initialData(mode), input.data),
      visit: mergePlain({
        consent: { granted: false, grantedAt: null, method: '' },
        plaud: { recordingId: '', status: 'not-linked', importedAt: null },
      }, input.visit),
      notes: [],
      files: [],
      createdAt: now,
      updatedAt: now,
    };
    data.workspaces.push(workspace);
    return publicWorkspace(workspace);
  });
}

export async function updateWorkspace(id, patch = {}) {
  return mutate(data => {
    const workspace = data.workspaces.find(w => w.id === id);
    if (!workspace) return null;
    if ('title' in patch) workspace.title = cleanText(patch.title, 160) || workspace.title;
    if ('status' in patch && ['draft', 'active', 'review', 'complete'].includes(patch.status)) workspace.status = patch.status;
    if ('customer' in patch) workspace.customer = mergePlain(workspace.customer, patch.customer);
    if ('data' in patch) workspace.data = mergePlain(workspace.data, patch.data);
    if ('visit' in patch) workspace.visit = mergePlain(workspace.visit, patch.visit);
    workspace.updatedAt = new Date().toISOString();
    return publicWorkspace(workspace);
  });
}

export async function addWorkspaceNote(id, text, source = 'manual') {
  return mutate(data => {
    const workspace = data.workspaces.find(w => w.id === id);
    if (!workspace) return null;
    const note = { id: crypto.randomUUID(), text: cleanText(text, 10000), source: cleanText(source, 80) || 'manual', createdAt: new Date().toISOString() };
    if (!note.text) return publicWorkspace(workspace);
    workspace.notes = workspace.notes || [];
    workspace.notes.push(note);
    workspace.updatedAt = note.createdAt;
    return publicWorkspace(workspace);
  });
}

function safeExtension(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

export async function storeWorkspaceFile(id, { name, mime, kind, buffer }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Leere Datei.');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('Datei ist groesser als 25 MB.');
  if (!FILE_KINDS.includes(kind)) throw new Error('Unbekannter Dateityp.');
  const originalName = cleanText(name, 240) || 'datei';
  const fileId = crypto.randomUUID();
  const storageName = fileId + safeExtension(originalName);
  const folder = path.join(FILES_DIR, id);
  const exists = await getWorkspace(id);
  if (!exists) return null;
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, storageName), buffer);
  return mutate(data => {
    const workspace = data.workspaces.find(w => w.id === id);
    if (!workspace) return null;
    const file = {
      id: fileId,
      kind,
      name: originalName,
      mime: cleanText(mime, 160) || 'application/octet-stream',
      bytes: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      storageName,
      createdAt: new Date().toISOString(),
    };
    workspace.files = workspace.files || [];
    workspace.files.push(file);
    workspace.updatedAt = file.createdAt;
    return { ...file, storageName: undefined };
  });
}

export async function readWorkspaceFile(id, fileId) {
  const data = await loadStore();
  const workspace = data.workspaces.find(w => w.id === id);
  const file = workspace?.files?.find(f => f.id === fileId);
  if (!file || !/^[a-f0-9-]+(?:\.[a-z0-9]{1,8})?$/i.test(file.storageName || '')) return null;
  const buffer = await fs.readFile(path.join(FILES_DIR, id, file.storageName));
  return { meta: publicWorkspace({ files: [file] }).files[0], buffer };
}
