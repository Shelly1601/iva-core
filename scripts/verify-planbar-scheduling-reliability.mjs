import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildPlanbarSchedulingFollowup, isoWeekRange, mergePlanbarSchedulingProgress, planbarSchedulingKey } from '../operations/customer-scheduling.js';
import { classifyPlanbarSchedulingFailure, schedulingRequestStatus } from '../operations/scheduling-dispatch.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'iva-planbar-reliability-'));
process.env.DATA_DIR = directory;
const { upsertExternalAgentRun } = await import('../operations/store.js');
after(() => rm(directory, { recursive: true, force: true }));
const now = Date.now();
const timestamp = offset => new Date(now + offset).toISOString();
const request = { id: 'fixture-request', jobId: 'fixture-scheduling-job', customerName: 'Fixture Kunde', partnerId: 'heat-hero', partnerPrefix: 'HH', isoYear: 2026, week: 39, createdAt: timestamp(-180000) };
const reservation = { customerId: 'fixture-customer', appointmentId: 'fixture-appointment', resourceId: 'fixture-resource', resourceName: 'Fixture Team', isoYear: 2026, week: 39, ...isoWeekRange(2026, 39), verified: true, identityVerified: true, verifiedAt: timestamp(-120000) };
const sourceCheck = { dealId: '12345', partnerId: 'heat-hero', stage: 'Montage einplanen', identityVerified: true, objectLocationMatched: true, planbarRefreshedAt: timestamp(-150000), verifiedAt: timestamp(-120000), customerSegment: 'private', customerSegmentVerified: true, customerSegmentSource: 'Pipedrive: fixture Privatkunden-Zuordnung' };
const reserved = (input = {}) => mergePlanbarSchedulingProgress(null, { status: 'reserved', reservation, ...input });

test('verified reservation persists exact missing data as stable HH follow-up', () => {
  const progress = reserved({ missingDetails: ['Auftragsnummer', 'TMB: Transportbreite fehlt', 'Auftragsnummer'], remainingActions: ['Pipedrive-Abschluss'] });
  const first = buildPlanbarSchedulingFollowup(request, progress);
  const retry = buildPlanbarSchedulingFollowup({ ...request, jobId: 'fixture-new-worker' }, progress);
  assert.equal(first.caseId, retry.caseId);
  assert.equal(first.revision, retry.revision);
  assert.equal(first.schedulingKey, planbarSchedulingKey(request));
  assert.equal(first.appointmentId, reservation.appointmentId);
  assert.equal(first.jobId, request.jobId);
  assert.deepEqual(first.missingDetails, ['Auftragsnummer', 'TMB: Transportbreite fehlt']);
  assert.deepEqual(first.remainingActions, ['Pipedrive-Abschluss']);
  assert.equal(first.status, 'pending');
  assert.equal(first.customerSegment, 'unknown');
  assert.equal(first.requiresPrivateCustomerCheck, true);
  const changed = buildPlanbarSchedulingFollowup(request, mergePlanbarSchedulingProgress(progress, { status: 'details_pending', missingDetails: ['TMB: Transportbreite fehlt'] }));
  assert.equal(changed.caseId, first.caseId);
  assert.notEqual(changed.revision, first.revision);
});

test('public or private-segment input cannot invent a verified source classification', () => {
  assert.equal(buildPlanbarSchedulingFollowup({ ...request, customerSegment: 'private', customerSegmentVerified: true }, reserved()).requiresPrivateCustomerCheck, true);
  assert.equal(buildPlanbarSchedulingFollowup(request, reserved({ sourceCheck: { ...sourceCheck, customerSegmentVerified: false } })).customerSegment, 'unknown');
  const observed = buildPlanbarSchedulingFollowup(request, reserved({ sourceCheck }));
  assert.equal(observed.customerSegment, 'private');
  assert.equal(observed.requiresPrivateCustomerCheck, false);
  assert.equal(observed.sourceCheck.customerSegmentSource, sourceCheck.customerSegmentSource);
});

