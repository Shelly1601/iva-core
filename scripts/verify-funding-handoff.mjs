import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { completePipedriveFundingHandoff, listPendingFundingHandoffs } from '../integrations/pipedrive-funding-handoff.js';
import { fundingHandoffSnapshotFingerprint, validateFundingHandoffReview } from '../local-mac-helper/funding-handoff-policy.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-funding-handoff-'));
const grant = { canUseForFundingNote: true, units: 1, selfUsed: true, rate: 46, selfUsedUnitRate: 46, buildingBaseRate: 30,
  estimatedGrant: 12880, eligibleCosts: 28000, buildingBaseGrant: 8400, selfUsedUnitAdditionalGrant: 4480,
  bonuses: { base: 30, climateSpeed: 16, income: 0 }, incomeBonusRequested: false, calculationComplete: true };
function fixture() {
  let clock = Date.parse('2026-09-16T12:00:00Z'), noteSequence = 100;
  const file = path.join(directory, randomUUID(), 'handoff.json'), events = [], notes = new Map();
  const snapshot = { dealId: '123', customerPersonId: '77', pipeline: 'Auftragsmachbarkeit', stage: 'Auftrag eingereicht / Förderunterlagen einreichen',
    kfwAccountConfirmedByCredentials: true, kfwCredentialEvidenceNoteIds: ['71'],
    orderNumber: 'HH-AB-1234', customerEmail: 'fixture@example.test', phoneNumber: '0123456789', plant: 'Testanlage', incomeBonusRequested: false,
    fileRecords: ['Angebot', 'Ausweis', 'Meldebescheinigung', 'Grundbuch', 'KfW'].map((name, i) => ({ id: String(i + 1), name: `${name}.pdf`, size: 100 + i })) };
  const review = () => ({ dealId: '123', checkedAt: new Date(clock).toISOString(), complete: true, sourceNotesChecked: true, incomeBonusRequested: false,
    snapshotFingerprint: fundingHandoffSnapshotFingerprint(snapshot), files: snapshot.fileRecords.map(file => ({ fileId: file.id, readable: true, identityVerified: true })),
    documentEvidence: Object.fromEntries(['signed_offer', 'identity_card', 'registration_certificate', 'land_register', 'kfw_account_confirmation'].map(type => [type, 'present_in_pipedrive'])) });
  const dependencies = { file, now: () => clock, lockTimeoutMs: 2000,
    async readSnapshot(id) { assert.equal(id, '123'); events.push('read'); return structuredClone(snapshot); },
    async transition(input) {
      assert.equal(input.fromStage, 'Auftrag eingereicht / Förderunterlagen einreichen'); assert.equal(input.toStage, 'Förderung beantragen');
      const state = JSON.parse(await fs.readFile(file)); assert.equal(state.deals['123'].status, 'transition_attempted');
      events.push('transition'); snapshot.stage = 'Förderung beantragen'; return { changed: true, verified: true, fromStageId: 19, toStageId: 18 };
    },
    async writeNote(input) {
      events.push('note'); assert.equal(snapshot.stage, 'Förderung beantragen');
      const state = JSON.parse(await fs.readFile(file)); assert.equal(state.deals['123'].status, 'note_attempted');
      assert.ok(state.deals['123'].stageVerifiedAt);
      const old = notes.get(input.text); if (old) return { noteId: old, alreadyPresent: true, verified: true };
      if (input.reconcileOnly) return { noteId: null, verified: false, writeAttempted: false, reconcileOnly: true };
      const id = String(++noteSequence); notes.set(input.text, id); return { noteId: id, created: true, verified: true };
    },
  };
  const input = () => ({ dealId: '123', documentReview: review(), result: structuredClone(grant), confirmation: 'Pipedrive schreiben' });
  return { file, events, notes, snapshot, dependencies, input, review, advance(ms) { clock += ms; }, async run(value) { return completePipedriveFundingHandoff(value || input(), dependencies); } };
}

