import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildControlActivityFeed } from '../operations/activity-feed.js';
import { workflowSla } from '../local-mac-helper/workflow-sla.mjs';
const context = {};context.globalThis=context;
vm.runInNewContext(await readFile(new URL('../public/workflow-dashboard.js',import.meta.url),'utf8'),context);
const {buildWorkflowDashboard}=context.IVAWorkflowDashboard;
// Exact timestamps from the read-only live agent.status device probe on 17 September.
const probe={id:'completed-device-probe',action:'agent.status',status:'completed',createdAt:'2026-09-17T16:01:22.491Z',startedAt:'2026-09-17T16:01:22.817Z',completedAt:'2026-09-17T16:01:23.137Z',queueDelayMs:326};
const now=Date.parse('2026-09-17T16:12:06Z');
const activity=buildControlActivityFeed({deviceCommands:[probe]});
assert.equal(activity[0].createdAt,probe.createdAt);assert.equal(activity[0].completedAt,probe.completedAt);
for(const later of [now,now+3600000]){
 const item=buildWorkflowDashboard({activity},{now:later}).done[0];
 assert.equal(item.sla.totalDurationMs,646);assert.equal(item.sla.queueDelayMs,326);assert.equal(item.sla.violated,false);
 assert.equal(workflowSla(probe,later).totalDurationMs,646);
}
const sources=buildControlActivityFeed({
 agentRuns:[{...probe,id:'agent',jobId:'job',taskTitle:'Completed build'}],
 automationRuns:[{...probe,id:'automation',automationName:'Completed automation'}],
 projects:[{id:'project'}],protocolRuns:[{...probe,runId:'protocol',projectId:'project',workflowName:'Completed protocol'}],
});
const merged=buildWorkflowDashboard({activity:sources,buildProgress:{recent:[{id:'build',jobId:'job',status:'completed',title:'Completed build',createdAt:probe.createdAt,updatedAt:probe.completedAt,progress:100}]}},{now});
assert.equal(merged.done.length,3);
for(const item of merged.done){assert.equal(item.completedAt,probe.completedAt);assert.equal(item.sla.totalDurationMs,646);}
const start={...probe,id:'start',action:'codex.task.start',result:{jobId:'running-child'},payload:{}};
const status={...probe,id:'status',action:'codex.task.status',payload:{jobId:'running-child'},result:{status:'running',createdAt:probe.createdAt,updatedAt:new Date(now).toISOString()}};
const running=buildControlActivityFeed({deviceCommands:[start,status]})[0];assert.equal(running.completedAt,'','launch/poll completion must not become workflow completion');
const doneStatus={...status,result:{status:'completed',createdAt:probe.createdAt,completedAt:probe.completedAt}};
assert.equal(buildControlActivityFeed({deviceCommands:[start,doneStatus]})[0].completedAt,probe.completedAt);
const missingEnd=buildWorkflowDashboard({activity:[{id:'unknown-end',status:'completed',createdAt:probe.createdAt,updatedAt:probe.completedAt}]},{now}).done[0];
assert.equal(missingEnd.completedAt,'');assert.equal(missingEnd.sla.totalDurationMs,null,'missing completion evidence does not invent a running clock or end timestamp');
assert.equal(workflowSla({status:'completed',createdAt:probe.createdAt},now).totalDurationMs,null);
console.log('PASS completed SLA: actual device probe frozen at646ms including326ms queue; all source mappings and merged builds preserve end; launcher/poll timestamps cannot fabricate workflow completion.');
