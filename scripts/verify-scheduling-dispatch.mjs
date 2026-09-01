import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const root = await mkdtemp(path.join(os.tmpdir(), 'iva-scheduling-dispatch-'));
process.env.DATA_DIR = root;
process.env.IVA_CODEX_TASK_ROOT = path.join(root, 'tasks');
process.env.IVA_MAC_WAKE_ROOT = path.join(root, 'wake');
process.env.IVA_DEVICE_WORKSPACE = '/Users/nadine/Library/Mobile Documents/com~apple~CloudDocs/IVA-Assistent/iva-core';
const projects = await import('../projects/store.js');
const devices = await import('../device-control/store.js');
const tasks = await import('../local-mac-helper/codex-tasks.mjs');
const { schedulingRequestStatus } = await import('../operations/scheduling-dispatch.js');
const { withMacWakeGuard } = await import('../local-mac-helper/mac-wake-guard.mjs');
const input = { customerName: 'Fixture Workflow', partnerId: 'heat-hero', partnerName: 'Heat Hero', partnerPrefix: 'HH', isoYear: 2026, week: 42, materialDeliverySpace: true, theftWeatherProtected: false };
const metadata = { hostname: 'iMac-von-Nadine.local', protocolVersion: 2, release: 'fixture', workspace: process.env.IVA_DEVICE_WORKSPACE, iCloudAuthoritative: true, allowedActions: ['planbar.customer.schedule', 'app.open'] };
await devices.recordDeviceAgentHeartbeat({ deviceId: 'imac-nadine', ...metadata });

// Formulareingabe startet unmittelbar und speichert die tatsächliche Verknüpfung.
const created = await projects.addCustomerSchedulingRequest('heat-hero', input);
assert.equal(created.schedulingDispatch.status, 'queued');
const saved = (await projects.getProject('heat-hero')).customerSchedulingRequests[0];
assert.equal(saved.commandId, created.schedulingDispatch.commandId);
assert.equal(saved.dispatchPending, false);
assert.equal(saved.status, 'queued');
assert.match(saved.schedulingSummary, /Automatisch/);
let claim = await devices.claimNextDeviceCommand('imac-nadine', metadata);
assert.equal(claim.id, saved.commandId);
const finish = (command, extra) => devices.completeDeviceCommand({ deviceId: 'imac-nadine', commandId: command.id, leaseToken: command.leaseToken, agentMetadata: metadata, ...extra });
let retry = await finish(claim, { ok: false, error: 'Fixture spawn EAGAIN', failureStage: 'before_launch' });
assert.equal(retry.status, 'queued');
assert.equal((await projects.getProject('heat-hero')).customerSchedulingRequests[0].status, 'retrying');
assert.equal(await devices.claimNextDeviceCommand('imac-nadine', metadata), null, 'Backoff nicht überspringen');
const expireBackoff = async () => {
  const file = path.join(root, 'device-commands.json');
  const data = JSON.parse(await readFile(file, 'utf8'));
  for (const command of data.commands) if (command.retryAt) command.retryAt = new Date(0).toISOString();
  await writeFile(file, JSON.stringify(data));
};
for (let attempt = 2; attempt <= 3; attempt++) {
  await expireBackoff();
  claim = await devices.claimNextDeviceCommand('imac-nadine', metadata);
  assert.equal(claim.attempts, attempt);
  retry = await finish(claim, { ok: false, error: 'Fixture Startfehler', failureStage: 'before_launch' });
}
assert.equal(retry.status, 'failed', 'Vorstart-Wiederholungen sind begrenzt');
assert.match((await projects.getProject('heat-hero')).customerSchedulingRequests[0].schedulingSummary, /Start fehlgeschlagen/);
const staleQueuedRun = { schedulingKey: (await import('../operations/customer-scheduling.js')).planbarSchedulingKey(saved), status: 'queued' };
assert.equal(schedulingRequestStatus(saved, [staleQueuedRun], [retry]).status, 'failed', 'Ein alter Queue-Lauf darf den endgültigen Startfehler nicht verdecken');
const unsafe = await devices.enqueueDeviceCommand({ action: 'planbar.customer.schedule', payload: { ...input, customerName: 'Fixture Unsicher' } });
claim = await devices.claimNextDeviceCommand('imac-nadine', metadata);
assert.equal(claim.id, unsafe.id);
assert.equal((await finish(claim, { ok: false, error: 'Speichern unklar' })).status, 'failed', 'Keine Wiederholung unklarer Schreibaktionen');
const other = await devices.enqueueDeviceCommand({ action: 'app.open', payload: { app: 'WhatsApp' } });
claim = await devices.claimNextDeviceCommand('imac-nadine', metadata);
assert.equal(claim.id, other.id);
assert.equal((await finish(claim, { ok: false, error: 'Fixture', failureStage: 'before_launch' })).status, 'failed', 'Keine Ausweitung der Wiederholungsfreigabe');

