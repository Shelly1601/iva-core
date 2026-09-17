import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = await mkdtemp(path.join(os.tmpdir(), 'iva-quota-blocker-'));
process.env.IVA_CODEX_TASK_ROOT = path.join(root, 'tasks');
process.env.IVA_MAC_HELPER_DATA_DIR = path.join(root, 'helper');
process.env.IVA_DEVICE_WORKSPACE = path.join(root, 'workspace');
const tasks = await import('../local-mac-helper/codex-tasks.mjs');
after(() => rm(root, { recursive: true, force: true }));
const quota = "ERROR: You've hit your usage limit. Try again later.";
const report = async () => true;
let sequence = 0;
async function fixture(state = {}, request = {}) {
  const jobId = tasks.codexJobIdForRequest(`quota-fixture-${++sequence}`), directory = path.join(process.env.IVA_CODEX_TASK_ROOT, jobId);
  await mkdir(directory, { recursive: true });
  const at = new Date().toISOString();
  const req = { jobId, requestId: `quota-fixture-${sequence}`, createdAt: at, mode: 'project-workflow', workflowId: 'fixture', launchProtocol: 2, ...request };
  await writeFile(path.join(directory, 'request.json'), JSON.stringify(req));
  await writeFile(path.join(directory, 'state.json'), JSON.stringify({ jobId, status: 'running', workerPid: 23456, childPid: 23457, attemptStartedAt: at,
    createdAt: at, updatedAt: at, progress: 45, recoveryAttempts: 107, preservedReceipt: 'fixture-proof', ...state }));
  return { jobId, directory, at, request: req, state: async () => JSON.parse(await readFile(path.join(directory, 'state.json'))) };
}

test('only current stderr diagnoses quota, including split chunks and later long output', () => {
  const capture = tasks.createCodexTaskStderrEvidence();
  capture.observe('Tool quoted text: ' + quota + '\n');
  assert.equal(capture.result(), null);
  capture.observe("ERROR: You've hit your us"); capture.observe('age limit. Try again later.\n');
  capture.observe('x'.repeat(20000));
  assert.deepEqual(capture.result(), { code: 'CODEX_USAGE_LIMIT', source: 'current_process_stderr' });
  assert.equal(tasks.createCodexTaskStderrEvidence().result(), null, 'a new attempt cannot inherit historical stderr');
  for (const line of ['ERROR: insufficient_quota', 'ERROR: usage_limit_reached', 'ERROR: quota limit exceeded']) {
    const other = tasks.createCodexTaskStderrEvidence(); other.observe(line); assert.equal(other.result()?.code, 'CODEX_USAGE_LIMIT');
  }
});

test('quota stops every workflow before Planbar special-case, while technical failures still resume', () => {
  for (const workflowId of ['funding-initial-backfill', 'planbar-completion-morning', 'fixture']) {
    const request = { workflowId, jobId: 'fixture' };
    assert.equal(tasks.shouldResumeCodexTaskAfterTermination({ request, exitCode: 1, stderrEvidence: { code: 'CODEX_USAGE_LIMIT', source: 'current_process_stderr' } }), false);
    assert.equal(tasks.shouldResumeCodexTaskAfterTermination({ request, exitCode: 1, state: { status: 'blocked', phase: 'usage_limit' } }), false);
    assert.equal(tasks.shouldResumeCodexTaskAfterTermination({ request, exitCode: 1, resultText: 'Network connection interrupted' }), true);
  }
});

test('durable current-attempt stderr evidence blocks orphan recovery without losing receipts', async () => {
  const f = await fixture({}, { workflowId: 'planbar-completion-morning', resultProtocol: 2 });
  await writeFile(path.join(f.directory, 'stderr-evidence.json'), JSON.stringify({ code: 'CODEX_USAGE_LIMIT', source: 'current_process_stderr', exitCode: 1, attemptStartedAt: f.at }));
  await writeFile(path.join(f.directory, 'codex.log'), quota);
  let launches = 0;
  await tasks.syncCodexTaskStates({ force: true, processAlive: () => false, report, launch: async () => { launches++; } });
  const state = await f.state();
  assert.equal(state.status, 'blocked'); assert.equal(state.phase, 'usage_limit'); assert.equal(state.nextAttemptAt, null);
  assert.equal(state.recoveryAttempts, 107); assert.equal(state.preservedReceipt, 'fixture-proof'); assert.equal(launches, 0);
  assert.equal(await readFile(path.join(f.directory, 'codex.log'), 'utf8'), quota);
  await tasks.syncCodexTaskStates({ force: true, processAlive: () => false, report, launch: async () => { launches++; } });
  assert.equal(launches, 0);
});

test('historical log and stale stderr evidence cannot block a fresh attempt', async () => {
  const f = await fixture();
  await writeFile(path.join(f.directory, 'codex.log'), quota);
  await writeFile(path.join(f.directory, 'stderr-evidence.json'), JSON.stringify({ code: 'CODEX_USAGE_LIMIT', source: 'current_process_stderr', attemptStartedAt: '2000-01-01T00:00:00Z' }));
  let launches = 0;
  await tasks.syncCodexTaskStates({ force: true, processAlive: () => false, report, launch: async () => { launches++; } });
  assert.equal((await f.state()).status, 'queued'); assert.equal(launches, 1);
  await rm(f.directory, { recursive: true });
});

test('quota text printed by a successful child or without confirmed exit cannot block completion or orphan recovery', async () => {
  const capture = tasks.createCodexTaskStderrEvidence(); capture.observe(quota);
  assert.equal(tasks.confirmCodexTaskUsageLimit(capture.result(), 0), null);
  assert.equal(tasks.confirmCodexTaskUsageLimit(capture.result(), null), null);
  assert.equal(tasks.confirmCodexTaskUsageLimit(capture.result(), 1)?.exitCode, 1);
  const f = await fixture();
  await writeFile(path.join(f.directory, 'stderr-evidence.json'), JSON.stringify({ ...capture.result(), attemptStartedAt: f.at }));
  let launches = 0;
  await tasks.syncCodexTaskStates({ force: true, processAlive: () => false, report, launch: async () => { launches++; } });
  assert.equal((await f.state()).status, 'queued'); assert.equal(launches, 1);
  await rm(f.directory, { recursive: true });
});

test('exit and delayed progress cannot replace stopped, completed, deferred or quota-blocked state', async () => {
  for (const patch of [{ status: 'stopped' }, { status: 'completed' }, { status: 'blocked', phase: 'user_deferred' },
    { status: 'blocked', phase: 'usage_limit' }, { status: 'failed', completedAt: new Date().toISOString() }]) {
    const f = await fixture(patch), before = await f.state();
    assert.deepEqual(await tasks.writeCodexTaskTerminationState(f.jobId, { status: 'failed', detail: 'late error' }), before);
    assert.deepEqual(await tasks.updateCodexTaskProgress(f.jobId, 'testing', 'late progress'), before);
    assert.equal(tasks.shouldResumeCodexTaskAfterTermination({ request: f.request, state: before, exitCode: 1 }), false);
  }
});

test('new prompts preserve the explicit tab reuse and cleanup rule', () => {
  const prompt = tasks.buildCodexPrompt({ jobId: 'a'.repeat(24), prompt: 'Fixture only', mode: 'operational' });
  assert.match(prompt, /vorhandene passende Fenster und Tabs wieder/);
  assert.match(prompt, /ersetzt ihn im selben Fenster/);
  assert.match(prompt, /Fremde Tabs und aktive Nutzerarbeit bleiben erhalten/);
});
