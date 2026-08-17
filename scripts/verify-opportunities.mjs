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
  listOpportunityLinkChecks,
  listOpportunities,
  opportunityRadarCounts,
  prepareOpportunityHandoff,
  updateOpportunity,
  updateOpportunitySettings,
  upsertOpportunity,
} = await import('../opportunities/store.js');
const { opportunityRadarStatus, scrapeInstagramHashtags } = await import('../opportunities/scout.js');
const { checkOpportunityLink, normalizeLinkCheckMode } = await import('../opportunities/link-check.js');

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

await assert.rejects(() => checkOpportunityLink({ url: 'https://example.com/blocked', mode: 'business' }, {
  loadSource: async () => { throw new Error('Quelle absichtlich nicht erreichbar'); },
}), /absichtlich nicht erreichbar/);
const linkChecks = await listOpportunityLinkChecks({ limit: 10 });
assert.equal(linkChecks.length, 2);
assert.equal(linkChecks[0].status, 'failed');
assert.equal((await opportunityRadarCounts()).linkChecks, 2);

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

console.log('IVA Chancenradar: OK');
