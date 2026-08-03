import assert from 'node:assert/strict';
import {
  callQonektoCustomerUpsertAutomation,
  isReadOnlyQonektoTool,
  isConfirmableQonektoWriteTool,
  isExplicitQonektoConfirmation,
  normalizeQonektoToolCollection,
  qonektoStatus,
  QONEKTO_DEFAULT_MCP_URL,
} from '../integrations/qonekto.js';

assert.equal(QONEKTO_DEFAULT_MCP_URL, 'https://app.qonekto.de/api/goalsandconcepts/mcp');

assert.equal(isReadOnlyQonektoTool({ name: 'list_customers' }), true);
assert.equal(isReadOnlyQonektoTool({ name: 'search_contracts' }), true);
assert.equal(isReadOnlyQonektoTool({ name: 'getAssets' }), true);
assert.equal(isReadOnlyQonektoTool({ name: 'search_archive_documents' }), true);
assert.equal(isReadOnlyQonektoTool({ name: 'list_closed_claims' }), true);
assert.equal(isReadOnlyQonektoTool({ name: 'customer_details', annotations: { readOnlyHint: true } }), true);
assert.equal(isReadOnlyQonektoTool({ name: 'update_customer', annotations: { readOnlyHint: true } }), false);
assert.equal(isReadOnlyQonektoTool({ name: 'delete_contract' }), false);
assert.equal(isReadOnlyQonektoTool({ name: 'mystery_tool' }), false);
assert.equal(isReadOnlyQonektoTool({ name: 'list_and_update_customers' }), false);
assert.equal(isReadOnlyQonektoTool({ name: 'list_customers', annotations: { destructiveHint: true } }), false);

assert.equal(isConfirmableQonektoWriteTool({ name: 'update_customer' }), true);
assert.equal(isConfirmableQonektoWriteTool({ name: 'change_bank_details' }), true);
assert.equal(isConfirmableQonektoWriteTool({ name: 'delete_customer' }), false);
assert.equal(isConfirmableQonektoWriteTool({ name: 'send_document' }), false);
assert.equal(isConfirmableQonektoWriteTool({ name: 'mystery_tool' }), false);
assert.equal(isConfirmableQonektoWriteTool({ name: 'get_assets' }), false);
assert.equal(isConfirmableQonektoWriteTool({ name: 'update_customer', annotations: { destructiveHint: true } }), false);

assert.equal(isExplicitQonektoConfirmation('Ja, Qonekto-Änderung ausführen'), true);
assert.equal(isExplicitQonektoConfirmation('ja qonekto änderung ausführen.'), true);
assert.equal(isExplicitQonektoConfirmation('Ja, mach das'), false);
assert.equal(isExplicitQonektoConfirmation('Ändere die Adresse'), false);

assert.deepEqual(
  normalizeQonektoToolCollection({
    get_customer: { description: 'Kunde lesen', input_schema: { type: 'object', properties: { id: { type: 'string' } } } },
    update_customer: { description: 'Kunde aendern', inputSchema: { type: 'object' } },
  }).map(tool => tool.name),
  ['get_customer', 'update_customer'],
);
assert.deepEqual(
  normalizeQonektoToolCollection({ data: [{ name: 'list_contracts', description: 'Vertraege' }] }).map(tool => tool.name),
  ['list_contracts'],
);

const oldToken = process.env.QONEKTO_MCP_TOKEN;
const oldSyncEnabled = process.env.CRM_QONEKTO_SYNC_ENABLED;
delete process.env.CRM_QONEKTO_SYNC_ENABLED;
await assert.rejects(
  () => callQonektoCustomerUpsertAutomation('upsertKunde', { nachname: 'Test' }),
  /nicht aktiviert/,
);
process.env.CRM_QONEKTO_SYNC_ENABLED = 'true';
await assert.rejects(
  () => callQonektoCustomerUpsertAutomation('updateVertrag', { id: 'V-1' }),
  /Nur das freigegebene Qonekto-Kunden-Upsert/,
);
if (oldSyncEnabled === undefined) delete process.env.CRM_QONEKTO_SYNC_ENABLED;
else process.env.CRM_QONEKTO_SYNC_ENABLED = oldSyncEnabled;
delete process.env.QONEKTO_MCP_TOKEN;
assert.deepEqual(await qonektoStatus(), {
  configured: false,
  reachable: false,
  readToolCount: 0,
});
if (oldToken !== undefined) process.env.QONEKTO_MCP_TOKEN = oldToken;

console.log('Qonekto-Leseschutz, Schreibbestaetigung und Konfiguration: OK');
