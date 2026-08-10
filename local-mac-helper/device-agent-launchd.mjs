import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
export const IMAC_DEVICE_AGENT_LABEL = 'de.iva.device-agent';

function dataRoot() {
  return process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper');
}

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function imacDeviceAgentPlistFile() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${IMAC_DEVICE_AGENT_LABEL}.plist`);
}

export function buildImacDeviceAgentLaunchAgent({ nodePath = process.execPath, cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url)) } = {}) {
  const logs = path.join(dataRoot(), 'logs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${IMAC_DEVICE_AGENT_LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(cliPath)}</string><string>run-imac-device-agent-once</string></array>
<key>WorkingDirectory</key><string>${xml(path.dirname(path.dirname(cliPath)))}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string><key>IVA_TESSERACT_LANG</key><string>deu+eng</string></dict>
<key>RunAtLoad</key><true/><key>StartInterval</key><integer>15</integer><key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(path.join(logs, 'device-agent.out.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, 'device-agent.err.log'))}</string>
</dict></plist>`;
}

export async function imacDeviceAgentLaunchdStatus() {
  const target = `gui/${process.getuid()}/${IMAC_DEVICE_AGENT_LABEL}`;
  try {
    const { stdout } = await execFileAsync('/bin/launchctl', ['print', target], { timeout: 10000, maxBuffer: 1024 * 1024 });
    return { loaded: true, state: String(stdout).match(/\bstate = ([^\n]+)/)?.[1]?.trim() || 'loaded', pollSeconds: 15 };
  } catch { return { loaded: false, state: 'not-loaded', pollSeconds: 15 }; }
}

export async function installImacDeviceAgentLaunchd() {
  const plist = imacDeviceAgentPlistFile();
  const guiDomain = `gui/${process.getuid()}`;
  await mkdir(path.dirname(plist), { recursive: true, mode: 0o700 });
  await mkdir(path.join(dataRoot(), 'logs'), { recursive: true, mode: 0o700 });
  await writeFile(plist, buildImacDeviceAgentLaunchAgent(), { mode: 0o600 });
  await execFileAsync('/usr/bin/plutil', ['-lint', plist], { timeout: 10000 });
  await execFileAsync('/bin/launchctl', ['bootout', guiDomain, plist], { timeout: 10000 }).catch(() => {});
  await execFileAsync('/bin/launchctl', ['bootstrap', guiDomain, plist], { timeout: 15000 });
  await execFileAsync('/bin/launchctl', ['kickstart', `${guiDomain}/${IMAC_DEVICE_AGENT_LABEL}`], { timeout: 15000 });
  return { installed: true, plist, ...(await imacDeviceAgentLaunchdStatus()) };
}

export async function uninstallImacDeviceAgentLaunchd() {
  const plist = imacDeviceAgentPlistFile();
  await execFileAsync('/bin/launchctl', ['bootout', `gui/${process.getuid()}`, plist], { timeout: 10000 }).catch(() => {});
  await unlink(plist).catch(error => { if (error?.code !== 'ENOENT') throw error; });
  return { installed: false, loaded: false };
}
