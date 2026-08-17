import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(here, '../outputs/pipedrive-custom-audience-2026-08-15');
const defaultQueuePath = path.join(outputDir, 'id-explicit-download-queue.json');
const defaultWorkDir = path.join(outputDir, 'id-docs-work');
const defaultManifestPath = path.join(outputDir, 'id-explicit-download-manifest.json');
const watchOnly = process.argv[2] === 'watch';
const directMode = process.argv[2] === 'direct';
const signedMode = process.argv[2] === 'signed';
const signedFileMode = process.argv[2] === 'signedfile';
const signedLoopMode = process.argv[2] === 'signedloop';
const queuePath = signedFileMode && process.argv[6] ? path.resolve(process.argv[6]) : defaultQueuePath;
const workDir = signedFileMode && process.argv[7] ? path.resolve(process.argv[7]) : defaultWorkDir;
const manifestPath = signedFileMode && process.argv[8] ? path.resolve(process.argv[8]) : defaultManifestPath;
const startIndex = (watchOnly || directMode || signedMode || signedFileMode) ? process.argv[3] : process.argv[2];
const limitIndex = (watchOnly || directMode || signedMode || signedFileMode) ? process.argv[4] : process.argv[3];
const start = String(Math.max(0, Number(startIndex) || 0));
const limit = String(Math.max(1, Number(limitIndex) || 25));

function run(script, args, cwd) {
  const child = spawn(process.execPath, [script, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => process.stdout.write(chunk));
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  const promise = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(script)} beendet mit Code ${code}`)));
  });
  return { child, promise };
}

if (signedLoopMode) {
  const loopStart = Math.max(0, Number(process.argv[3]) || 0);
  const loopTotal = Math.max(loopStart, Number(process.argv[4]) || 0);
  const loopBlockSize = Math.max(1, Number(process.argv[5]) || 20);
  const signedDir = path.resolve(process.argv[6] || '/private/tmp');
  const genericQueuePath = process.argv[7] ? path.resolve(process.argv[7]) : path.join(outputDir, 'id-generic-download-queue.json');
  const genericWorkDir = process.argv[8] ? path.resolve(process.argv[8]) : path.join(outputDir, 'id-docs-generic');
  const genericManifestPath = process.argv[9] ? path.resolve(process.argv[9]) : path.join(outputDir, 'id-generic-download-manifest.json');
  const signedPrefix = process.argv[10] || 'iva-generic-signed-';
  for (let blockStart = loopStart; blockStart < loopTotal; blockStart += loopBlockSize) {
    const blockCount = Math.min(loopBlockSize, loopTotal - blockStart);
    const signedPayloadFile = path.join(signedDir, `${signedPrefix}${String(blockStart).padStart(4, '0')}.json`);
    const child = run(fileURLToPath(import.meta.url), [
      'signedfile', String(blockStart), String(blockCount), signedPayloadFile,
      genericQueuePath, genericWorkDir, genericManifestPath,
    ], here);
    await child.promise;
    console.log(JSON.stringify({ downloaded: blockStart + blockCount, total: loopTotal }));
  }
  process.exit(0);
}

function runAppleScript(script) {
  const child = spawn('/usr/bin/osascript', ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(script);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error((stderr || stdout).trim())));
  });
}

if (directMode || signedMode || signedFileMode) {
  const signedPayloadFile = signedFileMode ? path.resolve(process.argv[5] || '') : null;
  const inputPayload = signedFileMode ? await readFile(signedPayloadFile, 'utf8') : await new Promise(resolve => {
    const keepAlive = setInterval(() => {}, 1000);
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    const onData = chunk => {
      value += String(chunk);
      if (!value.includes('\n')) return;
      clearInterval(keepAlive);
      process.stdin.off('data', onData);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      resolve(value.slice(0, value.indexOf('\n')).trim());
    };
    process.stdin.on('data', onData);
  });
  if (!inputPayload) throw new Error('Pipedrive-Downloaddaten fehlen.');
  const sessionToken = directMode ? inputPayload : null;
  let signedUrls = new Map();
  if (signedMode || signedFileMode) {
    try {
      signedUrls = new Map(JSON.parse(inputPayload).map(item => [String(item.fileId), String(item.signedUrl)]));
    } catch {
      throw new Error('Signierte Pipedrive-Downloaddaten sind unvollständig.');
    }
  }
  const queue = JSON.parse(await readFile(queuePath, 'utf8'));
  const batch = queue.slice(Number(start), Number(start) + Number(limit));
  if (!batch.length) throw new Error('Der direkte Download-Block ist leer.');
  await mkdir(workDir, { recursive: true });
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch { manifest = { generatedAt: null, records: [] }; }
  const existingIds = new Set((manifest.records || []).map(record => String(record.fileId)));
  const safePart = value => String(value || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  let processed = 0;
  for (const item of batch) {
    if (existingIds.has(String(item.fileId))) {
      processed += 1;
      console.log(JSON.stringify({ processed, total: batch.length, fileId: item.fileId, skipped: true }));
      continue;
    }
    const originalExtension = path.extname(item.name || '').toLowerCase() || '.bin';
    const baseName = safePart(path.basename(item.name || 'ausweis', path.extname(item.name || '')));
    const targetName = [
      String(item.seq).padStart(4, '0'),
      `deal-${safePart(item.dealId)}`,
      `file-${safePart(item.fileId)}`,
      baseName || 'ausweis',
    ].join('-') + originalExtension;
    const targetPath = path.join(workDir, targetName);
    const downloadUrl = (signedMode || signedFileMode)
      ? signedUrls.get(String(item.fileId))
      : 'https://simplegategmbh.pipedrive.com/v1/files/'
        + encodeURIComponent(item.fileId)
        + '/download?session_token=' + encodeURIComponent(sessionToken);
    if (!downloadUrl) throw new Error(`${item.fileId}: signierte Downloadadresse fehlt`);
    const response = await fetch(downloadUrl, { redirect: 'follow' });
    if (!response.ok) throw new Error(`${item.fileId}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error(`${item.fileId}: leere Datei`);
    await writeFile(targetPath, bytes);
    const saved = await stat(targetPath);
    manifest.records.push({ ...item, localPath: targetPath, downloadedAt: new Date().toISOString(), downloadedBytes: saved.size, error: null });
    manifest.generatedAt = new Date().toISOString();
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    existingIds.add(String(item.fileId));
    processed += 1;
    console.log(JSON.stringify({ processed, total: batch.length, fileId: item.fileId, bytes: saved.size }));
  }
  if (signedFileMode) await unlink(signedPayloadFile).catch(() => {});
  console.log(JSON.stringify({ complete: true, mode: signedMode || signedFileMode ? 'signed' : 'direct', start: Number(start), limit: batch.length, workDir, manifestPath }));
  process.exit(0);
}

