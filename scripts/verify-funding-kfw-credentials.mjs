import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateKfwCustomerCredentials, renderKfwCustomerCredentialsNote, kfwCredentialNoteHasPair, hasStoredKfwCustomerCredentials } from '../local-mac-helper/funding-kfw-credentials.mjs';
import { renderPipedriveFundingInformationNote, createPipedriveFundingInformationNote } from '../local-mac-helper/chrome-pipedrive.mjs';
import { writePipedriveKfwCustomerCredentials } from '../local-mac-helper/background-integrations.mjs';
import { buildCentralRuntimeBundle, validateCentralRuntimeBundle } from '../local-mac-helper/central-runtime.mjs';

function fixture() {
  return { scope: 'customer-kfw', dealId: '123', customerPersonId: '5', sourceIdentityVerified: true,
    email: 'fixture-kfw@example.test', password: `Fixture-${randomUUID()} & < > " ' two  spaces` };
}

test('explicit customer credentials render a complete escaped pair without normalizing the password', () => {
  const credentials = fixture();
  const rendered = renderPipedriveFundingInformationNote({ dealId: '123', kfwCredentials: credentials });
  assert.equal(rendered.containsCustomerCredentials, true);
  assert.ok(rendered.text.includes(credentials.password));
  assert.match(rendered.content, /&amp; &lt; &gt; &quot; &#39; two  spaces/);
  assert.ok(!rendered.content.includes('< >'));
  assert.ok(kfwCredentialNoteHasPair(rendered.text));
  for (const password of ['[Synthetic123]', 'a b', 'vorhanden123']) {
    assert.ok(kfwCredentialNoteHasPair(renderKfwCustomerCredentialsNote({ ...credentials, password }, '123').text));
  }
});

test('private/system scopes, OTP payloads, ambiguous identities and free-text passwords are rejected', () => {
  for (const patch of [{ scope: 'system' }, { scope: 'private' }, { sourceIdentityVerified: false }, { dealId: '999' },
    { customerPersonId: '' }, { otp: 'synthetic' }, { systemPassword: 'synthetic' }]) {
    assert.throws(() => validateKfwCustomerCredentials({ ...fixture(), ...patch }, '123'));
  }
  for (const heading of ['KfW', 'System', 'Information']) {
    assert.throws(() => renderPipedriveFundingInformationNote({ heading, details: [{ label: 'Passwort', value: fixture().password }] }), /kfwCredentials-Payload/);
  }
  assert.doesNotThrow(() => renderPipedriveFundingInformationNote({ heading: 'KfW', details: [{ label: 'Status', value: 'Login erfolgreich; abgemeldet.' }] }));
});

test('login-status and redacted placeholders do not count as stored credentials', () => {
  for (const text of ['KfW Login erfolgreich; abgemeldet.', 'KfW fixture@example.test Passwort: [ausgeblendet]',
    'KfW fixture@example.test Passwort: vorhanden', 'KfW fixture@example.test Passwort: nicht hinterlegt',
    'KfW fixture@example.test Passwort: erfolgreich geprüft', 'KfW fixture@example.test Passwort: gültig; Login erfolgreich',
    'KfW-Konto fixture@example.test erfolgreich2026 geprüft',
    'KfW fixture@example.test OTP: synthetic123', 'macOS KfW fixture@example.test Passwort: synthetic123']) assert.equal(kfwCredentialNoteHasPair(text), false);
  assert.equal(kfwCredentialNoteHasPair('KfW-Konto fixture@example.test synthetic123'), true);
  assert.equal(hasStoredKfwCustomerCredentials({ kfwAccountConfirmedByCredentials: true, kfwCredentialEvidenceNoteIds: ['9'] }), true);
  assert.equal(hasStoredKfwCustomerCredentials({ kfwAccountConfirmedByCredentials: true, kfwCredentialEvidenceNoteIds: [] }), false);
});

test('credential creation routes directly to the confirmed API without browser JavaScript', async () => {
  const kfwCredentials = fixture(); let calls = 0;
  const result = await createPipedriveFundingInformationNote({ dealId: '123', kfwCredentials, confirmApply: true }, {
    writeKfwCredentials: async input => { calls++; assert.deepEqual(input, { dealId: '123', kfwCredentials, confirmApply: true, reconcileOnly: false }); return { noteId: '9', verified: true }; },
  });
  assert.equal(calls, 1); assert.equal(result.verified, true);
  await assert.rejects(createPipedriveFundingInformationNote({ dealId: 'wrong123', kfwCredentials, confirmApply: true }), /Deal-ID/);
});

test('authenticated device write returns only a safe receipt and suppresses remote error payloads', async () => {
  const kfwCredentials = fixture(), input = { dealId: '123', kfwCredentials, confirmApply: true };
  let calls = 0;
  const requestImpl = async (pathname, options) => {
    calls++; assert.equal(pathname, '/device-agent/macmini-nadine/background/pipedrive/deals/123/kfw-credentials');
    assert.equal(options.method, 'POST'); assert.deepEqual(options.body.kfwCredentials, kfwCredentials);
    return { noteId: '9', created: true, verified: true, writeAttempted: true, content: kfwCredentials.password, kfwCredentials };
  };
  await assert.rejects(writePipedriveKfwCustomerCredentials({ ...input, confirmApply: false }, { requestImpl }), /confirmApply/);
  assert.equal(calls, 0);
  const receipt = await writePipedriveKfwCustomerCredentials(input, { requestImpl });
  assert.equal(receipt.noteId, '9'); assert.equal(receipt.verified, true);
  assert.ok(!JSON.stringify(receipt).includes(kfwCredentials.password)); assert.ok(!JSON.stringify(receipt).includes(kfwCredentials.email));
  for (const requestImpl of [async () => { throw new Error(kfwCredentials.password); }, async () => ({ verified: true, noteId: kfwCredentials.password })]) {
    await assert.rejects(writePipedriveKfwCustomerCredentials(input, { requestImpl }), error => !error.message.includes(kfwCredentials.password));
  }
});

test('central runtime includes and validates the exact credential module bytes', async () => {
  const repo = fileURLToPath(new URL('../', import.meta.url)), relative = 'local-mac-helper/funding-kfw-credentials.mjs';
  const bundle = validateCentralRuntimeBundle(await buildCentralRuntimeBundle(repo));
  const bundled = bundle.files.find(file => file.path === relative);
  assert.ok(bundled);
  assert.deepEqual(Buffer.from(bundled.content, 'base64'), await readFile(new URL(`../${relative}`, import.meta.url)));
});

test('CLI accepts stdin and malformed JSON never echoes the secret input', () => {
  const credentials = fixture();
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../local-mac-helper/cli.mjs', import.meta.url)),
    'create-pipedrive-funding-info-note', '-', '--commit'], { input: credentials.password, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /kein lesbares JSON/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(credentials.password));
});
