import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFundingFileLock } from '../local-mac-helper/funding-intake-state.mjs';

const queues = new Map();
export function createKnowledgeResearchStore({ file = path.join(process.env.DATA_DIR || '/data', 'knowledge-research.json') } = {}) {
  file = path.resolve(file);
  async function load() {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 12_000_000) throw new Error('Ungültige Rechercheablage.');
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.plans)) throw new Error('Ungültige Rechercheablage.');
      return data;
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, plans: [] }; throw error; }
  }
  async function read() { await queues.get(file); return structuredClone(await load()); }
  async function mutate(fn) {
    const task = (queues.get(file) || Promise.resolve()).catch(() => {}).then(() => withFundingFileLock(file, async () => {
      const data = await load(), result = await fn(data), text = JSON.stringify(data);
      if (Buffer.byteLength(text) > 12_000_000) throw new Error('Die Rechercheablage ist voll.');
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      return structuredClone(result);
    }));
    const settled = task.catch(() => {}); queues.set(file, settled);
    void settled.then(() => { if (queues.get(file) === settled) queues.delete(file); });
    return task;
  }
  return { file, read, mutate };
}
