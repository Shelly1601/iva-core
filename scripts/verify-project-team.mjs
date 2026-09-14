import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {registerProjectTeamRoutes} from '../projects/team.js';
import fs from 'node:fs/promises';
function fixture() {
  const handlers=new Map(), app={};for(const method of ['get','post','put','delete'])app[method]=(path,fn)=>handlers.set(`${method} ${path}`,fn);
  const calls=[],saved=[];
  const dependencies={
    getProject:async id=>id==='alpha'?{id,name:'Alpha',description:'Alpha project'}:null,
    connections:{list:async id=>({encryptionReady:true,items:[]}),save:async(...args)=>{saved.push(args);return {provider:args[1],hasToken:true};},remove:async(id,provider)=>({ok:true,id,provider})},
    getAgent:id=>({id}),toolMap:async(_agent,opts)=>{calls.push(opts);return {all:{},env:{SECRET:'do-not-output'}};},
    runner:{status:({projectId})=>({projectId,agents:[{agentId:'iva-marketing',enabled:true}]}),run:async input=>{calls.push(input);return {status:'completed',results:[{status:'completed',toolNames:['getCurrentProject']}]};}},
    beginAgentRun:async input=>{calls.push(input);return{id:'parent1'};},finishAgentRun:async(...args)=>calls.push(args),
  };
  registerProjectTeamRoutes(app,dependencies);
  const invoke=async(method,path,{id,provider,body={},query={}}={})=>{
    const req=Object.assign(new EventEmitter(),{params:{id,provider},body,query});
    const res=Object.assign(new EventEmitter(),{code:200,writableEnded:false,status(code){this.code=code;return this;},json(value){this.value=value;this.writableEnded=true;return this;}});
    await handlers.get(`${method} ${path}`)(req,res);return res;
  };return{invoke,calls,saved};
}
test('new project inherits real roster but no other project connection',async()=>{
  const f=fixture(),res=await f.invoke('get','/api/projects/:id/team',{id:'alpha'});
  assert.equal(res.code,200);assert.equal(res.value.agents[0].id,'iva-marketing');assert.deepEqual(res.value.connections.items,[]);assert(!JSON.stringify(res.value).includes('do-not-output'));assert.equal(f.calls[0].projectId,'alpha');
});
test('unknown projects cannot configure or execute accounts',async()=>{
  const f=fixture();for(const [method,path] of [['put','/api/projects/:id/connections/:provider'],['post','/api/projects/:id/agents/run'],['get','/api/projects/:id/team']]){const res=await f.invoke(method,path,{id:'other',provider:'instagram'});assert.equal(res.code,404);}assert.equal(f.saved.length,0);assert.equal(f.calls.length,0);
});
test('project URL wins over attempted project switch and tracks true tools',async()=>{
  const f=fixture(),res=await f.invoke('post','/api/projects/:id/agents/run',{id:'alpha',body:{projectId:'other',tasks:[{agentId:'iva-marketing',task:'Read current project'}]}});
  assert.equal(res.code,200);const run=f.calls.find(item=>item.tasks);assert.equal(run.projectId,'alpha');assert.equal(run.parentRunId,'parent1');assert.match(run.context,/Alpha/);assert.deepEqual(f.calls.at(-1)[1].tools,['getCurrentProject']);
});
test('server integration registers protected routes and namespaces both chat paths',async()=>{
  const source=await fs.readFile(new URL('../index.js',import.meta.url),'utf8');
  const auth=source.indexOf("app.use('/api'");const registration=source.indexOf('registerProjectTeamRoutes(app,');assert(auth>0&&registration>auth);
  assert.equal((source.match(/const scoped=await chatProject\(projectId,sessionId\)/g)||[]).length,2);
  assert.equal((source.match(/const personalKnowledge = projectId \? '' :/g)||[]).length,2);
  assert.match(source,/await askIva\(.*req.body\?\.projectId/);
  assert.match(source,/await streamIva\(.*req.body\?\.projectId/);
  assert.match(source,/const agentTools = await assembleTools/);
});
