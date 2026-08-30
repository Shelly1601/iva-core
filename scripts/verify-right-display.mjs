import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  encodeRightDisplayAttestation,
  ensureAppWindowOnRightDisplay,
  IVA_RIGHT_DISPLAY_ATTESTATION_ENV,
  requireRightDisplayWorkspace,
  resolveRightDisplayAttestation,
  resolveRightDisplayWorkspace,
  windowBoundsInsideRightDisplay,
} from '../local-mac-helper/display-workspace.mjs';

const workspace = resolveRightDisplayWorkspace({ displays: [
  { id: '1', main: true, x: 0, y: 0, width: 2240, height: 1260 },
  { id: '2', main: false, x: 2240, y: -180, width: 5120, height: 1440 },
] });
assert.equal(workspace.policy, 'rightmost-external-display');
assert.equal(workspace.target.id, '2');
assert.ok(workspace.bounds.left > 2240);
assert.ok(workspace.bounds.right < 7360);
assert.equal(windowBoundsInsideRightDisplay([2260, -160, 7340, 1240], workspace), true);
assert.equal(windowBoundsInsideRightDisplay([26, 30, 2060, 1178], workspace), false);

const verifiedAt = Date.parse('2026-08-30T08:00:00.000Z');
const attestation = encodeRightDisplayAttestation(workspace, {
  verifiedAt,
  expiresAt: verifiedAt + 60_000,
});
const attestedWorkspace = resolveRightDisplayAttestation(attestation, { now: verifiedAt + 30_000 });
assert.equal(attestedWorkspace.target.id, '2');
assert.equal(attestedWorkspace.attestedAt, '2026-08-30T08:00:00.000Z');
let attestedBridgeCalls = 0;
const inheritedWorkspace = await requireRightDisplayWorkspace({
  attestation: encodeRightDisplayAttestation(workspace),
  run: async () => { attestedBridgeCalls += 1; throw new Error('Bridge darf nicht erneut abgefragt werden.'); },
});
assert.equal(inheritedWorkspace.target.id, '2');
assert.equal(attestedBridgeCalls, 0);
assert.throws(
  () => resolveRightDisplayAttestation(attestation, { now: verifiedAt + 60_001 }),
  /ungültig oder abgelaufen/,
);

const priorAttestation = process.env[IVA_RIGHT_DISPLAY_ATTESTATION_ENV];
process.env[IVA_RIGHT_DISPLAY_ATTESTATION_ENV] = encodeRightDisplayAttestation(workspace, {
  preparedBundleIdentifiers: ['com.google.Chrome'],
});
try {
  const sandboxFallback = await ensureAppWindowOnRightDisplay('com.google.Chrome', {
    run: async () => { throw new Error('macOS-Bedienungshilfe ist für die IVA-Displayregel nicht freigegeben.'); },
  });
  assert.equal(sandboxFallback.onRightDisplay, true);
  assert.equal(sandboxFallback.verifiedBy, 'trusted-imac-runner-attestation');
  await assert.rejects(
    ensureAppWindowOnRightDisplay('com.microsoft.Outlook', {
      run: async () => { throw new Error('macOS-Bedienungshilfe ist für die IVA-Displayregel nicht freigegeben.'); },
    }),
    /macOS-Bedienungshilfe/,
  );
} finally {
  if (priorAttestation == null) delete process.env[IVA_RIGHT_DISPLAY_ATTESTATION_ENV];
  else process.env[IVA_RIGHT_DISPLAY_ATTESTATION_ENV] = priorAttestation;
}
assert.throws(() => resolveRightDisplayWorkspace({ displays: [
  { id: '1', main: true, x: 0, y: 0, width: 2240, height: 1260 },
] }), /rechte Arbeitsdisplay ist nicht angeschlossen/);
assert.throws(() => resolveRightDisplayWorkspace({ displays: [
  { id: '1', main: true, x: 0, y: 0, width: 2240, height: 1260 },
  { id: '2', main: false, x: 0, y: -1440, width: 2240, height: 1440 },
] }), /nicht eindeutig links\/rechts/);

