import { runImacDeviceAgentOnce } from './device-agent.mjs';

export const DEVICE_AGENT_HARD_TIMEOUT_MS = 240_000;

try {
  const result = await Promise.race([
    runImacDeviceAgentOnce(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Der IVA-Geräteabruf hat nach 240 Sekunden das harte Zeitlimit erreicht.')), DEVICE_AGENT_HARD_TIMEOUT_MS)),
  ]);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} catch (error) {
  console.error(`Fehler: ${error?.message || error}`);
  process.exit(1);
}
