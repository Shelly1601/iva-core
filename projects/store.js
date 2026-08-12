import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = process.env.DATA_DIR || '/data';
const STORE_FILE = path.join(DATA_DIR, 'projects.json');
const PROJECT_FILES_DIR = path.join(DATA_DIR, 'project-files');
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const PROJECT_STATUSES = new Set(['idea', 'planned', 'prepared', 'active', 'paused', 'complete']);
const ITEM_STATUSES = new Set(['idea', 'planned', 'foundation', 'prepared', 'active', 'paused', 'blocked', 'complete']);
let writeQueue = Promise.resolve();

export const HEAT_HERO_PROJECT = {
  id: 'heat-hero',
  name: 'Heat Hero',
  company: 'Heat Hero',
  category: 'Vertrieb · Wärmepumpen · Photovoltaik',
  status: 'planned',
  description: 'Zentrale Projektakte für Innendienstvertrieb, Hersteller-Leads, Energieplanung, Angebot und operative Automationen.',
  objective: 'HeatHero CRM bleibt die führende Vertriebsquelle. IVA verbindet Leadübernahme, digitale Kundenaufnahme, TMB, technische Planung, Angebot und Herstellerrückmeldung ohne doppelte Dateneingabe.',
  areas: [
    { id: 'inside-sales', name: 'Innendienstvertrieb', status: 'planned', summary: 'Geführter digitaler Beratungsprozess vom Lead bis zum Abschluss.', nextStep: 'Kundenlink und Live-Aufnahme im Videocall bauen.' },
    { id: 'customer-capture', name: 'Kundenaufnahme im Videocall', status: 'foundation', summary: 'Grundriss, Maße, Fotos, Heizkörper und Gebäudedaten in einer Fallakte erfassen.', nextStep: 'Foto-/Maßprüfung und Live-Fortschritt ergänzen.' },
    { id: 'energy', name: 'TMB, 3D und Energieplanung', status: 'foundation', summary: 'TMB, Räume, Heizlast, Leitungsweg, PV und technische Machbarkeit.', nextStep: '3D-Review und fachlich abgenommene Heizlast-Engine ergänzen.' },
    { id: 'sales-coach', name: 'KI-Sales-Coach', status: 'planned', summary: 'Bestätigte Gesprächsdaten als belegte TMB-Feldvorschläge.', nextStep: 'Quelle, Zeitstempel, Confidence und Beraterbestätigung verbinden.' },
    { id: 'quote', name: 'Angebots-KI', status: 'planned', summary: 'Geprüfte Fallakte plus Preislisten und Stücklistenregeln ergeben ein Angebot.', nextStep: 'Preislisten und Beispielangebote versioniert aufnehmen.' },
    { id: 'manufacturer-leads', name: 'Panasonic- und Bosch-Leads', status: 'prepared', summary: 'Leads nach Gebiet übernehmen und im CRM anlegen.', nextStep: 'Passwörter rotieren, Gebiete eintragen und Trockenlauf durchführen.' },
    { id: 'manufacturer-feedback', name: 'Hersteller-Rückmeldungen', status: 'planned', summary: 'Belegte CRM-Fortschritte in Herstellerportale zurückmelden.', nextStep: 'Portalstatus aufnehmen und Mapping freigeben.' },
    { id: 'wattfox', name: 'Wattfox und Regler', status: 'prepared', summary: 'Rückmeldungen täglich auswerten und wöchentlich abgleichen.', nextStep: 'Outlook-Ordnerzugriff auf dem iMac testen.' },
    { id: 'planbar', name: 'Planbar und Herstellerlisten', status: 'active', summary: 'Sechs-Wochen-Liste und Hersteller-PDFs freitags erzeugen.', nextStep: 'Produktiven Lauf und Sendelog kontrollieren.' },
  ],
  phases: [
    { phase: 1, name: 'Geführte Kundenaufnahme', status: 'planned', result: 'Kundenlink, Videocall-Cockpit, Fotoaufgaben, Maße und Live-Vollständigkeit.' },
    { phase: 2, name: 'Sales Coach → TMB', status: 'planned', result: 'Gesprächsdaten werden als belegte Feldvorschläge vorbereitet.' },
    { phase: 3, name: '3D und technische Engine', status: 'planned', result: 'Bestätigter Grundriss, Leitungsweg und fachlich abgenommene Heizlast.' },
    { phase: 4, name: 'Angebots-KI', status: 'planned', result: 'Versionierte Kalkulation aus Preislisten und geprüfter Fallakte.' },
    { phase: 5, name: 'CRM-/Herstellerkreislauf', status: 'prepared', result: 'Fortschrittsabgleich zwischen CRM, Panasonic, Bosch und Reporting.' },
  ],
  automations: [
    { id: 'planbar-weekly', name: 'Planbar-Kundenliste und Hersteller-PDFs', status: 'active', schedule: 'Freitag · 18:00 Uhr', execution: 'iMac · Chrome und Outlook', purpose: 'Sechs kommende Kalenderwochen aufbereiten und geprüft an Angelo senden.', safety: 'Kein Versand bei falschen Empfängern, unvollständigen Anlagen oder Doppelversand.', nextStep: 'Ersten produktiven Lauf kontrollieren.' },
    { id: 'manufacturer-daily', name: 'Panasonic-/Bosch-Leads und Wattfox', status: 'paused', schedule: 'Täglich · 21:00 Uhr', execution: 'iMac · Outlook, Chrome und Ente Auth', purpose: 'Leads übernehmen, CRM-Anlage und Vertriebszuordnung prüfen sowie Wattfox auswerten.', safety: 'Keine Schreibaktion ohne Gebiete, Passwortwechsel, bestätigten iMac und Trockenlauf.', nextStep: 'Readiness vollständig herstellen und Trockenlauf freigeben.' },
    { id: 'manufacturer-feedback', name: 'CRM-Fortschritt an Hersteller', status: 'planned', schedule: 'Geplant: täglich nach dem Leadlauf', execution: 'HeatHero CRM → Herstellerportale', purpose: 'Belegte CRM-Fortschritte ohne Double Handling zurückmelden.', safety: 'Nur feste IDs, erlaubte Vorwärtsübergänge und sichtbare Portalverifikation.', nextStep: 'Panasonic-/Bosch-Statuslisten aufnehmen und mappen.' },
    { id: 'customer-preflight', name: 'Kundenvorbereitung', status: 'planned', schedule: 'Geplant: nach Terminbuchung', execution: 'IVA-Kundenlink', purpose: 'Zollstock, Grundriss und Verbrauchsnachweis vor dem Videotermin vorbereiten.', safety: 'Kein kompliziertes Konto; nur notwendige Unterlagen.', nextStep: 'Kundenlink und Live-Fortschritt bauen.' },
    { id: 'sales-coach-tmb', name: 'Sales Coach → TMB', status: 'planned', schedule: 'Geplant: im Videotermin', execution: 'IVA Sales Coach und Energie-Fallakte', purpose: 'Bestätigte Aussagen als TMB-Feldvorschläge übernehmen.', safety: 'Einwilligung und Beraterbestätigung für technische Pflichtwerte.', nextStep: 'Transkript, Feldvorschläge und Qualitätsgates verbinden.' },
    { id: 'quote-generation', name: 'Angebot aus Energie-Fallakte', status: 'planned', schedule: 'Geplant: auf Knopfdruck', execution: 'IVA Angebots-KI', purpose: 'Aus Planung, Stückliste und Preislisten ein Angebot erzeugen.', safety: 'Nur bei grünen Pflichtgates und gültigem Preisstand.', nextStep: 'Preislisten und Kalkulationsregeln aufnehmen.' },
  ],
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function clean(value, max = 5000) { return String(value ?? '').trim().slice(0, max); }
function projectFileDir(projectId) {
  const safeId = clean(projectId, 100);
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(safeId)) throw new Error('Ungültige Projekt-ID.');
  return path.join(PROJECT_FILES_DIR, safeId);
}
function iso(value) {
  const parsed = new Date(value || Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}
function normalizeNote(note = {}) {
  return {
    id: clean(note.id, 100) || crypto.randomUUID(),
    text: clean(note.text, 12000),
    source: clean(note.source, 80) || 'manual',
    createdAt: iso(note.createdAt),
  };
}
function normalizeFolder(folder = {}) {
  return {
    id: clean(folder.id, 100) || crypto.randomUUID(),
    name: clean(folder.name, 180) || 'Neuer Ordner',
    parentId: clean(folder.parentId, 100) || null,
    createdAt: iso(folder.createdAt),
  };
}
function normalizeFile(file = {}) {
  return {
    id: clean(file.id, 100) || crypto.randomUUID(),
    name: clean(file.name, 240) || 'Dokument',
    mime: clean(file.mime, 160) || 'application/octet-stream',
    bytes: Math.max(0, Number(file.bytes) || 0),
    sha256: clean(file.sha256, 128),
    folderId: clean(file.folderId, 100) || null,
    storageName: clean(file.storageName, 300),
    createdAt: iso(file.createdAt),
  };
}
function normalizeItem(item = {}, fallback = {}) {
  const phaseId = item.phase != null || fallback.phase != null ? `phase-${clean(item.phase ?? fallback.phase, 20)}` : '';
  return {
    ...clone(fallback), ...clone(item),
    id: phaseId || clean(item.id || fallback.id, 100) || crypto.randomUUID(),
    name: clean(item.name || fallback.name, 220) || 'Neuer Eintrag',
    status: ITEM_STATUSES.has(item.status) ? item.status : (ITEM_STATUSES.has(fallback.status) ? fallback.status : 'planned'),
  };
}
function mergeById(input = [], fallback = []) {
  const key = item => item?.phase != null ? `phase-${item.phase}` : item?.id;
  const ids = [...new Set([...fallback, ...input].map(key).filter(Boolean))];
  return ids.map(id => normalizeItem(input.find(item => key(item) === id) || {}, fallback.find(item => key(item) === id) || {}));
}
function normalizeProject(input = {}, fallback = {}) {
  const notes = Array.isArray(input.notes) ? input.notes : (fallback.notes || []);
  const folders = Array.isArray(input.folders) ? input.folders : (fallback.folders || []);
  const files = Array.isArray(input.files) ? input.files : (fallback.files || []);
  return {
    ...clone(fallback), ...clone(input),
    id: clean(input.id || fallback.id, 100) || crypto.randomUUID(),
    name: clean(input.name || fallback.name, 180) || 'Neues Projekt',
    company: clean(input.company ?? fallback.company, 180),
    category: clean(input.category ?? fallback.category, 220) || 'Projekt',
    description: clean(input.description ?? fallback.description, 4000),
    objective: clean(input.objective ?? fallback.objective, 4000),
    status: PROJECT_STATUSES.has(input.status) ? input.status : (PROJECT_STATUSES.has(fallback.status) ? fallback.status : 'planned'),
    areas: mergeById(Array.isArray(input.areas) ? input.areas : [], fallback.areas || []),
    phases: mergeById(Array.isArray(input.phases) ? input.phases : [], fallback.phases || []),
    automations: mergeById(Array.isArray(input.automations) ? input.automations : [], fallback.automations || []),
    notes: notes.map(normalizeNote).filter(note => note.text),
    folders: folders.map(normalizeFolder),
    files: files.map(normalizeFile).filter(file => file.storageName),
  };
}
function publicProject(project) {
  const output = clone(project);
  output.files = (output.files || []).map(({ storageName, ...file }) => file);
  return output;
}
async function loadStore() {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE_FILE, 'utf8'));
    const saved = Array.isArray(parsed?.projects) ? parsed.projects : [];
    const deletedProjectIds = Array.isArray(parsed?.deletedProjectIds)
      ? [...new Set(parsed.deletedProjectIds.map(id => clean(id, 100)).filter(Boolean))]
      : [];
    const projects = saved.filter(item => !deletedProjectIds.includes(clean(item?.id, 100))).map(item => normalizeProject(item));
    if (!deletedProjectIds.includes('heat-hero') && !projects.some(item => item.id === 'heat-hero')) {
      projects.unshift(normalizeProject({}, HEAT_HERO_PROJECT));
    } else {
      const index = projects.findIndex(item => item.id === 'heat-hero');
      if (index >= 0) projects[index] = normalizeProject(projects[index], HEAT_HERO_PROJECT);
    }
    return { version: 2, deletedProjectIds, projects };
  } catch { return { version: 2, deletedProjectIds: [], projects: [normalizeProject({}, HEAT_HERO_PROJECT)] }; }
}
async function saveStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, STORE_FILE);
}
async function mutate(fn) {
  let result;
  const job = writeQueue.catch(() => {}).then(async () => { const store = await loadStore(); result = await fn(store); await saveStore(store); });
  writeQueue = job.catch(() => {});
  await job;
  return result;
}
export async function listProjects() {
  return (await loadStore()).projects.map(publicProject).sort((a, b) => a.name.localeCompare(b.name, 'de'));
}
export async function getProject(id) {
  const item = (await loadStore()).projects.find(project => project.id === clean(id, 100));
  return item ? publicProject(item) : null;
}
export async function createProject(input = {}) {
  return mutate(store => {
    const project = normalizeProject({ ...input, id: undefined, notes: [], folders: [], files: [], areas: [], phases: [], automations: [] });
    store.projects.push(project);
    store.deletedProjectIds = (store.deletedProjectIds || []).filter(id => id !== project.id);
    return publicProject(project);
  });
}
export async function updateProject(id, patch = {}) {
  return mutate(store => {
    const index = store.projects.findIndex(item => item.id === clean(id, 100));
    if (index < 0) return null;
    const current = store.projects[index];
    store.projects[index] = normalizeProject({
      ...current,
      ...patch,
      id: current.id,
      notes: current.notes,
      folders: current.folders,
      files: current.files,
    }, current);
    return publicProject(store.projects[index]);
  });
}
export async function addProjectNote(id, text, source = 'manual') {
  const noteText = clean(text, 12000);
  if (!noteText) throw new Error('Bitte zuerst eine Notiz eingeben.');
  return mutate(store => {
    const project = store.projects.find(item => item.id === clean(id, 100));
    if (!project) return null;
    project.notes = [...(project.notes || []), normalizeNote({ text: noteText, source })];
    return publicProject(project);
  });
}
export async function createProjectFolder(id, input = {}) {
  const name = clean(input.name, 180);
  const parentId = clean(input.parentId, 100) || null;
  if (!name) throw new Error('Der Ordner braucht einen Namen.');
  return mutate(store => {
    const project = store.projects.find(item => item.id === clean(id, 100));
    if (!project) return null;
    if (parentId && !(project.folders || []).some(folder => folder.id === parentId)) {
      throw new Error('Der übergeordnete Ordner wurde nicht gefunden.');
    }
    const duplicate = (project.folders || []).some(folder => folder.parentId === parentId && folder.name.localeCompare(name, 'de', { sensitivity: 'base' }) === 0);
    if (duplicate) throw new Error('In diesem Ordner gibt es bereits einen Ordner mit diesem Namen.');
    project.folders = [...(project.folders || []), normalizeFolder({ name, parentId })];
    return publicProject(project);
  });
}
export async function storeProjectFile(id, { name, mime, folderId, buffer }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Die Datei ist leer.');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('Die Datei ist größer als 25 MB.');
  const safeName = clean(name, 240) || 'Dokument';
  const requestedFolderId = clean(folderId, 100) || null;
  return mutate(async store => {
    const project = store.projects.find(item => item.id === clean(id, 100));
    if (!project) return null;
    if (requestedFolderId && !(project.folders || []).some(folder => folder.id === requestedFolderId)) {
      throw new Error('Der Zielordner wurde nicht gefunden.');
    }
    const extension = path.extname(safeName).replace(/[^a-z0-9.]/gi, '').slice(0, 16);
    const storageName = `${crypto.randomUUID()}${extension}`;
    const projectDir = projectFileDir(project.id);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, storageName), buffer, { mode: 0o600 });
    const file = normalizeFile({
      name: safeName,
      mime,
      bytes: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      folderId: requestedFolderId,
      storageName,
    });
    project.files = [...(project.files || []), file];
    return publicProject({ ...project, files: [file] }).files[0];
  });
}
export async function readProjectFile(id, fileId) {
  const project = (await loadStore()).projects.find(item => item.id === clean(id, 100));
  const file = project?.files?.find(item => item.id === clean(fileId, 100));
  if (!project || !file?.storageName) return null;
  const projectDir = projectFileDir(project.id);
  const filePath = path.join(projectDir, file.storageName);
  if (!filePath.startsWith(`${projectDir}${path.sep}`)) return null;
  return { meta: publicProject({ files: [file] }).files[0], buffer: await fs.readFile(filePath) };
}
export async function deleteProject(id) {
  const projectId = clean(id, 100);
  const deleted = await mutate(store => {
    const index = store.projects.findIndex(item => item.id === projectId);
    if (index < 0) return null;
    const [project] = store.projects.splice(index, 1);
    store.deletedProjectIds = [...new Set([...(store.deletedProjectIds || []), project.id])];
    return publicProject(project);
  });
  if (!deleted) return null;
  const projectDir = projectFileDir(projectId);
  if (projectDir.startsWith(`${PROJECT_FILES_DIR}${path.sep}`)) await fs.rm(projectDir, { recursive: true, force: true });
  return deleted;
}
