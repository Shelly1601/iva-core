import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFundingIntakeStore } from '../local-mac-helper/funding-intake-state.mjs';
import { completeFundingMail } from '../local-mac-helper/funding-mail-completion.mjs';
import { fundingIntakeProofIsComplete, hasCompletionEvidence } from '../local-mac-helper/workflow-recovery.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'iva-funding-wait-completion-'));
process.env.IVA_MAC_HELPER_DATA_DIR = path.join(directory, 'helper');
process.env.IVA_CODEX_TASK_ROOT = path.join(directory, 'tasks');
process.env.IVA_DEVICE_WORKSPACE = path.join(directory, 'workspace');
const { buildFundingIntakeProof: buildProof, getCodexTaskStatus, resolveFundingTaskFinalStatus, shouldResumeCodexTaskAfterTermination } = await import('../local-mac-helper/codex-tasks.mjs');
const emptyJournal = () => ({ version: 2, completed: [], pendingMoves: [] });
const buildFundingIntakeProof = (req, state, journal = emptyJournal()) => buildProof(req, state, journal);
after(() => rm(directory, { recursive: true, force: true }));
let serial = 0;
const messageId = 'outlook:fixture:waiting';
const page = (messages = [], checkpoint = 'fixture-delta') => ({ source: 'outlook-native', coverageVerified: true, complete: true, nextCursor: null, checkpoint, messages });
const message = (id = messageId, extra = {}) => ({ messageId: id, receivedAt: '2026-09-15T12:00:00Z', hasAttachments: false, ...extra });
const review = extra => ({ messageId, dealId: '123', identityVerified: true, sourceReadComplete: true, attachmentReviewComplete: true,
  reviewComplete: true, technicalWorkPending: false, sideEffectsVerified: true, sourceHash: 'a'.repeat(64), reviewFingerprint: 'b'.repeat(64),
  openPoints: ['Externe Antwort steht aus'], nextAction: 'Eine neue Antwort dem Deal zuordnen.', verifiedAt: new Date(Date.now() - 120_000).toISOString(), ...extra });
const request = mode => ({ jobId: '00000000-0000-4000-8000-000000000001', workflowId: mode === 'initial-backfill' ? 'funding-initial-backfill' : 'funding-daily-sequence',
  resultProtocol: 1, createdAt: new Date(Date.now() - 60_000).toISOString(), fundingRun: { mode } });
const accepts = (req, proof) => fundingIntakeProofIsComplete({ proof, jobId: req.jobId, mode: req.fundingRun.mode, createdAt: req.createdAt });
async function setup(extraReview) {
  const store = createFundingIntakeStore({ filePath: path.join(directory, `intake-${++serial}.json`) });
  await store.begin({ mode: 'initial-backfill' });
  await store.recordPage(page([message()], 'fixture-backfill'), { mode: 'initial-backfill' });
  await store.recordWaitingReview(review(extraReview));
  return store;
}
async function delta(store, messages = []) {
  const run = await store.begin({ mode: 'incremental' });
  assert.equal(run.mode, 'incremental', 'scanned backfill uses delta even while reviewed cases wait');
  await store.recordPage(page(messages), { mode: run.mode, expectedCursor: run.cursor });
  return store.status();
}

test('reviewed waiting permits daily completion without claiming filed messages or triggering another worker', async () => {
  const store = await setup(), state = await delta(store), req = request('incremental'), proof = buildFundingIntakeProof(req, state);
  assert.deepEqual([proof.pending, proof.pendingTotal, proof.actionablePending, proof.waiting], [1, 1, 0, 1]);
  assert.equal(proof.completed, true); assert.equal(proof.allMessagesCompleted, false); assert.equal(proof.backfillCompleted, false);
  assert.equal(accepts(req, proof), true);
  const structuredResult = { outcome: 'completed', summary: 'Ausführbare Schritte erledigt; ein geprüfter Fall wartet auf externe Antwort.' };
  assert.equal(hasCompletionEvidence({ request: req, state: { fundingIntakeProof: proof }, structuredResult }), true);
  assert.equal(resolveFundingTaskFinalStatus({ request: req, exitCode: 0, structuredStatus: 'completed', structuredResult, fundingIntakeProof: proof }), 'completed');
  assert.equal(shouldResumeCodexTaskAfterTermination({ request: req, state: { fundingIntakeProof: proof }, structuredResult, exitCode: 0 }), false);
  assert.equal((await store.status()).messages[0].status, 'waiting');
});

