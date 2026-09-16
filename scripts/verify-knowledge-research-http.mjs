import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-research-http-'));
process.env.DATA_DIR = temporary;
const { createKnowledgeResearchService } = await import('../knowledge/research-service.js');
const { registerKnowledgeResearchRoutes } = await import('../knowledge/research-routes.js');
const { getKnowledgeEntry, listKnowledgeEntries } = await import('../knowledge/store.js');
const text = 'Bei der Beratung werden zunächst Bedarf und Ziele geklärt. Ein strukturierter Vergleich unterstützt die nachvollziehbare Auswahl. Die vollständigen Bedingungen sind anhand der Originalunterlagen zu prüfen. Kosten, Laufzeiten, Leistungen und Grenzen sollen verständlich erklärt werden. Eine erneute Prüfung ist bei geänderten Bedürfnissen sinnvoll. Entscheidungen bleiben dokumentiert und prüfbar.';
let clock=Date.parse('2026-09-16T10:00:00.000Z'), searches=0;
const service=createKnowledgeResearchService({ now:()=>clock, search:async()=>{searches++;return [{url:'https://example.org/beratung'}];},read:async url=>({url,title:'Beratung',text}),synthesize:async()=>({title:'Bedarf in der Beratung',findings:[{text:'Zu Beginn einer Beratung sind Bedarf und Ziele zu klären.',sourceId:'S1',quote:'Bei der Beratung werden zunächst Bedarf und Ziele geklärt.'}],limitations:[]}) });
const app=express();app.use(express.json());app.use('/api',(req,res,next)=>req.headers.authorization==='Bearer fixture'?next():res.status(401).json({error:'Unauthorized'}));registerKnowledgeResearchRoutes(app,{service});
const server=await new Promise(resolve=>{const listening=app.listen(0,'127.0.0.1',()=>resolve(listening));});const base='http://127.0.0.1:'+server.address().port;
const request=async(url,method='GET',body)=>{const response=await fetch(base+'/api/knowledge/research'+url,{method,headers:{Authorization:'Bearer fixture','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
try{
 assert.equal((await fetch(base+'/api/knowledge/research')).status,401);
 assert.equal((await request('','POST',{topic:''})).status,400);
 const input={requestId:randomUUID(),topic:'Bedarf in der Beratung',category:'Sales',schedule:{frequency:'once'},maxSources:3};
 const created=await request('','POST',input);assert.equal(created.status,201);assert.equal(created.body.plan.latestRun.status,'queued');assert.equal(searches,0);
 const replay=await request('','POST',input);assert.equal(replay.body.plan.id,created.body.plan.id);
 assert.equal((await request('','POST',{...input,topic:'Anderes Thema'})).status,409);
 const id=created.body.plan.id;let plan;
 for(let attempt=0;attempt<60;attempt++){plan=(await request('')).body.plans.find(p=>p.id===id);if(plan.latestRun.status==='succeeded')break;await new Promise(resolve=>setTimeout(resolve,25));}
 assert.equal(plan.latestRun.status,'succeeded',plan.latestRun.error);assert.ok(plan.knowledgeEntryId);assert.equal((await getKnowledgeEntry(plan.knowledgeEntryId)).status,'ready');assert.equal((await listKnowledgeEntries()).length,1);
 assert.equal((await request('/'+id,'PATCH',{enabled:false})).body.plan.enabled,false);assert.equal((await request('/'+id+'/run','POST',{})).status,409);
 assert.equal((await request('/'+id,'PATCH',{enabled:true})).status,200);await request('/'+id+'/run','POST',{});
 for(let attempt=0;attempt<60;attempt++){plan=(await request('')).body.plans.find(p=>p.id===id);if(plan.latestRun.status==='unchanged')break;await new Promise(resolve=>setTimeout(resolve,25));}assert.equal(plan.latestRun.status,'unchanged');assert.equal((await listKnowledgeEntries()).length,1);
 const weekly=await request('','POST',{topic:'Beratung aktuell halten',schedule:{frequency:'weekly',weekday:7,time:'09:00'}});assert.equal(weekly.status,201);assert.equal(weekly.body.plan.nextRunAt,'2026-09-20T07:00:00.000Z');assert.equal(weekly.body.plan.latestRun,null);
 await request('/'+weekly.body.plan.id,'PATCH',{enabled:false});clock=Date.parse('2026-09-20T07:10:00Z');await service.tick();assert.equal((await service.list()).find(p=>p.id===weekly.body.plan.id).latestRun,null);
 assert.equal((await request('/missing','PATCH',{enabled:false})).status,404);
 console.log('PASS Knowledge research HTTP: auth, validation, durable async creation, request replay, real KB readback, pause, rerun, unchanged dedupe, Sunday schedule.');
}finally{await new Promise(resolve=>setTimeout(resolve,120));server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));await fs.rm(temporary,{recursive:true,force:true});}
