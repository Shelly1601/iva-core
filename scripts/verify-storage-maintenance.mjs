import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import {
  STORAGE_MAINTENANCE_INTERVAL_SECONDS,
  emptyCurrentUserTrash,
  pruneTerminalCodexTasks,
  runStorageMaintenance,
  storageMaintenancePaths,
} from '../local-mac-helper/storage-maintenance.mjs';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'iva-storage-maintenance-test-'));
const home = path.join(temporary, 'Users', 'nadine');
const root = path.join(home, 'Library', 'Application Support', 'IVA Mac Helper');
const paths = storageMaintenancePaths({ home, root });
await mkdir(path.join(paths.trash, 'nested'), { recursive: true });
await writeFile(path.join(paths.trash, 'nested', 'video.tmp'), Buffer.alloc(4096));
await writeFile(path.join(paths.trash, 'single.tmp'), Buffer.alloc(2048));

const now = new Date('2026-08-29T08:00:00.000Z');
const oldCompleted = path.join(paths.codexTasks, 'old-completed');
const recentCompleted = path.join(paths.codexTasks, 'recent-completed');
const active = path.join(paths.codexTasks, 'active');
for (const directory of [oldCompleted, recentCompleted, active]) await mkdir(directory, { recursive: true });
await writeFile(path.join(oldCompleted, 'state.json'), JSON.stringify({ status: 'completed', updatedAt: '2026-06-01T08:00:00.000Z' }));
await writeFile(path.join(recentCompleted, 'state.json'), JSON.stringify({ status: 'completed', updatedAt: '2026-08-20T08:00:00.000Z' }));
await writeFile(path.join(active, 'state.json'), JSON.stringify({ status: 'running', updatedAt: '2026-01-01T08:00:00.000Z' }));
await writeFile(path.join(oldCompleted, 'result.txt'), Buffer.alloc(8192));

const trashPreview = await emptyCurrentUserTrash({ paths, commit: false });
assert.equal(trashPreview.entryCount, 2);
assert.equal(trashPreview.deletedCount, 0);
assert.equal((await readFile(path.join(paths.trash, 'single.tmp'))).byteLength, 2048);
const taskPreview = await pruneTerminalCodexTasks({ paths, commit: false, now: now.getTime() });
assert.equal(taskPreview.candidateCount, 1);

const result = await runStorageMaintenance({ paths, commit: true, now });
assert.equal(result.mode, 'commit');
assert.equal(result.trash.entryCount, 2);
assert.equal(result.codexTasks.candidateCount, 1);
await assert.rejects(() => access(oldCompleted));
await access(recentCompleted);
await access(active);
assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(paths.trash)), []);
const audit = await readFile(paths.auditLog, 'utf8');
assert.doesNotMatch(audit, /video\.tmp|single\.tmp|old-completed/);

await writeFile(path.join(paths.trash, 'blocked.tmp'), Buffer.alloc(512));
await writeFile(path.join(paths.trash, 'deleteable.tmp'), Buffer.alloc(512));
const partial = await emptyCurrentUserTrash({
  paths,
  commit: true,
  removeEntry: async target => {
    if (target.endsWith('blocked.tmp')) throw Object.assign(new Error('blocked'), { code: 'EACCES' });
    await import('node:fs/promises').then(fs => fs.rm(target, { force: true }));
  },
});
assert.equal(partial.deletedCount, 1);
assert.equal(partial.failedCount, 1);
assert.deepEqual(partial.failureCodes, ['EACCES']);
assert.doesNotMatch(JSON.stringify(partial), /blocked\.tmp|deleteable\.tmp/);

assert.equal(STORAGE_MAINTENANCE_INTERVAL_SECONDS, 172800);

console.log('Storage maintenance verification passed.');
