import { createProject, getProject, listProjects } from '../projects/store.js';
import { getOpportunity, linkOpportunityProject } from './store.js';

let creationQueue = Promise.resolve();

const clean = (value, max = 3000) => String(value ?? '').trim().slice(0, max);

function workflow(id, name, purpose, nextStep) {
  return {
    id,
    name,
    status: 'planned',
    enabled: false,
    schedule: 'Noch festzulegen',
    execution: 'IVA/Codex · bevorzugt über den zentralen iMac-Kanal',
    purpose,
    safety: 'Zugänge sicher verbinden; nichts veröffentlichen, versenden oder kostenpflichtig schalten, bevor der jeweilige Auftrag und erforderliche Freigaben vorliegen.',
    nextStep,
  };
}

export function opportunityProjectBlueprint(opportunity = {}) {
  const title = clean(opportunity.title, 180) || 'Neue Chancenidee';
  const validation = clean(opportunity.firstValidation, 1500) || 'Zielgruppe, Bedarf und Zahlungsbereitschaft mit einem kleinen belegbaren Test validieren.';
  const offer = clean(opportunity.offer || opportunity.monetization, 1200) || 'Angebot, Nutzenversprechen und Erlösmodell schärfen.';
  const sourceUrls = (opportunity.sources || []).map(source => ({
    url: clean(source?.url, 1200),
    account: clean(source?.account, 160),
    signal: clean(source?.signal, 700),
  })).filter(source => source.url || source.signal).slice(0, 12);
  return {
    name: title,
    company: title,
    category: 'Chancenradar · Neues Geschäftsprojekt',
    status: 'idea',
    description: clean(opportunity.summary, 5000) || 'Aus IVAs Chancenradar übernommene, quellengeprüfte Projektidee.',
    objective: `Die Chance „${title}“ erst belastbar validieren und anschließend als eigenständige Marke mit verbundenen Kanälen, laufender Content-Produktion und messbarem Vertriebsweg aufbauen.`,
    origin: {
      type: 'opportunity-radar',
      opportunityId: clean(opportunity.id, 100),
      score: Math.max(0, Math.min(100, Number(opportunity.score) || 0)),
      title,
      summary: clean(opportunity.summary, 3000),
      customer: clean(opportunity.customer, 1000),
      offer,
      monetization: clean(opportunity.monetization, 1200),
      aiLeverage: clean(opportunity.aiLeverage, 1500),
      firstValidation: validation,
      evidence: clean(opportunity.evidence, 2500),
      evidenceLimits: clean(opportunity.evidenceLimits, 1800),
      risks: clean(opportunity.risks, 1800),
      setupHours: Math.max(0, Number(opportunity.setupHours) || 0),
      ongoingHoursPerWeek: Math.max(0, Number(opportunity.ongoingHoursPerWeek) || 0),
      initialBudgetEur: Math.max(0, Number(opportunity.initialBudgetEur) || 0),
      sources: sourceUrls,
      createdAt: new Date().toISOString(),
    },
    areas: [
      { id: 'opportunity-validation', name: 'Chance & Validierung', status: 'planned', owner: 'IVA Strategy', summary: `${validation} Alle Annahmen, Belege und Ergebnisse bleiben in dieser Projektakte.`, nextStep: validation },
      { id: 'brand-offer', name: 'Marke & Angebot', status: 'planned', owner: 'IVA Brand', summary: offer, nextStep: 'Name, Zielgruppe, Positionierung, Angebot und Markenprofil verbindlich ausarbeiten.' },
      { id: 'channels', name: 'Kanäle & Zugänge', status: 'planned', owner: 'IVA Integrations', summary: 'Website, Instagram, Meta und LinkedIn werden je nach Zielgruppe einzeln verbunden und verifiziert.', nextStep: 'Benötigte Kanäle auswählen und die jeweiligen Verbindungs-Workflows fertigstellen.' },
      { id: 'content-growth', name: 'Content & Wachstum', status: 'planned', owner: 'IVA Marketing', summary: 'Content-Strategie, Produktionssystem, Redaktionsplan, Publishing und Auswertung werden aus Chance und Markenprofil aufgebaut.', nextStep: 'Content-System fertig bauen und mit einem ersten belegten Content-Paket testen.' },
    ],
    phases: [
      { phase: 1, name: 'Potenzial validieren', status: 'planned', result: 'Belegte Zielgruppe, Problem, Angebot und Go-/No-Go-Entscheidung.' },
      { phase: 2, name: 'Marke und Fundament', status: 'planned', result: 'Markenprofil, Positionierung, Angebot und Landingpage-Grundlage.' },
      { phase: 3, name: 'Kanäle verbinden', status: 'planned', result: 'Benötigte Instagram-, Meta- und LinkedIn-Zugänge sind einzeln verifiziert.' },
      { phase: 4, name: 'Content-Maschine starten', status: 'planned', result: 'Strategie, Formate, erste Inhalte und kontrolliertes Publishing stehen.' },
      { phase: 5, name: 'Messen und skalieren', status: 'planned', result: 'Leads, Reichweite und Conversion werden ausgewertet und optimiert.' },
    ],
    automations: [
      workflow('validate-opportunity', 'Potenzial belastbar validieren', 'Zielgruppe, Problem, Zahlungsbereitschaft, Konkurrenz und kleinsten Markttest prüfen; danach eine klare Go-/No-Go-Empfehlung in der Projektakte ablegen.', validation),
      workflow('build-brand-foundation', 'Marke und Angebot ausarbeiten', 'Markenname, Positionierung, Zielgruppe, Tonalität, Nutzenversprechen, Angebot und Markenprofil aus der validierten Chance entwickeln.', 'Validierungsergebnis übernehmen und ein vollständiges Markenfundament erstellen.'),
      workflow('build-landing-page', 'Website oder Landingpage bauen', 'Eine hochwertige, messbare Landingpage mit passender Botschaft, Lead-Ziel und rechtlich erforderlichen Grundlagen erstellen.', 'Domain, Zielaktion und benötigte Inhalte klären und die Seite live ausliefern.'),
      workflow('connect-instagram', 'Instagram verbinden', 'Das passende Instagram-Profil sicher anbinden und für Content, Veröffentlichung und spätere Auswertung vorbereiten.', 'Bestehendes oder neues Zielprofil bestimmen, Verbindung herstellen und lesend verifizieren.'),
      workflow('connect-meta', 'Meta Business verbinden', 'Meta Business, Facebook-Seite und erforderliche Instagram-/Werbekonto-Zuordnungen kontrolliert verbinden.', 'Vorhandene Meta-Assets ermitteln, Rechte prüfen und die benötigten Verbindungen verifizieren.'),
      workflow('connect-linkedin', 'LinkedIn verbinden', 'LinkedIn-Unternehmensseite oder persönliches Zielprofil für den freigegebenen Content- und Vertriebsweg anbinden.', 'Zielprofil und zulässigen Veröffentlichungsweg festlegen und technisch prüfen.'),
      workflow('build-content-system', 'Content-System aufbauen', 'Aus Marke, Zielgruppe, Chance und Referenzen eine wiederholbare Content-Strategie mit Formaten, Hooks, Skripten, Bildern und Redaktionsplan bauen.', 'Drei Kernformate definieren und ein erstes vollständiges Content-Paket erzeugen.'),
      workflow('publishing-analytics-loop', 'Publishing und Auswertung verbinden', 'Freigegebene Inhalte planbar veröffentlichen, Ergebnisse messen und daraus konkrete Optimierungen für die nächsten Inhalte ableiten.', 'Freigabestufe, Frequenz, Zielkennzahlen und Reporting-Rhythmus festlegen.'),
    ],
    existingCapabilities: [clean(opportunity.aiLeverage, 3000), clean(opportunity.evidence, 3000)].filter(Boolean),
    missingCapabilities: ['Validierung abschließen', 'Markenfundament erstellen', 'Zielkanäle verbinden', 'Content-System starten', 'Publishing und Analytics verifizieren'],
  };
}

