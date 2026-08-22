import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-opportunities-'));
process.env.GEMINI_API_KEY = 'test-gemini-key';
delete process.env.APIFY_TOKEN;

const { scoreOpportunity, formatWeeklyPitch } = await import('../opportunities/score.js');
const {
  getOpportunitySettings,
  listOpportunityMarketAnalyses,
  listOpportunityLinkChecks,
  listOpportunityWatchSources,
  listOpportunities,
  opportunityRadarCounts,
  prepareOpportunityHandoff,
  setOpportunityWatchSource,
  updateOpportunity,
  updateOpportunitySettings,
  upsertOpportunity,
} = await import('../opportunities/store.js');
const { opportunityRadarStatus, scrapeInstagramHashtags } = await import('../opportunities/scout.js');
const { checkOpportunityLink, normalizeLinkCheckMode } = await import('../opportunities/link-check.js');
const { opportunityMarketResearchStatus, runOpportunityMarketResearch } = await import('../opportunities/market-research.js');

const defaults = await getOpportunitySettings();
assert.equal(defaults.weeklyEnabled, true);
assert.ok(defaults.hashtags.includes('passiveseinkommen'));

const settings = await updateOpportunitySettings({ maxInitialBudgetEur: 400, maxSetupHours: 20, maxOngoingHoursPerWeek: 3, hashtags: ['kiideen', '#microsaas'] });
assert.deepEqual(settings.hashtags, ['kiideen', 'microsaas']);

const candidate = {
  title: 'Quellenbasierter KI-Vorlagen-Shop', summary: 'Eine enge Vorlagenbibliothek für einen belegten Berufsprozess.',
  offer: 'Digitale Vorlagen plus Aktualisierungsabo', aiLeverage: 'Entwürfe, Varianten und Pflege', firstValidation: 'Landingpage und fünf Gespräche',
  setupHours: 16, ongoingHoursPerWeek: 2, initialBudgetEur: 250,
  sources: [{ url: 'https://www.instagram.com/p/example/', account: 'example', signal: 'Wiederkehrende Nachfrage nach Vorlagen' }],
  ratings: { demandEvidence: 8, monetizationClarity: 8, automationFit: 9, lowOngoingEffort: 8, speedToValidate: 9, nadineFit: 8, evidenceQuality: 7, defensibility: 6, platformRisk: 2, legalRisk: 2, saturationRisk: 4, hypeRisk: 2 },
};
const scoring = scoreOpportunity(candidate, settings);
assert.ok(scoring.score >= 60);
assert.equal(scoring.penalties.noDirectSource, 0);

const stored = await upsertOpportunity(candidate);
await updateOpportunity(stored.id, { score: scoring.score, scoreBreakdown: scoring, status: 'validate' });
const items = await listOpportunities({ limit: 10 });
assert.equal(items.length, 1);
assert.equal(items[0].status, 'validate');
assert.equal(items[0].score, scoring.score);

const pitch = formatWeeklyPitch(items);
assert.match(pitch, /Chancenradar/);
assert.match(pitch, /KI-Vorlagen-Shop/);
assert.match(pitch, /startet aber nichts ungefragt/);

const handoff = await prepareOpportunityHandoff(stored.id);
assert.equal(handoff.status, 'awaiting-confirmation');
assert.match(handoff.confirmation, /^Ja, Chancenidee .+ umsetzen$/);
assert.equal((await opportunityRadarCounts()).pendingHandoffs, 1);

assert.equal(normalizeLinkCheckMode('Für IVA Integration testen'), 'iva-integration');
assert.equal(normalizeLinkCheckMode('Für Business checken'), 'business');
assert.equal(normalizeLinkCheckMode('Automatisch einsortieren'), 'auto');
const linkCheck = await checkOpportunityLink({ url: 'https://example.com/tool', mode: 'iva-integration' }, {
  loadSource: async url => ({ url, finalUrl: url, contentType: 'html', title: 'Beispiel-Tool', text: 'Ein öffentlich beschriebenes Tool mit Exportfunktion.' }),
  analyze: async () => ({
    headline: 'Exportfunktion als IVA-Baustein prüfen', verdict: 'test-first', score: 68,
    summary: 'Potenziell nützlich, aber API und Rechte sind noch offen.', whatItIs: 'Ein externer Exportdienst.',
    evidence: ['Eine Exportfunktion wird auf der Quelle beschrieben.'], assumptions: ['Ein API-Zugang könnte existieren.'],
    fit: ['Kann einen bestehenden IVA-Bereich ergänzen.'], gaps: ['Offizielle API-Dokumentation fehlt.'], risks: ['Vendor-Lock-in'],
    costsAndEffort: 'Noch zu verifizieren.', nextTest: 'Offizielle API und Testkonto prüfen.', recommendedArea: 'builder',
  }),
});
assert.equal(linkCheck.status, 'complete');
assert.equal(linkCheck.mode, 'iva-integration');
assert.equal(linkCheck.assessment.score, 68);

