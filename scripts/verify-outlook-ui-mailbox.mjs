import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createOutlookUiMailbox, parseOutlookMimeFile } from '../local-mac-helper/outlook-ui-mailbox.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const from='foerderung@heat-hero.com', now=Date.parse('2026-09-15T10:00:00Z');
const item=(id,patch={})=>({messageId:`<${id}@example.test>`,subject:`Subject ${id}`,sentAt:'2026-09-14T10:00:00Z',receivedAt:'2026-09-14T10:00:01Z',sender:[from],recipients:['recipient@example.test'],cc:[],bcc:[],body:'Hallo\nText',bodyType:'text/plain',bodyHash:hash('Hallo\nText'),attachments:[],references:[],originalMessageIds:[],sourceHash:hash(id),...patch});
async function fixture(t,items=[],options={}) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'iva-outlook-ui-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  let currentFolder='',query='',calls=[],expanded=false;
  const descriptions=items.map(m=>`Absender: Test, Betreff: ${m.subject}, 14.09.26, Ordner: ${options.folder||'Posteingang'}, Nachrichtenvorschau: PRIVATE`);
  const bridge=async args=>{
    calls.push(args);
    if(args[0]==='open-account-folder') {currentFolder=args[2];query='';return {};}
    if(args[0]==='doctor')return {focusedWindowTitle:options.badFolder?'Posteingang • Wrong':currentFolder+' • Förderung | HEAT HERO'};
    if(args[0]==='mailbox-ui-search'){query=args[1];return {};}
    if(args[0]==='mailbox-ui-expand'){expanded=true;return {};}
    if(['mailbox-ui-next','mailbox-ui-clear-search','mailbox-ui-close-source'].includes(args[0]))return {};
    if(args[0]==='mailbox-ui-list')return {query,scope:options.badScope?'Alle Postfächer':'Aktueller Ordner',loading:options.loading||false,emptyVerified:!items.length,rowCount:items.length,visibleIndices:options.missingEnd?[]:items.map((_,i)=>i),rows:items.map((m,i)=>({index:i,description:descriptions[i],conversation:options.group&&!expanded,expanded,visible:true}))};
    if(args[0]==='mailbox-ui-source')return {sourcePath:String(descriptions.indexOf(args[1]))};
    throw Error('Unexpected command '+args[0]);
  };
  const adapter=createOutlookUiMailbox({bridge,parseSource:async p=>({...items[Number(p)],...(options.wrongSource?{subject:'OTHER'}:{})}),now:()=>now,sleep:async()=>{},assertHost:async()=>{},withLease:async f=>f(),dataDir:dir});
  return {adapter,calls,dir,descriptions};
}
test('original MIME parser reads encoded subject, recipient sets and actual attachment hashes',async t=>{
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'iva-mime-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const dir=path.join(root,'Profile','MimeFiles','one');await mkdir(dir,{recursive:true});
  const file=path.join(dir,'1.mime');const bytes=Buffer.from('xlsx-fixture');
  await writeFile(file,`From: Sender <${from}>\r\nTo: recipient@example.test\r\nCc: cc@example.test\r\nDate: Mon, 14 Sep 2026 12:00:00 +0200\r\nReceived: by example.test; Mon, 14 Sep 2026 12:00:01 +0200\r\nMessage-ID: <original@example.test>\r\nSubject: =?UTF-8?B?RsO2cmRlcnVuZw==?=\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=demo\r\n\r\n--demo\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHallo\r\nText\r\n--demo\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=forecast.xlsx\r\nContent-Transfer-Encoding: base64\r\n\r\n${bytes.toString('base64')}\r\n--demo--\r\n`);
  const result=await parseOutlookMimeFile(file,{trustedRoot:root});
  assert.equal(result.subject,'Förderung');assert.equal(result.messageId,'<original@example.test>');assert.equal(result.bodyHash,hash('Hallo\nText'));assert.equal(result.attachments[0].sha256,hash(bytes));assert.deepEqual(result.cc,['cc@example.test']);
  await writeFile(file,'Message-ID: <one@example.test>\r\nMessage-ID: <two@example.test>\r\n\r\nBad');await assert.rejects(()=>parseOutlookMimeFile(file,{trustedRoot:root}),/vollständig/);
});
test('source identity is freshly checked before returning exact RFC ID',async t=>{
  const f=await fixture(t,[item('one')]); const x=await f.adapter.resolveSourceIdentity({from,messageId:'<one@example.test>',description:f.descriptions[0]});
  assert.equal(x.identityVerified,true);assert.equal(x.messageId,'<one@example.test>');assert.equal(f.calls.filter(a=>a[0]==='mailbox-ui-source').length,1);
});
test('mismatched source and wrong folder fail closed',async t=>{
  const f=await fixture(t,[item('one')],{wrongSource:true});await assert.rejects(()=>f.adapter.resolveSourceIdentity({from,description:f.descriptions[0]}),{code:'OUTLOOK_UI_SOURCE_MISMATCH'});
  const g=await fixture(t,[item('one')],{badFolder:true});await assert.rejects(()=>g.adapter.resolveSourceIdentity({from,description:g.descriptions[0]}),{code:'OUTLOOK_UI_SCOPE_UNVERIFIED'});
});
test('mailbox pages persist work and resume after process recreation without rereading sources',async t=>{
  const f=await fixture(t,[item('one'),item('two')]);
  const first=await f.adapter.readFundingMailboxPage({from,since:'2026-09-14',mode:'initial-backfill',limit:1});
  assert.equal(first.messages.length,1);assert.equal(first.complete,false);assert.equal(first.coverageVerified,true);
  const second=await f.adapter.readFundingMailboxPage({from,since:'2026-09-14',mode:'initial-backfill',cursor:first.nextCursor,limit:1});
  assert.equal(second.complete,true);assert.equal(second.messages[0].messageId,'<two@example.test>');assert.equal(f.calls.filter(a=>a[0]==='mailbox-ui-source').length,2);
  const checkpoint=JSON.parse(Buffer.from(second.checkpoint,'base64url').toString()); assert.equal(checkpoint.since,now);
  assert.ok(!second.checkpoint.includes('PRIVATE'));assert.equal(checkpoint.kind,'checkpoint');
});
test('conversation descendants outside the query date are excluded by original Received time',async t=>{
  const f=await fixture(t,[item('old',{receivedAt:'2026-08-10T10:00:00Z'}),item('one')]);
  const p=await f.adapter.readFundingMailboxPage({from,since:'2026-09-14',mode:'initial-backfill'});
  assert.deepEqual(p.messages.map(x=>x.messageId),['<one@example.test>']);assert.equal(p.complete,true);
});
test('missing end proof and changed search scope never claim coverage',async t=>{
  const f=await fixture(t,[item('one')],{missingEnd:true});await assert.rejects(()=>f.adapter.readFundingMailboxPage({from,since:'2026-09-14'}),{code:'OUTLOOK_UI_COVERAGE_UNVERIFIED'});
  const g=await fixture(t,[item('one')],{badScope:true});await assert.rejects(()=>g.adapter.readFundingMailboxPage({from,since:'2026-09-14'}),{code:'OUTLOOK_UI_SEARCH_SCOPE_UNVERIFIED'});
});
const request={from,to:['recipient@example.test'],cc:[],bcc:[],subject:'Subject one',body:'Hallo\r\nText',attachments:[],notBefore:'2026-08-01T00:00:00Z',notAfter:'2026-09-15T10:00:00Z'};
test('Sent proof checks text, exact CC/BCC and stable Message-ID across the original request interval',async t=>{
  const f=await fixture(t,[item('one')],{folder:'Gesendet'});const proof=await f.adapter.verifyFundingSentMessage(request);
  assert.equal(proof.verified,true);assert.equal(proof.messageId,'<one@example.test>');assert.equal(proof.bodyHash,hash('Hallo\nText'));assert.equal(proof.body,undefined);assert.deepEqual(proof.attachments,[]);
  const g=await fixture(t,[item('one',{cc:['unexpected@example.test']})],{folder:'Gesendet'});await assert.rejects(()=>g.adapter.verifyFundingSentMessage(request),{code:'OUTLOOK_SENT_CONTENT_MISMATCH'});
});
test('negative Sent proof is allowed only after full search; duplicate exact matches are ambiguous',async t=>{
  const f=await fixture(t,[],{folder:'Gesendet'});assert.deepEqual(await f.adapter.verifyFundingSentMessage(request),{verified:false,reason:'not_found',searchComplete:true,checkedAt:new Date(now).toISOString()});
  const g=await fixture(t,[item('one'),item('two',{subject:'Subject one'})],{folder:'Gesendet'});
  await assert.rejects(()=>g.adapter.verifyFundingSentMessage(request));
});
test('forward proof requires the real original ID and matching introduction',async t=>{
  const m=item('one',{body:'Einleitung\n\nOriginalinhalt',bodyHash:hash('Einleitung\n\nOriginalinhalt'),references:['<original@example.test>']});
  const f=await fixture(t,[m],{folder:'Gesendet'});const proof=await f.adapter.verifyFundingSentMessage({...request,body:'Einleitung',introduction:'Einleitung',originalMessageId:'<original@example.test>'});assert.equal(proof.introductionHash,hash('Einleitung'));assert.equal(proof.originalMessageId,'<original@example.test>');
  await assert.rejects(()=>f.adapter.verifyFundingSentMessage({...request,body:'Einleitung',introduction:'Einleitung',originalMessageId:'<wrong@example.test>'}),{code:'OUTLOOK_SENT_CONTENT_MISMATCH'});
});
