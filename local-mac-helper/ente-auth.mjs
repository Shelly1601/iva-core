import { spawn } from 'node:child_process';
import { runMacUiBridge } from './macos-ui.mjs';

const ENTE_APP = '/Applications/Ente Auth.app';
const MAX_OUTPUT_BYTES = 64 * 1024;

function run(command, args, { timeoutMs = 30_000, sensitive = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Ente Auth hat das Zeitlimit überschritten.')); }, timeoutMs);
    child.stdout.on('data', chunk => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout.trim());
      const detail = sensitive ? '' : String(stderr || '').trim().slice(0, 500);
      return reject(new Error(detail || 'Ente Auth konnte den Panasonic-Code nicht sicher bereitstellen.'));
    });
  });
}

async function ensureEnteAuthRunning() {
  await run('/usr/bin/open', ['-a', ENTE_APP], { timeoutMs: 15_000 });
  await new Promise(resolve => setTimeout(resolve, 900));
}

async function runBridge(command, { sensitive = false } = {}) {
  await ensureEnteAuthRunning();
  try { return await runMacUiBridge([command], { timeoutMs: 30_000 }); }
  catch (error) { throw new Error(sensitive ? 'Ente Auth konnte den Panasonic-Code nicht sicher bereitstellen.' : error.message); }
}

export async function enteAuthPanasonicStatus() {
  return runBridge('ente-auth-status');
}

export async function typePanasonicTotpFromEnte() {
  const result = await runBridge('ente-auth-type-panasonic-code', { sensitive: true });
  if (!result?.typed || !result?.submitted || result.secretReturned !== false || result.clipboardUsed !== false) {
    throw new Error('Ente Auth hat den Panasonic-Code nicht sicher eingesetzt.');
  }
  return result;
}

export function enteAuthPolicy() {
  return Object.freeze({
    app: 'Ente Auth',
    bundleId: 'io.ente.auth',
    exactEntry: 'phvaceu-prod / Panasonic',
    forbiddenEntryMarker: 'A.Lausig',
    clipboardUsed: false,
    otpStoredByIva: false,
    otpReturnedToNode: false,
    otpReturnedToRailway: false,
    otpReturnedToModel: false,
  });
}
