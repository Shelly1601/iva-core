import os from 'node:os';
import { imacUiIsBusy } from './ui-execution-lock.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { chmod, cp, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEVICE_AGENT_HARD_TIMEOUT_MS = 240_000;
export const DEVICE_AGENT_POLL_INTERVAL_MS = 15_000;

const execFileAsync = promisify(execFile);
const DEVICE_ID = 'imac-nadine';
const KEYCHAIN_SERVICE = 'de.iva.device-agent';
const SERVER_URL = 'https://iva-core-production.up.railway.app';
const RELEASE = 'imac-central-v5';
const MODULE_PATH = fileURLToPath(import.meta.url);
const LOCAL_RUNTIME = process.env.IVA_DEVICE_LOCAL_RUNTIME === 'true';
const LOCAL_HELPER_DIR = path.dirname(MODULE_PATH);
const WORKSPACE = path.resolve(process.env.IVA_DEVICE_WORKSPACE || path.join(path.dirname(MODULE_PATH), '..'));
const WORKSPACE_RUNNER = path.join(WORKSPACE, 'local-mac-helper', 'device-agent-runner.mjs');
const WORKSPACE_AGENT = path.join(WORKSPACE, 'local-mac-helper', 'device-agent.mjs');
const AGENT_MODULE_PATH = LOCAL_RUNTIME ? path.join(LOCAL_HELPER_DIR, 'device-agent.mjs') : WORKSPACE_AGENT;
const DATA_ROOT = process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper');
const LOCAL_RELEASE_ROOT = path.join(DATA_ROOT, 'runtime', RELEASE);
const LOCAL_RELEASE_HELPER = path.join(LOCAL_RELEASE_ROOT, 'local-mac-helper');
const LOCAL_RELEASE_FORECAST = path.join(LOCAL_RELEASE_ROOT, 'outputs', 'planbar-weekly');
const MIGRATOR_LABEL = 'de.iva.device-agent-migrator';
const MIGRATOR_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${MIGRATOR_LABEL}.plist`);
const BOOTSTRAP_COMMIT = 'b332bdf18ad5eb25eda85f5f60326115133c1f4f';
const BOOTSTRAP_SHA256 = '97848c3288d809cdaf2b23f9df9ccad727aa369d663ff8a7ea2ccc2290421231';
const BOOTSTRAP_ROOT = path.join(DATA_ROOT, 'bootstrap');
const BOOTSTRAP_SOURCE = path.join(BOOTSTRAP_ROOT, `iva-core-${BOOTSTRAP_COMMIT}`);
const ALLOWED_ACTIONS = Object.freeze([
  'agent.status',
  'app.open',
  'codex.task.start',
  'codex.task.status',
  'computer.status',
  'funding.monitor.status',
  'funding.legacy-monitor.suspend',
  'funding.reviews.list',
  'planbar.customer.schedule',
  'planbar.search.refresh',
  'portal.credentials.status',
  'portal.login',
  'project.workflow.run',
]);

let deviceAgentModule = null;
let deviceAgentSourceFingerprint = '';
let lastMigrationScheduleAt = 0;

// Der iMac darf den Bildschirm weiterhin ausschalten. Nur der Systemschlaf bei
// Netzbetrieb wird verhindert, damit der ausgehende Agent erreichbar bleibt.
const wakeGuard = spawn('/usr/bin/caffeinate', ['-s', '-w', String(process.pid)], { stdio: 'ignore' });
wakeGuard.unref();

function hostname() {
  return String(os.hostname() || '').trim().toLowerCase().replace(/\.local$/, '');
}

function bootstrapMetadata() {
  return {
    hostname: hostname(),
    uiBusy: imacUiIsBusy(),
    protocolVersion: 2,
    release: RELEASE,
    runtimeRevision: (() => { try { return JSON.parse(readFileSync(path.join(LOCAL_HELPER_DIR, '..', 'release.json'), 'utf8')).revision || ''; } catch { return ''; } })(),
    workspace: WORKSPACE,
    iCloudAuthoritative: WORKSPACE.includes('/Library/Mobile Documents/com~apple~CloudDocs/IVA-Assistent/iva-core'),
    allowedActions: [...ALLOWED_ACTIONS],
  };
}

async function readDeviceToken() {
  const { stdout } = await execFileAsync('/usr/bin/security', [
    'find-generic-password', '-a', DEVICE_ID, '-s', KEYCHAIN_SERVICE, '-w',
  ], { timeout: 10_000 });
  const token = String(stdout || '').trim();
  if (token.length < 32) throw new Error('Das iMac-Gerätetoken fehlt im macOS-Schlüsselbund.');
  return token;
}

async function reportBootstrapHeartbeat() {
  const metadata = bootstrapMetadata();
  if (!metadata.hostname.includes('imac') || !metadata.iCloudAuthoritative) {
    throw new Error('Der lokale IVA-Start wurde außerhalb des verbindlichen iMac-iCloud-Workspace blockiert.');
  }
  const token = await readDeviceToken();
  const response = await fetch(`${SERVER_URL}/device-agent/${DEVICE_ID}/heartbeat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-IVA-Agent-Host': metadata.hostname,
      'X-IVA-Agent-Protocol': String(metadata.protocolVersion),
      'X-IVA-Agent-Release': metadata.release,
      'X-IVA-Agent-Workspace': metadata.workspace,
      'X-IVA-Agent-ICloud': metadata.iCloudAuthoritative ? 'true' : 'false',
    },
    body: JSON.stringify(metadata),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`IVA-Bootstrap-Heartbeat HTTP ${response.status}`);
}