test('initial review completes at scanned while the next daily run uses the saved delta checkpoint', async () => {
  const store = await setup(), state = await store.status(), req = request('initial-backfill'), proof = buildFundingIntakeProof(req, state);
  assert.equal(state.backfill.status, 'scanned'); assert.equal(proof.backfillReviewComplete, true);
  assert.equal(proof.backfillCompleted, false); assert.equal(proof.allMessagesCompleted, false); assert.equal(accepts(req, proof), true);
  const next = await store.begin({ mode: 'incremental' });
  assert.equal(next.mode, 'incremental'); assert.equal(next.cursor, 'fixture-backfill');
  await store.recordPage(page(), { mode: next.mode, expectedCursor: next.cursor });
  const second = await store.begin({ mode: 'incremental' });
  assert.equal(second.mode, 'incremental'); assert.equal(second.cursor, 'fixture-delta');
  assert.equal((await store.status()).messages[0].status, 'waiting');
});

test('unreviewed or newly changed work still prevents completion', async () => {
  for (const fresh of [message('outlook:fixture:new'), message(messageId, { sourceHash: 'c'.repeat(64) })]) {
    const store = await setup(), state = await delta(store, [fresh]), req = request('incremental'), proof = buildFundingIntakeProof(req, state);
    assert.equal(proof.actionablePending, 1); assert.equal(proof.completed, false); assert.equal(accepts(req, proof), false);
  }
});

test('weak or mismatched waiting labels cannot conceal actionable work', async () => {
  const state = await delta(await setup()), req = request('incremental');
  for (const alter of [
    item => { item.waitingReview.reviewComplete = false; },
    item => { item.waitingReview.technicalWorkPending = true; },
    item => { item.waitingReview.sideEffectsVerified = false; },
    item => { item.waitingReview = null; },
    item => { item.sourceHash = 'c'.repeat(64); },
    item => { item.waitingReview.messageId = 'outlook:fixture:other'; },
    item => { item.dealId = '456'; },
    item => { item.resume = { reason: 'blocker_resolved' }; },
  ]) {
    const changed = structuredClone(state); alter(changed.messages[0]);
    const proof = buildFundingIntakeProof(req, changed);
    assert.equal(proof.actionablePending, 1); assert.equal(proof.waiting, 0); assert.equal(accepts(req, proof), false);
  }
});

test('due followups are actionable and a previously generated wait proof expires at its due time', async () => {
  const store = await setup({ nextActionAt: new Date(Date.now() - 1000).toISOString() });
  const req = request('incremental'), state = await delta(store), proof = buildFundingIntakeProof(req, state);
  assert.equal(proof.actionablePending, 1); assert.equal(proof.completed, false);
  const futureStore = await setup({ nextActionAt: new Date(Date.now() + 60_000).toISOString() });
  const future = buildFundingIntakeProof(req, await delta(futureStore));
  assert.ok(future.nextWaitingActionAt); assert.equal(accepts(req, future), true);
  assert.equal(accepts(req, { ...future, nextWaitingActionAt: new Date(Date.now() - 1).toISOString() }), false);
});

test('waiting never bypasses running, incomplete, cursorless-unproved or stale mailbox coverage', async () => {
  const state = await delta(await setup()), req = request('incremental');
  for (const alter of [
    value => { value.backfill.status = 'running'; },
    value => { value.incremental.complete = false; },
    value => { value.incremental.cursor = 'remaining-page'; },
    value => { value.incremental.checkpoint = null; },
    value => { value.incremental.scannedAt = null; },
    value => { value.incremental.scannedAt = new Date(Date.now() - 3600_000).toISOString(); },
  ]) {
    const changed = structuredClone(state); alter(changed);
    assert.equal(accepts(req, buildFundingIntakeProof(req, changed)), false);
  }
  const initial = request('initial-backfill'), missing = structuredClone(state); missing.backfill.checkpoint = null;
  assert.equal(accepts(initial, buildFundingIntakeProof(initial, missing)), false);
});