// Fehler zwischen Queue-Schreiben und Projektbestätigung: dieselbe Zustellung.
const pending = await projects.addCustomerSchedulingRequest('heat-hero', { ...input, customerName: 'Fixture Outbox' }, { enqueue: async args => {
  await devices.enqueueDeviceCommand(args);
  throw new Error('Fixture Verbindungsabbruch nach erfolgreicher Speicherung');
} });
assert.equal(pending.schedulingDispatch.status, 'retrying');
const count = (await devices.listDeviceCommands()).length;
claim = await devices.claimNextDeviceCommand('imac-nadine', metadata);
await finish(claim, { ok: true, result: { jobId: 'fixture-existing-job' } });
await projects.dispatchPendingCustomerSchedulingRequests();
assert.equal((await devices.listDeviceCommands()).length, count, 'Auch abgeschlossene Zustellung wird nicht doppelt angelegt');
const recovered = (await projects.getProject('heat-hero')).customerSchedulingRequests[0];
assert.equal(recovered.commandId, claim.id);
assert.equal(recovered.dispatchPending, false);
assert.equal(recovered.status, 'starting', 'Queue-Abschluss ist kein gebuchter Slot');

// Gesicherter Slot gewinnt auch bei einem Folge-/Displayfehler.
const { planbarSchedulingKey, isoWeekRange, mergePlanbarSchedulingProgress } = await import('../operations/customer-scheduling.js');
const progress = mergePlanbarSchedulingProgress(null, { status: 'reserved', reservation: { customerId: 'fixture', appointmentId: 'fixture', resourceId: 'fixture', resourceName: 'Fixture Team', isoYear: 2026, week: 42, ...isoWeekRange(2026, 42), verified: true, identityVerified: true, verifiedAt: new Date().toISOString() } });
const status = schedulingRequestStatus(saved, [{ schedulingKey: planbarSchedulingKey(saved), status: 'failed', planbarProgress: progress }], [retry]);
assert.equal(status.status, 'reserved');
assert.match(status.schedulingSummary, /Slot in Planbar gesichert/);
assert.equal(schedulingRequestStatus(saved, [], []).status, 'not_started');
const operations = await import('../operations/store.js');
await operations.upsertExternalAgentRun({ externalKey: 'fixture-out-of-order', schedulingKey: planbarSchedulingKey(input), status: 'failed', updatedAt: '2026-08-27T15:00:00.000Z' });
const lateProof = await operations.upsertExternalAgentRun({ externalKey: 'fixture-out-of-order', status: 'running', planbarProgress: progress, updatedAt: '2026-08-27T14:59:00.000Z' });
assert.equal(lateProof.status, 'failed');
assert.equal(lateProof.planbarProgress.reservation.verified, true, 'Verspäteter Erstbeleg bleibt erhalten');
assert.equal((await operations.upsertExternalAgentRun({ externalKey: 'fixture-out-of-order', status: 'queued', updatedAt: '2026-08-27T14:58:00.000Z' })).status, 'failed');
await operations.upsertExternalAgentRun({ externalKey: 'fixture-general-terminal', status: 'completed', updatedAt: '2026-08-27T16:00:00.000Z', resultPreview: 'Fertig' });
const lateGeneralHeartbeat = await operations.upsertExternalAgentRun({ externalKey: 'fixture-general-terminal', status: 'running', updatedAt: '2026-08-27T16:00:01.000Z', resultPreview: 'Noch aktiv' });
assert.equal(lateGeneralHeartbeat.status, 'completed', 'ein spätes Lebenszeichen darf keinen allgemeinen Workflow-Abschluss zurücksetzen');
assert.equal(lateGeneralHeartbeat.resultPreview, 'Fertig');

