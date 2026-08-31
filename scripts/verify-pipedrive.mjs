import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-pipedrive-'));
process.env.PIPEDRIVE_CLIENT_ID = 'iva-pipedrive-test-client';
process.env.PIPEDRIVE_CLIENT_SECRET = 'iva-pipedrive-test-secret';
process.env.PIPEDRIVE_REDIRECT_URI = 'https://iva.example.test/oauth/pipedrive/callback';
process.env.PIPEDRIVE_ALLOWED_COMPANY_DOMAIN = 'simplegategmbh.pipedrive.com';
process.env.PIPEDRIVE_TOKEN_KEY = 'pipedrive-test-token-encryption-key-with-enough-entropy';
process.env.PIPEDRIVE_WEBHOOK_USERNAME = 'iva-webhook';
process.env.PIPEDRIVE_WEBHOOK_PASSWORD = 'webhook-test-password';
process.env.PIPEDRIVE_WRITE_ENABLED = 'false';

const { PIPEDRIVE_LAYOUT } = await import('../integrations/pipedrive-layout.js');
const pipelines = Object.values(PIPEDRIVE_LAYOUT.pipelines).map(item => ({ id: item.id, name: item.name, active: true }));
const stages = Object.values(PIPEDRIVE_LAYOUT.stages).map(item => ({ id: item.id, pipeline_id: item.pipelineId, name: item.name, active_flag: true }));
const dealFields = Object.values(PIPEDRIVE_LAYOUT.dealFields).map(item => ({ id: item.id, key: item.key, name: item.name, field_type: 'varchar', active_flag: true }));
let notes = [];
let files = [{ id: 44, name: 'Angebot.pdf' }];
let dealStage = 20;
let dealValues = {
  title: 'Testdeal',
  value: 1000,
  currency: 'EUR',
  expected_close_date: null,
  probability: null,
  custom_fields: {
    [PIPEDRIVE_LAYOUT.dealFields.orderNumber.key]: 'HH-100',
    [PIPEDRIVE_LAYOUT.dealFields.installationWeek.key]: null,
  },
};
let tokenRefreshes = 0;
let lastApiTokenQuery = '';
let lastDealCustomFields = '';

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
  if (url.href === 'https://oauth.pipedrive.com/oauth/token') {
    const body = new URLSearchParams(String(options.body || ''));
    if (body.get('grant_type') === 'refresh_token') tokenRefreshes += 1;
    return json({
      access_token: body.get('grant_type') === 'refresh_token' ? 'refreshed-access-token-plain' : 'access-token-plain',
      refresh_token: 'refresh-token-plain',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'base,deals:read,contacts:read,activities:read,leads:read',
      api_domain: 'https://simplegategmbh.pipedrive.com',
    });
  }
  lastApiTokenQuery = String(url.searchParams.get('api_token') || '');
  if (url.pathname === '/api/v2/deals' || url.pathname === '/api/v2/deals/123') {
    lastDealCustomFields = String(url.searchParams.get('custom_fields') || '');
  }
  const ok = data => json({ success: true, data }, 200, { 'x-ratelimit-limit': '80', 'x-ratelimit-remaining': '79' });
  if (url.pathname === '/api/v1/users/me') return ok({ id: 20185601, name: 'Test User' });
  if (url.pathname === '/api/v1/pipelines') return ok(pipelines);
  if (url.pathname === '/api/v1/stages') return ok(stages);
  if (url.pathname === '/api/v1/dealFields') return ok(dealFields);
  if (url.pathname === '/api/v1/personFields') return ok([]);
  if (url.pathname === '/api/v1/organizationFields') return ok([]);
  if (url.pathname === '/api/v1/activityTypes') return ok([{ id: 1, key_string: 'call', name: 'Anruf' }]);
  if (url.pathname === '/api/v2/deals/search') return ok({ items: [{ item: { id: 123, title: 'Testdeal' } }] });
  if (url.pathname === '/api/v2/deals' && options.method !== 'PATCH') return json(
    { success: true, data: [{ id: 123, ...dealValues, stage_id: dealStage }], additional_data: { next_cursor: null } },
    200,
    { 'x-ratelimit-limit': '80', 'x-ratelimit-remaining': '79' },
  );
  if (url.pathname === '/api/v2/deals/123' && String(options.method || 'GET').toUpperCase() === 'PATCH') {
    const body = JSON.parse(String(options.body || '{}'));
    if (Object.hasOwn(body, 'stage_id')) dealStage = Number(body.stage_id);
    dealValues = {
      ...dealValues,
      ...Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'stage_id' && key !== 'custom_fields')),
      custom_fields: { ...dealValues.custom_fields, ...(body.custom_fields || {}) },
    };
    return ok({ id: 123, ...dealValues, stage_id: dealStage });
  }
  if (url.pathname === '/api/v2/deals/123') return ok({ id: 123, ...dealValues, stage_id: dealStage, person_id: 5, org_id: 7 });
  if (url.pathname === '/api/v2/persons/5') return ok({ id: 5, name: 'Max Muster' });
  if (url.pathname === '/api/v2/organizations/7') return ok({ id: 7, name: 'Muster GmbH' });
  if (url.pathname === '/api/v1/notes' && String(options.method || 'GET').toUpperCase() === 'POST') {
    const body = JSON.parse(String(options.body || '{}'));
    const note = { id: notes.length + 1, deal_id: body.deal_id, content: body.content };
    notes.push(note);
    return ok(note);
  }
  if (url.pathname === '/api/v1/notes') return ok(notes);
  if (url.pathname === '/api/v1/deals/123/files') return ok(files);
  if (url.pathname === '/api/v1/files/44/download') return new Response(Buffer.from('%PDF-pipedrive-test'), { status: 200, headers: { 'Content-Type': 'application/pdf' } });
  if (url.pathname === '/api/v1/files' && String(options.method || '').toUpperCase() === 'POST') {
    files.push({ id: 45, name: 'Korrektur.pdf' });
    return ok(files.at(-1));
  }
  if (url.pathname === '/api/v2/activities') return ok([{ id: 55, subject: 'Nachfassen' }]);
  return json({ success: false, error: `Unerwarteter Testaufruf: ${url.pathname}` }, 500);
};

