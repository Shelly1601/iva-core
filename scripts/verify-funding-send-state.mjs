import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createFundingSendStore, fundingSendIntentId } from '../local-mac-helper/funding-send-state.mjs';
import { renderFundingMissingDocumentsEmail, renderFundingNoResponseEscalationDraft } from '../local-mac-helper/funding.mjs';
const NOW=Date.parse('2026-09-15T10:00:00Z'), at=n=>new Date(NOW+n).toISOString();
const digest=value=>createHash('sha256').update(value.replace(/\r\n?/g,'\n').trim()).digest('hex');
const absent=async()=>({verified:false,reason:'not_found',searchComplete:true,checkedAt:at(0)});
const evidence={sourceReviewComplete:true,identityVerified:true,pipedriveFilesReadbackVerified:true,pipedriveNotesReadbackVerified:true,customerAddressVerified:true,partnerAddressVerified:true};
function payload(extra={}) {
  const input={dealId:'123',customerName:'Fixture Kunde',customerEmail:'kunde@example.com',vpEmail:'vp@example.com',orderNumber:'HH-123',missingDocumentIds:['identity_card'],...extra};
  const rendered=renderFundingMissingDocumentsEmail(input);
  return {type:'missing-documents',input,prepared:{from:'foerderung@heat-hero.com',to:rendered.recipients.to,cc:rendered.recipients.cc,subject:rendered.subject,body:rendered.body},evidence,reviewedAt:at(0)};
}
function sent(expected,extra={}) {return {verified:true,folder:'Gesendet',messageId:'<fixture-sent@example.com>',sentAt:at(-1000),sender:expected.from,recipients:expected.to,cc:expected.cc,bcc:[],subject:expected.subject,bodyHash:digest(expected.body),attachments:[],...(expected.originalMessageId?{originalMessageId:expected.originalMessageId,introductionHash:digest(expected.introduction)}:{}),...extra};}
async function fixture(t,opts={}) {const root=await mkdtemp(path.join(os.tmpdir(),'iva-send-state-'));t.after(()=>rm(root,{recursive:true,force:true}));const filePath=path.join(root,'send.json');const options={filePath,now:()=>NOW,verifySent:absent,readSentById:absent,...opts};return {filePath,options,store:createFundingSendStore(options)};}

