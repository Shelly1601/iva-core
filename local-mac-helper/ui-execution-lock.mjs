import os from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';

const defaultRoot = path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper', 'ui-execution-lock');
export function imacUiIsBusy() {
  try { const owner = JSON.parse(readFileSync(path.join(defaultRoot, 'owner.json'), 'utf8')); process.kill(owner.pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export async function withImacExecutionLock(task, { root = defaultRoot, timeoutMs = 3 * 60 * 60_000, pollMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      await mkdir(root, { mode: 0o700 });
      await writeFile(path.join(root, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readFile(path.join(root, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null);
      const age = Date.now() - (await stat(root).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
      let alive = true;
      if (owner?.pid) { try { process.kill(owner.pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; } }
      if ((!owner && age > 10_000) || (owner && !alive)) { await rm(root, { recursive: true, force: true }); continue; }
      if (Date.now() >= deadline) throw new Error('Der iMac ist noch durch einen anderen Auftrag belegt; es wurde keine zweite UI-Aktion gestartet.');
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }
  try { return await task(); }
  finally { await rm(root, { recursive: true, force: true }); }
}
