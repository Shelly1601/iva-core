import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';

const taskRoot = await mkdtemp(path.join(os.tmpdir(), 'iva-funding-workflow-'));
process.env.IVA_CODEX_TASK_ROOT = taskRoot;

const {
  buildCodexPrompt,
  getCodexTaskStatus,
  recordProjectWorkflowOutcome,
  recordProjectWorkflowStep,
  resolveProjectWorkflowResultStatus,
  startCodexTask,
} = await import('../local-mac-helper/codex-tasks.mjs');

function fakeSpawn() {
  const child = new EventEmitter();
  child.unref = () => {};
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

try {
  const started = await startCodexTask({
    prompt: 'Führe den geordneten Förder-Tageslauf vollständig und geprüft aus.',
    title: 'Förderung – strukturierter Testlauf',
    requestId: 'funding-reliability-test',
    mode: 'project-workflow',
    projectId: 'heat-hero',
    workflowId: 'funding-daily-sequence',
  }, { materialize: async () => ({ iCloud: true, materialized: false, probes: [] }), spawnProcess: fakeSpawn, report: async () => true });

  const request = JSON.parse(await readFile(path.join(taskRoot, started.jobId, 'request.json'), 'utf8'));
  assert.equal(request.resultProtocol, 1);
  const prompt = buildCodexPrompt(request);
  assert.match(prompt, /workflow-status/);
  assert.match(prompt, /workflow-step .* completeness/);
  assert.match(prompt, /workflow-step .* amount/);
  assert.match(prompt, /workflow-step .* approval/);
  assert.match(prompt, /workflow-result/);
  assert.match(prompt, /ohne dieses Ergebnisprotokoll gilt ausdrücklich nicht als Erfolg/);

  await assert.rejects(
    recordProjectWorkflowStep(started.jobId, 'amount', 'completed', 2, 0, 'zu früh', { report: async () => true }),
    /erst nach abgeschlossenem Teilschritt completeness/,
  );
  await recordProjectWorkflowStep(started.jobId, 'completeness', 'completed', 73, 0, '73 Deals geprüft', { report: async () => true });
  await assert.rejects(
    recordProjectWorkflowOutcome(started.jobId, 'completed', 'zu früh', { report: async () => true }),
    /Pflicht-Teilschritte/,
  );
  await recordProjectWorkflowStep(started.jobId, 'amount', 'completed', 12, 0, '12 Förderhöhen geprüft', { report: async () => true });
  await recordProjectWorkflowStep(started.jobId, 'approval', 'completed', 8, 0, '8 Zusagen geprüft', { report: async () => true });
  const result = await recordProjectWorkflowOutcome(started.jobId, 'no_changes', 'Alle drei Schritte geprüft; kein Änderungsbedarf.', { report: async () => true });
  assert.equal(result.outcome, 'no_changes');
  assert.equal(result.checked, 93);
  assert.equal(result.changed, 0);
  assert.equal(resolveProjectWorkflowResultStatus(result), 'completed');
  assert.equal(resolveProjectWorkflowResultStatus(null), 'incomplete');
  assert.equal(resolveProjectWorkflowResultStatus({ outcome: 'partial' }), 'incomplete');
  assert.equal(resolveProjectWorkflowResultStatus({ outcome: 'blocked' }), 'blocked');

  const status = await getCodexTaskStatus(started.jobId);
  assert.equal(status.workflowOutcome, 'no_changes');
  assert.equal(status.workflowSteps.length, 3);
  assert.deepEqual(status.workflowMetrics, { checked: 93, changed: 0 });
  console.log('Funding workflow reliability checks passed.');
} finally {
  await rm(taskRoot, { recursive: true, force: true });
}
