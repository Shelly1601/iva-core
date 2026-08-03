// Agent-Registry. Ausschliesslich Konfiguration - keine Fachlogik. Alle
// Agenten teilen denselben Chat-Loop, denselben Model-Router und dieselben
// Skill-Registrierungen. Was einen Agenten von einem anderen unterscheidet:
//   - rolePrompt: null bedeutet "Standard-Prompt aus buildSystemPrompt(index.js)"
//   - knowledgeSources: welche persistierten Quellen im Prompt-Kontext beruecksichtigt werden (heute rein deklarativ)
//   - allowedSkills: welche Skill-IDs registriert werden (siehe skills/*.js)
//   - modelProfile: welches Task-Profil (siehe core/router.js) benutzt wird
//   - safetyDefault: creative | operational | liability (fuer spaetere Sicherheitsprueflogik)
//   - enabled: nur enabled=true Agenten sind aufrufbar; disabled Vorlagen dienen der
//              spaeteren Befuellung ohne UI/Verhaltensaenderung heute
//
// Nur "iva-standard" ist aktiviert. Die anderen drei Vorlagen sind bewusst
// leer und deaktiviert - sie erzeugen weder UI noch neues Verhalten.

const ALL_SKILLS = ['memory', 'calendar', 'mails', 'crm', 'marketing', 'research', 'workspaces', 'advice', 'qonekto'];

export const AGENTS = {
  'iva-standard': {
    id: 'iva-standard',
    name: 'IVA (Standard)',
    enabled: true,
    rolePrompt: null, // Signal: buildSystemPrompt() im index.js liefert den Prompt (bestehendes Verhalten)
    knowledgeSources: ['project-docs', 'memory', 'crm', 'mails', 'calendar', 'calendly', 'qonekto', 'advice-knowledge'],
    allowedSkills: ALL_SKILLS,
    modelProfile: 'chat',
    safetyDefault: 'operational',
  },
  'iva-marketing': {
    id: 'iva-marketing',
    name: 'IVA Marketing',
    enabled: false, // Vorlage - noch nicht aktivieren
    rolePrompt: null,
    knowledgeSources: [],
    allowedSkills: [],
    modelProfile: 'chat',
    safetyDefault: 'operational',
  },
  'iva-finance': {
    id: 'iva-finance',
    name: 'IVA Finance',
    enabled: false, // Vorlage - noch nicht aktivieren
    rolePrompt: null,
    knowledgeSources: [],
    allowedSkills: [],
    modelProfile: 'chat',
    safetyDefault: 'operational',
  },
  'iva-sales': {
    id: 'iva-sales',
    name: 'IVA Sales',
    enabled: false, // Vorlage - noch nicht aktivieren
    rolePrompt: null,
    knowledgeSources: [],
    allowedSkills: [],
    modelProfile: 'chat',
    safetyDefault: 'operational',
  },
};

// Liefert den angeforderten Agenten. Wenn id nicht existiert oder disabled ist,
// wird der Default-Agent (iva-standard) zurueckgegeben. Damit ist askIva/streamIva
// robust gegen unbekannte oder deaktivierte agentId-Werte.
export function getAgent(id = 'iva-standard') {
  const a = AGENTS[id];
  if (a && a.enabled) return a;
  return AGENTS['iva-standard'];
}

// Fuer Introspection (Tests, spaetere UI).
export function listAgents() {
  return Object.values(AGENTS).map(a => ({ id: a.id, name: a.name, enabled: a.enabled, allowedSkills: a.allowedSkills, modelProfile: a.modelProfile }));
}
