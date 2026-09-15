import express from 'express';
import {createHash} from 'node:crypto';
import {normalizeCampaign} from './rules.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const publicDir=fileURLToPath(new URL('../public/',import.meta.url));
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const wrap=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{await fn(req,res);}catch(error){res.status(error.status||error.statusCode||400).json({error:error.message,code:error.code});}};
const scope=req=>({projectId:req.query.projectId || req.body?.projectId,workspaceId:req.query.workspaceId || req.body?.workspaceId,customerId:req.query.customerId || req.body?.customerId,month:req.query.month});
export function registerCustomerCarePublicRoutes(app,{service}) {
  const base='/public/customer-care/:token';
  const requests=new Map();
  const limited=(q,r,next)=>{const now=Date.now(),key=createHash('sha256').update(String(q.socket.remoteAddress)+':'+String(q.params.token)).digest('hex');const previous=requests.get(key);const entry=previous&&previous.until>now?previous:{until:now+60000,count:0};entry.count++;requests.set(key,entry);if(requests.size>2000)for(const [k,v] of requests){if(v.until<now||requests.size>2000)requests.delete(k);}if(entry.count>60)return r.status(429).json({error:'Bitte kurz warten und dieselbe Anfrage erneut versuchen.'});next();};
  const headers=(_q,r,next)=>{r.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff'});next();};
  // Opaque capability URLs expose only the one form, never a customer search.
  app.get('/checkup/:token',headers,(_q,r)=>r.sendFile(path.join(publicDir,'customer-checkup.html')));
  for(const name of ['customer-checkup.js','customer-checkup.css']) app.get('/'+name,headers,(_q,r)=>r.sendFile(path.join(publicDir,name)));
  app.get(base,headers,limited,wrap(async(q,r)=>r.json(await service.getPublicCheckup(q.params.token))));
  app.post(base,headers,limited,express.json({limit:'24kb'}),wrap(async(q,r)=>r.json(await service.submitPublicCheckup(q.params.token,q.body||{}))));
}
export function registerCustomerCareRoutes(app,{service,listProjects,access,customers,readiness,calculatorReadiness,websiteService,landing,quotes}) {
  const base='/api/customer-care';
  async function check(s) {
    if(!s.projectId)throw fail('Bitte ein Projekt auswählen.');
    const config=await access.getProjectAccess(s.projectId);
    if(!config.modules.includes('crm')&&!config.modules.includes('marketing'))throw fail('Kundenbetreuung ist für dieses Projekt nicht freigegeben.',403);
    if((s.customerId||s.workspaceId)&&!(await customers(s)).length)throw fail('Kundenakte gehört nicht zu diesem Projekt.',404);
    return s;
  }
  const scoped=fn=>wrap(async(q,r)=>fn(q,r,await check(scope(q))));
  app.get(base+'/projects',wrap(async(_q,r)=>{const rows=[];for(const p of await listProjects()){const c=await access.getProjectAccess(p.id);if(c.modules.includes('crm')||c.modules.includes('marketing'))rows.push({id:p.id,name:p.name});}r.json({projects:rows});}));
  app.get(base,scoped(async(q,r,s)=>{const dashboard=await service.getDashboard(s);r.json({...dashboard,...(quotes?await quotes.list(s):{}),readiness:[...(dashboard.readiness||[]),...await readiness()],calculators:calculatorReadiness(),websiteStudioUrl:'/website-studio?projectId='+encodeURIComponent(s.projectId)});}));
  app.get(base+'/overview',wrap(async(q,r)=>{const rows=[];for(const p of await listProjects()){try{await check({projectId:p.id});const d=await service.getDashboard({projectId:p.id});rows.push({projectId:p.id,projectName:p.name,monthly:(d.monthly?.[0]?.items||[]),notifications:d.notifications||[],campaigns:d.campaigns||[]});}catch(e){if(e.status!==403)throw e;}}r.json({projects:rows});}));
  app.patch(base,scoped(async(q,r,s)=>{if(q.body?.settings)await service.updateSettings(s,q.body.settings);if(q.body?.customerCare)await service.updateCustomerCare(s,q.body.customerCare);r.json(await service.getDashboard(s));}));
  app.post(base+'/quotes',scoped(async(q,r,s)=>r.status(201).json(await quotes.save(s,q.body))));
  app.post(base+'/contracts',scoped(async(q,r,s)=>r.status(201).json(await service.addContract(s,q.body))));
  app.post(base+'/batch-campaigns',wrap(async(q,r)=>{
    const ids=q.body?.projectIds;
    if(!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids).size!==ids.length)throw fail('Bitte die Zielprojekte eindeutig auswählen.');
    if(!/^[A-Za-z0-9_-]{16,160}$/.test(q.body?.idempotencyKey||''))throw fail('Die eindeutige Kampagnenkennung fehlt.');
    normalizeCampaign(q.body.campaign||{},Date.now());
    for(const id of ids)await check({projectId:id});
    const results=[];for(const projectId of ids)results.push({projectId,campaign:await service.createCampaign({projectId},{...q.body.campaign,idempotencyKey:q.body.idempotencyKey})});
    r.status(201).json({campaigns:results});
  }));
  app.post(base+'/campaigns',scoped(async(q,r,s)=>r.status(201).json(await service.createCampaign(s,q.body))));
  app.patch(base+'/campaigns/:id',scoped(async(q,r,s)=>r.json(await service.updateCampaign(s,q.params.id,q.body))));
  app.post(base+'/run',scoped(async(q,r,s)=>r.json(await service.runDue({projectId:s.projectId}))));
  app.post(base+'/tokens/:id/revoke',scoped(async(q,r,s)=>r.json(await service.revokePublicCheckup(s,q.params.id))));
  app.post(base+'/landing',scoped(async(q,r,s)=>r.status(201).json(await landing({projectId:s.projectId,siteId:q.body?.siteId},websiteService))));
  app.get('/api/advice/calculators/readiness',wrap(async(_q,r)=>r.json(calculatorReadiness())));
}
export function createCustomerCareScheduler({service,listProjects,authorize,reconcile,intervalMs=60000,onError=()=>{}}) {
  let timer,active=null,closed=false,lastError=null,lastRunAt=null;
  async function execute(){await reconcile(service);for(const p of await listProjects()){if(closed)break;try{if(!await authorize(p.id))continue;await service.runDue({projectId:p.id});}catch(e){lastError='Kundenbetreuung konnte einen Projektlauf nicht abschließen.';onError(e);}}lastRunAt=new Date().toISOString();}
  const tick=()=>active||(active=execute().finally(()=>{active=null;}));
  async function loop(){try{await tick();}catch(e){lastError='Kundenbetreuung wird beim nächsten Lauf erneut geprüft.';onError(e);}finally{if(!closed){timer=setTimeout(loop,intervalMs);timer.unref?.();}}}
  timer=setTimeout(loop,15000);timer.unref?.();
  return {tick,status:()=>({running:!!active,lastRunAt,lastError,intervalMs}),close(){closed=true;clearTimeout(timer);}};
}
