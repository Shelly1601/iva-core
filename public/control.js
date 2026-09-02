const $ = id => document.getElementById(id);
const TOKEN_KEY = 'iva_token';
const state = { status:null, approvals:[], runs:[], audit:[], automations:[], projectWorkflows:[], reports:[], deviceAgent:null, loading:false };
function token(){ return localStorage.getItem(TOKEN_KEY) || ''; }
function esc(value){ return String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }
function fmt(value){ if(!value)return '–'; try{return new Date(value).toLocaleString('de-DE',{dateStyle:'short',timeStyle:'short'});}catch{return value;} }
function duration(ms){ if(!Number.isFinite(Number(ms)))return '–'; return Number(ms)<1000?Math.round(ms)+' ms':(Number(ms)/1000).toFixed(1).replace('.',',')+' s'; }
function setStatus(kind,text){ $('status').className='status'+(kind?' '+kind:''); $('status').querySelector('span').textContent=text; }
async function api(path,options={}){ const response=await fetch(path,{...options,headers:{Authorization:'Bearer '+token(),...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})},body:options.body?JSON.stringify(options.body):undefined}); const payload=await response.json().catch(()=>({})); if(!response.ok)throw new Error(payload.error||'HTTP '+response.status); return payload; }
function empty(text){ return `<div class="empty">${esc(text)}</div>`; }

function workflowCard(item){
  const kind=item.group==='running'?'live':item.group==='done'?'ready':item.group==='waiting'?'off':'';
  const hasProgress=item.progress!=null&&item.progress!==''&&Number.isFinite(Number(item.progress));
  const progress=hasProgress?Math.max(0,Math.min(100,Number(item.progress))):null;
  const progressView=hasProgress
    ? `<div class="workflow-progress-label"><span>Echter Fortschritt</span><b>${esc(progress)} %</b></div><div class="progress-track" role="progressbar" aria-label="${esc(item.title)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${esc(progress)}"><div class="progress-fill${item.group==='blocked'?' blocked':''}" style="width:${progress}%"></div></div>`
    : '<div class="workflow-progress-label"><span>Fortschritt</span><b>von Quelle nicht gemeldet</b></div>';
  const blocker=item.group==='blocked'?`<div class="workflow-blocker"><b>Konkreter Blocker:</b> ${esc(item.blocker||'Der Lauf ist ausdrücklich als blockiert gemeldet, aber ohne weiteren Grund.')}</div>`:'';
  const stale=item.stale?'<div class="workflow-stale">Nicht mehr als aktiv gezählt: Seit über fünf Minuten fehlt ein echtes Update.</div>':'';
  const technical=item.technicalReview?'<div class="workflow-stale">Technischer Zwischenfehler – fachlich nicht automatisch als blockiert gewertet.</div>':'';
  return `<article class="workflow-card"><div class="workflow-card-head"><div><h4>${esc(item.title)}</h4><div class="workflow-source">${esc(item.source)}</div></div><span class="badge ${kind}">${esc(item.label)}</span></div><div class="workflow-purpose">${esc(item.purpose)}</div><div class="workflow-facts"><span>Phase</span><b>${esc(item.phase)}</b><span>Letztes Update</span><b>${fmt(item.updatedAt)}</b><span>Detail</span><b>${esc(item.detail)}</b></div>${progressView}${blocker}${stale}${technical}</article>`;
}
function renderWorkflowDashboard(){
  const dashboard=window.IVAWorkflowDashboard?.buildWorkflowDashboard(state.status||{})||{running:[],waiting:[],blocked:[],done:[],counts:{running:0,waiting:0,blocked:0,done:0}};
  $('workflowCountRunning').textContent=dashboard.counts.running;
  $('workflowCountWaiting').textContent=dashboard.counts.waiting;
  $('workflowCountBlocked').textContent=dashboard.counts.blocked;
  $('workflowCountDone').textContent=dashboard.counts.done;
  const renderGroup=(id,items,label,limit)=>{ $(id).innerHTML=items.length?items.slice(0,limit).map(workflowCard).join(''):`<div class="workflow-empty">${esc(label)}</div>`; };
  renderGroup('workflowRunning',dashboard.running,'Gerade läuft kein belegter Workflow.',8);
  renderGroup('workflowWaiting',dashboard.waiting,'Keine wartenden oder technisch zu prüfenden Läufe.',8);
  renderGroup('workflowBlocked',dashboard.blocked,'Kein fachlicher Blocker gemeldet.',8);
  renderGroup('workflowDone',dashboard.done,'Noch kein erledigter Lauf erfasst.',5);
}

