import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createSchedulingPlanbarAdapter } from '../local-mac-helper/scheduling-planbar-adapter.mjs';
import { createSchedulingWhatsAppAdapter } from '../local-mac-helper/scheduling-whatsapp-adapter.mjs';

test('Planbar observed store contract, customer identity and visible event readback',async()=>{
 let entries=[],writes=0;
 const resource={id:'r',name:'Montage 1'};
 const config={routes:{resourceDataForTooltips:'/data',resourceModalData:'/detail',resourceStore:'/store'},permissions:{bookingStore:true}};
 const execute=async source=>vm.runInNewContext(source,{URL,CSS:{escape:x=>x},location:{origin:'https://planbar.test'},document:{querySelector:selector=>selector==='[data-planboard-config]'?{dataset:{planboardConfig:JSON.stringify(config)}}:{},querySelectorAll:()=>[{getAttribute:()=>resource.id,innerText:resource.name}]},window:{getPlanboard:()=>({refetchEvents(){},getEventById:id=>entries.find(x=>x.id===id)?{getResources:()=>[{id:'r'}]}:null})},XMLHttpRequest:class{
  open(method,url){this.url=new URL(url);this.method=method;}setRequestHeader(){}send(){this.status=200;let data;
   if(this.url.pathname==='/data')data={entries};
   else if(this.url.pathname==='/detail')data={customer:{id:'c'}};
   else if(this.url.pathname==='/store'){writes++;assert.equal(this.method,'GET');assert.equal(this.url.searchParams.get('site_id'),'task');entries=[{id:'a',resourceId:'r',start:'2026-10-05 00:00:00',end:'2026-10-10 00:00:00',tooltipdata:{customer:{id:'c',firstname:'HH Test',lastname:'Customer'}}}];data=true;}
   this.responseText=JSON.stringify(data);
  }
 }});
 const adapter=createSchedulingPlanbarAdapter({execute,refresh:async()=>{}});
 const request={customerName:'Test Customer',partnerPrefix:'HH',isoYear:2026,week:41,planbarCustomerId:'c',planbarTaskId:'task',planbarIdentityProof:{verified:true,customerId:'c',taskId:'task'}};
 await assert.rejects(adapter.findExisting({...request,planbarIdentityProof:null}),/identity/);
 const initial=await adapter.findExisting(request);const target=await adapter.create(request,initial);
 const proof=await adapter.read(target,request);assert.equal(proof.verified,true);assert.equal(proof.appointmentId,'a');assert.equal(writes,1);
 assert.equal((await adapter.findExisting(request)).appointment.id,'a');
 await assert.rejects(adapter.create(request,initial),/appeared/);assert.equal(writes,1);
});
test('WhatsApp requires independent native evidence after send',async()=>{
 let sent=0,found=false;const adapter=createSchedulingWhatsAppAdapter({send:async()=>{sent++;found=true;},read:async()=>found?{messageId:'ax-sha256:evidence',verified:true,verifiedAt:new Date().toISOString()}:{absenceVerified:true,communityVerified:true}});
 const message={group:'Terminierung Dispo',community:'Heat Hero GmbH',text:'Test Customer, KW 41, O1'};
 assert.equal((await adapter.find(message)).absenceVerified,true);
 const proof=await adapter.send(message);assert.equal(proof.app,'native-whatsapp');assert.equal((await adapter.read(proof,message)).messageId,proof.messageId);assert.equal(sent,1);
});
