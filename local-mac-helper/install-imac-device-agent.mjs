#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { imacDeviceAgentLocalRunnerFile, imacDeviceAgentPlistFile, installImacDeviceAgentLaunchd } from './device-agent-launchd.mjs';

try {
  if (process.env.IVA_DEVICE_MIGRATOR === 'true') {
    const currentPlist = await readFile(imacDeviceAgentPlistFile(), 'utf8').catch(() => '');
    if (currentPlist.includes(imacDeviceAgentLocalRunnerFile())) {
      console.log('Die lokale IVA-iMac-Laufzeit ist bereits dauerhaft eingerichtet.');
      process.exit(0);
    }
  }
  const result = await installImacDeviceAgentLaunchd();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`FEHLER: ${error?.message || error}`);
  process.exitCode = 1;
}
