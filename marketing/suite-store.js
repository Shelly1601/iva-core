import fs from 'fs/promises';

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = DATA_DIR + '/marketing-suite.json';
const COLLECTIONS = new Set(['researchRuns', 'companies', 'contentPlans', 'emailCampaigns', 'adSnapshots', 'reports']);
let mutationQueue = Promise.resolve();

function emptyStore() {
  return { version: 1, researchRuns: [], companies: [], contentPlans: [], emailCampaigns: [], adSnapshots: [], reports: [] };
}

async function load() {
  try {
    const data = JSON.parse(await fs.readFile(FILE, 'utf8'));
    const clean = { ...emptyStore(), ...data };
    for (const key of COLLECTIONS) if (!Array.isArray(clean[key])) clean[key] = [];
    return clean;
  } catch {
    return emptyStore();
  }
}

async function save(data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, FILE);
}

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function assertCollection(collection) {
  if (!COLLECTIONS.has(collection)) throw new Error(`Unbekannte Marketing-Sammlung: ${collection}`);
}

export async function listSuiteItems(collection, { limit = 100, campaignId = '', status = '' } = {}) {
  assertCollection(collection);
  const data = await load();
  return data[collection]
    .filter(item => !campaignId || item.campaignId === campaignId)
    .filter(item => !status || item.status === status)
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
    .slice(0, Math.max(1, Math.min(1000, Number(limit) || 100)));
}

export async function getSuiteItem(collection, itemId) {
  assertCollection(collection);
  return (await load())[collection].find(item => item.id === itemId) || null;
}

export async function createSuiteItem(collection, input = {}) {
  assertCollection(collection);
  let result;
  const mutation = mutationQueue.catch(() => {}).then(async () => {
    const data = await load();
    const now = new Date().toISOString();
    result = { ...input, id: id(collection.replace(/[A-Z].*$/, '').slice(0, 8) || 'mkt'), createdAt: now, updatedAt: now };
    data[collection].push(result);
    if (data[collection].length > 5000) data[collection] = data[collection].slice(-5000);
    await save(data);
  });
  mutationQueue = mutation.catch(() => {});
  await mutation;
  return result;
}

export async function updateSuiteItem(collection, itemId, patch = {}) {
  assertCollection(collection);
  let result = null;
  const mutation = mutationQueue.catch(() => {}).then(async () => {
    const data = await load();
    const item = data[collection].find(entry => entry.id === itemId);
    if (!item) return;
    Object.assign(item, patch, { id: item.id, createdAt: item.createdAt, updatedAt: new Date().toISOString() });
    result = { ...item };
    await save(data);
  });
  mutationQueue = mutation.catch(() => {});
  await mutation;
  return result;
}

export async function suiteCounts() {
  const data = await load();
  return Object.fromEntries([...COLLECTIONS].map(key => [key, data[key].length]));
}
