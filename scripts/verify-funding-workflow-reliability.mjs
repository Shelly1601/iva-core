import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { prioritizedPipedriveApiSourceDealIds } from '../local-mac-helper/chrome-pipedrive.mjs';

const taskRoot = await mkdtemp(path.join(os.tmpdir(), 'iva-funding-workflow-'));
process.env.IVA_CODEX_TASK_ROOT = taskRoot;

const {
  buildCodexPrompt,
  getCodexTaskStatus,
  recordProjectWorkflowOutcome,
  recordProjectWorkflowStep,
  prepareProjectWorkflowWindows,
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
  assert.deepEqual(prioritizedPipedriveApiSourceDealIds(['8503', '8153', '8503', '317']), ['8153', '8503', '317']);
  assert.deepEqual(prioritizedPipedriveApiSourceDealIds(['8503', '317', '42'], { limit: 2 }), ['8503', '317']);

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
  assert.match(prompt, /Bediene ausschließlich das physisch rechte Display/);
  assert.match(prompt, /Chrome und Outlook unmittelbar vor dem Start geöffnet, rechts platziert/);
  assert.match(prompt, /Ein mit partial abgeschlossenes Teilprotokoll beendet diesen Teilschritt ebenfalls/);
  assert.match(prompt, /ohne dieses Ergebnisprotokoll gilt ausdrücklich nicht als Erfolg/);

  const codexTaskSource = await readFile(new URL('../local-mac-helper/codex-tasks.mjs', import.meta.url), 'utf8');
  const pipedriveSource = await readFile(new URL('../local-mac-helper/chrome-pipedrive.mjs', import.meta.url), 'utf8');
  const macUiSource = await readFile(new URL('../local-mac-helper/macos-ui.mjs', import.meta.url), 'utf8');
  const macBridgeSource = await readFile(new URL('../local-mac-helper/macos/iva-ax.swift', import.meta.url), 'utf8');
  assert.match(codexTaskSource, /recoveryAttempts: Number\(previousState\.recoveryAttempts \|\| 0\)/,
    'ein laufender Task muss seinen begrenzten Wiederholungszähler behalten');
  assert.match(codexTaskSource, /runMode !== 'manual'/,
    'ein manueller Förderlauf darf nach einem früheren Tagesabschluss bewusst erneut gestartet werden');
  assert.match(codexTaskSource, /\['completed', 'no_changes'\]\.includes\(state\.workflowOutcome\)/,
    'nur ein fachlich verifizierter automatischer Förderabschluss darf den Tag deduplizieren');
  assert.match(pipedriveSource, /hasAuthenticatedApiSession/);
  assert.match(pipedriveSource, /openAuthenticatedPipedriveApiSource/);
  assert.match(macUiSource, /for \(let attempt = 1; attempt <= 3; attempt \+= 1\)/);
  assert.match(macBridgeSource, /sidebarNodesEnsuringFolder/);
  assert.match(macBridgeSource, /AXPress erfolgreich quittieren/);

  const preparedApps = [];
  const openedApps = [];
  assert.deepEqual(await prepareProjectWorkflowWindows(request, {
    openApp: async app => openedApps.push(app),
    ensureWindow: async bundle => preparedApps.push(bundle),
    waitFn: async () => {},
  }), ['com.google.Chrome', 'com.microsoft.Outlook']);
  assert.deepEqual(openedApps, ['Google Chrome', 'Microsoft Outlook']);
  assert.deepEqual(preparedApps, ['com.google.Chrome', 'com.microsoft.Outlook']);

  await assert.rejects(
    recordProjectWorkflowStep(started.jobId, 'amount', 'completed', 2, 0, 'zu früh', { report: async () => true }),
    /erst nach protokolliertem Teilschritt completeness/,
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

  const partialRun = await startCodexTask({
    prompt: 'Führe den Förderlauf trotz einzelner offener Fälle weiter aus.',
    title: 'Förderung – Teilfall-Fortsetzung',
    requestId: 'funding-partial-continuation-test',
    mode: 'project-workflow',
    projectId: 'heat-hero',
    workflowId: 'funding-daily-sequence',
  }, { materialize: async () => ({ iCloud: true, materialized: false, probes: [] }), spawnProcess: fakeSpawn, report: async () => true });
  await recordProjectWorkflowStep(partialRun.jobId, 'completeness', 'partial', 72, 0, 'Einzelne Downloads offen', { report: async () => true });
  await recordProjectWorkflowStep(partialRun.jobId, 'amount', 'completed', 17, 0, 'Alle belegten Förderhöhen geprüft', { report: async () => true });
  await recordProjectWorkflowStep(partialRun.jobId, 'approval', 'completed', 9, 0, 'Alle belegten Zusagen geprüft', { report: async () => true });
  const partialResult = await recordProjectWorkflowOutcome(partialRun.jobId, 'partial', 'Einzelfälle offen; alle drei Workflows wurden ausgeführt.', { report: async () => true });
  assert.equal(partialResult.steps.length, 3);
  assert.equal(resolveProjectWorkflowResultStatus(partialResult), 'incomplete');

  const blockedRun = await startCodexTask({
    prompt: 'Prüfe den Förderlauf mit einem echten technischen Blocker.',
    title: 'Förderung – Blocker-Reihenfolge',
    requestId: 'funding-blocked-order-test',
    mode: 'project-workflow',
    projectId: 'heat-hero',
    workflowId: 'funding-daily-sequence',
  }, { materialize: async () => ({ iCloud: true, materialized: false, probes: [] }), spawnProcess: fakeSpawn, report: async () => true });
  await recordProjectWorkflowStep(blockedRun.jobId, 'completeness', 'blocked', 0, 0, 'CAPTCHA', { report: async () => true });
  await assert.rejects(
    recordProjectWorkflowStep(blockedRun.jobId, 'amount', 'completed', 0, 0, 'darf nicht laufen', { report: async () => true }),
    /nach blockiertem Teilschritt completeness/,
  );
  console.log('Funding workflow reliability checks passed.');
} finally {
  await rm(taskRoot, { recursive: true, force: true });
}
