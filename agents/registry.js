// Agent-Registry: IVA bleibt die zentrale Ansprechpartnerin. Fachagenten sind
// keine getrennten Datensilos, sondern eng berechtigte Arbeitsrollen auf dem
// gemeinsamen IVA-Core. Der Router waehlt deterministisch; unbekannte oder
// deaktivierte Agenten fallen sicher auf IVA Standard zurueck.

const STANDARD_SKILLS = ['memory', 'calendar', 'mails', 'crm', 'marketing', 'research', 'workspaces', 'advice', 'opportunities', 'accounting', 'energyTariffs', 'selfImprovement', 'qonekto'];

export const AGENTS = {
  'iva-standard': {
    id: 'iva-standard', name: 'IVA · Zentrale', shortName: 'IVA', enabled: true,
    description: 'Versteht das Anliegen, koordiniert Fachagenten und behaelt Freigaben sowie Gesamtzusammenhang im Blick.',
    rolePrompt: 'Du bist IVAs zentrale Koordinationsrolle. Bearbeite gemischte oder unklare Anliegen selbst und halte Fachgrenzen, Quellen sowie Freigaben sichtbar.',
    knowledgeSources: ['project-docs', 'memory', 'crm', 'mails', 'calendar', 'calendly', 'qonekto', 'advice-knowledge'],
    allowedSkills: STANDARD_SKILLS, modelProfile: 'chat', safetyDefault: 'operational', color: 'cyan',
  },
  'iva-customer': {
    id: 'iva-customer', name: 'Kunden & Backoffice', shortName: 'Kunden', enabled: true,
    description: 'Kundenakten, CRM, Qonekto/blau direkt, Termine, Mails, Dokumente und Servicevorgaenge.',
    rolePrompt: 'Arbeite als Kunden- und Backoffice-Agent. Qonekto/blau direkt ist fachliche Stammdatenquelle. Lies zuerst, vermeide Dubletten und bereite jede Aenderung nur ueber den vorgesehenen Bestaetigungsweg vor.',
    knowledgeSources: ['crm', 'qonekto', 'mails', 'calendar', 'workspaces'],
    allowedSkills: ['memory', 'calendar', 'mails', 'crm', 'workspaces', 'qonekto', 'selfImprovement'], modelProfile: 'chat', safetyDefault: 'operational', color: 'blue',
  },
  'iva-finance': {
    id: 'iva-finance', name: 'Beratung & Fachpruefung', shortName: 'Beratung', enabled: true,
    description: 'Finanz- und Versicherungsberatung, quellenbasierte Vergleiche, Beratungsakten und DIN-orientierte Vorbereitung.',
    rolePrompt: 'Arbeite als Beratungs- und Fachpruefungs-Agent. Produktleistungen nur aus belegten Originalquellen nennen. Fehlende Tarifstaende offen markieren. Modellrechnungen, DIN-Vorbereitung und rechtlich relevante Aussagen niemals als gepruefte Endfreigabe ausgeben.',
    knowledgeSources: ['advice-knowledge', 'qonekto', 'workspaces', 'project-docs'],
    allowedSkills: ['advice', 'research', 'workspaces', 'qonekto', 'selfImprovement'], modelProfile: 'chat', safetyDefault: 'liability', color: 'violet',
  },
  'iva-marketing': {
    id: 'iva-marketing', name: 'Marketing & Growth', shortName: 'Marketing', enabled: true,
    description: 'Marktanalyse, Content, Kampagnen, Ads-Auswertung, Lead-Recherche und Chancenradar.',
    rolePrompt: 'Arbeite als Marketing- und Growth-Agent. Trenne Research, Entwurf, Freigabe und Publishing. Keine unbelegte Erfolgsbehauptung, kein automatischer Outreach und keine Budgetaenderung ohne den vorgesehenen Freigabesatz.',
    knowledgeSources: ['brand-profiles', 'campaigns', 'public-research', 'opportunities'],
    allowedSkills: ['marketing', 'research', 'opportunities', 'selfImprovement'], modelProfile: 'chat', safetyDefault: 'operational', color: 'mint',
  },
  'iva-energy': {
    id: 'iva-energy', name: 'Energie & Vor Ort', shortName: 'Energie', enabled: true,
    description: 'TMB, Foto-Checkliste, Gebaeudedaten, Heizlast-Vorplanung, Foerdercheck und Energie-Fallakten.',
    rolePrompt: 'Arbeite als Energie- und Vor-Ort-Agent. Verwende die deterministischen IVA-Rechenwege, erfinde keine Gebaeudedaten und nenne Vorplanung niemals Normnachweis oder Foerderzusage. Fehlende Pflichtangaben gezielt abfragen.',
    knowledgeSources: ['workspaces', 'energy-rules', 'customer-context'],
    allowedSkills: ['workspaces', 'energyTariffs', 'research', 'qonekto', 'selfImprovement'], modelProfile: 'chat', safetyDefault: 'liability', color: 'amber',
  },
  'iva-accounting': {
    id: 'iva-accounting', name: 'Buchhaltung & Controlling', shortName: 'Buchhaltung', enabled: true,
    description: 'Belegstatus, Rechtstraeger, Monatsvollstaendigkeit und Steuerberater-Vorbereitung.',
    rolePrompt: 'Arbeite als Buchhaltungs- und Controlling-Agent. Ordne und pruefe nachvollziehbar, aber gib keine unbelegte steuerliche Absetzbarkeitszusage und reiche nichts ein. Aenderungen an Belegen bleiben vorerst in der Buchhaltungsoberflaeche.',
    knowledgeSources: ['accounting', 'project-docs'],
    allowedSkills: ['accounting', 'research', 'selfImprovement'], modelProfile: 'chat', safetyDefault: 'liability', color: 'green',
  },
  'iva-sales': {
    id: 'iva-sales', name: 'Sales & Gespraechscoach', shortName: 'Sales', enabled: true,
    description: 'Vorbereitung, Einwandbehandlung, Gespraechsstruktur und Nachbereitung. Live-Audio folgt mit der Mac-App.',
    rolePrompt: 'Arbeite als Sales-Coach. Gib kurze, konkrete Formulierungen, achte auf Bedarf, Redeanteil, Einwaende und naechste Frage. Behaupte nie, ein Meeting live mitzuhören, solange keine aktive Audio-Session vorliegt.',
    knowledgeSources: ['crm', 'advice-knowledge', 'sales-guides'],
    allowedSkills: ['crm', 'advice', 'research', 'qonekto', 'selfImprovement'], modelProfile: 'chat', safetyDefault: 'operational', color: 'rose',
  },
  'iva-knowledge': {
    id: 'iva-knowledge', name: 'Wissen & Kurse', shortName: 'Wissen', enabled: false,
    description: 'Versionierte Wissenspakete und Kursproduktion. Wird nach sicherem Quellenimport aktiviert.',
    rolePrompt: null, knowledgeSources: [], allowedSkills: [], modelProfile: 'chat', safetyDefault: 'operational', color: 'slate',
  },
  'iva-builder': {
    id: 'iva-builder', name: 'Entwicklung & QA', shortName: 'Builder', enabled: false,
    description: 'Bauvorschlaege, Tests, Vorschau und Rollback. Bleibt deaktiviert, bis Git- und Deployment-Freigaben getrennt sind.',
    rolePrompt: null, knowledgeSources: [], allowedSkills: [], modelProfile: 'chat', safetyDefault: 'operational', color: 'slate',
  },
};

