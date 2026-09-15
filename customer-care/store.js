import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const queues = new Map();
export const careError = (message, status = 400, code = 'CUSTOMER_CARE_INVALID') => Object.assign(new Error(message), { status, statusCode: status, code });
export function careId(value, label = 'Kennung') {
  const id = String(value ?? '').trim();
  if (['constructor', 'prototype', '__proto__'].includes(id) || !/^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,159}$/.test(id)) throw careError(`${label} ist ungültig.`);
  return id;
}
const emptyProject = id => ({ id, settings: null, customers: {}, contracts: [], campaigns: [], tokens: [], outbox: [], notifications: [] });

export function createCustomerCareStore({ dataDir } = {}) {
  if (!dataDir || !path.isAbsolute(dataDir)) throw careError('Ein absoluter Datenordner für die Kundenbetreuung fehlt.');
  const directory = path.join(dataDir, 'customer-care'), file = path.join(directory, 'state.json'), lock = path.join(directory, 'write.lock');
  async function read() {
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 20 * 1024 * 1024) throw careError('Die Kundenbetreuungsdaten sind nicht sicher lesbar.', 503);
      const state = JSON.parse(await fs.readFile(file, 'utf8'));
      if (state.version !== 1 || !state.projects || typeof state.projects !== 'object' || Array.isArray(state.projects)) throw careError('Die Kundenbetreuungsdaten sind ungültig.', 503);
      return state;
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, projects: {} }; throw error; }
  }
  async function locked(action) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw careError('Ungültiger Datenordner.', 503);
    const owner = { pid: process.pid, nonce: randomUUID() }, deadline = Date.now() + 5000;
    for (;;) {
      try { const handle = await fs.open(lock, 'wx', 0o600); try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); } finally { await handle.close(); } break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Only reclaim a lock whose process is proved gone; uncertainty stays queued.
        let old; try { old = JSON.parse(await fs.readFile(lock, 'utf8')); } catch {}
        if (Number.isInteger(old?.pid) && old.pid > 0) {
          try { process.kill(old.pid, 0); } catch (probe) {
            if (probe.code === 'ESRCH') {
              const recovery = `${lock}.recovery`;
              try {
                await fs.mkdir(recovery, { mode: 0o700 });
                try { const latest = JSON.parse(await fs.readFile(lock, 'utf8')); if (latest.nonce === old.nonce) await fs.unlink(lock); } catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
                finally { await fs.rmdir(recovery); }
              } catch (recoverError) { if (!['EEXIST', 'ENOENT'].includes(recoverError.code)) throw recoverError; }
              continue;
            }
          }
        }
        if (Date.now() > deadline) throw careError('Die Kundenbetreuung wird gerade aktualisiert. Bitte denselben Vorgang erneut aufrufen.', 409, 'CUSTOMER_CARE_BUSY');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try { return await action(); } finally { const current = await fs.readFile(lock, 'utf8').then(JSON.parse).catch(() => null); if (current?.nonce === owner.nonce) await fs.unlink(lock).catch(() => {}); }
  }
  async function mutate(action) {
    const pending = (queues.get(file) || Promise.resolve()).catch(() => {}).then(() => locked(async () => {
      const state = await read(), result = await action(state), body = JSON.stringify(state);
      if (Buffer.byteLength(body) > 20 * 1024 * 1024 || Object.keys(state.projects).length > 2000) throw careError('Der Speicher für Kundenbetreuung ist voll; vorhandene Vorgänge bleiben erhalten.', 507);
      const temporary = `${file}.${randomUUID()}.tmp`, handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
      try { await fs.rename(temporary, file); } finally { await fs.unlink(temporary).catch(() => {}); }
      return structuredClone(result);
    }));
    queues.set(file, pending); return pending;
  }
  return {
    async read(projectId) { const id = careId(projectId, 'Projekt'); const state = await read(); return structuredClone(state.projects[id] || emptyProject(id)); },
    async listProjectIds() { return Object.keys((await read()).projects); },
    transaction(projectId, action) { const id = careId(projectId, 'Projekt'); return mutate(state => { state.projects[id] ||= emptyProject(id); return action(state.projects[id]); }); },
    async findToken(hash) { const state = await read(); for (const project of Object.values(state.projects)) { const token = project.tokens.find(item => item.hash === hash); if (token) return { projectId: project.id, token: structuredClone(token) }; } return null; },
    async findDelivery(id) { const state = await read(); for (const project of Object.values(state.projects)) { const row = project.outbox.find(item => item.id === id); if (row) return { projectId: project.id, delivery: structuredClone(row) }; } return null; },
  };
}
