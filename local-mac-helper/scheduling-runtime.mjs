import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { runSchedulingFastLane, canonicalSchedulingExecutionKey } from './scheduling-fast-lane.mjs';
import { createSchedulingPlanbarAdapter } from './scheduling-planbar-adapter.mjs';
import { createSchedulingPipedriveAdapter } from './scheduling-pipedrive-adapter.mjs';
import { createSchedulingWhatsAppAdapter } from './scheduling-whatsapp-adapter.mjs';
import { acquirePriorityLease } from './execution-priority.mjs';
import { mergePlanbarSchedulingProgress } from '../operations/customer-scheduling.js';
import { resourceExecutionRoot } from './ui-execution-lock.mjs';
import { collectPlanbarSearchIndex } from './planbar.mjs';
import { readPipedriveFundingDeal } from './background-integrations.mjs';

const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('de').replace(/\s+/g, ' ').trim();
const base = process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(),'Library','Application Support','IVA Mac Helper');
const defaultRoot = path.join(base,'scheduling-fast-lane');
const load = file => readFile(file,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return {entries:[]};throw error;});

// Only compact proven mappings are cached. Offer/CRM order-number fields are
// never promoted into signed-offer evidence. Scope changes invalidate mappings.
export async function refreshSchedulingPreindex(requests, { root = defaultRoot, readPlanbar = collectPlanbarSearchIndex,
  readDeal = readPipedriveFundingDeal, concurrency = 4 } = {}) {
  const previous = await load(path.join(root,'preindex.json'));
  const planbar = await readPlanbar();
  const unique = [...new Map(requests.map(request=>[normalize(`${request.partnerId}|${request.customerName}|${request.objectLocation||''}`),request])).values()];
  const results = []; let next=0;
  await Promise.all(Array.from({length:Math.min(Math.max(1,concurrency),unique.length)},async()=>{
    for(;;){const index=next++;if(index>=unique.length)return;const request=unique[index];
      try {
        const known=previous.entries.filter(row=>row.verified===true&&row.partnerId===request.partnerId
          &&normalize(row.customerName)===normalize(request.customerName)&&normalize(row.objectLocation)===normalize(request.objectLocation));
        const candidates=[];
        for(const prior of known){
          const deal=await readDeal({dealId:String(prior.dealId)});
          if(normalize(deal.customerName)!==normalize(request.customerName))continue;
          if(String(deal.dealId)!==String(prior.dealId))continue;
          candidates.push({...prior,customerName:deal.customerName,dealId:String(deal.dealId),verifiedAt:new Date().toISOString()});
        }
        if(candidates.length!==1){results.push({customerName:request.customerName,qualified:false,reason:'crm_identity_partner_or_object_not_unique'});continue;}
        const mapped=candidates[0];
        const appointments=(planbar.appointments||[]).filter(row=>normalize(row.customerName)===normalize(request.customerName)||normalize(row.customerName)===normalize(`${request.partnerPrefix||'HH'} ${request.customerName}`));
        results.push({...mapped,qualified:true,appointmentIds:appointments.map(row=>row.id)});
      }catch(error){results.push({customerName:request.customerName,qualified:false,reason:'read_source_unavailable',error:String(error.message).slice(0,300)});}
    }
  }));
  const updated={version:1,updatedAt:new Date().toISOString(),entries:[...previous.entries.filter(old=>!results.some(row=>row.qualified&&row.dealId===old.dealId)),...results.filter(row=>row.qualified)]};
  await mkdir(root,{recursive:true});const temporary=path.join(root,`preindex-${randomUUID()}.tmp`);
  await writeFile(temporary,JSON.stringify(updated),{mode:0o600});await rename(temporary,path.join(root,'preindex.json'));
  return {results,updatedAt:updated.updatedAt};
}

export async function resolveSchedulingRequest(request,{root=defaultRoot,index,maxAgeMs=24*60*60_000}={}) {
  if(request.source==='public-heat-hero')return {qualified:false,reason:'public_source_check_and_confirmation_mail_require_existing_workflow'};
  const source=index||await load(path.join(root,'preindex.json'));
  const candidates=source.entries.filter(row=>row.verified===true&&normalize(row.customerName)===normalize(request.customerName)
    &&row.partnerId===request.partnerId&&normalize(row.objectLocation)===normalize(request.objectLocation)
    &&(!request.dealId||String(row.dealId)===String(request.dealId))&&Date.now()-Date.parse(row.verifiedAt)<=maxAgeMs);
  if(candidates.length!==1)return {qualified:false,reason:'verified_preindex_mapping_missing_or_ambiguous'};
  const row=candidates[0];
  if(row.schedulingMode==='enter-block-first')return {qualified:false,reason:'enter_replacement_contract_unqualified'};
  if(!row.planbarCustomerId||!row.planbarTaskId||row.planbarIdentityProof?.verified!==true)return {qualified:false,reason:'existing_planbar_customer_task_mapping_missing'};
  return {qualified:true,request:{...request,dealId:String(row.dealId),planbarCustomerId:row.planbarCustomerId,planbarTaskId:row.planbarTaskId,planbarIdentityProof:row.planbarIdentityProof}};
}

