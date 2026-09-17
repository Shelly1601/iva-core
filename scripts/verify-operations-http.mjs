import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHmac} from 'node:crypto';

test('full server connects operations behind owner/module gates and accepts only signed Meta webhooks',async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'iva-operations-http-'));
 const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const token='synthetic-owner-token-for-isolated-tests',secret='synthetic-meta-signing-secret',verify='synthetic-challenge-token',base='http://127.0.0.1:'+port;
 const preload=path.join(dataDir,'no-external-network.mjs');await fs.writeFile(preload,`const original=globalThis.fetch;globalThis.fetch=(input,options)=>{const url=new URL(typeof input==='string'?input:input.url||input);if(!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('External access disabled in isolated operations test');return original(input,options);};`);
 const child=spawn(process.execPath,['--import',preload,'index.js'],{cwd:new URL('..',import.meta.url).pathname,env:{PATH:process.env.PATH,HOME:process.env.HOME,DATA_DIR:dataDir,PORT:String(port),DOTENV_CONFIG_PATH:'/dev/null',API_TOKEN:token,IVA_CORE_ORIGIN:base,WHATSAPP_APP_SECRET:secret,WHATSAPP_VERIFY_TOKEN:verify},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',v=>logs+=v);child.stderr.on('data',v=>logs+=v);
 const request=async(route,{method='GET',body,auth=true,headers={},raw}={})=>{const r=await fetch(base+route,{method,headers:{'content-type':'application/json',...(auth?{authorization:'Bearer '+token}:{}),...headers},body:raw??(body===undefined?undefined:JSON.stringify(body))});let data=await r.text();try{data=JSON.parse(data);}catch{}return{status:r.status,data};};
 const ok=async(route,options)=>{const result=await request(route,options);assert.ok(result.status>=200&&result.status<300,route+' '+result.status+' '+JSON.stringify(result.data));return result.data;};
 try{
  let ready=false;for(let n=0;n<300;n++){if(child.exitCode!==null)throw Error(logs);if(logs.includes('IVA-Core auf Port')){ready=true;break;}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,logs);
  const project=await ok('/api/projects',{method:'POST',body:{name:'Operations fixture'}}),pid=project.id;
  for(const endpoint of ['/api/advice/workbench/catalog','/api/sales-coach/context','/api/tax-preparation/context','/api/prospecting/context','/api/whatsapp/automation/config']){
   assert.equal((await request(endpoint+'?projectId='+pid,{auth:false})).status,401);await ok(endpoint+'?projectId='+pid);
  }
  const tooLarge=await request('/api/advice/workbench/cases/missing/documents?projectId='+pid,{method:'POST',body:{payload:'x'.repeat(2_400_000)}});assert.equal(tooLarge.data.code,'ADVICE_INVALID','bounded larger body reaches document validator');
  assert.equal((await request('/webhooks/whatsapp',{method:'POST',body:{entry:[]},auth:false})).status,401);
  const raw=JSON.stringify({object:'whatsapp_business_account',entry:[]}),signature='sha256='+createHmac('sha256',secret).update(raw).digest('hex');
  assert.equal((await request('/webhooks/whatsapp',{method:'POST',raw,headers:{'x-hub-signature-256':signature},auth:false})).status,200);
  assert.equal((await request('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token='+verify+'&hub.challenge=fixture-challenge',{auth:false})).data,'fixture-challenge');
  const config=await ok('/api/projects/'+pid+'/access');await ok('/api/projects/'+pid+'/access',{method:'POST',body:{...config,modules:[]}});
  for(const endpoint of ['/api/advice/workbench/catalog','/api/sales-coach/context','/api/tax-preparation/context','/api/prospecting/context'])assert.equal((await request(endpoint+'?projectId='+pid)).status,403,endpoint+' module disabled');
  assert.equal((await request('/api/advice/workbench/context?projectId=missing-project')).status,404);
 }finally{child.kill('SIGTERM');if(child.exitCode===null)await once(child,'exit');await fs.rm(dataDir,{recursive:true,force:true});}
});