test('complete/readable proof moves 19 to18 before writing exactly one verified note', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.verified, true); assert.equal(result.stageChanged, true); assert.equal(result.noteId, '101');
  assert.deepEqual(f.events, ['read', 'transition', 'read', 'note']);
  assert.match([...f.notes.keys()][0], /^Voraussichtlich .+ Förderung \(/);
  assert.ok([...f.notes.keys()][0].endsWith('(Notiz von Nadine)'));
  assert.deepEqual(await listPendingFundingHandoffs({ file: f.file }), []);
  const repeat = await f.run({ dealId: '123', confirmation: 'Pipedrive schreiben' });
  assert.equal(repeat.alreadyPresent, true); assert.equal(f.events.filter(v => v === 'transition').length, 1); assert.equal(f.notes.size, 1);
});

test('missing, unreadable, stale, foreign and mismatching review never writes stage or amount note', async () => {
  for (const alter of [
    input => { input.documentReview.documentEvidence.land_register = 'missing'; },
    input => { input.documentReview.documentEvidence.signed_offer = 'available_in_email'; },
    input => { input.documentReview.files[0].readable = false; },
    input => { input.documentReview.sourceNotesChecked = false; },
    input => { input.documentReview.checkedAt = '2026-09-16T10:00:00Z'; },
    input => { input.documentReview.checkedAt = '2026-09-17T12:00:00Z'; },
    input => { input.documentReview.dealId = '999'; },
    input => { input.documentReview.snapshotFingerprint = '0'.repeat(64); },
  ]) {
    const f = fixture(), input = f.input(); alter(input);
    await assert.rejects(f.run(input), error => error.code.startsWith('FUNDING_HANDOFF_'));
    assert.deepEqual(f.events, ['read']); assert.equal(f.notes.size, 0);
  }
});

test('all four canonical CRM fields remain a hard handoff gate', async () => {
  for (const field of ['orderNumber', 'customerEmail', 'phoneNumber', 'plant']) {
    const f = fixture(); f.snapshot[field] = null;
    await assert.rejects(f.run(), { code: 'FUNDING_HANDOFF_REQUIRED_FIELDS' }); assert.equal(f.events.includes('transition'), false);
  }
});

test('a login-status note or claimed KfW document alone cannot replace credentials freshly stored in the deal', async () => {
  for (const patch of [{ kfwAccountConfirmedByCredentials: false }, { kfwCredentialEvidenceNoteIds: [] }, { kfwCredentialEvidenceNoteIds: ['unknown'] }]) {
    const f = fixture(); Object.assign(f.snapshot, patch);
    await assert.rejects(f.run(), { code: 'FUNDING_HANDOFF_KFW_CREDENTIALS' });
    assert.deepEqual(f.events, ['read']); assert.equal(f.notes.size, 0);
  }
  const f = fixture(), input = f.input();
  f.snapshot.kfwCredentialEvidenceNoteIds = [];
  await assert.rejects(f.run(input), { code: 'FUNDING_HANDOFF_KFW_CREDENTIALS' });
  assert.equal(f.events.includes('transition'), false, 'fresh snapshot overrides an earlier positive review');
});

test('old phase18 without own persisted handoff does not create an amount note', async () => {
  for (const stage of ['Förderung beantragen', 'Förderung beantragt']) {
    const f = fixture(); f.snapshot.stage = stage;
    await assert.rejects(f.run(), { code: 'FUNDING_HANDOFF_NO_TRANSITION_PROOF' }); assert.equal(f.notes.size, 0);
  }
});

test('income bonus requires corresponding readable tax assessments and matching calculation', async () => {
  const f = fixture(); f.snapshot.incomeBonusRequested = true;
  let input = f.input(); await assert.rejects(f.run(input), { code: 'FUNDING_HANDOFF_INCOME_BONUS' });
  input.documentReview.incomeBonusRequested = true;
  await assert.rejects(f.run(input), { code: 'FUNDING_HANDOFF_MISSING_DOCUMENTS' });
  input.documentReview.documentEvidence.tax_assessment_2023 = 'present_in_pipedrive'; input.documentReview.documentEvidence.tax_assessment_2024 = 'present_in_pipedrive';
  await assert.rejects(f.run(input), { code: 'FUNDING_HANDOFF_INCOME_BONUS' });
  input.result.incomeBonusRequested = true; assert.equal((await f.run(input)).verified, true);
});