async function updateLocalRunnerFromIcloud() {
  if (LOCAL_RUNTIME) return false;
  if (path.resolve(MODULE_PATH) === path.resolve(WORKSPACE_RUNNER)) return false;
  try {
    const [installed, source] = await Promise.all([
      readFile(MODULE_PATH, { signal: AbortSignal.timeout(5_000) }),
      readFile(WORKSPACE_RUNNER, { signal: AbortSignal.timeout(5_000) }),
    ]);
    if (installed.equals(source)) return false;
    const temporary = `${MODULE_PATH}.${process.pid}.tmp.mjs`;
    try {
      await writeFile(temporary, source, { mode: 0o700 });
      await execFileAsync(process.execPath, ['--check', temporary], { timeout: 10_000 });
      await rename(temporary, MODULE_PATH);
      await chmod(MODULE_PATH, 0o700);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    console.log('Der lokale IVA-Geräterunner wurde sicher aus iCloud aktualisiert.');
    return true;
  } catch (error) {
    console.error(`Runner-Aktualisierung wird später erneut versucht: ${error?.message || error}`);
    return false;
  }
}

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function copyRuntimeDirectory(source, target, label) {
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
      await new Promise(resolve => setTimeout(resolve, 2_000 * attempt));
    }
  }
  throw new Error(`${label} konnte nicht lokal bereitgestellt werden: ${lastError?.message || lastError}`);
}

