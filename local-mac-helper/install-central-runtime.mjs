import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { activateCentralRuntime, centralRuntimeRoot, prepareCentralRuntime } from './central-runtime.mjs';
import { assertImacExecutionHost, DEVICE_AGENT_RELEASE, fetchCentralRuntimeBundle, fetchImacDeviceAgentStatus } from './device-agent.mjs';
import { buildImacDeviceAgentLaunchAgent, imacDeviceAgentPlistFile, verifyImacDeviceAgentConnection } from './device-agent-launchd.mjs';
import { EXECUTION_WORKSPACE } from './execution-host-policy.mjs';

const exec = promisify(execFile);
export async function installCentralRuntime() {
  assertImacExecutionHost();
  const plist = imacDeviceAgentPlistFile();
  const previous = await readFile(plist, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  const baseline = await fetchImacDeviceAgentStatus().catch(() => ({}));
  const workspace = EXECUTION_WORKSPACE;
  const oldRuntime = path.join(centralRuntimeRoot(), 'current');
  const helperRoot = path.join(os.homedir(), 'Library/Application Support/IVA Mac Helper');
  await mkdir(path.dirname(plist), { recursive: true, mode: 0o700 });
  await mkdir(path.join(helperRoot, 'logs'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(helperRoot, 'outputs/planbar-weekly'), { recursive: true, mode: 0o700 });
  const bundle = await fetchCentralRuntimeBundle();
  const target = await prepareCentralRuntime(bundle, { dependencyRoot: oldRuntime });
  await activateCentralRuntime(target);
  const runnerPath = path.join(centralRuntimeRoot(), 'current/local-mac-helper/device-agent-runner.mjs');
  const next = buildImacDeviceAgentLaunchAgent({ runnerPath, workspace, forecastRoot: path.join(helperRoot, 'outputs/planbar-weekly') });
  const domain = `gui/${process.getuid()}`;
  if (previous) await writeFile(`${plist}.before-central`, previous, { mode: 0o600 });
  await writeFile(plist, next, { mode: 0o600 });
  try {
    await exec('/usr/bin/plutil', ['-lint', plist]);
    await exec('/bin/launchctl', ['bootout', domain, plist]).catch(() => {});
    await exec('/bin/launchctl', ['bootstrap', domain, plist]);
    return await verifyImacDeviceAgentConnection({ baselineLastSeenAt: baseline.lastSeenAt, requiredRelease: DEVICE_AGENT_RELEASE });
  } catch (error) {
    await exec('/bin/launchctl', ['bootout', domain, plist]).catch(() => {});
    if (previous) {
      await writeFile(plist, previous, { mode: 0o600 });
      await exec('/bin/launchctl', ['bootstrap', domain, plist]);
    } else await unlink(plist).catch(() => {});
    throw new Error(`Zentrale Laufzeit nicht bestätigt; bisherige Installation wiederhergestellt: ${error.message}`);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  installCentralRuntime().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
