import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { tool } from 'ai';
import { z } from 'zod';
import { createSpecialistRunner } from '../core/specialists.js';
import { specialistSkill, specialistSkillMeta } from '../skills/specialists.js';

const agents = [
  { id: 'iva-customer', name: 'Kunden', enabled: true, rolePrompt: 'Prüfe Kundenquellen.', modelProfile: 'customer' },
  { id: 'iva-finance', name: 'Finanzen', enabled: true, rolePrompt: 'Prüfe Finanzquellen.', modelProfile: 'finance' },
  { id: 'iva-off', name: 'Aus', enabled: false },
];
const tasks = [{ agentId: 'iva-customer', task: 'Prüfe die Kundendaten.' }, { agentId: 'iva-finance', task: 'Prüfe die Finanzdaten.' }];
const usage = { promptTokens: 30, completionTokens: 10, totalTokens: 40 };
const settle = () => delay(0);
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

function harness(overrides = {}) {
  const started = [], ended = [], charged = [], toolCalls = [];
  const runner = createSpecialistRunner({
    getAgent: id => agents.find(item => item.id === id) || agents[0], listAgents: () => agents,
    assembleReadTools: (agent, options) => {
      assert.equal(options.readOnly, true); assert.equal(options.allowDelegation, false);
      return { [`read_${agent.modelProfile}`]: { ...tool({ description: 'Liest verifizierte Daten.', parameters: z.object({ id: z.string() }), execute: async (input, execution) => { assert.ok(execution.abortSignal); toolCalls.push({ agentId: agent.id, input }); return { source: agent.id, value: 12 }; } }), readOnly: true } };
    },
    generate: async input => {
      assert.equal(input.maxSteps, 4); assert.equal(input.maxTokens, 1600); assert.equal(input.maxRetries, 0);
      const name = Object.keys(input.tools)[0];
      await input.tools[name].execute({ id: 'sample' }, {});
      return { text: `Geprüft durch ${name}; Quelle vorhanden.`, usage };
    },
    choose: ({ task }) => ({ key: `test:${task}`, model: { id: task } }), check: async () => {},
    record: async (model, data) => charged.push({ model: model.key, usage: data }),
    begin: async input => { const value = { ...input, id: `run-${started.length + 1}` }; started.push(value); return value; },
    finish: async (id, input) => { ended.push({ id, ...input }); return { id, ...input }; },
    ...overrides,
  });
  return { runner, started, ended, charged, toolCalls };
}

test('separate model/tool runs preserve roles, source identity, parent relation and usage', async () => {
  const prompts = [];
  const h = harness({ generate: async input => {
    prompts.push(input);
    const name = Object.keys(input.tools)[0];
    assert.equal(Object.keys(input.tools).length, 1);
    await input.tools[name].execute({ id: 'item' }, {});
    return { text: `Ergebnis mit Quelle ${name}.`, usage };
  } });
  const output = await h.runner.run({ tasks, context: 'x'.repeat(9000), parentRunId: 'parent-123' });
  assert.equal(output.status, 'completed'); assert.equal(prompts.length, 2);
  assert.notEqual(prompts[0].model.id, prompts[1].model.id);
  assert.match(prompts[0].system, /Prüfe Kundenquellen/); assert.match(prompts[1].system, /Prüfe Finanzquellen/);
  assert.equal(JSON.parse(prompts[0].prompt).context.length, 5000);
  assert.equal(h.started.length, 2); assert.equal(h.ended.length, 2); assert.equal(h.charged.length, 2);
  assert.ok(h.started.every(item => item.routeReason === 'specialist parent:parent-123'));
  assert.ok(h.ended.every(item => item.status === 'completed'));
  assert.deepEqual(output.results.map(item => item.toolNames), [['read_customer'], ['read_finance']]);
  assert.deepEqual(output.results.map(item => item.usage.totalTokens), [40, 40]);
  assert.equal(h.runner.status().active, 0);
});

test('unknown/disabled agent IDs and excess tasks cannot fall back or start work', async () => {
  const h = harness();
  for (const agentId of ['missing', 'iva-off', 'constructor']) await assert.rejects(() => h.runner.run({ tasks: [{ agentId, task: 'Prüfen' }] }));
  await assert.rejects(() => h.runner.run({ tasks: [...tasks, ...tasks] }));
  await assert.rejects(() => h.runner.run({ tasks: [{ ...tasks[0], task: ' ' }] }));
  assert.equal(h.started.length, 0);
});

