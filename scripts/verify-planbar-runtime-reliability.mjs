import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// All persistence lives in a disposable directory. No real worker is spawned,
// no network API is called, and every Finder invocation is injected.
const temp = await mkdtemp(path.join(os.tmpdir(),'iva-runtime-reliability-'));
after(() => rm(temp,{recursive:true,force:true}));
process.env.DATA_DIR=path.join(temp,'server');
process.env.IVA_DEVICE_WORKSPACE=path.join(temp,'workspace');
process.env.IVA_CODEX_TASK_ROOT=path.join(temp,'tasks');
process.env.IVA_PLANBAR_OUTPUT_ROOT=path.join(temp,'forecast');
process.env.IVA_MAC_HELPER_DATA_DIR=path.join(temp,'helper');
const tasks=await import('../local-mac-helper/codex-tasks.mjs');
const {hasCompletionEvidence}=await import('../local-mac-helper/workflow-recovery.mjs');
const automationStore=await import('../automations/store.js');
const {createAutomationOrchestrator,isDue,automationSlotKey}=await import('../automations/orchestrator.js');
const {createProjectWorkflowAutomationHandler,createPlanbarForecastAutomationHandler}=await import('../automations/imac-workflow.js');
const {emptyDailyTrash,buildDailyTrashLaunchAgent}=await import('../local-mac-helper/funding-trash.mjs');
const device=await import('../device-control/store.js');
const {reconcileFundingImacRuntime,FUNDING_RUNTIME_MARKER,FUNDING_RUNTIME_REQUIRED_ACTION,fundingRuntimeUpdatePrompt}=await import('../device-control/funding-runtime-reconciler.js');
const report=async()=>true;
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const put=async(file,value)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value));};
async function fixture(name,{request={},state={}}={}) {
  const requestId='fixture-'+name, jobId=tasks.codexJobIdForRequest(requestId), directory=path.join(process.env.IVA_CODEX_TASK_ROOT,jobId);
  const createdAt=new Date(Date.now()-60_000).toISOString();
  const req={jobId,requestId,createdAt,mode:'project-workflow',workflowId:'planbar-completion-morning',resultProtocol:2,launchProtocol:2,prompt:'Nur isolierte Testdaten prüfen.',...request};
  await put(path.join(directory,'request.json'),req);
  await put(path.join(directory,'state.json'),{jobId,createdAt,updatedAt:createdAt,status:'blocked',progress:35,...state});
  return {jobId,directory,request:req,stateFile:path.join(directory,'state.json'),requestFile:path.join(directory,'request.json')};
}
function fakeSpawn(counter) { return ()=>{counter.count++;const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;}; }

