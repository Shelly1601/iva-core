import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const startAt = Number(process.argv[2] || 0);
const total = Number(process.argv[3] || 0);
const blockSize = Number(process.argv[4] || 20);
const signedDir = process.argv[5] || '/private/tmp';
const queuePath = '../outputs/pipedrive-custom-audience-2026-08-15/id-generic-download-queue.json';
const workDir = '../outputs/pipedrive-custom-audience-2026-08-15/id-docs-generic';
const manifestPath = '../outputs/pipedrive-custom-audience-2026-08-15/id-generic-download-manifest.json';

if (!Number.isInteger(startAt) || !Number.isInteger(total) || total <= startAt) {
  throw new Error('Usage: node download-pipedrive-generic-signed-loop.mjs <start> <total> [block-size] [signed-dir]');
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] });
  let error = '';
  child.stderr.on('data', chunk => { error += chunk.toString(); });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve() : reject(new Error(error || `Download-Block endete mit ${code}`)));
});

for (let start = startAt; start < total; start += blockSize) {
  const count = Math.min(blockSize, total - start);
  const signedFile = path.join(signedDir, `iva-generic-signed-${String(start).padStart(3, '0')}.json`);
  const deadline = Date.now() + 20 * 60 * 1000;
  while (true) {
    try {
      await access(signedFile);
      const signed = JSON.parse(await readFile(signedFile, 'utf8'));
      if (signed.length !== count) throw new Error(`${signedFile}: ${signed.length} statt ${count} URLs`);
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await sleep(800);
    }
  }
  await run([
    'run-pipedrive-id-download-batch.mjs', 'signedfile', String(start), String(count), signedFile,
    queuePath, workDir, manifestPath,
  ]);
  process.stdout.write(`${start + count}/${total} heruntergeladen\n`);
}
