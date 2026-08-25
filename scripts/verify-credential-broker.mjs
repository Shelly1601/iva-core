import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  IVA_CREDENTIAL_SERVICES,
  credentialBrokerPolicy,
  credentialBrokerStatus,
  configureCredentialFieldInteractive,
  generateTotp,
  readCredentialField,
} from '../local-mac-helper/credential-broker.mjs';
import { ensurePortalLogin, portalAuthPolicy } from '../local-mac-helper/portal-auth.mjs';
import { macWakeGuardPolicy } from '../local-mac-helper/mac-wake-guard.mjs';

const noWakeGuard = async task => task();

assert.deepEqual(Object.keys(IVA_CREDENTIAL_SERVICES), ['panasonic', 'bosch', 'pipedrive', 'airtable', 'planbar']);
assert.equal(IVA_CREDENTIAL_SERVICES.pipedrive.allowedHosts[0], 'simplegategmbh.pipedrive.com');
assert.equal(IVA_CREDENTIAL_SERVICES.panasonic.externalAuthenticator, 'ente-auth:phvaceu-prod-panasonic');
assert.equal(credentialBrokerPolicy().remoteSecretRead, false);
assert.equal(portalAuthPolicy().arbitraryHosts, false);
assert.equal(portalAuthPolicy().credentialsViaProcessArguments, false);
assert.equal(macWakeGuardPolicy().displaySleepAfterRun, true);

const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
assert.equal(generateTotp(`otpauth://totp/Test?secret=${rfcSecret}&algorithm=SHA1&digits=8&period=30`, { now: 59_000 }), '94287082');
assert.equal(generateTotp(`otpauth://totp/Test?secret=${rfcSecret}&algorithm=SHA1&digits=8&period=30`, { now: 1_111_111_109_000 }), '07081804');
assert.throws(() => generateTotp('ungueltig!'), /Base32/);

const fakeExec = async (_binary, args) => {
  const serviceIndex = args.indexOf('-s');
  const key = args[serviceIndex + 1];
  if (args.includes('-w')) return { stdout: key.endsWith('.username') ? 'iva-user@example.test\n' : 'test-secret\n', stderr: '' };
  if (key.endsWith('.pipedrive.username') || key.endsWith('.pipedrive.password')) return { stdout: '', stderr: '' };
  const error = new Error('The specified item could not be found in the keychain.');
  error.code = 44;
  error.stderr = 'The specified item could not be found in the keychain.';
  throw error;
};
const brokerStatus = await credentialBrokerStatus('', { exec: fakeExec });
const pipedriveStatus = brokerStatus.services.find(item => item.id === 'pipedrive');
assert.equal(pipedriveStatus.keychainReady, true);
assert.equal(pipedriveStatus.configured.totp, false);
assert.equal(brokerStatus.secretValuesReturned, false);
assert.equal(JSON.stringify(brokerStatus).includes('test-secret'), false);
assert.equal(await readCredentialField('pipedrive', 'username', { exec: fakeExec }), 'iva-user@example.test');
await assert.rejects(() => readCredentialField('panasonic', 'totp', { exec: fakeExec }), /nicht.*gespeichert/);
await assert.rejects(() => configureCredentialFieldInteractive('pipedrive', 'password'), /interaktiven Terminal/);

const enteBridgeSource = await readFile(new URL('../local-mac-helper/macos/iva-ax.swift', import.meta.url), 'utf8');
assert.match(enteBridgeSource, /phvaceu-prod/);
assert.match(enteBridgeSource, /panasonic/);
assert.match(enteBridgeSource, /lausig/);
assert.match(enteBridgeSource, /"clipboardUsed": false/);
assert.match(enteBridgeSource, /"secretReturned": false/);

function fakeTransport(states) {
  let index = 0;
  const calls = [];
  return {
    calls,
    open: async profile => { calls.push(['open', profile.id]); },
    wait: async () => {},
    probe: async profile => {
      calls.push(['probe', profile.id]);
      return states[Math.min(index++, states.length - 1)];
    },
    startLogin: async profile => { calls.push(['startLogin', profile.id]); return 'STARTED'; },
    submitCredentials: async (profile, username, password) => {
      calls.push(['credentials', profile.id, username === 'user', password === 'pass']);
      return { usernameFilled: true, passwordFilled: true, submitted: true };
    },
    submitTotp: async (profile, code) => {
      calls.push(['totp', profile.id, code === '123456']);
      return { filled: true, submitted: true };
    },
    submitAuthenticator: async profile => {
      calls.push(['authenticator', profile.id]);
      return { typed: true, submitted: true, secretReturned: false, clipboardUsed: false };
    },
  };
}

const airtableTransport = fakeTransport([{ authenticated: true }]);
const airtableLogin = await ensurePortalLogin('airtable', { transport: airtableTransport, wakeGuard: noWakeGuard });
assert.equal(airtableLogin.status, 'authenticated');
assert.equal(airtableLogin.credentialsSubmitted, false);

const pipedriveTransport = fakeTransport([
  { authenticated: false, usernameVisible: true, passwordVisible: true },
  { authenticated: true },
]);
const pipedriveLogin = await ensurePortalLogin('pipedrive', {
  transport: pipedriveTransport,
  wakeGuard: noWakeGuard,
  keychainStatus: async () => ({ configured: { username: true, password: true, totp: false } }),
  readSecret: async (_service, field) => field === 'username' ? 'user' : 'pass',
});
assert.equal(pipedriveLogin.status, 'authenticated');
assert.equal(pipedriveLogin.credentialsSubmitted, true);
assert.equal(JSON.stringify(pipedriveLogin).includes('user'), false);
assert.deepEqual(pipedriveTransport.calls.find(call => call[0] === 'credentials'), ['credentials', 'pipedrive', true, true]);

const panasonicTransport = fakeTransport([
  { authenticated: false, ssoStartVisible: true },
  { authenticated: false, totpVisible: true },
  { authenticated: true },
]);
const panasonicLogin = await ensurePortalLogin('panasonic', {
  transport: panasonicTransport,
  wakeGuard: noWakeGuard,
});
assert.equal(panasonicLogin.status, 'authenticated');
assert.equal(panasonicLogin.totpSubmitted, true);
assert.deepEqual(panasonicTransport.calls.find(call => call[0] === 'authenticator'), ['authenticator', 'panasonic']);

const missingTransport = fakeTransport([{ authenticated: false, usernameVisible: true, passwordVisible: true }]);
const missingLogin = await ensurePortalLogin('pipedrive', {
  transport: missingTransport,
  wakeGuard: noWakeGuard,
  keychainStatus: async () => ({ configured: { username: false, password: false, totp: false } }),
});
assert.equal(missingLogin.status, 'setup_required');
assert.deepEqual(missingLogin.missingFields, ['username', 'password']);

const captchaLogin = await ensurePortalLogin('pipedrive', {
  transport: fakeTransport([{ authenticated: false, captchaVisible: true }]),
  wakeGuard: noWakeGuard,
});
assert.equal(captchaLogin.status, 'blocked');
assert.equal(captchaLogin.blocker, 'captcha');
await assert.rejects(() => ensurePortalLogin('unbekannt', { wakeGuard: noWakeGuard }), /nicht.*freigegeben/);

console.log('PASS IVA-Schlüsselbund: fünf Portalprofile, sichere Statusausgabe, TOTP und autonome Login-Orchestrierung.');
