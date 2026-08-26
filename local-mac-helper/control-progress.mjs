#!/usr/bin/env node
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { reportOperationalRun } from './device-agent.mjs';

const STATE_DIR = process.env.IVA_CONTROL_PROGRESS_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper');
const STATE_FILE = path.join(STATE_DIR, 'current-control-progress.json');
const PHASE_PROGRESS = Object.freeze({ planning: 10, implementing: 30, testing: 50, committing: 65, pushing: 75, deploying: 88, live_verification: 96, completed: 100 });

function clean(value, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function load() {
  return JSON.parse(await readFile(STATE_FILE, 'utf8'));
}

async function save(value) {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await writeFile(STATE_FILE, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function publish(state) {
  const terminal = ['completed', 'failed', 'blocked', 'incomplete'].includes(state.status);
  try {
    return await reportOperationalRun({
      externalKey: `codex-direct:${state.id}`,
      jobId: state.id,
      agentId: 'iva-codex-direct',
      agentName: state.title,
      taskTitle: state.title,
      routeReason: 'direct-codex-build',
      channel: 'codex-build',
      source: 'Codex Desktop',
      requestPreview: state.title,
      status: state.status,
      phase: state.phase,
      progress: state.progress,
      detail: state.detail,
      resultPreview: state.resultPreview || state.detail,
      error: state.error,
      startedAt: state.startedAt,
      completedAt: terminal ? state.completedAt || state.updatedAt : '',
      updatedAt: state.updatedAt,
    });
  } catch (error) {
    console.error(`Kontrollzentrum vorübergehend nicht erreichbar: ${clean(error.message, 300)}`);
    return { reported: false };
  }
}

async function main() {
  const [command, first, ...rest] = process.argv.slice(2);
  const detail = clean(rest.join(' '), 1000);
  if (command === 'start') {
    const title = clean(first, 220);
    if (!title) throw new Error('Ein sichtbarer Titel für den Bauauftrag fehlt.');
    const now = new Date().toISOString();
    const state = { id: crypto.randomUUID(), title, status: 'running', phase: 'planning', progress: 10, detail: detail || 'Planung wurde begonnen.', startedAt: now, updatedAt: now };
    await save(state);
    await publish(state);
    console.log(JSON.stringify(state));
    return;
  }
  if (command === 'status') {
    console.log(JSON.stringify(await load(), null, 2));
    return;
  }
  const state = await load();
  const now = new Date().toISOString();
  if (command === 'phase') {
    const phase = clean(first, 80);
    if (!Object.hasOwn(PHASE_PROGRESS, phase) || phase === 'completed') throw new Error('Unbekannte oder terminale Bauphase.');
    if (PHASE_PROGRESS[phase] < Number(state.progress || 0)) throw new Error('Der Baufortschritt kann nicht zurückgesetzt werden.');
    Object.assign(state, { status: 'running', phase, progress: PHASE_PROGRESS[phase], detail: detail || `${phase} wurde begonnen.`, error: '', updatedAt: now });
  } else if (command === 'complete') {
    Object.assign(state, { status: 'completed', phase: 'completed', progress: 100, detail: clean([first, ...rest].join(' '), 1000) || 'Live-Prüfung erfolgreich abgeschlossen.', resultPreview: clean([first, ...rest].join(' '), 1000), error: '', completedAt: now, updatedAt: now });
  } else if (command === 'fail' || command === 'blocked') {
    const reason = clean([first, ...rest].join(' '), 1000);
    if (!reason) throw new Error('Der konkrete Fehler oder Blocker fehlt.');
    Object.assign(state, { status: command === 'blocked' ? 'blocked' : 'failed', detail: reason, error: reason, completedAt: now, updatedAt: now });
  } else {
    throw new Error('Erlaubt: start, phase, complete, fail, blocked oder status.');
  }
  await save(state);
  await publish(state);
  console.log(JSON.stringify(state));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
