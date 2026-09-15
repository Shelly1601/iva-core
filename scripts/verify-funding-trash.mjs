import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { emptyDailyTrash, buildDailyTrashLaunchAgent, installDailyTrash, FUNDING_TRASH_LABEL } from '../local-mac-helper/funding-trash.mjs';

async function fixture(t) {const directory=await mkdtemp(path.join(os.tmpdir(),'iva-trash-fixture-'));t.after(()=>rm(directory,{recursive:true,force:true}));return path.join(directory,'daily-trash.json');}
const at=()=>new Date('2026-09-15T22:30:00Z');

test('schedule uses stable current-runtime entry point, safe node arguments and no immediate trigger',()=>{
  const standard=buildDailyTrashLaunchAgent();
  assert.match(standard,/\/runtime\/central\/current\/local-mac-helper\/funding-trash\.mjs<\/string>/);
  assert.match(standard,/<key>Hour<\/key><integer>0<\/integer>/);assert.match(standard,/<key>Minute<\/key><integer>30<\/integer>/);
  assert.doesNotMatch(standard,/RunAtLoad|StartInterval|KeepAlive|kickstart|empty trash/);
  const escaped=buildDailyTrashLaunchAgent({nodePath:'/fixture/A&B/node',helperPath:'/fixture/<current>/trash.mjs'});
  assert.match(escaped,/<string>\/fixture\/A&amp;B\/node<\/string>/);assert.match(escaped,/<string>\/fixture\/&lt;current&gt;\/trash\.mjs<\/string><string>run<\/string>/);
});
test('empty readback is persisted privately and duplicate does not invoke Finder again',async t=>{
  const file=await fixture(t);let calls=0,hostCalls=0;
  const opts={file,now:at(),assertHost:()=>{hostCalls++},execute:async(command,args)=>{calls++;assert.equal(command,'/usr/bin/osascript');assert.match(args[1],/if beforeCount > 0 then empty trash/);assert.match(args[1],/set remainingCount to count items of trash/);return{stdout:'12:0\n'}}};
  const result=await emptyDailyTrash(opts);assert.equal(result.verified,true);assert.equal(result.remainingItems,0);assert.equal(result.day,'2026-09-16');assert.equal(result.removedItems,12);
  const saved=JSON.parse(await readFile(file,'utf8'));assert.deepEqual(saved,result);assert.equal((await stat(file)).mode&0o777,0o600);
  assert.equal((await emptyDailyTrash(opts)).duplicate,true);assert.equal(calls,1);assert.equal(hostCalls,2);
});
test('new Berlin day permits its own scheduled cleanup, not UTC day rollover',async t=>{
  const file=await fixture(t);let calls=0;const execute=async()=>{calls++;return{stdout:'0:0'}};
  const opts={file,assertHost:()=>{},execute};
  await emptyDailyTrash({...opts,now:new Date('2026-09-15T22:30:00Z')});
  assert.equal((await emptyDailyTrash({...opts,now:new Date('2026-09-16T01:00:00Z')})).duplicate,true);
  assert.equal((await emptyDailyTrash({...opts,now:new Date('2026-09-16T22:30:00Z')})).duplicate,undefined);assert.equal(calls,2);
});
test('remaining items, invalid readback and Finder errors never create success receipt',async t=>{
  for(const execute of [async()=>({stdout:'12:1'}),async()=>({stdout:'true'}),async()=>{throw new Error('Fixture Finder unavailable')}]) {
    const file=await fixture(t);await assert.rejects(emptyDailyTrash({file,now:at(),assertHost:()=>{},execute}));await assert.rejects(access(file),{code:'ENOENT'});
  }
});
test('host refusal happens before executing Finder or writing receipt',async t=>{
  const file=await fixture(t);let calls=0;await assert.rejects(emptyDailyTrash({file,now:at(),assertHost:()=>{throw new Error('Fixture wrong host')},execute:async()=>{calls++;return{stdout:'1:0'}}}),/wrong host/);assert.equal(calls,0);await assert.rejects(access(file),{code:'ENOENT'});
});
test('corrupt private status cannot be silently overwritten by another cleanup',async t=>{
  const file=await fixture(t);await writeFile(file,'{invalid');let calls=0;await assert.rejects(emptyDailyTrash({file,now:at(),assertHost:()=>{},execute:async()=>{calls++;return{stdout:'1:0'}}}));assert.equal(calls,0);assert.equal(await readFile(file,'utf8'),'{invalid');
});
test('concurrent daily triggers grant only one Finder operation',async t=>{
  const file=await fixture(t);let calls=0;
  const opts={file,now:at(),assertHost:()=>{},execute:async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,40));return{stdout:'2:0'}}};
  const results=await Promise.all([emptyDailyTrash(opts),emptyDailyTrash(opts),emptyDailyTrash(opts)]);assert.equal(calls,1);assert.equal(results.filter(row=>row.duplicate===true).length,2);
});


