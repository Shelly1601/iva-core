import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateText, streamText, tool } from 'ai';
import { z } from 'zod';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'iva-router-budget-'));
process.env.DATA_DIR=directory;process.env.GROQ_API_KEY='offline-fixture';
process.env.IVA_MONTHLY_BUDGET_EUR='30';
const realFetch=globalThis.fetch;
const router=await import('../core/router.js');
test.after(async()=>{globalThis.fetch=realFetch;await fs.rm(directory,{recursive:true,force:true});});

test('actual SDK tool loop is charged per request exactly once, including spread routes',async()=>{
 let calls=0,tools=0;
 globalThis.fetch=async()=>{
   calls++;return Response.json({id:'fixture-'+calls,object:'chat.completion',created:1,model:'openai/gpt-oss-120b',
     choices:[{index:0,message:calls===1?{role:'assistant',content:null,tool_calls:[{id:'tool-1',type:'function',function:{name:'verify',arguments:'{}'}}]}:{role:'assistant',content:'Verified source'},finish_reason:calls===1?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}});
 };
 const routed=router.chooseModelKey('groq:openai/gpt-oss-120b',{task:'quality-test'});
 const copy={...routed};
 const release=await router.reserveModelBudget(copy,1);
 const result=await generateText({model:copy.model,prompt:'Use the verification tool.',maxTokens:100,maxRetries:0,maxSteps:3,tools:{verify:tool({parameters:z.object({}),execute:async()=>{tools++;return{verified:true};}})}});
 await router.recordUsage(copy,result.usage);await release();
 const status=await router.currentSpendEUR();
 assert.equal(result.text,'Verified source');assert.equal(tools,1);assert.equal(calls,2);
 assert.equal(status.byModel[routed.key].calls,2);assert.equal(status.byModel[routed.key].tokensIn,40);assert.equal(status.reservedEUR,0);
});

test('actual SDK stream accounts final usage without a second onFinish charge',async()=>{
 globalThis.fetch=async()=>{
  const chunks=[{id:'stream-1',object:'chat.completion.chunk',created:1,model:'openai/gpt-oss-120b',choices:[{index:0,delta:{role:'assistant',content:'OK'},finish_reason:null}]},
   {id:'stream-1',object:'chat.completion.chunk',created:1,model:'openai/gpt-oss-120b',choices:[{index:0,delta:{},finish_reason:'stop'}]},
   {id:'stream-1',object:'chat.completion.chunk',created:1,model:'openai/gpt-oss-120b',choices:[],usage:{prompt_tokens:7,completion_tokens:2,total_tokens:9}}];
  return new Response(chunks.map(value=>'data: '+JSON.stringify(value)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 };
 const routed=router.chooseModelKey('groq:openai/gpt-oss-120b',{task:'stream-test'});
 const output=streamText({model:routed.model,prompt:'OK',maxTokens:100,maxRetries:0,onFinish:async({usage})=>router.recordUsage(routed,usage)});
 let answer='';for await(const text of output.textStream)answer+=text;
 assert.equal(answer,'OK');const status=await router.currentSpendEUR();assert.equal(status.byTask['stream-test'].calls,1);assert.equal(status.byTask['stream-test'].tokensIn,7);assert.equal(status.reservedEUR,0);
});
