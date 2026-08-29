// Agent-Registry: IVA bleibt die zentrale Ansprechpartnerin. Fachagenten sind
// keine getrennten Datensilos, sondern eng berechtigte Arbeitsrollen auf dem
// gemeinsamen IVA-Core. Der Router waehlt deterministisch; unbekannte oder
// deaktivierte Agenten fallen sicher auf IVA Standard zurueck.

const STANDARD_SKILLS = ['memory', 'calendar', 'mails', 'crm', 'pipedrive', 'marketing', 'research', 'workspaces', 'advice', 'opportunities', 'accounting', 'energyTariffs', 'selfImprovement', 'builder', 'qonekto', 'lumit', 'capabilityReview', 'knowledgeLibrary', 'recruiting', 'deviceControl', 'planbar', 'investment'];

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
    rolePrompt: 'Arbeite als Kunden- und Backoffice-Agent. Qonekto/blau direkt ist fachliche Stammdatenquelle. Lies zuerst und vermeide Dubletten. Wenn Nadine einen ganzen Planbar-, Airtable- oder Backoffice-Workflow auf dem iMac ausfuehren laesst, verwende runTaskOnImac und verfolge danach Gerätebefehl und inneren Task bis zum Endstatus; Einreihen allein ist kein Ergebnis. Wenn Nadine einen Kunden mit eindeutiger Kalenderwoche terminieren laesst, klaere nur fehlende Pflichtangaben: Partner/Kundentyp, beide Materialantworten und bei Enter, ob ohne passenden ENTER-Block ersatzweise ein vollstaendig freier Fuenf-Tage-Platz erlaubt ist. Standard: Heat Hero=HH und freier Platz, Enter=EN und ENTER-Block zuerst, D Warmte=DW und freier Platz; zusaetzliche gespeicherte Partnerkuerzel werden entsprechend verwendet. Starte danach scheduleCustomerInPlanbar sofort; der konkrete Terminierungsauftrag ist selbst die Freigabe. Andere Aenderungen laufen weiter ueber den jeweils vorgesehenen Bestaetigungsweg. Bei LUMIT gilt zwingend: Onlineabschluss ueber Agentur 162-58556, Vermittlernummer 009T7N pruefen, danach servicierter Antrag, Mail an den Mannheimer-Poolservice, Dokument in die Blau-direkt-Kundenakte und Uebergabe an Hauswertschutz. Fordere die Police ausschliesslich digital ueber den Vermittler an, behaupte diesen Versandweg aber erst nach Bestaetigung durch Mannheimer/blau direkt. Nach Policeneingang: nichts automatisch an den Kunden senden; erst Hauswertschutz-Pruefung, kompaktes Markenpaket mit unveraenderter Originalpolice und lesbarer Vertrags-/Preisaufteilung, dann ausdrueckliche Freigabe.',
    knowledgeSources: ['crm', 'qonekto', 'mails', 'calendar', 'workspaces', 'lumit-workflow'],
    allowedSkills: ['memory', 'calendar', 'mails', 'crm', 'pipedrive', 'workspaces', 'qonekto', 'lumit', 'selfImprovement', 'deviceControl', 'planbar'], modelProfile: 'chat', safetyDefault: 'operational', color: 'blue',
  },
  'iva-finance': {
    id: 'iva-finance', name: 'Beratung & Fachpruefung', shortName: 'Beratung', enabled: true,
    description: 'Finanz- und Versicherungsberatung, quellenbasierte Vergleiche, Beratungsakten und DIN-orientierte Vorbereitung.',
    rolePrompt: 'Arbeite als Beratungs- und Fachpruefungs-Agent. Produktleistungen nur aus belegten Originalquellen nennen. Fehlende Tarifstaende offen markieren. Modellrechnungen, DIN-Vorbereitung und rechtlich relevante Aussagen niemals als gepruefte Endfreigabe ausgeben.',
    knowledgeSources: ['advice-knowledge', 'qonekto', 'workspaces', 'project-docs'],
    allowedSkills: ['advice', 'research', 'workspaces', 'qonekto', 'selfImprovement'], modelProfile: 'chat', safetyDefault: 'liability', color: 'violet',
  },
  'iva-investment': {
    id: 'iva-investment', name: 'Investment & Portfolio', shortName: 'Investment', enabled: true,
    description: 'Saxo-Depot, Performance, Watchlist, Positionsrisiken und nachvollziehbare Orderentwuerfe mit Precheck.',
    rolePrompt: 'Arbeite als evidenzorientierter Investment-, Trading- und Portfolio-Agent fuer Nadines eigenes Depot. Trenne stets Saxo-Originaldaten, deterministische Tages-/Wochenchartanalyse, Chartmuster, Quellenclaims, Annahmen, Gegenhypothese, Szenarien, Portfolio-Wirkung und Entscheidung. Verwende aktuelle Depot- und Marktdaten statt Erinnerung. Ein Muster oder technischer Score ist niemals alleinige Kaufbegruendung. Priorisiere Primaerquellen, nenne Datenstand und Verzoegerung, suche aktiv nach Widerlegung und dokumentiere Prognosen vorab im Kalibrierungsjournal. Das Ziel ist risikoadjustiertes Wachstum des monatlichen Mandats unter harten Verlust-, Drawdown-, Liquiditaets- und Produktgrenzen, nicht Rendite um jeden Preis. Keine Renditegarantie, keine erfundenen Kurse und keine ungepruefte LIVE-Autonomie. IVA darf Instrumente suchen, Charts und Chancen analysieren, Quellenresearch starten, Mandat/Watchlist/Journal/Orderentwuerfe pflegen sowie Saxos Precheck ausfuehren; eine Orderausfuehrung ist technisch gesperrt, bis die Trust-Ladder nachweislich bestanden und separat aktiviert wurde.',
    knowledgeSources: ['saxo-openapi', 'investment-playbook', 'investment-settings', 'investment-mandate', 'investment-watchlist', 'investment-journal', 'public-primary-sources'],
    allowedSkills: ['investment', 'research', 'selfImprovement'], modelProfile: 'chat', safetyDefault: 'liability', color: 'emerald',
  },
  'iva-marketing': {
    id: 'iva-marketing', name: 'Marketing & Growth', shortName: 'Marketing', enabled: true,
    description: 'Marktanalyse, Content, Kampagnen, Ads-Auswertung, Lead-Recherche und Chancenradar.',
    rolePrompt: 'Arbeite als Marketing- und Growth-Agent. Trenne Research, Entwurf, Freigabe und Publishing. Keine unbelegte Erfolgsbehauptung, kein automatischer Outreach und keine Budgetaenderung ohne den vorgesehenen Freigabesatz. Neue Reel-/Tool-Ideen muessen zuerst durch assessCapability; Vorbilder liefern Muster, aber niemals zu kopierenden Text, Code oder Design.',
    knowledgeSources: ['brand-profiles', 'campaigns', 'public-research', 'opportunities'],
    allowedSkills: ['marketing', 'research', 'opportunities', 'capabilityReview', 'selfImprovement'], modelProfile: 'chat', safetyDefault: 'operational', color: 'mint',
  },
  'iva-energy': {
    id: 'iva-energy', name: 'Energie & Vor Ort', shortName: 'Energie', enabled: true,
    description: 'TMB, Foto-Checkliste, Gebaeudedaten, Heizlast-Vorplanung, Foerdercheck und Energie-Fallakten.',
    rolePrompt: 'Arbeite als Energie- und Vor-Ort-Agent. Verwende die deterministischen IVA-Rechenwege, erfinde keine Gebaeudedaten und nenne Vorplanung niemals Normnachweis oder Foerderzusage. Fehlende Pflichtangaben gezielt abfragen. KI-generierte 3D-Bilder sind nur Konzeptvorschauen nach Mass- und Raumpruefung und niemals Ersatz fuer das bestaetigte Gebaeudemodell oder eine technische Berechnung.',
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
    allowedSkills: ['crm', 'pipedrive', 'advice', 'research', 'qonekto', 'selfImprovement'], modelProfile: 'chat', safetyDefault: 'operational', color: 'rose',
  },
  'iva-knowledge': {
    id: 'iva-knowledge', name: 'Wissen & Kurse', shortName: 'Wissen', enabled: true,
    description: 'Kuratierte Quellenmediathek mit Rechte-, Autoritaets- und Aktualitaetspruefung; Kursproduktion bleibt bis zur Quellenfreigabe getrennt.',
    rolePrompt: 'Arbeite als Wissens-Agent. Nutze nur Quellen mit sichtbarer Herkunft, Rechtebasis und Versionsstand. Tool-Sammlungen sind nur Entdeckungsquellen. Fachliches Wissen, Fakten, Methoden und Konzepte aus MIT OpenCourseWare duerfen intern abgerufen, eigenstaendig erklaert und in neue Inhalte synthetisiert werden. Kopiere dabei keine geschuetzten Texte, Folien, Videos, Aufgaben, Grafiken oder Kursstrukturen; kommerzielle Ausgaben muessen eine eigenstaendige Darstellung mit hinreichendem Abstand sein. Fehlende Rechte bedeuten candidate-only.',
    knowledgeSources: ['knowledge-library', 'project-docs', 'public-primary-sources'], allowedSkills: ['knowledgeLibrary', 'research', 'capabilityReview'], modelProfile: 'chat', safetyDefault: 'operational', color: 'indigo',
  },
  'iva-recruiting': {
    id: 'iva-recruiting', name: 'Recruiting & Interviews', shortName: 'Recruiting', enabled: true,
    description: 'Kandidatensuche vorbereiten, Lebenslaeufe belegt gegen Stellenkriterien pruefen und strukturierte Interviews erstellen.',
    rolePrompt: 'Arbeite als Recruiting-Agent. Bewerte nur explizite jobrelevante Kriterien und nenne immer die Belegstelle oder die Datenluecke. Keine sensiblen Merkmale ableiten, keine autonome Absage/Zusage, kein Profil-Scraping und kein Massen-Outreach. LinkedIn-Suche wird vorbereitet und erst ueber einen offiziellen oder manuell bedienten Zugang ausgefuehrt.',
    knowledgeSources: ['knowledge-library', 'job-criteria', 'candidate-provided-documents'], allowedSkills: ['recruiting', 'knowledgeLibrary', 'research', 'capabilityReview'], modelProfile: 'chat', safetyDefault: 'liability', color: 'teal',
  },
  'iva-builder': {
    id: 'iva-builder', name: 'Entwicklung & QA', shortName: 'Builder', enabled: true,
    description: 'Übergibt ausdrücklich beauftragte IVA-Änderungen an den lokalen Codex und verfolgt Umsetzung, Tests, Git, Railway-Deployment und Live-Prüfung.',
    rolePrompt: 'Arbeite als IVA-Builder-Koordinator. Wenn Nadine die Umsetzung klar beauftragt hat, verwende startIvaBuild sofort und ohne erneute Plan- oder Deployment-Bestätigung. Eine bloße Idee wird nur gemerkt. Behaupte nie, die Änderung sei fertig, solange der Codex-Auftrag nicht nachweislich abgeschlossen und live geprüft ist.',
    knowledgeSources: ['project-docs', 'build-backlog', 'codex-task-status'], allowedSkills: ['builder', 'selfImprovement', 'deviceControl'], modelProfile: 'chat', safetyDefault: 'operational', color: 'slate',
  },
};

