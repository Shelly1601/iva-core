import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(os.tmpdir(), 'iva-explicit-resume-'));
process.env.DATA_DIR = directory;
after(() => rm(directory, { recursive: true, force: true }));
const { upsertExternalAgentRun } = await import('../operations/store.js');
const now = Date.now(), origin = new Date(now - 2 * 3600000).toISOString();
const stoppedAt = new Date(now - 1000).toISOString(), resumedAt = new Date(now).toISOString();
let sequence = 0;
async function stoppedFixture(status = 'stopped') {
  const jobId = `resume-fixture-${++sequence}`;
  const stopped = { externalKey: `codex-task:${jobId}`, jobId, projectId: 'iva-core', workflowId: 'build-fixture',
    schedulingKey: 'a'.repeat(64), status, phase: 'user_deferred', recoveryAttempts: 0, createdAt: origin, updatedAt: stoppedAt };
  await upsertExternalAgentRun(stopped);
  return { ...stopped, status: 'running', phase: 'recovering', recoveryAttempts: 1, updatedAt: resumedAt, resumeAuthorized: true };
}

test('explicit same-job resume reopens stopped run without resetting original SLA', async () => {
  const input = await stoppedFixture();
  const resumed = await upsertExternalAgentRun({ ...input, sla: { originAt: resumedAt } });
  assert.equal(resumed.status, 'running'); assert.equal(resumed.phase, 'recovering');
  assert.equal(resumed.recoveryAttempts, 1); assert.equal(resumed.completedAt, '');
  assert.equal(resumed.createdAt, origin); assert.equal(resumed.sla.originAt, origin);
  assert.equal(resumed.sla.violated, true);
});

test('ordinary heartbeats and incomplete authorization cannot reopen stopped runs', async () => {
  for (const patch of [
    { resumeAuthorized: undefined }, { resumeAuthorized: false }, { resumeAuthorized: 'true' },
    { phase: 'running' }, { recoveryAttempts: 0 }, { recoveryAttempts: 1.5 },
    { updatedAt: stoppedAt }, { updatedAt: 'invalid' }, { jobId: 'foreign-job' },
    { projectId: 'foreign-project' }, { workflowId: 'foreign-workflow' },
    { schedulingKey: 'b'.repeat(64) }, { schedulingKey: undefined },
  ]) {
    const input = await stoppedFixture();
    const actual = await upsertExternalAgentRun({ ...input, ...patch });
    assert.equal(actual.status, 'stopped', JSON.stringify(patch));
    assert.equal(actual.recoveryAttempts, 0); assert.equal(actual.updatedAt, stoppedAt);
  }
});

test('explicit resume never reopens completed runs; authorization does not persist for a later stop', async () => {
  const completed = await stoppedFixture('completed');
  assert.equal((await upsertExternalAgentRun(completed)).status, 'completed');
  const input = await stoppedFixture();
  const resumed = await upsertExternalAgentRun(input);
  assert.equal(resumed.resumeAuthorized, undefined);
  const laterStop = new Date(now + 1000).toISOString();
  await upsertExternalAgentRun({ ...input, status: 'stopped', phase: 'cancelled', updatedAt: laterStop, resumeAuthorized: undefined });
  const heartbeat = await upsertExternalAgentRun({ ...input, recoveryAttempts: 2, updatedAt: new Date(now + 2000).toISOString(), resumeAuthorized: undefined });
  assert.equal(heartbeat.status, 'stopped'); assert.equal(heartbeat.phase, 'cancelled');
});
