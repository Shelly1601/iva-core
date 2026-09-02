import crypto from 'node:crypto';
import { withImacExecutionLock, imacUiIsBusy } from './ui-execution-lock.mjs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { access, readFile, stat } from 'node:fs/promises';
import { cleanupExpiredDewarmteLocalData, storeDewarmteLocalSupplement } from './dewarmte-local-retention.mjs';

const execFileAsync = promisify(execFile);
export const IMAC_DEVICE_ID = 'imac-nadine';
export const DEVICE_AGENT_PROTOCOL_VERSION = 2;
export const DEVICE_AGENT_RELEASE = 'imac-central-v8';
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
const APP_BUNDLE_IDENTIFIERS = Object.freeze({
  'Microsoft Outlook': 'com.microsoft.Outlook',
  'Google Chrome': 'com.google.Chrome',
  WhatsApp: 'net.whatsapp.WhatsApp',
  Codex: 'com.openai.codex',
  ChatGPT: 'com.openai.codex',
});
// Reine Task-Starts bedienen keine UI. Der gestartete Worker hält selbst die
// UI-Sperre und den Wachschutz; Display-/Lockfehler dürfen die Übergabe nicht verdecken.
const UI_ACTIONS = new Set(['computer.status', 'portal.login', 'app.open']);
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

