import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { streamText } from 'ai';
import fs from 'node:fs/promises';
import { createChatStreamLifecycle, pipeChatTextStream, safeChatStreamError } from '../core/chat-stream-lifecycle.js';

function fixture(options = {}) {
  const writes = [], histories = [], incidents = [];
  const lifecycle = createChatStreamLifecycle({
    finishRun: async value => writes.push(value),
    saveCompleted: async value => histories.push({ kind: 'completed', text: value.text }),
    saveInterrupted: async value => histories.push({ kind: 'interrupted', code: value.error.code, checkpoint: value.checkpoint }),
    recordFailure: async error => incidents.push({ code: error.code, message: error.message }),
    ...options,
  });
  return { lifecycle, writes, histories, incidents };
}
function response() {
  const out = new EventEmitter();
  return Object.assign(out, { headersSent: false, destroyed: false, writableEnded: false, text: '',
    setHeader() {}, write(text) { this.headersSent = true; this.text += text; return true; },
    end() { this.writableEnded = true; },
  });
}
const done = { finishReason: 'stop', text: 'Antwort.', usage: { promptTokens: 5, completionTokens: 2 }, steps: [] };

test('late budget error is persisted once and a subsequent finish cannot overwrite failure', async () => {
  const f = fixture();
  f.lifecycle.onChunk({ chunk: { type: 'text-delta', textDelta: 'Teilantwort' } });
  f.lifecycle.onChunk({ chunk: { type: 'tool-call', toolName: 'readCase', args: { password: 'SECRET_SENTINEL' } } });
  f.lifecycle.onChunk({ chunk: { type: 'tool-result', toolName: 'readCase', result: { secret: 'SECRET_SENTINEL' } } });
  f.lifecycle.onStepFinish({});
  await f.lifecycle.onError({ error: Object.assign(new Error('SECRET_SENTINEL'), { code: 'budget_exceeded' }) });
  f.lifecycle.onFinish(done);
  await assert.rejects(f.lifecycle.complete(), { code: 'budget_exceeded' });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].status, 'failed');
  assert.deepEqual(f.writes[0].tools, ['readCase']);
  assert.match(f.writes[0].resultPreview, /1 Modellschritte; 1 Werkzeugaufrufe; 1 Werkzeugrückgaben/);
  assert.equal(f.histories[0].kind, 'interrupted');
  assert.doesNotMatch(JSON.stringify([f.writes, f.histories, f.incidents]), /SECRET_SENTINEL|password/);
});

test('finishReason alone is not completion; EOF and a nonempty chat response are required', async () => {
  const f = fixture();
  f.lifecycle.onFinish(done);
  assert.equal(f.writes.length, 0);
  await f.lifecycle.complete();
  assert.equal(f.writes[0].status, 'completed');
  for (const event of [null, { ...done, text: '' }, { ...done, finishReason: 'tool-calls' }, { ...done, finishReason: 'error' }]) {
    const incomplete = fixture();
    if (event) incomplete.lifecycle.onFinish(event);
    await assert.rejects(incomplete.lifecycle.complete(), { code: 'chat_stream_incomplete' });
    assert.equal(incomplete.writes[0].status, 'failed');
  }
});

test('pending tool calls remain an incomplete chat response, never a completed workflow', async () => {
  const f = fixture();
  f.lifecycle.onChunk({ chunk: { type: 'tool-call', toolName: 'writeCase' } });
  f.lifecycle.onFinish(done);
  await assert.rejects(f.lifecycle.complete(), { code: 'chat_stream_incomplete' });
  assert.equal(f.writes[0].status, 'failed');
});

test('abort persists a stopped checkpoint and cannot be overwritten by finish', async () => {
  const controller = new AbortController();
  const f = fixture({ abortSignal: controller.signal });
  controller.abort();
  f.lifecycle.onFinish(done);
  await assert.rejects(f.lifecycle.complete(), { code: 'chat_stream_aborted' });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].status, 'stopped');
});

test('failure racing an asynchronous success save wins the terminal state', async () => {
  let continueSave;
  const saving = new Promise(resolve => { continueSave = resolve; });
  const f = fixture({ saveCompleted: () => saving });
  f.lifecycle.onFinish(done);
  const completing = f.lifecycle.complete();
  await Promise.resolve();
  const failing = f.lifecycle.fail({ code: 'budget_exceeded' });
  continueSave();
  await failing;
  await assert.rejects(completing, { code: 'budget_exceeded' });
  assert.equal(f.writes.at(-1).status, 'failed');
  assert.ok(f.writes.every(value => value.status !== 'completed'));
});

test('unknown provider details and forged error codes never enter safe messages', () => {
  const error = safeChatStreamError({ code: 'budget_SECRET_SENTINEL', message: 'https://provider/?key=SECRET_SENTINEL' });
  assert.equal(error.code, 'chat_stream_failed');
  assert.doesNotMatch(error.message, /SECRET_SENTINEL|provider/);
});