if (watchOnly) {
  const watcherOnly = run(
    path.join(outputDir, 'watch-id-downloads.mjs'),
    [queuePath, workDir, manifestPath, start, limit],
    outputDir,
  );
  await watcherOnly.promise;
  console.log(JSON.stringify({ complete: true, mode: 'watch-only', start: Number(start), limit: Number(limit), workDir, manifestPath }));
  process.exit(0);
}

const tabState = await runAppleScript(`tell application "Google Chrome"
activate
repeat with w in windows
  repeat with t in tabs of w
    if (URL of t) contains "simplegategmbh.pipedrive.com/deal/541" then return "EXISTING"
  end repeat
end repeat
make new tab at end of tabs of front window with properties {URL:"https://simplegategmbh.pipedrive.com/deal/541"}
return "CREATED"
end tell`);
await new Promise(resolve => setTimeout(resolve, 3500));

const watcher = run(
  path.join(outputDir, 'watch-id-downloads.mjs'),
  [queuePath, workDir, manifestPath, start, limit],
  outputDir,
);
await new Promise(resolve => setTimeout(resolve, 750));
const trigger = run(
  path.join(here, 'trigger-pipedrive-id-downloads.mjs'),
  [start, limit],
  here,
);

try {
  await Promise.all([watcher.promise, trigger.promise]);
} catch (error) {
  if (watcher.child.exitCode == null) watcher.child.kill('SIGTERM');
  if (trigger.child.exitCode == null) trigger.child.kill('SIGTERM');
  throw error;
} finally {
  if (tabState === 'CREATED') {
    await runAppleScript(`tell application "Google Chrome"
repeat with w in windows
  set tabCount to count of tabs of w
  repeat with i from tabCount to 1 by -1
    set t to tab i of w
    if (URL of t) contains "simplegategmbh.pipedrive.com/deal/541" then close t
  end repeat
end repeat
end tell`).catch(() => {});
  }
}
console.log(JSON.stringify({ complete: true, start: Number(start), limit: Number(limit), workDir, manifestPath }));