test('intent identity ignores retry IDs and document ordering, escalation uses one original-message key',()=>{
  assert.equal(fundingSendIntentId(payload({requestId:'attempt-one',missingDocumentIds:['identity_card','land_register']})),fundingSendIntentId(payload({requestId:'attempt-two',missingDocumentIds:['land_register','identity_card']})));
  const original={type:'no-response',input:{dealId:'123',originalMessageId:'<actual-original@example.com>',missingDocumentIds:['identity_card']}};
  assert.equal(fundingSendIntentId(original),fundingSendIntentId({...original,input:{...original.input,missingDocumentIds:['land_register'],requestId:'another-attempt'}}));
});
test('prepare requires real exact renderer/source gates and exhaustive negative sent search',async t=>{
  const {store}=await fixture(t);
  const p=payload();
  await assert.rejects(store.prepareFundingSend({...p,prepared:{...p.prepared,cc:['wrong@example.com']}}),/entwurf/i);
  await assert.rejects(store.prepareFundingSend({...p,prepared:{...p.prepared,body:p.prepared.body+' extra'}}),/entwurf/i);
  await assert.rejects(store.prepareFundingSend({...p,evidence:{...evidence,customerAddressVerified:false}}),/eindeutig/);
  await assert.rejects(store.prepareFundingSend({...p,reviewedAt:at(-301000)}),{code:'FUNDING_SEND_TIME'});
  for (const change of [{ bcc:{} },{ attachments:{} },{ introduction:p.prepared.body,body:'Fremder Inhalt' }]) await assert.rejects(store.prepareFundingSend({...p,prepared:{...p.prepared,...change}}),{code:'FUNDING_SEND_INPUT'});
  await assert.rejects(store.prepareFundingSend({...p,input:{...p.input,dealId:'00123'}}),{code:'FUNDING_SEND_IDENTITY'});
  const result=await store.prepareFundingSend(p);assert.equal(result.state,'prepared');assert.equal(result.maySend,false);assert.equal(result.readyForPreSubmitReview,true);
});
test('incomplete/ambiguous/failed searches never permit sending',async t=>{
  for(const verifySent of [async()=>null,async()=>({verified:false}),async()=>({verified:false,reason:'not_found',searchComplete:false}),async()=>{throw new Error('Fixture transport failure')}] ) {
    const {store}=await fixture(t,{verifySent});await assert.rejects(store.prepareFundingSend(payload()),/Gesendet/);
  }
});
test('pre-existing exact sent message is adopted instead of submitted again',async t=>{
  const {store}=await fixture(t,{verifySent:async expected=>sent(expected)});
  const result=await store.prepareFundingSend(payload());assert.equal(result.alreadySent,true);assert.equal(result.maySend,false);assert.equal(result.sentProof.messageId,'<fixture-sent@example.com>');
  assert.equal((await store.markFundingSendSubmitted(result.intentId,{})).maySend,false);
});
test('only one concurrent before-submit claim may authorize the click, including after restart',async t=>{
  const {store,options,filePath}=await fixture(t);const p=payload(),prepared=await store.prepareFundingSend(p);const second=createFundingSendStore(options);
  const claims=await Promise.all([store.markFundingSendSubmitted(prepared.intentId,{...p,envelopeHash:prepared.envelopeHash}),second.markFundingSendSubmitted(prepared.intentId,{...p,envelopeHash:prepared.envelopeHash})]);
  assert.equal(claims.filter(row=>row.maySend).length,1);assert.equal((await stat(filePath)).mode&0o777,0o600);
  assert.equal((await createFundingSendStore(options).markFundingSendSubmitted(prepared.intentId,{})).maySend,false);
});
test('before-submit revalidates all source gates rather than accepting stored hash alone',async t=>{
  const {store}=await fixture(t);const p=payload(),prepared=await store.prepareFundingSend(p);
  await assert.rejects(store.markFundingSendSubmitted(prepared.intentId,{envelopeHash:prepared.envelopeHash}),/Identität|Deal-ID/);
  await assert.rejects(store.markFundingSendSubmitted(prepared.intentId,{...p,envelopeHash:prepared.envelopeHash,evidence:{...evidence,pipedriveFilesReadbackVerified:false}}),/Quellenprüfung/);
  assert.equal((await store.get(prepared.intentId)).state,'prepared');
});
test('crash after before-submit stays uncertain even after an exhaustive no-match result',async t=>{
  const {store,options}=await fixture(t);const p=payload(),prepared=await store.prepareFundingSend(p);
  await store.markFundingSendSubmitted(prepared.intentId,{...p,envelopeHash:prepared.envelopeHash});
  const resumed=await createFundingSendStore(options).reviewResumption(prepared.intentId);assert.equal(resumed.state,'submitted_unverified');assert.equal(resumed.maySend,false);assert.equal(resumed.requiresReadback,true);
  assert.equal((await store.prepareFundingSend({...p,input:{...p.input,requestId:'brand-new-attempt'}})).maySend,false);
});
test('complete ignores caller success flag and requires genuine verifier output',async t=>{
  let reads=0;const {store}=await fixture(t,{readSentById:async()=>{reads++;return absent();}});const p=payload(),prepared=await store.prepareFundingSend(p);
  await store.markFundingSendSubmitted(prepared.intentId,{...p,envelopeHash:prepared.envelopeHash});
  const result=await store.completeFundingSend(prepared.intentId,{messageId:'<fixture-sent@example.com>',verified:true,sent:true});assert.equal(reads,1);assert.equal(result.state,'submitted_unverified');assert.equal(result.alreadySent,false);
});
test('exact readback including TO CC BCC body and ID proves completion',async t=>{
  const {store}=await fixture(t,{readSentById:async expected=>sent(expected,{messageId:expected.messageId})});const p=payload(),prepared=await store.prepareFundingSend(p);
  await store.markFundingSendSubmitted(prepared.intentId,{...p,envelopeHash:prepared.envelopeHash});
  const result=await store.completeFundingSend(prepared.intentId,{messageId:'<exact@example.com>'});assert.equal(result.alreadySent,true);assert.equal(result.sentProof.messageId,'<exact@example.com>');
});
test('mismatched recipients, body, absent proof fields and wrong by-ID lookup remain unverified',async t=>{
  for(const change of [{cc:[]},{bcc:['hidden@example.com']},{bodyHash:'wrong'},{messageId:'<other@example.com>'},{sentAt:at(120000)},{folder:'Posteingang'},{cc:undefined},{attachments:['unexpected.pdf']}]) {
    const {store}=await fixture(t,{readSentById:async expected=>sent(expected,change)});const p=payload(),prepared=await store.prepareFundingSend(p);
    await assert.rejects(store.completeFundingSend(prepared.intentId,{messageId:'<fixture-sent@example.com>'}));assert.equal((await store.get(prepared.intentId)).state,'prepared');
  }
});
test('existing intent cannot swap recipient or envelope under same case identity',async t=>{
  const {store}=await fixture(t);await store.prepareFundingSend(payload());await assert.rejects(store.prepareFundingSend(payload({customerEmail:'other@example.com'})),{code:'FUNDING_SEND_CONFLICT'});
});
test('corrupt persistence is rejected without overwrite',async t=>{
  const {store,filePath}=await fixture(t);await writeFile(filePath,'{broken');await assert.rejects(store.prepareFundingSend(payload()));assert.equal(await readFile(filePath,'utf8'),'{broken');
});
function escalation(overrides={}) {
  const input={dealId:'123',customerName:'Fixture Kunde',customerEmail:'kunde@example.com',vpEmail:'vp@ekd-solar.de',orderNumber:'HH-123',salesStructure:'EKD',originalMessageId:'<original@example.com>',originalSubject:'Fixture fehlende Unterlagen',requestSentAt:at(-8*86400000),responses:[],...overrides};
  const rendered=renderFundingNoResponseEscalationDraft(input,new Date(NOW));
  return {type:'no-response',input,reviewedAt:at(0),prepared:{from:'foerderung@heat-hero.com',to:rendered.to,cc:[],subject:rendered.subject,introduction:rendered.body,originalMessageId:input.originalMessageId},evidence:{...evidence,originalMessageForwarded:true,responseThreadReadComplete:true}};
}
test('seven-day escalation is one-time per original message, rechecks new replies before click',async t=>{
  const {store}=await fixture(t);const p=escalation(),prepared=await store.prepareFundingSend(p);
  await assert.rejects(store.markFundingSendSubmitted(prepared.intentId,{...p,envelopeHash:prepared.envelopeHash,input:{...p.input,requestSentAt:at(-6*86400000)}}),/sieben vollen Tagen/);
  await assert.rejects(store.markFundingSendSubmitted(prepared.intentId,{...p,envelopeHash:prepared.envelopeHash,input:{...p.input,responses:[{senderEmail:'kunde@example.com',receivedAt:at(-1000)}]}}),/reagiert/);
  assert.equal((await store.markFundingSendSubmitted(prepared.intentId,{...p,envelopeHash:prepared.envelopeHash})).maySend,true);
  assert.equal((await store.prepareFundingSend({...p,input:{...p.input,requestId:'new-escalation-attempt'}})).maySend,false);
});
test('forward readback requires the real original message identity and introduction hash',async t=>{
  const {store}=await fixture(t,{readSentById:async expected=>sent(expected,{messageId:expected.messageId,originalMessageId:'<different@example.com>'})});const p=escalation(),prepared=await store.prepareFundingSend(p);
  await assert.rejects(store.completeFundingSend(prepared.intentId,{messageId:'<forward@example.com>'}),{code:'FUNDING_SEND_PROOF_MISMATCH'});
});
test('separate processes share the same before-submit claim without two send permissions',async t=>{
  const {store,filePath}=await fixture(t);const p=payload(),prepared=await store.prepareFundingSend(p);
  const moduleUrl=new URL('../local-mac-helper/funding-send-state.mjs',import.meta.url).href;
  const code=`import {createFundingSendStore} from ${JSON.stringify(moduleUrl)}; const s=createFundingSendStore({filePath:${JSON.stringify(filePath)},now:()=>${NOW},verifySent:async()=>({verified:false,reason:'not_found',searchComplete:true,checkedAt:${JSON.stringify(at(0))}})}); const r=await s.markFundingSendSubmitted(${JSON.stringify(prepared.intentId)},${JSON.stringify({...p,envelopeHash:prepared.envelopeHash})}); console.log(JSON.stringify({maySend:r.maySend}));`;
  function run(){return new Promise((resolve,reject)=>{const process=spawn(globalThis.process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});let output='',error='';process.stdout.on('data',x=>output+=x);process.stderr.on('data',x=>error+=x);process.on('error',reject);process.on('exit',status=>status===0?resolve(JSON.parse(output)):reject(new Error(error)));});}
  const results=await Promise.all([run(),run(),run()]);assert.equal(results.filter(row=>row.maySend).length,1);
});