// Echte iCloud-Dateien, Codex-CLI und Fachsysteme werden nicht angefasst.
let spawned = 0;
const fakeSpawn = fail => () => {
  spawned++;
  const child = new EventEmitter();
  child.unref = () => {};
  child.exitCode = null;
  child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('close', 0)); };
  queueMicrotask(() => child.emit(fail ? 'error' : 'spawn', fail ? new Error('Fixture EAGAIN') : undefined));
  return child;
};
const dependencies = { materialize: async () => { throw new Error('Operativer Start darf keine iCloud-Codeprobe verlangen'); }, spawnProcess: fakeSpawn(false), report: async () => true };
const taskInput = { prompt: 'Fixture ausschließlich Test', title: 'Fixture', requestId: 'fixture-stable-launch', mode: 'project-workflow', planbar: input };
for (const mode of ['operational', 'project-workflow', 'build']) {
  const args = tasks.buildCodexCliArguments({ ...taskInput, jobId: '00000000-0000-4000-8000-000000000001', mode, acceptanceCriteria: [] });
  assert.equal(args[0], 'exec');
  assert.ok(args.includes('--approve-for-me'));
  assert.equal(args.includes('code_mode_host'), mode !== 'build');
  if (mode !== 'build') assert.equal(args[args.indexOf('--enable') + 1], 'code_mode_host');
  assert.equal(args.filter(arg => arg === '--add-dir').length, 2);
  assert.equal(args[args.indexOf('-C') + 1], process.env.IVA_DEVICE_WORKSPACE);
  assert.ok(!args.some(arg => /--disable|--dangerously-|--ignore-rules|--ignore-user-config|--yolo|danger-full-access/.test(arg)));
}
await assert.rejects(tasks.startCodexTask(taskInput, { ...dependencies, spawnProcess: fakeSpawn(true) }), error => error.code === 'IVA_TASK_NOT_LAUNCHED');
const launched = await tasks.startCodexTask(taskInput, dependencies);
assert.equal(launched.jobId, tasks.codexJobIdForRequest(taskInput.requestId));
assert.equal(spawned, 2);
const results = await Promise.all(Array.from({ length: 8 }, () => tasks.claimCodexTaskExecution(launched.jobId, { report: async () => true })));
assert.equal(results.filter(Boolean).length, 1, 'Atomare Ausführungsfreigabe verhindert parallele Doppelstarts');
await tasks.startCodexTask(taskInput, dependencies);
assert.equal(spawned, 2, 'Laufender Auftrag wird nicht neu gestartet');
const reports = [];
await tasks.syncSchedulingTaskStates({ processAlive: () => false, report: async (...args) => { reports.push(args); return true; } });
assert.equal(reports[0][1].status, 'failed');
assert.match(reports[0][1].error, /Keine automatische Wiederholung/);

