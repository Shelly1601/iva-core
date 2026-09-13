// The user's exclusive execution host, pinned on 2026-09-13. No iMac fallback.
export const EXECUTION_DEVICE_ID = 'macmini-nadine';
export const EXECUTION_HOSTNAME = 'mac-mini-von-macmini';
export const EXECUTION_HARDWARE_MODEL = 'Mac14,3';
export const EXECUTION_HARDWARE_FINGERPRINT = '8025cc7515fb3f453f9e508e003d03664769c09b7867b7696c057f6407b9365a';
export const EXECUTION_WORKSPACE = '/Users/macmini/Documents/Codex/IVA/iva-core';
export const EXECUTION_PROTOCOL_VERSION = 4;
export const EXECUTION_RELEASE = 'macmini-central-v1';
export const normalizedExecutionHost = value => String(value || '').trim().toLowerCase().replace(/\.local$/, '');
export function isExclusiveExecutionMetadata(value = {}) {
  return normalizedExecutionHost(value.hostname) === EXECUTION_HOSTNAME
    && value.hardwareModel === EXECUTION_HARDWARE_MODEL
    && value.hardwareFingerprint === EXECUTION_HARDWARE_FINGERPRINT
    && value.workspace === EXECUTION_WORKSPACE
    && value.localWorkspace === true
    && value.protocolVersion === EXECUTION_PROTOCOL_VERSION;
}
export function assertExclusiveExecutionMetadata(value) {
  if (!isExclusiveExecutionMetadata(value)) throw new Error('IVA ist ausschließlich an diesen Mac Mini gebunden. iMac, MacBook und andere Geräte sind gesperrt.');
}