test('unlabelled tools and recursive/generic dispatch are rejected before model execution', async () => {
  let generations = 0;
  for (const [name, readOnly] of [['updateCustomer', false], ['delegateIvaTasks', true], ['executeIvaTool', true], ['runTaskOnImac', true]]) {
    const h = harness({ assembleReadTools: () => ({ [name]: { readOnly, execute: async () => { throw new Error('Must not run'); } } }), generate: async () => { generations++; } });
    const result = await h.runner.run({ tasks: [tasks[0]] });
    assert.equal(result.results[0].code, 'specialist_tools_not_read_only');
    assert.equal(h.ended[0].status, 'failed');
  }
  assert.equal(generations, 0);
});

test('tool errors are isolated, sanitized and never stored as completed', async () => {
  const h = harness({ assembleReadTools: agent => ({ readData: { readOnly: true, execute: async () => {
    if (agent.id === 'iva-finance') throw new Error('Secret API credential value');
    return { ok: true, source: 'original' };
  } } }) });
  const output = await h.runner.run({ tasks });
  assert.equal(output.status, 'partial');
  assert.deepEqual(output.results.map(item => item.status), ['completed', 'failed']);
  assert.equal(output.results[1].code, 'specialist_tool_failed');
  assert.doesNotMatch(JSON.stringify({ output, ended: h.ended }), /Secret API/);
  assert.equal(h.ended.filter(item => item.status === 'completed').length, 1);
});

test('structured tool failure and empty model output cannot masquerade as success', async () => {
  const h = harness({ assembleReadTools: () => ({ readData: { readOnly: true, execute: async () => ({ ok: false, error: 'sensitive response' }) } }) });
  const output = await h.runner.run({ tasks: [tasks[0]] });
  assert.equal(output.results[0].code, 'specialist_tool_failed');
  const empty = harness({ generate: async () => ({ text: ' ', usage }) });
  assert.equal((await empty.runner.run({ tasks: [tasks[0]] })).results[0].code, 'specialist_empty_result');
  assert.equal(empty.charged.length, 1);
});

test('only two workers execute in parallel, and the third gets a real independent run', async () => {
  let active = 0, maxActive = 0;
  const h = harness({ generate: async () => { active++; maxActive = Math.max(maxActive, active); await delay(15); active--; return { text: 'Ergebnis.', usage }; } });
  const output = await h.runner.run({ tasks: [...tasks, tasks[0]] });
  assert.equal(maxActive, 2); assert.equal(h.started.length, 3); assert.equal(output.results.length, 3);
  assert.equal(output.status, 'completed');
});

test('global worker limit applies across independent runner instances', async () => {
  const gates = [];
  const create = () => harness({ generate: async () => { const gate = deferred(); gates.push(gate); await gate.promise; return { text: 'Ergebnis.', usage }; } });
  const a = create(), b = create(), c = create();
  const first = a.runner.run({ tasks }), second = b.runner.run({ tasks });
  await settle();
  assert.equal(gates.length, 4); assert.equal(c.runner.status().globalActive, 4);
  const refused = await c.runner.run({ tasks: [tasks[0]] });
  assert.equal(refused.results[0].code, 'specialist_busy'); assert.equal(c.started.length, 0);
  gates.forEach(gate => gate.resolve());
  await Promise.all([first, second]); await settle();
  assert.equal(c.runner.status().globalActive, 0);
});

test('cancellation before work prevents starts and during work cancels child SDK calls', async () => {
  const already = new AbortController(); already.abort();
  const h = harness();
  assert.equal((await h.runner.run({ tasks, abortSignal: already.signal })).status, 'aborted');
  assert.equal(h.started.length, 0);
  const controller = new AbortController();
  let signals = [];
  const running = harness({ generate: input => new Promise((resolve, reject) => {
    signals.push(input.abortSignal);
    input.abortSignal.addEventListener('abort', () => reject(input.abortSignal.reason), { once: true });
  }) });
  const result = running.runner.run({ tasks: [...tasks, tasks[0]], abortSignal: controller.signal });
  await settle(); controller.abort();
  const output = await result;
  assert.equal(output.status, 'aborted'); assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
  assert.ok(running.ended.every(item => item.status === 'stopped')); assert.equal(running.started.length, 2);
  await settle(); assert.equal(running.runner.status().active, 0);
});

test('timeout is bounded and a late provider keeps its permit and accounts usage', async () => {
  const gate = deferred(); let passedSignal;
  const h = harness({ timeoutMs: 50, generate: input => { passedSignal = input.abortSignal; return gate.promise; } });
  const started = Date.now();
  const output = await h.runner.run({ tasks: [tasks[0]] });
  assert.ok(Date.now() - started < 800); assert.equal(output.results[0].code, 'specialist_timeout');
  assert.ok(passedSignal.aborted); assert.equal(h.runner.status().active, 1);
  gate.resolve({ text: 'Zu spät.', usage }); await settle();
  assert.equal(h.runner.status().active, 0); assert.equal(h.charged.length, 1);
  assert.equal(h.ended[0].status, 'failed');
});

