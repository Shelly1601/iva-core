import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createOutlookUiMailbox, parseOutlookMimeFile } from '../local-mac-helper/outlook-ui-mailbox.mjs';
import { moveOutlookMessageToFolder } from '../local-mac-helper/macos-ui.mjs';
import { completeFundingMail } from '../local-mac-helper/funding-mail-completion.mjs';
const exec = promisify(execFile);
const hash=x=>createHash('sha256').update(x).digest('hex');
const from='foerderung@heat-hero.com', now=Date.parse('2026-09-15T10:00:00Z');
const item=(id,patch={})=>({messageId:`<${id}@example.test>`,subject:`Subject ${id}`,sentAt:'2026-09-14T10:00:00Z',receivedAt:'2026-09-14T10:00:01Z',sender:[from],recipients:['recipient@example.test'],cc:[],bcc:[],body:'Hallo\nText',bodyType:'text/plain',bodyHash:hash('Hallo\nText'),attachments:[],references:[],originalMessageIds:[],sourceHash:hash(id),...patch});
async function fixture(t,items=[],options={}) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'iva-outlook-ui-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  let currentFolder='',query='',calls=[],expanded=false;
  const descriptionsFor=folder=>items.map(m=>`Absender: Test, Betreff: ${m.subject}, 14.09.26, Ordner: ${folder}, Nachrichtenvorschau: PRIVATE`);
  let descriptions=descriptionsFor(options.folder||'Posteingang');
  const bridge=async args=>{
    calls.push(args);
    if(args[0]==='open-account-folder') {currentFolder=options.nativeFolder||args[2];query='';return {};}
    if(['doctor','mailbox-ui-window'].includes(args[0]))return {focusedWindowTitle:options.windowTitle||(options.badFolder?'Posteingang • Wrong':currentFolder+' • Förderung | HEAT HERO')};
    if(args[0]==='mailbox-ui-search'){query=args[1];return {};}
    if(args[0]==='mailbox-ui-expand'){expanded=true;return {};}
    if(['mailbox-ui-next','mailbox-ui-clear-search','mailbox-ui-close-source'].includes(args[0]))return {};
    if(args[0]==='mailbox-ui-list')return {query,scope:options.badScope?'Alle Postfächer':'Aktueller Ordner',loading:options.loading||false,emptyVerified:!items.length,rowCount:items.length,visibleIndices:options.missingEnd?[]:items.map((_,i)=>i),rows:items.map((m,i)=>({index:i,description:descriptions[i],conversation:options.group&&!expanded,expanded,visible:true}))};
    if(args[0]==='mailbox-ui-source')return {sourcePath:String(descriptions.indexOf(args[1]))};
    throw Error('Unexpected command '+args[0]);
  };
  const adapter=createOutlookUiMailbox({bridge,parseSource:async p=>({...items[Number(p)],...(options.wrongSource?{subject:'OTHER'}:{})}),now:()=>now,sleep:async()=>{},assertHost:async()=>{},withLease:async f=>f(),dataDir:dir});
  return {adapter,calls,dir,get descriptions(){return descriptions;},setFolder(folder){options.nativeFolder=folder;descriptions=descriptionsFor(folder);}};
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
test('Fertig accepts the native folder casing without broadening the account or folder scope',async t=>{
  for (const nativeFolder of ['Fertig','fertig','FERTIG']) {
    const f=await fixture(t,[item('one')],{folder:nativeFolder,nativeFolder});
    const result=await f.adapter.resolveSourceIdentity({from,folder:'Fertig',description:f.descriptions[0],messageId:'<one@example.test>'});
    assert.equal(result.identityVerified,true);assert.equal(result.messageId,'<one@example.test>');
  }
  for (const windowTitle of ['fertig • Förderung | HEAT HERO Archiv','fertig • Other','Posteingang • Förderung | HEAT HERO']) {
    const f=await fixture(t,[item('one')],{folder:'fertig',windowTitle});
    await assert.rejects(()=>f.adapter.resolveSourceIdentity({from,folder:'Fertig',description:f.descriptions[0]}),{code:'OUTLOOK_UI_SCOPE_UNVERIFIED'});
    assert.equal(f.calls.some(a=>a[0]==='mailbox-ui-source'),false);
  }
  const f=await fixture(t,[item('one')]);
  await assert.rejects(()=>f.adapter.resolveSourceIdentity({from,folder:'Fertig Archiv',description:f.descriptions[0]}),{code:'OUTLOOK_UI_SCOPE_DENIED'});
});
test('moved mail is found by its RFC ID after the Ordner label changes, never by stale row text',async t=>{
  const f=await fixture(t,[item('one')]);const sourceDescription=f.descriptions[0];
  await f.adapter.resolveSourceIdentity({from,folder:'Posteingang',description:sourceDescription,messageId:'<one@example.test>'});
  f.setFolder('fertig');
  const result=await f.adapter.resolveSourceIdentity({from,folder:'Fertig',description:sourceDescription,messageId:'<one@example.test>'});
  assert.equal(result.messageId,'<one@example.test>');assert.equal(result.identityVerified,true);
  assert.notEqual(result.description,sourceDescription);assert.ok(result.description.includes('Ordner: fertig,'));
  assert.ok(f.calls.some(a=>a[0]==='mailbox-ui-search'&&a[1].includes('subject:"Subject one"')));
  await assert.rejects(()=>f.adapter.resolveSourceIdentity({from,folder:'Fertig',description:f.descriptions[0],messageId:'<different@example.test>'}),{code:'OUTLOOK_UI_SOURCE_ID_MISMATCH'});
});
test('native mover requires the verified account and delegates destination identity proof to completion',async()=>{
  const calls=[];const messageDescription='Absender: Test, Betreff: Test, Ordner: Posteingang,';
  const dependencies={openFolder:async input=>{calls.push(input);},bridge:async args=>{calls.push(args);return {moved:true,removedFromSource:true};}};
  const result=await moveOutlookMessageToFolder({from,messageDescription,destinationFolder:'Fertig'},dependencies);
  assert.deepEqual(calls,[{from,folder:'Fertig'},{from,folder:'Posteingang'},['move-message-to-folder',messageDescription,'Fertig','Förderung | HEAT HERO']]);
  assert.equal(result.verifiedInDestination,false);assert.equal(result.requiresMessageIdReadback,true);
  await assert.rejects(()=>moveOutlookMessageToFolder({from:'another@example.test',messageDescription,destinationFolder:'Fertig'},dependencies),/geprüftes Konto/);
  assert.equal(calls.length,3);
  await assert.rejects(()=>moveOutlookMessageToFolder({from,messageDescription,destinationFolder:'Fertig'},{...dependencies,openFolder:async()=>{throw new Error('destination account unverified');}}),/destination account unverified/);
  assert.equal(calls.length,3,'no move is attempted if the destination account cannot be proved');
});
test('native window guard folds folder case while preserving exact mailbox identity',async t=>{
  const source=await readFile(new URL('../local-mac-helper/macos/iva-ax.swift',import.meta.url),'utf8');
  const helpers=['normalizedAXText','outlookFolderWindowMatches'].map(name=>source.match(new RegExp('func '+name+'\\([\\s\\S]*?\\n\\}'))?.[0]);
  assert.ok(helpers.every(Boolean));
  const dir=await mkdtemp(path.join(os.tmpdir(),'iva-outlook-folder-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'folder.swift');
  await writeFile(file,'import Foundation\n'+helpers.join('\n')+`\nlet account = "Förderung | HEAT HERO"
precondition(outlookFolderWindowMatches("fertig • " + account, folder: "Fertig", account: account))
precondition(outlookFolderWindowMatches("FERTIG - " + account, folder: "fertig", account: account))
precondition(!outlookFolderWindowMatches("Fertig • " + account + " Archiv", folder: "Fertig", account: account))
precondition(!outlookFolderWindowMatches("Fertig • Förderung | Other", folder: "Fertig", account: account))
precondition(!outlookFolderWindowMatches("Fertig Archiv • " + account, folder: "Fertig", account: account))
`);
  await exec('/usr/bin/swift',['-sdk',process.env.SDKROOT||'/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk',file],{timeout:60000});
});
test('a wrong destination Message-ID leaves the move pending and cannot trigger a blind repeat',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'iva-outlook-completion-'));
  const previousDirectory=process.env.IVA_MAC_HELPER_DATA_DIR;process.env.IVA_MAC_HELPER_DATA_DIR=dir;
  t.after(async()=>{if(previousDirectory===undefined)delete process.env.IVA_MAC_HELPER_DATA_DIR;else process.env.IVA_MAC_HELPER_DATA_DIR=previousDirectory;await rm(dir,{recursive:true,force:true});});
  let state={completed:[],pendingMoves:[]},moves=0,completed=0;
  const receipt={messageId:'<one@example.test>',dealId:'123',identityVerified:true,sourceReadComplete:true,expectedAttachmentCount:1,attachmentProcessingVerified:true,uploadedFiles:[{id:'77',filename:'Unterlagen.pdf',dealId:'123',verified:true}],textRelevant:false,verifiedAt:new Date().toISOString()};
  const input={receipt,messageDescription:'Betreff: Subject one, Ordner: Posteingang,'};
  const dependencies={load:async()=>structuredClone(state),save:async next=>{state=structuredClone(next);},intakeStore:{completeMessage:async()=>{completed++;}},moveMessage:async()=>{moves++;return {moved:true,removedFromSource:true};},resolveIdentity:async({folder})=>({identityVerified:true,messageId:folder==='Posteingang'?receipt.messageId:'<another@example.test>',description:`Betreff: Subject one, Ordner: ${folder},`})};
  await assert.rejects(()=>completeFundingMail(input,dependencies),/Message-ID in Fertig/);
  assert.equal(state.pendingMoves.length,1);assert.equal(state.completed.length,0);assert.equal(moves,1);assert.equal(completed,0);
  await assert.rejects(()=>completeFundingMail(input,dependencies),/Identität im Zielordner/);
  assert.equal(moves,1);assert.equal(completed,0);
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

test('conversation expansion stops on an unchanged or alternating group instead of reopening it',async t=>{
  for(const alternating of [false,true]) {
    const dir=await mkdtemp(path.join(os.tmpdir(),'iva-outlook-stall-'));t.after(()=>rm(dir,{recursive:true,force:true}));
    let query='',active=-1;const expansions=[];const reads=[];
    const groups=['one','two'].map(id=>`Unterhaltung, Betreff: Subject ${id}, 14.09.26, Ordner: Posteingang,`);
    const messages=['one','two'].map(id=>`Absender: Test, Betreff: Subject ${id}, 14.09.26, Ordner: Posteingang,`);
    const bridge=async args=>{
      if(args[0]==='mailbox-ui-window')return {focusedWindowTitle:'Posteingang • Förderung | HEAT HERO'};
      if(args[0]==='mailbox-ui-search'){query=args[1];return {};}
      if(args[0]==='mailbox-ui-expand'){expansions.push(args[1]);active=alternating?groups.indexOf(args[1]):-1;return {expanded:true};}
      if(args[0]==='mailbox-ui-source'){const id=messages.indexOf(args[1]);reads.push(id);return {sourcePath:String(id)};}
      if(args[0]==='mailbox-ui-list'){
        const rows=(alternating?groups:groups.slice(0,1)).map((description,i)=>({description,conversation:true,expanded:i===active,visible:true}));
        if(active>=0)rows.push({description:messages[active],conversation:false,expanded:false,visible:true});
        return {query,scope:'Aktueller Ordner',rows,rowCount:rows.length,visibleIndices:rows.map((_,i)=>i),loading:false};
      }
      return {};
    };
    const adapter=createOutlookUiMailbox({bridge,parseSource:async p=>item(['one','two'][Number(p)]),now:()=>now,sleep:async()=>{},assertHost:async()=>{},withLease:async f=>f(),dataDir:dir});
    await assert.rejects(()=>adapter.readFundingMailboxPage({from,folder:'Posteingang',since:'2026-08-01',mode:'initial-backfill'}),{code:'OUTLOOK_UI_CONVERSATION_STALLED'});
    assert.equal(expansions.length,alternating?2:1);
    assert.deepEqual(reads,alternating?[0,1]:[]);
  }
});
