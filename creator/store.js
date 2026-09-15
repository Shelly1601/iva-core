import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const queues = new Map();
export const creatorError = (message, status = 400, code = 'CREATOR_INVALID') => Object.assign(new Error(message), { status, statusCode: status, code });
export function creatorId(value, label = 'Kennung') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value) || ['constructor', 'prototype', '__proto__'].includes(value)) throw creatorError(`${label} ist ungültig.`);
  return value;
}
export const creatorText = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const empty = projectId => ({ version: 1, projectId, products: [], jobs: [] });

// Each project is an independently bounded, atomic file. A process lock covers
// read-modify-write; model calls never hold it. Existing versions are append-only.
export function createCreatorStore({ dataDir, getProject }) {
  if (!path.isAbsolute(dataDir || '') || typeof getProject !== 'function') throw creatorError('Creator benötigt Datenordner und Projektprüfung.');
  const directory = path.join(dataDir, 'creator');
  async function project(projectId) { creatorId(projectId, 'Projekt'); const p = await getProject(projectId); if (!p) throw creatorError('Projekt nicht verfügbar.', 404); return p; }
  async function directoryReady() { await fs.mkdir(directory, { recursive: true, mode: 0o700 }); const info = await fs.lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw creatorError('Creator-Ablage ist nicht verfügbar.', 503); }
  async function load(id) {
    await directoryReady();
    const file = path.join(directory, `${id}.json`);
    try {
      const info = await fs.lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 48 * 1024 * 1024) throw creatorError('Creator-Ablage ist nicht sicher lesbar.', 503);
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (data.version !== 1 || data.projectId !== id || !Array.isArray(data.products) || !Array.isArray(data.jobs)) throw creatorError('Creator-Ablage ist beschädigt.', 503);
      return data;
    } catch (e) { if (e.code === 'ENOENT') return empty(id); throw creatorError('Creator-Ablage ist nicht verfügbar.', 503); }
  }
  async function locked(id, fn) {
    await directoryReady();
    const lock = path.join(directory, `${id}.lock`), nonce = randomUUID(), deadline = Date.now() + 5000;
    for (;;) {
      try { const handle = await fs.open(lock, 'wx', 0o600); try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); await handle.sync(); } finally { await handle.close(); } break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const old = await fs.readFile(lock, 'utf8').then(JSON.parse).catch(() => null);
        if (Number.isInteger(old?.pid) && old.pid > 0) {
          try { process.kill(old.pid, 0); } catch (probe) {
            if (probe.code === 'ESRCH') {
              try { await fs.mkdir(`${lock}.recovery`); try { const current = await fs.readFile(lock, 'utf8').then(JSON.parse); if (current.nonce === old.nonce) await fs.unlink(lock); } finally { await fs.rmdir(`${lock}.recovery`); } } catch (recovery) { if (!['ENOENT', 'EEXIST'].includes(recovery.code)) throw recovery; }
              continue;
            }
          }
        }
        if (Date.now() > deadline) throw creatorError('Creator wird gerade gespeichert. Bitte denselben Vorgang erneut aufrufen.', 409, 'CREATOR_BUSY');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try { return await fn(); } finally { const owner = await fs.readFile(lock, 'utf8').then(JSON.parse).catch(() => null); if (owner?.nonce === nonce) await fs.unlink(lock).catch(() => {}); }
  }
  async function mutate(id, fn) {
    await project(id); const file = path.join(directory, `${id}.json`);
    const pending = (queues.get(file) || Promise.resolve()).catch(() => {}).then(() => locked(id, async () => {
      await project(id); const state = await load(id), result = await fn(state);
      const body = JSON.stringify(state);
      if (Buffer.byteLength(body) > 48 * 1024 * 1024 || state.products.length > 100 || state.jobs.length > 500) throw creatorError('Die Creator-Ablage ist voll. Vorhandene Fassungen bleiben erhalten.', 507);
      await project(id); const temp = `${file}.${randomUUID()}.tmp`;
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
      try { await fs.rename(temp, file); } finally { await fs.unlink(temp).catch(() => {}); }
      return structuredClone(result);
    }));
    const tail = pending.catch(() => {}); queues.set(file, tail); void tail.then(() => { if (queues.get(file) === tail) queues.delete(file); }); return pending;
  }
  async function read(id) { await project(id); await (queues.get(path.join(directory, `${id}.json`)) || Promise.resolve()); const state = await load(id); await project(id); return structuredClone(state); }
  return { project, read, mutate };
}