test('verified registration notification permits application and survives retry without claiming a full register', async () => {
  const f = fixture(), transition = f.dependencies.transition;
  f.snapshot.fileRecords[3].name = 'Eintragungsbekanntmachung.pdf';
  const input = f.input();
  delete input.documentReview.documentEvidence.land_register;
  input.documentReview.documentEvidence.land_register_notification = 'present_in_pipedrive';
  f.dependencies.transition = async () => { throw new Error('network'); };
  await assert.rejects(f.run(input), { code: 'FUNDING_HANDOFF_TRANSITION_UNCONFIRMED' });
  const record = JSON.parse(await fs.readFile(f.file)).deals['123'];
  assert.equal(record.proof.applicationOwnershipDocument, 'land_register_notification');
  assert.deepEqual(record.proof.payoutOutstandingDocumentIds, ['land_register']);
  assert.equal(record.documentReview.documentEvidence.land_register_notification, 'present_in_pipedrive');
  assert.equal(record.documentReview.documentEvidence.land_register, undefined);
  assert.equal(record.proof.requiredDocumentIds.includes('land_register'), false);
  f.dependencies.transition = transition;
  assert.equal((await f.run({ dealId: '123', confirmation: 'Pipedrive schreiben' })).verified, true);
  assert.equal(f.notes.size, 1);
});

test('notification still requires verified readable deal evidence before handoff', async () => {
  for (const status of ['available_in_email', 'ambiguous', 'invalid', 'missing']) {
    const f = fixture(), input = f.input();
    delete input.documentReview.documentEvidence.land_register;
    input.documentReview.documentEvidence.land_register_notification = status;
    await assert.rejects(f.run(input), { code: 'FUNDING_HANDOFF_MISSING_DOCUMENTS' });
    assert.equal(f.events.includes('transition'), false);
  }
});

test('positive source review requires tax evidence even without a positive CRM field; absence does not', async () => {
  for (const field of [null, false]) {
    const f = fixture(); f.snapshot.incomeBonusRequested = field;
    const input = f.input();
    input.documentReview.incomeBonusRequested = true;
    input.result.incomeBonusRequested = true;
    await assert.rejects(f.run(input), { code: 'FUNDING_HANDOFF_MISSING_DOCUMENTS' });
    input.documentReview.documentEvidence.tax_assessment_2023 = 'present_in_pipedrive';
    input.documentReview.documentEvidence.tax_assessment_2024 = 'present_in_pipedrive';
    assert.equal((await f.run(input)).verified, true);
    const noRequest = fixture(); noRequest.snapshot.incomeBonusRequested = field;
    assert.equal((await noRequest.run()).verified, true);
  }
});

test('uncertain successful stage response is read back before note; transition is never repeated', async () => {
  const f = fixture();
  f.dependencies.transition = async () => { f.events.push('transition'); f.snapshot.stage = 'Förderung beantragen'; throw new Error('response lost'); };
  assert.equal((await f.run()).verified, true);
  assert.deepEqual(f.events, ['read', 'transition', 'read', 'note']);
});

test('uncertain non-applied stage write is not retried in the same call; restart reads first', async () => {
  const f = fixture(), original = f.dependencies.transition;
  f.dependencies.transition = async () => { f.events.push('uncertain'); throw new Error('network'); };
  await assert.rejects(f.run(), { code: 'FUNDING_HANDOFF_TRANSITION_UNCONFIRMED' });
  assert.deepEqual(f.events, ['read', 'uncertain', 'read']); assert.equal(f.notes.size, 0);
  assert.equal((await listPendingFundingHandoffs({ file: f.file }))[0].status, 'transition_attempted');
  f.dependencies.transition = original;
  assert.equal((await f.run({ dealId: '123', confirmation: 'Pipedrive schreiben' })).verified, true);
  assert.deepEqual(f.events, ['read', 'uncertain', 'read', 'read', 'transition', 'read', 'note']);
});