export function createSchedulingRuntime({root=defaultRoot,lockRoot=resourceExecutionRoot,adapters={planbar:createSchedulingPlanbarAdapter(),pipedrive:createSchedulingPipedriveAdapter(),whatsapp:createSchedulingWhatsAppAdapter()},resolve=resolveSchedulingRequest,onProgress=async()=>{}}={}) {
  // Retained live leases are reused only by the same job on reconciliation.
  const retained = new Map();
  return {root,get pendingReconciliationCount(){return retained.size;},async start(request){
    const resolved=await resolve(request,{root});
    if(!resolved.qualified)return {started:false,qualified:false,reason:resolved.reason,requiresExistingWorkflow:true};
    let activeLease=null;
    return runSchedulingFastLane(resolved.request,{root:path.join(root,'executions'),adapters,
      onIntent:async(name,state)=>activeLease.beginCriticalSection({criticalSection:name,caseCheckpoint:{jobId:state.jobId,schedulingKey:state.schedulingKey,step:name}}),
      onProgress,
      withResource:async(scope,action,metadata)=>{
        const key=`${metadata.jobId}:${scope}`;
        const lease=retained.get(key)||await acquirePriorityLease({root:lockRoot,scope,...metadata,title:'Kunde terminieren',timeoutMs:30000,pollMs:100});
        activeLease=lease;
        try {
          const result=await action();
          await lease.checkpoint({writeOutcomeVerified:true,safeToYield:true,caseCheckpoint:{jobId:metadata.jobId,step:metadata.criticalSection,verified:true}});
          await lease.release();retained.delete(key);return result;
        }catch(error){
          if(lease.owner.safeToYield===false)retained.set(key,lease);
          else await lease.release();
          throw error;
        }finally{activeLease=null;}
      },
    });
  }};
}


