import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-marketing-'));
process.env.DATA_DIR = dir;
delete process.env.GOOGLE_PLACES_API_KEY;

const { marketingConnectorStatus, discoverGoogleBusinesses } = await import('../marketing/connectors.js');
const { createEmailCampaign, createMarketingReport, evaluateAdMetrics, recordAdSnapshot } = await import('../marketing/planning.js');
const { createSuiteItem, listSuiteItems } = await import('../marketing/suite-store.js');

const status = marketingConnectorStatus();
assert.equal(status.total, 7);
assert.equal(status.connectors.find(item => item.id === 'google-places').configured, false);
const noGoogle = await discoverGoogleBusinesses({ industry: 'Finanzberatung', region: 'Berlin' });
assert.equal(noGoogle.ok, false);
assert.match(noGoogle.error, /GOOGLE_PLACES_API_KEY/);

const evaluation = evaluateAdMetrics({ spend: 500, impressions: 20_000, clicks: 100, leads: 5, frequency: 4.2 }, { minCtr: 1, maxCpl: 50, maxFrequency: 3.5 });
assert.equal(evaluation.decision, 'suggest-only');
assert.ok(evaluation.suggestions.some(item => /Hook/.test(item.action)));
assert.ok(evaluation.suggestions.some(item => /Landingpage/.test(item.action)));
assert.ok(evaluation.suggestions.some(item => /Rotation/.test(item.action)));

const email = await createEmailCampaign({ name: 'Pilot', audienceStatus: 'b2b-review-required', subject: 'Test' });
assert.equal(email.status, 'draft');
assert.equal(email.delivery.enabled, false);
assert.equal(email.sendApproval, 'pending');

const ad = await recordAdSnapshot({ campaignId: 'campaign-1', adSet: 'Test', metrics: { spend: 100, impressions: 10_000, clicks: 50, leads: 2 }, targets: { maxCpl: 40 } });
assert.equal(ad.approval.status, 'pending');
assert.equal((await listSuiteItems('adSnapshots')).length, 1);

await createSuiteItem('researchRuns', { industry: 'Testbranche', status: 'partial' });
await createSuiteItem('contentPlans', { campaignId: 'campaign-1', status: 'draft' });
const report = await createMarketingReport({ period: 'test' });
assert.match(report.text, /Marketing-Report/);
assert.equal(report.counts.researchRuns, 1);
assert.equal(report.counts.contentPlans, 1);

console.log('Marketing-Suite: OK');
