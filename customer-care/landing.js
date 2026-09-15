export function customerCheckupLandingFiles({coreOrigin,projectName='Jahres-Check-up'}) {
  const origin=new URL(coreOrigin);if(origin.protocol!=='https:'||origin.username||origin.password)throw new Error('Check-up benötigt eine sichere IVA-Adresse.');
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return [{path:'index.html',encoding:'utf8',content:`<!doctype html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><title>${esc(projectName)} · Jahres-Check-up</title><style>body{margin:0;background:#f5f7fa;color:#14283a;font:18px/1.6 system-ui}main{max-width:640px;margin:12vh auto;padding:24px}h1{font-size:clamp(28px,6vw,48px);line-height:1.15}iframe{display:block;width:100%;height:100dvh;border:0}small{color:#526677}</style></head><body><main id="welcome"><small>${esc(projectName)}</small><h1>Was hat sich bei Ihnen verändert?</h1><p>Mit Ihrem persönlichen Jahres-Check-up behalten wir gemeinsam den Überblick. Wenige Fragen, auf Wunsch ein Beratungstermin.</p><p>Bitte öffnen Sie dafür den persönlichen Link aus Ihrer Einladung.</p></main><script>(()=>{const token=location.hash.slice(1);if(!/^[A-Za-z0-9_-]{43,128}$/.test(token))return;const frame=document.createElement('iframe');frame.title='Persönlicher Jahres-Check-up';frame.referrerPolicy='no-referrer';frame.src=${JSON.stringify(origin.origin)}+'/checkup/'+encodeURIComponent(token);document.getElementById('welcome').replaceWith(frame);history.replaceState(null,'',location.pathname+location.search+'#'+token);})();</script></body></html>`}];
}
export function createCustomerCareLanding({coreOrigin,getProject}) {
  const jobs=new Map();
  async function create({projectId},websiteService){
    const project=await getProject(projectId);if(!project)throw new Error('Projekt nicht gefunden.');
    const existing=(await websiteService.list(projectId)).find(s=>s.source?.type==='customer-care' || s.description==='IVA Kundenbetreuung · persönlicher Jahres-Check-up');
    if(existing?.draftRevisionId)return {site:existing,url:'/website-studio?projectId='+encodeURIComponent(projectId)+'&siteId='+existing.id,reused:true};
    const site=existing || await websiteService.create({projectId,name:project.name+' · Jahres-Check-up',description:'IVA Kundenbetreuung · persönlicher Jahres-Check-up'});
    await websiteService.store.saveRevision(projectId,site.id,{baseRevisionId:null,files:customerCheckupLandingFiles({coreOrigin,projectName:project.name}),summary:'Mobile Kunden-Check-up-Seite mit persönlichem Einladungsschlüssel.',source:{type:'customer-care'}});
    const preview=await websiteService.preview(projectId,site.id);
    if(preview.status!=='ready')throw new Error('Die Check-up-Seite konnte nicht gebaut werden.');
    return {site:await websiteService.site(projectId,site.id),url:'/website-studio?projectId='+encodeURIComponent(projectId)+'&siteId='+site.id,status:'draft',message:'Seite im Website Studio erstellt. Nach Veröffentlichung die Seitenadresse in der Kundenbetreuung als Landingpage hinterlegen.'};
  }
  return (input,service)=>{const key=input.projectId;if(jobs.has(key))return jobs.get(key);const promise=create(input,service).finally(()=>jobs.delete(key));jobs.set(key,promise);return promise;};
}