function buildTaskCard(item){
  const blocked=item.status==='blocked';
  const steps=(item.steps||[]).map(step=>`<div class="milestone ${esc(step.state)}" title="${esc(step.label)}"><i></i><span>${esc(step.label)}</span></div>`).join('');
  return `<article class="build-task"><div class="build-title"><div><h3>${esc(item.title)}</h3><p>${esc(item.phaseLabel)} · ${esc(item.status==='running'?'läuft':item.status==='queued'?'wartet':item.status==='blocked'?'blockiert':'fertig')}</p></div><div class="build-percent">${esc(item.progress||0)} %</div></div><div class="progress-track" role="progressbar" aria-label="${esc(item.title)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${esc(item.progress||0)}"><div class="progress-fill${blocked?' blocked':''}" style="width:${Math.max(0,Math.min(100,Number(item.progress)||0))}%"></div></div><div class="milestones">${steps}</div><div class="build-detail${blocked?' error':''}">${esc(item.blocker||item.detail||'')}</div><div class="meta">Aktualisiert: ${fmt(item.updatedAt)}</div></article>`;
}
function miniBuild(item,{blocked=false}={}){
  return `<div class="mini-build-row${blocked?' blocked':''}"><b>${esc(item.title)}</b><small>${esc(blocked?(item.blocker||item.detail):(item.phaseLabel+' · '+(item.progress||0)+' %'))}</small><small>${fmt(item.updatedAt||item.createdAt)}</small></div>`;
}
function renderBuildProgress(){
  const build=state.status?.buildProgress||{};
  const active=build.active||[];
  $('currentBuilds').innerHTML=active.length
    ? active.map(buildTaskCard).join('')
    : `<div class="build-task"><div class="build-title"><div><h3>Aktuell läuft kein Bauauftrag</h3><p>${(build.queued||[]).length?'Der nächste Auftrag wartet bereits in der Warteschlange.':'IVA ist bereit für den nächsten Auftrag.'}</p></div><div class="build-percent">0 %</div></div><div class="progress-track"><div class="progress-fill" style="width:0%"></div></div></div>`;
  $('buildQueue').innerHTML=(build.queued||[]).length?(build.queued||[]).slice(0,5).map(item=>miniBuild(item)).join(''):'<div class="muted">Keine wartenden Aufträge.</div>';
  $('buildBlocked').innerHTML=(build.blocked||[]).length?(build.blocked||[]).slice(0,5).map(item=>miniBuild(item,{blocked:true})).join(''):'<div class="muted">Keine Blocker.</div>';
  const latest=build.latestImplementation;
  if(!latest){ $('latestImplementation').innerHTML='<div class="muted">Noch keine abgeschlossene Umsetzung erfasst.</div>'; return; }
  const git=latest.gitCommit?`<span>Git ${esc(latest.gitCommit.slice(0,8))}</span>`:'';
  const live=latest.liveStatus==='live'?'<span class="live">● live</span>':'';
  const link=latest.livePath?`<a href="${esc(latest.livePath)}">öffnen</a>`:'';
  $('latestImplementation').innerHTML=`<div class="mini-build-row"><b>${esc(latest.title)}</b><small>${esc(latest.description||latest.detail||'')}</small><small>${fmt(latest.completedAt||latest.updatedAt)}</small><div class="release-meta">${live}${git}${link}</div></div>`;
}

