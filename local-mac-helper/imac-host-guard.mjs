import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EXECUTION_HOSTNAME, EXECUTION_HARDWARE_MODEL, EXECUTION_HARDWARE_FINGERPRINT } from './execution-host-policy.mjs';

let cachedHardwareModel;
let cachedFingerprint;

export function detectHardwareFingerprint({ platform = os.platform(), exec = execFileSync } = {}) {
  if (platform !== 'darwin') return '';
  if (cachedFingerprint !== undefined && exec === execFileSync) return cachedFingerprint;
  try {
    const raw = String(exec('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']}));
    const uuid = raw.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1];
    const value = uuid ? crypto.createHash('sha256').update(uuid).digest('hex') : '';
    if(exec === execFileSync) cachedFingerprint = value;
    return value;
  } catch { return ''; }
}

function normalizedHost(value) {
  return String(value || '').trim().toLowerCase().replace(/\.local$/, '');
}

export function isPhysicalImacHardwareModel(value) {
  return String(value || '').trim() === EXECUTION_HARDWARE_MODEL;
}

export function detectAppleHardwareModel({ platform = os.platform(), exec = execFileSync } = {}) {
  if (platform !== 'darwin') return '';
  if (cachedHardwareModel !== undefined && exec === execFileSync) return cachedHardwareModel;
  let model = '';
  try {
    model = String(exec('/usr/sbin/sysctl', ['-n', 'hw.model'], {
      encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
    }) || '').trim();
  } catch {
    try {
      const raw = String(exec('/usr/sbin/system_profiler', ['SPHardwareDataType', '-json'], {
        encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      }) || '');
      model = String(JSON.parse(raw)?.SPHardwareDataType?.[0]?.machine_model || '').trim();
    } catch {
      model = '';
    }
  }
  if (exec === execFileSync) cachedHardwareModel = model;
  return model;
}

export function isAllowedImacExecutionHost(
  hostname = os.hostname(),
  expectedHostname = process.env.IVA_MACMINI_HOSTNAME,
  hardwareModel = detectAppleHardwareModel(),
  hardwareFingerprint = detectHardwareFingerprint(),
) {
  if (!isPhysicalImacHardwareModel(hardwareModel)) return false;
  const actual = normalizedHost(hostname);
  const expected = normalizedHost(expectedHostname);
  return actual === EXECUTION_HOSTNAME && (!expected || expected === EXECUTION_HOSTNAME)
    && hardwareFingerprint === EXECUTION_HARDWARE_FINGERPRINT;
}

export function assertImacExecutionHost(
  hostname = os.hostname(),
  expectedHostname = process.env.IVA_MACMINI_HOSTNAME,
  hardwareModel = detectAppleHardwareModel(),
  hardwareFingerprint = detectHardwareFingerprint(),
) {
  if (isAllowedImacExecutionHost(hostname, expectedHostname, hardwareModel, hardwareFingerprint)) return true;
  const detected = String(hardwareModel || 'nicht erkannt').replace(/[^A-Za-z0-9,._-]/g, '').slice(0, 80) || 'nicht-erkannt';
  throw new Error(`Der Gerätekanal macmini-nadine darf ausschließlich auf einem echten Mac Mini starten (Hardwaremodell: ${detected}).`);
}
