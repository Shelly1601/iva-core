import {createInstagramConnector} from '../integrations/instagram.js';
import {projectContext} from '../core/project-scope.js';
import {toolRoutingStatus,describeIvaTool} from '../core/tool-routing.js';

// These routes are registered after the application's existing /api auth guard.
export function registerProjectTeamRoutes(app,{getProject,connections,runner,toolMap,getAgent,beginAgentRun,finishAgentRun}) {
  const project=async id=>{if(typeof id!=='string'||!/^[a-zA-Z0-9:_-]{1,100}$/.test(id))throw Object.assign(new Error('Ungültiges Projekt.'),{status:400});const value=await getProject(id);if(!value)throw Object.assign(new Error('Projekt nicht gefunden.'),{status:404});return value;};
  const failure=(res,error)=>res.status(error.status||400).json({error:error.message||'Auftrag fehlgeschlagen.'});
  const roster=async projectId=>{
    const {all,env}=await toolMap(getAgent('iva-standard'),{projectId,allowDelegation:false});
    const readTools=Object.entries(all).filter(([name,value])=>{const meta=describeIvaTool(name,value,{env});return meta.readOnly&&meta.connection.state!=='missing-connection';}).map(([name])=>name);
    const runtime=runner.status({projectId});
    return {...runtime,agents:runtime.agents.map(agent=>({...agent,id:agent.agentId,availableReadTools:readTools.length,readToolNames:readTools})),connections:projectId?await connections.list(projectId):undefined};
  };
  app.get('/api/agents/runtime',async(_req,res)=>{try{res.json(await roster(''));}catch(error){failure(res,error);}});
  app.get('/api/tools/status',async(req,res)=>{try{
    const projectId=req.query.projectId||'';if(projectId)await project(projectId);
    const {all,env}=await toolMap(getAgent('iva-standard'),{projectId,allowDelegation:false});
    res.json({projectId,...toolRoutingStatus(all,{env})});
  }catch(error){failure(res,error);}});
  app.get('/api/projects/:id/team',async(req,res)=>{try{await project(req.params.id);res.json(await roster(req.params.id));}catch(error){failure(res,error);}});
  app.get('/api/projects/:id/connections',async(req,res)=>{try{await project(req.params.id);res.json(await connections.list(req.params.id));}catch(error){failure(res,error);}});
  app.put('/api/projects/:id/connections/:provider',async(req,res)=>{try{
    await project(req.params.id);res.json(await connections.save(req.params.id,req.params.provider,req.body||{}));
  }catch(error){failure(res,error);}});
  app.delete('/api/projects/:id/connections/:provider',async(req,res)=>{try{
    await project(req.params.id);res.json(await connections.remove(req.params.id,req.params.provider));
  }catch(error){failure(res,error);}});
  app.post('/api/projects/:id/connections/:provider/verify',async(req,res)=>{try{
    await project(req.params.id);
    if(req.params.provider!=='instagram')throw new Error('Für diesen Anbieter ist noch kein Verbindungstest eingerichtet.');
    const before=await connections.list(req.params.id);
    const item=before.items.find(row=>row.provider==='instagram');
    if(!item)throw new Error('Bitte zuerst die Instagram-Anbindung in diesem Projekt speichern.');
    const env=await connections.resolveEnv(req.params.id);
    const result=await createInstagramConnector({env,timeoutMs:15000}).listOwnInstagramMedia({limit:1});
    const saved=await connections.recordVerification(req.params.id,'instagram',{expectedRevision:item.revision,ok:result.ok===true,error:result.ok?'':result.error||'Verbindungsprüfung fehlgeschlagen.'});
    if(saved?.code==='stale_revision')return res.status(409).json({ok:false,error:'Der Zugang wurde zwischenzeitlich geändert. Bitte erneut prüfen.'});
    res.json({ok:result.ok===true,connection:saved,error:result.ok?undefined:result.error,checkedCapabilities:result.ok?['account_identity','own_media']:[],notice:'Dieser Test belegt Kontozuordnung und Medienzugriff. Kommentarrechte werden beim ersten Kommentarabruf geprüft.'});
  }catch(error){failure(res,error);}});
  const delegate=async(req,res)=>{
    const projectId=req.params.id||req.body?.projectId||'';
    let parent;
    try {
      const p=projectId?await project(projectId):null;
      const tasks=req.body?.tasks;
      if(!Array.isArray(tasks)||tasks.length<1||tasks.length>3)throw new Error('Bitte einen bis drei Fachaufträge angeben.');
      const context=`${p?projectContext(p):''}\n${String(req.body?.context||'').slice(0,3500)}`;
      const aborter=new AbortController();req.on('aborted',()=>aborter.abort());res.on('close',()=>{if(!res.writableEnded)aborter.abort();});
      parent=await beginAgentRun({agentId:'iva-standard',agentName:'IVA · Teamkoordination',channel:'team',sessionId:`project-team:${projectId||'global'}`,routeReason:`Teamauftrag${projectId?` project:${projectId}`:''}`,requestPreview:tasks.map(task=>String(task?.task||'')).join(' | ').slice(0,500)});
      const result=await runner.run({tasks,context,projectId,parentRunId:parent.id,abortSignal:aborter.signal});
      await finishAgentRun(parent.id,{status:result.status==='completed'?'completed':result.status==='aborted'?'stopped':'failed',tools:[...new Set(result.results.flatMap(row=>row.toolNames||[]))],resultPreview:result.status});
      if(!res.destroyed)res.json({...result,parentRunId:parent.id,projectId});
    }catch(error){if(parent)await finishAgentRun(parent.id,{status:'failed',error:'Teamauftrag fehlgeschlagen.'}).catch(()=>{});if(!res.destroyed)failure(res,error);}
  };
  app.post('/api/agents/delegate',delegate);
  app.post('/api/projects/:id/agents/run',delegate);
}
