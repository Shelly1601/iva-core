import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { tool } from 'ai';
import { z } from 'zod';
import { rankIvaTools, describeIvaTool, connectionState, recordToolOutcome, toolRoutingStatus } from '../core/tool-routing.js';
import { compactIvaTools } from '../core/tool-discovery.js';

const make = (skillId, description, execute = async () => ({ ok: true }), parameters = z.object({})) => ({ ...tool({ description, parameters, execute }), iva: { skillId } });

test('native Outlook precedes generic mail APIs while exact tool names stay discoverable', () => {
  const all = {
    getMails: make('mails', 'Liest neue E-Mails aus dem Postfach.'),
    runTaskOnImac: make('deviceControl', 'Führt den beauftragten nativen Outlook-Leseauftrag auf dem Mac Mini aus.'),
  };
  const options = { env: { MACMINI_DEVICE_TOKEN: 'fixture' }, agentId: 'iva-customer' };
  const ranked = rankIvaTools(all, { ...options, query: 'Lies meine neuen Mails im Outlook Postfach' });
  assert.equal(ranked[0].name, 'runTaskOnImac');
  assert.match(ranked[0].reason, /nativen Outlook/);
  assert.equal(rankIvaTools(all, { ...options, query: 'getMails' })[0].name, 'getMails');
  assert.equal(rankIvaTools(all, { ...options, query: 'getMails', readOnly: true })[0].name, 'getMails');
});

test('discovery is bounded and read-only selection excludes mutation/unknown-name tools', () => {
  const all = {
    getCurrentProject: make('projects', 'Projekt lesen'),
    addCurrentProjectNote: make('projects', 'Projektnotiz schreiben'),
    mysteryRead: { ...make('projects', 'Projekt lesen'), readOnly: true },
  };
  assert.deepEqual(rankIvaTools(all, { query: 'Projekt', readOnly: true }).map(row => row.name), ['getCurrentProject']);
  assert.equal(describeIvaTool('mysteryRead', all.mysteryRead).readOnly, false);
  const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`tool${i}`, make('projects', 'Projekt vergleichen')]));
  assert.equal(rankIvaTools(many, { query: 'Projekt', limit: 200 }).length, 12);
  assert.equal(rankIvaTools(many, { query: 'Projekt' }).length, 5);
});

test('own Instagram route is preferred to public-reference scraping when connected', () => {
  const all = {
    readInstagramReference: make('instagram', 'Öffentliche Instagram-Referenz auslesen'),
    listOwnInstagramMedia: make('instagram', 'Eigene Instagram-Beiträge lesen'),
  };
  const env = { APIFY_TOKEN: 'fixture', INSTAGRAM_AUTH_MODE: 'instagram', INSTAGRAM_ACCESS_TOKEN: 'fixture', INSTAGRAM_ACCOUNT_ID: '123', META_GRAPH_VERSION: 'v25.0' };
  assert.equal(rankIvaTools(all, { query: 'Lies meine eigenen Instagram Posts', env })[0].name, 'listOwnInstagramMedia');
  assert.equal(connectionState('instagram', {}).state, 'missing-connection');
  assert.equal(connectionState('instagram', env).state, 'configured');
  assert.doesNotMatch(JSON.stringify(toolRoutingStatus(all, { env })), /fixture/);
});

test('execute preserves original confirmation validation and audits the real tool identity', async () => {
  let calls = 0; const receipts = [];
  const original = make('accounting', 'Beleg bestätigen', async input => { calls++; return input; }, z.object({ confirmed: z.literal(true), note: z.string().optional() }));
  const tools = compactIvaTools({ approveReceipt: original }, { projectId: 'project-a', runId: 'run-1', onExecution: value => receipts.push(value) });
  await assert.rejects(() => tools.executeIvaTool.execute({ name: 'approveReceipt', arguments: { confirmed: false } }));
  const output = await tools.executeIvaTool.execute({ name: 'approveReceipt', arguments: { confirmed: true, note: null } });
  assert.deepEqual(output, { confirmed: true }); assert.equal(calls, 1);
  assert.deepEqual(receipts.map(item => item.tool), ['approveReceipt', 'approveReceipt']);
  assert.deepEqual(receipts.map(item => item.outcome), ['failed', 'returned']);
  assert.ok(receipts.every(item => item.projectId === 'project-a' && item.runId === 'run-1'));
  const count = receipts.length;
  await assert.rejects(() => tools.executeIvaTool.execute({ name: 'foreignProjectTool', arguments: {} }));
  await assert.rejects(() => tools.executeIvaTool.execute({ name: 'constructor', arguments: {} }));
  assert.equal(receipts.length, count);
});

test('tool side effects are serialized and auditing failures do not repeat execution', async () => {
  let active = 0, maxActive = 0, calls = 0;
  const perform = async () => { calls++; active++; maxActive = Math.max(maxActive, active); await delay(10); active--; return { ok: true }; };
  const tools = compactIvaTools({ writeFirst: make('projects', 'Schreiben', perform), writeSecond: make('projects', 'Schreiben', perform) }, { onExecution: () => { throw new Error('audit unavailable'); } });
  await Promise.all(['writeFirst', 'writeSecond'].map(name => tools.executeIvaTool.execute({ name, arguments: {} })));
  assert.equal(maxActive, 1); assert.equal(calls, 2);
});

test('aborted queued writes never execute, while independent reads can overlap', async () => {
  let calls = 0; const controller = new AbortController(); controller.abort();
  const all = { getCurrentProject: make('projects', 'Lesen', async () => { calls++; await delay(5); return { ok: true }; }) };
  const compact = compactIvaTools(all);
  await assert.rejects(() => compact.executeIvaTool.execute({ name: 'getCurrentProject', arguments: {} }, { abortSignal: controller.signal }));
  assert.equal(calls, 0);
  let active = 0, max = 0;
  const read = async () => { active++; max = Math.max(max, active); await delay(10); active--; return {}; };
  const reads = compactIvaTools({ getCurrentProject: make('projects', 'Lesen', read), readCurrentProjectFile: make('projects', 'Lesen', read) });
  await Promise.all(['getCurrentProject', 'readCurrentProjectFile'].map(name => reads.executeIvaTool.execute({ name, arguments: {} })));
  assert.equal(max, 2);
});

test('outcome accounting distinguishes pending work and explicit failures from returned data', () => {
  assert.equal(recordToolOutcome('accounting-fixture-a', { queued: true }, 5).outcome, 'pending');
  assert.equal(recordToolOutcome('accounting-fixture-b', { ok: false }, 5).outcome, 'failed');
  assert.equal(recordToolOutcome('accounting-fixture-c', { status: 'failed' }, 5).outcome, 'failed');
  assert.equal(recordToolOutcome('accounting-fixture-d', { command: { status: 'running' } }, 5).outcome, 'pending');
  assert.equal(recordToolOutcome('accounting-fixture-e', { command: { status: 'failed' } }, 5).outcome, 'failed');
});
