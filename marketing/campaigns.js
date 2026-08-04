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

function whatsappConfig(input = {}, current = {}) {
  return {
    enabled: input.enabled === undefined ? (current.enabled ?? false) : input.enabled === true,
    profileId: String(input.profileId ?? current.profileId ?? '').trim().slice(0, 120),
    mode: ['lead', 'service', 'hybrid'].includes(input.mode) ? input.mode : (current.mode || 'lead'),
    appointmentUrl: String(input.appointmentUrl ?? current.appointmentUrl ?? '').trim().slice(0, 1000),
  };
}

function campaignConfig(input = {}, current = {}) {
  const channels = Array.isArray(input.channels) ? input.channels : (current.channels || []);
  return {
    objective: String(input.objective ?? current.objective ?? '').trim().slice(0, 2000),
    channels: [...new Set(channels.map(value => String(value).trim()).filter(Boolean))].slice(0, 12),
    researchRunId: String(input.researchRunId ?? current.researchRunId ?? '').trim().slice(0, 120),
    schedule: String(input.schedule ?? current.schedule ?? '').trim().slice(0, 300),
    budgetCap: Math.max(0, Number(input.budgetCap ?? current.budgetCap ?? 0) || 0),
    approvalRequired: input.approvalRequired === undefined ? (current.approvalRequired ?? true) : input.approvalRequired !== false,
  };
}

export async function listCampaigns() {
  return ((await load()).campaigns || []).map(campaign => ({ ...campaign, whatsapp: whatsappConfig(campaign.whatsapp), config: campaignConfig(campaign.config) }));
}
export async function getCampaign(id) {
  const campaign = ((await load()).campaigns || []).find(c => c.id === id) || null;
  return campaign ? { ...campaign, whatsapp: whatsappConfig(campaign.whatsapp), config: campaignConfig(campaign.config) } : null;
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
    whatsapp: whatsappConfig(input.whatsapp),
    config: campaignConfig(input.config || input),
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
  if ('whatsapp' in patch) c.whatsapp = whatsappConfig(patch.whatsapp, c.whatsapp);
  if ('config' in patch) c.config = campaignConfig(patch.config, c.config);
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
