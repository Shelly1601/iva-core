import { runImacDeviceAgentOnce } from './device-agent.mjs';

export const DEVICE_AGENT_HARD_TIMEOUT_MS = 240_000;
export const DEVICE_AGENT_POLL_INTERVAL_MS = 15_000;

async function runWithTimeout() {
  let timeout;
  try {
    return await Promise.race([
      runImacDeviceAgentOnce(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Der IVA-Geräteabruf hat nach 240 Sekunden das harte Zeitlimit erreicht.')), DEVICE_AGENT_HARD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

for (;;) {
  try {
    console.log(JSON.stringify(await runWithTimeout(), null, 2));
  } catch (error) {
    console.error(`Fehler: ${error?.message || error}`);
  }
  await new Promise(resolve => setTimeout(resolve, DEVICE_AGENT_POLL_INTERVAL_MS));
}
