import crypto from 'node:crypto';
import { withImacExecutionLock, imacUiIsBusy } from './ui-execution-lock.mjs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
export const IMAC_DEVICE_ID = 'imac-nadine';
export const DEVICE_AGENT_PROTOCOL_VERSION = 2;
export const DEVICE_AGENT_RELEASE = 'imac-central-v5';
const RUNTIME_REVISION = (() => { try { return JSON.parse(readFileSync(new URL('../release.json', import.meta.url), 'utf8')).revision || ''; } catch { return ''; } })();
const KEYCHAIN_SERVICE = 'de.iva.device-agent';
const KEYCHAIN_ACCOUNT = IMAC_DEVICE_ID;
const DEFAULT_SERVER_URL = 'https://iva-core-production.up.railway.app';
const APP_ALLOWLIST = Object.freeze({
  'Microsoft Outlook': Object.freeze(['/Applications/Microsoft Outlook.app']),
  'Google Chrome': Object.freeze(['/Applications/Google Chrome.app']),
  WhatsApp: Object.freeze(['/Applications/WhatsApp.app']),
  Codex: Object.freeze(['/Applications/ChatGPT.app', '/Applications/Codex.app']),
  ChatGPT: Object.freeze(['/Applications/ChatGPT.app', '/Applications/Codex.app']),
});
// Reine Task-Starts bedienen keine UI. Der gestartete Worker hält selbst die
// UI-Sperre und den Wachschutz; Display-/Lockfehler dürfen die Übergabe nicht verdecken.
const UI_ACTIONS = new Set(['computer.status', 'planbar.search.refresh', 'project.workflow.run', 'portal.login', 'app.open']);
const AGENT_WORKSPACE = path.resolve(process.env.IVA_DEVICE_WORKSPACE || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const ALLOWED_ACTIONS = Object.freeze([
  'agent.status',
  'computer.status',
  'funding.monitor.status',
  'funding.legacy-monitor.suspend',
  'funding.reviews.list',
  'planbar.search.refresh',
  'planbar.customer.schedule',
  'project.workflow.run',
  'portal.credentials.status',
  'portal.login',
  'codex.task.start',
  'codex.task.status',
  'app.open',
]);

function normalizedHost(value) {
  return String(value || '').trim().toLowerCase().replace(/\.local$/, '');
}

export function isAllowedImacExecutionHost(hostname = os.hostname(), expectedHostname = process.env.IVA_IMAC_HOSTNAME) {
  const actual = normalizedHost(hostname);
  const expected = normalizedHost(expectedHostname);
  if (expected) return actual === expected;
  return actual.includes('imac');
}

export function assertImacExecutionHost(hostname = os.hostname(), expectedHostname = process.env.IVA_IMAC_HOSTNAME) {
  if (isAllowedImacExecutionHost(hostname, expectedHostname)) return true;
  throw new Error(`Der iMac-Geräteagent darf auf diesem Rechner nicht laufen (${normalizedHost(hostname) || 'unbekannt'}).`);
}

export function isAuthoritativeIcloudWorkspace(workspace = AGENT_WORKSPACE) {
  return path.resolve(String(workspace || '')).includes('/Library/Mobile Documents/com~apple~CloudDocs/IVA-Assistent/iva-core');
}

export function imacDeviceAgentMetadata() {
  return Object.freeze({
    hostname: normalizedHost(os.hostname()),
    protocolVersion: DEVICE_AGENT_PROTOCOL_VERSION,
    release: DEVICE_AGENT_RELEASE,
    runtimeRevision: RUNTIME_REVISION,
    uiBusy: imacUiIsBusy(),
    workspace: AGENT_WORKSPACE,
    iCloudAuthoritative: isAuthoritativeIcloudWorkspace(),
    allowedActions: [...ALLOWED_ACTIONS],
  });
}

function cleanServerUrl(value) {
  const url = new URL(String(value || DEFAULT_SERVER_URL));
  if (url.protocol !== 'https:') throw new Error('Der IVA-Gerätekanal benötigt HTTPS.');
  return url.origin;
}

export async function readImacDeviceToken() {
  const { stdout } = await execFileAsync('/usr/bin/security', ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w'], { timeout: 10000 });
  const token = String(stdout || '').trim();
  if (token.length < 32) throw new Error('Das iMac-Gerätetoken fehlt im macOS-Schlüsselbund.');
  return token;
}

export async function provisionImacDeviceToken() {
  const token = crypto.randomBytes(48).toString('base64url');
  await execFileAsync('/usr/bin/security', ['add-generic-password', '-U', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w', token], { timeout: 10000 });
  return { storedInKeychain: true, service: KEYCHAIN_SERVICE, account: KEYCHAIN_ACCOUNT, tokenLength: token.length };
}

async function request(pathname, { method = 'GET', body } = {}) {
  const server = cleanServerUrl(process.env.IVA_DEVICE_SERVER_URL);
  const token = await readImacDeviceToken();
  const agent = imacDeviceAgentMetadata();
  const response = await fetch(`${server}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-IVA-Agent-Host': agent.hostname,
      'X-IVA-Agent-Ui-Busy': agent.uiBusy ? 'true' : 'false',
      'X-IVA-Agent-Protocol': String(agent.protocolVersion),
      'X-IVA-Agent-Release': agent.release,
      'X-IVA-Agent-Revision': agent.runtimeRevision,
      'X-IVA-Agent-Workspace': agent.workspace,
      'X-IVA-Agent-ICloud': agent.iCloudAuthoritative ? 'true' : 'false',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw new Error(`IVA-Gerätekanal HTTP ${response.status}: ${String(payload?.error || text || response.statusText).slice(0, 400)}`);
  return payload;
}

export async function reportImacDeviceAgentHeartbeat() {
  const metadata = imacDeviceAgentMetadata();
  return request(`/device-agent/${IMAC_DEVICE_ID}/heartbeat`, { method: 'POST', body: metadata });
}

export async function fetchCentralRuntimeBundle() {
  return request(`/device-agent/${IMAC_DEVICE_ID}/runtime`);
}

export async function fetchImacDeviceAgentStatus() {
  return request(`/device-agent/${IMAC_DEVICE_ID}/status`);
}

export async function fetchFundingRuntimeReconcileStatus() {
  return request(`/device-agent/${IMAC_DEVICE_ID}/funding-runtime-status`);
}

export async function reportOperationalRun(input = {}) {
  return request(`/device-agent/${IMAC_DEVICE_ID}/operational-runs`, { method: 'POST', body: input });
}

export async function reportProjectWorkflowRun(input = {}) {
  return request(`/device-agent/${IMAC_DEVICE_ID}/project-workflow-runs`, { method: 'POST', body: input });
}

async function openApplication(appName) {
  const candidates = APP_ALLOWLIST[appName];
  if (!candidates) throw new Error('Diese App ist auf dem iMac nicht freigegeben.');
  const appPath = await Promise.any(candidates.map(async candidate => {
    await access(candidate);
    return candidate;
  })).catch(() => null);
  if (!appPath) throw new Error(`${appName} ist auf dem iMac nicht installiert.`);
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/open', ['-a', appPath], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', code => code === 0
      ? resolve({ app: appName, applicationPath: appPath, opened: true })
      : reject(new Error(`${appName} konnte nicht geöffnet werden.`)));
  });
}

async function executeDeviceCommand(command) {
  if (command.action === 'agent.status') {
    let launchd;
    try {
      const moduleUrl = new URL('./device-agent-launchd.mjs', import.meta.url);
      moduleUrl.searchParams.set('status_probe', String(Date.now()));
      const { imacDeviceAgentLaunchdStatus } = await import(moduleUrl.href);
      launchd = await imacDeviceAgentLaunchdStatus();
    } catch (error) {
      // Ein vorübergehendes iCloud-EAGAIN darf den attestierten Gerätekanal
      // nicht als fehlgeschlagen markieren. Der nächste Statusbefehl lädt das
      // Modul über eine frische URL erneut und kann die Detailprobe nachholen.
      launchd = {
        loaded: null,
        state: 'probe-retry-required',
        pollSeconds: 15,
        error: String(error?.message || error).slice(0, 300),
      };
    }
    return {
      online: true,
      runtimeMode: process.env.IVA_DEVICE_LOCAL_RUNTIME === 'true' ? 'local' : 'icloud',
      ...imacDeviceAgentMetadata(),
      launchd,
    };
  }
  if (command.action === 'computer.status') {
    const { diagnoseOutlook } = await import('./outlook.mjs');
    const { diagnosePipedriveChrome } = await import('./chrome-pipedrive-status.mjs');
    const { diagnoseWhatsAppMac } = await import('./whatsapp-mac.mjs');
    const { runMacUiBridge } = await import('./macos-ui.mjs');
    // Die UI-Pruefungen laufen absichtlich nacheinander. Outlook und WhatsApp
    // greifen beide auf macOS Accessibility/Apple Events zu und koennen sich
    // bei parallelen Probes gegenseitig einen falschen Negativstatus liefern.
    const outlook = await diagnoseOutlook();
    const bridge = await runMacUiBridge(['accessibility-status'], { timeoutMs: 15000 }).catch(() => ({ trusted: false }));
    const pipedrive = await diagnosePipedriveChrome();
    const whatsapp = await diagnoseWhatsAppMac();
    return {
      online: true,
      outlook: { installed: outlook.outlook?.installed, running: outlook.outlook?.running, accessibility: bridge.trusted === true },
      pipedrive: { chromeRunning: pipedrive.chromeRunning, readable: pipedrive.readDealFields },
      whatsapp: { installed: whatsapp.installed, running: whatsapp.running, linked: whatsapp.linkedAccountVerified },
    };
  }
  if (command.action === 'funding.monitor.status') {
    const { loadFundingMonitorState } = await import('./funding-monitor-state.mjs');
    const { fundingMonitorLaunchAgentStatus } = await import('./funding-monitor-launchd.mjs');
    const [state, launchd] = await Promise.all([loadFundingMonitorState(), fundingMonitorLaunchAgentStatus()]);
    return {
      mode: state.mode,
      emailSendEnabled: state.emailSendEnabled,
      replyDraftsOnly: state.replyDraftsOnly,
      lastCheckedAt: state.lastCheckedAt,
      lastRun: state.lastRun,
      launchd,
    };
  }
  if (command.action === 'funding.monitor.run') {
    throw new Error('Der alte Einzelmonitor ist deaktiviert. Der vollständige Förderlauf startet täglich um 05:00 Uhr als Reihenfolge 1 → 2 → 3 auf dem iMac.');
  }
  if (command.action === 'funding.legacy-monitor.suspend') {
    const { suspendFundingMonitorLaunchAgent } = await import('./funding-monitor-launchd.mjs');
    return suspendFundingMonitorLaunchAgent();
  }
  if (command.action === 'funding.reviews.list') {
    const { listFundingReviews } = await import('./funding-review-queue.mjs');
    const reviews = await listFundingReviews();
    const counts = {};
    for (const review of reviews) counts[review.status] = (counts[review.status] || 0) + 1;
    return { total: reviews.length, counts, latestAt: reviews[0]?.updatedAt || reviews[0]?.createdAt || null };
  }
  if (command.action === 'planbar.search.refresh') {
    const { buildPlanbarCapacitySnapshot, collectPlanbarSearchIndex } = await import('./planbar.mjs');
    const snapshot = await collectPlanbarSearchIndex();
    const capacity = buildPlanbarCapacitySnapshot(snapshot);
    const [stored, storedCapacity] = await Promise.all([
      request(`/device-agent/${IMAC_DEVICE_ID}/planbar-search-index`, { method: 'POST', body: snapshot }),
      request(`/device-agent/${IMAC_DEVICE_ID}/planbar-capacity`, { method: 'POST', body: capacity }),
    ]);
    return {
      updatedAt: stored.updatedAt,
      appointmentCount: stored.appointmentCount,
      rangeStart: stored.rangeStart,
      rangeEndExclusive: stored.rangeEndExclusive,
      capacityWeeks: storedCapacity.planbarCapacity?.weeks || capacity.weeks,
      minimumCapacityBlockDays: capacity.minimumBlockDays,
      readOnly: true,
    };
  }
  if (command.action === 'planbar.customer.schedule') {
    const { startPlanbarCustomerSchedulingTask } = await import('./codex-tasks.mjs');
    return startPlanbarCustomerSchedulingTask({ ...command.payload, commandId: command.id });
  }
  if (command.action === 'portal.credentials.status') {
    const { credentialServiceStatus } = await import('./credential-broker.mjs');
    return credentialServiceStatus(command.payload?.service);
  }
  if (command.action === 'portal.login') {
    const { ensurePortalLogin } = await import('./portal-auth.mjs');
    return ensurePortalLogin(command.payload?.service);
  }
  if (command.action === 'codex.task.start') {
    const { startCodexTask } = await import('./codex-tasks.mjs');
    return startCodexTask({ ...command.payload, requestId: command.id });
  }
  if (command.action === 'codex.task.status') {
    const { getCodexTaskStatus } = await import('./codex-tasks.mjs');
    return getCodexTaskStatus(command.payload?.jobId);
  }
  if (command.action === 'project.workflow.run') {
    const { startProjectWorkflowTask } = await import('./codex-tasks.mjs');
    return startProjectWorkflowTask({ workflowId: command.payload?.workflowId });
  }
  if (command.action === 'app.open') return openApplication(command.payload?.app);
  throw new Error('Der iMac hat diesen Befehl nicht in seiner lokalen Positivliste.');
}

export async function runImacDeviceAgentOnce() {
  assertImacExecutionHost();
  if (!isAuthoritativeIcloudWorkspace()) {
    throw new Error(`Der iMac-Geräteagent läuft nicht aus dem verbindlichen iCloud-Workspace (${AGENT_WORKSPACE}).`);
  }
  await reportImacDeviceAgentHeartbeat().catch(error => {
    // Während der einmaligen Railway-Migration darf ein noch nicht deployter
    // Heartbeat-Endpunkt den bisherigen Agentenabruf nicht unterbrechen.
    if (!/HTTP 404\b/.test(String(error?.message || error))) throw error;
  });
  // Verlorene Statusmeldungen nachliefern, tote Worker sichtbar machen. Kein
  // Wiederholen einer Terminbuchung; der lokale Reservierungsbeleg bleibt führend.
  const { syncSchedulingTaskStates } = await import('./codex-tasks.mjs');
  await syncSchedulingTaskStates().catch(error => console.error(`Terminierungsstatus: ${error.message}`));
  const payload = await request(`/device-agent/${IMAC_DEVICE_ID}/commands/next`);
  const command = payload?.command;
  if (!command) return { status: 'no_command', deviceId: IMAC_DEVICE_ID };
  let ok = false;
  let result = null;
  let error = '';
  let failureStage = '';
  try {
    if (UI_ACTIONS.has(command.action)) {
      const { withMacWakeGuard } = await import('./mac-wake-guard.mjs');
      result = await withImacExecutionLock(() => withMacWakeGuard(() => executeDeviceCommand(command), { maxSeconds: command.action === 'planbar.search.refresh' ? 180 : 120 }), { timeoutMs: 20_000 });
    } else {
      result = await executeDeviceCommand(command);
    }
    ok = true;
  } catch (caught) {
    error = String(caught?.message || caught).slice(0, 1000);
    failureStage = caught?.code === 'IVA_TASK_NOT_LAUNCHED' ? 'before_launch' : '';
  }
  await request(`/device-agent/${IMAC_DEVICE_ID}/commands/${encodeURIComponent(command.id)}/complete`, {
    method: 'POST',
    body: { leaseToken: command.leaseToken, ok, result, error, failureStage },
  });
  return { status: ok ? 'completed' : 'failed', deviceId: IMAC_DEVICE_ID, commandId: command.id, action: command.action, error: ok ? null : error };
}

export function imacDeviceAgentPolicy() {
  return Object.freeze({
    connection: 'outbound-https-only',
    server: cleanServerUrl(process.env.IVA_DEVICE_SERVER_URL),
    deviceId: IMAC_DEVICE_ID,
    executionHost: os.hostname(),
    executionHostAllowed: isAllowedImacExecutionHost(),
    protocolVersion: DEVICE_AGENT_PROTOCOL_VERSION,
    release: DEVICE_AGENT_RELEASE,
    runtimeRevision: RUNTIME_REVISION,
    uiBusy: imacUiIsBusy(),
    workspace: AGENT_WORKSPACE,
    iCloudAuthoritative: isAuthoritativeIcloudWorkspace(),
    expectedHostname: String(process.env.IVA_IMAC_HOSTNAME || '').trim() || 'Hostname enthält „iMac“',
    keychainService: KEYCHAIN_SERVICE,
    arbitraryShellCommands: false,
    allowedActions: [...ALLOWED_ACTIONS],
    allowedApps: Object.keys(APP_ALLOWLIST),
  });
}
