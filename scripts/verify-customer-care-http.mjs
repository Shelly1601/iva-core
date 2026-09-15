import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {createCustomerCareService} from '../customer-care/service.js';
import {createCustomerCareCustomers,workspaceProjectIds,createCustomerCareDelivery} from '../customer-care/adapters.js';
import {registerCustomerCareRoutes,registerCustomerCarePublicRoutes,createCustomerCareScheduler} from '../customer-care/routes.js';
import {createCustomerCareLanding,customerCheckupLandingFiles} from '../customer-care/landing.js';
import {createWebsiteService} from '../websites/service.js';
import {adviceCalculatorReadiness} from '../advice/calculator-audit.js';
const projects=[{id:'p1',name:'Goals & Concepts'},{id:'p2',name:'Heat Hero'}];
const data=[{id:'c1',mode:'kunde',customer:{name:'Testperson Eins',email:'one@example.test'},data:{project:'Goals & Concepts'}},{id:'c2',mode:'kunde',customer:{name:'Testperson Zwei',email:'two@example.test'},data:{projectId:'p2'}},{id:'c3',mode:'kunde',customer:{name:'Testperson Drei',email:'three@example.test'},data:{projectIds:['p1','p2']}}];
const customers=createCustomerCareCustomers({listWorkspaces:async()=>data,listProjects:async()=>projects});
await test('Projektzuordnung ist eindeutig, explizite IDs übersteuern alten Namen',async()=>{
  assert.deepEqual(workspaceProjectIds(data[0],projects),['p1']);
  assert.deepEqual(workspaceProjectIds({...data[0],data:{projectId:'p2',project:'Goals & Concepts'}},projects),['p2']);
  assert.equal((await customers({projectId:'p1'})).length,2);assert.equal((await customers({projectId:'p1',customerId:'c2'})).length,0);
});
await test('HTTP: Regeln, private Projektgrenzen, öffentliche Antwort, Abmeldung und dedupte Mehrprojektkampagne',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'iva-care-http-'));let now=Date.parse('2026-09-15T10:00:00Z');const queued=[];
  const service=createCustomerCareService({dataDir:dir,getCustomers:customers,getProject:async id=>projects.find(p=>p.id===id),now:()=>now,publicOrigin:'https://iva.example.test',deliver:async e=>{queued.push(e);return {status:'queued',queueId:'queue-'+e.id};}});
  const app=express();registerCustomerCarePublicRoutes(app,{service});app.use(express.json());
  app.use('/api',(q,r,next)=>q.headers.authorization==='Bearer fixture'?next():r.sendStatus(401));
  registerCustomerCareRoutes(app,{service,listProjects:async()=>projects,access:{getProjectAccess:async id=>{if(!projects.some(p=>p.id===id))throw Object.assign(new Error('Missing'),{status:404});return {modules:['crm','marketing']};}},customers,readiness:async()=>[],calculatorReadiness:adviceCalculatorReadiness,landing:async()=>({status:'draft'})});
  const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});const origin='http://127.0.0.1:'+server.address().port;
  async function req(url,body,method=body?'POST':'GET',auth=true){const r=await fetch(origin+url,{method,headers:{...(auth?{Authorization:'Bearer fixture'}:{}),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const text=await r.text();let value;try{value=JSON.parse(text);}catch{value=text;}return {status:r.status,value};}
  try{
    assert.equal((await req('/api/customer-care?projectId=p1',null,'GET',false)).status,401);
    assert.equal((await req('/api/customer-care?projectId=p1&customerId=c2')).status,404);
    assert.equal((await req('/api/customer-care',{projectId:'p1',settings:{enabled:true,senderEmail:'sender@example.test',advisorEmail:'advisor@example.test',annualCheckup:{enabled:false},monthlySummary:{enabled:false}}},'PATCH')).status,200);
    await req('/api/customer-care',{projectId:'p1',customerId:'c1',customerCare:{emailAuthorized:true,topics:['pv']}},'PATCH');
    const batch={projectIds:['p1','p2'],idempotencyKey:'fixture-campaign-0001',campaign:{name:'PV September',subject:'Ein persönliches Update',body:'Guten Tag, wir bieten Ihnen einen Beratungstermin an.',topics:['pv'],enabled:true,schedule:{type:'once',at:new Date(now-60000).toISOString(),to:'2026-09-30'}}};
    const first=await req('/api/customer-care/batch-campaigns',batch);assert.equal(first.status,201,JSON.stringify(first.value));
    const again=await req('/api/customer-care/batch-campaigns',batch);assert.deepEqual(first.value.campaigns.map(x=>x.campaign.id),again.value.campaigns.map(x=>x.campaign.id));
    const run=await req('/api/customer-care/run?projectId=p1',{});assert.equal(run.status,200);assert.equal(queued.length,1);
    await req('/api/customer-care/run?projectId=p1',{});assert.equal(queued.length,1);
    const outbox=queued[0];const token=outbox.body.match(/\/checkup\/([A-Za-z0-9_-]{43})/)[1];
    const pub=await req('/public/customer-care/'+token,null,'GET',false);assert.equal(pub.status,200);assert.equal(pub.value.project.name,'Goals & Concepts');assert.equal(JSON.stringify(pub.value).includes('one@example.test'),false);
    const input={answers:{changes:'yes',interest:'yes',topics:['pv']},interest:true,bookingRequested:true,idempotencyKey:'fixture-answer-0001'};
    assert.equal((await req('/public/customer-care/'+token,input,'POST',false)).status,200);
    assert.equal((await req('/public/customer-care/'+token,input,'POST',false)).status,200);
    const dashboard=(await req('/api/customer-care?projectId=p1')).value;assert.equal(dashboard.notifications.filter(x=>x.priority==='high').length,1);
    assert.equal((await req('/public/customer-care/'+token,{unsubscribe:true,idempotencyKey:'fixture-unsubscribe-1'},'POST',false)).value.status,'unsubscribed');
    assert.equal((await req('/api/customer-care?projectId=p1&customerId=c1')).value.customer.care.emailAuthorized,false);
    assert.equal((await req('/api/customer-care/overview')).value.projects.length,2);
    assert.equal((await req('/public/customer-care/not-a-token',null,'GET',false)).status,404);
  }finally{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});}
});
await test('Website Studio erstellt eine echte gebaute Revision und verwendet sie wieder',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'iva-care-website-'));try{const getProject=async id=>projects.find(p=>p.id===id);const website=createWebsiteService({dataDir:dir,getProject,listProjects:async()=>projects,env:{}});const landing=createCustomerCareLanding({coreOrigin:'https://iva.example.test',getProject});const result=await landing({projectId:'p1'},website);assert.equal(result.status,'draft');const preview=await website.preview('p1',result.site.id);assert.equal(preview.status,'ready');assert.match(preview.html,/checkup/);assert.equal((await landing({projectId:'p1'},website)).site.id,result.site.id);assert.equal((await website.list('p1')).length,1);const files=customerCheckupLandingFiles({coreOrigin:'https://iva.example.test',projectName:'<img src=x>'});assert.doesNotMatch(files[0].content,/<img src=x>/);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
await test('Originalangebot bleibt an PDF, Kundenakte, Vertrag und Ablauf gebunden',async()=>{
 const {createCustomerCareQuotes}=await import('../customer-care/quotes.js');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'iva-care-quotes-'));try{const now=Date.parse('2026-09-15T12:00:00Z');const service=createCustomerCareService({dataDir:dir,getCustomers:customers,getProject:async id=>projects.find(p=>p.id===id),now:()=>now});const scope={projectId:'p1',workspaceId:'c1',customerId:'c1'};const contract=await service.addContract(scope,{product:'Strom',provider:'Altanbieter',renewalDate:'2027-01-01',noticeDays:30});let bytes=Buffer.from('%PDF-fixture original verified');const adapter=createCustomerCareQuotes({dataDir:dir,customers,getWorkspace:async()=>({files:[{id:'pdf-1',name:'Angebot.pdf',mime:'application/pdf'}]}),readWorkspaceFile:async(w,id)=>w==='c1'&&id==='pdf-1'?{buffer:bytes}:null,now:()=>now});const input={contractId:contract.id,sourceDocumentId:'pdf-1',provider:'Anbieter',monthlyCost:69,expiresAt:'2026-10-01T12:00:00Z',summary:'Originalangebot geprüft',conditions:'Gesamtpreis inklusive Grundpreis; 12 Monate Laufzeit.',reviewConfirmed:true};const quote=await adapter.save(scope,input);assert.equal(quote.providerVerified,false);assert.equal(quote.sourceType,'verified-document');assert.equal((await adapter.get({projectId:'p1',customer:{id:'c1',workspaceId:'c1'},contract})).id,quote.id);await assert.rejects(()=>adapter.save({...scope,projectId:'p2'},input));await assert.rejects(()=>adapter.save(scope,{...input,reviewConfirmed:false}));bytes=Buffer.from('%PDF-fixture changed');assert.equal(await adapter.get({projectId:'p1',customer:{id:'c1',workspaceId:'c1'},contract}),null);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
await test('Versandabgleich adressiert ältere Vorgänge direkt statt nur neueste 50 Befehle',async()=>{
 const pending=Array.from({length:85},(_,i)=>({id:'out-'+i,queueId:'queue-'+i}));const completed=[],acknowledged=[];let requested;
 const adapter=createCustomerCareDelivery({findCustomerCareDeviceCommands:async ids=>{requested=ids;return ids.map(id=>({id:'queue-'+id.slice(4),payload:{outboxId:id},status:'completed',result:{receipt:{status:'sent'}}}));},acknowledgeCustomerCareCommand:async id=>acknowledged.push(id)});
 await adapter.reconcile({listPendingDeliveries:async()=>pending,completeDelivery:async id=>completed.push(id)});assert.equal(requested.length,85);assert.equal(completed.length,85);assert.equal(acknowledged.length,85);
});
