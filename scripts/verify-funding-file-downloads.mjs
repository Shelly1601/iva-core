import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'iva-funding-download-test-'));
process.env.IVA_MAC_HELPER_DATA_DIR=root;
const {downloadPipedriveDealFiles}=await import('../local-mac-helper/background-integrations.mjs');
after(()=>fs.rm(root,{recursive:true,force:true}));
const records=[{id:'21',name:'Angebot.pdf'},{id:'22',name:'Angebot.pdf'}];
const dependencies={
 readSnapshot:async()=>({fileRecords:records}),
 downloadFile:async(id,fileId)=>({buffer:Buffer.from('%PDF-distinct-'+fileId),contentType:'application/pdf'}),
};
test('different deal files sharing a display name both survive download with exact ID mapping',async()=>{
 const result=await downloadPipedriveDealFiles({dealId:'123'},dependencies);
 assert.equal(result.complete,true);assert.equal(result.downloadedCount,2);
 assert.equal(new Set(result.files.map(x=>x.filePath)).size,2);
 for(const f of result.files){assert.equal(f.originalName,'Angebot.pdf');assert.equal(await fs.readFile(f.filePath,'utf8'),'%PDF-distinct-'+f.id);}
});
test('a missing or failed file cannot yield a complete download',async()=>{
 await assert.rejects(downloadPipedriveDealFiles({dealId:'123',fileIds:['99']},dependencies),/gehört nicht/);
 const result=await downloadPipedriveDealFiles({dealId:'123'},{...dependencies,downloadFile:async(id,fileId)=>{if(fileId==='22')throw new Error('fixture download failed');return dependencies.downloadFile(id,fileId);}});
 assert.equal(result.complete,false);assert.equal(result.failedCount,1);assert.equal(result.failedFiles[0].id,'22');assert.equal(result.files.length,1);
});
