import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { acquirePriorityLease, serveBuildUiAccess, requestBuildUiAccess, serveUiCheckpoints, requestUiCheckpoint } from '../local-mac-helper/execution-priority.mjs';
import { mergeSchedulingMilestones, schedulingMilestoneStatus } from '../operations/customer-scheduling.js';
const root = await mkdtemp(path.join(os.tmpdir(), 'iva-fast-lane-'));
after(() => rm(root, { recursive: true, force: true }));
process.env.IVA_CODEX_TASK_ROOT = path.join(root, 'tasks');
process.env.DATA_DIR = path.join(root, 'data');
const tasks = await import('../local-mac-helper/codex-tasks.mjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('priority waits for verified safe point and runs ahead of normal queued UI', async () => {
  const lock = path.join(root, 'desktop'), events = [];
  const low = await acquirePriorityLease({ root: lock });
  const normal = acquirePriorityLease({ root: lock, priority: 0 }).then(async lease => { events.push('normal'); await lease.release(); });
  const urgent = acquirePriorityLease({ root: lock, priority: 100 }).then(async lease => { events.push('schedule'); await delay(30); await lease.release(); });
  await delay(30);
  assert.deepEqual(events, []);
  await assert.rejects(low.checkpoint({ writeOutcomeVerified: false }), /verifiziert/);
  await low.checkpoint({ writeOutcomeVerified: true });
  assert.equal(events[0], 'schedule');
  await low.release(); await Promise.all([normal, urgent]);
});
test('two concurrent UI reservations are serialized', async () => {
  let active = 0, maximum = 0;
  await Promise.all([1, 2].map(async () => {
    const lease = await acquirePriorityLease({ root: path.join(root, 'planbar'), priority: 100 });
    active++; maximum = Math.max(maximum, active); await delay(30); active--; await lease.release();
  }));
  assert.equal(maximum, 1);
});
test('legacy living owner is never evicted even by urgent reservation', async () => {
  const lock = path.join(root, 'legacy'); await mkdir(lock); await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(acquirePriorityLease({ root: lock, priority: 100, timeoutMs: 50, pollMs: 10 }), /laufende Aktion/);
});
test('worker checkpoint blocks until urgent action finishes and then reacquires', async () => {
  const directory = path.join(root, 'checkpoint'); await mkdir(directory);
  const lock = path.join(root, 'checkpoint-lock');
  const low = await acquirePriorityLease({ root: lock });
  let finished = false;
  const urgent = acquirePriorityLease({ root: lock, priority: 100 }).then(async lease => { await delay(20); finished = true; await lease.release(); });
  await serveUiCheckpoints(directory, low, async () => {
    const result = await requestUiCheckpoint(directory); assert.equal(result.yielded, true); assert.equal(finished, true);
  });
  await low.release(); await urgent;
});
test('long build does not take desktop lease or delay scheduling', async () => {
  const jobId = tasks.codexJobIdForRequest('build-fixture'), directory = path.join(process.env.IVA_CODEX_TASK_ROOT, jobId);
  await mkdir(directory, { recursive: true });
  const createdAt = new Date().toISOString();
  await writeFile(path.join(directory, 'request.json'), JSON.stringify({ jobId, mode: 'build', createdAt }));
  await writeFile(path.join(directory, 'state.json'), JSON.stringify({ jobId, status: 'queued', createdAt }));
  let endBuild, started;
  const start = new Promise(resolve => { started = resolve; });
  const build = tasks.runCodexTask(jobId, { report: async () => {}, withWakeGuard: async task => task(), withUiLock: () => { throw Error('Build acquired desktop'); }, execute: async () => { started(); await new Promise(resolve => { endBuild = resolve; }); } });
  await start;
  const lease = await acquirePriorityLease({ root: path.join(root, 'build-desktop'), priority: 100, timeoutMs: 1000 });
  await lease.release(); endBuild(); await build;
});
test('same customer simultaneous requests create exactly one worker', async () => {
  let launches = 0;
  const dependencies = { report: async () => {}, spawnProcess: () => { launches++; const c = new EventEmitter(); c.unref = () => {}; queueMicrotask(() => c.emit('spawn')); return c; } };
  const input = { customerName: 'Fixture Kunde', partnerId: 'heat-hero', partnerName: 'Heat Hero', partnerPrefix: 'HH', isoYear: 2026, week: 41, materialDeliverySpace: 'not-asked', theftWeatherProtected: false };
  const results = await Promise.all([tasks.startPlanbarCustomerSchedulingTask({ ...input, commandId: 'one' }, dependencies), tasks.startPlanbarCustomerSchedulingTask({ ...input, commandId: 'two' }, dependencies)]);
  assert.equal(results[0].jobId, results[1].jobId); assert.equal(launches, 1);
});
test('KW before phase; adjacent live stage; exact native community and signed offer gate', () => {
  const time = new Date().toISOString(), reservation = { verified: true, week: 9, verifiedAt: time };
  const week = { verified: true, verifiedAt: time, dealId: '123', value: 'KW09' };
  const stage = { verified: true, verifiedAt: time, dealId: '123', fromStageId: 'a', toStageId: 'b', visibleStageOrder: ['a', 'b', 'c'] };
  assert.throws(() => mergeSchedulingMilestones({}, { pipedriveStage: stage }, reservation), /KW/);
  assert.throws(() => mergeSchedulingMilestones({}, { pipedriveWeek: { ...week, value: 'KW9' } }, reservation), /KW/);
  let proof = mergeSchedulingMilestones({}, { pipedriveWeek: week }, reservation);
  assert.throws(() => mergeSchedulingMilestones(proof, { pipedriveStage: { ...stage, toStageId: 'c' } }, reservation), /Phase/);
  proof = mergeSchedulingMilestones(proof, { pipedriveStage: stage }, reservation);
  assert.equal(schedulingMilestoneStatus({ reservation, milestones: proof, missingDetails: ['Details'] }).minimalComplete, true);
  const whatsapp = { verified: true, verifiedAt: time, app: 'native-whatsapp', group: 'Terminierung Dispo', community: 'Heat Hero GmbH', messageId: 'observed-1', customerName: 'Fixture Kunde', orderNumber: 'HH-AN-1', orderNumberSource: { kind: 'signed-offer', documentId: 'doc-1', verified: true }, text: 'Fixture Kunde, KW 9, HH-AN-1' };
  for (const patch of [{ app: 'web-whatsapp' }, { community: 'other' }, { group: 'Terminierungen Dispo' }, { orderNumberSource: { kind: 'deal-title' } }, { text: 'Fixture Kunde, KW 9' }]) assert.throws(() => mergeSchedulingMilestones(proof, { whatsapp: { ...whatsapp, ...patch } }, reservation), /WhatsApp/);
  const complete = mergeSchedulingMilestones(proof, { whatsapp }, reservation);
  assert.equal(schedulingMilestoneStatus({ reservation, milestones: complete }).whatsappConfirmed, true);
  assert.throws(() => mergeSchedulingMilestones(complete, { pipedriveStage: { ...stage, fromStageId: 'b', toStageId: 'c' } }, reservation), /wiederholt/);
});


test('build UI sections acquire and release shared desktop; code sections stay free', async () => {
  const directory = path.join(root, 'build-ui'); await mkdir(directory);
  let held = false;
  await serveBuildUiAccess(directory, async task => { assert.equal(held, false); held = true; try { return await task(); } finally { held = false; } }, async () => {
    assert.equal(held, false);
    await requestBuildUiAccess(directory, 'acquire'); assert.equal(held, true);
    await requestBuildUiAccess(directory, 'release'); assert.equal(held, false);
    await requestBuildUiAccess(directory, 'acquire'); assert.equal(held, true);
  });
  assert.equal(held, false);
});
test('cancellation removes waiting ticket without evicting an active lease', async () => {
  const lock = path.join(root, 'cancel-ui'), controller = new AbortController();
  const owner = await acquirePriorityLease({ root: lock });
  const waiting = acquirePriorityLease({ root: lock, priority: 100, signal: controller.signal, pollMs: 5 });
  controller.abort(); await assert.rejects(waiting, /abort/i); await owner.release();
  const next = await acquirePriorityLease({ root: lock, timeoutMs: 1000 }); await next.release();
});
