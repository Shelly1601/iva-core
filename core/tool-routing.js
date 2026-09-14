// Capability routing uses only registered executable tools. Configuration is
// distinct from verified availability; neither descriptions nor model claims
// can grant new access or turn an unknown tool into a read-only tool.
export const TOOL_ROUTING_VERSION = '1.0.0';
const readTools = new Set(`getCalendar getCalendly getIvaAppointmentTypes getMails getLeads findHeatHeroLeads getPipedriveStatus searchPipedriveDeals listPipedriveDeals getPipedriveDeal getAirtableStatus listAirtableInstallationQueue listAirtableWorkflowStage searchAirtableWorkflowRecords getAirtableWorkflowRecord listCampaigns listBrands listContentWorkbench analyzeReferences askArchitect listWorkspaces getWorkspace listAdviceModules searchAdviceKnowledge listOpportunities listOpportunityWatchSources listOpportunityProjects getAccountingSummary listAccountingEntities listAccountingDocuments getAccountingDocument getEnergyTariffConnectorStatus qonektoStatus listQonektoTools callQonektoReadTool getLumitWorkflow listLumitServicedApplications getKnowledgeLibraryStatus listKnowledgeLibrary getPersonalKnowledgeBaseStatus searchPersonalKnowledgeBase getInvestmentStatus getInvestmentPortfolio getInvestmentRiskReport searchSaxoInstruments getInvestmentKnowledgeStatus getInvestmentMandate listInvestmentAnalyses listInvestmentJournal listInvestmentWatchlist listInvestmentOrderDrafts listCapabilityReviews getImacCommandStatus getImacTaskStatus checkIvaBuildDispatch checkIvaBuildTask getInstagramConnectionStatus readInstagramReference listOwnInstagramMedia readOwnInstagramComments getMetaAdsInsights getIvaConnectionStatus getIvaAgentRoster getCurrentProject readCurrentProjectFile listCurrentProjectConnections listAdviceModules createCandidateSearchPlan screenResumeAgainstCriteria createInterviewGuide`.split(' '));
const groups = {
  memory: ['iva', 'local', 'notizen todos erinnerung'],
  calendar: ['calendar', 'api', 'kalender termine buchungen calendly'],
  mails: ['mail', 'api', 'email e-mail mail postfach nachrichten outlook'],
  crm: ['crm', 'api', 'kunde kundenakte lead heat hero crm'],
  pipedrive: ['pipedrive', 'api', 'pipedrive deal auftrag montage'],
  airtable: ['airtable', 'api', 'airtable tabelle installationsliste enter'],
  marketing: ['iva', 'local', 'marketing kampagne content marke entwurf'],
  instagram: ['instagram', 'api', 'instagram reel reels social profil kommentar medien'],
  research: ['research', 'research', 'recherche quelle aktuell internet web fakten datenblatt gesetz preis'],
  workspaces: ['iva', 'local', 'kundenakte fallakte arbeitsbereich gebaude energie'],
  advice: ['iva', 'local', 'versicherung tarif beratung fachvergleich vorsorge'],
  opportunities: ['iva', 'local', 'chancenradar chancen opportunity projekte'],
  accounting: ['iva', 'local', 'buchhaltung beleg rechnung vollstandigkeit steuerberater'],
  energyTariffs: ['energy', 'api', 'stromtarif gas energie tarifvergleich'],
  qonekto: ['qonekto', 'mcp', 'qonekto blau direkt ameise kundenstamm police vertrag dokument'],
  lumit: ['iva', 'local', 'lumit mannheimer servicierter antrag'],
  knowledgeLibrary: ['iva', 'local', 'wissen kurs unterlagen dokument quelle mediathek'],
  recruiting: ['iva', 'local', 'recruiting bewerbung lebenslauf interview kandidat'],
  investment: ['saxo', 'api', 'saxo investment portfolio depot aktie watchlist order'],
  deviceControl: ['mac-mini', 'native-browser', 'mac mini browser outlook website portal datei ausfuhren'],
  planbar: ['mac-mini', 'native-browser', 'planbar terminierung plantafel kalenderwoche'],
  builder: ['mac-mini', 'worker', 'bauen entwickeln implementieren iva code software'],
  projects: ['iva', 'local', 'projekt projektakte dateien dokumente anbindungen'],
  specialists: ['iva', 'worker', 'fachagent agenten team parallel teilaufgaben delegieren'],
};
const special = {
  readInstagramReference: { provider: 'apify', transport: 'research', terms: 'instagram reel profil referenz fremd offentlich auslesen inspiration', purpose: 'public-instagram' },
  analyzeReferences: { provider: 'apify', transport: 'research', terms: 'instagram referenz profil muster content analyse vorbild', purpose: 'public-instagram' },
  listOwnInstagramMedia: { provider: 'instagram', terms: 'instagram eigene medien konto posts beitrage', purpose: 'own-instagram' },
  readOwnInstagramComments: { provider: 'instagram', terms: 'instagram eigene kommentare beitrag', purpose: 'own-instagram' },
  getInstagramConnectionStatus: { provider: 'iva', terms: 'instagram verbindung konto status einrichten', purpose: 'connection-status' },
  getMetaAdsInsights: { provider: 'meta-ads', transport: 'api', terms: 'meta facebook instagram ads werbung kennzahlen kosten performance impressions', purpose: 'ads-insights' },
  getIvaConnectionStatus: { provider: 'iva', transport: 'local', terms: 'anbindung verbindung schnittstelle tools werkzeuge zugange status einrichten', purpose: 'connection-status' },
  getCalendly: { provider: 'calendly' },
  generateImage: { provider: 'fal', transport: 'api', terms: 'bild motiv foto illustration generieren' },
  runTaskOnImac: { provider: 'mac-mini', transport: 'native-browser', terms: 'browser outlook mail postfach portal website bedienen auslesen datei', purpose: 'local-workflow' },
  startIvaBuild: { provider: 'mac-mini', transport: 'worker', purpose: 'development' },
};
const roles = {
  'iva-customer': ['pipedrive', 'airtable', 'qonekto', 'mails', 'calendar', 'workspaces'],
  'iva-finance': ['advice', 'research', 'qonekto'], 'iva-investment': ['investment', 'research'],
  'iva-marketing': ['instagram', 'marketing', 'research', 'opportunities'],
  'iva-energy': ['workspaces', 'energyTariffs', 'research'], 'iva-accounting': ['accounting'],
  'iva-sales': ['crm', 'pipedrive', 'advice', 'research'], 'iva-knowledge': ['knowledgeLibrary', 'research'],
  'iva-recruiting': ['recruiting', 'knowledgeLibrary', 'research'], 'iva-builder': ['builder', 'deviceControl', 'research'],
};
const requirements = {
  apify: [['APIFY_TOKEN']], research: [['TAVILY_API_KEY']], pipedrive: [['PIPEDRIVE_API_TOKEN']],
  airtable: [['AIRTABLE_TOKEN']], qonekto: [['QONEKTO_MCP_TOKEN']],
  'mac-mini': [['MACMINI_DEVICE_TOKEN']], fal: [['FAL_KEY']], calendly: [['CALENDLY_TOKEN']],
  'meta-ads': [['META_ACCESS_TOKEN'], ['META_AD_ACCOUNT_ID'], ['META_GRAPH_VERSION']],
};
const observed = new Map();
const normalized = text => String(text || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss');
const words = text => normalized(text).split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2 && !['und','oder','die','das','der','ein','eine','fur','mit','bitte','von','auf','den','dem','ist','soll'].includes(w));

