import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

const root = await mkdtemp(path.join(os.tmpdir(), 'iva-device-control-'));
process.env.DATA_DIR = root;
try {
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
  await assert.rejects(enqueueDeviceCommand({ action: 'shell.run', payload: { command: 'rm -rf /' } }), /nicht freigegeben/);
  await assert.rejects(enqueueDeviceCommand({ action: 'app.open', payload: { app: 'Terminal' } }), /nicht freigegeben/);

  const { buildImacDeviceAgentLaunchAgent } = await import('../local-mac-helper/device-agent-launchd.mjs');
  const plist = buildImacDeviceAgentLaunchAgent({ nodePath: '/node', cliPath: '/repo/local-mac-helper/cli.mjs' });
  assert.match(plist, /run-imac-device-agent-once/);
  assert.match(plist, /<integer>15<\/integer>/);
  console.log('PASS IVA Device Control: ausgehender Gerätekanal, Lease-Schutz und enge Aktions-Positivliste.');
} finally {
  await rm(root, { recursive: true, force: true });
}