const autoBusiness = await checkOpportunityLink({ url: 'https://example.com/business-idea', mode: 'auto' }, {
  loadSource: async url => ({ url, finalUrl: url, contentType: 'html', title: 'Neue Dienstleistung', text: 'Ein Angebot für zahlende Firmenkunden mit einem klaren Vertriebsweg.' }),
  analyze: async (_source, mode) => {
    assert.equal(mode, 'auto');
    return {
      classification: 'business', classificationReason: 'Der primäre Nutzen ist ein vermarktbares Kundenangebot.', classificationConfidence: 0.91,
      headline: 'Dienstleistung klein am Markt testen', verdict: 'test-first', score: 71, summary: 'Eine mögliche Business-Chance.', whatItIs: 'Ein neues Kundenangebot.', nextTest: 'Fünf Zielkundengespräche führen.',
    };
  },
});
assert.equal(autoBusiness.mode, 'business');
assert.equal(autoBusiness.requestedMode, 'auto');
assert.match(autoBusiness.classificationReason, /Kundenangebot/);

const autoIva = await checkOpportunityLink({ url: 'https://example.com/iva-tool', mode: 'auto' }, {
  loadSource: async url => ({ url, finalUrl: url, contentType: 'html', title: 'Neue Schnittstelle', text: 'Eine API liefert strukturierte Daten für bestehende Assistenten-Workflows.' }),
  analyze: async () => ({
    classification: 'iva-integration', classificationReason: 'Die API erweitert primär IVAs vorhandene Fähigkeiten.', classificationConfidence: 0.95,
    headline: 'API als IVA-Erweiterung prüfen', verdict: 'test-first', score: 76, summary: 'Eine mögliche IVA-Erweiterung.', whatItIs: 'Eine neue Daten-API.', nextTest: 'Sandbox und Datenrechte prüfen.',
  }),
});
assert.equal(autoIva.mode, 'iva-integration');
assert.equal(autoIva.requestedMode, 'auto');

await assert.rejects(() => checkOpportunityLink({ url: 'https://example.com/blocked', mode: 'business' }, {
  loadSource: async () => { throw new Error('Quelle absichtlich nicht erreichbar'); },
}), /absichtlich nicht erreichbar/);
const linkChecks = await listOpportunityLinkChecks({ limit: 10 });
assert.equal(linkChecks.length, 4);
assert.equal(linkChecks[0].status, 'failed');
assert.equal((await opportunityRadarCounts()).linkChecks, 4);