async function installer(t,loadedInitially=false) {
  const file=await fixture(t),directory=path.dirname(file),calls=[];let loaded=loadedInitially;
  const options={helperRoot:path.join(directory,'helper'),launchAgentsDir:path.join(directory,'agents'),nodePath:'/persistent/helper/tools/node/bin/node',userId:501,localTimezone:()=> 'Europe/Berlin',assertHost:()=>{},execute:async(command,args)=>{
    calls.push({command,args});
    if(command==='/usr/bin/plutil')return{stdout:'OK'};
    assert.equal(command,'/bin/launchctl','Installer darf kein anderes Systemprogramm aufrufen');
    if(args[0]==='bootstrap')loaded=true;
    else if(args[0]==='bootout')loaded=false;
    else if(args[0]==='print'&&!loaded)throw new Error('Fixture service not found');
    return{stdout:'Fixture launchd registration'};
  }};
  return {options,calls,plist:path.join(options.launchAgentsDir,FUNDING_TRASH_LABEL+'.plist'),setLoaded:value=>{loaded=value}};
}
test('installer registers only 00:30 schedule with persistent node and current-runtime path',async t=>{
  const f=await installer(t);const result=await installDailyTrash(f.options);
  assert.equal(result.installed,true);assert.equal(result.startedNow,false);assert.equal(result.nodePath,f.options.nodePath);assert.equal(result.helperPath,path.join(f.options.helperRoot,'runtime/central/current/local-mac-helper/funding-trash.mjs'));
  assert.equal(f.calls.filter(row=>row.args[0]==='bootstrap').length,1);assert.ok(f.calls.some(row=>row.command==='/usr/bin/plutil'));assert.ok(f.calls.every(row=>!row.args.includes('kickstart')&&row.command!=='/usr/bin/osascript'));
  assert.doesNotMatch(await readFile(f.plist,'utf8'),/RunAtLoad|KeepAlive/);
  assert.equal((await stat(f.plist)).mode&0o777,0o600);
});
test('unchanged unloaded LaunchAgent is bootstrapped again, loaded schedule remains untouched',async t=>{
  const f=await installer(t);await installDailyTrash(f.options);f.calls.length=0;
  await installDailyTrash(f.options);assert.equal(f.calls.filter(row=>['bootstrap','bootout'].includes(row.args[0])).length,0);
  f.setLoaded(false);f.calls.length=0;await installDailyTrash(f.options);
  assert.equal(f.calls.filter(row=>row.args[0]==='bootstrap').length,1);assert.equal(f.calls.filter(row=>row.args[0]==='bootout').length,0);
});
test('installer refuses other timezones and relative runtime paths without changing the system',async t=>{
  const f=await installer(t);
  await assert.rejects(installDailyTrash({...f.options,localTimezone:()=> 'UTC'}),/Europe\/Berlin/);
  await assert.rejects(installDailyTrash({...f.options,nodePath:'relative-node'}),/absolute/);
  await assert.rejects(installDailyTrash({...f.options,assertHost:()=>{throw new Error('Fixture invalid host')}}),/invalid host/);
  assert.equal(f.calls.length,0);await assert.rejects(access(f.plist),{code:'ENOENT'});
});
test('separate processes still perform exactly one mock Finder operation',async t=>{
  const file=await fixture(t),moduleUrl=new URL('../local-mac-helper/funding-trash.mjs',import.meta.url).href;
  const code=`import {emptyDailyTrash} from ${JSON.stringify(moduleUrl)}; let calls=0; const r=await emptyDailyTrash({file:${JSON.stringify(file)},now:new Date('2026-09-15T22:30:00Z'),assertHost:()=>{},execute:async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,40));return {stdout:'2:0'}}}); console.log(JSON.stringify({calls,duplicate:r.duplicate===true}));`;
  const run=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.on('error',reject);child.on('exit',code=>code===0?resolve(JSON.parse(stdout)):reject(new Error(stderr)));});
  const results=await Promise.all([run(),run(),run()]);assert.equal(results.reduce((sum,row)=>sum+row.calls,0),1);assert.equal(results.filter(row=>row.duplicate).length,2);
});