// Start guards read this Mac's hardware identity; process spawning is mocked.
test('old blocked HH workflow migrates under same job ID and preserves existing artifacts', async()=>{
  const f=await fixture('migration',{request:{workflowRevision:'legacy'},state:{status:'blocked'}});
  await writeFile(path.join(f.directory,'result.txt'),'Alter belegter Teilstand');
  const count={count:0};
  const result=await tasks.startCodexTask({...f.request,workflowRevision:'heat-hero-completion-v2'},{report,spawnProcess:fakeSpawn(count)});
  assert.equal(result.jobId,f.jobId);assert.equal(count.count,1);assert.equal((await json(f.requestFile)).workflowRevision,'heat-hero-completion-v2');
  assert.equal((await json(f.stateFile)).status,'queued');assert.equal(await readFile(path.join(f.directory,'result.txt'),'utf8'),'Alter belegter Teilstand');
  assert.equal((await json(path.join(f.directory,'pre-heat-hero-v2.json'))).state.status,'blocked');
});
test('migration never resets an active child or claimant even if outer status says blocked',async()=>{
  for (const mode of ['child','claim']) {
    const f=await fixture('active-'+mode,{request:{workflowRevision:'legacy'},state:mode==='child'?{childPid:process.pid}:{}});
    if(mode==='claim')await put(path.join(f.directory,'execution-claim.json'),{pid:process.pid});
    const count={count:0};const result=await tasks.startCodexTask({...f.request,workflowRevision:'heat-hero-completion-v2'},{report,spawnProcess:fakeSpawn(count)});
    assert.equal(result.activeProcessPreserved,true);assert.equal(count.count,0);assert.equal((await json(f.requestFile)).workflowRevision,'legacy');
  }
});
test('completed tasks are not migrated or launched twice',async()=>{
  const f=await fixture('already-complete',{request:{workflowRevision:'legacy'},state:{status:'completed'}}),count={count:0};
  const result=await tasks.startCodexTask({...f.request,workflowRevision:'heat-hero-completion-v2'},{report,spawnProcess:fakeSpawn(count)});
  assert.equal(result.duplicate,true);assert.equal(result.status,'completed');assert.equal(count.count,0);
});
test('text success and a different job scope cannot replace the durable HH proof',()=>{
  const request={workflowId:'planbar-completion-morning',jobId:'abc',resultProtocol:2};
  assert.equal(hasCompletionEvidence({request,resultText:'Status: erfolgreich'}),false);
  const proof={protocol:2,jobId:'abc',scope:'heat-hero-private',inventoryComplete:true,status:'completed'};
  for(const patch of [{jobId:'other'},{scope:'all-projects'},{inventoryComplete:false},{status:'partial'},{protocol:1}])assert.equal(hasCompletionEvidence({request,state:{planbarCompletionProof:{...proof,...patch}}}),false);
  assert.equal(hasCompletionEvidence({request,state:{planbarCompletionProof:proof}}),true);
  assert.equal(tasks.shouldResumeCodexTaskAfterTermination({request,resultText:'WhatsApp Login fehlt, Status: blockiert'}),true);
  assert.equal(tasks.shouldResumeCodexTaskAfterTermination({request,state:{planbarCompletionProof:{...proof,status:'partial',retryRequired:false}}}),false);
});
test('status reads durable completion proof and zero cases still need real inventory',async()=>{
  const f=await fixture('proof'), at=new Date().toISOString();
  assert.equal((await tasks.getCodexTaskStatus(f.jobId)).planbarCompletionProof,null);
  await tasks.recordPlanbarCompletion(f.jobId,'begin',{scope:'heat-hero-private',refreshedAt:at,sourceChecks:[{source:'planbar',status:'read',observedCount:0,checkedAt:at,evidence:'Fixture: vollständige leere HH-Inventur'}]},{report});
  const finished=await tasks.recordPlanbarCompletion(f.jobId,'finish',{checkedCaseIds:[],inventoryComplete:true,finalReadbackStartedAt:at,finalReadbackAt:at},{report});
  assert.equal(finished.status,'completed');assert.equal((await tasks.getCodexTaskStatus(f.jobId)).planbarCompletionProof.jobId,f.jobId);
});
test('forecast completion is tied to exact automatic slot or exact manual delivery key',()=>{
  const request={workflowId:'planbar-weekly-export',forecastDelivery:{runMode:'automatic',automationSlotKey:'current-slot'}};
  for(const proof of [null,{sentFolderVerified:true,runMode:'automatic',automationSlotKey:'old-slot'},{sentFolderVerified:true,runMode:'manual',automationSlotKey:'current-slot'}])assert.equal(hasCompletionEvidence({request,state:{workflowProof:proof},resultText:'Status: erfolgreich'}),false);
  assert.equal(hasCompletionEvidence({request,state:{workflowProof:{sentFolderVerified:true,...request.forecastDelivery}}}),true);
  const manual={...request,forecastDelivery:{runMode:'manual',deliveryRunKey:'manual-one'}};
  assert.equal(hasCompletionEvidence({request:manual,state:{workflowProof:{sentFolderVerified:true,runMode:'manual',deliveryRunKey:'manual-two'}}}),false);
});
test('forecast status lookup cannot borrow a newer receipt from another slot',async()=>{
  const f=await fixture('forecast-status',{request:{workflowId:'planbar-weekly-export',resultProtocol:0,forecastDelivery:{runMode:'automatic',automationSlotKey:'wanted'}}});
  await put(path.join(process.env.IVA_PLANBAR_OUTPUT_ROOT,'send-log.json'),{entries:[{status:'sent_verified',sentFolderVerified:true,runMode:'automatic',automationSlotKey:'other',sentAt:new Date().toISOString()}]});
  assert.equal((await tasks.getCodexTaskStatus(f.jobId)).workflowProof,null);
});
function handlerFixture(kind,overrides={}) {
  const calls=[];const dependencies={workflowId:'planbar-completion-morning',displayName:'Fixture HH',getProject:async()=>({automations:[{id:'planbar-completion-morning',enabled:true},{id:'planbar-weekly-export',enabled:true}]}),deviceAgentStatus:async()=>({online:true,dispatchReady:true}),enqueueDeviceCommand:async input=>{calls.push(input);return{id:'new-status-command'}},deviceCommandStatus:async()=>null,...overrides};
  return {calls,handler:(kind==='forecast'?createPlanbarForecastAutomationHandler:createProjectWorkflowAutomationHandler)(dependencies)};
}
test('missing original command preserves known job and polls without redispatching workflow',async()=>{
  for(const kind of ['project','forecast'])for(const commandId of ['expired-command','']) {
    const {handler,calls}=handlerFixture(kind);const result=await handler({slotKey:'fixture-slot',previousResult:{commandId,jobId:'known-job'}});
    assert.equal(result.status,'waiting');assert.equal(calls.length,1);assert.equal(calls[0].action,'codex.task.status');assert.equal(calls[0].payload.jobId,'known-job');
  }
});
test('server rejects local success without matching current HH proof',async()=>{
  const {handler}=handlerFixture('project',{deviceCommandStatus:async id=>id==='initial'?{status:'completed',result:{jobId:'job'}}:{status:'completed',result:{status:'completed',resultPreview:'Alles fertig'}}});
  await assert.rejects(handler({slotKey:'slot',previousResult:{commandId:'initial',jobId:'job',statusCommandId:'status'}}),/keinen vollständigen/);
});
test('one-time funding is due once at September 16 01:00 Berlin and remains deduplicated past run retention',async()=>{
  const def=automationStore.automationDefinition('funding-initial-backfill');
  assert.equal(isDue(def,new Date('2026-09-15T22:59:59Z')),false);assert.equal(isDue(def,new Date('2026-09-15T23:00:00Z')),true);
  assert.equal(automationSlotKey(def,new Date('2028-01-01')),automationSlotKey(def,new Date('2026-09-16')));
  let calls=0;const runner=createAutomationOrchestrator({[def.id]:async()=>{calls++;return{status:'completed',summary:'Fixture verified'};}});
  assert.equal((await runner.runAutomation(def.id,{now:new Date('2026-09-15T22:59:59Z')})).reason,'not-due');assert.equal(calls,0);
  assert.equal((await runner.runAutomation(def.id,{now:new Date('2026-09-15T23:00:00Z')})).run.status,'completed');
  const file=path.join(process.env.DATA_DIR,'automation-control.json');const persisted=await json(file);persisted.runs=[];await put(file,persisted);
  assert.equal((await runner.runAutomation(def.id,{now:new Date('2028-01-01')})).reason,'duplicate');assert.equal(calls,1);assert.ok((await json(file)).completedOnce[def.id]);
});
test('partial and failed handler results can never create a one-time completion tombstone',async()=>{
  const id='funding-initial-backfill',file=path.join(process.env.DATA_DIR,'automation-control.json');
  for(const [status,retryRequired,expected] of [['partial',true,'waiting'],['partial',false,'blocked'],['failed',false,'failed']]) {
    await put(file,{version:1,runs:[],completedOnce:{}});
    const runner=createAutomationOrchestrator({[id]:async()=>({status,retryRequired,summary:'Fixture incomplete'})});
    const result=await runner.runAutomation(id,{now:new Date('2026-09-16T00:00:00Z')});
    assert.equal(result.run.status,expected);assert.equal((await json(file)).completedOnce[id],undefined);
  }
});
test('funding task constructors separate approved initial scan from daily incremental work',async()=>{
  const startTask=async value=>value;
  const initial=await tasks.startProjectWorkflowTask({workflowId:'funding-initial-backfill',requestId:'initial-fixture',workflowInput:{fundingRun:{mode:'initial-backfill',since:'2026-08-01'}},startTask});
  assert.deepEqual(initial.fundingRun,{mode:'initial-backfill',since:'2026-08-01'});
  const daily=await tasks.startProjectWorkflowTask({workflowId:'funding-daily-sequence',requestId:'daily-fixture',startTask});assert.deepEqual(daily.fundingRun,{mode:'incremental'});
  await assert.rejects(tasks.startProjectWorkflowTask({workflowId:'funding-initial-backfill',startTask}),/zeitraum/i);
  await assert.rejects(tasks.startProjectWorkflowTask({workflowId:'funding-daily-sequence',workflowInput:{fundingRun:{mode:'initial-backfill',since:'2026-08-01'}},startTask}),/Vollscan/);
});
test('device payload keeps initial funding configuration through its persisted queue',async()=>{
  const input={projectId:'heat-hero',workflowId:'funding-initial-backfill',requestId:'device-fixture-initial',fundingRun:{mode:'initial-backfill',since:'2026-08-01'}};
  const command=await device.enqueueDeviceCommand({action:'project.workflow.run',payload:input});
  assert.deepEqual((await device.deviceCommandStatus(command.id)).payload.fundingRun,input.fundingRun);
  await assert.rejects(device.enqueueDeviceCommand({action:'project.workflow.run',payload:{...input,requestId:'bad',fundingRun:{mode:'initial-backfill',since:'2025-01-01'}}}),/zeitraum/i);
  await assert.rejects(device.enqueueDeviceCommand({action:'project.workflow.run',payload:{...input,workflowId:'funding-daily-sequence'}}),/Vollscan|Rücklauf/);
});
test('runtime maintenance suspends legacy monitor but never starts a parallel daily funding scan',async()=>{
  const enqueued=[];const result=await reconcileFundingImacRuntime({getStatus:async()=>({attested:true,online:true,allowedActions:[FUNDING_RUNTIME_REQUIRED_ACTION]}),listCommands:async()=>[{id:'done',action:FUNDING_RUNTIME_REQUIRED_ACTION,status:'completed',requestText:FUNDING_RUNTIME_MARKER,result:{suspended:true,loaded:false,plistRetained:true}}],enqueue:async command=>{enqueued.push(command);return{id:'unexpected'}}});
  assert.equal(result.status,'ready');assert.equal(enqueued.length,0);
  assert.match(fundingRuntimeUpdatePrompt(),/install-central-runtime\.mjs/);assert.doesNotMatch(fundingRuntimeUpdatePrompt(),/brctl|Mobile Documents|CloudDocs/);
});
test('trash cleanup requires verified empty readback, records receipt and runs once per Berlin day',async()=>{
  const file=path.join(temp,'trash','verified.json');let calls=0,hostChecks=0;
  const opts={file,now:new Date('2026-09-15T23:30:00Z'),assertHost:()=>{hostChecks++},execute:async(command,args)=>{calls++;assert.equal(command,'/usr/bin/osascript');assert.match(args[1],/count items of trash/);return{stdout:'3:0\n'}}};
  const result=await emptyDailyTrash(opts);assert.equal(result.day,'2026-09-16');assert.equal(result.verified,true);assert.equal(result.removedItems,3);
  assert.equal((await emptyDailyTrash(opts)).duplicate,true);assert.equal(calls,1);assert.equal(hostChecks,2);
});
test('trash remaining items never receive a verified receipt',async()=>{
  const file=path.join(temp,'trash','not-empty.json');
  await assert.rejects(emptyDailyTrash({file,now:new Date(),assertHost:()=>{},execute:async()=>({stdout:'3:1'})}),/keinen bestätigten/);
  await assert.rejects(access(file),{code:'ENOENT'});
});
test('trash LaunchAgent schedules 00:30 and never runs immediately on load',()=>{
  const plist=buildDailyTrashLaunchAgent({nodePath:'/fixture/node',helperPath:'/fixture/helper.mjs'});
  assert.match(plist,/<key>Hour<\/key><integer>0<\/integer>/);assert.match(plist,/<key>Minute<\/key><integer>30<\/integer>/);assert.doesNotMatch(plist,/RunAtLoad|StartInterval/);
});


