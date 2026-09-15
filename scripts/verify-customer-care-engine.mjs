import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createCustomerCareService } from '../customer-care/service.js';
import { createCustomerCareStore } from '../customer-care/store.js';
import { normalizeSettings, normalizeCustomerCare, dueAnnual, usableQuote, contractCareDates } from '../customer-care/rules.js';
const temporary = await mkdtemp(path.join(os.tmpdir(), 'iva-customer-care-engine-'));
after(() => rm(temporary, { recursive: true, force: true }));
let index=0;
function fixture(options={}) {
  const dataDir=path.join(temporary,String(++index)); let time=Date.parse('2026-09-15T10:00:00Z');
  const customers=[{id:'customer-a',workspaceId:'workspace-a',projectId:'project-a',name:'Anna Fixture',email:'anna@example.test',emailAuthorized:true,topics:['pv','energy']},{id:'customer-b',workspaceId:'workspace-b',projectId:'project-a',name:'Bert Fixture',email:'bert@example.test',emailAuthorized:false,topics:['insurance']}];
  const deliveries=[]; const getCustomers=async ({projectId})=>projectId==='project-a'?structuredClone(customers):[{id:'customer-a',workspaceId:'workspace-a',projectId,name:'Other Project',email:'other@example.test',emailAuthorized:true,topics:['energy']}];
  const dependencies={dataDir,now:()=>time,getCustomers,getProject:async id=>({id,name:`Project ${id}`,accentColor:'#123456'}),publicOrigin:'https://iva.example.test',deliver:async envelope=>{deliveries.push(envelope);return {status:'queued',queueId:`queue-${envelope.id}`};},...options};
  const api=createCustomerCareService(dependencies),scope={projectId:'project-a',customerId:'customer-a',workspaceId:'workspace-a'};
  const enable=async extra=>api.updateSettings({projectId:'project-a'},{enabled:true,senderEmail:'team@example.test',advisorEmail:'advisor@example.test',annualCheckup:{enabled:true,month:9,day:15},optimization:{enabled:false,leadDays:30},monthlySummary:{enabled:false,day:1},...extra});
  return {api,dataDir,customers,deliveries,scope,enable,dependencies,setTime:value=>{time=Date.parse(value);},now:()=>time};
}
const tokenFrom=envelope=>envelope.body.match(/https:\/\/iva\.example\.test\/checkup\/([A-Za-z0-9_-]{43})/)?.[1];
const receipt=(row,overrides={})=>({status:'sent',verified:true,messageId:`message-${row.id}`,recipient:row.to[0],from:row.from,sentAt:'2026-09-15T10:00:00Z',...overrides});