export function connectionState(provider, env = process.env) {
  if (provider === 'iva') return { state: 'local', missing: [] };
  if (provider === 'instagram') {
    const mode=env.INSTAGRAM_AUTH_MODE;
    const token=mode==='instagram'?env.INSTAGRAM_ACCESS_TOKEN:mode==='facebook'?env.META_ACCESS_TOKEN:'';
    const configured=Boolean(token && (env.INSTAGRAM_ACCOUNT_ID||env.INSTAGRAM_BUSINESS_ACCOUNT_ID) && /^v\d{1,2}\.\d{1,2}$/.test(env.META_GRAPH_VERSION||''));
    return { state: configured ? 'configured' : 'missing-connection', missing: configured ? [] : ['Projekt-Kontofreigabe, Login-Modus und Graph-Version'], requiresUserConnection: !configured };
  }
  if(provider==='pipedrive'&&!env.PIPEDRIVE_API_TOKEN&&env.PIPEDRIVE_CLIENT_ID&&env.PIPEDRIVE_CLIENT_SECRET&&env.PIPEDRIVE_REDIRECT_URI)return {state:'unverified',missing:[],note:'OAuth-App konfiguriert; gespeicherte Kontofreigabe wird beim Werkzeugaufruf geprüft.'};
  const required = requirements[provider];
  if (!required) return { state: 'unverified', missing: [] };
  const missing = required.filter(alternatives => !alternatives.some(key => Boolean(String(env[key] || '').trim()))).map(alternatives => alternatives.join(' oder '));
  return { state: missing.length ? 'missing-connection' : 'configured', missing };
}

export function describeIvaTool(name, tool, { env = process.env } = {}) {
  const skillId = tool.iva?.skillId || '';
  const [provider = 'unknown', transport = 'unknown', terms = ''] = groups[skillId] || [];
  const meta = { name, skillId, provider, transport, terms, readOnly: readTools.has(name), ...special[name] };
  const health = observed.get(name);
  const connection = connectionState(meta.provider, env);
  return { ...meta, connection, health: health ? { ...health } : null };
}

