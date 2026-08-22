import assert from 'node:assert/strict';
import { importPanasonicLeadsToMeinCrm, meinCrmPanasonicPolicy } from '../integrations/meincrm-panasonic-leads.js';

const calls = [];
const responses = [
  [],
  [{ id: '7ef67f00-25a1-4bfd-8f42-a8aaecb31b75', email: 'n.sell@heat-hero.com' }],
  [{ id: 77, user_id: '7ef67f00-25a1-4bfd-8f42-a8aaecb31b75', name: 'Vertrieb Innendienst', email: 'n.sell@heat-hero.com' }],
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
  serviceKey: 'service-test-key', projectId: '2e8f1cf6-4579-4d07-8c65-5b1ac4e954a8', restBase: 'https://example.invalid/rest/v1', fetchImpl: fetchStub,
});

assert.equal(result.created, 1);
assert.equal(result.duplicates, 1);
assert.equal(result.source, 'Panasonic');
assert.equal(result.advisor.id, 77);
assert.equal(meinCrmPanasonicPolicy.advisor.email, 'n.sell@heat-hero.com');

const advisorInsert = calls.find(call => call.url.includes('/vertriebler') && call.method === 'POST');
assert.deepEqual(advisorInsert.body, { name: 'Vertrieb Innendienst', email: 'n.sell@heat-hero.com', user_id: '7ef67f00-25a1-4bfd-8f42-a8aaecb31b75' });

const leadInsert = calls.find(call => call.url.includes('/leads') && call.method === 'POST');
assert.equal(leadInsert.body.quelle, 'Panasonic');
assert.equal(leadInsert.body.project_id, '2e8f1cf6-4579-4d07-8c65-5b1ac4e954a8');
assert.equal(leadInsert.body.assigned_user_id, '7ef67f00-25a1-4bfd-8f42-a8aaecb31b75');
assert.equal(leadInsert.body.fachberater_id, 77);
assert.equal(leadInsert.body.fachberater_name, 'Vertrieb Innendienst');
assert.equal('anrede' in leadInsert.body, false);
assert.equal('kundentyp' in leadInsert.body, false);
assert.match(leadInsert.body.notizen, /abcdef0123456789abcdef0123456789/);

const splitDbResponses = [
  { ok: true, status: 200, body: [] },
  { ok: false, status: 404, body: { message: "Could not find the table 'public.profiles' in the schema cache" } },
  { ok: true, status: 201, body: [{ id: 88, name: 'Vertrieb Innendienst', email: 'n.sell@heat-hero.com' }] },
  { ok: true, status: 200, body: [] },
  { ok: true, status: 201, body: [{ id: 102 }] },
];
const splitDbCalls = [];
async function splitDbFetchStub(url, options = {}) {
  const response = splitDbResponses.shift();
  splitDbCalls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
  return { ok: response.ok, status: response.status, text: async () => JSON.stringify(response.body) };
}
const splitDbResult = await importPanasonicLeadsToMeinCrm([{
  name: 'Getrennte Datenbank', email: 'split@example.de', telefon: '+491703333333',
  promatchId: '22222222222222222222222222222222', details: 'Profil liegt zentral',
}], {
  serviceKey: 'service-test-key', projectId: '3', restBase: 'https://example.invalid/rest/v1', fetchImpl: splitDbFetchStub,
});
assert.equal(splitDbResult.created, 1);
assert.equal(splitDbResult.advisor.id, 88);
assert.equal(splitDbResult.projectId, null);
assert.equal(splitDbResult.projectScope, 'dedicated-database');
const splitLeadInsert = splitDbCalls.find(call => call.url.includes('/leads') && call.method === 'POST');
assert.equal('project_id' in splitLeadInsert.body, false);
assert.equal('assigned_user_id' in splitLeadInsert.body, false);
assert.equal(splitLeadInsert.body.fachberater_id, 88);

const dedicatedCalls = [];
const dedicatedResponses = [
  [], [], [],
  [{ id: 1254 }],
];
async function dedicatedFetchStub(url, options = {}) {
  const response = dedicatedResponses.shift();
  dedicatedCalls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
  return { ok: true, status: options.method === 'POST' ? 201 : 200, text: async () => JSON.stringify(response) };
}
const dedicatedResult = await importPanasonicLeadsToMeinCrm([{
  name: 'Aktives Heat Hero', email: 'active@example.de', telefon: '+491704444444',
  strasse: 'Testweg', hausnummer: '4', plz: '40211', ort: 'Düsseldorf',
  promatchId: '33333333333333333333333333333333', impRequestId: 'REQ-3', details: 'Rückruf vormittags',
}], {
  externalSupabaseUrl: 'https://active.example.invalid',
  externalAnonKey: 'publishable-test-key',
  externalAdvisorId: 67,
  fetchImpl: dedicatedFetchStub,
});
assert.equal(dedicatedResult.created, 1);
assert.equal(dedicatedResult.projectScope, 'heat-hero-external-database');
assert.equal(dedicatedResult.advisor.id, 67);
const dedicatedLeadInsert = dedicatedCalls.find(call => call.url.includes('/leads') && call.method === 'POST');
assert.equal(dedicatedLeadInsert.body.quelle, 'Panasonic');
assert.equal(dedicatedLeadInsert.body.status_detail, 'neu');
assert.equal(dedicatedLeadInsert.body.vp_id, 67);
assert.equal(dedicatedLeadInsert.body.fachberater, 'Vertrieb Innendienst');
assert.equal(dedicatedLeadInsert.body.qualifizierungsdaten.promatch_id, '33333333333333333333333333333333');
assert.equal(dedicatedLeadInsert.body.qualifizierungsdaten.imp_id, 'REQ-3');
assert.equal('project_id' in dedicatedLeadInsert.body, false);
assert.equal('anrede' in dedicatedLeadInsert.body, false);
assert.equal('kundentyp' in dedicatedLeadInsert.body, false);

await assert.rejects(
  () => importPanasonicLeadsToMeinCrm([{
    name: 'Unvollständig', email: 'broken@example.de', promatchId: '44444444444444444444444444444444',
  }], {
    externalSupabaseUrl: 'https://active.example.invalid', fetchImpl: dedicatedFetchStub,
  }),
  /unvollstaendig konfiguriert/,
);

await assert.rejects(
  () => importPanasonicLeadsToMeinCrm([], { serviceKey: 'x', projectId: 'y', fetchImpl: fetchStub }),
  /1 bis 100 Leads/,
);

console.log('Mein-CRM-Panasonic-Import: OK');
