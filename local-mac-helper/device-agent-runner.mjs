import { runImacDeviceAgentOnce } from './device-agent.mjs';

try {
  const result = await Promise.race([
    runImacDeviceAgentOnce(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Der IVA-Geräteabruf hat nach 75 Sekunden das harte Zeitlimit erreicht.')), 75_000)),
  ]);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} catch (error) {
  console.error(`Fehler: ${error?.message || error}`);
  process.exit(1);
}
