import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkflowOrchestrator, WORKFLOW_BUDGET_MS } from '../operations/workflow-orchestrator.js';
const directories = [];
const file = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iva-shards-')); directories.push(dir); return path.join(dir, 'state.json'); };
const step = (handler = 'read', scope) => ({ id: handler, handler, ...(scope ? {scope} : {}) });
const evidence = { verified: true, evidence: { readback: 'confirmed' } };
const shard = (id, steps = [step()], fingerprint) => ({ id, steps, fingerprint });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
test.after(() => directories.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

test('complete barrier, parallel representative scope and incremental verified index', async () => {
 let active = 0, peak = 0, calls = 0;
 const engine = createWorkflowOrchestrator({ file: file(), handlers: { read: async () => { peak = Math.max(peak, ++active); calls++; await sleep(2); active--; return evidence; } }, baseConcurrency: 4 });
 for (const kind of ['funding', 'mail', 'planbar', 'build']) engine.enqueue({id:kind,kind,shards:Array.from({length:12},(_,i)=>shard(String(i),[step()],`v1-${i}`))});
 let results = await engine.runUntilIdle();
 assert.equal(results.length,4); assert.ok(results.every(w=>w.status==='completed' && !w.slaViolated && w.finished===12)); assert.ok(peak>1); assert.equal(calls,48);
 engine.enqueue({id:'funding-delta',kind:'funding',shards:[shard('0',[step()],'v1-0'),shard('1',[step()],'v2-1')]});
 await engine.runUntilIdle(); assert.equal(calls,49);
});

test('urgent arrival can execute while long builds consume lower-priority slots', async () => {
 let release; const gate = new Promise(resolve=>{release=resolve;});
 const engine=createWorkflowOrchestrator({file:file(),maxConcurrency:3,baseConcurrency:3,handlers:{long:async()=>{await gate;return evidence;},read:async()=>evidence}});
 engine.enqueue({id:'build',kind:'build',shards:[shard('a',[step('long')]),shard('b',[step('long')]),shard('c',[step('long')])]});
 engine.pump(); await sleep(5);
 engine.enqueue({id:'urgent',kind:'scheduling',lane:'customer-scheduling',budgetMs:30000,shards:[shard('urgent')]});
 engine.pump(); await sleep(10);
 assert.equal(engine.snapshot().find(w=>w.id==='urgent').status,'completed');
 assert.equal(engine.snapshot().find(w=>w.id==='build').status,'running');
 release(); await engine.runUntilIdle();
});

test('same write scope is serial; independent resources execute concurrently',async()=>{
 const running=new Set(); let peak=0;
 const engine=createWorkflowOrchestrator({file:file(),baseConcurrency:5,resourceLocks:{withResource:async(scope,meta,fn)=>{assert.ok(!running.has(scope));assert.ok(meta.jobId);running.add(scope);peak=Math.max(peak,running.size);try{return await fn();}finally{running.delete(scope);}}},handlers:{write:async()=>{await sleep(5);return evidence;}}});
 engine.enqueue({kind:'write',shards:[shard('a',[step('write','pipedrive-write')]),shard('b',[step('write','pipedrive-write')]),shard('c',[step('write','outlook-write')])]});
 assert.ok((await engine.runUntilIdle()).every(w=>w.status==='completed'));assert.equal(peak,2);
});

test('recovery preserves initial deadline and reconciles ambiguous write before retry',async()=>{
 let now=1000, puts=0, reconciles=0;const stateFile=file();
 const handler={run:async()=>{puts++;throw new Error('crash after PUT');},reconcile:async()=>{reconciles++;return evidence;}};
 let engine=createWorkflowOrchestrator({file:stateFile,clock:()=>now,resourceLocks:{withResource:async(s,m,fn)=>fn()},handlers:{write:handler}});
 engine.enqueue({id:'recover',kind:'crm',shards:[shard('deal',[step('write','pipedrive-write')])]});await engine.runUntilIdle();
 assert.equal(engine.snapshot()[0].shards[0].status,'paused');now+=WORKFLOW_BUDGET_MS+1;
 engine=createWorkflowOrchestrator({file:stateFile,clock:()=>now,resourceLocks:{withResource:async(s,m,fn)=>fn()},handlers:{write:handler}});
 engine.resume('recover','deal');const [result]=await engine.runUntilIdle();
 assert.equal(result.deadlineAt,1000+WORKFLOW_BUDGET_MS);assert.equal(result.slaViolated,true);assert.equal(result.status,'completed');assert.equal(puts,1);assert.equal(reconciles,1);
});

test('readback failures do not cross completion barrier; external blockers isolate cases',async()=>{
 const engine=createWorkflowOrchestrator({file:file(),handlers:{read:async()=>evidence,bad:async()=>({verified:true}),blocked:async()=>{throw Object.assign(new Error('CAPTCHA'),{externalBlocker:true});}}});
 engine.enqueue({kind:'mail',shards:[shard('ok'),shard('bad',[step('bad')]),shard('external',[step('blocked')])]});
 const [result]=await engine.runUntilIdle();assert.equal(result.finished,1);assert.equal(result.status,'running');assert.equal(result.shards[1].status,'paused');assert.equal(result.shards[2].status,'blocked');
});

test('concurrent enqueue is idempotent and cancellation never kills active or ambiguous writes',async()=>{
 const engine=createWorkflowOrchestrator({file:file(),handlers:{read:async()=>evidence}});
 for(let i=0;i<20;i++)engine.enqueue({id:'same',kind:'mail',shards:[shard('one')]});assert.equal(engine.snapshot().length,1);
 const result=engine.cancel('same');assert.equal(result.status,'cancelled');assert.equal(result.shards[0].steps[0].status,'pending');
});

test('real funding preflight adapter uses bounded live snapshot reads and isolates bad identities',async()=>{
 const {runFundingPreflightBatch}=await import('../operations/workflow-batches.js');let active=0,peak=0;
 const result=await runFundingPreflightBatch({file:file(),dealIds:['1','2','2','3'],concurrency:2},{readSnapshot:async id=>{peak=Math.max(peak,++active);await sleep(5);active--;return {dealId:id==='3'?'wrong':id,fileRecords:[],secretMustNotPersist:'private'};},missingFields:()=>['document']});
 assert.equal(result.total,3);assert.equal(result.finished,2);assert.ok(peak<=2);assert.ok(peak>1);assert.ok(!JSON.stringify(result).includes('private'));assert.equal(result.shards.find(s=>s.id==='3').status,'paused');
});

test('actual Planbar validator audits complete explicit scope and reuses identical index deltas',async()=>{
 const {runPlanbarIndexAuditBatch}=await import('../operations/workflow-batches.js');const stateFile=file();
 const index={appointments:[{id:'a',customerName:'Test',description:'7 kW Panasonic',team:'Team',startDate:'2026-09-21',endDateExclusive:'2026-09-22'}]};
 const first=await runPlanbarIndexAuditBatch({id:'one',file:stateFile,index});assert.equal(first.status,'completed');assert.equal(first.shards[0].evidence['description-format'].descriptionAudit.completeByFormat,true);
 const second=await runPlanbarIndexAuditBatch({id:'two',file:stateFile,index});assert.equal(second.shards[0].reused,true);
});
