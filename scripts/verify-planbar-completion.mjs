import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createPlanbarCompletionStore } from '../local-mac-helper/planbar-completion.mjs';
import { isoWeekRange } from '../operations/customer-scheduling.js';

const NOW = Date.now(), at = offset => new Date(NOW + offset).toISOString();
const REQUEST = { jobId: '00000000-0000-4000-8000-000000000001', requestId: 'fixture', planbar: { customerName: 'Fixture Kunde', partnerId: 'heat-hero', partnerPrefix: 'HH', isoYear: 2026, week: 39 } };
const IDENTITY = { customerId: 'customer-1', appointmentId: 'appointment-1', resourceId: 'team-1', resourceName: 'Montage 1', isoYear: 2026, week: 39, ...isoWeekRange(2026, 39) };
const progress = (patch = {}) => ({ status: 'reserved', reservation: { ...IDENTITY, verified: true, identityVerified: true, verifiedAt: at(-30_000) },
  sourceCheck: { dealId: '123', stage: 'Montage einplanen', partnerId: 'heat-hero', identityVerified: true, objectLocationMatched: true, customerSegment: 'private', customerSegmentVerified: true, verifiedAt: at(-40_000) },
  missingDetails: ['Auftragsnummer', 'Leistungsbeschreibung'], remainingActions: ['WhatsApp-Bestätigung'], updatedAt: at(-20_000), ...patch });
const expected = { orderNumber: 'HH-2026-123', description: '10 kW Bosch Compress 5800i AW\nMaterialannahme: Ja', manufacturer: 'Bosch', powerKw: 10, model: 'Compress 5800i AW', variant: '' };
function proof(overrides = {}) {
  return { expected, actual: { ...expected }, readback: { ...IDENTITY, source: 'planbar', identityVerified: true, partnerId: 'heat-hero', customerSegment: 'private', firstName: 'HH Fixture', checkedAt: at(-1000), evidence: 'Termin nach Speichern erneut geöffnet; Felder rückgelesen.' },
    sourceEvidence: Object.keys(expected).filter(k => k !== 'variant').map(field => ({ field, sourceId: 'signed-offer-123', sourceKind: 'signed-offer', evidence: 'Sichtbarer beauftragter Wert im unterschriebenen Dokument.', verified: true, checkedAt: at(-10_000) })),
    missingDetails: [], externalBlockers: [], ...overrides };
}
const begin = (extra = {}) => ({ scope: 'heat-hero-private', refreshedAt: at(-5000), sourceChecks: [{ source: 'planbar', status: 'read', evidence: 'Frischer kompletter Planbar-Bestandsabruf im Auftragsordner.', observedCount: 1, checkedAt: at(-5000) }], ...extra });
async function fixture(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'iva-completion-')); t.after(() => rm(root, { recursive: true, force: true })); return { root, store: createPlanbarCompletionStore({ dataDir: root, tasksDir: path.join(root, 'tasks'), now: () => NOW }) }; }