test('checkpoint failure is surfaced and cannot turn an interrupted run into success', async () => {
  const f = fixture({ saveInterrupted: async () => { throw new Error('SECRET_STORAGE_ERROR'); } });
  await assert.rejects(f.lifecycle.fail({ code: 'budget_exceeded' }), { code: 'chat_checkpoint_failed' });
  f.lifecycle.onFinish(done);
  await assert.rejects(f.lifecycle.complete(), { code: 'chat_checkpoint_failed' });
  assert.equal(f.writes[0].status, 'failed');
});

function sdkResult(f, parts, { rejectStart } = {}) {
  const model = {
    specificationVersion: 'v1', provider: 'offline', modelId: 'offline-fixture', defaultObjectGenerationMode: 'json',
    async doStream() {
      if (rejectStart) throw rejectStart;
      return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }) };
    },
  };
  const result = streamText({ model, prompt: 'Offline fixture only.', maxRetries: 0,
    onChunk: f.lifecycle.onChunk, onStepFinish: f.lifecycle.onStepFinish, onError: f.lifecycle.onError, onFinish: f.lifecycle.onFinish,
  });
  Object.defineProperty(result, 'ivaStreamLifecycle', { value: f.lifecycle });
  return result;
}

test('real installed SDK: asynchronously denied first dispatch is stored as failed', async () => {
  const f = fixture(), out = response();
  const result = sdkResult(f, [], { rejectStart: Object.assign(new Error('SECRET_SENTINEL'), { code: 'budget_exceeded' }) });
  await assert.rejects(pipeChatTextStream(result, out), { code: 'budget_exceeded' });
  assert.equal(f.writes[0].status, 'failed');
  assert.equal(out.writableEnded, false);
  assert.doesNotMatch(JSON.stringify(f.writes), /SECRET_SENTINEL/);
});

test('real installed SDK: error event after partial output cannot become completed on SDK finish', async () => {
  const f = fixture(), out = response();
  const result = sdkResult(f, [
    { type: 'text-delta', textDelta: 'Teilantwort' },
    { type: 'error', error: Object.assign(new Error('PRIVATE_PROVIDER_BODY'), { code: 'budget_usage_unknown' }) },
    { type: 'finish', finishReason: 'stop', usage: { promptTokens: 5, completionTokens: 2 } },
  ]);
  await assert.rejects(pipeChatTextStream(result, out), { code: 'budget_usage_unknown' });
  assert.equal(out.text, 'Teilantwort');
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].status, 'failed');
});

test('real installed SDK: a healthy complete chat response preserves output and saves once', async () => {
  const f = fixture(), out = response();
  const result = sdkResult(f, [
    { type: 'text-delta', textDelta: 'Antwort.' },
    { type: 'finish', finishReason: 'stop', usage: { promptTokens: 5, completionTokens: 2 } },
  ]);
  await pipeChatTextStream(result, out);
  assert.equal(out.text, 'Antwort.');
  assert.equal(out.writableEnded, true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].status, 'completed');
});

test('production stream entry preserves newer turns when saving an interrupted run', async () => {
  const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
  const entrySource = source.slice(source.indexOf('async function streamIva('), source.indexOf('function toTelegramHTML('));
  let history = { web: [{ role: 'user', content: 'Previous turn' }], other: [{ role: 'user', content: 'Other session' }] };
  const writes = [];
  const dependencies = {
    createChatStreamLifecycle, safeChatStreamError,
    chatProject: async (_project, sessionId) => ({ sessionId }),
    handleTrackedQonektoConfirmation: async () => null,
    routeAgent: () => ({ agent: { id: 'fixture', name: 'Fixture', modelProfile: 'chat' } }),
    beginAgentRun: async () => ({ id: 'test-run' }), finishAgentRun: async (_id, value) => writes.push(value),
    assembleTools: async () => ({}), buildSystemPrompt: async () => 'Offline only', TOOL_EXECUTION_POLICY: 'Rules',
    buildKnowledgePromptContext: async () => '', incidentPromptContext: async () => '',
    loadConversations: async () => structuredClone(history), saveConversations: async value => { history = structuredClone(value); },
    recordUsage: async () => {}, recordChatRunFailure: async () => {}, recordBrainReview: async () => {},
    chooseModel: () => ({ model: {} }), checkBudget: async () => {}, prepareBrain: async ({ system }) => ({ system }),
    streamText: () => ({ fullStream: (async function* () { yield { type: 'error', error: { code: 'budget_exceeded' } }; })() }),
    MAX_TURNS: 30,
  };
  const entry = new Function(...Object.keys(dependencies), `${entrySource}; return streamIva;`)(...Object.values(dependencies));
  const result = await entry('Original interrupted request', 'web');
  history.web.push({ role: 'user', content: 'Newer request' }, { role: 'assistant', content: 'Newer response' });
  history.other.push({ role: 'assistant', content: 'New other response' });
  await assert.rejects(pipeChatTextStream(result, response()), { code: 'budget_exceeded' });
  assert.ok(history.web.some(turn => turn.content === 'Newer response'));
  assert.equal(history.other.at(-1).content, 'New other response');
  assert.match(history.web.at(-1).content, /test-run.*budget_exceeded/);
  assert.equal(writes[0].status, 'failed');
});
