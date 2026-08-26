import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

const root = await mkdtemp(path.join(os.tmpdir(), 'iva-build-progress-'));
process.env.IVA_CODEX_TASK_ROOT = root;

try {
  const { buildJobsNeedingRefresh, buildProgressSnapshot } = await import('../operations/build-progress.js');
  const request = {
    id: 'request-1', title: 'Kontrollzentrum erweitern', desiredOutcome: 'Fortschritt sichtbar machen',
    status: 'dispatched', commandId: 'command-start', createdAt: '2026-08-25T08:00:00.000Z', updatedAt: '2026-08-25T08:01:00.000Z',
  };
  const start = {
    id: 'command-start', action: 'codex.task.start', status: 'completed',
    payload: { requestId: request.id }, result: { jobId: '11111111-1111-4111-8111-111111111111' },
    createdAt: '2026-08-25T08:01:00.000Z', completedAt: '2026-08-25T08:02:00.000Z',
  };
  const status = {
    id: 'command-status', action: 'codex.task.status', status: 'completed',
    payload: { jobId: start.result.jobId },
    result: { status: 'running', phase: 'testing', progress: 50, detail: 'Automatisierte Tests laufen.', updatedAt: '2026-08-25T08:10:00.000Z' },
    createdAt: '2026-08-25T08:09:00.000Z', completedAt: '2026-08-25T08:10:00.000Z',
  };
  let snapshot = buildProgressSnapshot({ requests: [request], commands: [start, status] });
  assert.equal(snapshot.active.length, 1);
  assert.equal(snapshot.active[0].phaseLabel, 'Tests');
  assert.equal(snapshot.active[0].progress, 50);
  assert.equal(snapshot.active[0].steps.find(step => step.id === 'testing').state, 'current');
  assert.equal(snapshot.active[0].steps.find(step => step.id === 'implementing').state, 'completed');

  const refresh = buildJobsNeedingRefresh({ requests: [request], commands: [start, status], now: Date.parse('2026-08-25T08:11:00.000Z') });
  assert.deepEqual(refresh.map(item => item.jobId), [start.result.jobId]);
  const noDuplicateRefresh = buildJobsNeedingRefresh({ requests: [request], commands: [start, { ...status, status: 'queued' }], now: Date.parse('2026-08-25T08:11:00.000Z') });
  assert.equal(noDuplicateRefresh.length, 0);

  const completedCommand = {
    ...status,
    id: 'command-completed',
    result: { status: 'completed', phase: 'completed', progress: 100, resultPreview: 'Live geprüft.', completedAt: '2026-08-25T08:20:00.000Z', updatedAt: '2026-08-25T08:20:00.000Z' },
    createdAt: '2026-08-25T08:19:00.000Z', completedAt: '2026-08-25T08:20:00.000Z',
  };
  snapshot = buildProgressSnapshot({ requests: [request], commands: [start, status, completedCommand] });
  assert.equal(snapshot.recent.length, 1);
  assert.equal(snapshot.latestImplementation.title, request.title);
  assert.equal(snapshot.latestImplementation.progress, 100);
  assert.equal(buildJobsNeedingRefresh({ requests: [request], commands: [start, completedCommand], now: Date.now() }).length, 0);

  const blockedCommand = {
    ...status,
    id: 'command-blocked',
    result: { status: 'blocked', phase: 'deploying', progress: 88, detail: 'Railway-Konto gesperrt.', updatedAt: '2026-08-25T08:30:00.000Z' },
    createdAt: '2026-08-25T08:29:00.000Z', completedAt: '2026-08-25T08:30:00.000Z',
  };
  snapshot = buildProgressSnapshot({ requests: [request], commands: [start, blockedCommand] });
  assert.equal(snapshot.blocked.length, 1);
  assert.match(snapshot.blocked[0].blocker, /Railway/);

  const jobId = '22222222-2222-4222-8222-222222222222';
  const jobDirectory = path.join(root, jobId);
  await mkdir(jobDirectory, { recursive: true });
  await writeFile(path.join(jobDirectory, 'state.json'), JSON.stringify({ jobId, status: 'running', phase: 'planning', progress: 10 }));
  const { getCodexTaskStatus, updateCodexTaskProgress } = await import('../local-mac-helper/codex-tasks.mjs');
  await updateCodexTaskProgress(jobId, 'implementing', 'Frontend wird umgesetzt.');
  let localStatus = await getCodexTaskStatus(jobId);
  assert.equal(localStatus.progress, 30);
  assert.equal(localStatus.detail, 'Frontend wird umgesetzt.');
  await assert.rejects(updateCodexTaskProgress(jobId, 'planning'), /nicht zurückgesetzt/);
  await updateCodexTaskProgress(jobId, 'blocked', 'Externe Bestätigung fehlt.');
  localStatus = await getCodexTaskStatus(jobId);
  assert.equal(localStatus.status, 'blocked');
  assert.match(localStatus.error, /Bestätigung/);

  const [html, browserJs] = await Promise.all([
    readFile(new URL('../public/control.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/control.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="currentBuilds"/);
  assert.match(html, /id="latestImplementation"/);
  assert.match(browserJs, /setInterval\(.*10000/);
  assert.match(browserJs, /role="progressbar"/);

  console.log('PASS IVA-Baufortschritt: echte Meilensteine, Polling, Blocker, letzte Umsetzung und responsive Kontrollzentrum-Anzeige.');
} finally {
  await rm(root, { recursive: true, force: true });
}
