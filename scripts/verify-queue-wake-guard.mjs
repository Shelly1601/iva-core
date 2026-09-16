import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createQueueWakeGuard } from '../local-mac-helper/queue-wake-guard.mjs';
function fixture() {
  let at=0, pending=true, locked=false;
  const children=[];
  const guard=createQueueWakeGuard({now:()=>at,pid:123,assessWork:async()=>({busy:pending,reason:'pending-ui-work'}),
    sessionStatus:async()=>({usable:!locked,locked}),spawnProcess:(bin,args)=>{
      const c=new EventEmitter();Object.assign(c,{bin,args,exitCode:null,signalCode:null,killed:false,unref(){},kill(){this.killed=true;this.signalCode='SIGTERM';}});
      children.push(c);queueMicrotask(()=>c.emit('spawn'));return c;
    }});
  return {guard,children,time:n=>at=n,pending:v=>pending=v,locked:v=>locked=v};
}
test('queued work keeps display and user activity assertions across worker handoffs',async()=>{
  const f=fixture();let r=await f.guard.tick();assert.equal(r.userActivityProtected,true);
  assert.deepEqual(f.children[0].args,['-di','-w','123']);assert.deepEqual(f.children[1].args,['-u','-t','120']);
  f.time(31000);await f.guard.tick();assert.equal(f.children.length,3);assert.equal(f.children[1].killed,true);assert.equal(f.children[2].killed,false);
  f.pending(false);f.time(60000);r=await f.guard.tick();assert.equal(r.protected,true);assert.equal(r.reason,'worker-handoff-grace');
  f.time(160000);r=await f.guard.tick();assert.equal(r.protected,false);assert.equal(f.children[0].killed,true);
});
test('locked queued session is never described or treated as unlocked',async()=>{
  const f=fixture();f.locked(true);let r=await f.guard.tick();assert.equal(r.sessionLocked,true);assert.equal(r.unlockAvailable,false);assert.equal(r.userActivityProtected,false);assert.equal(f.children.length,1);
  f.locked(false);r=await f.guard.tick();assert.equal(r.userActivityProtected,true);assert.equal(f.children.length,2);
});
test('dead assertion is reacquired; idle machine is left unchanged',async()=>{
  const f=fixture();f.pending(false);await f.guard.tick();assert.equal(f.children.length,0);
  f.pending(true);await f.guard.tick();f.children[0].exitCode=1;await f.guard.tick();assert.equal(f.children.length,3);assert.deepEqual(f.children[2].args,['-di','-w','123']);f.guard.stop();assert.ok(f.children.every(c=>c.exitCode===1||c.killed));
});
