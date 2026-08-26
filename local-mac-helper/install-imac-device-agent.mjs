#!/usr/bin/env node
import { installImacDeviceAgentLaunchd } from './device-agent-launchd.mjs';

try {
  const result = await installImacDeviceAgentLaunchd();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`FEHLER: ${error?.message || error}`);
  process.exitCode = 1;
}
