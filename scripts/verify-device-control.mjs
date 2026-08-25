import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

const root = await mkdtemp(path.join(os.tmpdir(), 'iva-device-control-'));
process.env.DATA_DIR = root;
try {
  console.log('Device-Control: Store laden …');
  const {
    IVA_IMAC_DEVICE_ID,
    claimNextDeviceCommand,
    completeDeviceCommand,
    deviceCommandStatus,
    enqueueDeviceCommand,
    listDeviceCommands,
  } = await import('../device-control/store.js');
  const command = await enqueueDeviceCommand({
    action: 'funding.monitor.status',
    requestedBy: 'test',
    requestText: 'Status auf dem iMac prüfen',
  });
  console.log('Device-Control: Queue und Lease prüfen …');
  assert.equal(command.deviceId, IVA_IMAC_DEVICE_ID);
  assert.equal(command.status, 'queued');
  const claimed = await claimNextDeviceCommand(IVA_IMAC_DEVICE_ID);
  assert.equal(claimed.id, command.id);
  assert.equal(claimed.status, 'running');
  assert.ok(claimed.leaseToken.length >= 32);
  await assert.rejects(
    completeDeviceCommand({ deviceId: IVA_IMAC_DEVICE_ID, commandId: command.id, leaseToken: 'falsch', ok: true }),
    /ungültig/,
  );
  const completed = await completeDeviceCommand({
    deviceId: IVA_IMAC_DEVICE_ID,
    commandId: command.id,
    leaseToken: claimed.leaseToken,
    ok: true,
    result: { online: true },
  });
  assert.equal(completed.status, 'completed');
  assert.equal((await deviceCommandStatus(command.id)).result.online, true);
  assert.equal((await listDeviceCommands({ deviceId: IVA_IMAC_DEVICE_ID })).length, 1);
  const planbarCommand = await enqueueDeviceCommand({ action: 'planbar.search.refresh', requestedBy: 'test' });
  assert.equal(planbarCommand.action, 'planbar.search.refresh');
  assert.deepEqual(planbarCommand.payload, {});
  const portalLoginCommand = await enqueueDeviceCommand({ action: 'portal.login', payload: { service: 'Panasonic' }, requestedBy: 'test' });
  assert.equal(portalLoginCommand.action, 'portal.login');
  assert.deepEqual(portalLoginCommand.payload, { service: 'panasonic' });
  const credentialStatusCommand = await enqueueDeviceCommand({ action: 'portal.credentials.status', payload: { service: 'planbar' }, requestedBy: 'test' });
  assert.deepEqual(credentialStatusCommand.payload, { service: 'planbar' });
  await assert.rejects(enqueueDeviceCommand({ action: 'portal.login', payload: { service: 'bank' } }), /nicht freigegeben/);
  const codexCommand = await enqueueDeviceCommand({
    action: 'codex.task.start', requestedBy: 'test',
    payload: { title: 'Voice-Parität', prompt: 'Baue die gemeinsame Voice- und Text-Pipeline vollständig.', acceptanceCriteria: ['Tests grün'] },
  });
  assert.equal(codexCommand.action, 'codex.task.start');
  assert.equal(codexCommand.payload.title, 'Voice-Parität');
  assert.deepEqual(codexCommand.payload.acceptanceCriteria, ['Tests grün']);
  await assert.rejects(enqueueDeviceCommand({ action: 'codex.task.status', payload: { jobId: '../falsch' } }), /Ungültige/);
  await assert.rejects(enqueueDeviceCommand({ action: 'shell.run', payload: { command: 'rm -rf /' } }), /nicht freigegeben/);
  await assert.rejects(enqueueDeviceCommand({ action: 'app.open', payload: { app: 'Terminal' } }), /nicht freigegeben/);

  const { buildImacDeviceAgentLaunchAgent } = await import('../local-mac-helper/device-agent-launchd.mjs');
  console.log('Device-Control: LaunchAgent und Codex-Policy prüfen …');
  const plist = buildImacDeviceAgentLaunchAgent({ nodePath: '/node', cliPath: '/repo/local-mac-helper/cli.mjs' });
  assert.match(plist, /run-imac-device-agent-once/);
  assert.match(plist, /<integer>15<\/integer>/);
  const { codexTaskPolicy } = await import('../local-mac-helper/codex-tasks.mjs');
  const codexPolicy = codexTaskPolicy();
  assert.equal(codexPolicy.arbitraryWorkspace, false);
  assert.equal(codexPolicy.sandbox, 'workspace-write');
  assert.match(codexPolicy.workspace, /iva-core$/);

  const { imacDeviceAgentPolicy } = await import('../local-mac-helper/device-agent.mjs');
  const devicePolicy = imacDeviceAgentPolicy();
  assert.equal(devicePolicy.allowedActions.includes('portal.login'), true);
  assert.equal(devicePolicy.allowedActions.includes('portal.credentials.status'), true);

  const { builderSkill } = await import('../skills/builder.js');
  console.log('Device-Control: Builder-Werkzeug prüfen …');
  let dispatched = null;
  const tools = builderSkill({
    captureImprovementRequest: async input => ({ id: '11111111-1111-4111-8111-111111111111', ...input }),
    markImprovementRequestDispatched: async (id, value) => { dispatched = { id, ...value }; },
    enqueueDeviceCommand: async input => ({ id: '22222222-2222-4222-8222-222222222222', deviceId: IVA_IMAC_DEVICE_ID, status: 'queued', ...input }),
    deviceCommandStatus: async id => ({ id, status: 'completed' }),
  });
  const notOrdered = await tools.startIvaBuild.execute({ title: 'Test', request: 'Eine echte Funktion bauen', explicitlyOrdered: false });
  assert.equal(notOrdered.queued, false);
  const ordered = await tools.startIvaBuild.execute({ title: 'Test', request: 'Eine echte Funktion bauen', explicitlyOrdered: true, acceptanceCriteria: ['Tests grün'] });
  assert.equal(ordered.queued, true);
  assert.equal(dispatched.commandId, ordered.commandId);

  const { deviceControlSkill } = await import('../skills/device-control.js');
  let portalDispatch = null;
  const deviceTools = deviceControlSkill({
    enqueueDeviceCommand: async input => {
      portalDispatch = input;
      return { id: '33333333-3333-4333-8333-333333333333', deviceId: IVA_IMAC_DEVICE_ID, expiresAt: new Date().toISOString(), ...input };
    },
    deviceCommandStatus: async id => ({ id, status: 'completed' }),
  });
  const loginDispatch = await deviceTools.ensureImacPortalLogin.execute({ service: 'pipedrive' });
  assert.equal(loginDispatch.queued, true);
  assert.equal(portalDispatch.action, 'portal.login');
  assert.deepEqual(portalDispatch.payload, { service: 'pipedrive' });
  console.log('PASS IVA Device Control: ausgehender Gerätekanal, Lease-Schutz und enge Aktions-Positivliste.');
} finally {
  await rm(root, { recursive: true, force: true });
}