test('restart in phase18 needs attempted intent, not just prepared bookkeeping', async () => {
  const f = fixture(), originalRead = f.dependencies.readSnapshot;
  let reads = 0;
  f.dependencies.transition = async () => { f.snapshot.stage = 'Förderung beantragen'; throw new Error('response lost'); };
  f.dependencies.readSnapshot = async id => { if (++reads === 2) throw new Error('read failed'); return originalRead(id); };
  await assert.rejects(f.run(), /read failed/); f.dependencies.readSnapshot = originalRead;
  assert.equal((await f.run({ dealId: '123', confirmation: 'Pipedrive schreiben' })).verified, true); assert.equal(f.notes.size, 1);
  const g = fixture(); await fs.mkdir(path.dirname(g.file), { recursive: true });
  const proof = validateFundingHandoffReview({ dealId: '123', snapshot: g.snapshot, documentReview: g.review(), now: g.dependencies.now() });
  const record = JSON.parse(await fs.readFile(f.file)).deals['123'];
  await fs.writeFile(g.file, JSON.stringify({ version: 1, deals: { '123': { ...record, status: 'prepared', stageVerifiedAt: null, transitionAttemptedAt: null, proof } } }));
  g.snapshot.stage = 'Förderung beantragen'; await assert.rejects(g.run({ dealId: '123', confirmation: 'Pipedrive schreiben' }), { code: 'FUNDING_HANDOFF_NO_TRANSITION_PROOF' });
});

test('a successful changed:false response cannot authorize a new funding note', async () => {
  const f = fixture();
  f.dependencies.transition = async () => { f.snapshot.stage = 'Förderung beantragen'; return { changed: false, alreadyPresent: true, verified: true, fromStageId: 18, toStageId: 18 }; };
  await assert.rejects(f.run(), { code: 'FUNDING_HANDOFF_NO_TRANSITION_PROOF' });
  await assert.rejects(f.run({ dealId: '123', confirmation: 'Pipedrive schreiben' }), { code: 'FUNDING_HANDOFF_NO_TRANSITION_PROOF' }); assert.equal(f.notes.size, 0);
});

test('changed:false is persisted before any fallible read and stays rejected on restart', async () => {
  const f = fixture(), originalRead = f.dependencies.readSnapshot; let reads = 0;
  f.dependencies.transition = async () => { f.snapshot.stage = 'Förderung beantragen'; return { changed: false, alreadyPresent: true, verified: true }; };
  f.dependencies.readSnapshot = async id => { if (++reads > 1) throw new Error('read failed'); return originalRead(id); };
  await assert.rejects(f.run(), { code: 'FUNDING_HANDOFF_NO_TRANSITION_PROOF' });
  f.dependencies.readSnapshot = originalRead;
  await assert.rejects(f.run({ dealId: '123', confirmation: 'Pipedrive schreiben' }), { code: 'FUNDING_HANDOFF_NO_TRANSITION_PROOF' });
  assert.equal(f.notes.size, 0);
});

test('new human notes invalidate the saved document review before resumed transition', async () => {
  const f = fixture(); f.snapshot.fundingHandoffNotesFingerprint = 'old-notes';
  f.dependencies.transition = async () => { throw new Error('network'); };
  await assert.rejects(f.run(), { code: 'FUNDING_HANDOFF_TRANSITION_UNCONFIRMED' });
  f.snapshot.fundingHandoffNotesFingerprint = 'new-income-request';
  await assert.rejects(f.run({ dealId: '123', confirmation: 'Pipedrive schreiben' }), { code: 'FUNDING_HANDOFF_CHANGED_DOCUMENTS' });
  assert.equal(f.notes.size, 0);
});

test('uncertain note write resumes the exact saved text once, even after review age expires', async () => {
  const f = fixture(), original = f.dependencies.writeNote;
  f.dependencies.writeNote = async input => { await original(input); throw new Error('reply lost'); };
  await assert.rejects(f.run(), { code: 'FUNDING_HANDOFF_NOTE_UNCONFIRMED' }); assert.equal(f.notes.size, 1);
  const pending = await listPendingFundingHandoffs({ file: f.file }); assert.equal(pending[0].status, 'note_attempted'); assert.ok(!JSON.stringify(pending).includes('12.880'));
  f.advance(24 * 60 * 60_000); f.dependencies.writeNote = original;
  const result = await f.run({ dealId: '123', confirmation: 'Pipedrive schreiben' });
  assert.equal(result.verified, true); assert.equal(result.alreadyPresent, true); assert.equal(f.notes.size, 1); assert.equal(f.events.filter(v => v === 'transition').length, 1);
});

