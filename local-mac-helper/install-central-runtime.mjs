import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { activateCentralRuntime, centralRuntimeRoot, prepareCentralRuntime } from './central-runtime.mjs';
import { assertImacExecutionHost, fetchCentralRuntimeBundle, fetchImacDeviceAgentStatus } from './device-agent.mjs';
import { buildImacDeviceAgentLaunchAgent, imacDeviceAgentPlistFile, verifyImacDeviceAgentConnection } from './device-agent-launchd.mjs';

const exec = promisify(execFile);
export async function installCentralRuntime() {
  assertImacExecutionHost();
  const plist = imacDeviceAgentPlistFile();
  const previous = await readFile(plist, 'utf8');
  const baseline = await fetchImacDeviceAgentStatus();
  const workspace = path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/IVA-Assistent/iva-core');
  const oldRuntime = path.join(os.homedir(), 'Library/Application Support/IVA Mac Helper/runtime/imac-local-v4');
  const bundle = await fetchCentralRuntimeBundle();
  const target = await prepareCentralRuntime(bundle, { dependencyRoot: oldRuntime });
  await activateCentralRuntime(target);
  const runnerPath = path.join(centralRuntimeRoot(), 'current/local-mac-helper/device-agent-runner.mjs');
  const next = buildImacDeviceAgentLaunchAgent({ runnerPath, workspace, forecastRoot: path.join(oldRuntime, 'outputs/planbar-weekly') });
  const domain = `gui/${process.getuid()}`;
  await writeFile(`${plist}.before-central`, previous, { mode: 0o600 });
  await writeFile(plist, next, { mode: 0o600 });
  try {
    await exec('/usr/bin/plutil', ['-lint', plist]);
    await exec('/bin/launchctl', ['bootout', domain, plist]).catch(() => {});
    await exec('/bin/launchctl', ['bootstrap', domain, plist]);
    return await verifyImacDeviceAgentConnection({ baselineLastSeenAt: baseline.lastSeenAt, requiredRelease: bundle.version });
  } catch (error) {
    await exec('/bin/launchctl', ['bootout', domain, plist]).catch(() => {});
    await writeFile(plist, previous, { mode: 0o600 });
    await exec('/bin/launchctl', ['bootstrap', domain, plist]);
    throw new Error(`Zentrale Laufzeit nicht bestätigt; bisherige Installation wiederhergestellt: ${error.message}`);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  installCentralRuntime().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
