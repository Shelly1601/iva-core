import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { markPipedriveFundingDealWonApi, PIPEDRIVE_WRITE_CONFIRMATION } from '../integrations/pipedrive.js';
const root = await mkdtemp(path.join(os.tmpdir(), 'iva-funding-won-test-'));
after(() => rm(root, { recursive: true, force: true }));
let serial = 0;
function setup() {
  const current = { id: 123, person_id: 77, pipeline_id: 1, stage_id: 18, status: 'open', label_ids: [1, 2] };
  const source = { dealId: '123', customerPersonId: '77', orderNumber: 'HH-AB-1234', customerEmail: 'fixture@example.com', phoneNumber: '0123456789', plant: 'Fixture Anlage', stage: 'Förderung beantragen', files: ['KfW-Zusage.pdf'], fileRecords: [{ id: '55', name: 'KfW-Zusage.pdf' }] };
  const target = { ...source, dealId: '456', stage: 'Montage einplanen' };
  const state = { current, source, target, targets: [{ id: 456, person_id: 77, pipeline_id: 2, stage_id: 8, status: 'open' }], writes: [], throwAfterWon: false };
  const dependencies = { dataDir: path.join(root, String(++serial)), wait: async () => {}, readSnapshot: async id => structuredClone(id === '123' ? state.source : { ...state.target, dealId: id }),
    request: async (url, options = {}) => {
      if (options.method === 'PATCH') {
        assert.equal(url, '/api/v2/deals/123', 'only the source deal may be mutated');
        assert.equal(options.write, true); state.writes.push(structuredClone(options.body)); Object.assign(current, options.body);
        if (options.body.status === 'won' && state.throwAfterWon) throw new Error('fixture unknown transport result');
        return { data: structuredClone(current) };
      }
      if (url === '/api/v2/deals/123') return { data: structuredClone(current) };
      assert.match(url, /^\/api\/v2\/deals\?pipeline_id=2&stage_id=8&person_id=77&status=open&limit=100$/);
      return { data: structuredClone(state.targets) };
    },
  };
  const input = { dealId: '123', approvalFileName: 'KfW-Zusage.pdf', confirmation: PIPEDRIVE_WRITE_CONFIRMATION,
    approvalEvidence: { dealId: '123', fileId: '55', filename: 'KfW-Zusage.pdf', officialApproval: true, identityVerified: true, readable: true, checkedAt: new Date(Date.now() - 1000).toISOString() } };
  return { state, input, dependencies };
}
test('deal-specific labels are removed and read back before Won and verified target', async () => {
  const { state, input, dependencies } = setup();
  const result = await markPipedriveFundingDealWonApi(input, dependencies);
  assert.deepEqual(state.writes, [{ label_ids: [] }, { status: 'won' }]);
  assert.equal(result.verified, true); assert.equal(result.targetDealId, '456'); assert.equal(result.labelsVerified, true);
  assert.deepEqual(result.targetMissingFields, []);
  assert.doesNotMatch(await readFile(path.join(dependencies.dataDir, 'funding-won/123.json'), 'utf8'), /fixture@example.com|0123456789/);
  await markPipedriveFundingDealWonApi({ ...input, approvalEvidence: undefined }, dependencies);
  assert.equal(state.writes.length, 2, 'retry uses receipt and readback, no second Won event');
});
test('missing or mismatched in-content approval proof never mutates a deal', async () => {
  for (const proof of [undefined, { fileId: '999' }, { officialApproval: false }, { dealId: '999' }]) {
    const { state, input, dependencies } = setup();
    await assert.rejects(markPipedriveFundingDealWonApi({ ...input, approvalEvidence: proof === undefined ? undefined : { ...input.approvalEvidence, ...proof } }, dependencies), /Zusage/);
    assert.equal(state.writes.length, 0);
  }
});
test('wrong stage or missing source fields remains pending without mutations', async () => {
  for (const change of ['stage', 'field']) {
    const { state, input, dependencies } = setup();
    if (change === 'stage') state.current.stage_id = 19; else state.source.phoneNumber = '';
    const result = await markPipedriveFundingDealWonApi(input, dependencies);
    assert.equal(result.pending, true); assert.equal(result.verified, false); assert.equal(state.writes.length, 0);
  }
});
test('missing target fields stay persisted for targeted repair, no repeated Won', async () => {
  const { state, input, dependencies } = setup(); state.target.plant = '';
  const result = await markPipedriveFundingDealWonApi(input, dependencies);
  assert.equal(result.pending, true); assert.equal(result.statusVerified, true); assert.equal(result.targetDealId, '456');
  assert.deepEqual(result.targetMissingFields, ['Anlage']);
  state.target.plant = state.source.plant;
  assert.equal((await markPipedriveFundingDealWonApi(input, dependencies)).verified, true);
  assert.equal(state.writes.length, 2);
});
test('uncertain Won transport result is recovered by reading the same source and target', async () => {
  const { state, input, dependencies } = setup(); state.throwAfterWon = true;
  const result = await markPipedriveFundingDealWonApi(input, dependencies);
  assert.equal(result.pending, true); assert.equal(result.errorCode, 'FUNDING_TECHNICAL_RECHECK');
  state.throwAfterWon = false;
  assert.equal((await markPipedriveFundingDealWonApi(input, dependencies)).fullyVerified, true);
  assert.equal(state.writes.filter(item => item.status === 'won').length, 1);
});
test('ambiguous target or mismatched person/order can never verify the handoff', async () => {
  for (const change of ['duplicate', 'person', 'order']) {
    const { state, input, dependencies } = setup();
    if (change === 'duplicate') state.targets.push({ ...state.targets[0], id: 789 });
    if (change === 'person') state.target.customerPersonId = '88';
    if (change === 'order') state.target.orderNumber = 'OTHER';
    const result = await markPipedriveFundingDealWonApi(input, dependencies);
    assert.equal(result.pending, true); assert.equal(result.targetDealId, null); assert.equal(result.errorCode, 'FUNDING_TARGET_AMBIGUOUS');
    assert.equal(state.writes.length, 2);
  }
});

test('approval receipt filename is enough and independent required-field helper guards writes', async () => {
  const { state, input, dependencies } = setup();
  delete input.approvalFileName;
  assert.equal((await markPipedriveFundingDealWonApi(input, dependencies)).requiredFieldsVerified, true);
  assert.equal(state.writes.length, 2);
});

test('a changed source identity after label removal prevents the Won write', async () => {
  const { state, input, dependencies } = setup();
  const read = dependencies.readSnapshot; let sourceReads=0;
  dependencies.readSnapshot = async id => {
    if (id === '123' && ++sourceReads === 2) state.source.orderNumber = 'OTHER-ORDER';
    return read(id);
  };
  const result = await markPipedriveFundingDealWonApi(input, dependencies);
  assert.equal(result.pending, true); assert.equal(result.errorCode, 'FUNDING_SOURCE_CHANGED');
  assert.deepEqual(state.writes, [{label_ids:[]}]);
});
