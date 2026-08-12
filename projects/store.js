import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = process.env.DATA_DIR || '/data';
const STORE_FILE = path.join(DATA_DIR, 'projects.json');
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
function normalizeItem(item = {}, fallback = {}) {
  return {
    ...clone(fallback), ...clone(item),
    id: clean(item.id || fallback.id, 100) || crypto.randomUUID(),
    name: clean(item.name || fallback.name, 220) || 'Neuer Eintrag',
    status: ITEM_STATUSES.has(item.status) ? item.status : (ITEM_STATUSES.has(fallback.status) ? fallback.status : 'planned'),
  };
}
function mergeById(input = [], fallback = []) {
  const ids = [...new Set([...fallback, ...input].map(item => item?.id).filter(Boolean))];
  return ids.map(id => normalizeItem(input.find(item => item?.id === id) || {}, fallback.find(item => item?.id === id) || {}));
}
function normalizeProject(input = {}, fallback = {}) {
  return {
    ...clone(fallback), ...clone(input),
    id: clean(input.id || fallback.id, 100) || crypto.randomUUID(),
    name: clean(input.name || fallback.name, 180) || 'Neues Projekt',
    status: PROJECT_STATUSES.has(input.status) ? input.status : (PROJECT_STATUSES.has(fallback.status) ? fallback.status : 'planned'),
    areas: mergeById(Array.isArray(input.areas) ? input.areas : [], fallback.areas || []),
    phases: mergeById(Array.isArray(input.phases) ? input.phases : [], fallback.phases || []),
    automations: mergeById(Array.isArray(input.automations) ? input.automations : [], fallback.automations || []),
  };
}
async function loadStore() {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE_FILE, 'utf8'));
    const saved = Array.isArray(parsed?.projects) ? parsed.projects : [];
    const heatHero = normalizeProject(saved.find(item => item.id === 'heat-hero') || {}, HEAT_HERO_PROJECT);
    return { version: 1, projects: [heatHero, ...saved.filter(item => item.id !== 'heat-hero').map(item => normalizeProject(item))] };
  } catch { return { version: 1, projects: [clone(HEAT_HERO_PROJECT)] }; }
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
export async function listProjects() { return clone((await loadStore()).projects).sort((a,b)=>a.name.localeCompare(b.name,'de')); }
export async function getProject(id) { const item=(await loadStore()).projects.find(project=>project.id===clean(id,100)); return item?clone(item):null; }
export async function createProject(input = {}) { return mutate(store => { const project=normalizeProject(input); if(store.projects.some(item=>item.id===project.id))throw new Error('Projekt-ID ist bereits vorhanden.'); store.projects.push(project); return clone(project); }); }
export async function updateProject(id, patch = {}) { return mutate(store => { const index=store.projects.findIndex(item=>item.id===clean(id,100)); if(index<0)return null; store.projects[index]=normalizeProject({...store.projects[index],...patch,id:store.projects[index].id},store.projects[index]); return clone(store.projects[index]); }); }