const active = new Map();
export const schedulingFastLaneActiveCount = () => active.size + [...runtimes.values()].reduce((sum,runtime)=>sum+(runtime.pendingReconciliationCount||0),0);
const runtimes = new Map();
const queueFile = (root,key) => path.join(root,'queue',`${key}.json`);
async function atomicQueueWrite(file,value) {
  const temporary=`${file}.${randomUUID()}.tmp`;
  await writeFile(temporary,JSON.stringify(value),{mode:0o600});await rename(temporary,file);
}
export function schedulingOperationalRun(state) {
  const verified=state.reservation?.verified===true;
  const remainingActions=[!state.milestones?.pipedriveWeek&&'Pipedrive KW',!state.milestones?.pipedriveStage&&'Pipedrive Phase',!state.milestones?.whatsapp&&'WhatsApp'].filter(Boolean);
  const reserved=verified?mergePlanbarSchedulingProgress(null,{status:'reserved',reservation:state.reservation,milestones:state.milestones,missingDetails:['Vervollständigung'],remainingActions}):null;
  const planbarProgress=reserved?mergePlanbarSchedulingProgress(reserved,{...reserved,status:'details_pending'}):null;
  return {externalKey:`scheduling-fast-lane:${state.jobId}`,jobId:state.jobId,agentId:'iva-operations',agentName:'Kunde terminieren',taskTitle:'Kunde terminieren',workflowId:'customer-scheduling',projectId:'heat-hero',
    channel:'deterministic-scheduling',source:'Mac Mini · IVA',schedulingKey:state.legacySchedulingKey||state.schedulingKey,canonicalSchedulingKey:state.schedulingKey,planbarProgress,
    startedAt:new Date(state.receivedAt).toISOString(),createdAt:new Date(state.receivedAt).toISOString(),
    status:state.status==='reconciliation_required'?'incomplete':'running',phase:state.status,
    detail:state.status==='fast_lane_verified'?'Terminierungs-Schnellspur rückgelesen; Vervollständigung noch offen':state.status,
    sla:{originAt:new Date(state.receivedAt).toISOString(),deadlineAt:new Date(state.deadlineAt).toISOString(),totalDurationMs:state.totalDurationMs,queueDelayMs:state.queueDelayMs,violated:state.slaViolated||state.minimalSlaViolated,activeShards:1,completedShards:state.minimalVerifiedAt?1:0,totalShards:1},
    metrics:{queueDelayMs:state.queueDelayMs,totalDurationMs:state.totalDurationMs,stepDurationMs:state.stepDurationMs,minimalDurationMs:state.minimalDurationMs}};
}
const reporting = new Map();
function reportPending(root,report) {
  if(reporting.has(root))return reporting.get(root);
  const pending=deliverPending(root,report).finally(()=>reporting.delete(root));reporting.set(root,pending);return pending;
}
async function deliverPending(root,report) {
  const directory=path.join(root,'reports');
  for(const name of (await readdir(directory).catch(()=>[])).sort()) {
    if(!name.endsWith('.json'))continue;
    const file=path.join(directory,name),pending=await load(file);
    if(pending.delivered)continue;
    try { await report(pending.payload);await atomicQueueWrite(file,{...pending,delivered:true}); } catch { break; /* preserve transition order on delivery retry */ }
  }
}
const reportDefault = async input => (await import('./device-agent.mjs')).reportOperationalRun(input);
function runQueued(record,{root,report=reportDefault,runtimeFactory=createSchedulingRuntime}={}) {
  const key=record.key,activeKey=`${root}:${key}`;
  if(active.has(activeKey))return;
  const operation=(async()=>{
    record.status='running';record.attempts=(record.attempts||0)+1;
    await atomicQueueWrite(queueFile(root,key),record);
    let runtime=runtimes.get(root);
    if(!runtime){
      runtime=runtimeFactory({root,resolve:async request=>({qualified:true,request}),onProgress:async state=>{
        await mkdir(path.join(root,'reports'),{recursive:true});
        const name=`${state.schedulingKey}-${String(state.sequence).padStart(12,'0')}.json`;
        await atomicQueueWrite(path.join(root,'reports',name),{delivered:false,payload:schedulingOperationalRun(state)});
      }});
      runtimes.set(root,runtime);
    }
    try {
      const result=await runtime.start(record.request);
      record.status=result.duplicate?'claimed_elsewhere':'awaiting_details';
      record.minimalVerifiedAt=result.minimalVerifiedAt||null;
      record.resultStatus=result.status||null;
    }catch(error){record.status=record.attempts>=3?'reconciliation_required':'recovery_pending';record.error=String(error.message).slice(0,500);record.nextAttemptAt=Date.now()+1000;}
    await atomicQueueWrite(queueFile(root,key),record);
  })();
  active.set(activeKey,operation);
  operation.catch(()=>{}).finally(()=>{active.delete(activeKey);void reportPending(root,report).catch(()=>{});});
}
export async function enqueueSchedulingFastLane(request,{root=defaultRoot,resolve=resolveSchedulingRequest,report=reportDefault,runtimeFactory=createSchedulingRuntime}={}) {
  const resolution=await resolve(request,{root});
  if(!resolution.qualified)return {started:false,qualified:false,requiresExistingWorkflow:true,reason:resolution.reason};
  const key=canonicalSchedulingExecutionKey(resolution.request);
  const hex=key.slice(0,32),jobId=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  const directory=path.join(root,'queue');await mkdir(directory,{recursive:true});
  const record={version:1,key,jobId,status:'queued',attempts:0,createdAt:request.createdAt||new Date().toISOString(),request:{...resolution.request,jobId,createdAt:request.createdAt||new Date().toISOString()}};
  try {await writeFile(queueFile(root,key),JSON.stringify(record),{mode:0o600,flag:'wx'});}
  catch(error){if(error.code!=='EEXIST')throw error;const existing=await load(queueFile(root,key));return {startedLocally:true,duplicate:true,jobId:existing.jobId,schedulingKey:key,status:existing.status};}
  runQueued(record,{root,report,runtimeFactory});
  return {startedLocally:true,queued:true,jobId,schedulingKey:key,status:'queued'};
}
export async function resumePendingSchedulingFastLanes({root=defaultRoot,report=reportDefault,runtimeFactory=createSchedulingRuntime}={}) {
  let resumed=0;
  for(const name of await readdir(path.join(root,'queue')).catch(()=>[])){
    if(!name.endsWith('.json'))continue;
    const record=await load(path.join(root,'queue',name));
    if(!['queued','running','recovery_pending'].includes(record.status)||record.attempts>=3||record.nextAttemptAt>Date.now())continue;
    runQueued(record,{root,report,runtimeFactory});resumed++;
  }
  void reportPending(root,report).catch(()=>{});
  return {resumed,active:active.size};
}
let directRuntime;
export const startSchedulingFastLane = request => (directRuntime ||= createSchedulingRuntime()).start(request);