test('native Outlook adapter contract supports historical pre-send search and exact positive readback',async t=>{
  const {createOutlookUiMailbox}=await import('../local-mac-helper/outlook-ui-mailbox.mjs');
  for(const found of [false,true]) {
    const {filePath}=await fixture(t);const p=payload();let query='';
    const metadata={messageId:'<contract@example.com>',subject:p.prepared.subject,sender:[p.prepared.from],recipients:p.prepared.to,cc:p.prepared.cc,bcc:[],sentAt:at(-1000),receivedAt:at(-1000),body:p.prepared.body,bodyType:'text/plain',bodyHash:digest(p.prepared.body),attachments:[],references:[],originalMessageIds:[],sourceHash:'fixture'};
    const row={description:'Betreff: '+metadata.subject+', Ordner: Gesendet, Fixture',conversation:false,visible:true};
    const adapter=createOutlookUiMailbox({now:()=>NOW,assertHost:()=>{},withLease:fn=>fn(),sleep:async()=>{},dataDir:path.join(path.dirname(filePath),'native'),parseSource:async()=>metadata,
      bridge:async([action,...args])=>{
        if(['doctor','mailbox-ui-window'].includes(action))return{focusedWindowTitle:'Gesendet • Förderung | HEAT HERO'};
        if(action==='mailbox-ui-search'){query=args[0];return{};}
        if(action==='mailbox-ui-list')return{scope:'Aktueller Ordner',query,rows:found?[row]:[],visibleIndices:found?[0]:[],rowCount:found?1:0,emptyVerified:!found,loading:false};
        if(action==='mailbox-ui-source')return{sourcePath:'/fixture-original.mime'};
        if(['open-account-folder','mailbox-ui-next','mailbox-ui-clear-search','mailbox-ui-close-source'].includes(action))return{};
        throw new Error('Unexpected fixture UI action: '+action);
      }});
    const store=createFundingSendStore({filePath,now:()=>NOW,verifySent:adapter.verifyFundingSentMessage,readSentById:adapter.verifyFundingSentMessage});
    const result=await store.prepareFundingSend(p);assert.equal(result.alreadySent,found);assert.equal(result.maySend,false);assert.match(query,/2026-08-01/);
  }
});
