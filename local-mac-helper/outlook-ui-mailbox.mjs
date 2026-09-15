import os from 'node:os';
import path from 'node:path';
import { readFile, writeFile, mkdir, rename, realpath, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runMacUiBridge } from './macos-ui.mjs';
import { assertImacExecutionHost } from './imac-host-guard.mjs';
import { withImacExecutionLock } from './ui-execution-lock.mjs';

const exec = promisify(execFile);
const ROOT = path.join(os.homedir(), 'Library/Application Support/IVA Mac Helper');
const parser = fileURLToPath(new URL('./outlook-mime-parser.py', import.meta.url));
const error = (code, message) => Object.assign(new Error(message), { code, source: 'outlook-native', coverageVerified: false, complete: false });
const hash = value => createHash('sha256').update(value).digest('hex');
const normalize = value => String(value || '').replace(/\r\n/g, '\n').trim();
const emails = values => [...new Set((values || []).map(x => String(x).trim().toLowerCase()))].sort();
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const accountLabel = from => from === 'foerderung@heat-hero.com' ? 'Förderung | HEAT HERO' : from;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const rfcId = value => /^<[^\s<>]{1,500}@[^\s<>]{1,250}>$/.test(String(value));
const allowedFolders = new Set(['Posteingang', 'Gesendet', 'fertig']);
const day = time => new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time));
const queryValue = value => '"' + String(value).replace(/["\\\r\n]/g, ' ').trim() + '"';
function descriptionMatches(description, metadata) {
  const subject = String(description).split('Betreff: ')[1];
  return subject && subject.startsWith(metadata.subject + ',');
}
function folderMatches(description, folder) {
  const explicit = String(description).match(/Ordner:\s*([^,]+),/);
  return !explicit || explicit[1].trim() === folder;
}
function startTime(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value || '')) {
    const midnight = Date.parse(value+'T00:00:00Z');
    const offset = Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Berlin',hour:'2-digit',hourCycle:'h23'}).format(new Date(midnight)));
    return midnight - offset*3600000;
  }
  return Date.parse(value);
}
async function atomic(file, data) {
  await mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const temp=file+'.'+randomUUID()+'.tmp';
  await writeFile(temp,JSON.stringify(data),{mode:0o600,flag:'wx'}); await rename(temp,file);
}

export async function parseOutlookMimeFile(sourcePath, { trustedRoot = path.join(os.homedir(),'Library/Group Containers/UBF8T346G9.Office/Outlook/Outlook 15 Profiles') } = {}) {
  const resolved = await realpath(sourcePath), root = await realpath(trustedRoot);
  if (!resolved.startsWith(root+path.sep) || !resolved.includes('/MimeFiles/') || !/\.mime$/.test(resolved) || resolved !== sourcePath) throw error('OUTLOOK_SOURCE_PATH_DENIED','Outlook hat keinen zulässigen Originalquellpfad geliefert.');
  if ((await stat(resolved)).size > 64*1024*1024) throw error('OUTLOOK_SOURCE_TOO_LARGE','Die Originalmail überschreitet die sichere Lesegröße.');
  let output;
  try { output = await exec('/usr/bin/python3',[parser,resolved],{timeout:20000,maxBuffer:8*1024*1024}); }
  catch { throw error('OUTLOOK_SOURCE_PARSE_FAILED','Die Originalmail konnte nicht vollständig und eindeutig gelesen werden.'); }
  let parsed; try { parsed=JSON.parse(output.stdout); } catch { throw error('OUTLOOK_SOURCE_PARSE_FAILED','Die Originalquelle lieferte keine gültigen Metadaten.'); }
  if (!rfcId(parsed.messageId) || !parsed.sentAt || !Array.isArray(parsed.attachments)) throw error('OUTLOOK_SOURCE_INVALID','Die Originalquelle enthält keinen belastbaren Nachrichtenbeleg.');
  return parsed;
}

