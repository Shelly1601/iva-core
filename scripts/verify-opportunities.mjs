import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-opportunities-'));
delete process.env.APIFY_TOKEN;

const { scoreOpportunity, formatWeeklyPitch } = await import('../opportunities/score.js');
const {
  getOpportunitySettings,
  listOpportunities,
  opportunityRadarCounts,
  prepareOpportunityHandoff,
  updateOpportunity,
  updateOpportunitySettings,
  upsertOpportunity,
} = await import('../opportunities/store.js');
const { opportunityRadarStatus } = await import('../opportunities/scout.js');

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

const status = await opportunityRadarStatus();
assert.equal(status.configured, false);
assert.deepEqual(status.missing, ['APIFY_TOKEN']);

console.log('IVA Chancenradar: OK');
