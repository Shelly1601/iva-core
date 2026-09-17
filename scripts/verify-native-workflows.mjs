import test from 'node:test';
import assert from 'node:assert/strict';
import { startNativeWorkflow, nativeWorkflowCapabilities } from '../local-mac-helper/native-workflows.mjs';

const input = { workflowId: 'planbar-weekly-export', runMode: 'automatic', automationSlotKey: 'forecast:2026-W38' };
function fixture() {
  const attachments = ['Planbar_Gesamtliste_KW40-49_2026.xlsx', 'Planbar_Bosch_KW40-49_2026.xlsx'];
  return { deliveryRunKey: 'automatic:forecast:2026-W38', runMode: 'automatic', automationSlotKey: 'forecast:2026-W38',
    sender: 'n.sell@heat-hero.com', recipient: 'a.keller@heat-hero.com', subject: 'Planbar-Listen KW 40-49 / 2026',
    period: 'KW 40-49 / 2026', attachments, attachmentHashes: Object.fromEntries(attachments.map(name => [name, 'a'.repeat(64)])),
    status: 'submitted_unverified', sentFolderVerified: false, planbarExactMatch: true,
    createdAt: '2026-09-18T16:00:00Z', verificationNotBefore: '2026-09-18T16:00:00Z', verificationNotAfter: '2026-09-18T16:10:00Z',
    sourceCollectedAt: '2026-09-18T15:59:00Z', planbarRecheckedAt: '2026-09-18T15:59:30Z' };
}
function markVerified(receipt) {
  receipt.status = 'sent_verified'; receipt.sentFolderVerified = true;
  receipt.sentFolder = { verified: true, folder: 'Gesendet', subject: receipt.subject, sender: receipt.sender,
    recipients: [receipt.recipient], attachments: [...receipt.attachments] };
  return receipt;
}
function harness(receipt = fixture()) {
  const calls = [];
  const dependencies = {
    assertHost: () => { calls.push('host'); },
    readReceipt: async key => { calls.push(`read:${key}`); return structuredClone(receipt); },
    resumeReceipt: async (_receipt, context) => { calls.push(`resume:${context.canonicalKey}`); markVerified(receipt); },
    sessionStatus: async () => { calls.push('session'); return { usable: true }; },
    withUiLock: async task => { calls.push('lock'); return task(); },
    withWakeGuard: async (task, options) => { calls.push('wake'); assert.equal(options.sleepDisplays, false); return task(); },
  };
  return { receipt, calls, dependencies };
}

test('new forecast is honestly blocked before UI; unsupported workflow never invokes adapters', async () => {
  const h = harness(null);
  const result = await startNativeWorkflow(input, h.dependencies);
  assert.equal(result.errorCode, 'NATIVE_FORECAST_BUILDER_UNAVAILABLE');
  assert.equal(result.completed, false); assert.equal(result.codexFallback, false);
  assert.deepEqual(h.calls, ['host', 'read:automatic:forecast:2026-W38']);
  h.calls.length = 0;
  assert.equal((await startNativeWorkflow({ workflowId: 'funding-daily-sequence' }, h.dependencies)).supported, false);
  assert.deepEqual(h.calls, []);
  assert.equal(nativeWorkflowCapabilities().workflows['planbar-weekly-export'].createNewDelivery, false);
});

test('fully verified original receipt completes without UI or new model run', async () => {
  const h = harness(markVerified(fixture()));
  const result = await startNativeWorkflow(input, h.dependencies);
  assert.equal(result.status, 'completed'); assert.equal(result.sentFolderVerified, true);
  assert.equal(result.workflowProof.automationSlotKey, input.automationSlotKey);
  assert.deepEqual(h.calls, ['host', 'read:automatic:forecast:2026-W38']);
});

