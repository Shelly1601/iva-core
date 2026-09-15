import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const operationalError = (message, status = 400) => Object.assign(new Error(message), { status });
export function operationalId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) throw operationalError('Ungültige Kennung.');
  return value;
}
const queues = new Map();
export function createProjectStore({dataDir, name, getProject, initial}) {
  operationalId(name); if (!path.isAbsolute(dataDir || '')) throw new Error('Absolute data directory required');
  const root = path.join(dataDir, name);
  async function prepare(id) {
    operationalId(id); if (!await getProject(id)) throw operationalError('Projekt nicht verfügbar.', 404);
    await fs.mkdir(root, {recursive:true, mode:0o700});
    const info = await fs.lstat(root); if (!info.isDirectory() || info.isSymbolicLink()) throw operationalError('Ablage nicht verfügbar.', 503);
    return path.join(root, id + '.json');
  }
  async function load(file, id) {
    try {
      const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8_000_000) throw new Error('invalid file');
      const data = JSON.parse(await fs.readFile(file,'utf8'));
      if (data.projectId !== id || data.version !== 1) throw new Error('invalid state');
      return data;
    } catch(e) { if(e.code === 'ENOENT') return {...initial(),projectId:id,version:1}; throw operationalError('Gespeicherte Daten können nicht sicher geladen werden.',503); }
  }
  async function read(id) { const file=await prepare(id);await queues.get(file);return structuredClone(await load(file,id)); }
  async function mutate(id, fn) {
    const file=await prepare(id);
    const job=(queues.get(file)||Promise.resolve()).catch(()=>{}).then(async()=>{
      const lock=file+'.lock', nonce=randomUUID();let handle;
      const busy=()=>operationalError('Ein Speichervorgang läuft oder wurde unterbrochen. Den unveränderten Vorgang erneut speichern.',409);
      const readOwner=()=>fs.readFile(lock,'utf8').then(JSON.parse).catch(()=>null);
      try {
        handle=await fs.open(lock,'wx',0o600);
        try { await handle.writeFile(JSON.stringify({pid:process.pid,nonce})); }
        catch(error) { await handle.close(); handle=null; await fs.unlink(lock).catch(()=>{}); throw error; }
      } catch(e) {
        if(e.code!=='EEXIST')throw e;
        // Only one stale-lock reaper may inspect/remove a dead owner's claim.
        // Normal writers cannot replace that claim until it has been removed.
        const recovery=lock+'.recovery';let recovering=false;
        try {
          await fs.mkdir(recovery,{mode:0o700});recovering=true;
          const owner=await readOwner();
          if(Number.isInteger(owner?.pid)&&owner.pid>0){
            try {process.kill(owner.pid,0);}
            catch(probe){
              if(probe.code==='ESRCH'){
                const current=await readOwner();
                if(current?.pid===owner.pid && current?.nonce===owner.nonce)await fs.unlink(lock).catch(error=>{if(error.code!=='ENOENT')throw error;});
              }
            }
          }
        } catch(recoveryError) {if(recoveryError.code!=='EEXIST')throw recoveryError;}
        finally {if(recovering)await fs.rmdir(recovery).catch(()=>{});}
        throw busy();
      }
      try {
        const data=await load(file,id), result=await fn(data);const text=JSON.stringify(data);
        if(Buffer.byteLength(text)>8_000_000)throw operationalError('Die Ablage ist voll.',507);
        await prepare(id);const temp=file+'.'+randomUUID()+'.tmp';
        try{await fs.writeFile(temp,text,{flag:'wx',mode:0o600});await fs.rename(temp,file);}finally{await fs.unlink(temp).catch(()=>{});}
        return structuredClone(result);
      }finally{await handle?.close();const owner=await readOwner();if(owner?.nonce===nonce && owner?.pid===process.pid)await fs.unlink(lock).catch(()=>{});}
    });
    const settled=job.catch(()=>{});queues.set(file,settled);void settled.then(()=>{if(queues.get(file)===settled)queues.delete(file);});return job;
  }
  return {read,mutate};
}