export function rankIvaTools(all, { query = '', agentId = 'iva-standard', env = process.env, readOnly = false, limit = 5 } = {}) {
  const tokens = words(query), raw = normalized(query);
  const mail = /outlook|postfach|\bmail\b|e-mail|emails/.test(raw);
  const ownInstagram = /instagram/.test(raw) && /eigen|unser|mein.*(?:konto|profil|beitrag|post)|kommentar/.test(raw);
  const rows = [];
  for (const [name, original] of Object.entries(all)) {
    const meta = describeIvaTool(name, original, { env });
    if (readOnly && !meta.readOnly) continue;
    const nameText = normalized(name), description = normalized(original.description), terms = words(meta.terms);
    const exact = nameText === raw;
    const lexical = tokens.reduce((sum, word) => sum + (nameText.includes(word) ? 16 : 0) + (description.includes(word) ? 2 : 0) + (terms.some(term => term.startsWith(word) || word.startsWith(term)) ? 7 : 0), 0);
    if (!exact && !lexical) continue;
    let score = exact ? 10000 : lexical;
    if (!exact) {
      if (meta.connection.state === 'missing-connection') score -= 60;
      else if (meta.connection.state === 'local') score += 5;
      if (meta.transport === 'api' || meta.transport === 'mcp') score += 5;
      if ((roles[agentId] || []).includes(meta.skillId)) score += 3;
      if ((meta.health?.consecutiveFailures || 0) >= 2 && Date.now() - Date.parse(meta.health.lastAttempt) < 60000) score -= 40;
      if (mail && name === 'runTaskOnImac') score += 45;
      if (mail && name === 'getMails') score -= 12;
      if (ownInstagram && meta.purpose === 'own-instagram') score += 45;
      if (ownInstagram && meta.purpose === 'public-instagram') score -= 70;
    }
    const reasons = [meta.connection.state === 'missing-connection' ? 'Verbindung fehlt; zuerst konkret einrichten.' : 'Registriertes ausführbares Werkzeug; Zugriff wird beim Aufruf geprüft.'];
    if (mail && name === 'runTaskOnImac') reasons.unshift('E-Mail-Aufträge zuerst in der vorhandenen nativen Outlook-Sitzung auf dem Mac Mini bearbeiten.');
    if (meta.transport === 'native-browser' || meta.transport === 'worker') reasons.push('Ein gereihter Auftrag ist noch kein fertiges Ergebnis; den belegten Endstatus prüfen.');
    if (!meta.readOnly) reasons.push('Originale Fach-, Auftrags- und Freigabeprüfungen gelten; bei unklarem Ausgang vor Wiederholung den Zielzustand prüfen.');
    rows.push({ ...meta, score, reason: reasons.join(' '), description: original.description });
  }
  return rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, Math.max(1, Math.min(12, limit)));
}

export function recordToolOutcome(name, result, durationMs, error = false) {
  const states=[result?.status,result?.command?.status,result?.task?.status];
  const failed = error || result?.ok === false || Boolean(result?.error) || result?.queued === false || states.some(state=>['failed','error','rejected','cancelled','canceled','stopped','aborted','partial'].includes(state));
  const pending = result?.queued === true || states.some(state=>['queued','pending','running','pending-report'].includes(state));
  const outcome = failed ? 'failed' : pending ? 'pending' : 'returned';
  const old = observed.get(name) || { calls: 0, failures: 0, consecutiveFailures: 0, meanDurationMs: 0 };
  const count = old.calls + 1;
  const value = { calls: count, failures: old.failures + Number(failed), consecutiveFailures: failed ? old.consecutiveFailures + 1 : 0, meanDurationMs: Math.round((old.meanDurationMs * old.calls + Math.max(0, durationMs)) / count), lastOutcome: outcome, lastAttempt: new Date().toISOString() };
  observed.set(name, value);
  return { tool: name, outcome, durationMs: Math.round(durationMs) };
}

export function toolRoutingStatus(all, options = {}) {
  const tools = Object.entries(all).map(([name, tool]) => describeIvaTool(name, tool, options));
  const providers = [...new Set(tools.map(tool => tool.provider))].map(provider => ({ provider, ...connectionState(provider, options.env), tools: tools.filter(tool => tool.provider === provider).map(tool => tool.name) }));
  return { version: TOOL_ROUTING_VERSION, policy: 'task-and-connection-aware', registeredTools: tools.length, readOnlyTools: tools.filter(tool => tool.readOnly).length, providers, tools, note: 'configured bedeutet eingerichteter Zugang, keine pauschal geprüfte Berechtigung. Fachagenten wählen aus denselben registrierten Schnittstellen nach Aufgabe und Fachpräferenz.' };
}
