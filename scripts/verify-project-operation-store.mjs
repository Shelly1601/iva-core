import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createProjectStore } from '../operations/project-store.js';
const moduleUrl = new URL('../operations/project-store.js', import.meta.url).href;
async function fixture(t) {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'iva-project-store-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const store=createProjectStore({dataDir,name:'test-store',getProject:async id=>id==='p1',initial:()=>({count:0})});
  await store.read('p1');return {store,dataDir,lock:path.join(dataDir,'test-store/p1.json.lock')};
}
function worker(dataDir,iterations){
  return new Promise((resolve,reject)=>{
    const code=`import {createProjectStore} from ${JSON.stringify(moduleUrl)};
      const store=createProjectStore({dataDir:${JSON.stringify(dataDir)},name:'test-store',getProject:async()=>true,initial:()=>({count:0})});
      for(let i=0;i<${iterations};i++) {let done=false;for(let retry=0;retry<1000;retry++){try{await store.mutate('p1',async state=>{const count=state.count;await new Promise(r=>setTimeout(r,3));state.count=count+1;});done=true;break;}catch(e){if(e.status!==409)throw e;await new Promise(r=>setTimeout(r,2+Math.random()*7));}}if(!done)throw new Error('claim never acquired');}`;
    const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});let output='';child.stderr.on('data',d=>output+=d);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(output||`worker exit ${code}`)));
  });
}
test('multiple processes recover one stale claim and preserve every committed update',async t=>{
  const f=await fixture(t);await fs.writeFile(f.lock,JSON.stringify({pid:99999999,nonce:'dead-claim'}));
  await Promise.all(Array.from({length:5},()=>worker(f.dataDir,12)));assert.equal((await f.store.read('p1')).count,60);await assert.rejects(fs.stat(f.lock),{code:'ENOENT'});
});
test('live owner and an in-progress recovery claim are not removed',async t=>{
  const f=await fixture(t), live={pid:process.pid,nonce:'live-claim'};await fs.writeFile(f.lock,JSON.stringify(live));
  await assert.rejects(f.store.mutate('p1',s=>s.count++),{status:409});assert.deepEqual(JSON.parse(await fs.readFile(f.lock)),live);
  await fs.writeFile(f.lock,JSON.stringify({pid:99999999,nonce:'dead'}));await fs.mkdir(f.lock+'.recovery');
  await assert.rejects(f.store.mutate('p1',s=>s.count++),{status:409});assert.equal(JSON.parse(await fs.readFile(f.lock)).nonce,'dead');
});
test('finally releases only the owned claim; errors preserve prior state and normal retry works',async t=>{
  const f=await fixture(t);await assert.rejects(f.store.mutate('p1',s=>{s.count=10;throw new Error('abort');}),/abort/);assert.equal((await f.store.read('p1')).count,0);
  await f.store.mutate('p1',async s=>{s.count=1;await fs.writeFile(f.lock,JSON.stringify({pid:process.pid,nonce:'replacement'}));});
  assert.equal(JSON.parse(await fs.readFile(f.lock)).nonce,'replacement');await fs.unlink(f.lock);
  await f.store.mutate('p1',s=>s.count++);assert.equal((await f.store.read('p1')).count,2);
});
test('project isolation and corrupt files fail closed without overwriting',async t=>{
  const f=await fixture(t);await assert.rejects(f.store.read('other'),{status:404});const file=f.lock.slice(0,-5);await fs.writeFile(file,'invalid');await assert.rejects(f.store.mutate('p1',s=>s.count++),{status:503});assert.equal(await fs.readFile(file,'utf8'),'invalid');
});
