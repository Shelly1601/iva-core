import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-integration-checkup-'));
process.env.DATA_DIR = dir;
process.env.GEMINI_API_KEY = 'gemini-test-key';
for (const name of ['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN', 'CALENDLY_TOKEN', 'GROQ_API_KEY', 'ELEVENLABS_API_KEY', 'APIFY_TOKEN']) delete process.env[name];

const { formatCheckupTelegram, getIntegrationCheckupStatus, newestStableGeminiFlash, runIntegrationCheckup } = await import('../maintenance/checkup.js');
const { inspectRouting } = await import('../core/router.js');

assert.equal(newestStableGeminiFlash(['gemini-2.5-flash', 'gemini-3.6-flash', 'gemini-4.0-flash-preview']), 'gemini-3.6-flash');

let probeCalls = 0;
const currentFetch = async url => {
  assert.match(String(url), /generativelanguage\.googleapis\.com\/v1beta\/models/);
  return {
    ok: true, status: 200,
    json: async () => ({ models: [{ name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] }] }),
  };
};
const current = await runIntegrationCheckup({ fetchImpl: currentFetch });
assert.equal(current.checks.find(item => item.id === 'gemini').status, 'ok');
assert.equal(current.updates.length, 0);

const replacementFetch = async url => {
  const value = String(url);
  if (value.includes(':generateContent')) {
    probeCalls += 1;
    assert.match(value, /gemini-4\.0-flash/);
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }) };
  }
  return {
    ok: true, status: 200,
    json: async () => ({ models: [
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-4.0-flash', supportedGenerationMethods: ['generateContent'] },
    ] }),
  };
};
const replaced = await runIntegrationCheckup({ fetchImpl: replacementFetch });
assert.equal(replaced.checks.find(item => item.id === 'gemini').status, 'updated');
assert.equal(replaced.updates[0].to, 'gemini-4.0-flash');
assert.equal(probeCalls, 1);
assert.equal(inspectRouting().resolved['marketing-market'].key, 'google:gemini-4.0-flash');

const persisted = await getIntegrationCheckupStatus();
assert.equal(persisted.modelOverrides['marketing-assist'], 'google:gemini-4.0-flash');
assert.equal(persisted.packageUpdates.safeAutoMergeAfterTests, true);
assert.match(formatCheckupTelegram(replaced), /Automatisch aktualisiert/);

await fs.rm(dir, { recursive: true, force: true });
console.log('Monatlicher KI- und Integrations-Check-up: OK');