test('other partners, confirmed businesses and absent receipts do not enter pure HH queue', () => {
  for (const partner of [{ partnerId: 'enter', partnerPrefix: 'EN' }, { partnerId: 'd-warmte', partnerPrefix: 'DW' }, { partnerId: 'heat-hero', partnerPrefix: 'EN' }]) assert.equal(buildPlanbarSchedulingFollowup({ ...request, ...partner }, reserved()), null);
  assert.equal(buildPlanbarSchedulingFollowup(request, reserved({ sourceCheck: { ...sourceCheck, customerSegment: 'business' } })), null);
  assert.equal(buildPlanbarSchedulingFollowup(request, null), null);
  assert.throws(() => buildPlanbarSchedulingFollowup({ ...request, week: 40 }, reserved()), /Kalenderwoche/);
  assert.throws(() => buildPlanbarSchedulingFollowup(request, { ...reserved(), reservation: { ...reservation, identityVerified: false } }), /Reservierungsnachweis/);
});

test('open follow-up is never completed by process status or missing descriptions', () => {
  const pending = reserved({ missingDetails: [], remainingActions: ['WhatsApp-Bestätigung'] });
  assert.equal(buildPlanbarSchedulingFollowup({ ...request, status: 'completed' }, pending).status, 'pending');
  assert.throws(() => buildPlanbarSchedulingFollowup(request, { ...pending, status: 'completed', completionVerified: true }), /Offene/);
  const complete = mergePlanbarSchedulingProgress(pending, { status: 'completed', missingDetails: [], remainingActions: [], completionVerified: true });
  assert.equal(buildPlanbarSchedulingFollowup(request, complete).status, 'completed');
});

test('later reservation readback preserves original time and existing mail evidence', () => {
  const mail = { messageId: 'fixture-mail', from: 'n.sell@heat-hero.com', recipientHash: 'a'.repeat(64), sentAt: timestamp(-60000), verified: true };
  const sent = mergePlanbarSchedulingProgress(reserved(), { status: 'details_pending', confirmationMail: mail });
  const reread = mergePlanbarSchedulingProgress(sent, { status: 'details_pending', reservation: { ...reservation, verifiedAt: timestamp(-30000) } });
  assert.equal(reread.reservation.firstVerifiedAt, reservation.verifiedAt);
  assert.equal(reread.reservation.verifiedAt, timestamp(-30000));
  assert.deepEqual(reread.confirmationMail, mail);
  assert.throws(() => mergePlanbarSchedulingProgress(reserved(), { status: 'details_pending', confirmationMail: { ...mail, sentAt: timestamp(-150000) } }), /Mailnachweis/);
  assert.throws(() => reserved({ reservation: { ...reservation, firstVerifiedAt: timestamp(-60000) } }), /zeitlich ungültig/);
});

test('technical errors remain open with explicit readback requirement, no fake booking', () => {
  for (const error of ['Browser-Tab nicht erreichbar', 'Worker unterbrochen', 'Speichern unklar', 'ECONNRESET']) {
    const run = { schedulingKey: planbarSchedulingKey(request), status: 'blocked', error };
    const view = schedulingRequestStatus(request, [run]);
    assert.equal(classifyPlanbarSchedulingFailure(run), 'recoverable_technical');
    assert.equal(view.status, 'retrying');
    assert.equal(view.requiresTargetReadback, true);
    assert.equal(view.planbarProgress, null);
    assert.match(view.schedulingSummary, /offen/);
  }
  const recovering = schedulingRequestStatus(request, [{ schedulingKey: planbarSchedulingKey(request), status: 'running', phase: 'recovering' }]);
  assert.equal(recovering.status, 'retrying');
  assert.match(recovering.schedulingSummary, /vorgemerkt/);
});

