import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateWebsiteUrl } from '../websites/import-url.js';

export const marketingError = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
export const clean = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
export function publicMarketingUrl(value) { return value ? validateWebsiteUrl(String(value).trim()).href : ''; }
const ROLES = new Set(['profile', 'research', 'drafts', 'videoQuotes', 'videos']);
const queues = new Map();
export function createProjectMarketingStore({ dataDir = process.env.DATA_DIR || '/data', getProject }) {
  const file = path.join(dataDir, 'project-marketing.json');
  const queued = () => queues.get(file) || Promise.resolve();
  async function project(projectId) {
    if (typeof projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(projectId) || ['__proto__', 'prototype', 'constructor'].includes(projectId)) throw marketingError('PROJECT_REQUIRED', 'Bitte ein gültiges Projekt wählen.');
    const value = await getProject(projectId);
    if (!value) throw marketingError('PROJECT_NOT_FOUND', 'Dieses Projekt ist nicht verfügbar.', 404);
    return value;
  }
  async function load() {
    try { const value = JSON.parse(await fs.readFile(file, 'utf8')); if (!value?.projects || typeof value.projects !== 'object') throw new Error(); return value; }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, projects: {} }; throw marketingError('MARKETING_STORE_UNAVAILABLE', 'Die Marketingdaten können gerade nicht gelesen werden.', 503); }
  }
  async function writeMutation(projectId, action, lifecycleOnly = false) {
    if (!lifecycleOnly) await project(projectId);
    const pending = queued().then(async () => {
      if (!lifecycleOnly) await project(projectId);
      const data = await load();
      if (lifecycleOnly && !data.projects[projectId]) throw marketingError('MARKETING_ITEM_NOT_FOUND', 'Eintrag nicht gefunden.', 404);
      const current = data.projects[projectId] ||= { profile: null, research: [], drafts: [], videoQuotes: [], videos: [] };
      for (const collection of ['research', 'drafts', 'videoQuotes', 'videos']) if (!Array.isArray(current[collection])) throw marketingError('MARKETING_STORE_UNAVAILABLE', 'Die Marketingablage ist beschädigt.', 503);
      const result = await action(current);
      if (!lifecycleOnly) await project(projectId);
      await fs.mkdir(dataDir, { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
        if (!lifecycleOnly) await project(projectId);
        await fs.rename(temp, file);
      } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
      return structuredClone(result);
    });
    const tail = pending.catch(() => {}); queues.set(file, tail);
    void tail.then(() => { if (queues.get(file) === tail) queues.delete(file); });
    return pending;
  }
  const mutate = (projectId, action) => writeMutation(projectId, action);
  async function snapshot(projectId) {
    const p = await project(projectId); await queued(); await project(projectId);
    const value = (await load()).projects[projectId] || {};
    const profile = value.profile || { projectId, name: p.name || '', company: p.company || p.name || '', offer: p.offer || p.description || '', industry: p.industry || '', audience: p.audience || '', region: p.region || 'DACH', website: '', instagram: '', linkedin: '', colors: [], tone: '', rules: '', logo: null };
    return structuredClone({ projectId, profile, research: value.research || [], drafts: value.drafts || [], videos: value.videos || [], videoQuotes: (value.videoQuotes || []).filter(q => q.status === 'quoted' && Date.parse(q.expiresAt) > Date.now()).map(q => ({ id: q.id, projectId, model: q.prepared.model, prompt: q.prepared.payload.prompt, duration: q.prepared.payload.duration, aspectRatio: q.prepared.payload.aspect_ratio, ...q.estimate, expiresAt: q.expiresAt, status: 'quoted', createdAt: q.createdAt })) });
  }
  async function saveProfile(projectId, input = {}) {
    const patch = {};
    for (const key of ['name', 'company', 'offer', 'industry', 'audience', 'region', 'tone', 'rules']) if (key in input) patch[key] = clean(input[key], ['offer', 'audience', 'rules'].includes(key) ? 6000 : 1500);
    for (const key of ['website', 'instagram', 'linkedin']) if (key in input) {
      let url = input[key]; if (key === 'instagram' && /^@?[\w.]{1,30}$/.test(url || '')) url = `https://www.instagram.com/${String(url).replace(/^@/, '')}/`;
      patch[key] = publicMarketingUrl(url);
      if (patch[key] && key !== 'website' && !new RegExp(`(^|\\.)${key === 'instagram' ? 'instagram' : 'linkedin'}\\.com$`).test(new URL(patch[key]).hostname)) throw marketingError('PROFILE_SOCIAL_URL', `Bitte eine gültige ${key === 'instagram' ? 'Instagram' : 'LinkedIn'}-Adresse angeben.`);
    }
    if ('colors' in input) {
      if (!Array.isArray(input.colors) || input.colors.length > 10 || input.colors.some(x => !/^#[a-f\d]{6}$/i.test(x))) throw marketingError('PROFILE_COLORS', 'Bitte bis zu zehn Farben als #RRGGBB angeben.');
      patch.colors = [...new Set(input.colors.map(x => x.toUpperCase()))];
    }
    const base = (await snapshot(projectId)).profile;
    return mutate(projectId, state => { state.profile = { ...base, ...state.profile, ...patch, projectId, version: randomUUID(), updatedAt: new Date().toISOString() }; return state.profile; });
  }
  async function saveLogo(projectId, bytes, mime) {
    const buffer = Buffer.from(bytes || []);
    const actual = buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255 ? 'image/jpeg' : buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : '';
    if (!buffer.length || buffer.length > 3 * 1024 * 1024 || !actual || mime !== actual) throw marketingError('PROFILE_LOGO_INVALID', 'Logo als PNG, JPG oder WebP mit höchstens 3 MiB hochladen.', 413);
    const base = (await snapshot(projectId)).profile;
    return mutate(projectId, state => { state.profile = { ...base, ...state.profile, logo: { mime: actual, data: buffer.toString('base64') }, version: randomUUID(), updatedAt: new Date().toISOString() }; return { ok: true }; });
  }
  async function add(projectId, collection, input) {
    if (!ROLES.has(collection) || collection === 'profile') throw new Error('Unknown collection');
    return mutate(projectId, state => { const item = { ...input, id: randomUUID(), projectId, createdAt: new Date().toISOString() }; state[collection].unshift(item); return item; });
  }
  async function get(projectId, collection, id) {
    await project(projectId); await queued(); await project(projectId);
    if (!ROLES.has(collection) || collection === 'profile') throw new Error('Unknown collection');
    const item = ((await load()).projects[projectId]?.[collection] || []).find(row => row.id === id);
    if (!item) throw marketingError('MARKETING_ITEM_NOT_FOUND', 'Dieser Eintrag gehört nicht zum gewählten Projekt.', 404);
    return structuredClone(item);
  }
  async function update(projectId, collection, id, patch) {
    return mutate(projectId, state => { const item = state[collection]?.find(row => row.id === id); if (!item) throw marketingError('MARKETING_ITEM_NOT_FOUND', 'Eintrag nicht gefunden.', 404); Object.assign(item, patch, { id, projectId, updatedAt: new Date().toISOString() }); return item; });
  }
  // Server-only lifecycle settlement remains possible after module revocation.
  // It cannot add records, change brand/content, issue requests or reveal data.
  async function settle(projectId, collection, id, patch) {
    if (!['research', 'drafts', 'videos'].includes(collection) || !/^[a-zA-Z0-9_-]{1,100}$/.test(projectId) || ['__proto__', 'prototype', 'constructor'].includes(projectId)) throw marketingError('MARKETING_ITEM_NOT_FOUND', 'Eintrag nicht gefunden.', 404);
    const states = collection === 'videos' ? ['failed', 'canceled', 'submission_uncertain', 'queued', 'in_progress', 'completed', 'nsfw'] : ['failed'];
    if (!states.includes(patch.status)) throw new Error('Invalid lifecycle status');
    const safe = { status: patch.status, message: clean(patch.message, 600) };
    if (collection === 'videos' && patch.requestId !== undefined) {
      if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(patch.requestId)) throw new Error('Invalid provider receipt');
      safe.requestId = patch.requestId;
      if (patch.videoUrl) { const url = new URL(patch.videoUrl); if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 8192) throw new Error('Invalid provider receipt'); safe.videoUrl = url.href; }
    }
    return writeMutation(projectId, state => { const item = state[collection]?.find(row => row.id === id); if (!item) throw marketingError('MARKETING_ITEM_NOT_FOUND', 'Eintrag nicht gefunden.', 404); Object.assign(item, safe, { updatedAt: new Date().toISOString() }); return { id, status: item.status }; }, true);
  }
  return { project, snapshot, saveProfile, saveLogo, add, get, update, mutate, settle };
}
