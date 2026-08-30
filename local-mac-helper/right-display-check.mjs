#!/usr/bin/env node
import { requireRightDisplayWorkspace } from './display-workspace.mjs';
import { assertFrontmostWindowOnRightDisplay } from './macos-ui.mjs';

async function main() {
  const options = new Set(process.argv.slice(2));
  const workspace = await requireRightDisplayWorkspace();
  if (options.has('--frontmost-window-must-be-right')) {
    const window = await assertFrontmostWindowOnRightDisplay({ requireSecondDisplay: true });
    console.log(JSON.stringify({ ok: true, mode: 'frontmost-window', policy: workspace.policy, window }, null, 2));
    return;
  }
  if (options.size && !options.has('--require-second-display')) throw new Error('Unbekannte Rechtsbildschirm-Prüfoption.');
  console.log(JSON.stringify({ ok: true, mode: 'display-layout', ...workspace }, null, 2));
}

main().catch(error => {
  console.error(`Fehler: ${error.message}`);
  process.exitCode = 1;
});
