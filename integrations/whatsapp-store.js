import crypto from 'crypto';
import fs from 'fs/promises';

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = DATA_DIR + '/whatsapp.json';
const MODES = ['lead', 'service', 'hybrid'];
let writeQueue = Promise.resolve();

function initialData() {
  return { profiles: [], conversations: {}, claimIntakes: [] };
}

function clean(value, max = 2000) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeAnswers(value) {
  return (Array.isArray(value) ? value : []).slice(0, 100).map(item => ({
    question: clean(item?.question, 500),
    answer: clean(item?.answer, 2000),
  })).filter(item => item.question && item.answer);
}

export function normalizeWhatsAppProfile(input = {}, current = {}) {
  return {
    id: current.id || clean(input.id, 100) || crypto.randomUUID(),
    name: clean(input.name, 160) || current.name || 'Neues WhatsApp-Profil',
    enabled: input.enabled === undefined ? (current.enabled ?? false) : input.enabled === true,
    mode: MODES.includes(input.mode) ? input.mode : (current.mode || 'lead'),
    campaignId: clean(input.campaignId, 120) || (input.campaignId === '' ? '' : current.campaignId || ''),
    phoneNumberId: clean(input.phoneNumberId, 160) || (input.phoneNumberId === '' ? '' : current.phoneNumberId || ''),
    businessName: clean(input.businessName, 160) || (input.businessName === '' ? '' : current.businessName || 'IVA'),
    appointmentUrl: clean(input.appointmentUrl, 1000) || (input.appointmentUrl === '' ? '' : current.appointmentUrl || ''),
    objective: clean(input.objective, 1000) || (input.objective === '' ? '' : current.objective || 'Passenden Termin vereinbaren'),
    welcomeText: clean(input.welcomeText, 2000) || (input.welcomeText === '' ? '' : current.welcomeText || ''),
    handoffText: clean(input.handoffText, 2000) || (input.handoffText === '' ? '' : current.handoffText || 'Ich gebe das sicherheitshalber persönlich weiter.'),
    requireCustomerMatch: input.requireCustomerMatch === undefined ? (current.requireCustomerMatch ?? true) : input.requireCustomerMatch !== false,
    answers: input.answers === undefined ? (current.answers || []) : normalizeAnswers(input.answers),
    createdAt: current.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function load() {
  try {
    const data = JSON.parse(await fs.readFile(FILE, 'utf8'));
    return { ...initialData(), ...data, profiles: Array.isArray(data.profiles) ? data.profiles : [], conversations: data.conversations || {}, claimIntakes: Array.isArray(data.claimIntakes) ? data.claimIntakes : [] };
  } catch { return initialData(); }
}

async function save(data) {
  await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  const temp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2));
  await fs.rename(temp, FILE);
}

function mutate(fn) {
  const next = writeQueue.then(async () => {
    const data = await load();
    const result = await fn(data);
    await save(data);
    return result;
  });
  writeQueue = next.catch(() => {});
  return next;
}

export async function listWhatsAppProfiles() {
  return (await load()).profiles.map(profile => normalizeWhatsAppProfile(profile, profile));
}

export async function getWhatsAppProfile(id) {
  const profile = (await load()).profiles.find(item => item.id === id);
  return profile ? normalizeWhatsAppProfile(profile, profile) : null;
}

export async function createWhatsAppProfile(input = {}) {
  return mutate(data => {
    const profile = normalizeWhatsAppProfile(input);
    data.profiles.push(profile);
    return profile;
  });
}

export async function updateWhatsAppProfile(id, patch = {}) {
  return mutate(data => {
    const index = data.profiles.findIndex(item => item.id === id);
    if (index < 0) return null;
    data.profiles[index] = normalizeWhatsAppProfile(patch, data.profiles[index]);
    return data.profiles[index];
  });
}

export async function deleteWhatsAppProfile(id) {
  return mutate(data => {
    const before = data.profiles.length;
    data.profiles = data.profiles.filter(item => item.id !== id);
    return data.profiles.length < before;
  });
}

export async function resolveWhatsAppProfile({ profileId = '', phoneNumberId = '', campaignId = '' } = {}) {
  const profiles = await listWhatsAppProfiles();
  if (profileId) return profiles.find(item => item.id === profileId) || null;
  if (phoneNumberId) return profiles.find(item => item.enabled && item.phoneNumberId === phoneNumberId) || null;
  if (campaignId) return profiles.find(item => item.enabled && item.campaignId === campaignId) || null;
  const defaultId = clean(process.env.WHATSAPP_DEFAULT_PROFILE_ID, 100);
  return profiles.find(item => defaultId && item.enabled && item.id === defaultId) || null;
}

function conversationKey(profileId, sender) {
  return `${clean(profileId, 100)}:${clean(sender, 100)}`;
}

export async function getWhatsAppConversation(profileId, sender) {
  const key = conversationKey(profileId, sender);
  return (await load()).conversations[key] || { key, profileId, sender, messages: [], customerId: '', claimIntakeId: '', humanHandoff: false };
}

export async function appendWhatsAppMessages(profileId, sender, messages = [], patch = {}) {
  return mutate(data => {
    const key = conversationKey(profileId, sender);
    const current = data.conversations[key] || { key, profileId, sender, messages: [], customerId: '', claimIntakeId: '', humanHandoff: false, createdAt: new Date().toISOString() };
    const additions = (Array.isArray(messages) ? messages : []).map(item => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      text: clean(item.text, 6000),
      at: item.at || new Date().toISOString(),
      messageId: clean(item.messageId, 200),
    })).filter(item => item.text);
    data.conversations[key] = {
      ...current,
      ...patch,
      messages: [...(current.messages || []), ...additions].slice(-30),
      updatedAt: new Date().toISOString(),
    };
    return data.conversations[key];
  });
}

export async function createOrUpdateClaimIntake({ id = '', profileId, sender, customerId = '', text = '', status = 'collecting' } = {}) {
  return mutate(data => {
    let intake = data.claimIntakes.find(item => id && item.id === id);
    if (!intake) {
      intake = { id: crypto.randomUUID(), profileId, sender, customerId, status, statements: [], createdAt: new Date().toISOString() };
      data.claimIntakes.push(intake);
    }
    if (text) intake.statements.push({ text: clean(text, 6000), at: new Date().toISOString() });
    intake.customerId = customerId || intake.customerId;
    intake.status = status || intake.status;
    intake.updatedAt = new Date().toISOString();
    return intake;
  });
}

export async function listClaimIntakes({ status = '', limit = 100 } = {}) {
  return (await load()).claimIntakes
    .filter(item => !status || item.status === status)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, Math.min(Math.max(Number(limit) || 100, 1), 500));
}
