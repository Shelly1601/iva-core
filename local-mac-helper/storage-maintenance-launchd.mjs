#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STORAGE_MAINTENANCE_INTERVAL_SECONDS, STORAGE_MAINTENANCE_LABEL } from './storage-maintenance.mjs';

const execFileAsync = promisify(execFile);

function dataRoot() {
  return process.env.IVA_MAC_HELPER_DATA_DIR
    || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper');
}

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function storageMaintenancePlistFile() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${STORAGE_MAINTENANCE_LABEL}.plist`);
}

export function centralStorageMaintenanceRunner() {
  return path.join(dataRoot(), 'runtime', 'central', 'current', 'local-mac-helper', 'storage-maintenance.mjs');
}

export function buildStorageMaintenanceLaunchAgent({
  nodePath = process.execPath,
  runnerPath = centralStorageMaintenanceRunner(),
  root = dataRoot(),
} = {}) {
  const logs = path.join(root, 'logs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${STORAGE_MAINTENANCE_LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(runnerPath)}</string><string>run</string><string>--commit</string></array>
<key>WorkingDirectory</key><string>${xml(path.dirname(runnerPath))}</string>
<key>StartInterval</key><integer>${STORAGE_MAINTENANCE_INTERVAL_SECONDS}</integer>
<key>ProcessType</key><string>Background</string>
<key>LowPriorityIO</key><true/>
<key>StandardOutPath</key><string>${xml(path.join(logs, 'storage-maintenance.out.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, 'storage-maintenance.err.log'))}</string>
</dict></plist>`;
}

export async function storageMaintenanceLaunchdStatus() {
  const target = `gui/${process.getuid()}/${STORAGE_MAINTENANCE_LABEL}`;
  try {
    const { stdout } = await execFileAsync('/bin/launchctl', ['print', target], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    return {
      installed: true,
      loaded: true,
      state: String(stdout).match(/\bstate = ([^\n]+)/)?.[1]?.trim() || 'loaded',
      intervalSeconds: STORAGE_MAINTENANCE_INTERVAL_SECONDS,
      plist: storageMaintenancePlistFile(),
      runner: centralStorageMaintenanceRunner(),
    };
  } catch {
    return { installed: false, loaded: false, state: 'not-loaded', intervalSeconds: STORAGE_MAINTENANCE_INTERVAL_SECONDS };
  }
}

export async function installStorageMaintenanceLaunchAgent({ runnerPath = centralStorageMaintenanceRunner() } = {}) {
  await access(runnerPath, fsConstants.R_OK);
  const plist = storageMaintenancePlistFile();
  const guiDomain = `gui/${process.getuid()}`;
  const previous = await readFile(plist, 'utf8').catch(() => null);
  await mkdir(path.dirname(plist), { recursive: true, mode: 0o700 });
  await mkdir(path.join(dataRoot(), 'logs'), { recursive: true, mode: 0o700 });
  try {
    await writeFile(plist, buildStorageMaintenanceLaunchAgent({ runnerPath }), { mode: 0o600 });
    await execFileAsync('/usr/bin/plutil', ['-lint', plist], { timeout: 10_000 });
    await execFileAsync('/bin/launchctl', ['bootout', guiDomain, plist], { timeout: 10_000 }).catch(() => {});
    await execFileAsync('/bin/launchctl', ['bootstrap', guiDomain, plist], { timeout: 15_000 });
    return { ...(await storageMaintenanceLaunchdStatus()), plist, runner: runnerPath };
  } catch (error) {
    await execFileAsync('/bin/launchctl', ['bootout', guiDomain, plist], { timeout: 10_000 }).catch(() => {});
    if (previous) {
      await writeFile(plist, previous, { mode: 0o600 });
      await execFileAsync('/bin/launchctl', ['bootstrap', guiDomain, plist], { timeout: 15_000 }).catch(() => {});
    } else await unlink(plist).catch(() => {});
    throw new Error(`Speicherwartung konnte nicht installiert werden; vorheriger Stand wurde wiederhergestellt: ${error.message}`);
  }
}

export async function uninstallStorageMaintenanceLaunchAgent() {
  const plist = storageMaintenancePlistFile();
  await execFileAsync('/bin/launchctl', ['bootout', `gui/${process.getuid()}`, plist], { timeout: 10_000 }).catch(() => {});
  await unlink(plist).catch(error => { if (error?.code !== 'ENOENT') throw error; });
  return { installed: false, loaded: false };
}

async function main() {
  const command = process.argv[2] || 'status';
  if (command === 'status') return console.log(JSON.stringify(await storageMaintenanceLaunchdStatus(), null, 2));
  if (command === 'install') return console.log(JSON.stringify(await installStorageMaintenanceLaunchAgent(), null, 2));
  if (command === 'uninstall') return console.log(JSON.stringify(await uninstallStorageMaintenanceLaunchAgent(), null, 2));
  throw new Error('Erlaubte Befehle: install, status, uninstall');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