test('captured reservations survive restart, keep pending details and do not duplicate across job IDs', async t => {
  const { root, store } = await fixture(t); const first = await store.capture(REQUEST, progress());
  assert.equal(first.status, 'pending_details'); assert.equal(first.appointmentId, IDENTITY.appointmentId);
  const reopened = createPlanbarCompletionStore({ dataDir: root, now: () => NOW });
  await reopened.capture({ ...REQUEST, jobId: '00000000-0000-4000-8000-000000000002' }, progress());
  const rows = await reopened.list(); assert.equal(rows.length, 1); assert.equal(rows[0].jobIds.length, 2); assert.equal((await stat(path.join(root, 'planbar-completion.json'))).mode & 0o777, 0o600);
});
test('no receipt, another partner and confirmed business cannot create a completion case', async t => {
  const { store } = await fixture(t);
  assert.equal(await store.capture(REQUEST, {}), null);
  assert.equal(await store.capture({ ...REQUEST, planbar: { ...REQUEST.planbar, partnerId: 'enter', partnerPrefix: 'EN' } }, progress()), null);
  assert.equal(await store.capture(REQUEST, progress({ sourceCheck: { ...progress().sourceCheck, customerSegment: 'business' } })), null);
  assert.equal((await store.list()).length, 0);
});
test('unknown customer segment remains pending and cannot be declared completed by a caller flag', async t => {
  const { store } = await fixture(t); const row = await store.capture(REQUEST, progress({ sourceCheck: null })); assert.equal(row.status, 'scope_pending');
  const output = await store.recordProof(row.caseId, { status: 'completed', completionVerified: true }); assert.equal(output.detailsComplete, false); assert.equal(output.recoveryRequired, true);
  await assert.rejects(store.recordProof(row.caseId, proof({ readback: { ...proof().readback, customerSegment: 'business' } })), { code: 'PLANBAR_COMPLETION_SCOPE' });
});
test('exact verified detail readback completes the case while separate WhatsApp followup remains open', async t => {
  const { store } = await fixture(t); const row = await store.capture(REQUEST, progress());
  const complete = await store.recordProof(row.caseId, proof()); assert.equal(complete.status, 'completed'); assert.equal(complete.detailsComplete, true); assert.equal(complete.externalActionsPending, true); assert.deepEqual(complete.remainingActions, ['WhatsApp-Bestätigung']);
  await store.capture(REQUEST, progress()); assert.equal((await store.get(row.caseId)).status, 'completed');
});
test('order number needs a signed-offer evidence and output identity cannot change', async t => {
  const { store } = await fixture(t); const row = await store.capture(REQUEST, progress());
  const noOffer = await store.recordProof(row.caseId, proof({ sourceEvidence: proof().sourceEvidence.map(x => ({ ...x, sourceKind: 'deal-title' })) })); assert.notEqual(noOffer.status, 'completed'); assert.ok(noOffer.missingDetails.includes('Quellenbeleg: orderNumber'));
  for (const patch of [{ appointmentId: 'other' }, { customerId: 'other' }, { resourceId: 'other' }, { resourceName: 'David Service' }, { week: 40, ...isoWeekRange(2026, 40) }]) await assert.rejects(store.recordProof(row.caseId, proof({ readback: { ...proof().readback, ...patch } })));
  assert.equal((await store.get(row.caseId)).appointmentId, IDENTITY.appointmentId);
});
test('original offer is allowed only after proven complete signed search and exact deal/offer matching', async t => {
  const { store } = await fixture(t); const row = await store.capture(REQUEST, progress());
  const original = { ...proof().sourceEvidence.find(x => x.field === 'orderNumber'), sourceKind: 'original-offer', matchedDealId: '123', matchedOfferNumber: expected.orderNumber, identityVerified: true, signedOfferSearchComplete: true, signedOfferFound: false };
  const input = item => proof({ sourceEvidence: proof().sourceEvidence.map(x => x.field === 'orderNumber' ? item : x) });
  for (const patch of [{ matchedDealId: '999' }, { matchedOfferNumber: 'other' }, { identityVerified: false }, { signedOfferSearchComplete: false }, { signedOfferFound: true }]) assert.notEqual((await store.recordProof(row.caseId, input({ ...original, ...patch }))).status, 'completed');
  assert.equal((await store.recordProof(row.caseId, input(original))).status, 'completed');
});
test('Bosch model, Vaillant variant, kW, HH prefix and preserved notes are required', async t => {
  const { store } = await fixture(t); const row = await store.capture(REQUEST, progress());
  for (const bad of [proof({ expected: { ...expected, model: '' } }), proof({ expected: { ...expected, powerKw: null } }), proof({ preservedNotes: ['Kunde wünscht vorherigen Anruf'] }), proof({ readback: { ...proof().readback, firstName: 'HH HH Fixture' } })]) assert.notEqual((await store.recordProof(row.caseId, bad)).status, 'completed');
  const vaillant = { ...expected, manufacturer: 'Vaillant', model: '', description: '10 kW Vaillant\nKunde wünscht vorherigen Anruf', variant: '' };
  const bad = await store.recordProof(row.caseId, proof({ expected: vaillant, actual: vaillant })); assert.notEqual(bad.status, 'completed');
  const good = { ...vaillant, description: '10 kW Vaillant Plus\nKunde wünscht vorherigen Anruf', variant: 'Plus' };
  const result = await store.recordProof(row.caseId, proof({ expected: good, actual: good, sourceEvidence: [...proof().sourceEvidence, { field: 'variant', sourceId: 'offer', sourceKind: 'signed-offer', evidence: 'Plus sichtbar.', checkedAt: at(-1000), verified: true }] })); assert.equal(result.status, 'completed');
});
test('Ist deviations require recovery and never silently replace the expected value', async t => {
  const { store } = await fixture(t); const row = await store.capture(REQUEST, progress());
  const result = await store.recordProof(row.caseId, proof({ actual: { ...expected, orderNumber: 'wrong' } })); assert.equal(result.status, 'mismatch'); assert.equal(result.recoveryRequired, true); assert.deepEqual(result.differences, ['orderNumber']); assert.equal(result.expected.orderNumber, expected.orderNumber);
});
test('stale or future readbacks are rejected without changing the persisted case', async t => {
  const { store } = await fixture(t); const row = await store.capture(REQUEST, progress());
  for (const checkedAt of [at(-16 * 60_000), at(61_000), 'never']) await assert.rejects(store.recordProof(row.caseId, proof({ readback: { ...proof().readback, checkedAt } })), { code: 'PLANBAR_COMPLETION_TIME' });
  assert.equal((await store.get(row.caseId)).history.length, 0);
});
test('overlong detail values cannot hide a differing suffix through truncation', async t => {
  const { store } = await fixture(t); const row = await store.capture(REQUEST, progress());
  await assert.rejects(store.recordProof(row.caseId, proof({ actual: { ...expected, description: 'x'.repeat(16_001) } })), { code: 'PLANBAR_COMPLETION_DETAILS' });
  const pending = await store.recordProof(row.caseId, proof({ missingDetails: ['Speichertransportweg fachlich noch nicht belegt'] })); assert.equal(pending.status, 'pending_details'); assert.equal(pending.actual.orderNumber, expected.orderNumber);
});
test('manual inventory discovery is restricted to existing private HH identities and deduplicates captures', async t => {
  const { store } = await fixture(t); const row = await store.capture(REQUEST, progress());
  const observed = { identity: IDENTITY, scopeEvidence: { partnerId: 'heat-hero', customerSegment: 'private', identityVerified: true, checkedAt: at(-2000), evidence: 'Privatkundenfeld und passender HH-Termin sichtbar.' } };
  assert.equal((await store.enqueueObservedCase(observed)).caseId, row.caseId); assert.equal((await store.list()).length, 1);
  assert.equal(await store.enqueueObservedCase({ ...observed, scopeEvidence: { ...observed.scopeEvidence, customerSegment: 'business' } }), null);
  await assert.rejects(store.enqueueObservedCase({ ...observed, identity: { ...IDENTITY, appointmentId: '' } }));
});
test('reconciliation imports persisted task receipts but never dispatches or invents a reservation', async t => {
  const { root, store } = await fixture(t); const dir = path.join(root, 'tasks', REQUEST.jobId); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'request.json'), JSON.stringify(REQUEST)); await writeFile(path.join(dir, 'state.json'), JSON.stringify({ planbarProgress: progress() }));
  assert.equal((await store.reconcile()).captured, 1); assert.equal((await store.reconcile()).captured, 1); assert.equal((await store.list()).length, 1);
  await writeFile(path.join(dir, 'planbar-progress.json'), '{broken'); const result = await store.reconcile(); assert.equal(result.captured, 0); assert.equal(result.skipped.length, 1); assert.equal((await store.list()).length, 1);
});
test('concurrent stores preserve all distinct reservations and reject corrupt persistence without overwriting it', async t => {
  const { root, store } = await fixture(t); const other = createPlanbarCompletionStore({ dataDir: root, now: () => NOW });
  await Promise.all(Array.from({ length: 25 }, (_, i) => (i % 2 ? store : other).capture(REQUEST, progress({ reservation: { ...progress().reservation, appointmentId: 'appt-' + i } })))); assert.equal((await store.list()).length, 25);
  await writeFile(path.join(root, 'planbar-completion.json'), '{broken'); await assert.rejects(store.capture(REQUEST, progress()), { code: 'PLANBAR_COMPLETION_STORE' }); assert.equal(await readFile(path.join(root, 'planbar-completion.json'), 'utf8'), '{broken');
});
test('separate worker processes serialize writes to the same durable queue', async t => {
  const { root, store } = await fixture(t);
  const moduleUrl = new URL('../local-mac-helper/planbar-completion.mjs', import.meta.url).href;
  await Promise.all(Array.from({ length: 3 }, (_, worker) => new Promise((resolve, reject) => {
    const code = `import {createPlanbarCompletionStore} from ${JSON.stringify(moduleUrl)}; const store=createPlanbarCompletionStore({dataDir:${JSON.stringify(root)}}); const request=${JSON.stringify(REQUEST)}; const base=${JSON.stringify(progress())}; for(let n=0;n<8;n++) await store.capture(request,{...base,reservation:{...base.reservation,appointmentId:'worker-${worker}-'+n}});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] }); let error = ''; child.stderr.on('data', part => { error += part; }); child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(error)));
  })));
  assert.equal((await store.list()).length, 24);
});
test('empty inventory needs a fresh observed Planbar proof and a final readback before success', async t => {
  const { store } = await fixture(t);
  await store.beginRun('empty', begin({ sourceChecks: [{ source: 'planbar', status: 'read' }] })); let result = await store.finishRun('empty', { checkedCaseIds: [], inventoryComplete: true, finalReadbackStartedAt: at(-1500), finalReadbackAt: at(-100) }); assert.equal(result.status, 'partial'); assert.equal(result.retryRequired, true);
  await store.beginRun('empty-verified', begin({ sourceChecks: [{ ...begin().sourceChecks[0], observedCount: 0 }] }));
  result = await store.finishRun('empty-verified', { checkedCaseIds: [], inventoryComplete: true, finalReadbackStartedAt: at(-1500), finalReadbackAt: at(-100) }); assert.equal(result.status, 'completed'); assert.equal(result.protocol, 2); assert.equal(result.scope, 'heat-hero-private'); assert.equal(result.checked, 0); assert.equal(result.retryRequired, false);
  await store.beginRun('hidden-case', begin()); result = await store.finishRun('hidden-case', { checkedCaseIds: [], inventoryComplete: true, finalReadbackStartedAt: at(-1500), finalReadbackAt: at(-100) }); assert.equal(result.status, 'partial'); assert.equal(result.inventoryAccountedFor, false);
});
test('locked Planbar records an external partial proof without pretending to refresh or looping recovery', async t => {
  const { store } = await fixture(t); await store.beginRun('locked', { scope: 'heat-hero-private', refreshedAt: null, sourceChecks: [{ source: 'planbar', status: 'blocked', external: true, reason: 'macOS verlangt Freigabe.' }] });
  const result = await store.finishRun('locked', { inventoryComplete: false, finalReadbackAt: null }); assert.equal(result.status, 'partial'); assert.equal(result.retryRequired, false); assert.equal(result.refreshedAt, null);
});
test('WhatsApp QR affects only its source status; an independent HH case still completes', async t => {
  const { store } = await fixture(t); const row = await store.capture(REQUEST, progress());
  await store.beginRun('whatsapp', begin({ sourceChecks: [...begin().sourceChecks, { source: 'whatsapp', status: 'unavailable', external: true, reason: 'QR-Geräteverknüpfung erforderlich.' }] }));
  await store.recordProof(row.caseId, proof()); const result = await store.finishRun('whatsapp', { checkedCaseIds: [row.caseId], inventoryComplete: true, finalReadbackStartedAt: at(-1500), finalReadbackAt: at(-100) }); assert.equal(result.completed, 1); assert.equal(result.status, 'partial'); assert.equal(result.retryRequired, false); assert.equal((await store.get(row.caseId)).status, 'completed');
});
test('omitted queue cases, unchecked inventory and stale case receipts cannot complete a daily run', async t => {
  const { store } = await fixture(t); const row = await store.capture(REQUEST, progress());
  await store.beginRun('missing', begin()); let result = await store.finishRun('missing', { checkedCaseIds: [], inventoryComplete: true, finalReadbackStartedAt: at(-1500), finalReadbackAt: at(-100) }); assert.equal(result.status, 'partial'); assert.equal(result.retryRequired, true); assert.deepEqual(result.omittedCaseIds, [row.caseId]);
  await store.recordProof(row.caseId, proof({ readback: { ...proof().readback, checkedAt: at(-10_000) } }));
  await store.beginRun('stale', begin()); result = await store.finishRun('stale', { checkedCaseIds: [row.caseId], inventoryComplete: true, finalReadbackStartedAt: at(-1500), finalReadbackAt: at(-100) }); assert.equal(result.status, 'partial'); assert.deepEqual(result.staleCaseIds, [row.caseId]);
});
test('a fresh final timestamp cannot pass off an earlier editing readback as the second review', async t => {
  const { store } = await fixture(t); const row = await store.capture(REQUEST, progress()); await store.beginRun('second-round', begin());
  await store.recordProof(row.caseId, proof({ readback: { ...proof().readback, checkedAt: at(-3000) } }));
  const result = await store.finishRun('second-round', { checkedCaseIds: [row.caseId], inventoryComplete: true, finalReadbackStartedAt: at(-1500), finalReadbackAt: at(-100) });
  assert.equal(result.status, 'partial'); assert.equal(result.retryRequired, true); assert.deepEqual(result.staleCaseIds, [row.caseId]);
});
test('external per-case blockers remain separate from technical recovery and cannot mark a run successful', async t => {
  const { store } = await fixture(t); const row = await store.capture(REQUEST, progress()); await store.beginRun('external', begin());
  const blocked = await store.recordProof(row.caseId, { missingDetails: ['Unterschriebenes Angebot fehlt'], externalBlockers: [{ external: true, system: 'documents', code: 'OFFER_MISSING', reason: 'Angefragtes unterschriebenes Angebot ist noch nicht vorhanden.' }] }); assert.equal(blocked.status, 'external_blocked'); assert.equal(blocked.recoveryRequired, false);
  const result = await store.finishRun('external', { checkedCaseIds: [row.caseId], inventoryComplete: true, finalReadbackStartedAt: at(-1500), finalReadbackAt: at(-100) }); assert.equal(result.status, 'partial'); assert.equal(result.retryRequired, false);
});
test('freshness and scope checks reject unsafe run creation and missing run references', async t => {
  const { store } = await fixture(t); for (const input of [begin({ scope: 'all' }), begin({ refreshedAt: at(-6 * 60_000) }), begin({ refreshedAt: at(70_000) })]) await assert.rejects(store.beginRun('invalid', input));
  await assert.rejects(store.getRun('../escape')); await assert.rejects(store.finishRun('not-started', { inventoryComplete: true, finalReadbackAt: at(0) }));
});