test('identity/capacity and external account gates are preserved', () => {
  for (const error of ['Kunde nicht eindeutig', 'Keine zulässige Ressource vollständig frei']) assert.equal(classifyPlanbarSchedulingFailure({ status: 'blocked', error }), 'business');
  assert.equal(classifyPlanbarSchedulingFailure({ status: 'blocked', error: 'CAPTCHA im Browser verlangt' }), 'external');
  assert.equal(classifyPlanbarSchedulingFailure({ status: 'stopped', error: 'Browser-Fehler' }), 'cancelled');
  assert.equal(schedulingRequestStatus(request, [{ schedulingKey: planbarSchedulingKey(request), status: 'completed' }]).status, 'incomplete');
});

test('reserved appointment stays visible after technical follow-up failure', () => {
  const view = schedulingRequestStatus(request, [{ schedulingKey: planbarSchedulingKey(request), jobId: request.jobId, status: 'failed', error: 'Browser timeout', planbarProgress: reserved() }]);
  assert.equal(view.status, 'reserved');
  assert.equal(view.schedulingFollowup.appointmentId, reservation.appointmentId);
  assert.equal(view.schedulingFollowup.jobId, request.jobId);
});

let serial = 0;
async function terminalRun(extra = {}) {
  const input = { externalKey: `fixture-recovery-${++serial}`, jobId: `fixture-job-${serial}`, projectId: 'heat-hero', workflowId: '', schedulingKey: planbarSchedulingKey(request), status: 'failed', recoveryAttempts: 1, updatedAt: timestamp(-10000), ...extra };
  await upsertExternalAgentRun(input);
  return input;
}
const resume = original => ({ ...original, status: 'queued', phase: 'recovering', recoveryAttempts: 2, updatedAt: timestamp(-5000) });

test('a verified later recovery reopens the same failed job and persists retry count', async () => {
  for (const status of ['failed', 'blocked', 'timed_out', 'incomplete']) {
    const original = await terminalRun({ status, planbarProgress: reserved() });
    const recovered = await upsertExternalAgentRun(resume(original));
    assert.equal(recovered.status, 'queued');
    assert.equal(recovered.recoveryAttempts, 2);
    assert.equal(recovered.planbarProgress.reservation.appointmentId, reservation.appointmentId);
    assert.equal(recovered.completedAt, '');
    assert.equal(recovered.error, '');
    const heartbeat = await upsertExternalAgentRun({ ...resume(original), status: 'running', phase: 'executing', updatedAt: timestamp(-4000) });
    assert.equal(heartbeat.status, 'running');
    assert.equal(heartbeat.recoveryAttempts, 2);
  }
});

test('stale, repeated, unbound, conflicting and non-recovery updates cannot reopen jobs', async () => {
  for (const override of [
    { updatedAt: timestamp(-10000) }, { updatedAt: timestamp(-15000) }, { updatedAt: undefined },
    { recoveryAttempts: 1 }, { recoveryAttempts: -1 }, { recoveryAttempts: '2' },
    { phase: 'executing' }, { jobId: 'other-job' }, { jobId: '' },
    { projectId: 'other-project' }, { workflowId: 'other-workflow' }, { schedulingKey: 'b'.repeat(64) },
    { planbarProgress: { ...reserved(), reservation: { ...reservation, appointmentId: 'other-appointment' } } },
  ]) {
    const original = await terminalRun({ planbarProgress: reserved() });
    const result = await upsertExternalAgentRun({ ...resume(original), ...override });
    assert.equal(result.status, 'failed', JSON.stringify(override));
    assert.equal(result.recoveryAttempts, 1);
    assert.equal(result.planbarProgress.reservation.appointmentId, reservation.appointmentId);
  }
});

test('completed and manually stopped jobs never reopen, even with fresh recovery marker', async () => {
  for (const status of ['completed', 'stopped']) {
    const original = await terminalRun({ status });
    assert.equal((await upsertExternalAgentRun(resume(original))).status, status);
  }
});

test('general workflow recovery is bound to project and workflow even without scheduling key', async () => {
  const original = await terminalRun({ schedulingKey: '', workflowId: 'fixture-workflow' });
  assert.equal((await upsertExternalAgentRun({ ...resume(original), workflowId: 'different' })).status, 'failed');
  assert.equal((await upsertExternalAgentRun(resume(original))).status, 'queued');
});