// Wiederanlauf nach abgestürztem Starter, ohne jemals eine UI-Freigabe erhalten zu haben.
const restartInput = { ...taskInput, requestId: 'fixture-recover-launch' };
const restart = await tasks.startCodexTask(restartInput, dependencies);
const restartPath = path.join(process.env.IVA_CODEX_TASK_ROOT, restart.jobId, 'state.json');
const restartState = JSON.parse(await readFile(restartPath, 'utf8'));
await writeFile(restartPath, JSON.stringify({ ...restartState, lastLaunchAt: new Date(0).toISOString() }));
let recoveries = 0;
await tasks.syncSchedulingTaskStates({ now: Date.now() + 70_000, report: async () => true, launch: async request => {
  recoveries++;
  assert.equal(request.jobId, restart.jobId);
  return tasks.startCodexTask(request, dependencies);
} });
assert.equal(recoveries, 1);
assert.equal(JSON.parse(await readFile(restartPath, 'utf8')).launchAttempts, 2);
await writeFile(restartPath, JSON.stringify({ ...restartState, launchAttempts: 3, lastLaunchAt: new Date(0).toISOString() }));
await tasks.syncSchedulingTaskStates({ now: Date.now() + 140_000, report: async () => true, launch: async () => { throw new Error('Kein vierter Start'); } });
assert.equal(JSON.parse(await readFile(restartPath, 'utf8')).status, 'failed');

// Alle iMac-Codex-Workflows melden Lebenszeichen und werden nach einem sicher
// erkannten toten Worker mit demselben Auftrag kontrolliert fortgesetzt.
const operationalInput = { prompt: 'Fixture operativer Durchlauf ohne Fachsystem', title: 'Fixture Workflow-Aufsicht', requestId: 'fixture-operational-recovery', mode: 'operational' };
const operational = await tasks.startCodexTask(operationalInput, dependencies);
assert.equal(await tasks.claimCodexTaskExecution(operational.jobId, { report: async () => true }), true);
const heartbeatAt = Date.now() + 180_000;
const heartbeat = await tasks.recordCodexTaskHeartbeat(operational.jobId, { now: heartbeatAt, workerPid: 4321, childPid: 4322, report: async () => true });
assert.equal(heartbeat.workerPid, 4321);
assert.equal(heartbeat.childPid, 4322);
assert.match(heartbeat.detail, /Workflow aktiv/);
const heartbeatStatus = await tasks.getCodexTaskStatus(operational.jobId);
assert.equal(heartbeatStatus.heartbeatAt, new Date(heartbeatAt).toISOString());
assert.equal(heartbeatStatus.childPid, 4322);
let orphanRelaunch = false;
await tasks.syncCodexTaskStates({ force: true, now: heartbeatAt + 60_000, processAlive: pid => pid === 4322, report: async () => true, launch: async () => { orphanRelaunch = true; } });
assert.equal(orphanRelaunch, false, 'ein noch laufender Codex-Unterprozess darf keinen Doppelstart auslösen');
assert.equal((await tasks.getCodexTaskStatus(operational.jobId)).phase, 'orphan_child_running');
let operationalRecoveries = 0;
const recoverySummary = await tasks.syncCodexTaskStates({ force: true, now: heartbeatAt + 120_000, processAlive: () => false, report: async () => true, launch: async request => {
  operationalRecoveries++;
  return tasks.startCodexTask(request, dependencies);
} });
assert.equal(operationalRecoveries, 1);
assert.equal(recoverySummary.recovered, 1);
const operationalPath = path.join(process.env.IVA_CODEX_TASK_ROOT, operational.jobId);
let operationalState = JSON.parse(await readFile(path.join(operationalPath, 'state.json'), 'utf8'));
assert.equal(operationalState.status, 'queued');
assert.equal(operationalState.recoveryAttempts, 1);
assert.equal((await readdir(operationalPath)).some(name => name.startsWith('execution-claim-interrupted-')), true);
assert.match(tasks.buildCodexPrompt({ ...operationalInput, jobId: operational.jobId, acceptanceCriteria: [], recoveryAttempt: 1 }), /automatische Wiederanlauf 1/);
assert.equal(await tasks.claimCodexTaskExecution(operational.jobId, { report: async () => true }), true);
operationalState = JSON.parse(await readFile(path.join(operationalPath, 'state.json'), 'utf8'));
await writeFile(path.join(operationalPath, 'state.json'), JSON.stringify({ ...operationalState, recoveryAttempts: tasks.CODEX_TASK_MAX_RECOVERY_ATTEMPTS }));
await tasks.syncCodexTaskStates({ force: true, now: heartbeatAt + 240_000, processAlive: () => false, report: async () => true, launch: async () => { throw new Error('Keine weitere Fortsetzung'); } });
operationalState = JSON.parse(await readFile(path.join(operationalPath, 'state.json'), 'utf8'));
assert.equal(operationalState.status, 'failed');
assert.match(operationalState.error, /automatischen Fortsetzungen/);