test('uncertain send uses original identity and only completes after durable reread', async () => {
  const h = harness();
  const result = await startNativeWorkflow(input, h.dependencies);
  assert.equal(result.status, 'completed'); assert.equal(result.resumed, true);
  assert.deepEqual(h.calls, ['host', 'read:automatic:forecast:2026-W38', 'session', 'lock', 'session', 'wake',
    'resume:automatic:forecast:2026-W38', 'read:automatic:forecast:2026-W38']);
});

test('success-shaped adapter return without saved proof stays open', async () => {
  const h = harness(); h.dependencies.resumeReceipt = async () => ({ sent: true, sentFolderVerified: true });
  const result = await startNativeWorkflow(input, h.dependencies);
  assert.equal(result.status, 'blocked'); assert.equal(result.errorCode, 'NATIVE_WORKFLOW_PROOF_PENDING');
  assert.equal(result.retryReadbackOnly, true);
});

test('foreign or incomplete receipt and invented success evidence fail closed', async () => {
  for (const mutate of [
    r => { r.deliveryRunKey = 'automatic:other-slot'; },
    r => { r.automationSlotKey = 'other-slot'; },
    r => { r.sender = 'other@example.test'; },
    r => { r.attachments.push('unexpected.pdf'); },
    r => { r.attachments[1] = '../Planbar_Bosch_KW40-49_2026.xlsx'; },
    r => { r.verificationNotAfter = '2026-09-19T16:00:00Z'; },
    r => { r.planbarExactMatch = false; },
    r => { r.sourceCollectedAt = '2026-09-18T15:30:00Z'; },
    r => { r.planbarRecheckedAt = '2026-09-18T16:01:00Z'; },
    r => { delete r.attachmentHashes; },
    r => { markVerified(r); r.sentFolder.attachments = []; },
    r => { markVerified(r); delete r.sentFolder; },
  ]) {
    const h = harness(); mutate(h.receipt);
    const result = await startNativeWorkflow(input, h.dependencies);
    assert.equal(result.status, 'blocked'); assert.equal(result.completed, false);
    assert.equal(h.calls.some(call => call.startsWith('resume:')), false);
  }
});

test('manual identity stays separate and invalid identity cannot touch receipts', async () => {
  const receipt = markVerified(fixture()); receipt.runMode = 'manual'; receipt.automationSlotKey = ''; receipt.deliveryRunKey = 'manual:manual-1';
  const h = harness(receipt);
  const result = await startNativeWorkflow({ workflowId: input.workflowId, runMode: 'manual', requestId: 'manual-1' }, h.dependencies);
  assert.equal(result.status, 'completed');
  assert.equal(result.workflowProof.deliveryRunKey, 'manual-1');
  assert.equal(result.workflowProof.canonicalDeliveryRunKey, 'manual:manual-1');
  for (const bad of [{ ...input, automationSlotKey: '' }, { ...input, runMode: 'auto' },
    { workflowId: input.workflowId, requestId: 'manual-1', automationSlotKey: 'other' }]) {
    h.calls.length = 0;
    assert.equal((await startNativeWorkflow(bad, h.dependencies)).errorCode, 'NATIVE_WORKFLOW_IDENTITY_REQUIRED');
    assert.deepEqual(h.calls, []);
  }
});

test('session locking during queue wait prevents readback UI and failures never become success', async () => {
  const h = harness(); let probe = 0;
  h.dependencies.sessionStatus = async () => ({ usable: ++probe === 1 });
  assert.equal((await startNativeWorkflow(input, h.dependencies)).errorCode, 'NATIVE_WORKFLOW_SESSION_REQUIRED');
  assert.equal(h.calls.includes('wake'), false);
  h.dependencies.sessionStatus = async () => ({ usable: true });
  h.dependencies.resumeReceipt = async () => { throw new Error('technical problem'); };
  const result = await startNativeWorkflow(input, h.dependencies);
  assert.equal(result.status, 'blocked'); assert.equal(result.retryReadbackOnly, true);
  assert.equal(JSON.stringify(result).includes('technical problem'), false);
});
