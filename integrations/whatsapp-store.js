import crypto from 'crypto';
import fs from 'fs/promises';

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = DATA_DIR + '/whatsapp.json';
const MODES = ['lead', 'service', 'hybrid'];
const HANDOFF_STATUSES = new Set(['open', 'in-progress', 'resolved']);
let writeQueue = Promise.resolve();

function initialData() {
  return { version: 2, profiles: [], conversations: {}, claimIntakes: [], handoffTickets: [] };
}

function clean(value, max = 2000) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeAnswers(value) {
  return (Array.isArray(value) ? value : []).slice(0, 100).map(item => ({
    question: clean(item?.question, 500),
    answer: clean(item?.answer, 2000),
    source: clean(item?.source, 1000),
    verifiedAt: clean(item?.verifiedAt, 60),
  })).filter(item => item.question && item.answer);
}

export function normalizeWhatsAppProfile(input = {}, current = {}) {
  const projectId = clean(input.projectId ?? current.projectId, 120);
  if (projectId && (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(projectId) || ['__proto__', 'constructor', 'prototype'].includes(projectId))) throw new Error('Ungültige Projektkennung.');
  const task = ['appointment', 'claim', 'service'].includes(input.task) ? input.task : current.task || (input.mode === 'service' || current.mode === 'service' ? 'service' : 'appointment');
  const eventTypeUri = clean(input.calendlyEventTypeUri ?? current.calendlyEventTypeUri, 300);
  if (eventTypeUri && !/^https:\/\/api\.calendly\.com\/event_types\/[A-Za-z0-9_-]+$/.test(eventTypeUri)) throw new Error('Calendly-Ereignis aus der geprüften Ereignisliste wählen.');
  const appointmentUrl = clean(input.appointmentUrl ?? current.appointmentUrl, 1000);
  if (appointmentUrl) { const url = new URL(appointmentUrl); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Terminlink muss eine HTTPS-Adresse ohne Zugangsdaten sein.'); }
  const timezone = clean(input.timezone ?? current.timezone, 80) || 'Europe/Berlin';
  try { new Intl.DateTimeFormat('de-DE', { timeZone: timezone }); } catch { throw new Error('Ungültige Zeitzone.'); }
  return {
    id: current.id || clean(input.id, 100) || crypto.randomUUID(),
    name: clean(input.name, 160) || current.name || 'Neues WhatsApp-Profil',
    enabled: Boolean(projectId) && (input.enabled === undefined ? (current.enabled ?? false) : input.enabled === true),
    projectId, task, calendlyEventTypeUri: eventTypeUri, timezone,
    mode: MODES.includes(input.mode) ? input.mode : (current.mode || 'lead'),
    campaignId: clean(input.campaignId, 120) || (input.campaignId === '' ? '' : current.campaignId || ''),
    phoneNumberId: clean(input.phoneNumberId, 160) || (input.phoneNumberId === '' ? '' : current.phoneNumberId || ''),
    businessName: clean(input.businessName, 160) || (input.businessName === '' ? '' : current.businessName || 'IVA'),
    appointmentUrl,
    objective: clean(input.objective, 1000) || (input.objective === '' ? '' : current.objective || 'Passenden Termin vereinbaren'),
    welcomeText: clean(input.welcomeText, 2000) || (input.welcomeText === '' ? '' : current.welcomeText || ''),
    handoffText: clean(input.handoffText, 2000) || (input.handoffText === '' ? '' : current.handoffText || 'Ich gebe das sicherheitshalber persönlich weiter.'),
    handoffOwner: clean(input.handoffOwner, 200) || (input.handoffOwner === '' ? '' : current.handoffOwner || ''),
    handoffSlaMinutes: Math.max(15, Math.min(10_080, Number(input.handoffSlaMinutes ?? current.handoffSlaMinutes) || 240)),
    requireCustomerMatch: input.requireCustomerMatch === undefined ? (current.requireCustomerMatch ?? true) : input.requireCustomerMatch !== false,
    answers: input.answers === undefined ? (current.answers || []) : normalizeAnswers(input.answers),
    createdAt: current.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function load() {
  try {
    const data = JSON.parse(await fs.readFile(FILE, 'utf8'));
    return {
      ...initialData(), ...data, version: 2,
      profiles: Array.isArray(data.profiles) ? data.profiles : [], conversations: data.conversations || {},
      claimIntakes: Array.isArray(data.claimIntakes) ? data.claimIntakes : [],
      handoffTickets: Array.isArray(data.handoffTickets) ? data.handoffTickets : [],
    };
  } catch (error) { if (error.code === 'ENOENT') return initialData(); throw new Error('Die WhatsApp-Ablage ist nicht lesbar. Vorhandene Daten bleiben erhalten.'); }
}

async function save(data) {
  await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  const temp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
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
    if (data.profiles.some(p => p.id === profile.id)) throw new Error('Diese Profilkennung ist bereits vergeben.');
    if (profile.enabled && (!profile.phoneNumberId || !/^\d{5,30}$/.test(profile.phoneNumberId))) throw new Error('Ein aktives Profil benötigt die Meta Phone Number ID.');
    if (profile.enabled && data.profiles.some(p => p.enabled && p.phoneNumberId === profile.phoneNumberId)) throw new Error('Diese WhatsApp-Nummer ist bereits einem aktiven Profil zugeordnet.');
    data.profiles.push(profile);
    return profile;
  });
}

export async function updateWhatsAppProfile(id, patch = {}) {
  return mutate(data => {
    const index = data.profiles.findIndex(item => item.id === id);
    if (index < 0) return null;
    const current = data.profiles[index], next = normalizeWhatsAppProfile(patch, current);
    if (current.projectId && next.projectId !== current.projectId) throw new Error('Für ein anderes Projekt bitte ein neues Profil anlegen; bestehende Kundenverläufe behalten ihre Zuordnung.');
    if (current.phoneNumberId && next.phoneNumberId !== current.phoneNumberId) throw new Error('Für eine andere WhatsApp-Nummer bitte ein neues Profil anlegen.');
    if (next.enabled && (!/^\d{5,30}$/.test(next.phoneNumberId) || data.profiles.some(p => p.id !== id && p.enabled && p.phoneNumberId === next.phoneNumberId))) throw new Error('Eine eindeutige Meta-Nummer für das aktive Profil fehlt.');
    data.profiles[index] = next;
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
  if (phoneNumberId) { const matches = profiles.filter(item => item.enabled && item.phoneNumberId === phoneNumberId); return matches.length === 1 ? matches[0] : null; }
  if (campaignId) return profiles.find(item => item.enabled && item.campaignId === campaignId) || null;
  const defaultId = clean(process.env.WHATSAPP_DEFAULT_PROFILE_ID, 100);
  return profiles.find(item => defaultId && item.enabled && item.id === defaultId) || null;
}

function conversationKey(profileId, sender) {
  return `${clean(profileId, 100)}:${clean(sender, 100)}`;
}

export async function getWhatsAppConversation(profileId, sender) {
  const key = conversationKey(profileId, sender);
  return (await load()).conversations[key] || { key, profileId, sender, messages: [], customerId: '', claimIntakeId: '', handoffTicketId: '', humanHandoff: false };
}

export async function appendWhatsAppMessages(profileId, sender, messages = [], patch = {}) {
  return mutate(data => {
    const key = conversationKey(profileId, sender);
    const current = data.conversations[key] || { key, profileId, sender, messages: [], customerId: '', claimIntakeId: '', handoffTicketId: '', humanHandoff: false, createdAt: new Date().toISOString() };
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

export async function createOrUpdateWhatsAppHandoff({ id = '', profileId, sender, customerId = '', owner = '', slaMinutes = 240, reasons = [], priority = 'normal', lastMessage = '' } = {}) {
  return mutate(data => {
    let ticket = data.handoffTickets.find(item => id && item.id === id && item.status !== 'resolved');
    if (!ticket) ticket = data.handoffTickets.find(item => item.profileId === profileId && item.sender === sender && item.status !== 'resolved');
    const now = new Date();
    if (!ticket) {
      ticket = {
        id: crypto.randomUUID(), profileId, sender, customerId, owner: clean(owner, 200), status: 'open',
        priority: priority === 'high' ? 'high' : 'normal', reasons: [], trace: [],
        dueAt: new Date(now.getTime() + Math.max(15, Math.min(10_080, Number(slaMinutes) || 240)) * 60_000).toISOString(),
        createdAt: now.toISOString(),
      };
      data.handoffTickets.push(ticket);
    }
    ticket.customerId = customerId || ticket.customerId;
    ticket.owner = clean(owner, 200) || ticket.owner;
    ticket.priority = priority === 'high' ? 'high' : ticket.priority;
    ticket.reasons = [...new Set([...(ticket.reasons || []), ...((Array.isArray(reasons) ? reasons : []).map(item => clean(item, 100)).filter(Boolean))])];
    if (lastMessage) ticket.trace.push({ at: now.toISOString(), message: clean(lastMessage, 1000) });
    ticket.trace = ticket.trace.slice(-30);
    ticket.updatedAt = now.toISOString();
    return { ...ticket };
  });
}

export async function listWhatsAppHandoffs({ status = '', limit = 100 } = {}) {
  return (await load()).handoffTickets
    .filter(item => !status || item.status === status)
    .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)))
    .slice(0, Math.min(Math.max(Number(limit) || 100, 1), 500));
}

export async function updateWhatsAppHandoff(id, patch = {}) {
  return mutate(data => {
    const ticket = data.handoffTickets.find(item => item.id === id);
    if (!ticket) return null;
    if (patch.status && !HANDOFF_STATUSES.has(patch.status)) throw new Error('Ungueltiger Ticketstatus');
    if (patch.status) ticket.status = patch.status;
    if (patch.owner !== undefined) ticket.owner = clean(patch.owner, 200);
    if (patch.note) ticket.trace.push({ at: new Date().toISOString(), message: clean(patch.note, 1000), type: 'internal-note' });
    ticket.trace = ticket.trace.slice(-30);
    ticket.updatedAt = new Date().toISOString();
    if (ticket.status === 'resolved' && !ticket.resolvedAt) ticket.resolvedAt = ticket.updatedAt;
    if (ticket.status !== 'resolved') delete ticket.resolvedAt;
    return { ...ticket };
  });
}
