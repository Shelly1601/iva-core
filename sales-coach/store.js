import fs from 'node:fs/promises';
import path from 'node:path';
export const clean = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export const fail = (message, status = 400, code = 'SALES_COACH_ERROR') => Object.assign(new Error(message), { status, code });
export function createCoachStore(dataDir) {
  const file = path.join(dataDir, 'sales-coach.json'); let queue = Promise.resolve();
  async function read() { try { const data = JSON.parse(await fs.readFile(file, 'utf8')); if (!Array.isArray(data.sessions)) throw Error('invalid'); return data; } catch (error) { if (error.code === 'ENOENT') return {version:1,sessions:[]}; throw fail('Gesprächsspeicher ist nicht lesbar. Es wird nichts überschrieben.', 503); } }
  async function mutate(fn) { const job = queue.catch(()=>{}).then(async()=>{const data=await read(),result=await fn(data);await fs.mkdir(dataDir,{recursive:true});const temporary=file+'.'+process.pid+'.tmp';await fs.writeFile(temporary,JSON.stringify(data),{mode:0o600});await fs.rename(temporary,file);return structuredClone(result);});queue=job.catch(()=>{});return job; }
  return {read:async()=>{await queue;return read();},mutate};
}
