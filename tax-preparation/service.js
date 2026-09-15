import {createProjectStore,operationalError,operationalId} from '../operations/project-store.js';
import {TAX_QUESTIONS,TAX_SOURCES,TAX_REVIEWED_AT} from './catalog.js';
const clean=(v,n=3000)=>String(v??'').trim().slice(0,n);
const yearOf=value=>{
  if(typeof value!=='string')return null;
  const match=/^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if(!match)return null;
  const [,y,m,d]=match.map(Number), date=new Date(Date.UTC(y,m-1,d));
  return date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d&&Number.isFinite(Date.parse(value))?y:null;
};
const dateValues=document=>[document.invoiceDate,document.payment?.paidAt];
const invalidDate=document=>dateValues(document).some(value=>value!==undefined&&value!==null&&value!==''&&!yearOf(value));
const dated=document=>!invalidDate(document)&&dateValues(document).some(value=>yearOf(value)!==null);
const assignedIds=state=>Array.isArray(state.entityIds)?state.entityIds:[];
const configRevision=state=>Number.isInteger(state.configRevision)?state.configRevision:0;
export function createTaxPreparation({dataDir,getProject,listEntities,listDocuments}){
  const store=createProjectStore({dataDir,name:'tax-preparation',getProject,initial:()=>({years:[],entityIds:[],configRevision:0})});
  async function parameters(scope){
    operationalId(scope?.projectId);operationalId(scope?.entityId);
    const year=Number(scope.year);if(!Number.isInteger(year)||year<2020||year>new Date().getUTCFullYear())throw operationalError('Bitte ein vorhandenes Steuerjahr wählen.');
    const state=await store.read(scope.projectId);
    const entity=(await listEntities()).find(e=>e.id===scope.entityId&&assignedIds(state).includes(e.id));if(!entity)throw operationalError('Rechtsträger ist diesem Projekt nicht zugeordnet.',404);
    return {year,entity,key:year+':'+entity.id,state};
  }
  async function documents(entityId,year){
    const rows=await listDocuments({entityId});
    return rows.filter(d=>d.entityId===entityId&&(invalidDate(d)||!yearOf(d.invoiceDate)&&!yearOf(d.payment?.paidAt)||yearOf(d.invoiceDate)===year||yearOf(d.payment?.paidAt)===year));
  }
  function assessed(state,entity,year,docs){
    const source=state||{year,entityId:entity.id,revision:0,includePersonal:!/(gmbh|\bug\b|\bag\b)/i.test(entity.legalForm||''),answers:{},notes:''};
    const questions=TAX_QUESTIONS.filter(q=>!q.personal||source.includePersonal).map(q=>{
      const answer=source.answers[q.id]||{relevance:'unknown',note:'',documentIds:[]};
      const linked=answer.documentIds.map(id=>docs.find(d=>d.id===id)).filter(Boolean);
      const missingEvidence=answer.documentIds.filter(id=>!linked.some(d=>d.id===id));
      const reviewed=linked.length>0&&linked.every(d=>d.assessment?.workflowStatus==='ready'&&!d.duplicateOf&&dated(d));
      const status=answer.relevance==='no'?'not-applicable':answer.relevance==='yes'&&reviewed&&!missingEvidence.length?'documented':'open';
      return {...q,answer,status,missingEvidence,suggestedDocumentIds:docs.filter(d=>q.categories.includes(d.category)&&!d.duplicateOf).map(d=>d.id)};
    });
    const complete=questions.filter(q=>q.status!=='open').length;
    const byMonth=Array.from({length:12},(_,i)=>({month:year+'-'+String(i+1).padStart(2,'0'),documents:docs.filter(d=>dateValues(d).some(v=>yearOf(v)===year&&v.slice(0,7)===year+'-'+String(i+1).padStart(2,'0'))).length}));
    const blockers=[];if(!['euer','bilanz'].includes(entity.taxMode))blockers.push('Gewinnermittlung EÜR/Bilanz ist noch ungeklärt.');if(entity.vatStatus==='unknown'||!entity.vatStatus)blockers.push('Umsatzsteuerstatus ist noch ungeklärt.');
    if(docs.some(d=>d.duplicateOf))blockers.push('Mögliche Belegdubletten prüfen.');
    if(docs.some(invalidDate))blockers.push('Ungültige Rechnungs- oder Zahlungsdaten in der Belegablage korrigieren.');
    if(docs.some(d=>!yearOf(d.invoiceDate)&&!yearOf(d.payment?.paidAt)))blockers.push('Undatierte Belege einem Steuerjahr zuordnen.');
    if(docs.some(d=>d.assessment?.workflowStatus!=='ready'))blockers.push('Offene Prüfungen in der Belegablage bearbeiten.');
    return {...source,entity,questions,documents:docs,months:byMonth,progress:{complete,total:questions.length,percent:Math.round(100*complete/questions.length)},status:complete===questions.length&&!blockers.length?'prepared':'incomplete',blockers,nextQuestions:questions.filter(q=>q.status==='open').slice(0,3),sources:TAX_SOURCES,reviewedAt:TAX_REVIEWED_AT,scopeNote:'Vorbereitung und Belegordnung; keine Steuerberechnung, Steuerfreigabe oder ELSTER-Übermittlung. Die Rechtslage muss zum gewählten Steuerjahr passen.'};
  }
  async function entityAssignments(projectId){
    const state=await store.read(projectId), available=await listEntities();
    return {availableEntities:available.map(entity=>({id:entity.id,name:entity.name})),entityIds:assignedIds(state).filter(id=>available.some(entity=>entity.id===id)),configRevision:configRevision(state)};
  }
  async function setEntityAssignments(projectId,input={}){
    if(!Array.isArray(input.entityIds)||input.entityIds.length>200||new Set(input.entityIds).size!==input.entityIds.length)throw operationalError('Firmenzuordnung ungültig.');
    const available=await listEntities();
    for(const id of input.entityIds){operationalId(id);if(!available.some(entity=>entity.id===id))throw operationalError('Unbekannter Rechtsträger.');}
    await store.mutate(projectId,state=>{
      if(!Number.isInteger(input.expectedRevision)||input.expectedRevision!==configRevision(state))throw operationalError('Die Firmenzuordnung wurde inzwischen geändert. Bitte neu laden.',409);
      state.entityIds=[...input.entityIds];state.configRevision=configRevision(state)+1;return null;
    });return entityAssignments(projectId);
  }
  async function context(projectId){const state=await store.read(projectId);return {entities:(await listEntities()).filter(entity=>assignedIds(state).includes(entity.id)),sources:TAX_SOURCES,questionCount:TAX_QUESTIONS.length,reviewedAt:TAX_REVIEWED_AT};}
  async function get(scope){const p=await parameters(scope),docs=await documents(p.entity.id,p.year);return assessed(p.state.years.find(y=>y.key===p.key),p.entity,p.year,docs);}
  async function update(scope,input={}){
    const p=await parameters(scope),docs=await documents(p.entity.id,p.year);
    await store.mutate(scope.projectId,state=>{
      if(!assignedIds(state).includes(p.entity.id))throw operationalError('Rechtsträger ist diesem Projekt nicht zugeordnet.',404);
      let row=state.years.find(y=>y.key===p.key);const current=assessed(row,p.entity,p.year,docs);
      if(input.expectedRevision!==current.revision)throw operationalError('Der Stand wurde inzwischen geändert. Bitte neu laden.',409);
      if(!row){row={key:p.key,year:p.year,entityId:p.entity.id,revision:0,includePersonal:current.includePersonal,answers:{},notes:'',createdAt:new Date().toISOString()};state.years.push(row);}
      if('includePersonal'in input){if(typeof input.includePersonal!=='boolean')throw operationalError('Persönlicher Bereich ungültig.');row.includePersonal=input.includePersonal;}
      if('notes'in input)row.notes=clean(input.notes,8000);
      if('answers'in input){if(!input.answers||typeof input.answers!=='object'||Array.isArray(input.answers)||Object.keys(input.answers).length>50)throw operationalError('Antworten ungültig.');
        for(const [id,a]of Object.entries(input.answers)){
          if(!TAX_QUESTIONS.some(q=>q.id===id)||!a||!['yes','no','unknown'].includes(a.relevance))throw operationalError('Unbekannte Frage oder Antwort.');
          if(!Array.isArray(a.documentIds)||a.documentIds.length>30||a.documentIds.some(id=>!docs.some(d=>d.id===id)))throw operationalError('Ein Beleg gehört nicht zu diesem Rechtsträger und Steuerjahr.');
          row.answers[id]={relevance:a.relevance,note:clean(a.note),documentIds:[...new Set(a.documentIds)],answeredAt:new Date().toISOString()};
        }
      }
      row.revision++;row.updatedAt=new Date().toISOString();return row;
    });return get(scope);
  }
  return{context,get,update,entityAssignments,setEntityAssignments};
}

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function taxPreparationReport(data){
  const status={open:'Offen',documented:'Belege dokumentiert','not-applicable':'Trifft laut Angabe nicht zu'};
  return `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Steuervorbereitung ${data.year}</title><style>body{max-width:960px;margin:48px auto;padding:0 28px;font:15px/1.6 system-ui;color:#183b3f}h1{font-size:36px;line-height:1.15}h2{margin-top:32px}small,.muted{color:#617477}.bar{border-top:5px solid #168379;padding-top:22px}.item{break-inside:avoid;border-bottom:1px solid #dfe7e5;padding:18px 0}.label{font-size:12px;text-transform:uppercase;color:#168379}.note{white-space:pre-wrap}table{width:100%;border-collapse:collapse;font-size:12px}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left;overflow-wrap:anywhere}a{color:#12695f}footer{margin-top:32px;font-size:12px}@media print{body{margin:0;max-width:none}thead{display:table-header-group}@page{size:A4;margin:18mm}}</style><header class="bar"><span class="label">IVA · Vorbereitung für die Steuerberatung</span><h1>${esc(data.entity.name)}<br>Steuerjahr ${data.year}</h1><p>${data.progress.complete} von ${data.progress.total} Prüfpunkten dokumentiert oder als nicht zutreffend beantwortet.</p><p class="muted">${esc(data.scopeNote)}</p><p>Gewinnermittlung: ${esc(data.entity.taxMode)} · Umsatzsteuer: ${esc(data.entity.vatStatus)}</p></header><h2>Als Nächstes klären</h2><ul>${[...data.blockers,...data.questions.filter(q=>q.status==='open').map(q=>q.label+': '+q.documents)].map(t=>`<li>${esc(t)}</li>`).join('')||'<li>Keine offenen Punkte im beantworteten Fragebogen. Fachliche Schlussprüfung bleibt separat.</li>'}</ul>${data.notes?`<h2>Eigene Notizen</h2><p class="note">${esc(data.notes)}</p>`:''}<h2>Antworten und Belege</h2>${data.questions.map(q=>`<section class="item"><span class="label">${esc(q.group)} · ${esc(status[q.status])}</span><h3>${esc(q.label)}</h3><p>${esc(q.question)}</p><p class="note">${esc(q.answer.note||'Keine zusätzliche Erläuterung.')}</p><p><strong>Benötigt:</strong> ${esc(q.documents)}</p><p>${esc(q.tip)}</p><small>Verknüpfte Belege: ${q.answer.documentIds.map(id=>esc(data.documents.find(d=>d.id===id)?.file?.name||id)).join(', ')||'keine'}</small></section>`).join('')}<h2>Belegverzeichnis</h2><table><thead><tr><th>Beleg</th><th>Rechnungsdatum</th><th>Zahlungsdatum</th><th>Prüfstatus</th></tr></thead><tbody>${data.documents.map(d=>`<tr><td>${esc(d.file?.name)}<br>${esc(d.vendor)}</td><td>${esc(d.invoiceDate||'offen')}</td><td>${esc(d.payment?.paidAt||'offen')}</td><td>${esc(d.assessment?.reason||'Prüfung offen')}</td></tr>`).join('')}</tbody></table><footer><b>Quellen zur fachlichen Prüfung · Abrufstand ${TAX_REVIEWED_AT}</b><ul>${data.sources.map(s=>`<li><a href="${esc(s.url)}">${esc(s.title)}</a></li>`).join('')}</ul>Die EÜR-Anleitung 2025 ist als Orientierung gekennzeichnet und keine bestätigte Zeilenbelegung für andere Jahre.</footer></html>`;
}
