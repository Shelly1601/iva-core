import { runMacUiBridge } from './macos-ui.mjs';

export const IVA_UI_DISPLAY_POLICY = 'rightmost-external-display';

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

export async function requireRightDisplayWorkspace() {
  const status = await runMacUiBridge(['display-status'], { timeoutMs: 15000 });
  return resolveRightDisplayWorkspace(status);
}

export async function ensureAppWindowOnRightDisplay(bundleIdentifier) {
  const bundleId = String(bundleIdentifier || '').trim();
  if (!/^[a-z0-9.-]{3,160}$/i.test(bundleId)) throw new Error('Ungültige App-ID für die IVA-Displayregel.');
  const workspace = await requireRightDisplayWorkspace();
  const result = await runMacUiBridge(['ensure-app-window-right', bundleId], { timeoutMs: 20000 });
  if (result.onRightDisplay !== true) throw new Error('IVA-Displayregel blockiert: Das App-Fenster konnte rechts nicht verifiziert werden.');
  return { ...result, workspace };
}

export function chromeBoundsAppleScript(workspace) {
  const bounds = workspace?.bounds;
  if (!bounds) throw new Error('Die rechte Chrome-Arbeitsfläche wurde nicht bestimmt.');
  return `{${bounds.left}, ${bounds.top}, ${bounds.right}, ${bounds.bottom}}`;
}
