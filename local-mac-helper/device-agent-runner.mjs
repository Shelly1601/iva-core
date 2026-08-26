import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export const DEVICE_AGENT_HARD_TIMEOUT_MS = 240_000;
export const DEVICE_AGENT_POLL_INTERVAL_MS = 15_000;

const execFileAsync = promisify(execFile);
const DEVICE_ID = 'imac-nadine';
const KEYCHAIN_SERVICE = 'de.iva.device-agent';
const SERVER_URL = 'https://iva-core-production.up.railway.app';
const RELEASE = 'imac-icloud-v2';
const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_ACTIONS = Object.freeze([
  'agent.status',
  'app.open',
  'codex.task.start',
  'codex.task.status',
  'computer.status',
  'funding.monitor.status',
  'funding.reviews.list',
  'planbar.customer.schedule',
  'planbar.search.refresh',
  'portal.credentials.status',
  'portal.login',
  'project.workflow.run',
]);

let deviceAgentModule = null;

function hostname() {
  return String(os.hostname() || '').trim().toLowerCase().replace(/\.local$/, '');
}

function bootstrapMetadata() {
  return {
    hostname: hostname(),
    protocolVersion: 2,
    release: RELEASE,
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
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`IVA-Bootstrap-Heartbeat HTTP ${response.status}`);
}

async function loadDeviceAgent() {
  if (deviceAgentModule) return deviceAgentModule;
  deviceAgentModule = await import(`./device-agent.mjs?runner=${Date.now()}`);
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

for (;;) {
  try {
    console.log(JSON.stringify(await runWithTimeout(), null, 2));
  } catch (error) {
    deviceAgentModule = null;
    console.error(`Fehler: ${error?.message || error}`);
  }
  await new Promise(resolve => setTimeout(resolve, DEVICE_AGENT_POLL_INTERVAL_MS));
}