test('settings and customer overrides preserve inherit and reject invalid address/date scopes',()=>{
  assert.equal(normalizeCustomerCare({annualCheckupEnabled:null}).annualCheckupEnabled,null);
  assert.throws(()=>normalizeCustomerCare({emailAuthorized:'yes'}));
  assert.throws(()=>normalizeSettings({bookingUrl:'javascript:alert(1)'}));
  assert.throws(()=>normalizeSettings({senderEmail:'a@example.test,b@example.test'}));
  assert.equal(normalizeSettings({landingUrl:'https://website.example.test/checkup',signature:'Team'}).landingUrl,'https://website.example.test/checkup');
  assert.equal(dueAnnual(Date.parse('2028-02-29T12:00:00Z'),2,29,'2027-01-01').due,'2028-02-29');
});
test('project and customer filters isolate settings, contracts and overrides',async()=>{
  const f=fixture();await f.enable();await f.api.updateCustomerCare(f.scope,{topics:['pv'],emailAuthorized:false});
  const own=await f.api.getDashboard(f.scope),other=await f.api.getDashboard({projectId:'project-b',customerId:'customer-a',workspaceId:'workspace-a'});
  assert.deepEqual(own.customer.care.topics,['pv']);assert.equal(own.customer.care.emailAuthorized,false);assert.equal(other.customer.care.emailAuthorized,true);assert.equal(other.settings.enabled,false);
  await f.api.addContract(f.scope,{id:'contract-a',product:'Strom',provider:'Provider',topic:'energy',renewalDate:'2026-11-01',noticeDays:30,monthlyCost:70});
  assert.equal((await f.api.getDashboard({projectId:'project-b'})).contracts.length,0);
  await assert.rejects(f.api.getDashboard({...f.scope,customerId:'customer-b'}),/genau einen/);
  await assert.rejects(f.api.getDashboard({projectId:'../escape'}));
  const mode=(await stat(path.join(f.dataDir,'customer-care/state.json'))).mode & 0o777;assert.equal(mode,0o600);
});
test('annual invitation sends only authorized customers, queues once and persists across restarts',async()=>{
  const f=fixture();await f.enable();await Promise.all([f.api.runDue({projectId:'project-a'}),f.api.runDue({projectId:'project-a'})]);
  assert.equal(f.deliveries.length,1);assert.deepEqual(f.deliveries[0].to,['anna@example.test']);assert.ok(tokenFrom(f.deliveries[0]));
  const restarted=createCustomerCareService(f.dependencies);await restarted.runDue({projectId:'project-a'});assert.equal(f.deliveries.length,1);
  const row=(await restarted.listPendingDeliveries())[0];assert.equal(row.status,'queued');assert.equal(row.queueId,`queue-${row.id}`);
  assert.equal((await restarted.getDeliveryEnvelope(row.id)).id,row.id);assert.equal((await restarted.getDeliveryEnvelope(row.id)).id,row.id);
  await restarted.completeDelivery(row.id,receipt(f.deliveries[0]));assert.equal((await restarted.listPendingDeliveries()).length,0);
  await restarted.completeDelivery(row.id,receipt(f.deliveries[0]));assert.equal((await restarted.getDashboard(f.scope)).recent[0].status,'sent');
});
test('unknown sends stay uncertain and never trigger blind retries',async()=>{
  let attempts=0;const f=fixture({deliver:async()=>{attempts++;throw new Error('provider token secret must not leak');}});await f.enable();await f.api.runDue({projectId:'project-a'});await f.api.runDue({projectId:'project-a'});
  assert.equal(attempts,1);const rows=await f.api.listPendingDeliveries();assert.equal(rows[0].status,'uncertain');assert.equal(JSON.stringify(rows).includes('secret'),false);
});
test('fresh authorization, recipient and campaign changes cancel queued delivery',async()=>{
  for (const mutation of ['authorization','recipient','campaign']) {
    const f=fixture();await f.enable({annualCheckup:{enabled:false,month:9,day:15}});
    const campaign=await f.api.createCampaign({projectId:'project-a'},{name:'Fixture',subject:'Hello',body:'Known text',topics:['energy'],schedule:{type:'once',at:'2026-09-15T09:00:00Z'},enabled:true});
    await f.api.runDue({projectId:'project-a'});assert.equal(f.deliveries.length,1);
    if(mutation==='authorization')await f.api.updateCustomerCare(f.scope,{emailAuthorized:false});
    if(mutation==='recipient')f.customers[0].email='new@example.test';
    if(mutation==='campaign')await f.api.updateCampaign({projectId:'project-a'},campaign.id,{enabled:false});
    await assert.rejects(f.api.getDeliveryEnvelope(f.deliveries[0].id),/geändert|Freigabe/);
    assert.equal((await f.api.getDashboard(f.scope)).recent[0].status,'cancelled');
  }
});
test('verified receipt binds exact recipient, sender, time and tenant',async()=>{
  const f=fixture();await f.enable();await f.api.runDue({projectId:'project-a'});const row=f.deliveries[0];
  for(const patch of [{recipient:'other@example.test'},{from:'other@example.test'},{verified:false},{sentAt:'2020-01-01T00:00:00Z'}])await assert.rejects(f.api.completeDelivery(row.id,receipt(row,patch)));
  await assert.rejects(f.api.completeDelivery(row.id,receipt(row),{projectId:'project-b'}),/nicht gefunden/);
  assert.equal((await f.api.listPendingDeliveries())[0].status,'queued');
});
test('public checkup reveals no recipient data and produces one high-priority advisor item',async()=>{
  const f=fixture();await f.enable({bookingUrl:'https://booking.example.test/anna'});await f.api.runDue({projectId:'project-a'});const token=tokenFrom(f.deliveries[0]);
  const form=await f.api.getPublicCheckup(token);assert.equal(form.status,'active');assert.equal(form.questions.length,4);assert.equal(JSON.stringify(form).includes('anna@example.test'),false);
  const input={answers:{changes:'yes',interest:'yes',topics:['energy'],comment:'Call me'},interest:true,bookingRequested:true,idempotencyKey:'fixture-idempotency'};
  const result=await f.api.submitPublicCheckup(token,input);assert.equal(result.status,'submitted');assert.equal(result.bookingUrl,'https://booking.example.test/anna');await f.api.submitPublicCheckup(token,input);
  await assert.rejects(f.api.submitPublicCheckup(token,{...input,answers:{...input.answers,comment:'Different'}}),/bereits beantwortet/);
  const dashboard=await f.api.getDashboard(f.scope);assert.equal(dashboard.responses.length,1);assert.equal(dashboard.responses[0].answers.comment,'Call me');assert.equal(JSON.stringify(dashboard.responses).includes(token),false);assert.equal(dashboard.responses[0].hash,undefined);assert.equal(dashboard.notifications.filter(item=>item.priority==='high').length,1);
  await f.api.runDue({projectId:'project-a'});assert.equal(f.deliveries.filter(item=>item.to[0]==='advisor@example.test').length,1);
});
test('public tokens expire, revoke and unsubscribe after submitted without affecting another project',async()=>{
  const f=fixture();await f.enable();await f.api.runDue({projectId:'project-a'});const token=tokenFrom(f.deliveries[0]);
  await f.api.submitPublicCheckup(token,{answers:{changes:'no',interest:'no'},idempotencyKey:'fixture-answers'});
  await f.api.submitPublicCheckup(token,{unsubscribe:true,idempotencyKey:'fixture-unsubscribe'});await f.api.submitPublicCheckup(token,{unsubscribe:true,idempotencyKey:'fixture-unsubscribe'});
  assert.equal((await f.api.getPublicCheckup(token)).status,'unsubscribed');assert.equal((await f.api.getDashboard(f.scope)).customer.care.emailAuthorized,false);
  assert.equal((await f.api.getDashboard({projectId:'project-b',customerId:'customer-a',workspaceId:'workspace-a'})).customer.care.emailAuthorized,true);
  const row=(await f.api.getDashboard(f.scope)).recent.find(item=>item.tokenId);await f.api.revokePublicCheckup(f.scope,row.tokenId);await assert.rejects(f.api.getPublicCheckup(token),/nicht mehr aktiv/);
  const g=fixture();await g.enable();await g.api.runDue({projectId:'project-a'});g.setTime('2026-11-01T10:00:00Z');await assert.rejects(g.api.getPublicCheckup(tokenFrom(g.deliveries[0])),/nicht mehr aktiv/);
});
test('optimization requires a current real provider quote with matching contract and customer',async()=>{
  const f=fixture();await f.enable({annualCheckup:{enabled:false,month:9,day:15},optimization:{enabled:true,leadDays:30}});
  await f.api.addContract(f.scope,{id:'energy-contract',product:'Strom',provider:'Current',topic:'energy',renewalDate:'2026-10-01',noticeDays:15,monthlyCost:80});
  await f.api.runDue({projectId:'project-a'});assert.equal(f.deliveries.length,0);assert.equal((await f.api.getDashboard(f.scope)).notifications[0].kind,'quote-required');
  const quote={id:'quote-1',provider:'Verified Provider',verified:true,providerVerified:true,customerId:'customer-a',contractId:'energy-contract',currency:'EUR',monthlyCost:65,checkedAt:'2026-09-15T09:00:00Z',expiresAt:'2026-09-17T00:00:00Z'};
  for(const patch of [{customerId:'other'},{verified:false},{expiresAt:'2026-09-01T00:00:00Z'}])assert.equal(usableQuote({...quote,...patch},{id:'energy-contract'},{id:'customer-a'},f.now()),null);
  const ready=createCustomerCareService({...f.dependencies,getOptimizationQuote:async()=>quote});await ready.runDue({projectId:'project-a'});assert.equal(f.deliveries.length,1);assert.match(f.deliveries[0].body,/65.00 EUR/);
  f.setTime('2026-09-18T12:00:00Z');await assert.rejects(ready.getDeliveryEnvelope(f.deliveries[0].id),/aktuell/);
});
test('monthly advisor summary is once per project/month and respects selected dashboard month',async()=>{
  const f=fixture();await f.enable({annualCheckup:{enabled:false,month:9,day:15},monthlySummary:{enabled:true,day:1}});await f.api.runDue({projectId:'project-a'});await f.api.runDue({projectId:'project-a'});
  assert.equal(f.deliveries.length,1);assert.deepEqual(f.deliveries[0].to,['advisor@example.test']);assert.match(f.deliveries[0].subject,/2026-09/);
  f.setTime('2026-10-01T10:00:00Z');await f.api.runDue({projectId:'project-a'});assert.equal(f.deliveries.length,2);
  assert.equal((await f.api.getDashboard({projectId:'project-a',month:'2027-02'})).monthly[0].month,'2027-02');
});
test('campaign annual/contract windows, topics and authorization remain unified',async()=>{
  const f=fixture();await f.enable({annualCheckup:{enabled:false,month:9,day:15}});await f.api.updateCustomerCare({...f.scope,workspaceId:'workspace-b',customerId:'customer-b'},{emailAuthorized:true});
  await f.api.addContract(f.scope,{id:'contract-x',product:'Energy',provider:'Provider',topic:'energy',renewalDate:'2026-09-30',noticeDays:15});
  const base={name:'Campaign',subject:'Topic check',body:'Fixture body',topics:['energy'],enabled:true};
  await f.api.createCampaign({projectId:'project-a'},{...base,schedule:{type:'contract',leadDays:30,from:'2026-09-01',to:'2026-09-30'}});
  await f.api.createCampaign({projectId:'project-a'},{...base,name:'Annual',schedule:{type:'annual',month:9,day:15}});
  await f.api.createCampaign({projectId:'project-a'},{...base,name:'Expired',schedule:{type:'once',at:'2026-09-01T00:00:00Z',to:'2026-09-10'}});
  await f.api.runDue({projectId:'project-a'});assert.equal(f.deliveries.length,2);assert.ok(f.deliveries.every(item=>item.to[0]==='anna@example.test' && tokenFrom(item)));
});
test('customer overrides cannot cross tenant boundaries through object keys',async()=>{
  const store=createCustomerCareStore({dataDir:path.join(temporary,'prototype')});await assert.rejects(async()=>store.read('constructor'));
  const f=fixture({getCustomers:async()=>[{id:'other',projectId:'project-b',email:'other@example.test'}]});await assert.rejects(f.api.getDashboard({projectId:'project-a'}),/anderen Projekt/);
});