test('proof validator preserves legacy zero-pending checks and rejects inconsistent new counts', async () => {
  const req = request('incremental'), proof = buildFundingIntakeProof(req, await delta(await setup()));
  for (const patch of [{ pending: 0 }, { pendingTotal: 0 }, { actionablePending: 1 }, { waiting: 0 }, { waiting: -1 },
    { allMessagesCompleted: true }, { pendingTotal: null }, { actionablePending: undefined }, { nextWaitingActionAt: 'invalid' },
    { completionJournalVerified: false }, { pendingMoves: 1 }, { pendingMoves: null }]) {
    assert.equal(accepts(req, { ...proof, ...patch }), false);
  }
  const legacy = { protocol: 2, jobId: req.jobId, mode: 'incremental', coverageComplete: true, checkpointRecorded: true, completed: true, pending: 0, scannedAt: new Date().toISOString() };
  assert.equal(accepts(req, legacy), true); assert.equal(accepts(req, { ...legacy, pending: 1 }), false);
  assert.equal(hasCompletionEvidence({ request: req, state: { fundingIntakeProof: proof }, structuredResult: { outcome: 'partial' } }), false);
});

test('an uncertain move out of waiting remains technical work even before intake status changes', async () => {
  const store = await setup(); await delta(store);
  let journal = emptyJournal();
  const input = { messageDescription: 'Betreff: Fixture', receipt: { messageId, dealId: '123', identityVerified: true, sourceReadComplete: true,
    expectedAttachmentCount: 0, textRelevant: true, note: { id: '42', dealId: '123', verified: true }, verifiedAt: new Date().toISOString() } };
  await assert.rejects(completeFundingMail(input, { intakeStore: store, load: async () => structuredClone(journal), save: async value => { journal = structuredClone(value); },
    resolveIdentity: async () => ({ identityVerified: true, messageId, description: 'Betreff: Fixture' }), moveMessage: async () => { throw new Error('uncertain move'); } }), /uncertain move/);
  const state = await store.status(), req = request('incremental');
  assert.equal(state.waiting.length, 1); assert.equal(journal.pendingMoves.length, 1);
  const proof = buildFundingIntakeProof(req, state, journal);
  assert.equal(proof.pendingMoves, 1); assert.equal(proof.completed, false); assert.equal(accepts(req, proof), false);
});

test('final status freshly reads the completion journal and fails closed on unreadable or malformed state', async () => {
  const store = await setup(), state = await delta(store), req = request('incremental');
  const taskDirectory = path.join(process.env.IVA_CODEX_TASK_ROOT, req.jobId), helper = process.env.IVA_MAC_HELPER_DATA_DIR;
  await mkdir(taskDirectory, { recursive: true }); await mkdir(helper, { recursive: true });
  await writeFile(path.join(taskDirectory, 'request.json'), JSON.stringify(req));
  await writeFile(path.join(taskDirectory, 'state.json'), JSON.stringify({ jobId: req.jobId, status: 'completed' }));
  await writeFile(path.join(helper, 'funding-intake.json'), JSON.stringify(state));
  const file = path.join(helper, 'funding-mail-completion.json');
  assert.equal((await getCodexTaskStatus(req.jobId)).fundingIntakeProof.completed, true, 'missing journal has no persisted move intent');
  for (const body of [JSON.stringify({ ...emptyJournal(), pendingMoves: [{ messageId }] }), '{broken', '{}', JSON.stringify({ version: 2, completed: [], pendingMoves: null })]) {
    await writeFile(file, body);
    const proof = (await getCodexTaskStatus(req.jobId)).fundingIntakeProof;
    assert.equal(proof.completed, false); assert.equal(accepts(req, proof), false);
    assert.equal(await readFile(file, 'utf8'), body, 'checking completion must never rewrite the journal');
  }
  await writeFile(file, JSON.stringify(emptyJournal()));
  assert.equal((await getCodexTaskStatus(req.jobId)).fundingIntakeProof.completed, true);
});
