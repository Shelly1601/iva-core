import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractText } from 'unpdf';
import { createCandidateSearchPlan, createInterviewGuide, screenResumeAgainstCriteria } from './assistant.js';

const DATA_DIR = process.env.DATA_DIR || '/data';
const STORE_FILE = path.join(DATA_DIR, 'recruiting.json');
const FILES_DIR = path.join(DATA_DIR, 'recruiting-files');
const PIPELINE_STATUSES = new Set(['new', 'review', 'contact-planned', 'contacted', 'interview', 'hold', 'rejected', 'hired']);
const ALLOWED_MIME = new Set(['application/pdf', 'text/plain']);
let mutationQueue = Promise.resolve();

const emptyStore = () => ({ version: 1, roles: [], candidates: [] });
const clean = (value, max = 2000) => String(value ?? '').trim().slice(0, max);
const uniqueList = (value, max = 30) => [...new Set((Array.isArray(value) ? value : []).map(item => clean(item, 180)).filter(Boolean))].slice(0, max);
const clone = value => JSON.parse(JSON.stringify(value));

function normalizeLinkedInUrl(value) {
  try {
    const url = new URL(clean(value, 1500));
    if (url.protocol !== 'https:' || !/(^|\.)linkedin\.com$/i.test(url.hostname) || url.username || url.password) return '';
    url.hash = '';
    url.search = '';
    url.hostname = 'www.linkedin.com';
    return url.toString().replace(/\/$/, '');
  } catch { return ''; }
}

async function loadStore() {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE_FILE, 'utf8'));
    return {
      version: 1,
      roles: Array.isArray(parsed.roles) ? parsed.roles : [],
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
    };
  } catch { return emptyStore(); }
}

async function saveStore(data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data, null, 2));
  await fs.rename(temporary, STORE_FILE);
}

async function mutate(fn) {
  let result;
  const job = mutationQueue.catch(() => {}).then(async () => {
    const data = await loadStore();
    result = await fn(data);
    await saveStore(data);
  });
  mutationQueue = job.catch(() => {});
  await job;
  return result;
}

