const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const label = value => String(value || '').slice(0, 240);

// This directory is only mounted behind the owner API. A project portal never
// receives the global library; products retain only explicitly selected sources.
export function createCreatorContext({ listProjects, access, listKnowledgeEntries, listOpportunities, listOpportunityLinkChecks, getOpportunity, env = process.env }) {
  async function projects() {
    const rows = [];
    for (const project of await listProjects()) {
      const configuration = await access.getProjectAccess(project.id);
      if (configuration.modules.includes('creator')) rows.push({ id: project.id, name: project.name });
    }
    return rows;
  }
  function opportunity(row) {
    if (!row) return null;
    return { ...row, title: row.title || row.assessment?.headline || row.sourceTitle || 'Idee aus dem Chancenradar', summary: row.summary || row.assessment?.summary || '', evidence: row.evidence || row.assessment?.evidence || [], risks: row.risks || row.assessment?.risks || [], score: row.score ?? row.assessment?.score, sourceUrl: row.sourceUrl || row.url || '', originType: row.assessment ? 'link-check' : 'radar' };
  }
  async function resolveOpportunity(id) {
    const regular = await getOpportunity(id);
    if (regular) return opportunity(regular);
    return opportunity((await listOpportunityLinkChecks({ limit: 200 })).find(row => row.id === id));
  }
  async function context(projectId) {
    const available = await projects();
    if (!projectId) return { projects: available, knowledge: [], opportunities: [], readiness: [] };
    if (!available.some(p => p.id === projectId)) throw fail('Creator ist für dieses Projekt nicht freigegeben.', 403);
    const [knowledge, radar, checks] = await Promise.all([listKnowledgeEntries({ status: 'ready', limit: 300 }), listOpportunities({ limit: 200 }), listOpportunityLinkChecks({ limit: 100 })]);
    const modelConfigured = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY'].some(key => Boolean(env[key]));
    return {
      projects: available,
      knowledge: knowledge.filter(row => !row.projectId || row.projectId === projectId).map(row => ({ id: row.id, title: label(row.title), kind: row.kind, wordCount: row.wordCount, sourceUrl: row.sourceUrl || '', preview: String(row.preview || '').slice(0, 300) })),
      opportunities: [...radar, ...checks].filter(row => !row.projectId || row.projectId === projectId).map(opportunity).map(row => ({ id: row.id, title: label(row.title), summary: String(row.summary).slice(0, 600), originType: row.originType, score: row.score, projectId: row.projectId || '' })),
      readiness: [
        { id: 'model', label: 'KI-Ausarbeitung', status: modelConfigured ? 'conditional' : 'missing', detail: modelConfigured ? 'Modellzugang konfiguriert. Jeder Auftrag zeigt das tatsächlich verwendete Modell und seinen Abschluss.' : 'Zuerst einen Modellzugang im Kontrollzentrum verbinden.' },
        { id: 'knowledge', label: 'Wissensdatenbank', status: 'ready', detail: 'Ausgewählte Inhalte werden mit Herkunft und Versionsstand ins Produkt übernommen.' },
        { id: 'exports', label: 'PDF, Markdown und ZIP', status: 'ready', detail: 'Vollständig ausgearbeitete Versionen lassen sich als digitales Produkt exportieren.' },
        { id: 'sales', label: 'Verkauf und Kursplattform', status: 'conditional', detail: 'Verkaufsseite im Website Studio und eigene HTTPS-Verkaufslinks. Checkout, Bezahlung, Teilnehmerzugänge und Plattform-Upload müssen beim gewählten Anbieter eingerichtet werden.' },
      ],
    };
  }
  return { context, projects, resolveOpportunity };
}
