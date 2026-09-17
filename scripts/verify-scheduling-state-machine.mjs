import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSchedulingFastLane, MANUALLY_BOOKED_REQUEST } from '../local-mac-helper/scheduling-fast-lane.mjs';

async function fixture(t, options = {}) {
 const root = await mkdtemp(path.join(os.tmpdir(), 'iva-scheduling-machine-')); t.after(() => rm(root,{recursive:true,force:true}));
 const request = { customerName:'Test Customer', partnerId:'heat-hero', isoYear:2026,week:41,createdAt:new Date().toISOString(), orderNumber:'O-1', orderNumberSource:{kind:'signed-offer',documentId:'offer-1',verified:true} };
 const counts={slot:0,week:0,stage:0,wa:0}; let slot=options.existing ? {id:'a'} : null, week='',stage='1',message=null;
 const at=()=>new Date().toISOString();
 const adapters={
 planbar:{findExisting:async()=>({appointment:slot,absenceVerified:true,identityVerified:true,capacityVerified:true}),create:async()=>{counts.slot++;return slot={id:'a'};},read:async()=>({appointmentId:'a',customerId:'c',resourceId:'r',resourceName:'Montage 1',isoYear:2026,week:41,startDate:'2026-10-05',endDateExclusive:'2026-10-10',verified:true,identityVerified:true,verifiedAt:at()})},
 pipedrive:{read:async()=>({dealId:'42',identityVerified:true,week:options.badWeek?'':week,stageId:stage,visibleStageOrder:['1','2','3'],verified:true,verifiedAt:at()}),writeWeek:async(id,value)=>{counts.week++;week=value;},writeStage:async(id,from,to)=>{counts.stage++;assert.equal(stage,from);stage=to;if(options.crashStage){options.crashStage=false;throw Error('crash after PUT');}}},
 whatsapp:{find:async()=>message||{absenceVerified:true,communityVerified:true},send:async input=>{counts.wa++;message={...input,messageId:'m',verified:true,verifiedAt:at()};if(options.crashWhatsApp){options.crashWhatsApp=false;throw Error('crash after send');}return message;},read:async()=>message}
 };
 const deps={root,adapters,withResource:async(scope,action)=>action()};
 return {root,request,deps,counts,state:async()=>JSON.parse(await readFile(path.join(root,(await readdir(root)).find(x=>!x.startsWith('.')),'state.json'),'utf8'))};
}
test('20 concurrent duplicate requests yield exactly one slot, phase and WhatsApp',async t=>{const f=await fixture(t);const results=await Promise.all(Array.from({length:20},()=>runSchedulingFastLane(f.request,f.deps)));assert.equal(results.filter(x=>!x.duplicate).length,1);assert.deepEqual(f.counts,{slot:1,week:1,stage:1,wa:1});assert.equal((await f.state()).status,'fast_lane_verified');});
test('KW readback failure performs no phase write and no message',async t=>{const f=await fixture(t,{badWeek:true});await assert.rejects(runSchedulingFastLane(f.request,f.deps),/KW readback/);assert.equal(f.counts.stage,0);assert.equal(f.counts.wa,0);});
test('crash after phase PUT adopts target and never advances a second time; original SLA persists',async t=>{const f=await fixture(t,{crashStage:true});await assert.rejects(runSchedulingFastLane(f.request,f.deps),/crash/);const before=await f.state();await runSchedulingFastLane({...f.request,createdAt:new Date(Date.now()+5000).toISOString()},f.deps);const after=await f.state();assert.equal(f.counts.stage,1);assert.equal(f.counts.wa,1);assert.equal(after.deadlineAt,before.deadlineAt);assert.equal(after.receivedAt,before.receivedAt);assert.equal(after.milestones.pipedriveStage.toStageId,'2');});
test('uncertain WhatsApp send is reconciled once by visible message',async t=>{const f=await fixture(t,{crashWhatsApp:true});await assert.rejects(runSchedulingFastLane(f.request,f.deps),/crash/);await runSchedulingFastLane(f.request,f.deps);assert.equal(f.counts.wa,1);});
test('manual appointment is adopted, never rebooked',async t=>{const f=await fixture(t,{existing:true});await runSchedulingFastLane({...f.request,id:MANUALLY_BOOKED_REQUEST},f.deps);assert.equal(f.counts.slot,0);});
test('missing manual appointment proof forbids replacement',async t=>{const f=await fixture(t);await assert.rejects(runSchedulingFastLane({...f.request,id:MANUALLY_BOOKED_REQUEST},f.deps),/replacement/);assert.equal(f.counts.slot,0);});
test('missing order only defers WhatsApp and details after minimal completion',async t=>{const f=await fixture(t);const state=await runSchedulingFastLane({...f.request,orderNumber:null},f.deps);assert.equal(state.status,'minimal_verified_whatsapp_pending');assert.deepEqual(f.counts,{slot:1,week:1,stage:1,wa:0});});
test('persisted slot intent after an uncertain save prevents duplicate creation',async t=>{const f=await fixture(t);f.deps.adapters.planbar.create=async()=>{f.counts.slot++;throw Error('connection lost');};await assert.rejects(runSchedulingFastLane(f.request,f.deps),/connection lost/);await assert.rejects(runSchedulingFastLane(f.request,f.deps),/replacement/);assert.equal(f.counts.slot,1);});
test('resolved canonical claim adopts legacy receipts without repeating completed writes',async t=>{
 const f=await fixture(t);const first=await runSchedulingFastLane(f.request,f.deps);
 const adopted=await runSchedulingFastLane({...f.request,dealId:'42',source:'public-heat-hero'},f.deps);
 assert.equal(adopted.deadlineAt,first.deadlineAt);assert.equal(adopted.migratedFrom,first.schedulingKey);
 assert.deepEqual(f.counts,{slot:1,week:1,stage:1,wa:1});
});
