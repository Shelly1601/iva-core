import assert from 'node:assert/strict';
import { importPanasonicLeadsToMeinCrm, meinCrmPanasonicPolicy } from '../integrations/meincrm-panasonic-leads.js';

const calls = [];
const responses = [
  [],
  [{ id: 'profile-1', email: 'n.sell@heat-hero.com' }],
  [{ id: 77, user_id: 'profile-1', name: 'Vertrieb Innendienst', email: 'n.sell@heat-hero.com' }],
  [{ id: 5, name: 'Schon vorhanden', email: 'existing@example.de', telefon: '+491701111111', notizen: 'ProMatch-ID: 11111111111111111111111111111111' }],
  [{ id: 101 }],
];

async function fetchStub(url, options = {}) {
  const response = responses.shift();
  calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
  return { ok: true, status: 200, text: async () => JSON.stringify(response) };
}

const result = await importPanasonicLeadsToMeinCrm([
  {
    name: 'Bestandsdublette', email: 'existing@example.de', telefon: '+491701111111',
    promatchId: '11111111111111111111111111111111', impRequestId: 'REQ-1',
  },
  {
    name: 'Neuer Lead', email: 'neu@example.de', telefon: '+491702222222',
    strasse: 'Musterweg', hausnummer: '2', plz: '40210', ort: 'Düsseldorf',
    promatchId: 'abcdef0123456789abcdef0123456789', impRequestId: 'REQ-2', details: 'Rückruf abends',
  },
], {
  serviceKey: 'service-test-key', projectId: 'heat-hero-project', restBase: 'https://example.invalid/rest/v1', fetchImpl: fetchStub,
});

assert.equal(result.created, 1);
assert.equal(result.duplicates, 1);
assert.equal(result.source, 'Panasonic');
assert.equal(result.advisor.id, 77);
assert.equal(meinCrmPanasonicPolicy.advisor.email, 'n.sell@heat-hero.com');

const advisorInsert = calls.find(call => call.url.includes('/vertriebler') && call.method === 'POST');
assert.deepEqual(advisorInsert.body, { name: 'Vertrieb Innendienst', email: 'n.sell@heat-hero.com', user_id: 'profile-1' });

const leadInsert = calls.find(call => call.url.includes('/leads') && call.method === 'POST');
assert.equal(leadInsert.body.quelle, 'Panasonic');
assert.equal(leadInsert.body.project_id, 'heat-hero-project');
assert.equal(leadInsert.body.assigned_user_id, 77);
assert.equal(leadInsert.body.fachberater_id, 77);
assert.equal(leadInsert.body.fachberater_name, 'Vertrieb Innendienst');
assert.equal('anrede' in leadInsert.body, false);
assert.equal('kundentyp' in leadInsert.body, false);
assert.match(leadInsert.body.notizen, /abcdef0123456789abcdef0123456789/);

await assert.rejects(
  () => importPanasonicLeadsToMeinCrm([], { serviceKey: 'x', projectId: 'y', fetchImpl: fetchStub }),
  /1 bis 100 Leads/,
);

console.log('Mein-CRM-Panasonic-Import: OK');