function normalizeRole(input = {}, existing = {}) {
  const now = new Date().toISOString();
  const role = clean(input.role ?? existing.role, 200);
  const mustHave = input.mustHave === undefined ? uniqueList(existing.mustHave) : uniqueList(input.mustHave);
  if (!role) throw new Error('Stellenbezeichnung fehlt');
  if (!mustHave.length) throw new Error('Mindestens ein Muss-Kriterium fehlt');
  return {
    ...existing,
    role,
    project: clean(input.project ?? existing.project, 160),
    description: clean(input.description ?? existing.description, 5000),
    mustHave,
    niceToHave: input.niceToHave === undefined ? uniqueList(existing.niceToHave) : uniqueList(input.niceToHave),
    titles: input.titles === undefined ? uniqueList(existing.titles, 15) : uniqueList(input.titles, 15),
    locations: input.locations === undefined ? uniqueList(existing.locations, 10) : uniqueList(input.locations, 10),
    remote: clean(input.remote ?? existing.remote, 80),
    languages: input.languages === undefined ? uniqueList(existing.languages, 10) : uniqueList(input.languages, 10),
    seniority: input.seniority === undefined ? uniqueList(existing.seniority, 10) : uniqueList(input.seniority, 10),
    industries: input.industries === undefined ? uniqueList(existing.industries, 15) : uniqueList(input.industries, 15),
    excludedTerms: input.excludedTerms === undefined ? uniqueList(existing.excludedTerms, 15) : uniqueList(input.excludedTerms, 15),
    status: ['draft', 'active', 'paused', 'closed'].includes(input.status) ? input.status : existing.status || 'active',
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

function screeningFor(candidate, role) {
  const evidenceText = [candidate.profileText, candidate.documentText].filter(Boolean).join('\n\n');
  if (!evidenceText || !role?.mustHave?.length) return null;
  return screenResumeAgainstCriteria({ role: role.role, cvText: evidenceText, mustHave: role.mustHave, niceToHave: role.niceToHave });
}

function publicCandidate(candidate, { includeText = false } = {}) {
  const result = clone(candidate);
  if (!includeText) {
    delete result.profileText;
    delete result.documentText;
  }
  return result;
}

export async function recruitingSummary() {
  const data = await loadStore();
  const counts = Object.fromEntries([...PIPELINE_STATUSES].map(status => [status, data.candidates.filter(item => item.status === status).length]));
  return {
    mode: 'free-manual-linkedin',
    costs: { additionalRecruitingSubscription: false, paidDataProvider: false },
    capabilities: ['Stellenprofile', 'kostenlose LinkedIn-Suchplaene', 'manueller Link-/PDF-Import', 'belegbares Matching', 'Kandidaten-Pipeline', 'Interviewleitfaeden'],
    limits: ['Kein Profil-Scraping', 'Kein automatischer LinkedIn-Import', 'Kein Massen-Outreach', 'Keine automatische Zu- oder Absage'],
    counts: { roles: data.roles.length, activeRoles: data.roles.filter(item => item.status === 'active').length, candidates: data.candidates.length, ...counts },
  };
}

export async function listRecruitingRoles() {
  return clone((await loadStore()).roles.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));
}

export async function getRecruitingRole(roleId) {
  const data = await loadStore();
  const role = data.roles.find(item => item.id === roleId);
  if (!role) return null;
  const candidates = data.candidates.filter(item => item.roleId === roleId).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(item => publicCandidate(item));
  return { ...clone(role), searchPlan: createCandidateSearchPlan(role), interviewGuide: createInterviewGuide(role), candidates };
}

export async function createRecruitingRole(input = {}) {
  return mutate(data => {
    const role = normalizeRole(input);
    role.id = crypto.randomUUID();
    data.roles.push(role);
    return clone(role);
  });
}

export async function updateRecruitingRole(roleId, patch = {}) {
  return mutate(data => {
    const index = data.roles.findIndex(item => item.id === roleId);
    if (index < 0) return null;
    const role = normalizeRole(patch, data.roles[index]);
    role.id = data.roles[index].id;
    data.roles[index] = role;
    for (const candidate of data.candidates.filter(item => item.roleId === roleId)) {
      candidate.screening = screeningFor(candidate, role);
      candidate.updatedAt = new Date().toISOString();
    }
    return clone(role);
  });
}

export async function deleteRecruitingRole(roleId) {
  const deleted = await mutate(data => {
    const role = data.roles.find(item => item.id === roleId);
    if (!role) return null;
    data.roles = data.roles.filter(item => item.id !== roleId);
    data.candidates = data.candidates.filter(item => item.roleId !== roleId);
    return clone(role);
  });
  if (deleted) await fs.rm(path.join(FILES_DIR, roleId), { recursive: true, force: true }).catch(() => {});
  return deleted;
}

function normalizeCandidate(input = {}, existing = {}) {
  const now = new Date().toISOString();
  return {
    ...existing,
    name: clean(input.name ?? existing.name, 200),
    linkedInUrl: input.linkedInUrl === undefined ? existing.linkedInUrl || '' : normalizeLinkedInUrl(input.linkedInUrl),
    headline: clean(input.headline ?? existing.headline, 300),
    location: clean(input.location ?? existing.location, 200),
    notes: clean(input.notes ?? existing.notes, 8000),
    profileText: clean(input.profileText ?? existing.profileText, 60_000),
    source: 'linkedin-manual',
    status: PIPELINE_STATUSES.has(input.status) ? input.status : existing.status || 'new',
    retentionReviewAt: clean(input.retentionReviewAt ?? existing.retentionReviewAt, 10) || new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10),
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

export async function listRecruitingCandidates({ roleId = '', status = '' } = {}) {
  const data = await loadStore();
  return data.candidates
    .filter(item => (!roleId || item.roleId === roleId) && (!status || item.status === status))
    .sort((a, b) => Number(b.screening?.evidenceScore || 0) - Number(a.screening?.evidenceScore || 0) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map(item => publicCandidate(item));
}

export async function getRecruitingCandidate(candidateId) {
  const item = (await loadStore()).candidates.find(candidate => candidate.id === candidateId);
  return item ? publicCandidate(item, { includeText: true }) : null;
}

export async function createRecruitingCandidate(roleId, input = {}) {
  return mutate(data => {
    const role = data.roles.find(item => item.id === roleId);
    if (!role) return null;
    const candidate = normalizeCandidate(input);
    if (clean(input.linkedInUrl, 1500) && !candidate.linkedInUrl) throw new Error('Bitte einen gültigen LinkedIn-Profillink verwenden');
    if (!candidate.name && !candidate.linkedInUrl) throw new Error('Name oder LinkedIn-Profillink fehlt');
    const duplicate = data.candidates.find(item => item.roleId === roleId && ((candidate.linkedInUrl && item.linkedInUrl === candidate.linkedInUrl) || (candidate.name && item.name.toLocaleLowerCase('de-DE') === candidate.name.toLocaleLowerCase('de-DE'))));
    if (duplicate) throw new Error('Diese Person ist für die Stelle bereits angelegt');
    candidate.id = crypto.randomUUID();
    candidate.roleId = roleId;
    candidate.screening = screeningFor(candidate, role);
    data.candidates.push(candidate);
    return publicCandidate(candidate, { includeText: true });
  });
}

export async function updateRecruitingCandidate(candidateId, patch = {}) {
  return mutate(data => {
    const index = data.candidates.findIndex(item => item.id === candidateId);
    if (index < 0) return null;
    const current = data.candidates[index];
    const candidate = normalizeCandidate(patch, current);
    if (patch.linkedInUrl !== undefined && clean(patch.linkedInUrl, 1500) && !candidate.linkedInUrl) throw new Error('Bitte einen gültigen LinkedIn-Profillink verwenden');
    const duplicate = data.candidates.find(item => item.id !== candidateId && item.roleId === current.roleId && candidate.linkedInUrl && item.linkedInUrl === candidate.linkedInUrl);
    if (duplicate) throw new Error('Dieser LinkedIn-Profillink ist für die Stelle bereits angelegt');
    candidate.id = current.id;
    candidate.roleId = current.roleId;
    candidate.document = current.document;
    candidate.documentText = current.documentText;
    candidate.screening = screeningFor(candidate, data.roles.find(item => item.id === candidate.roleId));
    data.candidates[index] = candidate;
    return publicCandidate(candidate, { includeText: true });
  });
}

export async function deleteRecruitingCandidate(candidateId) {
  const deleted = await mutate(data => {
    const candidate = data.candidates.find(item => item.id === candidateId);
    if (!candidate) return null;
    data.candidates = data.candidates.filter(item => item.id !== candidateId);
    return clone(candidate);
  });
  if (deleted) await fs.rm(path.join(FILES_DIR, deleted.roleId, deleted.id), { recursive: true, force: true }).catch(() => {});
  return deleted ? publicCandidate(deleted) : null;
}

async function documentText(buffer, mime) {
  if (mime === 'text/plain') return clean(buffer.toString('utf8'), 100_000);
  if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Die Datei ist keine gültige PDF');
  const result = await extractText(new Uint8Array(buffer), { mergePages: true });
  return clean(result.text, 100_000);
}

export async function storeRecruitingCandidateDocument(candidateId, { name, mime, buffer } = {}) {
  const safeMime = clean(mime, 100).split(';')[0].toLowerCase();
  if (!ALLOWED_MIME.has(safeMime)) throw new Error('Erlaubt sind PDF- und Textdateien');
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Datei fehlt');
  const extracted = await documentText(buffer, safeMime);
  if (!extracted) throw new Error('Aus der Datei konnte kein Text gelesen werden. Bitte Text manuell einfügen oder eine durchsuchbare PDF verwenden.');
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const existing = (await loadStore()).candidates.find(item => item.id === candidateId);
  if (!existing) return null;
  const extension = safeMime === 'application/pdf' ? '.pdf' : '.txt';
  const fileName = `${hash}${extension}`;
  const directory = path.join(FILES_DIR, existing.roleId, candidateId);
  const filePath = path.join(directory, fileName);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(filePath, buffer);
  const result = await mutate(data => {
    const candidate = data.candidates.find(item => item.id === candidateId);
    if (!candidate) return null;
    const role = data.roles.find(item => item.id === candidate.roleId);
    candidate.document = { name: clean(name, 240) || `Kandidatenprofil${extension}`, mime: safeMime, size: buffer.length, sha256: hash, fileName, uploadedAt: new Date().toISOString() };
    candidate.documentText = extracted;
    candidate.screening = screeningFor(candidate, role);
    candidate.updatedAt = new Date().toISOString();
    return { candidate: publicCandidate(candidate, { includeText: true }), fileName, roleId: candidate.roleId };
  });
  if (!result) {
    await fs.rm(filePath, { force: true }).catch(() => {});
    return null;
  }
  if (existing.document?.fileName && existing.document.fileName !== fileName) {
    await fs.rm(path.join(directory, existing.document.fileName), { force: true }).catch(() => {});
  }
  return result.candidate;
}

export async function readRecruitingCandidateDocument(candidateId) {
  const candidate = (await loadStore()).candidates.find(item => item.id === candidateId);
  if (!candidate?.document?.fileName) return null;
  const buffer = await fs.readFile(path.join(FILES_DIR, candidate.roleId, candidate.id, candidate.document.fileName));
  return { meta: clone(candidate.document), buffer };
}

export { PIPELINE_STATUSES };
