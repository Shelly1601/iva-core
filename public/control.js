const $ = id => document.getElementById(id);
const TOKEN_KEY = 'iva_token';
const state = { status:null, approvals:[], runs:[], audit:[], automations:[], automationRuns:[], reports:[] };
function token(){ return localStorage.getItem(TOKEN_KEY) || ''; }
function esc(value){ return String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }
function fmt(value){ if(!value)return '–'; try{return new Date(value).toLocaleString('de-DE',{dateStyle:'short',timeStyle:'short'});}catch{return value;} }
function duration(ms){ if(!Number.isFinite(Number(ms)))return '–'; return Number(ms)<1000?Math.round(ms)+' ms':(Number(ms)/1000).toFixed(1).replace('.',',')+' s'; }
function setStatus(kind,text){ $('status').className='status'+(kind?' '+kind:''); $('status').querySelector('span').textContent=text; }
async function api(path,options={}){ const response=await fetch(path,{...options,headers:{Authorization:'Bearer '+token(),...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})},body:options.body?JSON.stringify(options.body):undefined}); const payload=await response.json().catch(()=>({})); if(!response.ok)throw new Error(payload.error||'HTTP '+response.status); return payload; }
function empty(text){ return `<div class="empty">${esc(text)}</div>`; }

function renderMetrics(){
  const s=state.status||{}, ops=s.operations||{}, connectors=s.connectors||{}, automations=s.automations||{};
  const values=[
    [automations.enabled||0,'Automationen an','good'],
    [automations.failedToday||0,'Workflow-Fehler heute',automations.failedToday?'bad':'good'],
    [`${connectors.ready||0} / ${connectors.total||0}`,'Anbindungen bereit',(connectors.ready||0)===(connectors.total||0)?'good':'warn'],
    [ops.approvals?.pending||0,'offene Freigaben',ops.approvals?.pending?'warn':'good'],
    [ops.runs?.failed||0,'fehlgeschlagene Läufe',ops.runs?.failed?'bad':'good'],
  ];
  $('metrics').innerHTML=values.map(([value,label,kind])=>`<div class="metric ${kind}"><b>${esc(value)}</b><small>${esc(label)}</small></div>`).join('');
}
function automationStatus(item){ const run=item.lastRun; if(!run)return ['noch kein Lauf','off']; if(run.status==='completed')return ['zuletzt erfolgreich','ready']; if(run.status==='failed')return ['zuletzt Fehler','']; if(run.status==='blocked')return ['blockiert','']; return [run.status,'off']; }
function renderAutomations(){
  const reporting=state.status?.systems?.reporting||{};
  $('automations').innerHTML=state.automations.length?state.automations.map(item=>{ const [label,kind]=automationStatus(item); return `<article class="workflow"><div><div class="list-head"><h3>${esc(item.name)}</h3><span class="badge ${kind}">${esc(label)}</span></div><p>${esc(item.description)}</p><div class="workflow-meta"><span>${esc(item.category)}</span><span>${esc(item.schedule)}</span>${item.lastRun?`<span>Letzter Lauf: ${fmt(item.lastRun.completedAt||item.lastRun.startedAt)}</span>`:''}</div></div><label class="switch" title="${item.enabled?'Ausschalten':'Einschalten'}"><input type="checkbox" data-automation="${esc(item.id)}" ${item.enabled?'checked':''}><span class="slider"></span></label></article>`; }).join(''):empty('Keine Automationen registriert.');
  const emailHint=reporting.ready?`E-Mail bereit über ${reporting.provider} · ${reporting.recipient}`:`E-Mail noch nicht bereit · fehlt: ${(reporting.missing||[]).join(', ')}`;
  $('reports').innerHTML=`<span class="report-chip">${esc(emailHint)}</span>`+(state.reports.length?state.reports.slice(0,8).map(item=>`<span class="report-chip">${esc(item.type==='weekly'?'Woche':'Tag')} ${esc(item.periodKey)} · ${esc(item.counts?.completed||0)} ok / ${esc(item.counts?.failed||0)} Fehler</span>`).join(''):'<span class="report-chip">Noch kein Report erstellt.</span>');
  document.querySelectorAll('[data-automation]').forEach(input=>input.addEventListener('change',()=>{void toggleAutomation(input);}));
}
async function toggleAutomation(input){
  const enabled=input.checked; input.disabled=true; setStatus('','speichere Schalter …');
  try{ const updated=await api(`/api/automations/${encodeURIComponent(input.dataset.automation)}`,{method:'PATCH',body:{enabled}}); const index=state.automations.findIndex(item=>item.id===updated.id); if(index>=0)state.automations[index]={...state.automations[index],...updated}; renderAutomations(); setStatus('on',enabled?'Automation aktiviert':'Automation pausiert'); }
  catch(error){ input.checked=!enabled; setStatus('err',error.message); }
  finally{ input.disabled=false; }
}
function renderAgents(){
  const items=state.status?.agents||[];
  $('agents').innerHTML=items.length?items.map(item=>`<article class="agent"><div class="agent-head"><div><b>${esc(item.name)}</b><p>${esc(item.description)}</p></div><span class="badge ${item.enabled?'ready':'off'}">${item.enabled?'aktiv':'gesperrt'}</span></div><div class="skills">${(item.allowedSkills||[]).map(skill=>`<span>${esc(skill)}</span>`).join('')||'<span>noch keine Werkzeuge</span>'}</div><div class="meta">Sicherheitsstufe: ${esc(item.safetyDefault)}</div></article>`).join(''):empty('Keine Agenten geladen.');
}
function renderConnectors(){
  const items=state.status?.connectors?.items||[];
  $('connectors').innerHTML=items.length?items.map(item=>`<article class="connector"><div class="connector-head"><div><b>${esc(item.label)}</b><p>${esc(item.detail||'')}</p></div><span class="badge ${item.ready?'ready':''}">${item.ready?'bereit':'offen'}</span></div>${item.missing?.length?`<div class="missing">Fehlt: ${item.missing.map(esc).join(' · ')}</div>`:''}</article>`).join(''):empty('Keine Connector-Daten.');
}
function renderApprovals(){
  $('approvals').innerHTML=state.approvals.length?state.approvals.map(item=>`<article class="list-item"><div class="list-head"><b>${esc(item.title)}</b><span class="badge">${esc(item.status)}</span></div><p>${esc(item.summary||'')}</p><div class="tools">Bestätigung: ${esc(item.confirmationPhrase||'im Vorgang')}</div><div class="meta">${fmt(item.updatedAt)} · ${esc(item.agentId)}</div></article>`).join(''):empty('Keine Freigabe wartet.');
}
function renderRuns(){
  $('runs').innerHTML=state.runs.length?state.runs.map(item=>`<article class="list-item"><div class="list-head"><b>${esc(item.agentName)}</b><span class="badge ${item.status==='completed'?'ready':item.status==='failed'?'':'off'}">${esc(item.status)}</span></div><p>${esc(item.requestPreview||'')}</p>${item.tools?.length?`<div class="tools">Werkzeuge: ${item.tools.map(esc).join(' · ')}</div>`:''}${item.error?`<div class="error">${esc(item.error)}</div>`:''}<div class="meta">${fmt(item.createdAt)} · ${duration(item.durationMs)} · ${esc(item.routeReason)}</div></article>`).join(''):empty('Noch keine protokollierten Agentenläufe.');
}
function renderBacklog(){
  const items=state.status?.buildBacklog||[];
  $('backlog').innerHTML=items.length?items.slice(0,8).map(item=>`<article class="list-item"><div class="list-head"><b>${esc(item.title||item.request||'Bauauftrag')}</b><span class="badge">${esc(item.status||'erfasst')}</span></div><p>${esc(item.request||item.description||'')}</p><div class="meta">${fmt(item.updatedAt||item.createdAt)}</div></article>`).join(''):empty('Keine offene Bauanforderung.');
}
function renderAudit(){
  $('audit').innerHTML=state.audit.length?state.audit.slice(0,8).map(item=>`<article class="list-item"><div class="list-head"><b>${esc(item.action)}</b><span class="badge ${item.status==='completed'?'ready':''}">${esc(item.status)}</span></div><p>${esc(item.detail||item.target||'')}</p><div class="meta">${fmt(item.createdAt)} · ${esc(item.actor)}</div></article>`).join(''):empty('Noch keine Audit-Ereignisse.');
}
function render(){ renderMetrics(); renderAutomations(); renderAgents(); renderConnectors(); renderApprovals(); renderRuns(); renderBacklog(); renderAudit(); }
function makeCollapsible(){ document.querySelectorAll('.main>section.card,.main>section.grid>.card').forEach(card=>{ const heading=card.querySelector(':scope>h2'); if(!heading)return; const subtitle=heading.nextElementSibling?.classList?.contains('muted')?heading.nextElementSibling:null; const details=document.createElement('details'); details.className=card.className+' disclosure'; details.style.cssText=card.style.cssText; const summary=document.createElement('summary'); summary.innerHTML=`<div><span>${esc(heading.textContent)}</span>${subtitle?`<small>${esc(subtitle.textContent)}</small>`:''}</div>`; const body=document.createElement('div'); body.className='disclosure-body'; [...card.children].forEach(child=>{ if(child!==heading&&child!==subtitle)body.appendChild(child); }); details.append(summary,body); card.replaceWith(details); }); }
async function load(){
  setStatus('','verbinde …');
  try{
    [state.status,state.approvals,state.runs,state.audit,state.automations,state.automationRuns,state.reports]=await Promise.all([api('/api/control/status'),api('/api/control/approvals?status=pending&limit=30'),api('/api/control/runs?limit=30'),api('/api/control/audit?limit=30'),api('/api/automations'),api('/api/automations/runs?limit=50'),api('/api/automation-reports?limit=12')]);
    render(); setStatus('on','aktuell · '+fmt(state.status.generatedAt));
  }catch(error){ setStatus('err',error.message); if(error.message.includes('401')) $('token').focus(); }
}
$('token').value=token();
$('saveToken').addEventListener('click',()=>{ localStorage.setItem(TOKEN_KEY,$('token').value.trim()); load(); });
$('refresh').addEventListener('click',load);
$('ivaHelper').addEventListener('click',()=>location.href='/cockpit');
makeCollapsible();
load();