test('campaign and contract creation are idempotent per project and reject key reuse for changed data',async()=>{
  const f=fixture();const campaign={name:'Test',subject:'Test',body:'Hello',schedule:{type:'once',at:'2026-10-01T10:00:00Z'},idempotencyKey:'campaign-command'};
  const first=await f.api.createCampaign({projectId:'project-a'},campaign),again=await f.api.createCampaign({projectId:'project-a'},campaign);
  assert.equal(first.id,again.id);assert.notEqual((await f.api.createCampaign({projectId:'project-b'},campaign)).id,first.id);
  await assert.rejects(f.api.createCampaign({projectId:'project-a'},{...campaign,body:'Changed'}),/anderen Kampagnendaten/);
  const contract={product:'Test',provider:'Provider',renewalDate:'2026-11-01',idempotencyKey:'contract-command'};
  assert.equal((await f.api.addContract(f.scope,contract)).id,(await f.api.addContract(f.scope,contract)).id);
});
test('uncertain and cancelled device outcomes reconcile without being counted as sent',async()=>{
  const f=fixture();await f.enable();const run=await f.api.runDue({projectId:'project-a'});
  assert.equal(run.queued,1);assert.equal(run.delivered,0);assert.equal(run.sent,0);
  const row=f.deliveries[0];await f.api.completeDelivery(row.id,{status:'uncertain'});assert.equal((await f.api.listPendingDeliveries())[0].status,'uncertain');
  await f.api.completeDelivery(row.id,{status:'canceled'});assert.equal((await f.api.listPendingDeliveries()).length,0);
  assert.equal((await f.api.getDashboard(f.scope)).recent[0].status,'cancelled');
});
test('missing quote results are retried after a bounded cache period, never on every tick',async()=>{
  let reads=0;const f=fixture({getOptimizationQuote:async()=>{reads++;return null;}});await f.enable({annualCheckup:{enabled:false,month:9,day:15},optimization:{enabled:true,leadDays:30}});
  await f.api.addContract(f.scope,{id:'contract',product:'Energy',provider:'Provider',renewalDate:'2026-10-01'});await f.api.runDue({projectId:'project-a'});await f.api.runDue({projectId:'project-a'});assert.equal(reads,1);
  f.setTime('2026-09-15T10:16:00Z');await f.api.runDue({projectId:'project-a'});assert.equal(reads,2);assert.equal(f.deliveries.length,0);
});

