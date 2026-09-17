import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-planbar-shard-ingestion-'));
process.env.DATA_DIR = root;
const { replacePlanbarSearchIndex, getPlanbarSearchIndex, auditPlanbarDescription } = await import('../operations/planbar-search.js');
try {
  const appointments = Array.from({length:3000},(_,i)=>({id:`fixture-${i}`,customerName:`Fixture ${i}`,description:i%2?'7 kW Panasonic':'Bosch',team:'Fixture Team',resourceId:`resource-${i}`,startDate:'2026-09-21',endDateExclusive:'2026-09-26'}));
  const started = Date.now();
  const initial = await replacePlanbarSearchIndex({appointments,updatedAt:'2026-09-17T00:00:00Z'});
  assert.equal(initial.appointmentCount,3000);assert.equal(initial.auditWorkflow.status,'completed');assert.equal(initial.auditWorkflow.totalShards,32);assert.equal(initial.auditWorkflow.reusedShards,0);
  assert.ok(Date.now()-started<30000,'full supported index must publish within 30 seconds in fixture');
  for(const appointment of initial.appointments) assert.deepEqual(appointment.descriptionAudit,auditPlanbarDescription(appointment.description));
  const repeats = await Promise.all(Array.from({length:20},()=>replacePlanbarSearchIndex({appointments,updatedAt:'2026-09-17T00:01:00Z'})));
  assert.equal(new Set(repeats.map(result=>result.auditWorkflow.id)).size,1,'concurrent identical ingestion coalesces');
  const repeated = repeats[0];
  assert.equal(repeated.auditWorkflow.reusedShards,32);
  appointments[0].description='12 kW Panasonic';
  const delta = await replacePlanbarSearchIndex({appointments,updatedAt:'2026-09-17T00:02:00Z'});
  assert.equal(delta.auditWorkflow.reusedShards,31);
  assert.equal((await getPlanbarSearchIndex()).appointments.find(a=>a.id==='fixture-0').descriptionAudit.completeByFormat,true);
  await assert.rejects(replacePlanbarSearchIndex({appointments:[]}));
  assert.equal((await getPlanbarSearchIndex()).appointmentCount,3000,'rejected input keeps published index intact');
  console.log(`PASS production Planbar ingestion: 3000 records, 32 persistent read shards, unchanged validator results, all/one-bucket delta reuse, prior index preserved; ${Date.now()-started} ms.`);
} finally { await fs.rm(root,{recursive:true,force:true}); }
