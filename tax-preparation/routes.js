import {taxPreparationReport} from './service.js';
const wrap=fn=>async(q,r)=>{r.set('Cache-Control','no-store');try{await fn(q,r);}catch(e){r.status(e.status||500).json({error:e.status?e.message:'Steuervorbereitung derzeit nicht verfügbar.'});}};
const scope=q=>{ for(const key of ['projectId','entityId','year']) if(q.body?.[key]!==undefined&&String(q.body[key])!==String(q.query[key]))throw Object.assign(new Error('Projekt, Firma und Jahr müssen eindeutig sein.'),{status:400}); return {projectId:q.query.projectId,entityId:q.query.entityId,year:q.query.year}; };
export function registerTaxPreparationRoutes(app,{service}){
  // This router is mounted behind the owner guard; assignment discovery returns only IDs/names.
  app.get('/api/tax-preparation/entities',wrap(async(q,r)=>r.json(await service.entityAssignments(scope(q).projectId))));
  app.put('/api/tax-preparation/entities',wrap(async(q,r)=>r.json(await service.setEntityAssignments(scope(q).projectId,q.body))));
  app.get('/api/tax-preparation/context',wrap(async(q,r)=>r.json(await service.context(q.query.projectId))));
  app.get('/api/tax-preparation/year',wrap(async(q,r)=>r.json(await service.get(scope(q)))));
  app.patch('/api/tax-preparation/year',wrap(async(q,r)=>r.json(await service.update(scope(q),q.body))));
  app.get('/api/tax-preparation/report',wrap(async(q,r)=>{const data=await service.get(scope(q));r.set({'Content-Type':'text/html; charset=utf-8','Content-Disposition':`attachment; filename="IVA-Steuervorbereitung-${data.year}.html"`}).send(taxPreparationReport(data));}));
}