test('task synchronizer preserves live child and retries dead worker under same ID without invented success',async()=>{
  await rm(process.env.IVA_CODEX_TASK_ROOT,{recursive:true,force:true});
  const f=await fixture('sync-live-child',{state:{status:'running',workerPid:991991,childPid:process.pid}});
  await writeFile(path.join(f.directory,'result.txt'),'Status: erfolgreich');
  const launches=[];
  await tasks.syncCodexTaskStates({force:true,report,launch:async request=>launches.push(request.jobId),processAlive:pid=>pid===process.pid});
  assert.equal(launches.length,0);assert.equal((await json(f.stateFile)).phase,'orphan_child_running');
  await put(f.stateFile,{...(await json(f.stateFile)),childPid:null});
  await tasks.syncCodexTaskStates({force:true,report,launch:async request=>launches.push(request.jobId),processAlive:()=>false});
  const state=await json(f.stateFile);assert.equal(state.status,'queued');assert.equal(state.phase,'recovering');assert.deepEqual(launches,[f.jobId]);assert.ok(state.nextAttemptAt);
});
test('durable reservation progress automatically creates one followup and stays open for missing fields',async()=>{
  const {isoWeekRange}=await import('../operations/customer-scheduling.js');
  const f=await fixture('reservation-capture',{request:{workflowId:'',resultProtocol:0,planbar:{partnerId:'heat-hero',partnerPrefix:'HH',customerName:'Fixture',isoYear:2026,week:39}}});
  const at=new Date().toISOString();
  const progress=await tasks.recordPlanbarTaskProgress(f.jobId,{status:'reserved',reservation:{customerId:'fixture-customer',appointmentId:'fixture-appointment',resourceId:'fixture-team',resourceName:'Montage 1',isoYear:2026,week:39,...isoWeekRange(2026,39),verified:true,identityVerified:true,verifiedAt:at},missingDetails:['Auftragsnummer','Leistungsbeschreibung'],remainingActions:['WhatsApp-Bestätigung']},{report});
  assert.equal(progress.status,'reserved');assert.equal((await tasks.getCodexTaskStatus(f.jobId)).planbarProgress.reservation.appointmentId,'fixture-appointment');
  const queue=await json(path.join(process.env.IVA_DEVICE_WORKSPACE,'data','planbar-completion.json'));
  const rows=queue.cases.filter(row=>row.appointmentId==='fixture-appointment');assert.equal(rows.length,1);assert.notEqual(rows[0].status,'completed');assert.ok(rows[0].remainingActions.includes('WhatsApp-Bestätigung'));
});