export function deviceCommandNeedsImmediateUiLock(action) {
  return UI_ACTIONS.has(String(action || ''));
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

export async function publishDewarmtePdf({ filePath, jobId, language = '', revision = false }) {
  const absolutePath = path.resolve(String(filePath || ''));
  const safeJobId = String(jobId || '').trim();
  const safeLanguage = String(language || '').trim().toLowerCase();
  if (!path.isAbsolute(absolutePath) || !/^[a-f0-9-]{36}$/i.test(safeJobId)) throw new Error('PDF-Pfad oder DeWarmte-Job-Schlüssel ist ungültig.');
  if (safeLanguage && !['de', 'en', 'nl'].includes(safeLanguage)) throw new Error('DeWarmte-PDF-Sprache muss de, en oder nl sein.');
  const info = await stat(absolutePath);
  if (!info.isFile() || info.size < 5 || info.size > 25 * 1024 * 1024 || path.extname(absolutePath).toLowerCase() !== '.pdf') {
    throw new Error('Für die DeWarmte-Projektakte ist genau eine PDF-Datei bis 25 MB erforderlich.');
  }
  const buffer = await readFile(absolutePath);
  if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('Die Datei besitzt keine gültige PDF-Signatur.');
  const server = cleanServerUrl(process.env.IVA_DEVICE_SERVER_URL);
  const token = await readImacDeviceToken();
  const agent = imacDeviceAgentMetadata();
  const query = new URLSearchParams({ name: path.basename(absolutePath), jobId: safeJobId, ...(safeLanguage ? { language: safeLanguage } : {}), ...(revision ? { revision: 'append' } : {}) });
  const response = await fetch(`${server}/device-agent/${IMAC_DEVICE_ID}/projects/dewarmte/files?${query}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/pdf',
      'X-IVA-Agent-Host': agent.hostname,
      'X-IVA-Agent-Ui-Busy': agent.uiBusy ? 'true' : 'false',
      'X-IVA-Agent-Protocol': String(agent.protocolVersion),
      'X-IVA-Agent-Release': agent.release,
      'X-IVA-Agent-Revision': agent.runtimeRevision,
      'X-IVA-Agent-Workspace': agent.workspace,
      'X-IVA-Agent-ICloud': agent.iCloudAuthoritative ? 'true' : 'false',
    },
    body: buffer,
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw new Error(`DeWarmte-PDF-Upload HTTP ${response.status}: ${String(payload?.error || text || response.statusText).slice(0, 400)}`);
  return payload;
}

export async function fetchDewarmteSupplementPdf({ inputId, name, jobId }) {
  const safeInputId = String(inputId || '').trim();
  if (!/^[a-f0-9-]{36}$/i.test(safeInputId)) throw new Error('Ungültige DeWarmte-Zusatzdatei.');
  const server = cleanServerUrl(process.env.IVA_DEVICE_SERVER_URL);
  const token = await readImacDeviceToken();
  const agent = imacDeviceAgentMetadata();
  const response = await fetch(`${server}/device-agent/${IMAC_DEVICE_ID}/dewarmte-inputs/${safeInputId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-IVA-Agent-Host': agent.hostname,
      'X-IVA-Agent-Ui-Busy': agent.uiBusy ? 'true' : 'false',
      'X-IVA-Agent-Protocol': String(agent.protocolVersion),
      'X-IVA-Agent-Release': agent.release,
      'X-IVA-Agent-Revision': agent.runtimeRevision,
      'X-IVA-Agent-Workspace': agent.workspace,
      'X-IVA-Agent-ICloud': agent.iCloudAuthoritative ? 'true' : 'false',
    },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`DeWarmte-Zusatz-PDF HTTP ${response.status}: ${String(await response.text()).slice(0, 400)}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 15 * 1024 * 1024) throw new Error('DeWarmte-Zusatz-PDF überschreitet 15 MB.');
  return storeDewarmteLocalSupplement({ jobId, name, buffer });
}

// Called by the fixed, read-only browser capacity worker only after its
// deterministic DOM validation. Credentials never enter the worker prompt.
export async function publishPlanbarCapacitySnapshot(snapshot) {
  return request(`/device-agent/${IMAC_DEVICE_ID}/planbar-capacity`, { method: 'POST', body: snapshot });
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

export async function fetchIncidentPreventions(input = {}) {
  const query = new URLSearchParams();
  for (const key of ['system', 'workflowId', 'action', 'step', 'runId', 'limit']) {
    if (input[key] !== undefined && input[key] !== '') query.set(key, String(input[key]));
  }
  return request(`/device-agent/${IMAC_DEVICE_ID}/incidents/recommendations?${query}`);
}

export async function reportIncident(input = {}) {
  return request(`/device-agent/${IMAC_DEVICE_ID}/incidents`, { method: 'POST', body: input });
}

export async function reportPreventionUse(fingerprint, input = {}) {
  const safeFingerprint = String(fingerprint || '').trim();
  if (!/^[a-f0-9]{24}$/.test(safeFingerprint)) throw new Error('Ungültiger Fehlerfingerabdruck.');
  return request(`/device-agent/${IMAC_DEVICE_ID}/incidents/${safeFingerprint}/prevention-use`, { method: 'POST', body: input });
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
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/open', ['-a', appPath], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', code => code === 0
      ? resolve()
      : reject(new Error(`${appName} konnte nicht geöffnet werden.`)));
  });
  const { ensureAppWindowOnRightDisplay } = await import('./display-workspace.mjs');
  const display = await ensureAppWindowOnRightDisplay(APP_BUNDLE_IDENTIFIERS[appName]);
  return { app: appName, applicationPath: appPath, opened: true, displayPolicy: display.workspace.policy, onRightDisplay: display.onRightDisplay === true };
}

// The tooltip endpoint behind the open Planbar board already returns the live
// scheduling data for an explicit date range. Reading it must not wait for the
// shared UI lock or reload the page first: either condition can leave IVA on an
// old index while another iMac workflow is using Chrome. A verified page reload
// remains a fallback for an expired/missing board session.
export async function collectFreshPlanbarSearchSnapshot({ collect, refresh } = {}) {
  const planbar = (!collect || !refresh) ? await import('./planbar.mjs') : null;
  const readLiveIndex = collect || planbar.collectPlanbarSearchIndex;
  const reloadPlanbar = refresh || planbar.refreshPlanbarPage;
  let directError;
  try {
    const live = await readLiveIndex({ timeoutMs: 30_000 });
    return {
      ...live,
      sourceCheckedAt: live.updatedAt,
      pageRefreshedAt: null,
      refreshMode: 'direct-live-read',
    };
  } catch (error) {
    directError = error;
  }
  try {
    const page = await reloadPlanbar();
    const live = await readLiveIndex({ timeoutMs: 60_000 });
    return {
      ...live,
      sourceCheckedAt: live.updatedAt,
      pageRefreshedAt: page?.refreshedAt || null,
      refreshMode: 'page-reload-fallback',
    };
  } catch (fallbackError) {
    const directMessage = String(directError?.message || directError || 'unbekannter Fehler');
    const fallbackMessage = String(fallbackError?.message || fallbackError || 'unbekannter Fehler');
    throw new Error(`Planbar-Live-Lesung fehlgeschlagen (${directMessage}). Auch die erneute Anmeldung/Aktualisierung war nicht möglich (${fallbackMessage}).`);
  }
}

export function planbarSearchIndexPayload(snapshot = {}) {
  return {
    updatedAt: snapshot.updatedAt,
    rangeStart: snapshot.rangeStart,
    rangeEndExclusive: snapshot.rangeEndExclusive,
    appointments: Array.isArray(snapshot.appointments) ? snapshot.appointments : [],
  };
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
    const { backgroundIntegrationStatus } = await import('./background-integrations.mjs');
    const { diagnoseWhatsAppMac } = await import('./whatsapp-mac.mjs');
    const { runMacUiBridge } = await import('./macos-ui.mjs');
    const { requireRightDisplayWorkspace } = await import('./display-workspace.mjs');
    // Die UI-Pruefungen laufen absichtlich nacheinander. Outlook und WhatsApp
    // greifen beide auf macOS Accessibility/Apple Events zu und koennen sich
    // bei parallelen Probes gegenseitig einen falschen Negativstatus liefern.
    const outlook = await diagnoseOutlook();
    const bridge = await runMacUiBridge(['accessibility-status'], { timeoutMs: 15000 }).catch(() => ({ trusted: false }));
    const backgroundIntegrations = await backgroundIntegrationStatus();
    const whatsapp = await diagnoseWhatsAppMac();
    const display = await requireRightDisplayWorkspace();
    return {
      online: true,
      display: { policy: display.policy, displayCount: display.displayCount, target: display.target },
      outlook: { installed: outlook.outlook?.installed, running: outlook.outlook?.running, accessibility: bridge.trusted === true },
      pipedrive: { backgroundApi: true, readable: backgroundIntegrations?.pipedrive?.readReady === true },
      airtable: { backgroundApi: true, readable: backgroundIntegrations?.airtable?.readReady === true, writeEnabled: false },
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
    const { buildPlanbarCapacitySnapshot, collectPlanbarSearchIndex, refreshPlanbarPage } = await import('./planbar.mjs');
    const { withMacWakeGuard } = await import('./mac-wake-guard.mjs');
    const snapshot = await collectFreshPlanbarSearchSnapshot({
      collect: collectPlanbarSearchIndex,
      refresh: () => withImacExecutionLock(
        () => withMacWakeGuard(() => refreshPlanbarPage(), { maxSeconds: 90 }),
        { timeoutMs: 20_000 },
      ),
    });
    const capacity = buildPlanbarCapacitySnapshot(snapshot);
    const [stored, storedCapacity] = await Promise.all([
      request(`/device-agent/${IMAC_DEVICE_ID}/planbar-search-index`, { method: 'POST', body: planbarSearchIndexPayload(snapshot) }),
      request(`/device-agent/${IMAC_DEVICE_ID}/planbar-capacity`, { method: 'POST', body: capacity }),
    ]);
    return {
      updatedAt: stored.updatedAt,
      appointmentCount: stored.appointmentCount,
      rangeStart: stored.rangeStart,
      rangeEndExclusive: stored.rangeEndExclusive,
      capacityWeeks: storedCapacity.planbarCapacity?.weeks || capacity.weeks,
      minimumCapacityBlockDays: capacity.minimumBlockDays,
      sourceCheckedAt: capacity.sourceCheckedAt,
      refreshMode: snapshot.refreshMode,
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
    const { codexJobIdForRequest, startProjectWorkflowTask } = await import('./codex-tasks.mjs');
    const requestId = command.payload?.requestId || command.id;
    let workflowInput = command.payload;
    if (command.payload?.projectId === 'dewarmte' && command.payload?.supplementaryPdfId) {
      const jobId = codexJobIdForRequest(requestId);
      const supplementaryPdfPath = await fetchDewarmteSupplementPdf({
        inputId: command.payload.supplementaryPdfId,
        name: command.payload.supplementaryPdfName,
        jobId,
      });
      workflowInput = { ...command.payload, supplementaryPdfPath };
    }
    return startProjectWorkflowTask({
      workflowId: command.payload?.workflowId,
      requestId,
      runMode: command.payload?.runMode,
      automationSlotKey: command.payload?.automationSlotKey,
      workflowInput,
    });
  }
  if (command.action === 'app.open') return openApplication(command.payload?.app);
  throw new Error('Der iMac hat diesen Befehl nicht in seiner lokalen Positivliste.');
}

export async function runImacDeviceAgentOnce() {
  assertImacExecutionHost();
  if (!isAuthoritativeIcloudWorkspace()) {
    throw new Error(`Der iMac-Geräteagent läuft nicht aus dem verbindlichen iCloud-Workspace (${AGENT_WORKSPACE}).`);
  }
  await cleanupExpiredDewarmteLocalData().catch(error => console.error(`DeWarmte-Lokalbereinigung: ${error.message}`));
  await reportImacDeviceAgentHeartbeat().catch(error => {
    // Während der einmaligen Railway-Migration darf ein noch nicht deployter
    // Heartbeat-Endpunkt den bisherigen Agentenabruf nicht unterbrechen.
    if (!/HTTP 404\b/.test(String(error?.message || error))) throw error;
  });
  // Für alle lokalen Codex-Workflows Lebenszeichen nachliefern, verlorene
  // Abschlussmeldungen synchronisieren und unterbrochene Worker kontrolliert
  // fortsetzen. Gesicherte Planbar-Reservierungen bleiben dabei hart vor einer
  // automatischen Doppelbuchung geschützt.
  const { syncCodexTaskStates } = await import('./codex-tasks.mjs');
  await syncCodexTaskStates().catch(error => console.error(`Workflow-Aufsicht: ${error.message}`));
  const payload = await request(`/device-agent/${IMAC_DEVICE_ID}/commands/next`);
  const command = payload?.command;
  if (!command) return { status: 'no_command', deviceId: IMAC_DEVICE_ID };
  let ok = false;
  let result = null;
  let error = '';
  let failureStage = '';
  try {
    if (deviceCommandNeedsImmediateUiLock(command.action)) {
      const { withMacWakeGuard } = await import('./mac-wake-guard.mjs');
      result = await withImacExecutionLock(() => withMacWakeGuard(() => executeDeviceCommand(command), { maxSeconds: 120 }), { timeoutMs: 20_000 });
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
