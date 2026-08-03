import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  isStrategyConversationLead,
  normalizeCrmLeadForQonekto,
  runCrmQonektoSync,
} from '../integrations/crm-qonekto-sync.js';

const original = {
  DATA_DIR: process.env.DATA_DIR,
  CRM_QONEKTO_SYNC_ENABLED: process.env.CRM_QONEKTO_SYNC_ENABLED,
  CRM_QONEKTO_SYNC_STAGE: process.env.CRM_QONEKTO_SYNC_STAGE,
};
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-crm-qonekto-'));
process.env.DATA_DIR = directory;
process.env.CRM_QONEKTO_SYNC_ENABLED = 'true';
process.env.CRM_QONEKTO_SYNC_STAGE = 'Strategiegespräch';

try {
  const normalized = normalizeCrmLeadForQonekto({
    id: 'L-1',
    status_detail: 'Strategiegespräch vereinbart',
    contact: { first_name: 'Mara', last_name: 'Muster', email: 'mara@example.test' },
    address: { street: 'Testweg 1', postal_code: '12345', city: 'Berlin' },
  });
  assert.equal(normalized.id, 'L-1');
  assert.equal(normalized.values.vorname, 'Mara');
  assert.equal(normalized.values.nachname, 'Muster');
  assert.equal(normalized.values.kommunikation.email, 'mara@example.test');
  assert.equal(normalized.values.plz, '12345');
  assert.equal(isStrategyConversationLead(normalized.stage), true);

  let phone = '+49 170 1234567';
  let calls = 0;
  const fetchLeads = async () => ({
    leads: [
      { id: 'L-1', status_detail: 'Strategiegespräch', vorname: 'Mara', nachname: 'Muster', email: 'mara@example.test', telefon: phone },
      { id: 'L-2', status_detail: 'Neu', vorname: 'Nicht', nachname: 'Relevant' },
    ],
  });
  const upsertCustomer = async values => {
    calls += 1;
    return { tool: 'upsertKunde', customer: { id: `K-${values.nachname}` } };
  };

  const first = await runCrmQonektoSync({ fetchLeads, upsertCustomer });
  assert.equal(first.candidates, 1);
  assert.equal(first.createdOrUpdated, 1);
  assert.equal(calls, 1);

  const second = await runCrmQonektoSync({ fetchLeads, upsertCustomer });
  assert.equal(second.unchanged, 1);
  assert.equal(calls, 1, 'unveraenderter Lead darf nicht erneut geschrieben werden');

  phone = '+49 170 7654321';
  const third = await runCrmQonektoSync({ fetchLeads, upsertCustomer });
  assert.equal(third.createdOrUpdated, 1);
  assert.equal(calls, 2, 'geaenderte Stammdaten werden per Upsert aktualisiert');

  console.log('PASS CRM-Qonekto: Strategiegespraech, Mapping, Upsert und Dublettenschutz');
} finally {
  if (original.DATA_DIR === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = original.DATA_DIR;
  if (original.CRM_QONEKTO_SYNC_ENABLED === undefined) delete process.env.CRM_QONEKTO_SYNC_ENABLED; else process.env.CRM_QONEKTO_SYNC_ENABLED = original.CRM_QONEKTO_SYNC_ENABLED;
  if (original.CRM_QONEKTO_SYNC_STAGE === undefined) delete process.env.CRM_QONEKTO_SYNC_STAGE; else process.env.CRM_QONEKTO_SYNC_STAGE = original.CRM_QONEKTO_SYNC_STAGE;
  await fs.rm(directory, { recursive: true, force: true });
}