let queue=Promise.resolve();
async function uiLease(task) {
  const execute = async () => {
    // A CLI subprocess inside the existing workflow lease must not deadlock on
    // its own ancestor's lease. An unrelated process must obtain the lock.
    let owned=false;
    const owner=await readFile(path.join(ROOT,'ui-execution-lock/owner.json'),'utf8').then(JSON.parse).catch(()=>null);
    if (owner?.pid) {
      let pid=process.pid;
      for(let i=0;i<20&&pid>1;i++) {
        if(pid===owner.pid) { owned=true; break; }
        const out=await exec('/bin/ps',['-p',String(pid),'-o','ppid=']).catch(()=>null);
        pid=Number(out?.stdout.trim());
      }
    }
    return owned ? task() : withImacExecutionLock(task,{timeoutMs:30000});
  };
  const result=queue.then(execute,execute); queue=result.catch(()=>{}); return result;
}

export function createOutlookUiMailbox({bridge=runMacUiBridge,parseSource=parseOutlookMimeFile,now=()=>Date.now(),sleep=delay,assertHost=assertImacExecutionHost,withLease=uiLease,dataDir=path.join(ROOT,'outlook-mail-evidence')}={}) {
  const indexFile=id=>path.join(dataDir,'identities',hash(id)+'.json');
  async function open(from,folder) {
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from) || !allowedFolders.has(folder)) throw error('OUTLOOK_UI_SCOPE_DENIED','Das Postfach oder der Leseordner ist nicht zulässig.');
    for (let attempt=0;attempt<3;attempt++) {
      await bridge(['mailbox-ui-clear-search']);
      await bridge(['open-account-folder',accountLabel(from),folder],{timeoutMs:30000});
      const state=await bridge(['mailbox-ui-window']);
      if((state.focusedWindowTitle || '').startsWith(folder+' • '+accountLabel(from))) return;
      await sleep(300);
    }
    throw error('OUTLOOK_UI_SCOPE_UNVERIFIED','Der richtige Kontoordner ist nicht belegt.');
  }
  async function capture(from,folder,row) {
    if(row.conversation || !folderMatches(row.description,folder)) throw error('OUTLOOK_UI_SINGLE_MESSAGE_REQUIRED','Die Mail muss als einzelne Nachricht im richtigen Ordner sichtbar sein.');
    const output=await bridge(['mailbox-ui-source',row.description],{timeoutMs:20000});
    let metadata;
    try { metadata=await parseSource(output.sourcePath); }
    finally { await bridge(['mailbox-ui-close-source',output.sourcePath]).catch(()=>{}); }
    if(!descriptionMatches(row.description,metadata)) throw error('OUTLOOK_UI_SOURCE_MISMATCH','Die geöffnete Originalquelle gehört nicht zur ausgewählten Nachricht.');
    const result={...metadata,folder,account:from,description:row.description,identityVerified:true,source:'outlook-native',readAt:new Date(now()).toISOString()};
    // Only the locating key is persisted. Never persist mail body, MIME or UI preview.
    await atomic(indexFile(metadata.messageId),{messageId:metadata.messageId,from,folder,subject:metadata.subject,receivedAt:metadata.receivedAt,sentAt:metadata.sentAt});
    return result;
  }
  async function search(from,folder,query,{maximum=500,budget=Infinity,known=[],onProgress=null,partial=false}={}) {
    await open(from,folder); await bridge(['mailbox-ui-search',query],{timeoutMs:20000});
    let previous='',stable=0,ended=false;
    const found=new Map(known.map(x=>[x.rowKey,x.item])),deadline=now()+240000; let captured=0;
    const rowKey=row=>hash(row.description.replace(/(?:Ungelesen,|\d+ ungelesene Nachrichten?,|\(selected\))/g,'').replace(/\s+/g,' ').trim());
    for(let page=0;page<300;page++) {
      if(now()>deadline) throw error('OUTLOOK_UI_READ_TIMEOUT','Die Outlook-Suche ist noch nicht vollständig; der offene Cursor bleibt erhalten.');
      let view=await bridge(['mailbox-ui-list']);
      if(view.scope!=='Aktueller Ordner'||view.query!==query) throw error('OUTLOOK_UI_SEARCH_SCOPE_UNVERIFIED','Der Suchbereich wurde verändert.');
      const visibleSingles=view.rows.filter(x=>x.visible&&!x.conversation&&folderMatches(x.description,folder));
      if(new Set(visibleSingles.map(rowKey)).size!==visibleSingles.length) throw error('OUTLOOK_UI_ROW_AMBIGUOUS','Gleich beschriftete Einzelmails können nicht zuverlässig unterschieden werden.');
      const group=view.rows.find(x=>x.conversation&&!x.expanded&&x.visible);
      if(group) { await bridge(['mailbox-ui-expand',group.description]); stable=0; continue; }
      for(const row of view.rows.filter(x=>x.visible&&!x.conversation&&folderMatches(x.description,folder))) {
        const key=rowKey(row); if(found.has(key)) continue;
        if(partial&&captured>=budget) return {items:[...found.values()],known:[...found].map(([rowKey,item])=>({rowKey,item})),complete:false};
        if(found.size>=maximum) throw error('OUTLOOK_UI_RESULT_LIMIT','Die Suche ist zu groß für einen vollständig belegten Ausschnitt.');
        const item=await capture(from,folder,row); found.set(key,item); captured++;
        if(onProgress) await onProgress([...found].map(([rowKey,item])=>({rowKey,item})));
        // Source viewing opens TextEdit; listing remains app-scoped, and the
        // following source action reactivates Outlook before any pointer input.
      }
      const fingerprint=hash(JSON.stringify({rows:view.rows.map(r=>r.description),visible:view.visibleIndices,count:view.rowCount}));
      const lastVisible=Math.max(-1,...(view.visibleIndices||[]));
      const atBottom=lastVisible===view.rowCount-1 && view.rowCount>0;
      if(!view.loading && (atBottom || (view.emptyVerified&&view.rows.length===0))) {
        stable=fingerprint===previous?stable+1:0;
        if(stable>=3) { ended=true; break; }
      } else stable=0;
      previous=fingerprint;
      await bridge(['mailbox-ui-next']); await sleep(400);
    }
    if(!ended) throw error('OUTLOOK_UI_COVERAGE_UNVERIFIED','Das Ende der Outlook-Suche ist nicht belegt. Kein vollständiger Scan wird bestätigt.');
    // Headers from conversation children may be outside the date query. The
    // caller filters real Received/Date values, never the relative UI labels.
    const byId=new Map();
    for(const item of found.values()) {
      const earlier=byId.get(item.messageId);
      if(earlier && earlier.sourceHash!==item.sourceHash) throw error('OUTLOOK_UI_DUPLICATE_ID','Mehrere unterschiedliche Nachrichten verwenden dieselbe Nachrichten-ID.');
      byId.set(item.messageId,item);
    }
    return partial?{items:[...byId.values()],known:[...found].map(([rowKey,item])=>({rowKey,item})),complete:true}:[...byId.values()];
  }
  async function resolve({from='foerderung@heat-hero.com',folder='Posteingang',messageId,description}={}) {
    if(messageId&&!rfcId(messageId)) throw error('OUTLOOK_UI_ID_MIGRATION_REQUIRED','Die ältere native Nachrichtenkennung besitzt noch keine verifizierte RFC-Zuordnung. Sie bleibt offen.');
    await open(from,folder);
    let view=await bridge(['mailbox-ui-list']);
    if(description) {
      const matches=view.rows.filter(r=>!r.conversation&&r.description===description&&folderMatches(description,folder));
      if(matches.length===1) {
        const item=await capture(from,folder,matches[0]);
        if(messageId&&item.messageId!==messageId) throw error('OUTLOOK_UI_SOURCE_ID_MISMATCH','Die Original-ID passt nicht zur offenen Mail.');
        return item;
      }
    }
    const key=messageId?await readFile(indexFile(messageId),'utf8').then(JSON.parse).catch(()=>null):null;
    if(!key||key.from!==from) throw error('OUTLOOK_UI_LOCATOR_REQUIRED','Zum Wiederfinden der Originalmail fehlt der verifizierte lokale Suchschlüssel.');
    const date=day(key.receivedAt||key.sentAt);
    const found=await search(from,folder,`subject:${queryValue(key.subject)} ${folder==='Gesendet'?'sent':'received'}:${date}`);
    const matches=found.filter(item=>item.messageId===messageId);
    if(matches.length>1) throw error('OUTLOOK_UI_SOURCE_AMBIGUOUS','Die Originalmail ist nicht eindeutig.');
    return matches[0]||{notFound:true,messageId,searchComplete:true};
  }
  async function page(input={}) {
    const {from='foerderung@heat-hero.com',folder='Posteingang',since=null,limit=100,mode='incremental'}=input;
    if(from!=='foerderung@heat-hero.com'||folder!=='Posteingang'||!Number.isInteger(limit)||limit<1||limit>200||!['incremental','initial-backfill'].includes(mode)) throw error('OUTLOOK_UI_SCOPE_DENIED','Ungültiger Förderpostfach-Leseauftrag.');
    let cursor=null;
    if(input.cursor) {
      try { if(input.cursor.length>3000)throw Error(); cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString()); } catch { throw error('OUTLOOK_UI_BAD_CURSOR','Der Outlook-UI-Cursor ist ungültig.'); }
      if(cursor.version!==2||cursor.source!=='outlook-ui-mime'||cursor.from!==from||cursor.folder!==folder||!['page','checkpoint'].includes(cursor.kind)) throw error('OUTLOOK_UI_BAD_CURSOR','Der Cursor gehört zu einem anderen Leseweg.');
    }
    const lower=cursor?.since??startTime(since),upper=cursor?.kind==='page'?cursor.until:now();
    if(!Number.isFinite(lower)||!Number.isFinite(upper)||lower>upper||upper>now()+60000) throw error('OUTLOOK_UI_BAD_RANGE','Ein überprüfbarer Startzeitpunkt oder Checkpoint ist erforderlich.');
    if(cursor?.kind==='checkpoint'&&mode!=='incremental') throw error('OUTLOOK_UI_BAD_CURSOR','Ein abgeschlossener Checkpoint gilt nur für inkrementelle Läufe.');
    const snapshotKey=hash(JSON.stringify({from,folder,lower,upper})),file=path.join(dataDir,'pages',snapshotKey+'.json');
    let snapshot=await readFile(file,'utf8').then(JSON.parse).catch(()=>null);
    const safeItem=x=>({messageId:x.messageId,receivedAt:x.receivedAt,sentAt:x.sentAt,sender:x.sender,subject:x.subject,attachments:x.attachments.map(({name,sha256,size,contentType,disposition})=>({name,sha256,size,contentType,disposition})),sourceHash:x.sourceHash});
    const known=snapshot?.known||[];
    if(!snapshot?.scanComplete) {
      const persist=async rows=>atomic(file,{lower,upper,scanComplete:false,known:rows.map(({rowKey,item})=>({rowKey,item:safeItem(item)})),messages:[]});
      const scan=await search(from,folder,`received:${day(lower)}..${day(upper)}`,{maximum:3000,budget:limit,known,onProgress:persist,partial:true});
      const items=scan.items;
      const messages=items.filter(x=>x.receivedAt&&Date.parse(x.receivedAt)>=lower&&Date.parse(x.receivedAt)<=upper).map(x=>({messageId:x.messageId,receivedAt:x.receivedAt,description:`Absender: ${x.sender.join(', ')}, Betreff: ${x.subject}, ${day(x.receivedAt)}, ${x.attachments.length?'Hat Dateien':'Keine Anlagen'}`,hasAttachments:x.attachments.length>0}));
      if(items.some(x=>!x.receivedAt)) throw error('OUTLOOK_UI_RECEIVED_TIME_MISSING','Mindestens einer Originalmail fehlt ein belegter Empfangszeitpunkt.');
      snapshot={lower,upper,scanComplete:scan.complete,known:scan.known.map(({rowKey,item})=>({rowKey,item:safeItem(item)})),messages}; await atomic(file,snapshot);
    }
    const offset=cursor?.kind==='page'?cursor.offset:0;
    if(!Number.isInteger(offset)||offset<0||offset>snapshot.messages.length) throw error('OUTLOOK_UI_BAD_CURSOR','Die gespeicherte Seitenposition ist ungültig.');
    const selected=snapshot.messages.slice(offset,offset+limit),complete=snapshot.scanComplete&&offset+selected.length===snapshot.messages.length;
    const base={version:2,source:'outlook-ui-mime',from,folder};
    return {messages:selected,complete,coverageVerified:true,source:'outlook-native',nextCursor:complete?null:encode({...base,kind:'page',since:lower,until:upper,offset:offset+selected.length}),checkpoint:complete?encode({...base,kind:'checkpoint',since:upper}):null,coverage:{since:new Date(lower).toISOString(),until:new Date(upper).toISOString(),scope:'outlook-ui-search-original-mime',messages:snapshot.messages.length},limitations:['Outlook-UI-Suche, kein serverseitiger Delta-Token. Später synchronisierte ältere Mails vor dem Checkpoint werden nicht durch einen täglichen Vollscan nachgeholt.']};
  }
  async function verify(input) {
    const from=String(input.from||'').toLowerCase(),before=Date.parse(input.notBefore),after=Date.parse(input.notAfter);
    if(!Number.isFinite(before)||!Number.isFinite(after)||after<before||!normalize(input.subject)) throw error('OUTLOOK_SENT_RANGE_REQUIRED','Gesendet-Prüfung benötigt Betreff und ein begrenztes unveränderliches Zeitfenster.');
    const items=await search(from,'Gesendet',`subject:${queryValue(input.subject)} sent:${day(before)}..${day(after)}`);
    const candidates=items.filter(x=>x.subject===normalize(input.subject)&&Date.parse(x.sentAt)>=before&&Date.parse(x.sentAt)<=after&&(!input.messageId||x.messageId===input.messageId));
    const matches=[];
    for(const item of candidates) {
      if(!equal(item.sender,[from])||!equal(item.recipients,emails(input.to))||!equal(item.cc,emails(input.cc))||!equal(item.bcc,emails(input.bcc)))continue;
      const expectedAttachments=await Promise.all((input.attachments||[]).map(async a=>typeof a==='string'?{name:path.basename(a),sha256:hash(await readFile(a))}:{name:a.name||a.filename,sha256:a.sha256}));
      const actualAttachments=item.attachments.filter(a=>a.disposition==='attachment').map(({name,sha256})=>({name,sha256}));
      if(!equal(actualAttachments.sort((a,b)=>a.name.localeCompare(b.name)),expectedAttachments.sort((a,b)=>a.name.localeCompare(b.name))))continue;
      const expectedBody=normalize(input.body),intro=normalize(input.introduction);
      if(expectedBody&&!intro&&(item.bodyType!=='text/plain'||item.bodyHash!==hash(expectedBody)))continue;
      if(intro&&(item.bodyType!=='text/plain'||!item.body.startsWith(intro)))continue;
      if(input.originalMessageId&&!item.originalMessageIds.includes(input.originalMessageId)&&!item.references.includes(input.originalMessageId))continue;
      matches.push({...item,attachments:actualAttachments,sender:from,introductionHash:intro?hash(intro):undefined,originalMessageId:input.originalMessageId});
    }
    if(matches.length>1) throw error('OUTLOOK_SENT_AMBIGUOUS','Mehrere gesendete Nachrichten passen zum selben Versandauftrag.');
    if(!matches.length) {
      if(candidates.length) throw error('OUTLOOK_SENT_CONTENT_MISMATCH','Eine Nachricht mit passendem Betreff und Zeitfenster hat andere Inhalte, Empfänger oder Anlagen.');
      return {verified:false,reason:'not_found',searchComplete:true,checkedAt:new Date(now()).toISOString()};
    }
    const {body,description,references,originalMessageIds,account,identityVerified,sourceHash,...proof}=matches[0];
    return {...proof,verified:true,folder:'Gesendet',checkedAt:new Date(now()).toISOString()};
  }
  const wrap=fn=>async input=>{await assertHost();return withLease(()=>fn(input));};
  return {resolveSourceIdentity:wrap(resolve),readByMessageId:wrap(resolve),readFundingMailboxPage:wrap(page),verifyFundingSentMessage:wrap(verify)};
}
const adapter=createOutlookUiMailbox();
export const resolveSourceIdentity=adapter.resolveSourceIdentity;
export const readByMessageId=adapter.readByMessageId;
export const readFundingMailboxPageViaUi=adapter.readFundingMailboxPage;
export const verifyFundingSentMessage=adapter.verifyFundingSentMessage;