function requestIcloudMaterialization(target) {
  try {
    const child = spawn('/usr/bin/brctl', ['download', target], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // Das anschließende Kopieren löst die Materialisierung ebenfalls aus und
    // liefert bei einem echten Fehler die genaue Ursache.
  }
}

async function ensureVerifiedBootstrapSnapshot() {
  const installer = path.join(BOOTSTRAP_SOURCE, 'local-mac-helper', 'install-imac-device-agent.mjs');
  const snapshotRunner = path.join(BOOTSTRAP_SOURCE, 'local-mac-helper', 'device-agent-runner.mjs');
  try {
    const [installerInfo, runnerInfo] = await Promise.all([stat(installer), stat(snapshotRunner)]);
    if (installerInfo.isFile() && runnerInfo.isFile()) return BOOTSTRAP_SOURCE;
  } catch {
    // Das Paket wird im nächsten Schritt vollständig und verifiziert geladen.
  }
  await mkdir(BOOTSTRAP_ROOT, { recursive: true, mode: 0o700 });
  const archive = path.join(BOOTSTRAP_ROOT, `${BOOTSTRAP_COMMIT}.tar.gz`);
  const temporary = `${archive}.${process.pid}.download`;
  try {
    await execFileAsync('/usr/bin/curl', [
      '--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--tlsv1.2',
      `https://github.com/Shelly1601/iva-core/archive/${BOOTSTRAP_COMMIT}.tar.gz`,
      '-o', temporary,
    ], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    const { stdout } = await execFileAsync('/usr/bin/shasum', ['-a', '256', temporary], { timeout: 30_000 });
    const actual = String(stdout || '').trim().split(/\s+/)[0];
    if (actual !== BOOTSTRAP_SHA256) throw new Error('Das direkt geladene IVA-Paket hat die fest hinterlegte SHA-256-Prüfsumme nicht bestanden.');
    await rename(temporary, archive);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  await execFileAsync('/usr/bin/tar', ['-xzf', archive, '-C', BOOTSTRAP_ROOT], { timeout: 120_000, maxBuffer: 1024 * 1024 });
  await Promise.all([
    execFileAsync(process.execPath, ['--check', installer], { timeout: 10_000 }),
    execFileAsync(process.execPath, ['--check', snapshotRunner], { timeout: 10_000 }),
  ]);
  return BOOTSTRAP_SOURCE;
}

async function scheduleLocalRuntimeMigration() {
  if (LOCAL_RUNTIME) return false;
  const now = Date.now();
  if (now - lastMigrationScheduleAt < 120_000) return false;
  lastMigrationScheduleAt = now;
  const metadata = bootstrapMetadata();
  if (!metadata.hostname.includes('imac') || !metadata.iCloudAuthoritative) return false;
  const runtimeSource = await ensureVerifiedBootstrapSnapshot();
  const helperSource = path.join(runtimeSource, 'local-mac-helper');
  const forecastSource = path.join(WORKSPACE, 'outputs', 'planbar-weekly');
  requestIcloudMaterialization(forecastSource);
  console.error('IVA übernimmt das direkt geladene und SHA-256-geprüfte Paket jetzt in die lokale iMac-Laufzeit …');
  await copyRuntimeDirectory(helperSource, LOCAL_RELEASE_HELPER, 'IVA-Helfer');
  await copyRuntimeDirectory(forecastSource, LOCAL_RELEASE_FORECAST, 'Vorbereitete Forecast-Dateien');
  const installer = path.join(LOCAL_RELEASE_HELPER, 'install-imac-device-agent.mjs');
  const localRunner = path.join(LOCAL_RELEASE_HELPER, 'device-agent-runner.mjs');
  await Promise.all([chmod(installer, 0o700), chmod(localRunner, 0o700)]);
  await execFileAsync(process.execPath, ['--check', installer], { timeout: 10_000 });
  await execFileAsync(process.execPath, ['--check', localRunner], { timeout: 10_000 });
  const logs = path.join(DATA_ROOT, 'logs');
  await mkdir(logs, { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(MIGRATOR_PLIST), { recursive: true, mode: 0o700 });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${MIGRATOR_LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(installer)}</string></array>
<key>WorkingDirectory</key><string>${xml(LOCAL_RELEASE_HELPER)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string><key>IVA_DEVICE_WORKSPACE</key><string>${xml(WORKSPACE)}</string><key>IVA_DEVICE_RUNTIME_SOURCE</key><string>${xml(runtimeSource)}</string><key>IVA_DEVICE_MIGRATOR</key><string>true</string></dict>
<key>RunAtLoad</key><true/><key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(path.join(logs, 'device-agent-migrator.out.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, 'device-agent-migrator.err.log'))}</string>
</dict></plist>`;
  await writeFile(MIGRATOR_PLIST, plist, { mode: 0o600 });
  await execFileAsync('/usr/bin/plutil', ['-lint', MIGRATOR_PLIST], { timeout: 10_000 });
  const guiDomain = `gui/${process.getuid()}`;
  await execFileAsync('/bin/launchctl', ['bootout', guiDomain, MIGRATOR_PLIST], { timeout: 10_000 }).catch(() => {});
  await execFileAsync('/bin/launchctl', ['bootstrap', guiDomain, MIGRATOR_PLIST], { timeout: 15_000 });
  console.error('Die lokale iMac-Übernahme wurde gestartet; der bestehende Agent bleibt bis zur geprüften Umschaltung aktiv.');
  return true;
}

async function loadDeviceAgent() {
  try {
    const info = await stat(AGENT_MODULE_PATH);
    const fingerprint = `${info.size}:${info.mtimeMs}`;
    if (deviceAgentSourceFingerprint && fingerprint !== deviceAgentSourceFingerprint) deviceAgentModule = null;
    deviceAgentSourceFingerprint = fingerprint;
  } catch {
    // Der anschließende Import liefert den präzisen Fehler und wird im Loop
    // erneut versucht; die eigenständigen Heartbeats bleiben davon unberührt.
  }
  if (deviceAgentModule) return deviceAgentModule;
  const moduleUrl = pathToFileURL(AGENT_MODULE_PATH);
  moduleUrl.searchParams.set('runner', String(Date.now()));
  deviceAgentModule = await import(moduleUrl.href);
  return deviceAgentModule;
}

async function runWithTimeout() {
  let timeout;
  try {
    // Dieser eigenständige Heartbeat bleibt absichtlich vor dem vollständigen
    // Modulimport. Ist eine weitere iCloud-Datei vorübergehend noch nicht lokal,
    // bleibt der iMac trotzdem sichtbar und der Runner versucht den Import erneut.
    await reportBootstrapHeartbeat();
    const { runImacDeviceAgentOnce } = await loadDeviceAgent();
    return await Promise.race([
      runImacDeviceAgentOnce(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Der IVA-Geräteabruf hat nach 240 Sekunden das harte Zeitlimit erreicht.')), DEVICE_AGENT_HARD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

let lastCentralUpdateAt = 0;
async function updateFromCentralRuntime() {
  if (!LOCAL_RUNTIME || Date.now() - lastCentralUpdateAt < 60_000) return false;
  // Only the central launchd installation follows the atomic current symlink.
  // A legacy fixed-path installation must first use install-central-runtime.mjs.
  if (!LOCAL_HELPER_DIR.includes(`${path.sep}central${path.sep}releases${path.sep}`)) return false;
  lastCentralUpdateAt = Date.now();
  const { fetchCentralRuntimeBundle, imacDeviceAgentMetadata } = await loadDeviceAgent();
  const bundle = await fetchCentralRuntimeBundle();
  if (bundle.revision === imacDeviceAgentMetadata().runtimeRevision) return false;
  const { prepareCentralRuntime, activateCentralRuntime } = await import('./central-runtime.mjs');
  const target = await prepareCentralRuntime(bundle, { dependencyRoot: path.dirname(LOCAL_HELPER_DIR) });
  await activateCentralRuntime(target);
  return true;
}

for (;;) {
  try {
    await reportBootstrapHeartbeat();
    if (await updateFromCentralRuntime().catch(error => { console.error(`Zentrale Aktualisierung wird erneut versucht: ${error.message}`); return false; })) process.exit(75);
    if (await updateLocalRunnerFromIcloud()) process.exit(75);
    await scheduleLocalRuntimeMigration().catch(error => {
      console.error(`Lokale iMac-Übernahme wird erneut versucht: ${error?.message || error}`);
    });
    console.log(JSON.stringify(await runWithTimeout(), null, 2));
  } catch (error) {
    deviceAgentModule = null;
    console.error(`Fehler: ${error?.message || error}`);
  }
  await new Promise(resolve => setTimeout(resolve, DEVICE_AGENT_POLL_INTERVAL_MS));
}