let transientAttempts = 0;
const recoveredWorkspace = await requireRightDisplayWorkspace({
  attempts: 3,
  retryDelayMs: 100,
  waitFn: async () => {},
  wakeFn: async () => {},
  run: async () => {
    transientAttempts += 1;
    if (transientAttempts < 3) return { displays: [{ id: '1', main: true, x: 0, y: 0, width: 2240, height: 1260 }] };
    return { displays: [
      { id: '1', main: true, x: 0, y: 0, width: 2240, height: 1260 },
      { id: '2', main: false, x: 2240, y: -180, width: 5120, height: 1440 },
    ] };
  },
});
assert.equal(transientAttempts, 3);
assert.equal(recoveredWorkspace.target.id, '2');

let persistentAttempts = 0;
await assert.rejects(requireRightDisplayWorkspace({
  attempts: 4,
  retryDelayMs: 100,
  waitFn: async () => {},
  wakeFn: async () => {},
  run: async () => {
    persistentAttempts += 1;
    return { displays: [{ id: '1', main: true, x: 0, y: 0, width: 2240, height: 1260 }] };
  },
}), /rechte Arbeitsdisplay ist nicht angeschlossen/);
assert.equal(persistentAttempts, 4);

const [pipedriveSource, codexSource, planbarSource, whatsappSource, macUiSource, macBridgeSource, displayCheckSource] = await Promise.all([
  readFile(new URL('../local-mac-helper/chrome-pipedrive.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../local-mac-helper/codex-tasks.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../local-mac-helper/planbar.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../local-mac-helper/whatsapp-mac.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../local-mac-helper/macos-ui.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../local-mac-helper/macos/iva-ax.swift', import.meta.url), 'utf8'),
  readFile(new URL('../local-mac-helper/right-display-check.mjs', import.meta.url), 'utf8'),
]);
assert.match(pipedriveSource, /set ivaWindow to make new window/);
assert.match(pipedriveSource, /if ivaWindow is missing value then/);
assert.match(pipedriveSource, /make new tab at end of tabs of ivaWindow/);
assert.match(pipedriveSource, /set bounds of ivaWindow to/);
assert.match(pipedriveSource, /return output\.split\(','\)\.map\(id => `tab:\$\{id\}`\)/);
assert.doesNotMatch(pipedriveSource, /anchor\.target\s*=\s*['_"]self/);
assert.match(pipedriveSource, /set downloadTab to make new tab/);
assert.match(pipedriveSource, /separater rechter Browser-Downloadtab/);
assert.doesNotMatch(pipedriveSource, /fetch\(downloadUrl/);
assert.match(codexSource, /Bediene ausschließlich das physisch rechte Display/);
assert.match(codexSource, /requireRightDisplayWorkspace/);
assert.match(codexSource, /encodeRightDisplayAttestation/);
assert.match(codexSource, /IVA_RIGHT_DISPLAY_ATTESTATION/);
assert.match(planbarSource, /isRightWorkspace/);
assert.match(whatsappSource, /ensureAppWindowOnRightDisplay\('net\.whatsapp\.WhatsApp'\)/);
assert.match(macUiSource, /const BINARY = path\.join\(BIN_DIR, 'iva-ax'\)/);
assert.match(macUiSource, /sourceDigest: digest, binaryDigest/);
assert.match(macUiSource, /2100-01-01T00:00:00\.000Z/);
assert.match(macUiSource, /STALE_COMPILE_LOCK_MS/);
assert.doesNotMatch(macUiSource, /`iva-ax-\$\{digest/);
assert.match(macBridgeSource, /command == "display-status"/);
assert.match(macBridgeSource, /command == "display-layout"/);
assert.match(macBridgeSource, /command == "frontmost-window-display"/);
assert.match(macBridgeSource, /command == "ensure-app-window-right"/);
assert.match(displayCheckSource, /--require-second-display/);
assert.match(displayCheckSource, /--frontmost-window-must-be-right/);

console.log('Right-display workflow policy checks passed.');
