import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveRightDisplayWorkspace, windowBoundsInsideRightDisplay } from '../local-mac-helper/display-workspace.mjs';

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
assert.throws(() => resolveRightDisplayWorkspace({ displays: [
  { id: '1', main: true, x: 0, y: 0, width: 2240, height: 1260 },
] }), /rechte Arbeitsdisplay ist nicht angeschlossen/);
assert.throws(() => resolveRightDisplayWorkspace({ displays: [
  { id: '1', main: true, x: 0, y: 0, width: 2240, height: 1260 },
  { id: '2', main: false, x: 0, y: -1440, width: 2240, height: 1440 },
] }), /nicht eindeutig links\/rechts/);

const [pipedriveSource, codexSource, planbarSource, whatsappSource, macUiSource, macBridgeSource] = await Promise.all([
  readFile(new URL('../local-mac-helper/chrome-pipedrive.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../local-mac-helper/codex-tasks.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../local-mac-helper/planbar.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../local-mac-helper/whatsapp-mac.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../local-mac-helper/macos-ui.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../local-mac-helper/macos/iva-ax.swift', import.meta.url), 'utf8'),
]);
assert.match(pipedriveSource, /set ivaWindow to make new window/);
assert.match(pipedriveSource, /set URL of active tab of ivaWindow/);
assert.match(pipedriveSource, /set bounds of ivaWindow to/);
assert.match(pipedriveSource, /window:\$\{output\}/);
assert.doesNotMatch(pipedriveSource, /anchor\.target\s*=\s*['_"]self/);
assert.match(pipedriveSource, /set downloadTab to make new tab/);
assert.match(pipedriveSource, /separater rechter Browser-Downloadtab/);
assert.doesNotMatch(pipedriveSource, /fetch\(downloadUrl/);
assert.match(codexSource, /Bediene ausschließlich das physisch rechte Display/);
assert.match(codexSource, /requireRightDisplayWorkspace/);
assert.match(planbarSource, /isRightWorkspace/);
assert.match(whatsappSource, /ensureAppWindowOnRightDisplay\('net\.whatsapp\.WhatsApp'\)/);
assert.match(macUiSource, /const BINARY = path\.join\(BIN_DIR, 'iva-ax'\)/);
assert.match(macUiSource, /sourceDigest: digest, binaryDigest/);
assert.match(macUiSource, /2100-01-01T00:00:00\.000Z/);
assert.doesNotMatch(macUiSource, /`iva-ax-\$\{digest/);
assert.match(macBridgeSource, /command == "display-status"/);
assert.match(macBridgeSource, /command == "display-layout"/);
assert.match(macBridgeSource, /command == "frontmost-window-display"/);
assert.match(macBridgeSource, /command == "ensure-app-window-right"/);

console.log('Right-display workflow policy checks passed.');
