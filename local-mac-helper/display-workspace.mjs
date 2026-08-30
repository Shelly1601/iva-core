import { spawn } from 'node:child_process';
import { runMacUiBridge } from './macos-ui.mjs';

export const IVA_UI_DISPLAY_POLICY = 'rightmost-external-display';
export const IVA_RIGHT_DISPLAY_ATTESTATION_ENV = 'IVA_RIGHT_DISPLAY_ATTESTATION';
const MAX_ATTESTATION_LIFETIME_MS = (6 * 60 * 60_000) + (5 * 60_000);

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Ungültige Display-Geometrie (${label}).`);
  return number;
}

export function resolveRightDisplayWorkspace(input = {}) {
  const displays = (Array.isArray(input.displays) ? input.displays : []).map(display => ({
    id: String(display.id ?? ''),
    main: display.main === true,
    x: finiteNumber(display.x, 'x'),
    y: finiteNumber(display.y, 'y'),
    width: finiteNumber(display.width, 'width'),
    height: finiteNumber(display.height, 'height'),
  })).filter(display => display.width > 0 && display.height > 0);
  if (displays.length < 2) {
    throw new Error('IVA-Displayregel blockiert: Das rechte Arbeitsdisplay ist nicht angeschlossen. Links wird nicht ersatzweise gearbeitet.');
  }
  const target = [...displays].sort((a, b) => {
    const rightEdge = (b.x + b.width) - (a.x + a.width);
    return rightEdge || b.x - a.x || b.width - a.width;
  })[0];
  const otherDisplays = displays.filter(display => display.id !== target.id);
  if (!otherDisplays.some(display => target.x >= display.x + display.width)) {
    throw new Error('IVA-Displayregel blockiert: Die angeschlossenen Displays sind nicht eindeutig links/rechts angeordnet.');
  }
  const insetX = Math.min(36, Math.max(18, Math.round(target.width * 0.008)));
  const insetY = Math.min(36, Math.max(18, Math.round(target.height * 0.015)));
  const bounds = {
    left: Math.round(target.x + insetX),
    top: Math.round(target.y + insetY),
    right: Math.round(target.x + target.width - insetX),
    bottom: Math.round(target.y + target.height - insetY),
  };
  return Object.freeze({
    policy: IVA_UI_DISPLAY_POLICY,
    displayCount: displays.length,
    target: Object.freeze(target),
    bounds: Object.freeze(bounds),
  });
}

export function windowBoundsInsideRightDisplay(bounds = [], workspace) {
  const values = Array.isArray(bounds) ? bounds.map(Number) : [];
  if (values.length !== 4 || values.some(value => !Number.isFinite(value))) return false;
  const [left, top, right, bottom] = values;
  const target = workspace?.target;
  if (!target) return false;
  return left >= target.x && top >= target.y
    && right <= target.x + target.width && bottom <= target.y + target.height
    && right > left && bottom > top;
}

export function encodeRightDisplayAttestation(workspace, {
  verifiedAt = Date.now(),
  expiresAt = Number(verifiedAt) + MAX_ATTESTATION_LIFETIME_MS,
  preparedBundleIdentifiers = [],
} = {}) {
  const verified = Number(verifiedAt);
  const expires = Number(expiresAt);
  if (!Number.isFinite(verified) || !Number.isFinite(expires)
    || expires <= verified || expires - verified > MAX_ATTESTATION_LIFETIME_MS) {
    throw new Error('Ungültige Laufzeit des Rechtsbildschirm-Nachweises.');
  }
  if (workspace?.policy !== IVA_UI_DISPLAY_POLICY || Number(workspace?.displayCount) < 2
    || !windowBoundsInsideRightDisplay([
      workspace?.bounds?.left,
      workspace?.bounds?.top,
      workspace?.bounds?.right,
      workspace?.bounds?.bottom,
    ], workspace)) {
    throw new Error('Der Rechtsbildschirm-Nachweis enthält keine gültige Arbeitsfläche.');
  }
  const payload = {
    version: 1,
    policy: IVA_UI_DISPLAY_POLICY,
    verifiedAt: new Date(verified).toISOString(),
    expiresAt: new Date(expires).toISOString(),
    displayCount: Number(workspace.displayCount),
    target: workspace.target,
    bounds: workspace.bounds,
    preparedBundleIdentifiers: [...new Set(preparedBundleIdentifiers.map(value => String(value || '').trim()))]
      .filter(value => /^[a-z0-9.-]{3,160}$/i.test(value)),
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function resolveRightDisplayAttestation(encoded, { now = Date.now() } = {}) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(String(encoded || ''), 'base64url').toString('utf8'));
  } catch {
    throw new Error('Der Rechtsbildschirm-Nachweis ist beschädigt.');
  }
  const verifiedAt = Date.parse(payload?.verifiedAt || '');
  const expiresAt = Date.parse(payload?.expiresAt || '');
  const checkedAt = Number(now);
  if (payload?.version !== 1 || payload?.policy !== IVA_UI_DISPLAY_POLICY
    || !Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt) || !Number.isFinite(checkedAt)
    || verifiedAt > checkedAt + 60_000 || expiresAt <= checkedAt
    || expiresAt <= verifiedAt || expiresAt - verifiedAt > MAX_ATTESTATION_LIFETIME_MS) {
    throw new Error('Der Rechtsbildschirm-Nachweis ist ungültig oder abgelaufen.');
  }
  const workspace = Object.freeze({
    policy: IVA_UI_DISPLAY_POLICY,
    displayCount: finiteNumber(payload.displayCount, 'Anzahl'),
    target: Object.freeze({
      id: String(payload?.target?.id ?? ''),
      main: payload?.target?.main === true,
      x: finiteNumber(payload?.target?.x, 'x'),
      y: finiteNumber(payload?.target?.y, 'y'),
      width: finiteNumber(payload?.target?.width, 'width'),
      height: finiteNumber(payload?.target?.height, 'height'),
    }),
    bounds: Object.freeze({
      left: finiteNumber(payload?.bounds?.left, 'links'),
      top: finiteNumber(payload?.bounds?.top, 'oben'),
      right: finiteNumber(payload?.bounds?.right, 'rechts'),
      bottom: finiteNumber(payload?.bounds?.bottom, 'unten'),
    }),
    attestedAt: payload.verifiedAt,
    attestationExpiresAt: payload.expiresAt,
    preparedBundleIdentifiers: Object.freeze((Array.isArray(payload.preparedBundleIdentifiers)
      ? payload.preparedBundleIdentifiers : []).map(value => String(value || '').trim())
      .filter(value => /^[a-z0-9.-]{3,160}$/i.test(value))),
  });
  if (workspace.displayCount < 2 || workspace.target.width <= 0 || workspace.target.height <= 0
    || !windowBoundsInsideRightDisplay([
      workspace.bounds.left,
      workspace.bounds.top,
      workspace.bounds.right,
      workspace.bounds.bottom,
    ], workspace)) {
    throw new Error('Der Rechtsbildschirm-Nachweis enthält keine gültige Arbeitsfläche.');
  }
  return workspace;
}

async function wakeDisplaysForVerification() {
  if (process.platform !== 'darwin') return;
  // Keep the synthetic user-activity assertion alive while CoreGraphics reads
  // the display list. Waiting for caffeinate to exit first lets a sleeping
  // external display detach again in the small gap before `display-status`.
  const wakeLock = spawn('/usr/bin/caffeinate', ['-u', '-t', '90'], {
    stdio: 'ignore',
  });
  wakeLock.unref();
  await new Promise(resolve => setTimeout(resolve, 1000));
  return () => {
    try { wakeLock.kill('SIGTERM'); } catch { /* The wake lease already ended. */ }
  };
}

export async function requireRightDisplayWorkspace({
  attempts = 30,
  retryDelayMs = 1500,
  run = runMacUiBridge,
  waitFn = delay => new Promise(resolve => setTimeout(resolve, delay)),
  wakeFn = wakeDisplaysForVerification,
  attestation = process.env[IVA_RIGHT_DISPLAY_ATTESTATION_ENV],
} = {}) {
  // The trusted iMac runner checks CoreGraphics before it starts a sandboxed
  // Codex task. Reuse that task-scoped result inside the child: sandboxed
  // processes can otherwise receive a false one-display snapshot even while
  // the external screen and the real desktop session are both available.
  if (String(attestation || '').trim()) return resolveRightDisplayAttestation(attestation);
  const maximumAttempts = Math.max(1, Math.min(30, Number(attempts) || 30));
  let lastError;
  const releaseWakeLease = await wakeFn();
  try {
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        const status = await run(['display-status'], { timeoutMs: 5000 });
        return resolveRightDisplayWorkspace(status);
      } catch (error) {
        lastError = error;
        if (attempt < maximumAttempts) await waitFn(Math.max(100, Math.min(2000, Number(retryDelayMs) || 1500)));
      }
    }
    throw lastError;
  } finally {
    if (typeof releaseWakeLease === 'function') releaseWakeLease();
  }
}

export async function ensureAppWindowOnRightDisplay(bundleIdentifier, { run = runMacUiBridge } = {}) {
  const bundleId = String(bundleIdentifier || '').trim();
  if (!/^[a-z0-9.-]{3,160}$/i.test(bundleId)) throw new Error('Ungültige App-ID für die IVA-Displayregel.');
  const workspace = await requireRightDisplayWorkspace();
  let result;
  try {
    result = await run(['ensure-app-window-right', bundleId], { timeoutMs: 20000 });
  } catch (error) {
    // Accessibility permission is attached to the responsible process on
    // macOS. A sandboxed Codex child may therefore be denied even though the
    // trusted launchd runner pre-positioned and verified this exact app only
    // moments earlier. Accept only that task-scoped, expiring app receipt.
    if (workspace.attestedAt
      && workspace.preparedBundleIdentifiers?.includes(bundleId)
      && /macOS-Bedienungshilfe.*nicht freigegeben/i.test(String(error?.message || error))) {
      return {
        bundleIdentifier: bundleId,
        onRightDisplay: true,
        verifiedBy: 'trusted-imac-runner-attestation',
        workspace,
      };
    }
    throw error;
  }
  if (result.onRightDisplay !== true) throw new Error('IVA-Displayregel blockiert: Das App-Fenster konnte rechts nicht verifiziert werden.');
  return { ...result, workspace };
}

export function chromeBoundsAppleScript(workspace) {
  const bounds = workspace?.bounds;
  if (!bounds) throw new Error('Die rechte Chrome-Arbeitsfläche wurde nicht bestimmt.');
  return `{${bounds.left}, ${bounds.top}, ${bounds.right}, ${bounds.bottom}}`;
}