function renderMetrics(){
  const s=state.status||{}, ops=s.operations||{}, connectors=s.connectors||{}, automations=s.automations||{}, incidents=s.incidents||{};
  const values=[
    [automations.enabled||0,'Automationen an','good'],
    [automations.failedToday||0,'Workflow-Fehler heute',automations.failedToday?'bad':'good'],
    [`${connectors.ready||0} / ${connectors.total||0}`,'Anbindungen bereit',(connectors.ready||0)===(connectors.total||0)?'good':'warn'],
    [ops.approvals?.pending||0,'offene Freigaben',ops.approvals?.pending?'warn':'good'],
    [ops.runs?.failed||0,'fehlgeschlagene Läufe',ops.runs?.failed?'bad':'good'],
    [incidents.preventedCount||0,'Wiederholungen vermieden','good'],
  ];
  $('metrics').innerHTML=values.map(([value,label,kind])=>`<div class="metric ${kind}"><b>${esc(value)}</b><small>${esc(label)}</small></div>`).join('');
}
function renderIncidents(){
  const memory=state.status?.incidents||{};
  $('incidentSummary').innerHTML=[
    `<span class="good">${esc(memory.resolved||0)} gelöste Ursachen</span>`,
    `<span class="warn">${esc(memory.open||0)} offen</span>`,
    `<span>${esc(memory.recurring||0)} wiederkehrend</span>`,
    `<span class="good">${esc(memory.preventedCount||0)} Wiederholungen vermieden</span>`,
  ].join('');
  const items=memory.items||[];
  $('incidents').innerHTML=items.length?items.slice(0,12).map(item=>`<article class="list-item incident-item ${item.status==='resolved'?'resolved':'open'}"><div class="list-head"><div><b>${esc(item.workflowId||item.action||item.system||'Technische Störung')}</b><div class="activity-source">${esc(item.system||'iva')} · ${esc(item.step||item.action||'Lauf')}</div></div><span class="badge ${item.status==='resolved'?'ready':''}">${item.status==='resolved'?'gelöst':'offen'} · ${esc(item.occurrences||1)}×</span></div><p>${esc(item.error||'Störung protokolliert.')}</p>${item.prevention?`<div class="incident-fix">Prävention: ${esc(item.prevention)}</div>`:''}${item.evidence?`<div class="incident-proof">✓ ${esc(item.evidence)}</div>`:''}<div class="meta">Zuletzt: ${fmt(item.lastSeenAt)} · eingesetzt ${esc(item.preventionUses||0)}× · vermieden ${esc(item.preventedCount||0)}×</div></article>`).join(''):empty('Noch keine technische Störung protokolliert.');
}
function automationStatus(item){ const run=item.lastRun; if(!run)return ['noch kein Lauf','off']; if(run.status==='completed')return ['zuletzt erfolgreich','ready']; if(run.status==='waiting')return ['läuft · wartet auf Endnachweis','ready']; if(run.status==='failed')return ['zuletzt Fehler','']; if(run.status==='blocked')return ['blockiert','']; return [run.status,'off']; }
function statusView(status){
  const value=String(status||'recorded').toLowerCase();
  if(value==='completed'||value==='successful'||value==='sent-and-verified')return ['erfolgreich','ready'];
  if(value==='running')return ['läuft','live'];
  if(value==='queued')return ['wartet','off'];
  if(value==='blocked')return ['blockiert',''];
  if(value==='skipped')return ['übersprungen','off'];
  if(['failed','timed_out','incomplete'].includes(value))return ['Fehler',''];
  return [value,'off'];
}
function workflowResult(item){
  const run=item.lastRun;
  if(!run)return '<div class="workflow-result empty-result"><b>Noch kein belegter Lauf</b><span>Sobald der Workflow läuft, erscheinen Zeitpunkt, Status und Ergebnis automatisch hier.</span></div>';
  const [label,kind]=statusView(run.status);
  const evidence=(run.proofs||[]).length?`<div class="proofs">${run.proofs.map(value=>`<span>✓ ${esc(value)}</span>`).join('')}</div>`:'';
  const success=item.lastSuccessfulRun;
  const successEvidence=(success?.proofs||[]).length?`<div class="proofs">${success.proofs.map(value=>`<span>✓ ${esc(value)}</span>`).join('')}</div>`:'';
  const priorSuccess=success&&success.id!==run.id?`<div class="workflow-result verified-result"><div class="list-head"><b>Letzter erfolgreicher Nachweis: ${fmt(success.completedAt||success.updatedAt||success.startedAt)}</b><span class="badge ready">verifiziert</span></div><p>${esc(success.summary||'Erfolgreicher Lauf belegt.')}</p>${successEvidence}</div>`:'';
  return `<div class="workflow-result"><div class="list-head"><b>Letzter Lauf: ${fmt(run.completedAt||run.updatedAt||run.startedAt)}</b><span class="badge ${kind}">${esc(label)}</span></div><p>${esc(run.summary||'Lauf protokolliert.')}</p>${evidence}${run.error?`<div class="error">${esc(run.error)}</div>`:''}</div>${priorSuccess}`;
}
function renderAutomations(){
  const reporting=state.status?.systems?.reporting||{};
  $('projectWorkflows').innerHTML=state.projectWorkflows.length?state.projectWorkflows.map(item=>`<article class="workflow project-workflow"><div><div class="list-head"><h3>${esc(item.name)}</h3><span class="badge ${item.enabled?'ready':'off'}">${item.enabled?'aktiv':esc(item.status)}</span></div><p>${esc(item.purpose)}</p><div class="workflow-meta"><span>${esc(item.projectName)}</span><span>${esc(item.schedule)}</span><span>${esc(item.execution)}</span></div>${workflowResult(item)}</div><a class="workflow-link" href="/projects?id=${encodeURIComponent(item.projectId)}">Projekt öffnen</a></article>`).join(''):empty('Keine Projekt-Workflows registriert.');
  $('automations').innerHTML=state.automations.length?state.automations.map(item=>{ const [label,kind]=automationStatus(item); const run=item.lastRun; return `<article class="workflow"><div><div class="list-head"><h3>${esc(item.name)}</h3><span class="badge ${kind}">${esc(label)}</span></div><p>${esc(item.description)}</p><div class="workflow-meta"><span>${esc(item.category)}</span><span>${esc(item.schedule)}</span>${run?`<span>Letzter Lauf: ${fmt(run.completedAt||run.startedAt)}</span>`:''}</div>${run?`<div class="workflow-result"><p>${esc(run.summary||run.error||'Lauf protokolliert.')}</p>${run.error?`<div class="error">${esc(run.error)}</div>`:''}</div>`:''}</div><label class="switch" title="${item.enabled?'Ausschalten':'Einschalten'}"><input type="checkbox" data-automation="${esc(item.id)}" ${item.enabled?'checked':''}><span class="slider"></span></label></article>`; }).join(''):empty('Keine Automationen registriert.');
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
  $('runs').innerHTML=state.runs.length?state.runs.map(item=>{ const [label,kind]=statusView(item.status); const when=item.completedAt||item.updatedAt||item.startedAt; const evidence=(item.proofs||[]).length?`<div class="proofs">${item.proofs.map(value=>`<span>✓ ${esc(value)}</span>`).join('')}</div>`:''; const progress=Number.isFinite(Number(item.progress))&&item.status==='running'?`<div class="run-progress"><i style="width:${Math.max(0,Math.min(100,Number(item.progress)))}%"></i></div>`:''; return `<article class="list-item activity-item"><div class="list-head"><div><b>${esc(item.name)}</b><div class="activity-source">${esc(item.source)} · ${esc(item.type)}</div></div><span class="badge ${kind}">${esc(label)}</span></div><p>${esc(item.summary||'Lauf protokolliert.')}</p>${progress}${item.phase?`<div class="tools">Phase: ${esc(item.phase)}${Number.isFinite(Number(item.progress))?` · ${esc(item.progress)} %`:''}</div>`:''}${item.tools?.length?`<div class="tools">Werkzeuge: ${item.tools.map(esc).join(' · ')}</div>`:''}${evidence}${item.error?`<div class="error">${esc(item.error)}</div>`:''}<div class="meta">${fmt(when)}${item.startedAt&&item.completedAt?` · Start ${fmt(item.startedAt)} · Ende ${fmt(item.completedAt)}`:''}${item.durationMs!=null?` · ${duration(item.durationMs)}`:''}</div></article>`; }).join(''):empty('Noch keine echten Läufe oder Befehle protokolliert.');
}
function renderBacklog(){
  const items=state.status?.buildBacklog||[];
  $('backlog').innerHTML=items.length?items.slice(0,8).map(item=>`<article class="list-item"><div class="list-head"><b>${esc(item.title||item.request||'Bauauftrag')}</b><span class="badge">${esc(item.status||'erfasst')}</span></div><p>${esc(item.request||item.description||'')}</p><div class="meta">${fmt(item.updatedAt||item.createdAt)}</div></article>`).join(''):empty('Keine offene Bauanforderung.');
}
function renderAudit(){
  $('audit').innerHTML=state.audit.length?state.audit.slice(0,8).map(item=>`<article class="list-item"><div class="list-head"><b>${esc(item.action)}</b><span class="badge ${item.status==='completed'?'ready':''}">${esc(item.status)}</span></div><p>${esc(item.detail||item.target||'')}</p><div class="meta">${fmt(item.createdAt)} · ${esc(item.actor)}</div></article>`).join(''):empty('Noch keine Audit-Ereignisse.');
}
function renderImacStatus(){
  const agent=state.deviceAgent||{};
  const label=!agent.online?'iMac nicht verbunden':agent.uiBusy?'iMac arbeitet – weitere Aufträge warten':agent.dispatchReady?'iMac bereit':'iMac verbunden – Befehlsabholung wird geprüft';
  const el=$('imacStatus');
  if(el)el.innerHTML=`<b>${esc(label)}</b><div class="meta">Handy · MacBook · Telegram → IVA-Core → iMac · ${esc(agent.release||'Version unbekannt')}${agent.runtimeRevision?' · '+esc(agent.runtimeRevision.slice(0,12)):''}</div><div class="meta">${esc(agent.detail||'')} · Letzter Abruf: ${fmt(agent.lastPolledAt)}</div>`;
}
function render(){ renderImacStatus(); renderWorkflowDashboard(); renderBuildProgress(); renderMetrics(); renderIncidents(); renderAutomations(); renderAgents(); renderConnectors(); renderApprovals(); renderRuns(); renderBacklog(); renderAudit(); }
function makeCollapsible(){ document.querySelectorAll('.main>section.card,.main>section.grid>.card').forEach(card=>{ const heading=card.querySelector(':scope>h2'); if(!heading)return; const subtitle=heading.nextElementSibling?.classList?.contains('muted')?heading.nextElementSibling:null; const details=document.createElement('details'); details.className=card.className+' disclosure'; details.style.cssText=card.style.cssText; const summary=document.createElement('summary'); summary.innerHTML=`<div><span>${esc(heading.textContent)}</span>${subtitle?`<small>${esc(subtitle.textContent)}</small>`:''}</div>`; const body=document.createElement('div'); body.className='disclosure-body'; [...card.children].forEach(child=>{ if(child!==heading&&child!==subtitle)body.appendChild(child); }); details.append(summary,body); card.replaceWith(details); }); }
async function load(){
  if(state.loading)return;
  state.loading=true;
  setStatus('','verbinde …');
  try{
    [state.status,state.approvals,state.audit,state.automations,state.reports,state.deviceAgent]=await Promise.all([api('/api/control/status'),api('/api/control/approvals?status=pending&limit=30'),api('/api/control/audit?limit=30'),api('/api/automations'),api('/api/automation-reports?limit=12'),api('/api/device-agent/status')]);
    state.runs=state.status.activity||[];
    state.projectWorkflows=state.status.projectWorkflows||[];
    render(); setStatus('on','aktuell · '+fmt(state.status.generatedAt));
  }catch(error){ setStatus('err',error.message); if(error.message.includes('401')) $('token').focus(); }
  finally{ state.loading=false; }
}
$('token').value=token();
if(window.matchMedia('(max-width:800px)').matches)$('connectionCard').removeAttribute('open');
$('saveToken').addEventListener('click',()=>{ localStorage.setItem(TOKEN_KEY,$('token').value.trim()); load(); });
$('refresh').addEventListener('click',load);
$('ivaHelper').addEventListener('click',()=>location.href='/cockpit');
makeCollapsible();
load();
setInterval(()=>{ if(document.visibilityState==='visible')load(); },10000);
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible')load(); });
