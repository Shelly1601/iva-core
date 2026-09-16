import test from 'node:test';
import assert from 'node:assert/strict';
import { amendPipedriveFundingHandoff } from '../local-mac-helper/background-integrations.mjs';

test('amendment helper requires explicit confirmation and uses only the scoped PATCH route', async () => {
  const input = { dealId: '123', noteId: '456', handoffId: 'fixture-handoff', requestId: 'fixture-change',
    expectedContentSha256: 'a'.repeat(64), documentReview: { complete: true }, result: { estimatedGrant: 9000 }, confirmApply: true };
  let calls = 0;
  const requestImpl = async (route, options) => {
    calls++;
    assert.equal(route, '/device-agent/macmini-nadine/background/pipedrive/deals/123/funding-handoff/note');
    assert.equal(options.method, 'PATCH');
    const { dealId, confirmApply, ...body } = input;
    assert.deepEqual(options.body, body);
    return { verified: true, noteId: '456', noteCreated: false, stageChanged: false };
  };
  await assert.rejects(amendPipedriveFundingHandoff({ ...input, confirmApply: false }, { requestImpl }), /confirmApply/);
  await assert.rejects(amendPipedriveFundingHandoff({ ...input, dealId: '123/other' }, { requestImpl }), /Deal-/);
  assert.equal(calls, 0);
  assert.equal((await amendPipedriveFundingHandoff(input, { requestImpl })).verified, true);
  assert.equal(calls, 1);
});

test('uncertain device-channel response is not retried and raw response data is suppressed', async () => {
  let calls = 0;
  await assert.rejects(amendPipedriveFundingHandoff({ dealId: '123', noteId: '456', confirmApply: true }, {
    requestImpl: async () => { calls++; throw new Error('raw-private-response-marker'); },
  }), error => /denselben Vorgang/.test(error.message) && !error.message.includes('raw-private-response-marker'));
  assert.equal(calls, 1);
});
