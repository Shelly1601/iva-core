import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { access, chmod, copyFile, cp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertImacExecutionHost, DEVICE_AGENT_RELEASE, fetchImacDeviceAgentStatus } from './device-agent.mjs';
import { materializeIcloudWorkspace } from './icloud-workspace.mjs';

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

export function imacDeviceAgentLocalRunnerFile() {
  return path.join(dataRoot(), 'runtime', DEVICE_AGENT_RELEASE, 'local-mac-helper', 'device-agent-runner.mjs');
}

function imacDeviceAgentLocalForecastRoot() {
  return path.join(dataRoot(), 'runtime', DEVICE_AGENT_RELEASE, 'outputs', 'planbar-weekly');
}

function authoritativeWorkspace() {
  return path.resolve(process.env.IVA_DEVICE_WORKSPACE || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
}

export function buildImacDeviceAgentLaunchAgent({
  nodePath = process.execPath,
  runnerPath = imacDeviceAgentLocalRunnerFile(),
  workspace = authoritativeWorkspace(),
  forecastRoot = imacDeviceAgentLocalForecastRoot(),
} = {}) {
  const logs = path.join(dataRoot(), 'logs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${IMAC_DEVICE_AGENT_LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(runnerPath)}</string></array>
<key>WorkingDirectory</key><string>${xml(path.dirname(runnerPath))}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string><key>IVA_TESSERACT_LANG</key><string>deu+eng</string><key>IVA_DEVICE_WORKSPACE</key><string>${xml(workspace)}</string><key>IVA_DEVICE_LOCAL_RUNTIME</key><string>true</string><key>IVA_PLANBAR_OUTPUT_ROOT</key><string>${xml(forecastRoot)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(path.join(logs, 'device-agent.out.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, 'device-agent.err.log'))}</string>
</dict></plist>`;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function verifyImacDeviceAgentConnection({
  baselineLastSeenAt = '',
  getStatus = fetchImacDeviceAgentStatus,
  timeoutMs = 90_000,
  pollMs = 5_000,
  minimumAdvanceMs = 10_000,
  requiredRelease = DEVICE_AGENT_RELEASE,
} = {}) {
  const baseline = Date.parse(baselineLastSeenAt || '') || 0;
  const deadline = Date.now() + timeoutMs;
  let firstHeartbeat = 0;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await getStatus().catch(() => null);
    const seen = Date.parse(latest?.lastSeenAt || '') || 0;
    if (latest?.online === true && latest?.release === requiredRelease && seen > baseline) {
      if (!firstHeartbeat) firstHeartbeat = seen;
      else if (seen - firstHeartbeat >= minimumAdvanceMs) {
        return {
          verified: true,
          deviceId: latest.deviceId,
          hostname: latest.hostname,
          release: latest.release,
          firstVerifiedHeartbeatAt: new Date(firstHeartbeat).toISOString(),
          secondVerifiedHeartbeatAt: new Date(seen).toISOString(),
          pollSeconds: 15,
        };
      }
    }
    await wait(pollMs);
  }
  throw new Error(`Der lokale iMac-Agent hat innerhalb von ${Math.ceil(timeoutMs / 1000)} Sekunden keine zwei fortlaufenden Railway-Heartbeats bestätigt.`);
}

async function copyDirectoryWithRetry(source, target, label) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await cp(source, target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const transient = error?.code === 'EAGAIN' || error?.code === 'ENOENT' || error?.errno === -11;
      if (!transient || attempt === 6) break;
      console.error(`${label}: iCloud-Dateien sind kurz belegt, Versuch ${attempt + 1} von 6 …`);
      await wait(2_000 * attempt);
    }
  }
  throw new Error(`${label} konnte nicht lokal bereitgestellt werden: ${lastError?.message || lastError}`);
}

async function findNpmExecutable() {
  for (const candidate of [
    path.join(path.dirname(process.execPath), 'npm'),
    '/opt/homebrew/bin/npm',
    '/usr/local/bin/npm',
    '/usr/bin/npm',
  ]) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error('npm wurde neben der lokalen Node.js-Laufzeit nicht gefunden.');
}

async function localRuntimeDependenciesReady(releaseRoot) {
  try {
    await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      'await Promise.all([import("unpdf"), import("pdf-lib")])',
    ], { cwd: releaseRoot, timeout: 30_000, maxBuffer: 512 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function installLocalRuntimeDependencies({ runtimeSource, releaseRoot }) {
  const packageSource = path.join(runtimeSource, 'local-mac-helper', 'runtime-package.json');
  const packageTarget = path.join(releaseRoot, 'package.json');
  await copyFile(packageSource, packageTarget);
  if (await localRuntimeDependenciesReady(releaseRoot)) return { installed: false, ready: true };
  const npm = await findNpmExecutable();
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin'}` };
  await execFileAsync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--package-lock=false'], {
    cwd: releaseRoot,
    env,
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (!await localRuntimeDependenciesReady(releaseRoot)) {
    throw new Error('Die lokalen IVA-Abhängigkeiten wurden installiert, können aber nicht geladen werden.');
  }
  return { installed: true, ready: true };
}

export async function imacDeviceAgentLaunchdStatus() {
  const target = `gui/${process.getuid()}/${IMAC_DEVICE_AGENT_LABEL}`;
  try {
    const { stdout } = await execFileAsync('/bin/launchctl', ['print', target], { timeout: 10000, maxBuffer: 1024 * 1024 });
    return { loaded: true, state: String(stdout).match(/\bstate = ([^\n]+)/)?.[1]?.trim() || 'loaded', pollSeconds: 15 };
  } catch { return { loaded: false, state: 'not-loaded', pollSeconds: 15 }; }
}

export async function installImacDeviceAgentLaunchd() {
  assertImacExecutionHost();
  const plist = imacDeviceAgentPlistFile();
  const runnerPath = imacDeviceAgentLocalRunnerFile();
  const workspace = authoritativeWorkspace();
  const runtimeSource = path.resolve(process.env.IVA_DEVICE_RUNTIME_SOURCE || workspace);
  const helperSource = path.join(runtimeSource, 'local-mac-helper');
  const helperTarget = path.dirname(runnerPath);
  const releaseRoot = path.dirname(helperTarget);
  const forecastSource = path.join(workspace, 'outputs', 'planbar-weekly');
  const forecastRoot = imacDeviceAgentLocalForecastRoot();
  const guiDomain = `gui/${process.getuid()}`;
  const baseline = await fetchImacDeviceAgentStatus().catch(() => null);
  const previousPlist = await readFile(plist, 'utf8').catch(() => null);
  let activationStarted = false;
  await mkdir(path.dirname(plist), { recursive: true, mode: 0o700 });
  await mkdir(path.join(dataRoot(), 'logs'), { recursive: true, mode: 0o700 });
  await materializeIcloudWorkspace({ workspace: runtimeSource });
  if (runtimeSource !== workspace) await materializeIcloudWorkspace({ workspace });
  console.error('IVA richtet die vollständig lokale iMac-Laufzeit ein …');
  await copyDirectoryWithRetry(helperSource, helperTarget, 'IVA-Helfer');
  const dependencies = await installLocalRuntimeDependencies({ runtimeSource, releaseRoot });
  await copyDirectoryWithRetry(forecastSource, forecastRoot, 'Vorbereitete Forecast-Dateien');
  await chmod(runnerPath, 0o700);
  try {
    await writeFile(plist, buildImacDeviceAgentLaunchAgent({ runnerPath, workspace, forecastRoot }), { mode: 0o600 });
    await execFileAsync('/usr/bin/plutil', ['-lint', plist], { timeout: 10000 });
    activationStarted = true;
    await execFileAsync('/bin/launchctl', ['bootout', guiDomain, plist], { timeout: 10000 }).catch(() => {});
    await execFileAsync('/bin/launchctl', ['bootstrap', guiDomain, plist], { timeout: 15000 });
    await execFileAsync('/bin/launchctl', ['kickstart', `${guiDomain}/${IMAC_DEVICE_AGENT_LABEL}`], { timeout: 15000 });
    console.error('Lokale Laufzeit eingerichtet. Dauerverbindung wird geprüft …');
    const connection = await verifyImacDeviceAgentConnection({
      baselineLastSeenAt: baseline?.lastSeenAt,
      requiredRelease: DEVICE_AGENT_RELEASE,
    });
    return { installed: true, plist, runnerPath, dependencies, connection, ...(await imacDeviceAgentLaunchdStatus()) };
  } catch (error) {
    if (!activationStarted) throw error;
    await execFileAsync('/bin/launchctl', ['bootout', guiDomain, plist], { timeout: 10000 }).catch(() => {});
    if (previousPlist) {
      await writeFile(plist, previousPlist, { mode: 0o600 });
      await execFileAsync('/usr/bin/plutil', ['-lint', plist], { timeout: 10000 });
      await execFileAsync('/bin/launchctl', ['bootstrap', guiDomain, plist], { timeout: 15000 });
      await execFileAsync('/bin/launchctl', ['kickstart', `${guiDomain}/${IMAC_DEVICE_AGENT_LABEL}`], { timeout: 15000 }).catch(() => {});
    } else {
      await unlink(plist).catch(() => {});
    }
    throw new Error(`Neue lokale Laufzeit fehlgeschlagen; vorheriger Agent wurde wiederhergestellt: ${error?.message || error}`);
  }
}

export async function uninstallImacDeviceAgentLaunchd() {
  const plist = imacDeviceAgentPlistFile();
  await execFileAsync('/bin/launchctl', ['bootout', `gui/${process.getuid()}`, plist], { timeout: 10000 }).catch(() => {});
  await unlink(plist).catch(error => { if (error?.code !== 'ENOENT') throw error; });
  return { installed: false, loaded: false };
}
