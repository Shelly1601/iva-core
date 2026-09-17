import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { taskResourcePriority, taskExecutionLane, taskResultDeadline, taskRecoveryAllowed, taskWatchdogRequest } from '../local-mac-helper/task-execution-policy.mjs';
const root = await mkdtemp(path.join(os.tmpdir(), 'iva-task-policy-'));
process.env.IVA_CODEX_TASK_ROOT = root;
process.env.DATA_DIR = path.join(root, 'data');
after(() => rm(root, { recursive: true, force: true }));
const tasks = await import('../local-mac-helper/codex-tasks.mjs');
const { deviceCommandTaskMetadata } = await import('../local-mac-helper/device-agent.mjs');
const { requestBuildUiAccess } = await import('../local-mac-helper/execution-priority.mjs');

test('device metadata prioritizes automatic evidence above a stale interactive lane', () => {
  for (const payload of [{ runMode: 'automatic' }, { automationSlotKey: 'daily:1' }, { trigger: 'catch-up' }]) {
    const metadata = deviceCommandTaskMetadata({ action: 'project.workflow.run', lane: 'interactive', payload });
    assert.equal(metadata.lane, 'batch'); assert.equal(taskResourcePriority(metadata), 0);
  }
  assert.equal(taskResourcePriority({ planbar: {}, runMode: 'automatic' }), 100);
  assert.equal(taskExecutionLane({ workflowId: 'funding-initial-backfill', runMode: 'manual' }), 'history');
  assert.equal(taskResourcePriority({ mode: 'build' }), 50);
});

test('workflow creation preserves automatic metadata for non-Forecast workflows', async () => {
  let supplied;
  await tasks.startProjectWorkflowTask({ workflowId: 'kfw-funding-amount-morning', requestId: 'automatic-fixture', runMode: 'automatic', automationSlotKey: 'daily:fixture', lane: 'batch', startTask: async input => { supplied = input; return input; } });
  assert.equal(supplied.runMode, 'automatic'); assert.equal(supplied.automationSlotKey, 'daily:fixture');
  const spawnProcess = () => { const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; };
  const created = await tasks.startCodexTask(supplied, { report: async () => {}, spawnProcess });
  const saved = JSON.parse(await readFile(path.join(root, created.jobId, 'request.json')));
  assert.equal(saved.lane, 'batch'); assert.equal(saved.runMode, 'automatic'); assert.equal(saved.automationSlotKey, 'daily:fixture');
});

test('actual scoped resource admissions receive urgent100 interactive50 and batch/history0', async () => {
  for (const [lane, priority] of [['customer-scheduling', 100], ['interactive', 50], ['batch', 0], ['history', 0]]) {
    const jobId = tasks.codexJobIdForRequest(`lane-${lane}`), directory = path.join(root, jobId);
    await mkdir(directory); const createdAt = new Date().toISOString();
    await writeFile(path.join(directory, 'request.json'), JSON.stringify({ jobId, mode: 'build', resourceProtocol: 2, lane, createdAt }));
    await writeFile(path.join(directory, 'state.json'), JSON.stringify({ jobId, status: 'queued', createdAt }));
    let seen;
    await tasks.runCodexTask(jobId, { report: async () => {}, sessionStatus: async () => ({ usable: true }), withWakeGuard: async execute => execute(),
      withUiLock: async (execute, options) => { seen = options.priority; return execute(); },
      execute: async () => { await requestBuildUiAccess(directory, 'acquire'); await requestBuildUiAccess(directory, 'release'); },
    });
    assert.equal(seen, priority);
  }
});

test('recovery remains bounded by original origin and watchdog never represents completion or kill', () => {
  const origin = Date.parse('2026-09-17T10:00:00Z'), request = { jobId: 'fixture', createdAt: new Date(origin).toISOString() };
  assert.equal(taskRecoveryAllowed(request, { recoveryAttempts: 2 }, origin + 1000), true);
  assert.equal(taskRecoveryAllowed(request, { recoveryAttempts: 3 }, origin + 1000), false);
  assert.equal(taskRecoveryAllowed(request, { recoveryAttempts: 0, attemptStartedAt: new Date(origin + 1800000).toISOString() }, origin + 1800001), false);
  assert.equal(taskResultDeadline(request, { createdAt: new Date(origin + 1000).toISOString() }), origin + 1800000);
  const watchdog = taskWatchdogRequest(request, {}, origin + 1800001);
  assert.equal(watchdog.action, 'yield-at-safe-checkpoint'); assert.equal(watchdog.completed, false); assert.equal(watchdog.preserveAmbiguousWrites, true);
  assert.equal(tasks.shouldResumeCodexTaskAfterTermination({ request, state: { recoveryAttempts: 3 }, exitCode: 1 }), false);
});

test('protocol 2 rechecks the session at actual UI acquire after independent analysis', async () => {
  const jobId = tasks.codexJobIdForRequest('session-race-v2'), directory = path.join(root, jobId);
  await mkdir(directory); const createdAt = new Date().toISOString(); let usable = true, analysed = false;
  await writeFile(path.join(directory, 'request.json'), JSON.stringify({ jobId, mode: 'build', resourceProtocol: 2, createdAt }));
  await writeFile(path.join(directory, 'state.json'), JSON.stringify({ jobId, status: 'queued', createdAt }));
  await tasks.runCodexTask(jobId, { report: async () => {}, sessionStatus: async () => ({ usable }), withWakeGuard: async execute => execute(),
    withUiLock: async execute => { usable = false; return execute(); },
    execute: async () => { analysed = true; await assert.rejects(requestBuildUiAccess(directory, 'acquire'), /Freigabe/); },
  });
  assert.equal(analysed, true);
});

test('watchdog persists violation and requests cooperative yield without completing or dropping worker identity', async () => {
  const jobId = tasks.codexJobIdForRequest('watchdog-fixture'), directory = path.join(root, jobId);
  const origin = Date.now() - 1800001, createdAt = new Date(origin).toISOString();
  await mkdir(directory);
  await writeFile(path.join(directory, 'request.json'), JSON.stringify({ jobId, createdAt }));
  await writeFile(path.join(directory, 'state.json'), JSON.stringify({ jobId, status: 'running', createdAt, workerPid: process.pid, childPid: process.pid }));
  const value = await tasks.requestCodexTaskWatchdog(jobId, { report: async () => {} });
  assert.equal(value.status, 'running'); assert.equal(value.phase, 'sla_violation'); assert.equal(value.sla.violated, true);
  assert.equal(value.workerPid, process.pid); assert.equal(value.childPid, process.pid); assert.equal(value.completedAt, undefined);
  const request = JSON.parse(await readFile(path.join(directory, 'operational-watchdog.json')));
  assert.equal(request.action, 'yield-at-safe-checkpoint'); assert.equal(request.preserveAmbiguousWrites, true);
});
