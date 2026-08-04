const $ = id => document.getElementById(id);
const TOKEN_KEY = 'iva_token';
const state = { status:null, approvals:[], runs:[], audit:[] };
function token(){ return localStorage.getItem(TOKEN_KEY) || ''; }
function esc(value){ return String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }
function fmt(value){ if(!value)return '–'; try{return new Date(value).toLocaleString('de-DE',{dateStyle:'short',timeStyle:'short'});}catch{return value;} }
function duration(ms){ if(!Number.isFinite(Number(ms)))return '–'; return Number(ms)<1000?Math.round(ms)+' ms':(Number(ms)/1000).toFixed(1).replace('.',',')+' s'; }
function setStatus(kind,text){ $('status').className='status'+(kind?' '+kind:''); $('status').querySelector('span').textContent=text; }
async function api(path){ const response=await fetch(path,{headers:{Authorization:'Bearer '+token()}}); const payload=await response.json().catch(()=>({})); if(!response.ok)throw new Error(payload.error||'HTTP '+response.status); return payload; }
function empty(text){ return `<div class="empty">${esc(text)}</div>`; }

function renderMetrics(){
  const s=state.status||{}, agents=s.agents||[], ops=s.operations||{}, connectors=s.connectors||{};
  const values=[
    [agents.filter(a=>a.enabled).length,'aktive Agenten','good'],
    [agents.filter(a=>!a.enabled).length,'bewusst gesperrt',''],
    [`${connectors.ready||0} / ${connectors.total||0}`,'Anbindungen bereit',(connectors.ready||0)===(connectors.total||0)?'good':'warn'],
    [ops.approvals?.pending||0,'offene Freigaben',ops.approvals?.pending?'warn':'good'],
    [ops.runs?.failed||0,'fehlgeschlagene Läufe',ops.runs?.failed?'bad':'good'],
  ];
  $('metrics').innerHTML=values.map(([value,label,kind])=>`<div class="metric ${kind}"><b>${esc(value)}</b><small>${esc(label)}</small></div>`).join('');
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
function render(){ renderMetrics(); renderAgents(); renderConnectors(); renderApprovals(); renderRuns(); renderBacklog(); renderAudit(); }
async function load(){
  setStatus('','verbinde …');
  try{
    [state.status,state.approvals,state.runs,state.audit]=await Promise.all([api('/api/control/status'),api('/api/control/approvals?status=pending&limit=30'),api('/api/control/runs?limit=30'),api('/api/control/audit?limit=30')]);
    render(); setStatus('on','aktuell · '+fmt(state.status.generatedAt));
  }catch(error){ setStatus('err',error.message); if(error.message.includes('401')) $('token').focus(); }
}
$('token').value=token();
$('saveToken').addEventListener('click',()=>{ localStorage.setItem(TOKEN_KEY,$('token').value.trim()); load(); });
$('refresh').addEventListener('click',load);
$('ivaHelper').addEventListener('click',()=>location.href='/cockpit');
load();