const marketAnalysis = await runOpportunityMarketResearch({ topic: 'Betriebliche Krankenversicherung', keywords: ['Mitarbeiterbindung', 'Benefits'], region: 'DACH', language: 'Deutsch' }, {
  search: async () => [
    { title: 'bKV Praxis', url: 'https://www.instagram.com/bkvpraxis/', snippet: 'Praxisnahe Beiträge für Arbeitgeber.' },
    { title: 'Benefits Fachportal', url: 'https://example.com/benefits', snippet: 'Analysen und Leitfäden zu Benefits.' },
  ],
  scrape: async () => [
    { url: 'https://www.instagram.com/p/bkv1/', caption: 'Drei Fehler bei der bKV-Einführung', likesCount: 120, commentsCount: 14, videoViewCount: 2200, timestamp: '2026-08-12T08:00:00.000Z', type: 'Video' },
    { url: 'https://www.instagram.com/p/bkv2/', caption: 'So kommunizieren Arbeitgeber Benefits', likesCount: 90, commentsCount: 9, timestamp: '2026-08-10T08:00:00.000Z', type: 'Sidecar' },
  ],
  fetchSource: async url => ({ url, finalUrl: url, title: 'Benefits Fachportal', contentType: 'html', publishedAt: '2026-08-11', text: 'Regelmäßige Fachanalysen zu Mitarbeiterbindung, Fehlzeiten und Benefits für Arbeitgeber.' }),
  analyze: async (_request, candidates) => {
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].detail.sampleSize, 2);
    assert.match(candidates[1].detail.text, /Mitarbeiterbindung/);
    return {
      summary: 'Zwei wiederkehrend sinnvolle Quellen mit unterschiedlichen Stärken.',
      topSources: [
        { sourceRef: 1, displayName: 'bKV Praxis', score: 88, reason: 'Konkrete, aktuelle Praxisbeispiele.', strengths: ['Praxisnähe'], topics: ['bKV'], contentPatterns: ['Fehlerlisten'], evidence: ['Zwei echte Beiträge geprüft'], cadence: 'weekly', monitoringValue: 'high' },
        { sourceRef: 2, displayName: 'Benefits Fachportal', score: 79, reason: 'Unabhängige Fachanalysen.', strengths: ['Tiefe'], topics: ['Benefits'], contentPatterns: ['Leitfäden'], evidence: ['Originalseite gelesen'], cadence: 'monthly', monitoringValue: 'high' },
      ],
      marketPatterns: ['Praxisbeispiele und Arbeitgeberkommunikation dominieren.'], blindSpots: ['Wenig belastbare ROI-Daten.'], nextQueries: ['bKV Fehlzeiten Studie'],
    };
  },
});
assert.equal(marketAnalysis.status, 'complete');
assert.equal(marketAnalysis.sources.length, 2);
assert.equal((await listOpportunityMarketAnalyses({ limit: 10 })).length, 1);
await setOpportunityWatchSource({ ...marketAnalysis.sources[0], analysisId: marketAnalysis.id }, true);
await setOpportunityWatchSource({ ...marketAnalysis.sources[1], analysisId: marketAnalysis.id }, true);
assert.equal((await listOpportunityWatchSources()).length, 2);
await setOpportunityWatchSource(marketAnalysis.sources[1], false);
assert.deepEqual((await listOpportunityWatchSources()).map(source => source.handle), ['bkvpraxis']);
assert.equal((await opportunityRadarCounts()).marketAnalyses, 1);
assert.equal((await opportunityRadarCounts()).watchSources, 1);
await assert.rejects(() => setOpportunityWatchSource({ name: 'Unsicher', type: 'website', url: 'javascript:alert(1)' }, true), /öffentliche URL/);
await assert.rejects(() => runOpportunityMarketResearch({ topic: '' }, { search: async () => [] }), /Thema/);

const originalFetch = globalThis.fetch;
process.env.APIFY_TOKEN = 'test-token';
let actorRequest;
try {
  globalThis.fetch = async (url, options) => {
    actorRequest = { url: String(url), body: JSON.parse(options.body) };
    return new Response(JSON.stringify([{ url: 'https://www.instagram.com/p/test/', caption: 'Test' }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const actorItems = await scrapeInstagramHashtags(['eins', 'zwei', 'drei', 'vier'], { resultsLimit: 80 });
  assert.equal(actorItems.length, 1);
  assert.equal(actorRequest.body.resultsLimit, 20, 'resultsLimit muss als Pro-Hashtag-Limit aus dem Gesamtbudget berechnet werden');
  assert.equal(new URL(actorRequest.url).searchParams.get('limit'), '80');
  assert.equal((await opportunityRadarStatus()).ready, true);
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.APIFY_TOKEN;
}

const status = await opportunityRadarStatus();
assert.equal(status.configured, false);
assert.deepEqual(status.missing, ['APIFY_TOKEN']);

process.env.APIFY_TOKEN = 'test-token';
delete process.env.GEMINI_API_KEY;
const missingModelStatus = await opportunityRadarStatus();
assert.equal(missingModelStatus.ready, false);
assert.deepEqual(missingModelStatus.missing, ['GEMINI_API_KEY']);

process.env.GEMINI_API_KEY = 'test-gemini-key';
delete process.env.TAVILY_API_KEY;
assert.deepEqual(opportunityMarketResearchStatus().missing, ['TAVILY_API_KEY']);

const html = await fs.readFile(new URL('../public/opportunities.html', import.meta.url), 'utf8');
const js = await fs.readFile(new URL('../public/opportunities.js', import.meta.url), 'utf8');
const scoutSource = await fs.readFile(new URL('../opportunities/scout.js', import.meta.url), 'utf8');
assert.match(html, /Marktanalyse & Quellenradar/);
assert.match(html, /Links prüfen & automatisch einsortieren/);
assert.match(html, /id="linkUrls"/);
assert.match(html, /höchstens zehn|Bis zu zehn/);
assert.match(js, /mode: 'auto'/);
assert.match(js, /Business-Chance/);
assert.match(js, /IVA-Erweiterung/);
assert.match(js, /\/api\/opportunities\/market-research/);
assert.match(js, /Regelmäßig beobachten/);
assert.match(scoutSource, /watch-account/);
assert.match(scoutSource, /watch-web/);
assert.match(scoutSource, /curatedRotation/);

console.log('IVA Chancenradar: OK');
