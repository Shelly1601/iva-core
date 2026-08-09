const clean = (value, max = 2000) => String(value ?? '').trim().slice(0, max);
const clamp = (value, min, max, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

export const CAPABILITY_GATE_VERSION = 'iva-capability-gate-1.0';

export function evaluateCapability(input = {}) {
  const expectedRunsPerMonth = clamp(input.expectedRunsPerMonth, 0, 10_000);
  const minutesSavedPerRun = clamp(input.minutesSavedPerRun, 0, 10_000);
  const setupHours = clamp(input.setupHours, 0, 10_000);
  const monthlyCostEur = clamp(input.monthlyCostEur, 0, 1_000_000);
  const currentCoveragePercent = clamp(input.currentCoveragePercent, 0, 100);
  const evidence = Array.isArray(input.officialEvidence)
    ? input.officialEvidence.map(item => clean(item, 1000)).filter(Boolean)
    : [];
  const risks = Array.isArray(input.risks)
    ? input.risks.map(item => clean(item, 300)).filter(Boolean)
    : [];
  const monthlyHoursSaved = expectedRunsPerMonth * minutesSavedPerRun / 60;
  const netNewBenefitHours = monthlyHoursSaved * (1 - currentCoveragePercent / 100);
  const paybackMonths = netNewBenefitHours > 0 ? setupHours / netNewBenefitHours : null;
  const blockers = [];

  if (!clean(input.problem, 1200)) blockers.push('Kein konkretes wiederkehrendes Problem beschrieben.');
  if (input.requiresExternalTool === true && !evidence.length) blockers.push('Externer Dienst ist nicht durch eine offizielle Quelle verifiziert.');
  if (input.rightsClear === false) blockers.push('Nutzungs-/Lizenzrechte sind nicht geklaert.');
  if (input.securityReviewed === false && (input.personalData === true || input.externalWrite === true)) blockers.push('Sicherheits- und Datenschutzpruefung fehlt.');
  if (input.copiesProtectedWork === true) blockers.push('Fremder Code, geschuetztes Design oder geschuetzter Inhalt duerfte kopiert werden.');

  let decision = 'integrate-existing';
  if (input.rightsClear === false || input.copiesProtectedWork === true) decision = 'reject';
  else if (blockers.length) decision = 'needs-verification';
  else if (netNewBenefitHours < 1 && currentCoveragePercent >= 70) decision = 'do-not-build';
  else if (monthlyCostEur > 0 && netNewBenefitHours < 2) decision = 'watch';
  else if (input.distinctWorkflow === true && currentCoveragePercent < 40 && netNewBenefitHours >= 3) decision = 'new-agent-candidate';

  const score = Math.round(Math.max(0, Math.min(100,
    30
    + Math.min(30, netNewBenefitHours * 4)
    + (evidence.length ? 12 : 0)
    + (input.rightsClear === true ? 8 : 0)
    + (input.securityReviewed === true ? 8 : 0)
    - Math.min(18, monthlyCostEur / 20)
    - Math.min(20, currentCoveragePercent / 5)
    - blockers.length * 12
  )));

  return {
    gateVersion: CAPABILITY_GATE_VERSION,
    title: clean(input.title, 180) || 'Unbenannte Faehigkeit',
    decision,
    score,
    targetAgent: clean(input.existingAgent, 80) || (decision === 'new-agent-candidate' ? 'new-agent-review' : 'iva-standard'),
    benefit: {
      monthlyHoursSaved: Number(monthlyHoursSaved.toFixed(2)),
      netNewBenefitHours: Number(netNewBenefitHours.toFixed(2)),
      currentCoveragePercent,
      paybackMonths: paybackMonths === null ? null : Number(paybackMonths.toFixed(2)),
    },
    cost: { setupHours, monthlyCostEur },
    evidence,
    risks,
    blockers,
    nextStep: decision === 'needs-verification'
      ? 'Offizielle Quelle, Rechte und Sicherheitsweg belegen; danach erneut bewerten.'
      : decision === 'new-agent-candidate'
        ? 'Als abgegrenzten Agenten mit eigenen Tests und Freigaben spezifizieren.'
        : decision === 'integrate-existing'
          ? 'Nur die fehlende Funktion in den bestehenden Agenten integrieren und testen.'
          : decision === 'reject'
            ? 'Nicht uebernehmen.'
            : 'Nicht bauen; als Beobachtung oder spaeteren Vergleichspunkt behalten.',
  };
}

export const CURATED_CAPABILITY_REVIEWS = Object.freeze([
  {
    id: 'content-motion-transitions', category: 'content', decision: 'integrate-existing', targetAgent: 'iva-marketing',
    sourceCodes: ['DbiQDBooC92'], title: 'Logo-/Bild-Transitionen fuer Reels',
    utility: 'Optionales Creative-Muster fuer einzelne Reels; kein eigener Agent.',
  },
  {
    id: 'ai-3d-assets', category: 'content', decision: 'watch', targetAgent: 'iva-marketing',
    sourceCodes: ['DbdLYtdo0I_'], title: 'KI-generierte 3D-Assets',
    utility: 'Brauchbar fuer visuelle Assets; API ist nutzungsabhaengig und ersetzt keine technische Planung.',
  },
  {
    id: 'prompt-app-builders', category: 'builder', decision: 'do-not-build', targetAgent: 'iva-builder',
    sourceCodes: ['DbakgPSou1_', 'DaNW-RfoSpp', 'Daz90y7MpNo'], title: 'Prompt-basierte App-/Website-Builder',
    utility: 'Guter Benchmark, aber durch IVA, Sites/Lovable und den bestehenden Code-Workflow weitgehend abgedeckt.',
  },
  {
    id: 'tool-aggregators', category: 'opportunities', decision: 'discovery-only', targetAgent: 'iva-marketing',
    sourceCodes: ['Da5FtIqIb25', 'DZ16SSgIWwT', 'DZFPMklIaLz'], title: 'Sammlungen kostenloser KI-Tools',
    utility: 'Nur Ideenquelle. Jede Behauptung zu Kosten, Limits, Datenschutz und Rechten muss einzeln verifiziert werden.',
  },
  {
    id: 'design-reference-mining', category: 'website', decision: 'integrate-existing', targetAgent: 'iva-marketing',
    sourceCodes: ['DaVGK9wInO3'], title: 'Hochwertige Design-Portfolios als Referenz',
    utility: 'Als Qualitaetsbenchmark sinnvoll; Muster analysieren, niemals Designs kopieren.',
  },
  {
    id: 'open-generative-ai', category: 'content', decision: 'watch', targetAgent: 'iva-marketing',
    sourceCodes: ['DbbSXBAoFAb'], title: 'Open Generative AI',
    utility: 'Projekt und MIT-Lizenz sind real. Viele Cloud-Modelle benoetigen jedoch MuAPI-Guthaben; lokaler Betrieb kostet Hardware und Betrieb.',
  },
  {
    id: 'unverified-marketing-funnel', category: 'content', decision: 'needs-verification', targetAgent: 'iva-marketing',
    sourceCodes: ['DbJPpZsNEvC'], title: 'Unklarer Free-Marketing-Funnel',
    utility: 'Der oeffentliche Beitrag belegt keine konkrete Funktion. Keine Integration ohne Primarquelle.',
  },
  {
    id: 'unlicensed-png-library', category: 'content', decision: 'reject', targetAgent: 'iva-marketing',
    sourceCodes: ['DaDAtdWoFXL'], title: 'Massenhafte PNG-Bibliothek',
    utility: 'Ohne belastbare Einzel-Lizenzen zu hohes Urheberrechtsrisiko.',
  },
  {
    id: 'floorplan-3d-preview', category: 'energy', decision: 'integrate-existing', targetAgent: 'iva-energy',
    sourceCodes: ['DanF4k0oq2t'], title: 'Grundriss als 3D-Konzeptvorschau',
    utility: 'Nur nach Mass-/Raumpruefung als Visualisierung; niemals Ersatz fuer die deterministische Energie- und 3D-Planung.',
  },
  {
    id: 'failed-startup-database', category: 'opportunities', decision: 'integrate-existing', targetAgent: 'iva-marketing',
    sourceCodes: ['Dau9lThIom_'], title: 'Gescheiterte Startups als Chancenquelle',
    utility: 'Sinnvolles Gegenbeispiel-Research; jede Idee braucht weiterhin aktuellen Nachweis und einen kleinen Validierungstest.',
  },
  {
    id: 'learning-library', category: 'knowledge', decision: 'integrate-existing', targetAgent: 'iva-knowledge',
    sourceCodes: ['DbA8wcFohcR', 'Dah7D0iIFiU', 'DaIBlv4InFn', 'DZHyMX4Ijcp'], title: 'Kuratierte Lern- und Referenzquellen',
    utility: 'Sinnvoll als Quellenindex mit Rechte-, Aktualitaets- und Autoritaetspruefung; nicht als ungepruefte Volltextkopie.',
  },
  {
    id: 'recruiting-assistant', category: 'recruiting', decision: 'new-agent-candidate', targetAgent: 'iva-recruiting',
    sourceCodes: ['DZM-rtGIZno'], title: 'Recruiting-Vorbereitung und CV-Pruefung',
    utility: 'Eigenstaendiger HR-Prozess mit klarem Nutzen; keine autonome Auswahl oder Absage.',
  },
  {
    id: 'whatsapp-rag-handoff', category: 'whatsapp', decision: 'integrate-existing', targetAgent: 'iva-customer',
    sourceCodes: ['DbLKQlMo1sX'], title: 'WhatsApp-Wissensantworten mit Ticket-Uebergabe',
    utility: 'IVA hat Kanal, Identitaets- und Deckungsschutz bereits. Sinnvolle Luecke: nachvollziehbare Tickets mit Owner, Status und SLA.',
  },
]);

export function listCapabilityReviews({ category = '', decision = '' } = {}) {
  return CURATED_CAPABILITY_REVIEWS.filter(item => (!category || item.category === category) && (!decision || item.decision === decision));
}
