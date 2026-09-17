import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveSchedulingRequest,refreshSchedulingPreindex,createSchedulingRuntime } from '../local-mac-helper/scheduling-runtime.mjs';
import { canonicalSchedulingExecutionKey } from '../local-mac-helper/scheduling-fast-lane.mjs';
const request={customerName:'Test Customer',partnerId:'heat-hero',isoYear:2026,week:41};
const mapping={...request,dealId:'42',verified:true,verifiedAt:new Date().toISOString(),planbarCustomerId:'c',planbarTaskId:'t',planbarIdentityProof:{verified:true,customerId:'c',taskId:'t'}};
test('unqualified requests preserve established execution route',async()=>{
 assert.equal((await resolveSchedulingRequest(request,{index:{entries:[]}})).qualified,false);
 const runtime=createSchedulingRuntime({resolve:async()=>({qualified:false,reason:'missing mapping'})});
 assert.deepEqual(await runtime.start(request),{started:false,qualified:false,reason:'missing mapping',requiresExistingWorkflow:true});
});
test('resolver requires exact partner/object, fresh unique proof and preserves material answers',async()=>{
 const input={...request,materialDeliverySpace:'not-asked'};
 assert.equal((await resolveSchedulingRequest(input,{index:{entries:[mapping]}})).request.materialDeliverySpace,'not-asked');
 assert.equal((await resolveSchedulingRequest({...input,objectLocation:'other'},{index:{entries:[mapping]}})).qualified,false);
 assert.equal((await resolveSchedulingRequest(input,{index:{entries:[mapping,mapping]}})).qualified,false);
});
test('preindex refresh reuses verified compact mapping and omits fetched private data',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'iva-preindex-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'preindex.json'),JSON.stringify({entries:[mapping]}));
 const result=await refreshSchedulingPreindex([request,request],{root,readPlanbar:async()=>({appointments:[]}),readDeal:async()=>({dealId:'42',customerName:request.customerName,customerEmail:'private@example.test',orderNumber:'not-offer-proof'})});
 assert.equal(result.results.length,1);assert.equal(result.results[0].qualified,true);assert.equal(result.results[0].orderNumber,undefined);assert.equal(result.results[0].customerEmail,undefined);
});
test('resolved canonical scheduling key dedupes public and internal entry channels',()=>{
 const internal={...request,dealId:'42'},publicRequest={...internal,source:'public-heat-hero',objectLocation:'Example'};
 assert.equal(canonicalSchedulingExecutionKey(internal),canonicalSchedulingExecutionKey(publicRequest));
 assert.notEqual(canonicalSchedulingExecutionKey(internal),canonicalSchedulingExecutionKey({...internal,dealId:'43'}));
});
test('runtime retains uncertain writer and reuses its live lease for readback recovery',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'iva-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let slot=false,week='',stage='1',crash=true;
 const at=()=>new Date().toISOString();
 const adapters={planbar:{findExisting:async()=>({appointment:slot?{id:'a'}:null,absenceVerified:true,identityVerified:true,capacityVerified:true}),create:async()=>{slot=true;return {id:'a'};},read:async()=>({appointmentId:'a',customerId:'c',resourceId:'r',resourceName:'Montage 1',isoYear:2026,week:41,startDate:'2026-10-05',endDateExclusive:'2026-10-10',verified:true,identityVerified:true,verifiedAt:at()})},pipedrive:{read:async()=>({dealId:'42',identityVerified:true,week,stageId:stage,visibleStageOrder:['1','2'],verified:true,verifiedAt:at()}),writeWeek:async(id,value)=>{week=value;},writeStage:async()=>{stage='2';if(crash){crash=false;throw Error('uncertain PUT');}}},whatsapp:{}};
 const runtime=createSchedulingRuntime({root,lockRoot:path.join(root,'locks'),adapters,resolve:async input=>({qualified:true,request:{...input,dealId:'42'}})});
 await assert.rejects(runtime.start(request),/uncertain PUT/);
 const {readFile}=await import('node:fs/promises');
 const owner=JSON.parse(await readFile(path.join(root,'locks.resources','pipedrive-write','owner.json'),'utf8'));assert.equal(owner.safeToYield,false);
 const result=await runtime.start(request);assert.equal(result.status,'minimal_verified_whatsapp_pending');
 await assert.rejects(readFile(path.join(root,'locks.resources','pipedrive-write','owner.json')),{code:'ENOENT'});
});
test('persistent queue admits 20 concurrent requests once without waiting for execution',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'iva-admission-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const {enqueueSchedulingFastLane,resumePendingSchedulingFastLanes}=await import('../local-mac-helper/scheduling-runtime.mjs');
 let release,started=0;const gate=new Promise(resolve=>{release=resolve;});
 const options={root,resolve:async input=>({qualified:true,request:{...input,dealId:'42'}}),report:async()=>{},runtimeFactory:()=>({start:async()=>{started++;await gate;return {status:'minimal_verified_whatsapp_pending',minimalVerifiedAt:Date.now()};}})};
 const began=Date.now();const results=await Promise.all(Array.from({length:20},()=>enqueueSchedulingFastLane(request,options)));
 assert.equal(results.filter(result=>!result.duplicate).length,1);assert.ok(Date.now()-began<2000);
 await resumePendingSchedulingFastLanes(options);assert.equal(started,1);release();
 const {readFile}=await import('node:fs/promises');const file=path.join(root,'queue',`${results[0].schedulingKey}.json`);
 for(let i=0;i<100;i++){if(JSON.parse(await readFile(file,'utf8')).status==='awaiting_details')break;await new Promise(resolve=>setTimeout(resolve,5));}
 assert.equal(JSON.parse(await readFile(file,'utf8')).status,'awaiting_details');
});
test('public requests stay on source-check and confirmation-mail workflow',async()=>{
 assert.equal((await resolveSchedulingRequest({...request,source:'public-heat-hero'},{index:{entries:[mapping]}})).reason,'public_source_check_and_confirmation_mail_require_existing_workflow');
});