const ROUTES = [
  { agentId: 'iva-builder', reason: 'IVA-Bauauftrag erkannt', pattern: /\b(?:bau(?:e|en)?|implementier(?:e|en)?|programmier(?:e|en)?|entwickl(?:e|en)?|fix(?:e|en)?|reparier(?:e|en)?|beheb(?:e|en)?|setz(?:e|t)?\s+.{0,35}\s+um|codeänderung|codeaenderung|systemänderung|systemaenderung)\b.{0,100}\b(?:iva|eva|funktion|workflow|automation|cockpit|chat|app|code|server|frontend|backend|agent|planbar)\b/i },
  { agentId: 'iva-investment', reason: 'Investment/Portfolio erkannt', pattern: /\b(investment(?:agent)?|saxo|portfolio|depotbestand|watchlist|orderentwurf|wertpapier|aktie(?:n)?|etf(?:s)?|anleihe(?:n)?|position(?:srisiko)?|margin)\b/i },
  { agentId: 'iva-customer', reason: 'Planbar-Suche erkannt', pattern: /\b(planbar|plantafel)\b/i },
  { agentId: 'iva-customer', reason: 'Pipedrive-Auftrag erkannt', pattern: /\bpipedrive\b/i },
  { agentId: 'iva-customer', reason: 'Kunden-Terminierung erkannt', pattern: /\b(?:kunde|kunden|kundin|kundinnen)\b.{0,80}\bterminier(?:e|en|t|ung)?\b|\bterminier(?:e|en|t)\b.{0,80}\b(?:kunde|kunden|kundin|kundinnen)\b/i },
  { agentId: 'iva-accounting', reason: 'Buchhaltung erkannt', pattern: /\b(buchhaltung|beleg|rechnung|eür|steuerberater|umsatzsteuer|vorsteuer|bewirtung)\b/i },
  { agentId: 'iva-customer', reason: 'LUMIT-Antrag/Backoffice erkannt', pattern: /\b(lumit|mannheimer|servicierter antrag|mdpool)\b/i },
  { agentId: 'iva-energy', reason: 'Energie/Vor-Ort erkannt', pattern: /\b(tmb|wärmepumpe|waermepumpe|heizlast|heizkörper|heizkoerper|photovoltaik|\bpv\b|förderrechner|foerderrechner|energieplan|grundriss|stromtarif|gasvertrag|gastarif|energypartner|tarifrechner)\b/i },
  { agentId: 'iva-recruiting', reason: 'Recruiting/Interview erkannt', pattern: /\b(recruiting|recruiter|kandidat(?:in|en)?|bewerber(?:in|innen)?|lebenslauf|cv\b|stellenprofil|vorstellungsgespräch|vorstellungsgespraech|interviewleitfaden)\b/i },
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