const fundingLedgerFile=path.join(process.env.IVA_MAC_HELPER_DATA_DIR,'funding-intake.json');
function fundingLedger(overrides={}) {
  const fresh=new Date().toISOString(),old=new Date(Date.now()-3600_000).toISOString();
  return {version:1,messages:[],backfill:{since:'2026-08-01',status:'completed',scannedAt:old,checkpoint:'backfill-checkpoint'},
    incremental:{cursor:null,checkpoint:'delta-checkpoint',complete:true,scannedAt:fresh,runId:'fixture-delta-run',startedAt:fresh},...overrides};
}
test('funding status requires a complete current snapshot and zero pending IDs',async()=>{
  const f=await fixture('funding-status-proof',{request:{workflowId:'funding-daily-sequence',resultProtocol:1,fundingRun:{mode:'incremental'}}});
  const ledger=fundingLedger();
  await put(fundingLedgerFile,ledger);
  const valid=(await tasks.getCodexTaskStatus(f.jobId)).fundingIntakeProof;
  assert.equal(valid.completed,true);assert.equal(valid.pending,0);assert.equal(valid.jobId,f.jobId);
  for (const patch of [
    {incremental:{...ledger.incremental,scannedAt:new Date(Date.now()-3600_000).toISOString()}},
    {backfill:{...ledger.backfill,scannedAt:new Date(Date.now()-30_000).toISOString()},incremental:{...ledger.incremental,startedAt:new Date(Date.now()-15_000).toISOString(),complete:false,cursor:'unfinished-page',scannedAt:null}},
    {incremental:{...ledger.incremental,complete:true,cursor:'unfinished-page'}},
    {messages:[{messageId:'fixture-unresolved',fingerprint:'a'.repeat(64),status:'pending'}]},
  ]) {
    await put(fundingLedgerFile,{...ledger,...patch});
    const proof=(await tasks.getCodexTaskStatus(f.jobId)).fundingIntakeProof;
    assert.equal(proof.completed,false,'partial/stale snapshots or open IDs must not be current completed proof');
  }
});
test('an initial completion label without snapshot timestamp/checkpoint proves no mailbox coverage',async()=>{
  const f=await fixture('funding-initial-proof',{request:{workflowId:'funding-initial-backfill',resultProtocol:1,fundingRun:{mode:'initial-backfill',since:'2026-08-01'}}});
  await put(fundingLedgerFile,fundingLedger({backfill:{since:'2026-08-01',status:'completed',cursor:null,checkpoint:null}}));
  assert.equal((await tasks.getCodexTaskStatus(f.jobId)).fundingIntakeProof.completed,false);
});
test('funding recovery accepts only matching current proof with all required flags',()=>{
  const createdAt=new Date(Date.now()-60_000).toISOString();
  const request={jobId:'funding-proof-job',workflowId:'funding-daily-sequence',resultProtocol:1,createdAt,fundingRun:{mode:'incremental'}};
  const proof={protocol:2,jobId:request.jobId,mode:'incremental',coverageComplete:true,checkpointRecorded:true,completed:true,pending:0,scannedAt:new Date().toISOString()};
  const structuredResult={outcome:'completed'};
  assert.equal(hasCompletionEvidence({request,state:{fundingIntakeProof:proof},structuredResult}),true);
  for (const patch of [{jobId:'other-job'},{mode:'initial-backfill'},{coverageComplete:false},{checkpointRecorded:false},{completed:false},{pending:1},{scannedAt:null},{scannedAt:new Date(Date.now()-3600_000).toISOString()}]) {
    assert.equal(hasCompletionEvidence({request,state:{fundingIntakeProof:{...proof,...patch}},structuredResult}),false);
  }
  assert.equal(hasCompletionEvidence({request,state:{fundingIntakeProof:proof},structuredResult:{outcome:'partial'}}),false);
});
test('the final worker status cannot report funding completed when recovery is suppressed but intake proof is missing',()=>{
  const request={jobId:'funding-final',mode:'project-workflow',workflowId:'funding-daily-sequence',resultProtocol:1,createdAt:new Date(Date.now()-60_000).toISOString(),fundingRun:{mode:'incremental'}};
  const structuredResult={outcome:'completed',summary:'Alle Teilschritte gemeldet.'};
  for (const current of [{phase:'user_deferred'},{detail:'CAPTCHA erfordert externe Bestätigung.'}]) {
    assert.equal(tasks.shouldResumeCodexTaskAfterTermination({request,state:current,structuredResult,resultText:'',exitCode:0}),false);
    const status=tasks.resolveFundingTaskFinalStatus({request,exitCode:0,structuredStatus:'completed',structuredResult,fundingIntakeProof:null});
    assert.notEqual(status,'completed','structured success alone cannot bypass the actual mailbox proof');
  }
  const fundingIntakeProof={protocol:2,jobId:request.jobId,mode:'incremental',coverageComplete:true,checkpointRecorded:true,completed:true,pending:0,scannedAt:new Date().toISOString()};
  assert.equal(tasks.resolveFundingTaskFinalStatus({request,exitCode:0,structuredStatus:'completed',structuredResult,fundingIntakeProof}),'completed');
  assert.notEqual(tasks.resolveFundingTaskFinalStatus({request,exitCode:1,structuredStatus:'completed',structuredResult,fundingIntakeProof}),'completed');
});
test('server cannot mark daily funding complete with the wrong scan mode or stale scan time',async()=>{
  const createdAt=new Date(Date.now()-60_000).toISOString();
  const valid={protocol:2,jobId:'funding-job',mode:'incremental',coverageComplete:true,checkpointRecorded:true,completed:true,pending:0,scannedAt:new Date().toISOString()};
  for (const patch of [{mode:'initial-backfill'},{scannedAt:null},{scannedAt:new Date(Date.now()-3600_000).toISOString()}]) {
    const {handler}=handlerFixture('project',{workflowId:'funding-daily-sequence',getProject:async()=>({automations:[{id:'funding-daily-sequence',enabled:true}]}),
      deviceCommandStatus:async id=>id==='initial'?{status:'completed',result:{jobId:'funding-job'}}:{status:'completed',result:{status:'completed',workflowOutcome:'completed',createdAt,fundingIntakeProof:{...valid,...patch}}}});
    await assert.rejects(handler({slotKey:'funding-slot',previousResult:{commandId:'initial',jobId:'funding-job',statusCommandId:'status'}}),/nachweis/i);
  }
});