// Stirbt nur der äußere Worker nach bereits geschriebenem Endergebnis, wird
// der belegte Erfolg übernommen statt den Geschäftsablauf erneut auszuführen.
const salvageInput = { ...operationalInput, requestId: 'fixture-operational-salvage', title: 'Fixture Ergebnisrettung' };
const salvage = await tasks.startCodexTask(salvageInput, dependencies);
assert.equal(await tasks.claimCodexTaskExecution(salvage.jobId, { report: async () => true }), true);
const salvagePath = path.join(process.env.IVA_CODEX_TASK_ROOT, salvage.jobId);
await writeFile(path.join(salvagePath, 'result.txt'), 'Ergebnis sichtbar geprüft.\n\nStatus: erfolgreich\n');
let unsafeSalvageRelaunch = false;
await tasks.syncCodexTaskStates({ force: true, now: heartbeatAt + 360_000, processAlive: () => false, report: async () => true, launch: async () => { unsafeSalvageRelaunch = true; } });
const salvagedState = JSON.parse(await readFile(path.join(salvagePath, 'state.json'), 'utf8'));
assert.equal(salvagedState.status, 'completed');
assert.equal(salvagedState.progress, 100);
assert.equal(unsafeSalvageRelaunch, false);

const warnings = [];
const wakeOptions = {
  spawnProcess: fakeSpawn(false),
  exec: async command => {
    if (command === '/usr/sbin/ioreg') return { stdout: '"HIDIdleTime" = 7200000000000' };
    throw new Error('Fixture pmset Fehler');
  },
  displaySleepOptions: { now: new Date(2026, 7, 30, 23, 30), platform: 'darwin' },
  onCleanupWarning: warning => warnings.push(warning),
};
const inheritedWakeGuard = process.env.IVA_MAC_WAKE_GUARD_ACTIVE;
delete process.env.IVA_MAC_WAKE_GUARD_ACTIVE;
assert.deepEqual(await withMacWakeGuard(async () => ({ jobId: 'kept' }), wakeOptions), { jobId: 'kept' });
const primaryError = new Error('Ursprünglicher Workflowfehler');
await assert.rejects(withMacWakeGuard(async () => { throw primaryError; }, wakeOptions), error => error === primaryError);
if (inheritedWakeGuard === undefined) delete process.env.IVA_MAC_WAKE_GUARD_ACTIVE;
else process.env.IVA_MAC_WAKE_GUARD_ACTIVE = inheritedWakeGuard;
assert.equal(warnings.length, 2);

// /current ist ein Symlink. Der CLI-Einstieg muss ausgeführt werden, nicht Exit 0 ohne Wirkung.
const linked = path.join(root, 'linked-tasks.mjs');
await symlink(fileURLToPath(new URL('../local-mac-helper/codex-tasks.mjs', import.meta.url)), linked);
assert.equal(tasks.isCodexTasksEntrypoint(linked), true);
await assert.rejects(promisify(execFile)(process.execPath, [linked, 'planbar-progress', '00000000-0000-4000-8000-000000000000', '/invalid/receipt.json'], { env: process.env }), error => error.code === 1 && /Eingangsbeleg/.test(error.stderr));
console.log('PASS Terminierungsstart: sofortige Übergabe, durable Outbox, sichere begrenzte Wiederholung, allgemeine Workflow-Lebenszeichen, kontrollierte Worker-Fortsetzung, Status, atomare Worker-Deduplizierung, Abbruchmeldung, Wake-Cleanup und current-Symlink. Keine Fachsystem-Schreibaktionen.');
