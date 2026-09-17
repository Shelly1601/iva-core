import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceCommandPump } from '../local-mac-helper/device-command-pump.mjs';
import { workflowSla } from '../local-mac-helper/workflow-sla.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));
test('urgent claim proceeds while all normal commands remain unresolved', async () => {
  let finish; const blocked = new Promise(resolve => { finish = resolve; }); let urgent = 0, normals = 0;
  const pump = createDeviceCommandPump({ normalConcurrency: 2, run: async ({lane}) => { if (lane === 'urgent') { urgent++; return {}; } normals++; await blocked; } });
  pump.tick(); await flush(); pump.tick(); await flush(); pump.tick(); await flush();
  assert.equal(normals, 2); assert.equal(urgent, 3); assert.equal(pump.snapshot().length, 2);
  finish(); await pump.stop();
});
test('watchdog does not free unresolved writer or repeat its execution', async () => {
  let time = 0, finish, calls = 0; const pending = new Promise(resolve => { finish = resolve; });
  const pump = createDeviceCommandPump({ normalConcurrency: 1, now: () => time, run: async ({lane}) => { if (lane === 'normal') { calls++; await pending; } } });
  pump.tick(); await flush(); time = 300001; pump.tick(); await flush();
  assert.equal(calls, 1); assert.equal(pump.snapshot()[0].slow, true); finish(); await pump.stop();
});
test('recovery cannot reset original result deadline; timeout is not completion', () => {
  const createdAt = '2026-09-17T10:00:00.000Z';
  const state = {createdAt,startedAt:'2026-09-17T11:00:00.000Z',status:'running'};
  const sla = workflowSla(state, Date.parse('2026-09-17T11:01:00Z'));
  assert.equal(sla.deadlineAt,'2026-09-17T10:30:00.000Z'); assert.equal(sla.violated,true); assert.equal(state.status,'running');
});
