import assert from 'node:assert/strict';

process.env.AIRTABLE_TOKEN = 'pat-test-token-plain';
process.env.AIRTABLE_HWP_BASE_ID = 'appBsUeEsjEBzIMDc';
process.env.AIRTABLE_HWP_TABLE_ID = 'tblGcYRzV0X9i6dqc';

const { AIRTABLE_HWP_LAYOUT } = await import('../integrations/airtable-layout.js');
const fieldNames = [AIRTABLE_HWP_LAYOUT.stage.fieldName, ...Object.values(AIRTABLE_HWP_LAYOUT.fields)];
const fields = fieldNames.map((name, index) => ({
  id: `fld${String(index + 1).padStart(14, '0')}`,
  name,
  type: name === 'Stage' ? 'singleSelect' : (name === 'Angebot korrigiert' ? 'multipleAttachments' : 'singleLineText'),
  ...(name === 'Stage' ? { options: { choices: [{ id: AIRTABLE_HWP_LAYOUT.stage.installationQueueChoiceId, name: AIRTABLE_HWP_LAYOUT.stage.installationQueueName }] } } : {}),
}));
const byName = new Map(fields.map(field => [field.name, field.id]));
const queueRecord = {
  id: 'recQueue000000001',
  createdTime: '2026-08-29T06:00:00.000Z',
  fields: {
    [byName.get('Stage')]: 'Installation Queue',
    [byName.get('Kunde')]: 'Test Kunde',
    [byName.get('Projektanschrift')]: 'Testweg 1',
    [byName.get('Installationsdatum (geplant)')]: '2026-09-07',
    [byName.get('Angebot korrigiert')]: [{ id: 'attCorrected00001', filename: 'Angebot korrigiert.pdf', size: 12, type: 'application/pdf', url: 'https://v5.airtableusercontent.com/test.pdf' }],
    [byName.get('ID (HERO)')]: 'HERO-1',
    [byName.get('Emailadresse')]: 'test@example.invalid',
  },
};
let sawBearer = false;
let sawQueueFormula = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.hostname === 'v5.airtableusercontent.com') return new Response(Buffer.from('%PDF-test'), { status: 200, headers: { 'Content-Type': 'application/pdf' } });
  sawBearer ||= options.headers?.Authorization === 'Bearer pat-test-token-plain';
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.pathname === '/v0/meta/bases/appBsUeEsjEBzIMDc/tables') return json({ tables: [{ id: AIRTABLE_HWP_LAYOUT.tableId, name: 'Projekte', fields }] });
  if (url.pathname === '/v0/appBsUeEsjEBzIMDc/tblGcYRzV0X9i6dqc') {
    sawQueueFormula ||= url.searchParams.get('filterByFormula') === "{Stage}='Installation Queue'";
    return json({ records: [queueRecord] });
  }
  if (url.pathname === '/v0/appBsUeEsjEBzIMDc/tblGcYRzV0X9i6dqc/recQueue000000001') return json(queueRecord);
  return json({ error: { message: `Unerwarteter Testaufruf ${url.pathname}` } }, 500);
};

const {
  airtableRequest,
  airtableStatus,
  downloadAirtableCorrectedOffer,
  getAirtableHwpSchema,
  getAirtableWorkflowRecord,
  listAirtableInstallationQueue,
  listAirtableWorkflowStage,
  probeAirtable,
  searchAirtableWorkflowRecords,
} = await import('../integrations/airtable.js');
const { airtableSkill, airtableSkillMeta } = await import('../skills/airtable.js');

try {
  const schema = await getAirtableHwpSchema();
  assert.equal(schema.drift.matches, true);
  const queue = await listAirtableInstallationQueue();
  assert.equal(queue.count, 1);
  assert.equal(queue.records[0].customer, 'Test Kunde');
  assert.equal(queue.records[0].correctedOfferAttachments[0].filename, 'Angebot korrigiert.pdf');
  assert.equal(JSON.stringify(queue).includes('airtableusercontent.com'), false);
  assert.equal(sawQueueFormula, true);
  const search = await searchAirtableWorkflowRecords('HERO-1');
  assert.equal(search.totalMatches, 1);
  assert.equal((await listAirtableWorkflowStage({ stage: AIRTABLE_HWP_LAYOUT.stage.installationQueueChoiceId })).count, 1);
  const detail = await getAirtableWorkflowRecord('recQueue000000001');
  assert.equal(detail.record.plannedInstallationDate, '2026-09-07');
  const file = await downloadAirtableCorrectedOffer({ recordId: 'recQueue000000001', attachmentId: 'attCorrected00001' });
  assert.equal(file.buffer.toString(), '%PDF-test');
  assert.equal((await probeAirtable()).installationQueueRecords, 1);
  assert.equal((await airtableStatus()).writeEnabled, false);
  await assert.rejects(airtableRequest('/v0/test', { method: 'PATCH' }), /gesperrt/);
  assert.equal(sawBearer, true);
  const tools = airtableSkill({ status: airtableStatus, listInstallationQueue: listAirtableInstallationQueue, listWorkflowStage: listAirtableWorkflowStage, searchRecords: searchAirtableWorkflowRecords, getRecord: getAirtableWorkflowRecord });
  assert.deepEqual(Object.keys(tools), airtableSkillMeta.toolNames);
  assert.equal(Object.keys(tools).some(name => /create|update|delete|write/i.test(name)), false);
  console.log('Airtable-Schema, Read-only-Datenzugriff, IVA-Werkzeuge und korrigierter Angebotsdownload erfolgreich verifiziert.');
} finally {
  globalThis.fetch = realFetch;
}
