import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { initialEnergyData } from './tmb.js';

export const WORKSPACE_MODES = ['beratung', 'kunde', 'energie'];
export const FILE_KINDS = ['floorplan', 'elevation', 'photo', 'tmb-template', 'document', 'payroll-sample', 'audio', 'lumit-application', 'lumit-policy-original', 'lumit-brand-asset', 'lumit-customer-package'];
export const DOCUMENT_CATEGORIES = ['general', 'floorplan', 'consumption-proof', 'offer', 'tmb', 'contract', 'invoice', 'heating', 'pv', 'correspondence', 'other'];
export const MEETING_SOURCES = ['plaud', 'live-coach', 'manual'];

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
  if (out.mode === 'kunde' && out.status === 'draft') out.status = 'active';
  out.files = (out.files || []).map(({ storageName, ...file }) => file);
  return out;
}

function initialData(mode) {
  if (mode === 'energie') {
    return initialEnergyData();
  }
  if (mode === 'beratung') return { schemaVersion: 'iva-advice-1.0', appointmentAt: '', topic: '', goal: '', facts: '', recommendation: '', adviceModules: [], activeAdviceModule: '', moduleData: {} };
  return { project: '', company: '', relationship: '', nextStep: '' };
}

function normalizedCustomer(value = {}) {
  const customer = plainObject(value);
  return {
    id: cleanText(customer.id, 160),
    name: cleanText(customer.name, 200),
    salutationKey: cleanText(customer.salutationKey, 40),
    salutation: cleanText(customer.salutation, 100),
    firstName: cleanText(customer.firstName, 160),
    lastName: cleanText(customer.lastName, 200),
    company: cleanText(customer.company, 240),
    legalForm: cleanText(customer.legalForm, 160),
    email: cleanText(customer.email, 320),
    phone: cleanText(customer.phone, 100),
    street: cleanText(customer.street, 240),
    zip: cleanText(customer.zip, 40),
    city: cleanText(customer.city, 160),
    address: cleanText(customer.address, 500),
    brokerId: cleanText(customer.brokerId, 100),
  };
}

function normalizedNotes(notes = [], fallbackSource = 'import') {
  const now = new Date().toISOString();
  return (Array.isArray(notes) ? notes : [])
    .map(note => typeof note === 'string' ? { text: note } : plainObject(note))
    .map(note => ({
      id: cleanText(note.id, 160) || crypto.randomUUID(),
      text: cleanText(note.text, 10000),
      source: cleanText(note.source, 80) || fallbackSource,
      createdAt: cleanText(note.createdAt, 80) || now,
    }))
    .filter(note => note.text)
    .slice(0, 500);
}

