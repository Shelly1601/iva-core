#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { withMacWakeGuard } from './mac-wake-guard.mjs';

function parseArguments(argv) {
  const separator = argv.indexOf('--');
  if (separator < 0 || separator === argv.length - 1) {
    throw new Error('Aufruf: workflow-window.mjs [--max-seconds 1200] [--sleep-displays] [--dry-run] -- <programm> [argumente]');
  }
  const options = argv.slice(0, separator);
  const command = argv[separator + 1];
  const args = argv.slice(separator + 2);
  const maxIndex = options.indexOf('--max-seconds');
  const requestedSeconds = maxIndex >= 0 ? Number(options[maxIndex + 1]) : 1200;
  const maxSeconds = Math.max(60, Math.min(1200, Number.isFinite(requestedSeconds) ? requestedSeconds : 1200));
  return {
    command,
    args,
    maxSeconds,
    // Während des Laufs bleibt der Mac wach. Nach Abschluss darf IVA den Bildschirm
    // nur bei einem wirklich unbeaufsichtigten Nachtlauf ausschalten.
    sleepDisplays: true,
    keepDisplayAwake: true,
    dryRun: options.includes('--dry-run'),
  };
}

function closeResult(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function killProcessGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch {} }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const startedAt = new Date();
  if (options.dryRun) {
    console.log(JSON.stringify({
      status: 'dry_run',
      command: options.command,
      args: options.args,
      maxSeconds: options.maxSeconds,
      keepDisplayAwake: options.keepDisplayAwake,
      sleepDisplays: options.sleepDisplays,
    }));
    return;
  }

  let timedOut = false;
  let displaySleepDecision = { requested: false, reason: 'inherited-wake-guard' };
  const result = await withMacWakeGuard(async () => {
    const task = spawn(options.command, options.args, {
      detached: true,
      env: { ...process.env, IVA_MAC_WAKE_GUARD_ACTIVE: '1' },
      stdio: 'inherit',
    });
    const taskResult = closeResult(task);
    let forceTimer = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      console.error(`Workflow-Fenster: Zeitlimit von ${options.maxSeconds} Sekunden erreicht.`);
      killProcessGroup(task, 'SIGTERM');
      forceTimer = setTimeout(() => killProcessGroup(task, 'SIGKILL'), 5000);
      forceTimer.unref?.();
    }, options.maxSeconds * 1000);
    timeout.unref?.();

    try {
      return await taskResult;
    } finally {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
    }
  }, {
    maxSeconds: options.maxSeconds + 10,
    sleepDisplays: options.sleepDisplays,
    onDisplaySleepDecision: decision => { displaySleepDecision = decision; },
  });

  const summary = {
    status: timedOut ? 'timed_out' : result.code === 0 ? 'completed' : 'failed',
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    maxSeconds: options.maxSeconds,
    exitCode: result.code,
    signal: result.signal,
    displaySleepRequested: displaySleepDecision.requested,
    displaySleepDecision: displaySleepDecision.reason,
  };
  console.log(JSON.stringify(summary));
  if (timedOut) process.exitCode = 124;
  else if (result.code !== 0) process.exitCode = Number.isInteger(result.code) ? result.code : 1;
}

main().catch(error => {
  console.error(`Workflow-Fenster: ${error.message}`);
  process.exitCode = 1;
});