async function createProjectNow(opportunityId) {
  const opportunity = await getOpportunity(opportunityId);
  if (!opportunity) throw new Error('Chance nicht gefunden.');
  if (opportunity.projectId) {
    const linked = await getProject(opportunity.projectId);
    if (linked) return { created: false, project: linked, opportunity };
  }
  const existing = (await listProjects()).find(project => project.origin?.type === 'opportunity-radar' && project.origin?.opportunityId === opportunity.id);
  if (existing) {
    const updatedOpportunity = await linkOpportunityProject(opportunity.id, existing.id, existing.origin?.createdAt);
    return { created: false, project: existing, opportunity: updatedOpportunity };
  }
  const project = await createProject(opportunityProjectBlueprint(opportunity));
  const updatedOpportunity = await linkOpportunityProject(opportunity.id, project.id, project.origin?.createdAt || new Date().toISOString());
  return { created: true, project, opportunity: updatedOpportunity };
}

export async function createProjectFromOpportunity(opportunityId, { confirmed = false } = {}) {
  if (confirmed !== true) throw new Error('Bitte die Projekterstellung zuerst ausdrücklich bestätigen.');
  const job = creationQueue.catch(() => {}).then(() => createProjectNow(clean(opportunityId, 100)));
  creationQueue = job.catch(() => {});
  return job;
}
