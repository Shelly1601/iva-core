import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';

const root = await mkdtemp(path.join(os.tmpdir(), 'iva-control-activity-'));
process.env.DATA_DIR = root;

try {
  const { listAgentRuns, upsertExternalAgentRun } = await import('../operations/store.js');
  const { buildControlActivityFeed, buildProjectWorkflowOverview } = await import('../operations/activity-feed.js');
  const { buildJobsNeedingRefresh, buildProgressSnapshot } = await import('../operations/build-progress.js');

  const first = await upsertExternalAgentRun({
    externalKey: 'codex-direct:test', jobId: '11111111-1111-4111-8111-111111111111',
    agentId: 'iva-codex-direct', taskTitle: 'Kontrollzentrum vervollständigen', channel: 'codex-build',
    source: 'Codex Desktop', status: 'running', phase: 'testing', progress: 50,
    startedAt: '2026-08-26T08:00:00.000Z', updatedAt: '2026-08-26T08:10:00.000Z', detail: 'Tests laufen.',
  });
  const updated = await upsertExternalAgentRun({
    externalKey: 'codex-direct:test', jobId: first.jobId, taskTitle: first.taskTitle,
    channel: 'codex-build', source: 'Codex Desktop', status: 'completed', phase: 'completed', progress: 100,
    startedAt: first.startedAt, completedAt: '2026-08-26T08:20:00.000Z', updatedAt: '2026-08-26T08:20:00.000Z',
    resultPreview: 'Live geprüft.', proofs: ['Railway live'],
  });
  const stored = await listAgentRuns({ limit: 10 });
  assert.equal(stored.length, 1);
  assert.equal(updated.id, first.id);
  assert.equal(stored[0].status, 'completed');
  assert.equal(stored[0].progress, 100);

  const workflowCommand = {
    id: 'workflow-command', action: 'project.workflow.run', status: 'completed',
    requestText: 'Planbar-Forecast manuell auslösen',
    payload: { projectId: 'heat-hero', workflowId: 'planbar-weekly-export', displayName: 'Planbar-Forecast als Excel-Listen' },
    result: { jobId: '22222222-2222-4222-8222-222222222222' },
    createdAt: '2026-08-26T09:00:00.000Z', completedAt: '2026-08-26T09:01:00.000Z',
  };
  const workflowStatus = {
    id: 'workflow-status', action: 'codex.task.status', status: 'completed',
    payload: { jobId: workflowCommand.result.jobId },
    result: { status: 'running', phase: 'running', progress: 5, detail: 'Planbar wird ausgelesen.', updatedAt: '2026-08-26T09:02:00.000Z' },
    createdAt: '2026-08-26T09:02:00.000Z', completedAt: '2026-08-26T09:02:01.000Z',
  };
  const project = {
    id: 'heat-hero', name: 'Heat Hero',
    automations: [{ id: 'planbar-weekly-export', name: 'Planbar-Forecast als Excel-Listen', status: 'active', enabled: true, schedule: 'Freitag · 19:00 Uhr', execution: 'iMac', purpose: 'Forecast an Angelo' }],
    runLog: [{
      id: 'planbar-2026-08-23-kw36-45', automationId: 'planbar-weekly-export', executedAt: '2026-08-23T09:59:00.000Z',
      status: 'sent-and-verified', scope: 'KW 36–45 / 2026', attachmentCount: 8,
      summary: 'Forecast an Angelo gesendet und im Gesendet-Ordner verifiziert.',
    }],
  };
  const activity = buildControlActivityFeed({
    agentRuns: stored,
    automationRuns: [{ id: 'automation-1', automationId: 'daily-briefing', automationName: 'IVA Morning-Briefing', status: 'completed', summary: 'Telegram zugestellt.', startedAt: '2026-08-26T05:00:00.000Z', completedAt: '2026-08-26T05:00:02.000Z' }],
    deviceCommands: [workflowCommand, workflowStatus],
    projects: [project],
  });
  assert.ok(activity.some(item => item.source === 'Codex Desktop' && item.status === 'completed'));
  assert.ok(activity.some(item => item.name === 'IVA Morning-Briefing'));
  assert.ok(activity.some(item => /Angelo/.test(item.summary) && item.proofs.includes('Im Gesendet-Ordner verifiziert')));
  assert.ok(activity.some(item => item.workflowId === 'planbar-weekly-export' && item.status === 'running'));

  const workflows = buildProjectWorkflowOverview([project], activity);
  assert.equal(workflows[0].lastRun.status, 'running');
  assert.match(workflows[0].lastRun.summary, /Planbar wird ausgelesen/);
  assert.equal(workflows[0].lastSuccessfulRun.status, 'completed');
  assert.match(workflows[0].lastSuccessfulRun.summary, /Angelo/);
  assert.equal(workflows[0].recentRuns.length, 2);

  const progress = buildProgressSnapshot({ operationRuns: [{
    id: 'direct-running', taskTitle: 'Direkter Bau', agentName: 'Direkter Bau', channel: 'codex-build', source: 'Codex Desktop', status: 'running', phase: 'testing', progress: 50, createdAt: '2026-08-26T10:00:00.000Z', updatedAt: '2026-08-26T10:05:00.000Z', resultPreview: 'Tests laufen.',
  }] });
  assert.equal(progress.active.length, 1);
  assert.equal(progress.active[0].phaseLabel, 'Tests');

  const refresh = buildJobsNeedingRefresh({
    commands: [workflowCommand, workflowStatus],
    now: Date.parse('2026-08-26T09:03:00.000Z'), minAgeMs: 20_000,
  });
  assert.deepEqual(refresh.map(item => item.jobId), [workflowCommand.result.jobId]);

  const [html, browserJs] = await Promise.all([
    readFile(new URL('../public/control.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/control.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="projectWorkflows"/);
  assert.match(html, /Letzte echte Läufe &amp; Befehle|Letzte echte Läufe & Befehle/);
  assert.match(browserJs, /state\.status\.activity/);
  assert.match(browserJs, /Im Gesendet-Ordner verifiziert|proofs/);
  assert.match(browserJs, /Letzter erfolgreicher Nachweis/);

  console.log('PASS Kontrollzentrum-Aktivität: echte Bau-, iMac-, Projekt- und Automationsläufe mit Status, Ergebnis und Angelo-Beleg.');
} finally {
  await rm(root, { recursive: true, force: true });
}
