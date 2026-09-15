import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { assertImacExecutionHost } from './imac-host-guard.mjs';
import { withFundingFileLock } from './funding-intake-state.mjs';

const exec = promisify(execFile);
const root = path.join(os.homedir(), 'Library/Application Support/IVA Mac Helper');
export const FUNDING_TRASH_LABEL = 'de.iva.daily-trash';
const receiptPath = path.join(root, 'daily-trash.json');
const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dayOf = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

export function buildDailyTrashLaunchAgent({ nodePath = process.execPath, helperRoot = root, helperPath = path.join(helperRoot, 'runtime/central/current/local-mac-helper/funding-trash.mjs') } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${FUNDING_TRASH_LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(helperPath)}</string><string>run</string></array>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>0</integer><key>Minute</key><integer>30</integer></dict>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(path.join(helperRoot, 'logs/daily-trash.out.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(helperRoot, 'logs/daily-trash.err.log'))}</string>
</dict></plist>`;
}

async function writeAtomic(file, content) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    const directory = await open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function emptyDailyTrash({ now = new Date(), file = receiptPath, execute = exec, assertHost = assertImacExecutionHost } = {}) {
  await assertHost();
  const day = dayOf(now), receipt = path.resolve(file);
  // Serialize the entire check/action/readback transaction across worker
  // processes, so concurrent timer/manual invocations cannot empty twice.
  return withFundingFileLock(receipt, async () => {
    const previous = await readFile(receipt, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (previous && (!/^\d{4}-\d{2}-\d{2}$/.test(previous.day || '') || previous.verified !== true || previous.remainingItems !== 0 || !Number.isSafeInteger(previous.removedItems) || previous.removedItems < 0 || !Number.isFinite(Date.parse(previous.checkedAt)))) throw new Error('Der gespeicherte Papierkorb-Nachweis ist ungültig; keine neue Leerung.');
    if (previous?.day === day) return { ...previous, duplicate: true };
    // Nadine explicitly requested emptying the whole user Trash daily. This is
    // separate from deleting replacement copies in the managed funding folder.
    const { stdout } = await execute('/usr/bin/osascript', ['-e', 'tell application "Finder"\nset beforeCount to count items of trash\nif beforeCount > 0 then empty trash\nset remainingCount to count items of trash\nreturn (beforeCount as text) & ":" & (remainingCount as text)\nend tell'], { timeout: 120000, maxBuffer: 1024 });
    const match = String(stdout).trim().match(/^(\d+):(\d+)$/);
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[2]) !== 0) throw new Error('Der tägliche Papierkorb-Lauf hat noch keinen bestätigten leeren Zielzustand.');
    const result = { day, checkedAt: now.toISOString(), removedItems: Number(match[1]), remainingItems: 0, verified: true };
    await writeAtomic(receipt, JSON.stringify(result));
    return result;
  });
}

export async function installDailyTrash({ execute = exec, assertHost = assertImacExecutionHost,
  localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  helperRoot = root, launchAgentsDir = path.join(os.homedir(), 'Library/LaunchAgents'),
  nodePath = process.execPath, helperPath = path.join(helperRoot, 'runtime/central/current/local-mac-helper/funding-trash.mjs'),
  userId = process.getuid?.(),
} = {}) {
  await assertHost();
  const timezone = typeof localTimezone === 'function' ? localTimezone() : localTimezone;
  if (timezone !== 'Europe/Berlin') throw new Error('Der lokale Tageszeitplan benötigt Europe/Berlin als Mac-Zeitzone. Sie wurde nicht verändert.');
  if (!path.isAbsolute(nodePath) || !path.isAbsolute(helperPath) || !Number.isInteger(userId) || userId < 0) throw new Error('Für den Zeitplan fehlen absolute Laufzeitpfade oder der lokale Benutzer.');
  const plist = path.join(launchAgentsDir, FUNDING_TRASH_LABEL + '.plist');
  const previous = await readFile(plist, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const content = buildDailyTrashLaunchAgent({ nodePath, helperRoot, helperPath });
  await mkdir(path.join(helperRoot, 'logs'), { recursive: true, mode: 0o700 });
  const domain = `gui/${userId}`, target = `${domain}/${FUNDING_TRASH_LABEL}`;
  if (previous !== content) {
    await writeAtomic(plist, content);
    await execute('/usr/bin/plutil', ['-lint', plist]);
    await execute('/bin/launchctl', ['bootout', domain, plist]).catch(() => {});
    await execute('/bin/launchctl', ['bootstrap', domain, plist]);
  } else {
    const loaded = await execute('/bin/launchctl', ['print', target]).then(() => true, () => false);
    if (!loaded) await execute('/bin/launchctl', ['bootstrap', domain, plist]);
  }
  await execute('/bin/launchctl', ['print', target]);
  return { installed: true, hour: 0, minute: 30, timezone: 'Europe/Berlin', nodePath, helperPath, startedNow: false };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const action = process.argv[2];
  (action === 'install' ? installDailyTrash() : action === 'run' ? emptyDailyTrash() : Promise.reject(new Error('run oder install angeben.')))
    .then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
