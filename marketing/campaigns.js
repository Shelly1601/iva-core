// iva-core/marketing/campaigns.js
// Kampagnen-Verwaltung der IVA-Marketing-Maschine.
// Eine Kampagne = ein Marketing-/Vertriebs-Vorhaben pro Marke, mit:
//   - type:          'content' (Posts erzeugen+posten) | 'lead-gen' (Leads -> CRM) | 'ads' (Anzeigen bauen+optimieren)
//   - references:    Referenz-Konten (IG-Handles/URLs), an denen sich IVA orientiert
//   - tone:          Tonalitaet/Strategie in Worten
//   - targetChannel: Ziel-Kanal je nach Typ (CRM-project_id | Social-Handle | Ad-Account-ID)
//   - autonomy:      Trust-Ladder 'observe' -> 'suggest' -> 'auto'
// Mandantenfaehig: beliebig viele Kampagnen, unabhaengig bespielbar.

import fs from 'fs/promises';

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = DATA_DIR + '/marketing.json';

export const TYPES = ['content', 'lead-gen', 'ads', 'email'];
export const AUTONOMY = ['observe', 'suggest', 'auto']; // beobachten -> vorschlagen -> vollautonom

async function load() {
  try { return JSON.parse(await fs.readFile(FILE, 'utf8')); }
  catch { return { campaigns: [] }; }
}
async function save(data) {
  await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  await fs.writeFile(FILE, JSON.stringify(data, null, 2));
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

export async function listCampaigns() {
  return (await load()).campaigns || [];
}
export async function getCampaign(id) {
  return ((await load()).campaigns || []).find(c => c.id === id) || null;
}
export async function createCampaign(input = {}) {
  const data = await load();
  data.campaigns = data.campaigns || [];
  const c = {
    id: uid(),
    name: input.name || 'Neue Kampagne',
    brandId: input.brandId || '',                               // Verknuepfung zur Brand (brands.js)
    brand: input.brand || '',                                   // Klartext-Name (Fallback/Anzeige)
    type: TYPES.includes(input.type) ? input.type : 'content',
    references: Array.isArray(input.references) ? input.references : [],
    tone: input.tone || '',
    targetChannel: input.targetChannel || '',                   // CRM-project_id | Social-Handle | Ad-Account
    autonomy: AUTONOMY.includes(input.autonomy) ? input.autonomy : 'observe',
    analysis: null,                                             // letztes Muster-Profil (aus analyze.js)
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  data.campaigns.push(c);
  await save(data);
  return c;
}
export async function updateCampaign(id, patch = {}) {
  const data = await load();
  const c = (data.campaigns || []).find(x => x.id === id);
  if (!c) return null;
  for (const k of ['name', 'brandId', 'brand', 'type', 'references', 'tone', 'targetChannel', 'autonomy', 'analysis', 'active']) {
    if (k in patch) c[k] = patch[k];
  }
  c.updatedAt = new Date().toISOString();
  await save(data);
  return c;
}
export async function deleteCampaign(id) {
  const data = await load();
  data.campaigns = data.campaigns || [];
  const before = data.campaigns.length;
  data.campaigns = data.campaigns.filter(c => c.id !== id);
  await save(data);
  return data.campaigns.length < before;
}
