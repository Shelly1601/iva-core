import assert from 'node:assert/strict';
import { createPlanbarForecastAutomationHandler, createProjectWorkflowAutomationHandler } from '../automations/imac-workflow.js';

function harness({ projectEnabled = true, online = true, commands = {} } = {}) {
  const queued = [];
  const handler = createPlanbarForecastAutomationHandler({
    getProject: async () => ({ automations: [{ id: 'planbar-weekly-export', enabled: projectEnabled }] }),
    deviceAgentStatus: async () => ({ online, dispatchReady: online }),
    enqueueDeviceCommand: async input => {
      const id = `queued-${queued.length + 1}`;
      queued.push({ id, ...input });
      commands[id] ||= { id, status: 'queued' };
      return commands[id];
    },
    deviceCommandStatus: async id => commands[id] || null,
  });
  return { handler, queued, commands };
}

{
  const { handler, queued } = harness({ online: false });
  const result = await handler({ slotKey: 'forecast:weekly:2026-W35', attempt: 1 });
  assert.equal(result.status, 'waiting');
  assert.equal(queued.length, 0, 'offline iMac must not lose the due slot');
}

{
  const { handler, queued, commands } = harness();
  const result = await handler({ slotKey: 'planbar-weekly-export:weekly:2026-W35', attempt: 1 });
  assert.equal(result.status, 'waiting');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].payload.runMode, 'automatic');
  assert.equal(queued[0].payload.automationSlotKey, 'planbar-weekly-export:weekly:2026-W35');
  assert.equal(commands[queued[0].id].status, 'queued');
}

{
  const { handler } = harness({ projectEnabled: false });
  const result = await handler({ slotKey: 'forecast:weekly:2026-W35', attempt: 1 });
  assert.equal(result.status, 'blocked');
}

{
  const commands = {
    start: { id: 'start', status: 'completed', result: { sent: true, sentFolderVerified: true, period: 'KW 37-46 / 2026', attachmentCount: 8 } },
  };
  const { handler } = harness({ commands });
  const result = await handler({ slotKey: 'forecast:weekly:2026-W35', attempt: 1, previousResult: { commandId: 'start' } });
  assert.equal(result.sentFolderVerified, true);
  assert.match(result.summary, /Gesendet/);
}

{
  const commands = {
    start: { id: 'start', status: 'completed', result: { jobId: '12345678-1234-4234-8234-123456789012' } },
    status: { id: 'status', status: 'completed', result: { status: 'completed', workflowProof: { sentFolderVerified: true, period: 'KW 37-46 / 2026', attachmentCount: 8 } } },
  };
  const { handler } = harness({ commands });
  const result = await handler({ slotKey: 'forecast:weekly:2026-W35', attempt: 1, previousResult: { commandId: 'start', jobId: commands.start.result.jobId, statusCommandId: 'status' } });
  assert.equal(result.sentFolderVerified, true);
}

{
  const commands = {
    start: { id: 'start', status: 'completed', result: { jobId: '12345678-1234-4234-8234-123456789012' } },
    status: { id: 'status', status: 'completed', result: { status: 'incomplete', detail: 'Gesendet-Nachweis fehlt.' } },
  };
  const { handler } = harness({ commands });
  await assert.rejects(
    handler({ slotKey: 'forecast:weekly:2026-W35', attempt: 1, previousResult: { commandId: 'start', jobId: commands.start.result.jobId, statusCommandId: 'status' } }),
    /Gesendet-Nachweis fehlt/,
  );
}

console.log('PASS Planbar-Forecast-Automation verfolgt iMac und Outlook bis zum belegten Endzustand.');

{
  const commands = {
    start: { id: 'start', status: 'completed', result: { jobId: '12345678-1234-4234-8234-123456789012' } },
    status: { id: 'status', status: 'completed', result: { status: 'completed' } },
  };
  const handler = createProjectWorkflowAutomationHandler({
    workflowId: 'planbar-completion-morning',
    displayName: 'Planbar Vervollständigung',
    getProject: async () => ({ automations: [{ id: 'planbar-completion-morning', enabled: true }] }),
    deviceAgentStatus: async () => ({ online: true, dispatchReady: true, allowedActions: ['project.workflow.run', 'codex.task.status'] }),
    enqueueDeviceCommand: async () => { throw new Error('unexpected enqueue'); },
    deviceCommandStatus: async id => commands[id],
  });
  const result = await handler({
    slotKey: 'planbar-completion-morning:daily:2026-08-29',
    attempt: 1,
    previousResult: { commandId: 'start', jobId: commands.start.result.jobId, statusCommandId: 'status' },
  });
  assert.match(result.summary, /vollständig abgeschlossen/);
}

console.log('PASS Wiederkehrende iMac-Projektworkflows bleiben bis zum lokalen Endstatus offen.');

await import('./verify-planbar-forecast-delivery.mjs');