const ROUTES = [
  { agentId: 'iva-accounting', reason: 'Buchhaltung erkannt', pattern: /\b(buchhaltung|beleg|rechnung|eür|steuerberater|umsatzsteuer|vorsteuer|bewirtung)\b/i },
  { agentId: 'iva-energy', reason: 'Energie/Vor-Ort erkannt', pattern: /\b(tmb|wärmepumpe|waermepumpe|heizlast|heizkörper|heizkoerper|photovoltaik|\bpv\b|förderrechner|foerderrechner|energieplan|grundriss|stromtarif|gasvertrag|gastarif|energypartner|tarifrechner)\b/i },
  { agentId: 'iva-marketing', reason: 'Marketing/Growth erkannt', pattern: /\b(marketing|content|instagram|facebook|linkedin|kampagne|werbeanzeige|\bads?\b|reel|hashtag|mitbewerber|marktanalyse|leadgen|chancenradar)\b/i },
  { agentId: 'iva-sales', reason: 'Sales-Coaching erkannt', pattern: /\b(sales|closing|closer|einwand|verkaufsgespräch|verkaufsgespraech|redeanteil|abschlussfrage|gesprächscoach|gespraechscoach)\b/i },
  { agentId: 'iva-finance', reason: 'Beratung/Fachvergleich erkannt', pattern: /\b(finanzberatung|altersvorsorge(?:beratung|planung)?|depot(?:vergleich)?|hausratvergleich|vertragsvergleich|din 7723|versicherung vergleichen|beratungsakte|rentenberechnung|gkv-vergleich)\b/i },
  { agentId: 'iva-customer', reason: 'Kunden/Backoffice erkannt', pattern: /\b(kunde|kundenakte|qonekto|blau direkt|gesellschaft anschreiben|adressänderung|adressaenderung|bankdatenänderung|bankdatenaenderung|schadenmeldung|vertrag|police)\b/i },
];

export function getAgent(id = 'iva-standard') {
  const agent = AGENTS[id];
  if (agent?.enabled) return agent;
  return AGENTS['iva-standard'];
}

export function routeAgent(text = '', requestedId = '') {
  if (requestedId && requestedId !== 'iva-standard' && AGENTS[requestedId]?.enabled) {
    return { agent: AGENTS[requestedId], reason: 'explizit gewaehlt', automatic: false };
  }
  const route = ROUTES.find(item => item.pattern.test(String(text || '')) && AGENTS[item.agentId]?.enabled);
  return route
    ? { agent: AGENTS[route.agentId], reason: route.reason, automatic: true }
    : { agent: AGENTS['iva-standard'], reason: 'zentrale Bearbeitung', automatic: true };
}

export function listAgents() {
  return Object.values(AGENTS).map(agent => ({
    id: agent.id, name: agent.name, shortName: agent.shortName, description: agent.description,
    enabled: agent.enabled, allowedSkills: agent.allowedSkills, modelProfile: agent.modelProfile,
    safetyDefault: agent.safetyDefault, color: agent.color,
  }));
}
