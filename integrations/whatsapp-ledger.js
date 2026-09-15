import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const tails = new Map();
export const whatsAppError = (message, status = 400, code = 'WHATSAPP_INVALID') => Object.assign(new Error(message), { status, code });
export function createWhatsAppLedger({ dataDir }) {
  if (!path.isAbsolute(dataDir || '')) throw whatsAppError('Ein absoluter Datenordner fehlt.');
  const file = path.join(dataDir, 'whatsapp-automation.json'), lock = file + '.lock';
  async function read() {
    try { const info = await fs.lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 30 * 1024 * 1024) throw new Error(); const data = JSON.parse(await fs.readFile(file, 'utf8')); if (data.version !== 1 || !data.inbound || !data.conversations || !data.bookings || !data.outbound) throw new Error(); return data; }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, inbound: {}, conversations: {}, bookings: {}, outbound: {}, checks: {} }; throw whatsAppError('WhatsApp-Ablage ist nicht sicher lesbar.', 503); }
  }
  async function locked(fn) {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 }); const owner = { pid: process.pid, nonce: randomUUID() }, until = Date.now() + 5000;
    for (;;) {
      try { const handle = await fs.open(lock, 'wx', 0o600); try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); } finally { await handle.close(); } break; }
      catch (e) { if (e.code !== 'EEXIST') throw e; const old = await fs.readFile(lock, 'utf8').then(JSON.parse).catch(() => null); if (old?.pid > 0) { try { process.kill(old.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') { try { await fs.mkdir(lock + '.recovery'); try { const latest = await fs.readFile(lock, 'utf8').then(JSON.parse); if (latest.nonce === old.nonce) await fs.unlink(lock); } finally { await fs.rmdir(lock + '.recovery'); } } catch (recovery) { if (!['EEXIST', 'ENOENT'].includes(recovery.code)) throw recovery; } continue; } } } if (Date.now() > until) throw whatsAppError('WhatsApp wird gerade aktualisiert.', 409); await new Promise(r => setTimeout(r, 20)); }
    }
    try { return await fn(); } finally { const latest = await fs.readFile(lock, 'utf8').then(JSON.parse).catch(() => null); if (latest?.nonce === owner.nonce) await fs.unlink(lock).catch(() => {}); }
  }
  function transaction(fn) {
    const pending = (tails.get(file) || Promise.resolve()).catch(() => {}).then(() => locked(async () => { const state = await read(), result = await fn(state), body = JSON.stringify(state); if (Buffer.byteLength(body) > 30 * 1024 * 1024 || Object.keys(state.inbound).length > 50000) throw whatsAppError('WhatsApp-Ablage ist voll; vorhandene Vorgänge bleiben erhalten.', 507); const temp = file + '.' + randomUUID() + '.tmp', handle = await fs.open(temp, 'wx', 0o600); try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); } try { await fs.rename(temp, file); } finally { await fs.unlink(temp).catch(() => {}); } return structuredClone(result); }));
    const tail = pending.catch(() => {}); tails.set(file, tail); void tail.then(() => { if (tails.get(file) === tail) tails.delete(file); }); return pending;
  }
  return { read: async () => structuredClone(await read()), transaction };
}
