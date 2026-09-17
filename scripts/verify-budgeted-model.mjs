import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapBudgetedModel, providerRequestBound } from '../core/budgeted-model.js';
import { createGoogleSchemaFetch, googleCompleteUsage } from '../core/google-schema-transport.js';

const routed={key:'anthropic:claude-sonnet-4-6',provider:'anthropic'};
const options={prompt:[{role:'user',content:[{type:'text',text:'original source'}]}],mode:{type:'regular'},maxTokens:1000};
function fixture(provider={}) {
  const events=[];
  const model=wrapBudgetedModel({specificationVersion:'v1',provider:'fixture',...provider},routed,{
    estimate:(_,usage)=>{events.push(['bound',usage]);return 1;},
    reserve:async()=>{events.push(['reserve']);return{markDispatched:async()=>events.push(['dispatch']),settle:async usage=>events.push(['settle',usage]),release:async data=>events.push(['release',data])}},
  });return{model,events};
}
const result={text:'verified',finishReason:'stop',usage:{promptTokens:20,completionTokens:5}};
test('every request is separately reserved before dispatch; original source and model preserved',async()=>{
 const f=fixture({doGenerate:async actual=>{assert.equal(actual,options);f.events.push(['provider']);return result;}});
 for(let i=0;i<2;i++)assert.equal(await f.model.doGenerate(options),result);
 assert.equal(f.model.provider,'fixture');
 assert.deepEqual(f.events.map(x=>x[0]),['bound','reserve','dispatch','provider','settle','bound','reserve','dispatch','provider','settle']);
});
test('cache usage is included instead of omitted',async()=>{
 const f=fixture({doGenerate:async()=>({...result,providerMetadata:{anthropic:{cacheCreationInputTokens:100,cacheReadInputTokens:200}}})});
 await f.model.doGenerate(options);assert.deepEqual(f.events.at(-1),['settle',{promptTokens:320,completionTokens:5}]);
});
test('budget denial never reaches provider',async()=>{
 const model=wrapBudgetedModel({doGenerate:async()=>assert.fail('not allowed')},routed,{estimate:()=>1,reserve:async()=>{throw Error('budget');}});
 await assert.rejects(model.doGenerate(options),/budget/);
});
test('cancelled request never spends',async()=>{
 const f=fixture({doGenerate:async()=>assert.fail('not allowed')});
 await assert.rejects(f.model.doGenerate({...options,abortSignal:AbortSignal.abort()}),{name:'AbortError'});assert.equal(f.events.length,0);
});
test('unknown provider outcome retains reservation',async()=>{
 const f=fixture({doGenerate:async()=>{throw Error('network timeout');}});
 await assert.rejects(f.model.doGenerate(options),/network timeout/);assert.equal(f.events.at(-1)[0],'release');assert.equal(f.events.at(-1)[1],undefined);
});
test('stream settles finish usage before exposing completion',async()=>{
 const f=fixture({doStream:async()=>({stream:new ReadableStream({start(c){c.enqueue({type:'text-delta',textDelta:'yes'});c.enqueue({type:'finish',...result});c.close();}})})});
 const response=await f.model.doStream(options);const parts=[];for await(const part of response.stream)parts.push(part);
 assert.deepEqual(parts.map(p=>p.type),['text-delta','finish']);assert.equal(f.events.at(-1)[0],'settle');
});
test('stream missing finish does not report success or refund',async()=>{
 const f=fixture({doStream:async()=>({stream:new ReadableStream({start(c){c.close();}})})});
 const response=await f.model.doStream(options);await assert.rejects(async()=>{for await(const part of response.stream){}},{code:'budget_usage_unknown'});assert.equal(f.events.at(-1)[0],'release');
});
test('truncated answer is charged and rejected as incomplete',async()=>{
 const f=fixture({doGenerate:async()=>({...result,finishReason:'length'})});await assert.rejects(f.model.doGenerate(options),{code:'model_output_incomplete'});assert.equal(f.events.filter(e=>e[0]==='settle').length,1);
});
test('unpriced server tools and unknown models are rejected before dispatch',()=>{
 assert.throws(()=>providerRequestBound({...routed,key:'other:model'},options),{code:'budget_bound_unknown'});
 assert.throws(()=>providerRequestBound(routed,{...options,mode:{type:'regular',tools:[{type:'provider-defined'}]}}),{code:'budget_extra_charge_unknown'});
});
test('Google bill includes thought tokens and signature turns survive split stream chunks',async()=>{
 const source={candidates:[{content:{parts:[{functionCall:{name:'read',args:{}},thoughtSignature:'original-signature'}]}}],usageMetadata:{promptTokenCount:30,candidatesTokenCount:5,thoughtsTokenCount:90,totalTokenCount:125}};
 assert.equal(googleCompleteUsage(structuredClone(source)).usageMetadata.candidatesTokenCount,95);
 const requests=[];let count=0;
 const transport=createGoogleSchemaFetch(async(_,init)=>{requests.push(JSON.parse(init.body));if(count++>0)return Response.json({});
  const bytes=new TextEncoder().encode('data: '+JSON.stringify(source)+'\r\n\r\n');return new Response(new ReadableStream({start(c){c.enqueue(bytes.slice(0,40));c.enqueue(bytes.slice(40));c.close();}}),{headers:{'content-type':'text/event-stream'}});
 });
 const response=await transport('https://fixture.test',{body:JSON.stringify({contents:[]})});
 const output=JSON.parse((await response.text()).split('data: ')[1].trim());assert.equal(output.usageMetadata.candidatesTokenCount,95);
 await transport('https://fixture.test',{body:JSON.stringify({contents:[{role:'model',parts:[{functionCall:{name:'read',args:{}}}]}]})});
 assert.equal(requests[1].contents[0].parts[0].thoughtSignature,'original-signature');
});
test('Google nonstream bills thinking identically',async()=>{
 const transport=createGoogleSchemaFetch(async()=>Response.json({usageMetadata:{promptTokenCount:30,candidatesTokenCount:5,thoughtsTokenCount:90,totalTokenCount:125}}));
 const response=await transport('https://fixture.test',{});assert.equal((await response.json()).usageMetadata.candidatesTokenCount,95);
});