test('contract care lead time is before the actual cancellation deadline',()=>{
  assert.deepEqual(contractCareDates({renewalDate:'2026-11-30',noticeDays:90},45),{deadline:'2026-09-01',due:'2026-07-18'});
});
test('verified document quote preserves its original-document provenance without API claims',()=>{
  const quote={id:'quote-doc',provider:'Original Provider',verified:true,sourceType:'verified-document',sourceDocumentId:'doc-1',sourceSha256:'a'.repeat(64),reviewedBy:'admin',reviewedAt:'2026-09-01T12:00:00Z',conditions:'Twelve months, stated original tariff conditions.',customerId:'customer-a',contractId:'contract',currency:'EUR',monthlyCost:70,expiresAt:'2026-10-01T00:00:00Z'};
  const result=usableQuote(quote,{id:'contract'},{id:'customer-a'},Date.parse('2026-09-15T00:00:00Z'));
  assert.equal(result.providerVerified,false);assert.equal(result.sourceType,'verified-document');assert.equal(result.sourceLabel,'Geprüftes Originalangebot');
  assert.equal(usableQuote({...quote,sourceSha256:''},{id:'contract'},{id:'customer-a'},Date.parse('2026-09-15T00:00:00Z')),null);
});

test('a one-time campaign freezes its original audience and never enrolls later customers',async()=>{
  const f=fixture();await f.enable({annualCheckup:{enabled:false,month:9,day:15}});
  const campaign=await f.api.createCampaign({projectId:'project-a'},{name:'Once',subject:'Once',body:'Fixture body',schedule:{type:'once',at:'2026-09-15T09:00:00Z'},idempotencyKey:'once-audience'});
  await f.api.runDue({projectId:'project-a'});assert.equal(f.deliveries.length,1);
  f.customers.push({id:'new-customer',workspaceId:'workspace-new',projectId:'project-a',name:'Later customer',email:'new@example.test',emailAuthorized:true,topics:['energy']});
  f.setTime('2027-01-01T10:00:00Z');await f.api.updateCampaign({projectId:'project-a'},campaign.id,{name:'Renamed once'});await f.api.runDue({projectId:'project-a'});
  assert.equal(f.deliveries.length,1);const saved=(await f.api.getDashboard({projectId:'project-a'})).campaigns[0];assert.equal(saved.audienceSnapshot.length,1);
});
test('monthly annual items show verified sent state rather than always planned',async()=>{
  const f=fixture();await f.enable();await f.api.runDue({projectId:'project-a'});await f.api.completeDelivery(f.deliveries[0].id,receipt(f.deliveries[0]));
  const item=(await f.api.getDashboard(f.scope)).monthly[0].items.find(row=>row.kind==='annual-checkup');assert.equal(item.status,'sent');assert.equal(item.sentAt,'2026-09-15T10:00:00Z');
});