test('invisible uncertain note POST permits only reconciliation on every later invocation', async () => {
  const f = fixture(); let postAttempts = 0;
  f.dependencies.writeNote = async input => {
    if (!input.reconcileOnly) { postAttempts++; throw Object.assign(new Error('response lost'), { writeAttempted: true }); }
    return { verified: false, noteId: null, reconcileOnly: true, writeAttempted: false };
  };
  await assert.rejects(f.run(), { code: 'FUNDING_HANDOFF_NOTE_UNCONFIRMED' });
  for (let i = 0; i < 2; i++) await assert.rejects(f.run({ dealId: '123', confirmation: 'Pipedrive schreiben' }), { code: 'FUNDING_HANDOFF_NOTE_UNCONFIRMED' });
  assert.equal(postAttempts, 1);
});

test('a proved failure before any note POST permits one normal retry after fresh read', async () => {
  const f = fixture(), original = f.dependencies.writeNote;
  f.dependencies.writeNote = async input => { assert.equal(input.reconcileOnly, false); throw Object.assign(new Error('preflight read failed'), { writeAttempted: false }); };
  await assert.rejects(f.run(), { code: 'FUNDING_HANDOFF_NOTE_UNCONFIRMED' });
  f.dependencies.writeNote = async input => { assert.equal(input.reconcileOnly, false); return original(input); };
  assert.equal((await f.run({ dealId: '123', confirmation: 'Pipedrive schreiben' })).verified, true);
  assert.equal(f.notes.size, 1); assert.equal(f.events.filter(event => event === 'transition').length, 1);
});

test('changed files after transition prevent note publication and persisted resume', async () => {
  const f = fixture(), original = f.dependencies.transition;
  f.dependencies.transition = async input => { const result = await original(input); f.snapshot.fileRecords[0].size++; return result; };
  await assert.rejects(f.run(), { code: 'FUNDING_HANDOFF_CHANGED_DOCUMENTS' });
  await assert.rejects(f.run({ dealId: '123', confirmation: 'Pipedrive schreiben' }), { code: 'FUNDING_HANDOFF_CHANGED_DOCUMENTS' }); assert.equal(f.notes.size, 0);
});

test('old review before stage movement requires fresh re-review, not silent advancement', async () => {
  const f = fixture(), original = f.dependencies.transition;
  f.dependencies.transition = async () => { throw new Error('unavailable'); };
  await assert.rejects(f.run()); f.advance(31 * 60_000); f.dependencies.transition = original;
  await assert.rejects(f.run({ dealId: '123', confirmation: 'Pipedrive schreiben' }), { code: 'FUNDING_HANDOFF_STALE_REVIEW' });
  assert.equal((await f.run()).verified, true);
});

test('a corrected income request in a fresh review cannot reuse an older no-income calculation', async () => {
  const f = fixture(); f.dependencies.transition = async () => { throw new Error('network'); };
  await assert.rejects(f.run(), { code: 'FUNDING_HANDOFF_TRANSITION_UNCONFIRMED' });
  const review = f.review(); review.incomeBonusRequested = true;
  review.documentEvidence.tax_assessment_2023 = 'present_in_pipedrive'; review.documentEvidence.tax_assessment_2024 = 'present_in_pipedrive';
  await assert.rejects(f.run({ dealId: '123', documentReview: review, confirmation: 'Pipedrive schreiben' }), { code: 'FUNDING_HANDOFF_INCOME_BONUS' });
  assert.equal(f.notes.size, 0);
});

test('parallel callers serialize the transition and note write; malformed ledger is retained', async () => {
  const f = fixture(), input = f.input();
  const results = await Promise.all([f.run(input), f.run(input)]);
  assert.ok(results.every(result => result.verified)); assert.equal(f.events.filter(v => v === 'transition').length, 1); assert.equal(f.notes.size, 1);
  await fs.writeFile(f.file, '{broken'); await assert.rejects(f.run(input)); assert.equal(await fs.readFile(f.file, 'utf8'), '{broken');
});

after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