function cleanList(value, maxItems = 50, maxText = 1200) {
  return (Array.isArray(value) ? value : [])
    .map(item => cleanText(typeof item === 'string' ? item : item?.text, maxText))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizedMeeting(input = {}) {
  const meeting = plainObject(input);
  const consent = plainObject(meeting.consent);
  const source = MEETING_SOURCES.includes(meeting.source) ? meeting.source : 'manual';
  const now = new Date().toISOString();
  return {
    id: cleanText(meeting.id, 160) || crypto.randomUUID(),
    source,
    externalId: cleanText(meeting.externalId || meeting.recordingId, 300),
    title: cleanText(meeting.title, 240) || 'Kundengespräch',
    occurredAt: cleanText(meeting.occurredAt, 80) || now,
    durationSeconds: Math.max(0, Math.min(Number(meeting.durationSeconds) || 0, 24 * 60 * 60)),
    status: ['imported', 'review', 'complete'].includes(meeting.status) ? meeting.status : 'review',
    consent: {
      granted: consent.granted === true,
      grantedAt: cleanText(consent.grantedAt, 80) || (consent.granted === true ? now : ''),
      method: cleanText(consent.method, 160) || (consent.granted === true ? 'Vor Gespräch bestätigt' : ''),
    },
    transcript: cleanText(meeting.transcript, 100000),
    internalSummary: cleanText(meeting.internalSummary || meeting.summary, 20000),
    customerSummary: cleanText(meeting.customerSummary, 20000),
    topics: cleanList(meeting.topics),
    decisions: cleanList(meeting.decisions),
    actionItems: cleanList(meeting.actionItems),
    objections: cleanList(meeting.objections),
    createdAt: cleanText(meeting.createdAt, 80) || now,
    updatedAt: now,
  };
}

function customerGreeting(customer = {}) {
  const firstName = cleanText(customer.firstName, 160);
  const lastName = cleanText(customer.lastName, 200);
  const salutation = cleanText(customer.salutation, 100).toLocaleLowerCase('de');
  if (/frau/.test(salutation) && lastName) return `Guten Tag Frau ${lastName},`;
  if (/herr/.test(salutation) && lastName) return `Guten Tag Herr ${lastName},`;
  if (firstName) return `Hallo ${firstName},`;
  return 'Guten Tag,';
}

function buildCustomerFollowUp(workspace, meetings, input = {}) {
  const selected = meetings.filter(Boolean);
  const subject = cleanText(input.subject, 240)
    || `Zusammenfassung unseres Gesprächs${selected.length === 1 ? ` vom ${new Date(selected[0].occurredAt).toLocaleDateString('de-DE')}` : ''}`;
  const summaryParts = selected
    .map(meeting => meeting.customerSummary || meeting.internalSummary)
    .filter(Boolean);
  const decisions = [...new Set(selected.flatMap(meeting => meeting.decisions || []))];
  const actionItems = [...new Set(selected.flatMap(meeting => meeting.actionItems || []))];
  const sections = [
    customerGreeting(workspace.customer),
    '',
    cleanText(input.intro, 1200) || 'vielen Dank für unser Gespräch. Hier ist die kurze Zusammenfassung der besprochenen Punkte:',
    '',
    ...summaryParts.flatMap((text, index) => [selected.length > 1 ? `${index + 1}. ${selected[index].title}` : '', text, '']).filter(Boolean),
  ];
  if (decisions.length) sections.push('Festgehaltene Entscheidungen:', ...decisions.map(item => `- ${item}`), '');
  if (actionItems.length) sections.push('Nächste Schritte:', ...actionItems.map(item => `- ${item}`), '');
  sections.push('Wenn etwas anders gemeint war oder ergänzt werden soll, antworte bitte kurz auf diese E-Mail.', '', 'Viele Grüße', 'Nadine');
  return {
    id: crypto.randomUUID(),
    kind: 'customer-meeting-follow-up',
    status: 'draft',
    to: cleanText(input.to, 320) || cleanText(workspace.customer?.email, 320),
    subject,
    body: cleanText(input.body, 30000) || sections.join('\n'),
    meetingIds: selected.map(meeting => meeting.id),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function workspaceIdentity(data = {}) {
  return cleanText(data?.crm?.sourceKey, 500) || cleanText(data?.idempotencyKey, 500);
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
    const rawCustomer = plainObject(input.customer);
    const customer = normalizedCustomer(rawCustomer);
    const workspaceData = mergePlain(initialData(mode), input.data);
    const identity = workspaceIdentity(workspaceData);
    const existing = identity
      ? data.workspaces.find(item => item.mode === mode && workspaceIdentity(item.data) === identity)
      : null;
    if (existing) {
      existing.title = cleanText(input.title, 160) || existing.title;
      existing.status = mode === 'kunde' ? 'active' : existing.status;
      existing.customer = normalizedCustomer({ ...existing.customer, ...rawCustomer });
      existing.data = mergePlain(existing.data, workspaceData);
      const notes = normalizedNotes(input.notes, workspaceData?.crm?.project ? `crm:${workspaceData.crm.project}` : 'import');
      const knownNotes = new Set((existing.notes || []).map(note => `${note.source}|${note.text}`));
      existing.notes = [...(existing.notes || []), ...notes.filter(note => !knownNotes.has(`${note.source}|${note.text}`))];
      existing.updatedAt = now;
      return publicWorkspace(existing);
    }
    const workspace = {
      id: crypto.randomUUID(),
      mode,
      title: cleanText(input.title, 160) || ({ beratung: 'Neue Beratung', kunde: 'Neue Kundenakte', energie: 'Neue Energieplanung' })[mode],
      status: ['draft', 'active', 'review', 'complete'].includes(input.status) ? input.status : mode === 'kunde' ? 'active' : 'draft',
      customer,
      data: workspaceData,
      visit: mergePlain({
        consent: { granted: false, grantedAt: null, method: '' },
        plaud: { recordingId: '', status: 'not-linked', importedAt: null },
      }, input.visit),
      notes: normalizedNotes(input.notes, workspaceData?.crm?.project ? `crm:${workspaceData.crm.project}` : 'import'),
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
    if ('customer' in patch) workspace.customer = normalizedCustomer({ ...workspace.customer, ...plainObject(patch.customer) });
    if ('data' in patch) workspace.data = mergePlain(workspace.data, patch.data);
    if ('visit' in patch) workspace.visit = mergePlain(workspace.visit, patch.visit);
    workspace.updatedAt = new Date().toISOString();
    return publicWorkspace(workspace);
  });
}

export async function deleteWorkspace(id, { mode } = {}) {
  const removed = await mutate(data => {
    const index = data.workspaces.findIndex(workspace => workspace.id === id && (!mode || workspace.mode === mode));
    if (index < 0) return null;
    const [workspace] = data.workspaces.splice(index, 1);
    return publicWorkspace(workspace);
  });
  if (!removed) return null;
  const filesRoot = path.resolve(FILES_DIR) + path.sep;
  const folder = path.resolve(FILES_DIR, removed.id);
  if (!folder.startsWith(filesRoot)) throw new Error('Ungueltiger Arbeitsbereichspfad.');
  await fs.rm(folder, { recursive: true, force: true });
  return removed;
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

export async function addWorkspaceMeeting(id, input = {}) {
  return mutate(data => {
    const workspace = data.workspaces.find(w => w.id === id);
    if (!workspace) return null;
    const meeting = normalizedMeeting(input);
    if (!meeting.consent.granted) throw new Error('Die Einwilligung zur Gesprächsaufzeichnung und Auswertung muss dokumentiert sein.');
    workspace.data = plainObject(workspace.data);
    const meetings = Array.isArray(workspace.data.meetings) ? workspace.data.meetings : [];
    const duplicate = meeting.externalId
      ? meetings.find(item => item.source === meeting.source && item.externalId === meeting.externalId)
      : null;
    if (duplicate) return { workspace: publicWorkspace(workspace), meeting: safeClone(duplicate), duplicate: true };
    workspace.data.meetings = [...meetings, meeting].slice(-500);
    workspace.updatedAt = meeting.updatedAt;
    return { workspace: publicWorkspace(workspace), meeting: safeClone(meeting), duplicate: false };
  });
}

export async function updateWorkspaceMeeting(id, meetingId, patch = {}) {
  return mutate(data => {
    const workspace = data.workspaces.find(w => w.id === id);
    const meetings = Array.isArray(workspace?.data?.meetings) ? workspace.data.meetings : [];
    const index = meetings.findIndex(item => item.id === meetingId);
    if (!workspace || index < 0) return null;
    const current = meetings[index];
    const next = normalizedMeeting({ ...current, ...plainObject(patch), id: current.id, createdAt: current.createdAt });
    if (!next.consent.granted) throw new Error('Die dokumentierte Einwilligung darf nicht entfernt werden.');
    meetings[index] = next;
    workspace.updatedAt = next.updatedAt;
    return { workspace: publicWorkspace(workspace), meeting: safeClone(next) };
  });
}

export async function createWorkspaceFollowUpDraft(id, input = {}) {
  return mutate(data => {
    const workspace = data.workspaces.find(w => w.id === id);
    if (!workspace) return null;
    const meetings = Array.isArray(workspace.data?.meetings) ? workspace.data.meetings : [];
    const requestedIds = new Set((Array.isArray(input.meetingIds) ? input.meetingIds : []).map(String));
    const selected = meetings.filter(meeting => requestedIds.has(String(meeting.id)));
    if (!selected.length) throw new Error('Bitte mindestens eine Meeting-Zusammenfassung auswählen.');
    if (selected.some(meeting => !meeting.consent?.granted)) throw new Error('Mindestens einem Gespräch fehlt die dokumentierte Einwilligung.');
    if (selected.some(meeting => !(meeting.customerSummary || meeting.internalSummary))) throw new Error('Jedes ausgewählte Gespräch braucht eine geprüfte Zusammenfassung.');
    const draft = buildCustomerFollowUp(workspace, selected, input);
    workspace.data = plainObject(workspace.data);
    const drafts = Array.isArray(workspace.data.followUpDrafts) ? workspace.data.followUpDrafts : [];
    workspace.data.followUpDrafts = [...drafts, draft].slice(-200);
    workspace.updatedAt = draft.updatedAt;
    return { workspace: publicWorkspace(workspace), draft: safeClone(draft) };
  });
}

export async function updateWorkspaceFollowUpDraft(id, draftId, patch = {}) {
  return mutate(data => {
    const workspace = data.workspaces.find(w => w.id === id);
    const drafts = Array.isArray(workspace?.data?.followUpDrafts) ? workspace.data.followUpDrafts : [];
    const draft = drafts.find(item => item.id === draftId);
    if (!workspace || !draft) return null;
    if ('to' in patch) draft.to = cleanText(patch.to, 320);
    if ('subject' in patch) draft.subject = cleanText(patch.subject, 240);
    if ('body' in patch) draft.body = cleanText(patch.body, 30000);
    if ('status' in patch && ['draft', 'opened', 'sent-manually', 'archived'].includes(patch.status)) draft.status = patch.status;
    draft.updatedAt = new Date().toISOString();
    workspace.updatedAt = draft.updatedAt;
    return { workspace: publicWorkspace(workspace), draft: safeClone(draft) };
  });
}

function safeExtension(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

export async function storeWorkspaceFile(id, { name, mime, kind, category, buffer }) {
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
      category: DOCUMENT_CATEGORIES.includes(category) ? category : 'general',
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