test('the pure funding proof rejects running backfill even when a newer timestamp exists elsewhere',()=>{
  const request={jobId:'running-backfill',workflowId:'funding-daily-sequence',fundingRun:{mode:'incremental'},createdAt:new Date(Date.now()-60_000).toISOString()};
  const state=fundingLedger();state.backfill.status='running';state.backfill.cursor='remaining-backfill-page';state.pending=[];
  assert.equal(tasks.buildFundingIntakeProof(request,state).coverageComplete,false);
});

test('a valid daily proof passes server gate and a partial outcome cannot reuse it',async()=>{
  const createdAt=new Date(Date.now()-60_000).toISOString();
  const proof={protocol:2,jobId:'funding-job',mode:'incremental',coverageComplete:true,checkpointRecorded:true,completed:true,pending:0,scannedAt:new Date().toISOString()};
  for (const workflowOutcome of ['completed','partial']) {
    const {handler}=handlerFixture('project',{workflowId:'funding-daily-sequence',getProject:async()=>({automations:[{id:'funding-daily-sequence',enabled:true}]}),
      deviceCommandStatus:async id=>id==='initial'?{status:'completed',result:{jobId:'funding-job'}}:{status:'completed',result:{status:'completed',workflowOutcome,createdAt,fundingIntakeProof:proof}}});
    const invocation=handler({slotKey:'funding-slot',previousResult:{commandId:'initial',jobId:'funding-job',statusCommandId:'status'}});
    if (workflowOutcome==='partial') await assert.rejects(invocation,/nachweis/i); else assert.equal((await invocation).jobId,'funding-job');
  }
});
test('legacy funding requests missing a mode never bypass the current proof gate',()=>{
  const request={jobId:'legacy-funding',workflowId:'funding-daily-sequence',resultProtocol:1};
  assert.equal(hasCompletionEvidence({request,structuredResult:{outcome:'completed'}}),false);
});

test('the deployed runtime contains the exact original MIME parser', async () => {
  const { buildCentralRuntimeBundle, validateCentralRuntimeBundle } = await import('../local-mac-helper/central-runtime.mjs');
  const bundle = validateCentralRuntimeBundle(await buildCentralRuntimeBundle(new URL('..', import.meta.url).pathname));
  const entry = bundle.files.find(item => item.path === 'local-mac-helper/outlook-mime-parser.py');
  assert.ok(entry, 'original-source parser must ship with the native reader');
  assert.deepEqual(Buffer.from(entry.content, 'base64'), await readFile(new URL('../local-mac-helper/outlook-mime-parser.py', import.meta.url)));
});