const {
  PIPEDRIVE_WRITE_CONFIRMATION,
  authorizePipedriveWebhook,
  completePipedriveOAuth,
  createPipedriveAuthUrl,
  createPipedriveDealNote,
  downloadPipedriveDealFile,
  getPipedriveDealBundle,
  getPipedriveFundingSnapshot,
  getPipedriveStructure,
  listPipedriveFundingBoard,
  listPipedriveDeals,
  pipedriveRequest,
  pipedriveStatus,
  pipedriveWebhookStatus,
  recordPipedriveWebhook,
  searchPipedriveDeals,
  updatePipedriveDealField,
  updatePipedriveDealFieldsByName,
  updatePipedriveDealStage,
  uploadPipedriveDealFile,
} = await import('../integrations/pipedrive.js');
const { pipedriveSkill, pipedriveSkillMeta } = await import('../skills/pipedrive.js');

try {
  const authUrl = new URL(await createPipedriveAuthUrl());
  assert.equal(authUrl.origin, 'https://oauth.pipedrive.com');
  assert.equal(authUrl.searchParams.get('client_id'), process.env.PIPEDRIVE_CLIENT_ID);
  assert.equal(authUrl.searchParams.get('redirect_uri'), process.env.PIPEDRIVE_REDIRECT_URI);
  assert.ok(authUrl.searchParams.get('state'));

  const connected = await completePipedriveOAuth({ code: 'one-time-code', state: authUrl.searchParams.get('state') });
  assert.equal(connected.connected, true);
  assert.equal(connected.companyDomain, 'simplegategmbh.pipedrive.com');
  assert.equal(connected.probe.pipelines, 3);
  assert.equal(connected.probe.stages, 15);
  assert.equal(connected.probe.layoutMatches, true);

  const encrypted = await fs.readFile(path.join(process.env.DATA_DIR, 'pipedrive-oauth.enc.json'), 'utf8');
  assert.equal(encrypted.includes('access-token-plain'), false);
  assert.equal(encrypted.includes('refresh-token-plain'), false);

  const status = await pipedriveStatus();
  assert.equal(status.readReady, true);
  assert.equal(status.writeEnabled, false);
  assert.equal(status.webhookConfigured, true);

  const structure = await getPipedriveStructure();
  assert.equal(structure.drift.matches, true);
  assert.equal(structure.dealFields.length, Object.keys(PIPEDRIVE_LAYOUT.dealFields).length);

  const listed = await listPipedriveDeals({ pipelineId: 1, stageId: 20 });
  assert.equal(listed.deals[0].id, 123);
  assert.equal(listed.rateLimit.remaining, '79');
  assert.equal(lastDealCustomFields.split(',').length, Object.keys(PIPEDRIVE_LAYOUT.dealFields).length);

  const searched = await searchPipedriveDeals('Muster');
  assert.equal(searched.items[0].item.id, 123);

  const bundle = await getPipedriveDealBundle(123);
  assert.equal(bundle.deal.title, 'Testdeal');
  assert.equal(bundle.person.name, 'Max Muster');
  assert.equal(bundle.files[0].name, 'Angebot.pdf');
  assert.equal(bundle.activities[0].subject, 'Nachfassen');
  const fundingBoard = await listPipedriveFundingBoard();
  assert.equal(fundingBoard.source, 'iva-core-pipedrive-api');
  assert.equal(fundingBoard.stages['Angebot veröffentlicht'][0].id, '123');
  const fundingSnapshot = await getPipedriveFundingSnapshot(123);
  assert.equal(fundingSnapshot.customerName, 'Max Muster');
  assert.equal(fundingSnapshot.orderNumber, 'HH-100');
  assert.equal(fundingSnapshot.fileRecords[0].id, '44');
  assert.equal(fundingSnapshot.source, 'iva-core-pipedrive-api');
  const downloaded = await downloadPipedriveDealFile({ dealId: 123, fileId: 44 });
  assert.equal(downloaded.buffer.toString(), '%PDF-pipedrive-test');

  await assert.rejects(
    createPipedriveDealNote({ dealId: 123, text: 'Geprüfter Test', confirmation: PIPEDRIVE_WRITE_CONFIRMATION }),
    /noch nicht freigeschaltet/,
  );
  process.env.PIPEDRIVE_WRITE_ENABLED = 'true';
  dealValues.custom_fields[PIPEDRIVE_LAYOUT.dealFields.orderNumber.key] = null;
  const fieldBatch = await updatePipedriveDealFieldsByName({ dealId: 123, updates: [{ field: 'Auftragsnummer', value: 'HH-200' }], confirmation: PIPEDRIVE_WRITE_CONFIRMATION });
  assert.equal(fieldBatch.fullyVerified, true);
  assert.equal(fieldBatch.results[0].status, 'updated_and_verified');
  const uploadedFile = await uploadPipedriveDealFile({ dealId: 123, filename: 'Korrektur.pdf', buffer: Buffer.from('%PDF-upload') });
  assert.equal(uploadedFile.uploaded, true);
  assert.equal(uploadedFile.verified, true);
  const note = await createPipedriveDealNote({ dealId: 123, text: 'Geprüfter Test', confirmation: PIPEDRIVE_WRITE_CONFIRMATION });
  assert.equal(note.created, true);
  assert.equal(note.verified, true);
  const duplicateNote = await createPipedriveDealNote({ dealId: 123, text: 'Geprüfter Test', confirmation: PIPEDRIVE_WRITE_CONFIRMATION });
  assert.equal(duplicateNote.alreadyPresent, true);

  const moved = await updatePipedriveDealStage({ dealId: 123, expectedStageId: 20, targetStageId: 19, confirmation: PIPEDRIVE_WRITE_CONFIRMATION });
  assert.equal(moved.changed, true);
  assert.equal(moved.verified, true);
  assert.equal(dealStage, 19);

  const titleUpdate = await updatePipedriveDealField({
    dealId: 123,
    field: 'title',
    expectedValue: 'Testdeal',
    value: 'Testdeal aktualisiert',
    confirmation: PIPEDRIVE_WRITE_CONFIRMATION,
  });
  assert.equal(titleUpdate.changed, true);
  assert.equal(titleUpdate.verified, true);
  assert.equal(dealValues.title, 'Testdeal aktualisiert');

  const orderNumberUpdate = await updatePipedriveDealField({
    dealId: 123,
    field: 'orderNumber',
    expectedValue: 'HH-200',
    value: 'HH-101',
    confirmation: PIPEDRIVE_WRITE_CONFIRMATION,
  });
  assert.equal(orderNumberUpdate.changed, true);
  assert.equal(orderNumberUpdate.value, 'HH-101');
  assert.equal(dealValues.custom_fields[PIPEDRIVE_LAYOUT.dealFields.orderNumber.key], 'HH-101');

  const unchangedWeek = await updatePipedriveDealField({
    dealId: 123,
    field: 'installationWeek',
    expectedValue: null,
    value: null,
    confirmation: PIPEDRIVE_WRITE_CONFIRMATION,
  });
  assert.equal(unchangedWeek.alreadyPresent, true);
  await assert.rejects(updatePipedriveDealField({
    dealId: 123,
    field: 'orderNumber',
    expectedValue: 'veraltet',
    value: 'HH-102',
    confirmation: PIPEDRIVE_WRITE_CONFIRMATION,
  }), /seit dem Lesen/);
  await assert.rejects(updatePipedriveDealField({
    dealId: 123,
    field: 'beliebigerApiKey',
    expectedValue: null,
    value: 'unerlaubt',
    confirmation: PIPEDRIVE_WRITE_CONFIRMATION,
  }), /nicht freigegeben/);

  await assert.rejects(pipedriveRequest('/api/v1/files/1', { method: 'DELETE', write: true }), /Löschaktionen/);
  await assert.rejects(createPipedriveDealNote({ dealId: 123, text: 'Ohne Freigabe' }), /Schreibbestätigung/);

  const authHeader = `Basic ${Buffer.from('iva-webhook:webhook-test-password').toString('base64')}`;
  assert.equal(authorizePipedriveWebhook(authHeader), true);
  assert.equal(authorizePipedriveWebhook(`Basic ${Buffer.from('iva-webhook:falsch').toString('base64')}`), false);
  const webhook = { meta: { id: 'event-1', action: 'change', entity: 'deal', entity_id: 123, change_source: 'app', attempt: 0, timestamp: '2026-08-29T06:00:00Z' }, data: { id: 123, title: 'Kundendaten werden nicht gespeichert' } };
  assert.equal((await recordPipedriveWebhook(webhook)).duplicate, false);
  assert.equal((await recordPipedriveWebhook(webhook)).duplicate, true);
  const webhookStatus = await pipedriveWebhookStatus();
  assert.equal(webhookStatus.events, 1);
  const storedWebhook = await fs.readFile(path.join(process.env.DATA_DIR, 'pipedrive-webhook-events.json'), 'utf8');
  assert.equal(storedWebhook.includes('Kundendaten werden nicht gespeichert'), false);
  assert.equal(tokenRefreshes, 0);

  process.env.PIPEDRIVE_API_TOKEN = 'pipedrive-api-token-plain';
  const tokenStatus = await pipedriveStatus({ probe: true });
  assert.equal(tokenStatus.readReady, true);
  assert.equal(tokenStatus.authMode, 'api-token');
  assert.equal(tokenStatus.lastProbe.layoutMatches, true);
  assert.equal(lastApiTokenQuery, 'pipedrive-api-token-plain');

  const registeredTools = pipedriveSkill({
    status: pipedriveStatus,
    searchDeals: searchPipedriveDeals,
    listDeals: listPipedriveDeals,
    getDealBundle: getPipedriveDealBundle,
    createDealNote: createPipedriveDealNote,
    updateDealStage: updatePipedriveDealStage,
    updateDealField: updatePipedriveDealField,
  });
  assert.deepEqual(Object.keys(registeredTools), pipedriveSkillMeta.toolNames);
  assert.equal(Object.hasOwn(registeredTools, 'deletePipedriveDeal'), false);

  console.log('Pipedrive-API/OAuth, IVA-Werkzeuge, Live-Lesen, Schreibschutz und Webhook erfolgreich verifiziert.');
} finally {
  globalThis.fetch = realFetch;
}