test('a tool cannot start after cancellation even when a late model tries to invoke it', async () => {
  let input, mutations = 0; const gate = deferred(), controller = new AbortController();
  const h = harness({ generate: value => { input = value; return gate.promise; }, assembleReadTools: () => ({ readData: { readOnly: true, execute: async () => { mutations++; } } }) });
  const running = h.runner.run({ tasks: [tasks[0]], abortSignal: controller.signal });
  await settle(); controller.abort(); await running;
  await assert.rejects(() => input.tools.readData.execute({})); assert.equal(mutations, 0);
  gate.resolve({ text: 'Late', usage }); await settle();
});

test('cancellation between tool scheduling and execution still prevents the tool call', async () => {
  let calls = 0; const controller = new AbortController();
  const h = harness({ generate: async input => {
    const pending = input.tools.readData.execute({}); controller.abort(); await pending;
    return { text: 'Should never finish.', usage };
  }, assembleReadTools: () => ({ readData: { readOnly: true, execute: async () => { calls++; } } }) });
  const output = await h.runner.run({ tasks: [tasks[0]], abortSignal: controller.signal });
  assert.equal(output.status, 'aborted'); assert.equal(calls, 0);
  await settle(); assert.equal(h.runner.status().active, 0);
});

test('skill exposes executable roster and propagates parent/context/cancellation', async () => {
  let actual;
  const runner = { status: () => ({ agents: [{ agentId: 'iva-customer', runtimeAvailable: true, connectionStatus: 'not-probed' }] }), run: async value => { actual = value; return { status: 'completed' }; } };
  const tools = specialistSkill({ runner, parentRunId: 'parent-9', projectId: 'project-9', context: () => 'Auftragskontext' });
  assert.deepEqual(Object.keys(tools).sort(), [...specialistSkillMeta.toolNames].sort());
  assert.equal((await tools.getIvaAgentRoster.execute({})).agents[0].connectionStatus, 'not-probed');
  const controller = new AbortController();
  await tools.delegateIvaTasks.execute({ tasks, projectId: 'attacker-project' }, { abortSignal: controller.signal });
  assert.equal(actual.parentRunId, 'parent-9'); assert.equal(actual.projectId, 'project-9'); assert.equal(actual.context, 'Auftragskontext'); assert.equal(actual.abortSignal, controller.signal);
});

test('project context is server-bound and forwarded to tool assembly and child session', async () => {
  let scope;
  const h = harness({ assembleReadTools: (agent, options) => { scope = options; return {}; }, generate: async input => {
    assert.equal(JSON.parse(input.prompt).projectId, 'project-1'); return { text: 'Projektanalyse ohne Datenzugriff.', usage };
  } });
  const output = await h.runner.run({ tasks: [tasks[0]], projectId: 'project-1', parentRunId: 'parent' });
  assert.equal(scope.projectId, 'project-1'); assert.match(scope.sessionId, /^specialist:project-1:/);
  assert.match(h.started[0].sessionId, /^specialist:project-1:/); assert.match(h.started[0].routeReason, /project:project-1/);
  assert.equal(output.results[0].projectId, 'project-1');
});

test('roster readiness uses the current project without inventing account verification', () => {
  const h = harness({ readiness: (_agent, { projectId }) => ({ availableCount: projectId === 'project-1' ? 2 : 0 }) });
  assert.equal(h.runner.status({ projectId: 'project-1' }).agents[0].availableReadTools, 2);
  assert.equal(h.runner.status({ projectId: 'project-2' }).agents[0].availableReadTools, 0);
  assert.equal(h.runner.status().agents[0].connectionStatus, 'not-probed');
});

test('project specialists use the specialist domain without global account/workflow instructions', async () => {
  const h = harness({ getAgent: id => ({ ...agents.find(item => item.id === id), rolePrompt: 'Private agency account 009T7N, always use Heat Hero customer rules.' }), generate: async input => {
    assert.match(input.system, /Fachgebiet: Kunden/);
    assert.match(input.system, /nur das aktuelle Projekt/);
    assert.doesNotMatch(input.system, /009T7N|Heat Hero|Private agency/);
    return { text: 'Projektbezogene Fachanalyse.', usage };
  } });
  assert.equal((await h.runner.run({ tasks: [tasks[0]], projectId: 'project-1' })).status, 'completed');
});
