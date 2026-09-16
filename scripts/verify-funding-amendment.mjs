import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { amendPipedriveFundingHandoff } from '../integrations/pipedrive-funding-amendment.js';
import { fundingHandoffSnapshotFingerprint } from '../local-mac-helper/funding-handoff-policy.mjs';
import { buildFundingCalculationNote } from '../local-mac-helper/funding-workflows.mjs';
import { calculateKfw458Funding } from '../workspaces/energy-calculations.js';

const NOW = Date.parse('2026-09-16T12:00:00Z');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-funding-amendment-'));
const sha = value => createHash('sha256').update(value).digest('hex');
let counter = 0;
test.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

async function fixture() {
  const file = path.join(dir, `${++counter}.json`);
  const snapshot = { dealId: '123', stage: 'Förderung beantragen', customerPersonId: '456', customerName: 'Synthetic Test',
    customerEmail: 'test@example.test', phoneNumber: '+4930123456', orderNumber: 'TEST-123', plant: 'Test 8 kW',
    incomeBonusRequested: false, fundingHandoffNotesFingerprint: 'a'.repeat(64),
    kfwAccountConfirmedByCredentials: true, kfwCredentialEvidenceNoteIds: ['222'], kfwCredentialInvalidationNoteIds: [],
    fileRecords: ['signed_offer', 'identity_card', 'registration_certificate', 'land_register'].map((name, i) => ({ id: String(i + 1), name: name + '.pdf', size: 100 })) };
  const calc = climateBonusEligible => ({ ...calculateKfw458Funding({ applicantType: 'private-owner', selfUsed: true, units: 1,
    projectCosts: 28000, existingBuildingAgeYears: 30, applicationDate: '2026-09-16', incomeBonusRequested: false,
    climateBonusEligible, contractConditional: true, applicationBeforeStart: true, hydraulicBalancingPlanned: true }, new Date(NOW)), calculatedAt: new Date(NOW).toISOString() });
  const originalText = buildFundingCalculationNote({ result: calc(false) });
  const originalRecord = { id: 'handoff-test', dealId: '123', status: 'completed', stageVerifiedAt: new Date(NOW - 3600000).toISOString(),
    completedAt: new Date(NOW - 3500000).toISOString(), noteId: '789', noteText: originalText,
    resultHash: 'original-result-hash', proof: { fingerprint: fundingHandoffSnapshotFingerprint(snapshot) } };
  await fs.writeFile(file, JSON.stringify({ version: 1, deals: { '123': originalRecord } }));
  snapshot.fundingHandoffNotesFingerprint = 'b'.repeat(64);
  const note = { dealId: '123', noteId: '789', text: originalText, content: `<p>${originalText.replaceAll('\n', '<br>')}</p>` };
  const result = calc(true), events = [];
  const dependencies = { file, now: () => NOW, readSnapshot: async () => structuredClone(snapshot),
    readNote: async () => structuredClone(note), updateExistingNote: async input => {
      const saved = JSON.parse(await fs.readFile(file));
      assert.equal(saved.deals['123'].amendments.at(-1).status, 'update_attempted', 'intent must be durable before PUT');
      assert.equal(input.noteId, '789'); assert.equal(sha(note.content), input.expectedContentSha256);
      events.push('PUT'); note.text = input.text; note.content = `<p>${input.text.replaceAll('\n', '<br>')}</p>`;
      return { verified: true };
    } };
  const input = () => ({ dealId: '123', handoffId: 'handoff-test', noteId: '789', requestId: 'source-change-1', confirmation: 'Pipedrive schreiben',
    expectedContentSha256: sha(note.content), result,
    documentReview: { dealId: '123', checkedAt: new Date(NOW).toISOString(), complete: true, sourceNotesChecked: true, incomeBonusRequested: false,
      snapshotFingerprint: fundingHandoffSnapshotFingerprint(snapshot), files: snapshot.fileRecords.map(f => ({ fileId: f.id, readable: true, identityVerified: true })),
      documentEvidence: Object.fromEntries(['signed_offer', 'identity_card', 'registration_certificate', 'land_register', 'kfw_account_confirmation'].map(type => [type, 'present_in_pipedrive'])) } });
  const minimal = () => ({ dealId: '123', handoffId: 'handoff-test', noteId: '789', requestId: 'source-change-1', confirmation: 'Pipedrive schreiben' });
  return { file, snapshot, note, result, originalRecord, input, minimal, dependencies, events,
    run: override => amendPipedriveFundingHandoff(override || input(), dependencies),
    ledger: async () => JSON.parse(await fs.readFile(file)) };
}

test('amends only the own existing note, preserves original handoff, repeats without another PUT', async () => {
  const f = await fixture(), first = await f.run();
  assert.equal(first.verified, true); assert.equal(first.noteId, '789'); assert.equal(first.stageChanged, false); assert.equal(first.noteCreated, false);
  const record = (await f.ledger()).deals['123'];
  for (const key of ['id', 'noteId', 'noteText', 'resultHash', 'proof', 'completedAt']) assert.deepEqual(record[key], f.originalRecord[key]);
  assert.equal(record.amendments.length, 1); assert.notEqual(record.currentNoteText, record.noteText);
  assert.equal((await f.run(f.minimal())).alreadyPresent, true); assert.deepEqual(f.events, ['PUT']);
});

test('missing own completed transition and mismatched handoff or note fail before any write', async () => {
  for (const edit of [i => i.handoffId = 'foreign', i => i.noteId = '1000', i => delete i.confirmation]) {
    const f = await fixture(), input = f.input(); edit(input); await assert.rejects(f.run(input)); assert.equal(f.events.length, 0);
  }
  const f = await fixture(), state = await f.ledger(); state.deals['123'].status = 'note_attempted';
  await fs.writeFile(f.file, JSON.stringify(state)); await assert.rejects(f.run(), { code: 'FUNDING_HANDOFF_AMENDMENT_OWNERSHIP' });
});

