// iva-core/marketing/brands.js
// Brand-Profile = Fundament der Marketing-Suite.
// Eine Marke pro Eintrag: eigene Marke (type 'own') oder Referenz-/Vorbild-Marke ('reference').
// Felder: name, website, instagram, linkedin, colors[] (Designfarben), tone (Tonalitaet), audience (Zielgruppe).
// Speicherung: /data/marketing.json (gemeinsam mit Kampagnen, eigener Schluessel 'brands' -
// beide Module lesen/schreiben die ganze Datei, stoeren sich also nicht).

import fs from 'fs/promises';

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = DATA_DIR + '/marketing.json';

export const BRAND_TYPES = ['own', 'reference'];

async function load() {
  try { return JSON.parse(await fs.readFile(FILE, 'utf8')); } catch { return {}; }
}
async function save(data) {
  await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  await fs.writeFile(FILE, JSON.stringify(data, null, 2));
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

export async function listBrands() {
  return (await load()).brands || [];
}
export async function getBrand(id) {
  return ((await load()).brands || []).find(b => b.id === id) || null;
}
export async function createBrand(input = {}) {
  const data = await load();
  data.brands = data.brands || [];
  const b = {
    id: uid(),
    name: input.name || 'Neue Marke',
    type: BRAND_TYPES.includes(input.type) ? input.type : 'own',
    website: input.website || '',
    instagram: input.instagram || '',
    linkedin: input.linkedin || '',
    colors: Array.isArray(input.colors) ? input.colors : [],   // z.B. ['#0e1b30', '#4f8ff7']
    tone: input.tone || '',
    audience: input.audience || '',
    notes: input.notes || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  data.brands.push(b);
  await save(data);
  return b;
}
export async function updateBrand(id, patch = {}) {
  const data = await load();
  const b = (data.brands || []).find(x => x.id === id);
  if (!b) return null;
  for (const k of ['name', 'type', 'website', 'instagram', 'linkedin', 'colors', 'tone', 'audience', 'notes']) {
    if (k in patch) b[k] = patch[k];
  }
  b.updatedAt = new Date().toISOString();
  await save(data);
  return b;
}
export async function deleteBrand(id) {
  const data = await load();
  const before = (data.brands || []).length;
  data.brands = (data.brands || []).filter(b => b.id !== id);
  await save(data);
  return (data.brands || []).length < before;
}
