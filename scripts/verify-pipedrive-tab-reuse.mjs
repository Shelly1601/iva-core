import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildPipedrivePipelineTabAppleScript, executePipedriveJavaScript } from '../local-mac-helper/chrome-pipedrive.mjs';

const workspace = { target: { x: 0, width: 1920 }, bounds: { left: 0, top: 0, right: 1920, bottom: 1080 } };
const pipeline = 'https://simplegategmbh.pipedrive.com/pipeline/1';
function harness(replies, extra = {}) {
  const calls = [], waits = [];
  return { calls, waits, options: { getWorkspace: async () => workspace, waitFn: async ms => waits.push(ms),
    run: async script => {
      calls.push(script);
      assert.ok(replies.length, 'unexpected native invocation');
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply;
    }, ...extra } };
}

test('builder prefers exact tab, then Pipedrive/work/other existing window; only no window creates one', () => {
  const script = buildPipedrivePipelineTabAppleScript(workspace);
  const exact = script.indexOf('then return "existing:"');
  const host = script.indexOf('tabURL starts with "https://simplegategmbh.pipedrive.com/"');
  const work = script.indexOf('then set ivaWindow to workWindow');
  const any = script.indexOf('then set ivaWindow to first window');
  const create = script.indexOf('set ivaWindow to make new window');
  assert.ok(exact >= 0 && exact < host && host < work && work < any && any < create);
  assert.match(script, /if ivaWindow is missing value then\n  set ivaWindow to make new window/);
  assert.match(script, /else\n  set createdTab to make new tab at end of tabs of ivaWindow/);
  assert.ok(script.includes(`tabURL is "${pipeline}"`));
  assert.ok(script.includes(`tabURL starts with "${pipeline}?"`));
  assert.doesNotMatch(script, /set index of|set URL of active tab|close /);
});

test('an existing exact tab is reused without workspace lookup, creation, delay or cleanup', async () => {
  const h = harness(['result'], { cleanupTemporaryTab: true, getWorkspace: async () => { throw new Error('not needed'); } });
  assert.equal(await executePipedriveJavaScript('document.title', h.options), 'result');
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.waits, []);
  assert.doesNotMatch(h.calls[0], /make new|close |isRightWorkspace/);
});

test('exact deal lookup cannot select a different company or a longer deal ID', async () => {
  const h = harness(['ok'], { dealId: '8488' });
  await executePipedriveJavaScript('document.title', h.options);
  assert.match(h.calls[0], /tabURL is "https:\/\/simplegategmbh\.pipedrive\.com\/deal\/8488"/);
  assert.doesNotMatch(h.calls[0], /contains "(?:pipedrive|https:)/);
});

test('a synchronous operation closes only its own newly created pipeline tab after success', async () => {
  const h = harness(['NO_TAB', 'created:42', 'verified', 'closed'], { cleanupTemporaryTab: true });
  assert.equal(await executePipedriveJavaScript('performOperation()', h.options), 'verified');
  assert.deepEqual(h.waits, [2200]);
  assert.match(h.calls[3], /if \(id of t as text\) is "42" then\n      close t/);
  assert.doesNotMatch(h.calls[3], /close (?:w|window)|make new/);
});

test('a synchronous operation closes its own newly created tab after execution failure', async () => {
  const h = harness(['NO_TAB', 'created:42', new Error('operation failed'), 'closed'], { cleanupTemporaryTab: true });
  await assert.rejects(executePipedriveJavaScript('performOperation()', h.options), /operation failed/);
  assert.equal(h.calls.length, 4);
  assert.match(h.calls[3], /close t/);
});

test('a tab found by the fallback race check remains open and receives no loading delay', async () => {
  const h = harness(['NO_TAB', 'existing:42', 'verified'], { cleanupTemporaryTab: true });
  assert.equal(await executePipedriveJavaScript('performOperation()', h.options), 'verified');
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.waits, []);
});

test('default async callers retain their created source tab for later polling', async () => {
  const h = harness(['NO_TAB', 'created:42', 'started']);
  assert.equal(await executePipedriveJavaScript('startAsyncJob()', h.options), 'started');
  assert.equal(h.calls.length, 3);
});

test('missing deal and invalid creation handles never trigger broad cleanup', async () => {
  const deal = harness(['NO_TAB'], { dealId: '8488', cleanupTemporaryTab: true });
  await assert.rejects(executePipedriveJavaScript('read()', deal.options), /Kein geöffneter/);
  assert.equal(deal.calls.length, 1);
  const malformed = harness(['NO_TAB', 'unverified-handle'], { cleanupTemporaryTab: true });
  await assert.rejects(executePipedriveJavaScript('read()', malformed.options), /eindeutig zugeordnet/);
  assert.equal(malformed.calls.length, 2);
});

test('cleanup is explicitly opted into by exactly the three synchronous CLI note paths', async () => {
  const source = await readFile(new URL('../local-mac-helper/chrome-pipedrive.mjs', import.meta.url), 'utf8');
  assert.equal((source.match(/cleanupTemporaryTab: true/g) || []).length, 3);
  for (const name of ['createPipedriveFundingInformationNote', 'updatePipedriveFundingRequestNotes', 'createPipedriveFundingRequestNotes']) {
    const start = source.indexOf(`export async function ${name}(`);
    const end = source.indexOf('\nexport ', start + 1);
    assert.match(source.slice(start, end < 0 ? undefined : end), /cleanupTemporaryTab: true/);
  }
});