test('unchanged sources, changed stage, human edits and wrong expected hash cannot authorize a PUT', async () => {
  for (const change of [
    f => f.snapshot.fundingHandoffNotesFingerprint = 'a'.repeat(64),
    f => f.snapshot.stage = 'Montage',
    f => { f.note.text = 'Human edit'; f.note.content = '<p>Human edit</p>'; },
  ]) { const f = await fixture(); change(f); await assert.rejects(f.run()); assert.equal(f.events.length, 0); }
  const f = await fixture(), input = f.input(); input.expectedContentSha256 = '0'.repeat(64);
  await assert.rejects(f.run(input), { code: 'FUNDING_HANDOFF_AMENDMENT_NOTE_CHANGED' });
});

test('fresh document and calculation gates remain mandatory including credential evidence', async () => {
  for (const change of [
    (f, i) => i.documentReview.checkedAt = '2026-09-15T12:00:00Z',
    (f, i) => i.documentReview.files[0].readable = false,
    (f, i) => i.result.calculatedAt = '2026-09-15T12:00:00Z',
    (f, i) => i.result.calculatedAt = '2026-09-17T12:00:00Z',
    (f, i) => i.result.rulesVersion = 'wrong',
    (f, i) => i.result.canUseForFundingNote = false,
    (f, i) => i.result.isProjection = true,
    (f, i) => i.result.incomeBonusRequested = true,
    (f, i) => f.snapshot.kfwCredentialEvidenceNoteIds = [],
  ]) { const f = await fixture(), input = f.input(); change(f, input); await assert.rejects(f.run(input)); assert.equal(f.events.length, 0); }
});

test('uncertain PUT that actually applied is completed by readback, without retrying', async () => {
  const f = await fixture(), write = f.dependencies.updateExistingNote;
  f.dependencies.updateExistingNote = async i => { await write(i); throw new Error('response lost'); };
  assert.equal((await f.run()).verified, true); assert.deepEqual(f.events, ['PUT']);
});

test('uncertain PUT without visible effect is reconcile-only across restarts', async () => {
  const f = await fixture(); f.dependencies.updateExistingNote = async () => { f.events.push('PUT'); throw new Error('unknown'); };
  await assert.rejects(f.run(), { code: 'FUNDING_HANDOFF_AMENDMENT_UNCONFIRMED' });
  for (let i = 0; i < 2; i++) await assert.rejects(f.run(f.minimal()), { code: 'FUNDING_HANDOFF_AMENDMENT_UNCONFIRMED' });
  assert.deepEqual(f.events, ['PUT']);
  const amendment = (await f.ledger()).deals['123'].amendments[0];
  f.note.text = amendment.noteText; f.note.content = '<p>delayed current content</p>';
  assert.equal((await f.run(f.minimal())).verified, true); assert.deepEqual(f.events, ['PUT']);
});

test('new request cannot bypass an unresolved older amendment', async () => {
  const f = await fixture(); f.dependencies.updateExistingNote = async () => { throw new Error('unknown'); };
  await assert.rejects(f.run()); const input = f.input(); input.requestId = 'bypass';
  await assert.rejects(f.run(input), { code: 'FUNDING_HANDOFF_AMENDMENT_PENDING' });
});

test('explicit pre-write failure can safely resume the same intent with fresh evidence', async () => {
  const f = await fixture(), write = f.dependencies.updateExistingNote;
  f.dependencies.updateExistingNote = async () => { throw Object.assign(new Error('no request'), { writeAttempted: false }); };
  await assert.rejects(f.run(), { code: 'FUNDING_HANDOFF_AMENDMENT_NOT_ATTEMPTED' });
  assert.equal((await f.ledger()).deals['123'].amendments[0].status, 'prepared');
  f.dependencies.updateExistingNote = write; assert.equal((await f.run()).verified, true); assert.deepEqual(f.events, ['PUT']);
});

test('changes after intent prevent a stale correction and never reset attempted state', async () => {
  const f = await fixture(); f.dependencies.updateExistingNote = async () => { throw new Error('unknown'); };
  await assert.rejects(f.run()); f.snapshot.fundingHandoffNotesFingerprint = 'c'.repeat(64);
  await assert.rejects(f.run(f.minimal()), { code: 'FUNDING_HANDOFF_AMENDMENT_SOURCE_CHANGED' });
  assert.equal((await f.ledger()).deals['123'].amendments[0].status, 'update_attempted');
});

test('later genuine source delta can amend the same note while keeping both receipts', async () => {
  const f = await fixture(); await f.run(); f.snapshot.fundingHandoffNotesFingerprint = 'c'.repeat(64);
  // New source can confirm an unchanged calculated amount without another PUT.
  const next = f.input(); next.requestId = 'source-change-2';
  const response = await f.run(next); assert.equal(response.verified, true); assert.equal(response.updated, false);
  assert.equal((await f.ledger()).deals['123'].amendments.length, 2); assert.deepEqual(f.events, ['PUT']);
  await assert.rejects(f.run(f.minimal()), { code: 'FUNDING_HANDOFF_AMENDMENT_NOTE_CHANGED' });
});

test('concurrent identical requests serialize to one PUT', async () => {
  const f = await fixture(), input = f.input(); await Promise.all([f.run(input), f.run(input)]); assert.deepEqual(f.events, ['PUT']);
});
