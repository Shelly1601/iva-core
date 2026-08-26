import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const IMAC_DEVICE_ID = 'imac-nadine';
const KEYCHAIN_SERVICE = 'de.iva.device-agent';
const KEYCHAIN_ACCOUNT = IMAC_DEVICE_ID;
const DEFAULT_SERVER_URL = 'https://iva-core-production.up.railway.app';
const APP_ALLOWLIST = Object.freeze({
  'Microsoft Outlook': '/Applications/Microsoft Outlook.app',
  'Google Chrome': '/Applications/Google Chrome.app',
  WhatsApp: '/Applications/WhatsApp.app',
  Codex: '/Applications/Codex.app',
});
const UI_ACTIONS = new Set(['computer.status', 'planbar.search.refresh', 'planbar.customer.schedule', 'portal.login', 'app.open']);

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
  const response = await fetch(`${server}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw new Error(`IVA-Gerätekanal HTTP ${response.status}: ${String(payload?.error || text || response.statusText).slice(0, 400)}`);
  return payload;
}

export async function reportOperationalRun(input = {}) {
  return request(`/device-agent/${IMAC_DEVICE_ID}/operational-runs`, { method: 'POST', body: input });
}

export async function reportProjectWorkflowRun(input = {}) {
  return request(`/device-agent/${IMAC_DEVICE_ID}/project-workflow-runs`, { method: 'POST', body: input });
}

function openApplication(appName) {
  const appPath = APP_ALLOWLIST[appName];
  if (!appPath) throw new Error('Diese App ist auf dem iMac nicht freigegeben.');
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/open', ['-a', appPath], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ app: appName, opened: true }) : reject(new Error(`${appName} konnte nicht geöffnet werden.`)));
  });
}

async function executeDeviceCommand(command) {
  if (command.action === 'computer.status') {
    const { diagnoseOutlook } = await import('./outlook.mjs');
    const { diagnosePipedriveChrome } = await import('./chrome-pipedrive.mjs');
    const { diagnoseWhatsAppMac } = await import('./whatsapp-mac.mjs');
    const { runMacUiBridge } = await import('./macos-ui.mjs');
    // Die UI-Pruefungen laufen absichtlich nacheinander. Outlook und WhatsApp
    // greifen beide auf macOS Accessibility/Apple Events zu und koennen sich
    // bei parallelen Probes gegenseitig einen falschen Negativstatus liefern.
    const outlook = await diagnoseOutlook();
    const bridge = await runMacUiBridge(['accessibility-status', '--prompt'], { timeoutMs: 15000 }).catch(() => ({ trusted: false }));
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
    const { runFundingMonitorOnce } = await import('./funding-monitor-runner.mjs');
    return runFundingMonitorOnce({ ignoreIdle: true });
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
    return startPlanbarCustomerSchedulingTask(command.payload || {});
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
    return startCodexTask(command.payload || {});
  }
  if (command.action === 'codex.task.status') {
    const { codexTaskStatus } = await import('./codex-tasks.mjs');
    return codexTaskStatus(command.payload?.taskId);
  }
  if (command.action === 'project.workflow.run') {
    const { startProjectWorkflowTask } = await import('./codex-tasks.mjs');
    return startProjectWorkflowTask({ workflowId: command.payload?.workflowId });
  }
  if (command.action === 'app.open') return openApplication(command.payload?.app);
  throw new Error('Der iMac hat diesen Befehl nicht in seiner lokalen Positivliste.');
}

export async function runImacDeviceAgentOnce() {
  const payload = await request(`/device-agent/${IMAC_DEVICE_ID}/commands/next`);
  const command = payload?.command;
  if (!command) return { status: 'no_command', deviceId: IMAC_DEVICE_ID };
  let ok = false;
  let result = null;
  let error = '';
  try {
    if (UI_ACTIONS.has(command.action)) {
      const { withMacWakeGuard } = await import('./mac-wake-guard.mjs');
      result = await withMacWakeGuard(() => executeDeviceCommand(command), { maxSeconds: command.action === 'planbar.search.refresh' ? 180 : 120 });
    } else {
      result = await executeDeviceCommand(command);
    }
    ok = true;
  } catch (caught) {
    error = String(caught?.message || caught).slice(0, 1000);
  }
  await request(`/device-agent/${IMAC_DEVICE_ID}/commands/${encodeURIComponent(command.id)}/complete`, {
    method: 'POST',
    body: { leaseToken: command.leaseToken, ok, result, error },
  });
  return { status: ok ? 'completed' : 'failed', deviceId: IMAC_DEVICE_ID, commandId: command.id, action: command.action, error: ok ? null : error };
}

export function imacDeviceAgentPolicy() {
  return Object.freeze({
    connection: 'outbound-https-only',
    server: cleanServerUrl(process.env.IVA_DEVICE_SERVER_URL),
    deviceId: IMAC_DEVICE_ID,
    keychainService: KEYCHAIN_SERVICE,
    arbitraryShellCommands: false,
    allowedActions: ['computer.status', 'funding.monitor.status', 'funding.monitor.run', 'funding.reviews.list', 'planbar.search.refresh', 'planbar.customer.schedule', 'project.workflow.run', 'portal.credentials.status', 'portal.login', 'codex.task.start', 'codex.task.status', 'app.open'],
    allowedApps: Object.keys(APP_ALLOWLIST),
  });
}
