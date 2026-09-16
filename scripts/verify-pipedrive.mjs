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
const dealFields = Object.values(PIPEDRIVE_LAYOUT.dealFields).map(item => ({
  id: item.id,
  key: item.key,
  name: item.name,
  field_type: item.name === 'Anlage' ? 'enum' : 'varchar',
  active_flag: true,
  ...(item.name === 'Anlage' ? { options: [{ id: 42, label: 'Vaillant 5 kW' }] } : {}),
}));
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
    [PIPEDRIVE_LAYOUT.dealFields.plant.key]: { id: 42, label: 'Vaillant 5 kW' },
  },
};
let tokenRefreshes = 0;
let lastApiTokenQuery = '';
let lastDealCustomFields = '';
let failPersonFetch = false;
let personValues = { id: 5, name: 'Max Muster', emails: [{ value: 'kunde@example.test', primary: true }], phones: [{ value: '+4912345', primary: true }] };
let personPatches = 0;
let paginateFunding = false, invalidFundingPage = false;
const fileContents = new Map([['44', Buffer.from('%PDF-pipedrive-test')]]);
let filePosts = 0, corruptUploadedFile = false, omitUploadedId = false, wrongUploadedId = false;

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
  if (url.pathname === '/api/v2/persons/5') {
    if (failPersonFetch) return json({ success: false, error: 'rate limited' }, 429);
    if (String(options.method || 'GET').toUpperCase() === 'PATCH') {
      personPatches += 1;
      personValues = { ...personValues, ...JSON.parse(options.body) };
    }
    return ok(personValues);
  }
  if (url.pathname === '/api/v2/organizations/7') return ok({ id: 7, name: 'Muster GmbH' });
  if (url.pathname === '/api/v1/notes' && String(options.method || 'GET').toUpperCase() === 'POST') {
    const body = JSON.parse(String(options.body || '{}'));
    const note = { id: notes.length + 1, deal_id: body.deal_id, content: body.content };
    notes.push(note);
    return ok(note);
  }
  if (url.pathname === '/api/v1/notes' || url.pathname === '/api/v1/deals/123/files') {
    const rows = url.pathname === '/api/v1/notes' ? notes : files;
    if (!paginateFunding) return ok(rows);
    const start = Number(url.searchParams.get('start') || 0), data = rows.slice(start, start + 2);
    return json({ success: true, data, additional_data: { pagination: { more_items_in_collection: start + 2 < rows.length, next_start: invalidFundingPage ? start : start + 2 } } });
  }
  const downloadId = url.pathname.match(/^\/api\/v1\/files\/(\d+)\/download$/)?.[1];
  if (downloadId) return fileContents.has(downloadId)
    ? new Response(fileContents.get(downloadId), { status: 200, headers: { 'Content-Type': 'application/pdf' } })
    : json({ success: false, error: 'File missing' }, 404);
  if (url.pathname === '/api/v1/files' && String(options.method || '').toUpperCase() === 'POST') {
    filePosts++;
    const upload = options.body.get('file'), id = Math.max(44, ...files.map(file => Number(file.id))) + 1;
    files.push({ id, name: upload.name });
    fileContents.set(String(id), corruptUploadedFile ? Buffer.from('%PDF-unexpected-content') : Buffer.from(await upload.arrayBuffer()));
    return ok(omitUploadedId ? {} : wrongUploadedId ? { id: id + 1000 } : files.at(-1));
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
  completePipedriveFundingHandoffApi,
  listPipedriveFundingHandoffs,
  downloadPipedriveDealFile,
  getPipedriveDealBundle,
  getPipedriveFundingSnapshot,
  getPipedriveStructure,
  listPipedriveFundingBoard,
  listPipedriveDeals,
  missingPipedriveFundingRequiredFields,
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
  const fundingBoard = await listPipedriveFundingBoard({ includeOffers: true });
  assert.equal(fundingBoard.source, 'iva-core-pipedrive-api');
  assert.equal(fundingBoard.stages['Angebot veröffentlicht'][0].id, '123');
  const fundingSnapshot = await getPipedriveFundingSnapshot(123);
  assert.equal(fundingSnapshot.customerName, 'Max Muster');
  assert.equal(fundingSnapshot.customerEmail, 'kunde@example.test');
  assert.equal(fundingSnapshot.phoneNumber, '+4912345');
  assert.equal(fundingSnapshot.orderNumber, 'HH-100');
  assert.equal(fundingSnapshot.plant, 'Vaillant 5 kW');
  assert.equal(fundingSnapshot.fileRecords[0].id, '44');
  assert.equal(fundingSnapshot.source, 'iva-core-pipedrive-api');
  assert.equal(fundingSnapshot.requiredFieldSources.phoneNumber, 'person');
  assert.equal(fundingSnapshot.requiredFieldSources.customerEmail, 'person');
  // A number in the title is a lookup hint, not a saved order field.
  dealValues.title = 'Max Muster - HH-AN-4-26-1234';
  dealValues.custom_fields[PIPEDRIVE_LAYOUT.dealFields.orderNumber.key] = null;
  personValues.phones = [];
  const incompleteSnapshot = await getPipedriveFundingSnapshot(123);
  assert.equal(incompleteSnapshot.titleOrderNumberHint, 'HH-AN-4-26-1234');
  assert.equal(incompleteSnapshot.orderNumber, null);
  assert.equal(incompleteSnapshot.phoneNumber, null);
  assert.deepEqual(missingPipedriveFundingRequiredFields(incompleteSnapshot), ['Telefonnummer', 'Auftragsnummer']);
  dealValues.title = 'Testdeal';
  dealValues.custom_fields[PIPEDRIVE_LAYOUT.dealFields.orderNumber.key] = 'HH-100';
  personValues.phones = [{ value: '+4912345', primary: true }];
  assert.deepEqual(missingPipedriveFundingRequiredFields({
    customerEmail: 'kunde@example.test', phoneNumber: '+4912345', plant: 'Vaillant 5 kW', orderNumber: 'HH-100',
  }), []);
  assert.deepEqual(missingPipedriveFundingRequiredFields({
    customerEmail: '', phoneNumber: null, plant: '  ', orderNumber: 'HH-100',
  }), ['E-Mail', 'Telefonnummer', 'Anlage']);
  failPersonFetch = true;
  await assert.rejects(getPipedriveFundingSnapshot(123), /rate limited/,
    'ein technischer Kontaktabruf-Fehler darf nicht als leere Kundendaten erscheinen');
  failPersonFetch = false;
  const downloaded = await downloadPipedriveDealFile({ dealId: 123, fileId: 44 });
  assert.equal(downloaded.buffer.toString(), '%PDF-pipedrive-test');

  await assert.rejects(
    createPipedriveDealNote({ dealId: 123, text: 'Geprüfter Test', confirmation: PIPEDRIVE_WRITE_CONFIRMATION }),
    /noch nicht freigeschaltet/,
  );
  process.env.PIPEDRIVE_WRITE_ENABLED = 'true';
  await assert.rejects(createPipedriveDealNote({ dealId: 123, text: 'Voraussichtlich 30 % Förderung', confirmation: PIPEDRIVE_WRITE_CONFIRMATION }), { code: 'FUNDING_HANDOFF_REQUIRED' });
  await assert.rejects(createPipedriveDealNote({ dealId: 123, text: 'Zuschussbetrag offen', confirmation: PIPEDRIVE_WRITE_CONFIRMATION }, true), { code: 'FUNDING_HANDOFF_REQUIRED' });
  await assert.rejects(updatePipedriveDealStage({ dealId: 123, expectedStageId: 19, targetStageId: 18, confirmation: PIPEDRIVE_WRITE_CONFIRMATION }), { code: 'FUNDING_HANDOFF_REQUIRED' });
  dealValues.custom_fields[PIPEDRIVE_LAYOUT.dealFields.orderNumber.key] = null;
  const fieldBatch = await updatePipedriveDealFieldsByName({ dealId: 123, updates: [{ field: 'Auftragsnummer', value: 'HH-200' }], confirmation: PIPEDRIVE_WRITE_CONFIRMATION });
  assert.equal(fieldBatch.fullyVerified, true);
  assert.equal(fieldBatch.results[0].status, 'updated_and_verified');
  personValues.phones = [];
  await assert.rejects(updatePipedriveDealStage({ dealId: 123, expectedStageId: 20, targetStageId: 19, confirmation: PIPEDRIVE_WRITE_CONFIRMATION }), { code: 'FUNDING_REQUIRED_FIELDS_MISSING' });
  assert.equal(dealStage, 20);
  const phoneRepair = await updatePipedriveDealFieldsByName({ dealId: 123, updates: [{ field: 'Telefonnummer', value: '0123456789' }], confirmation: PIPEDRIVE_WRITE_CONFIRMATION });
  assert.equal(phoneRepair.fullyVerified, true);
  assert.equal(phoneRepair.results[0].entity, 'person');
  assert.equal(personPatches, 1);
  assert.equal((await getPipedriveFundingSnapshot(123)).phoneNumber, '0123456789');
  assert.equal(personValues.emails[0].value, 'kunde@example.test', 'phone repair leaves customer email unchanged');
  const repeatPhone = await updatePipedriveDealFieldsByName({ dealId: 123, updates: [{ field: 'Telefonnummer', value: '+49 123456789' }], confirmation: PIPEDRIVE_WRITE_CONFIRMATION });
  assert.equal(repeatPhone.fullyVerified, true);
  assert.equal(personPatches, 1, 'already present phone is not written twice');
  const conflictingPhone = await updatePipedriveDealFieldsByName({ dealId: 123, updates: [{ field: 'Telefonnummer', value: '0999999999' }], confirmation: PIPEDRIVE_WRITE_CONFIRMATION });
  assert.equal(conflictingPhone.fullyVerified, false);
  assert.equal(conflictingPhone.results[0].status, 'existing_value_conflict');
  assert.equal(personPatches, 1, 'a conflicting existing phone must be preserved');
  personValues.emails = [];
  const emailRepair = await updatePipedriveDealFieldsByName({ dealId: 123, updates: [{ field: 'E-Mail', value: 'kunde@example.test' }], confirmation: PIPEDRIVE_WRITE_CONFIRMATION });
  assert.equal(emailRepair.fullyVerified, true);
  assert.equal(emailRepair.results[0].entity, 'person');
  assert.equal(personValues.phones[0].value, '0123456789');
  assert.equal(personPatches, 2);
  const uploadedFile = await uploadPipedriveDealFile({ dealId: 123, filename: 'Korrektur.pdf', buffer: Buffer.from('%PDF-upload') });
  assert.equal(uploadedFile.fileId, '45');
  assert.equal(uploadedFile.contentVerified, true);
  assert.equal(uploadedFile.size, Buffer.byteLength('%PDF-upload'));
  assert.match(uploadedFile.sha256, /^[0-9a-f]{64}$/);
  const repeatedFile = await uploadPipedriveDealFile({ dealId: 123, filename: 'Korrektur.pdf', buffer: Buffer.from('%PDF-upload') });
  assert.equal(repeatedFile.alreadyPresent, true);
  assert.equal(repeatedFile.fileId, '45', 'a reused file supplies the real ID required by mail completion');
  assert.equal(repeatedFile.contentVerified, true);
  assert.equal(filePosts, 1, 'an identical retry must not create another file');
  await assert.rejects(uploadPipedriveDealFile({ dealId: 123, filename: 'Korrektur.pdf', buffer: Buffer.from('%PDF-other') }), { code: 'PIPEDRIVE_FILE_CONTENT_CONFLICT' });
  assert.equal(filePosts, 1, 'a same-name content conflict must not write or claim success');
  files.push({ id: 46, name: 'Korrektur.pdf' });
  fileContents.set('46', Buffer.from('%PDF-other-version'));
  paginateFunding = true;
  const exactExistingVersion = await uploadPipedriveDealFile({ dealId: 123, filename: 'Korrektur.pdf', buffer: Buffer.from('%PDF-other-version') });
  assert.equal(exactExistingVersion.fileId, '46', 'duplicate names beyond the first page are resolved by exact file content');
  paginateFunding = false;
  assert.equal(filePosts, 1);
  fileContents.delete('45');
  await assert.rejects(uploadPipedriveDealFile({ dealId: 123, filename: 'Korrektur.pdf', buffer: Buffer.from('%PDF-upload') }), /nicht geladen/);
  assert.equal(filePosts, 1, 'an unreadable existing file must not be replaced or treated as verified');
  fileContents.set('45', Buffer.from('%PDF-upload'));
  corruptUploadedFile = true;
  await assert.rejects(uploadPipedriveDealFile({ dealId: 123, filename: 'Beschaedigt.pdf', buffer: Buffer.from('%PDF-upload') }), { code: 'PIPEDRIVE_FILE_READBACK_MISMATCH' });
  corruptUploadedFile = false;
  omitUploadedId = true;
  await assert.rejects(uploadPipedriveDealFile({ dealId: 123, filename: 'Ohne-ID.pdf', buffer: Buffer.from('%PDF-upload') }), /keine eindeutige Datei-ID/);
  omitUploadedId = false;
  const reconciledFile = await uploadPipedriveDealFile({ dealId: 123, filename: 'Ohne-ID.pdf', buffer: Buffer.from('%PDF-upload') });
  assert.equal(reconciledFile.alreadyPresent, true, 'an uncertain POST is reconciled against real content');
  assert.equal(filePosts, 3);
  wrongUploadedId = true;
  await assert.rejects(uploadPipedriveDealFile({ dealId: 123, filename: 'Fremde-ID.pdf', buffer: Buffer.from('%PDF-upload') }), /nicht eindeutig bestätigt/);
  wrongUploadedId = false;
  files = files.filter(file => [44, 45].includes(file.id));
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
  personValues.phones = [];
  await assert.rejects(updatePipedriveDealStage({ dealId: 123, expectedStageId: 20, targetStageId: 19, confirmation: PIPEDRIVE_WRITE_CONFIRMATION }), { code: 'FUNDING_REQUIRED_FIELDS_MISSING' }, 'an already advanced but incomplete deal cannot report verified completion');
  personValues.phones = [{ value: '0123456789', primary: true }];

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

  // The official wrapper is the only authority that can move 19 -> 18 and
  // publish an amount note, with a fresh full review and a verified readback.
  const { fundingHandoffSnapshotFingerprint } = await import('../local-mac-helper/funding-handoff-policy.mjs');
  for (const [index, name] of ['Unterschriebenes Angebot.pdf', 'Personalausweis.pdf', 'Meldebescheinigung.pdf', 'Grundbuchauszug.pdf', 'KfW-Kontobestätigung.pdf'].entries()) files.push({ id: 100 + index, name });
  for (const content of ['Weitere geprüfte Information', 'Ergänzung zur Unterlagenprüfung']) notes.push({ id: notes.length + 1, deal_id: 123, content });
  paginateFunding = true; invalidFundingPage = true;
  await assert.rejects(getPipedriveFundingSnapshot(123), /weitere Seiten/);
  invalidFundingPage = false;
  const reviewedSnapshot = await getPipedriveFundingSnapshot(123);
  assert.equal(reviewedSnapshot.fileRecords.length, files.length);
  assert.equal(reviewedSnapshot.noteCount, notes.length);
  const documentReview = { dealId: '123', checkedAt: new Date().toISOString(), complete: true, sourceNotesChecked: true, incomeBonusRequested: false,
    snapshotFingerprint: fundingHandoffSnapshotFingerprint(reviewedSnapshot),
    documentEvidence: Object.fromEntries(['signed_offer', 'identity_card', 'registration_certificate', 'land_register', 'kfw_account_confirmation'].map(type => [type, 'present_in_pipedrive'])),
    files: reviewedSnapshot.fileRecords.map(file => ({ fileId: file.id, readable: true, identityVerified: true })) };
  const handoffResult = { canUseForFundingNote: true, units: 1, estimatedGrant: 9000, eligibleCosts: 30000, selfUsed: false, buildingBaseRate: 30, buildingBaseGrant: 9000, bonuses: { base: 30, climateSpeed: 0, income: 0 }, incomeBonusRequested: false };
  const noteCountBeforeHandoff = notes.length;
  const handoff = await completePipedriveFundingHandoffApi({ dealId: '123', documentReview, result: handoffResult, confirmation: PIPEDRIVE_WRITE_CONFIRMATION });
  assert.equal(handoff.verified, true); assert.equal(handoff.stageVerified, true); assert.equal(dealStage, 18);
  assert.equal(notes.length, noteCountBeforeHandoff + 1);
  assert.match(notes.at(-1).content, /Voraussichtlich 30 % Förderung/);
  assert.match(notes.at(-1).content, /Förderung \(9\.000,00 €\)<br>Grundförderung/);
  const replay = await completePipedriveFundingHandoffApi({ dealId: '123', confirmation: PIPEDRIVE_WRITE_CONFIRMATION });
  assert.equal(replay.alreadyPresent, true); assert.equal(notes.length, noteCountBeforeHandoff + 1);
  assert.deepEqual((await listPipedriveFundingHandoffs()).handoffs, []);
  const missingReconciliation = await createPipedriveDealNote({ dealId: '123', text: 'Noch nicht sichtbare Informationsnotiz', reconcileOnly: true, confirmation: PIPEDRIVE_WRITE_CONFIRMATION });
  assert.equal(missingReconciliation.verified, false); assert.equal(notes.length, noteCountBeforeHandoff + 1);

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