test('existing authoritative topics remain visible until explicitly overridden',async()=>{
  const f=fixture();assert.deepEqual((await f.api.getDashboard(f.scope)).customer.care.topics,['pv','energy']);
  await f.api.updateCustomerCare(f.scope,{topics:[]});assert.deepEqual((await f.api.getDashboard(f.scope)).customer.care.topics,[]);
});
test('queued original offers are revalidated against the current document before delivery',async()=>{
  let available=true;
  const quote={id:'doc-quote',provider:'Original',sourceType:'verified-document',sourceDocumentId:'doc',sourceSha256:'a'.repeat(64),reviewedBy:'admin',reviewedAt:'2026-09-15T09:00:00Z',conditions:'Fixture conditions',verified:true,customerId:'customer-a',contractId:'contract-original',currency:'EUR',monthlyCost:60,expiresAt:'2026-10-01T00:00:00Z'};
  const f=fixture({getOptimizationQuote:async()=>available?quote:null});await f.enable({annualCheckup:{enabled:false,month:9,day:15},optimization:{enabled:true,leadDays:30}});
  await f.api.addContract(f.scope,{id:'contract-original',product:'Energy',provider:'Provider',renewalDate:'2026-10-01'});await f.api.runDue({projectId:'project-a'});
  assert.equal((await f.api.getDeliveryEnvelope(f.deliveries[0].id)).id,f.deliveries[0].id);
  available=false;await assert.rejects(f.api.getDeliveryEnvelope(f.deliveries[0].id),/Originalangebot/);assert.equal((await f.api.getDashboard(f.scope)).recent[0].status,'cancelled');
});

test('independent processes keep all project mutations under the shared durable lock',async()=>{
  const dataDir=path.join(temporary,'parallel-processes'),url=new URL('../customer-care/store.js',import.meta.url).href;
  await Promise.all(Array.from({length:4},(_,index)=>promisify(execFile)(process.execPath,['--input-type=module','-e',`import {createCustomerCareStore} from ${JSON.stringify(url)}; await createCustomerCareStore({dataDir:${JSON.stringify(dataDir)}}).transaction('project-a',state=>{state.notifications.push({id:${JSON.stringify(String(index))}});return true;});`],{timeout:10000})));
  assert.equal((await createCustomerCareStore({dataDir}).read('project-a')).notifications.length,4);
});
