import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-router-config-'));
let counter = 0;
async function withRouter(contents, verify) {
  const data = path.join(directory, String(++counter));
  await fs.mkdir(data);
  if (contents === 'DIRECTORY') await fs.mkdir(path.join(data, 'integration-checkup.json'));
  else if (contents !== undefined) await fs.writeFile(path.join(data, 'integration-checkup.json'), contents);
  const old = new Map(Object.entries(process.env).filter(([name]) => name === 'DATA_DIR' || name.startsWith('IVA_MODEL_')));
  for (const name of old.keys()) delete process.env[name];
  process.env.DATA_DIR = data;
  try {
    const router = await import(`../core/router.js?config-test=${counter}`);
    await verify(router);
  } finally {
    for (const name of Object.keys(process.env)) if (name === 'DATA_DIR' || name.startsWith('IVA_MODEL_')) delete process.env[name];
    for (const [name, value] of old) process.env[name] = value;
  }
}

test('a genuinely absent file and absent override field preserve registered defaults', async () => {
  for (const content of [undefined, '{}', '{"modelOverrides":{}}']) await withRouter(content, router => {
    assert.equal(router.chooseModel({ task: 'chat' }).key, 'anthropic:claude-sonnet-4-6');
  });
});

test('corrupt or unreadable explicit configuration blocks routing without leaking its contents', async () => {
  for (const content of ['{SENTINEL_SECRET_INVALID_JSON', 'null', '[]', 'DIRECTORY']) await withRouter(content, router => {
    assert.throws(() => router.chooseModel({ task: 'chat' }), error => error.code === 'router_config_invalid' && !error.message.includes('SENTINEL_SECRET'));
    assert.throws(() => router.chooseModelKey('anthropic:claude-sonnet-4-6'), { code: 'router_config_invalid' });
    assert.ok(router.inspectRouting().resolved.chat.error);
  });
});

test('invalid override shape, task, empty value and unknown model never fall back', async () => {
  for (const overrides of [null, [], '', { chat: '' }, { chat: 'google:gemini-unreviewed' }, { typo: 'anthropic:claude-sonnet-4-6' }]) {
    await withRouter(JSON.stringify({ modelOverrides: overrides }), router => {
      assert.throws(() => router.chooseModel({ task: 'chat' }), { code: 'router_config_invalid' });
    });
  }
});

test('registered overrides and valid ENV precedence still choose the requested model', async () => {
  await withRouter('{"modelOverrides":{"chat":"google:gemini-3.6-flash"}}', router => {
    assert.equal(router.chooseModel({ task: 'chat' }).key, 'google:gemini-3.6-flash');
    process.env.IVA_MODEL_CHAT = 'groq:openai/gpt-oss-120b';
    assert.equal(router.chooseModel({ task: 'chat' }).key, 'groq:openai/gpt-oss-120b');
  });
});

test('explicit empty or unreviewed ENV values fail closed rather than selecting defaults', async () => {
  await withRouter(undefined, router => {
    for (const value of ['', '  ', 'google:gemini-unreviewed', 'google:gemini-3.6-flash:ignored-suffix']) {
      process.env.IVA_MODEL_CHAT = value;
      assert.throws(() => router.chooseModel({ task: 'chat' }), { code: 'router_config_invalid' });
    }
  });
});

test('invalid live update latches failure until a valid explicit repair', async () => {
  await withRouter(undefined, router => {
    router.setRuntimeModelOverrides({ chat: 'google:gemini-3.6-flash' });
    assert.throws(() => router.setRuntimeModelOverrides({ chat: 'invalid' }), { code: 'router_config_invalid' });
    assert.throws(() => router.chooseModel({ task: 'chat' }), { code: 'router_config_invalid' });
    router.setRuntimeModelOverrides({ chat: 'google:gemini-3.6-flash' });
    assert.equal(router.chooseModel({ task: 'chat' }).key, 'google:gemini-3.6-flash');
    router.setRuntimeModelOverrides({});
    assert.equal(router.chooseModel({ task: 'chat' }).key, 'anthropic:claude-sonnet-4-6');
  });
});

test.after(() => fs.rm(directory, { recursive: true, force: true }));
