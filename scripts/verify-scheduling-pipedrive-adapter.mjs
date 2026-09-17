import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createSchedulingPipedriveAdapter } from '../local-mac-helper/scheduling-pipedrive-adapter.mjs';

test('authenticated CRM adapter resolves KW by exact field name and compares stage before PUT', async () => {
 const deal={id:42,person_id:{name:'Test Customer'},pipeline_id:1,stage_id:3,kw_key:''};
 const stages=[{id:3,pipeline_id:1,order_nr:1,name:'A'},{id:4,pipeline_id:1,order_nr:2,name:'B'},{id:5,pipeline_id:1,order_nr:3,name:'C'}];
 const writes=[];
 const execute=async source=>vm.runInNewContext(source,{document:{querySelector:()=>({getAttribute:()=>stages.find(item=>item.id===deal.stage_id).name,textContent:stages.find(item=>item.id===deal.stage_id).name})},XMLHttpRequest:class{
  open(method,url){this.method=method;this.url=url;} setRequestHeader(){} send(body){
   this.status=200;let data;
   if(this.url.startsWith('/api/v1/dealFields'))data=[{key:'kw_key',name:'Einbautermin Kalenderwoche'}];
   else if(this.url.startsWith('/api/v1/stages'))data=stages;
   else {if(this.method==='PUT'){writes.push(JSON.parse(body));Object.assign(deal,JSON.parse(body));}data=deal;}
   this.responseText=JSON.stringify({success:true,data});
  }
 }});
 const adapter=createSchedulingPipedriveAdapter({execute});
 assert.equal((await adapter.read({dealId:'42',customerName:'Test Customer'})).identityVerified,true);
 await adapter.writeWeek('42','KW09');assert.equal((await adapter.read({dealId:'42',customerName:'Test Customer'})).week,'KW09');
 await adapter.writeStage('42','3','4');await adapter.writeStage('42','3','4');assert.equal(writes.length,2);
 await assert.rejects(adapter.writeStage('42','3','5'),/source stage changed/);
 assert.equal((await adapter.read({dealId:'42',customerName:'Other Customer'})).identityVerified,false);
});
