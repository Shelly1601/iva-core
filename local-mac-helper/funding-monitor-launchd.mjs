import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
export const FUNDING_MONITOR_LAUNCHD_LABEL = 'de.iva.funding-monitor';

function dataRoot() {
  return process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper');
}

export function fundingMonitorLaunchAgentFile() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${FUNDING_MONITOR_LAUNCHD_LABEL}.plist`);
}

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildFundingMonitorLaunchAgent({
  nodePath = process.execPath,
  cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url)),
  intervalSeconds = 1800,
} = {}) {
  const interval = Math.max(300, Number(intervalSeconds) || 1800);
  const logs = path.join(dataRoot(), 'logs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${FUNDING_MONITOR_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(cliPath)}</string>
    <string>run-funding-monitor-once</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(path.dirname(path.dirname(cliPath)))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>IVA_TESSERACT_LANG</key><string>deu+eng</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>${interval}</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(path.join(logs, 'funding-monitor.out.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, 'funding-monitor.err.log'))}</string>
</dict>
</plist>
`;
}

async function launchctl(args) {
  try { return await execFileAsync('/bin/launchctl', args, { timeout: 15000, maxBuffer: 1024 * 1024 }); }
  catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || error).replace(/\s+/g, ' ').trim();
    throw new Error(`launchctl ${args[0]} fehlgeschlagen: ${detail.slice(0, 500)}`);
  }
}

export async function installFundingMonitorLaunchAgent({ startNow = true } = {}) {
  const plist = fundingMonitorLaunchAgentFile();
  const guiDomain = `gui/${process.getuid()}`;
  await mkdir(path.dirname(plist), { recursive: true, mode: 0o700 });
  await mkdir(path.join(dataRoot(), 'logs'), { recursive: true, mode: 0o700 });
  await writeFile(plist, buildFundingMonitorLaunchAgent(), { mode: 0o600 });
  await execFileAsync('/usr/bin/plutil', ['-lint', plist], { timeout: 10000 });
  await execFileAsync('/bin/launchctl', ['bootout', guiDomain, plist], { timeout: 10000 }).catch(() => {});
  await launchctl(['bootstrap', guiDomain, plist]);
  if (startNow) await launchctl(['kickstart', `${guiDomain}/${FUNDING_MONITOR_LAUNCHD_LABEL}`]);
  const status = await fundingMonitorLaunchAgentStatus();
  return { installed: true, started: startNow, plist, ...status };
}

export async function fundingMonitorLaunchAgentStatus() {
  const guiDomain = `gui/${process.getuid()}`;
  try {
    const { stdout } = await execFileAsync('/bin/launchctl', ['print', `${guiDomain}/${FUNDING_MONITOR_LAUNCHD_LABEL}`], { timeout: 10000, maxBuffer: 1024 * 1024 });
    const state = String(stdout).match(/\bstate = ([^\n]+)/)?.[1]?.trim() || 'loaded';
    const lastExitCode = Number(String(stdout).match(/last exit code = (-?\d+)/)?.[1]);
    return { loaded: true, state, lastExitCode: Number.isFinite(lastExitCode) ? lastExitCode : null, intervalMinutes: 30 };
  } catch {
    return { loaded: false, state: 'not-loaded', lastExitCode: null, intervalMinutes: 30 };
  }
}

export async function uninstallFundingMonitorLaunchAgent() {
  const plist = fundingMonitorLaunchAgentFile();
  const guiDomain = `gui/${process.getuid()}`;
  await execFileAsync('/bin/launchctl', ['bootout', guiDomain, plist], { timeout: 10000 }).catch(() => {});
  await unlink(plist).catch(error => { if (error?.code !== 'ENOENT') throw error; });
  return { installed: false, loaded: false, plistRemoved: true };
}

export async function suspendFundingMonitorLaunchAgent() {
  const plist = fundingMonitorLaunchAgentFile();
  const guiDomain = `gui/${process.getuid()}`;
  await execFileAsync('/bin/launchctl', ['bootout', guiDomain, plist], { timeout: 10000 }).catch(() => {});
  const status = await fundingMonitorLaunchAgentStatus();
  if (status.loaded) throw new Error('Der veraltete 30-Minuten-Fördermonitor ist nach dem Anhalten weiterhin geladen.');
  return { suspended: true, loaded: false, plistRetained: true, plist, replacement: 'Railway 05:00 → imac-nadine → Förderung 1 → 2 → 3' };
}

export async function readFundingMonitorLogs({ maxCharacters = 12000 } = {}) {
  const logs = path.join(dataRoot(), 'logs');
  const output = await readFile(path.join(logs, 'funding-monitor.out.log'), 'utf8').catch(() => '');
  const error = await readFile(path.join(logs, 'funding-monitor.err.log'), 'utf8').catch(() => '');
  return { output: output.slice(-maxCharacters), error: error.slice(-maxCharacters) };
}
