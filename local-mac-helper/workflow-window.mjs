#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
    // Feste IVA-Betriebsregel: Während eines lokalen Arbeitslaufs darf der Mac
    // weder in den Leerlauf noch in die Sperre wechseln. Nach jedem Abschluss
    // gehen die Bildschirme aus – auch nach Timeout oder Fehler.
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

async function stopCaffeinate(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    closeResult(child).catch(() => null),
    new Promise(resolve => setTimeout(resolve, 1500)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function sleepDisplays() {
  if (process.platform !== 'darwin') return;
  await execFileAsync('/usr/bin/pmset', ['displaysleepnow'], { timeout: 10000, maxBuffer: 128 * 1024 });
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

  const wakeLock = spawn('/usr/bin/caffeinate', ['-dimsu', '-t', String(options.maxSeconds + 10)], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    wakeLock.once('spawn', resolve);
    wakeLock.once('error', reject);
  }).catch(error => { throw new Error(`Wachschutz konnte nicht gestartet werden: ${error.message}`); });

  const task = spawn(options.command, options.args, {
    detached: true,
    env: process.env,
    stdio: 'inherit',
  });
  const taskResult = closeResult(task);
  let timedOut = false;
  let forceTimer = null;
  const timeout = setTimeout(() => {
    timedOut = true;
    console.error(`Workflow-Fenster: Zeitlimit von ${options.maxSeconds} Sekunden erreicht.`);
    killProcessGroup(task, 'SIGTERM');
    forceTimer = setTimeout(() => killProcessGroup(task, 'SIGKILL'), 5000);
    forceTimer.unref?.();
  }, options.maxSeconds * 1000);
  timeout.unref?.();

  let result;
  try {
    result = await taskResult;
  } finally {
    clearTimeout(timeout);
    if (forceTimer) clearTimeout(forceTimer);
    await stopCaffeinate(wakeLock);
    if (options.sleepDisplays) {
      await sleepDisplays().catch(error => console.error(`Workflow-Fenster: Display konnte nicht ausgeschaltet werden: ${error.message}`));
    }
  }

  const summary = {
    status: timedOut ? 'timed_out' : result.code === 0 ? 'completed' : 'failed',
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    maxSeconds: options.maxSeconds,
    exitCode: result.code,
    signal: result.signal,
    displaySleepRequested: options.sleepDisplays,
  };
  console.log(JSON.stringify(summary));
  if (timedOut) process.exitCode = 124;
  else if (result.code !== 0) process.exitCode = Number.isInteger(result.code) ? result.code : 1;
}

main().catch(error => {
  console.error(`Workflow-Fenster: ${error.message}`);
  process.exitCode = 1;
});
