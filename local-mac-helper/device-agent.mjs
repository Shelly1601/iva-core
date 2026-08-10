import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { listFundingReviews } from './funding-review-queue.mjs';
import { runFundingMonitorOnce } from './funding-monitor-runner.mjs';
import { loadFundingMonitorState } from './funding-monitor-state.mjs';
import { fundingMonitorLaunchAgentStatus } from './funding-monitor-launchd.mjs';
import { diagnoseOutlook } from './outlook.mjs';
import { diagnosePipedriveChrome } from './chrome-pipedrive.mjs';
import { diagnoseWhatsAppMac } from './whatsapp-mac.mjs';

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
    const [outlook, pipedrive, whatsapp] = await Promise.all([diagnoseOutlook(), diagnosePipedriveChrome(), diagnoseWhatsAppMac()]);
    return {
      online: true,
      outlook: { installed: outlook.outlook?.installed, running: outlook.outlook?.running, accessibility: outlook.accessibility?.enabled },
      pipedrive: { chromeRunning: pipedrive.chromeRunning, readable: pipedrive.readDealFields },
      whatsapp: { installed: whatsapp.installed, running: whatsapp.running, linked: whatsapp.linkedAccountVerified },
    };
  }
  if (command.action === 'funding.monitor.status') {
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
  if (command.action === 'funding.monitor.run') return runFundingMonitorOnce({ ignoreIdle: true });
  if (command.action === 'funding.reviews.list') {
    const reviews = await listFundingReviews();
    const counts = {};
    for (const review of reviews) counts[review.status] = (counts[review.status] || 0) + 1;
    return { total: reviews.length, counts, latestAt: reviews[0]?.updatedAt || reviews[0]?.createdAt || null };
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
    result = await executeDeviceCommand(command);
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
    allowedActions: ['computer.status', 'funding.monitor.status', 'funding.monitor.run', 'funding.reviews.list', 'app.open'],
    allowedApps: Object.keys(APP_ALLOWLIST),
  });
}
