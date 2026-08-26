import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';

const root = await mkdtemp(path.join(os.tmpdir(), 'iva-device-control-'));
process.env.DATA_DIR = root;
try {
  console.log('Device-Control: Store laden …');
  const {
    IVA_IMAC_DEVICE_ID,
    DEVICE_AGENT_PROTOCOL_VERSION,
    cancelDeviceCommand,
    claimNextDeviceCommand,
    completeDeviceCommand,
    deviceAgentStatus,
    deviceCommandStatus,
    enqueueDeviceCommand,
    listDeviceCommands,
    recordDeviceAgentHeartbeat,
  } = await import('../device-control/store.js');
  const command = await enqueueDeviceCommand({
    action: 'funding.monitor.status',
    requestedBy: 'test',
    requestText: 'Status auf dem iMac prüfen',
  });
  console.log('Device-Control: Queue und Lease prüfen …');
  assert.equal(command.deviceId, IVA_IMAC_DEVICE_ID);
  assert.equal(command.status, 'queued');
  assert.ok(Date.parse(command.expiresAt) - Date.now() > 23 * 60 * 60_000, 'iMac-Befehl wartet mindestens 23 Stunden auf die Attestierung');
  assert.equal(await claimNextDeviceCommand(IVA_IMAC_DEVICE_ID), null, 'der alte Agent darf keinen Befehl mehr verbrauchen');
  assert.equal((await deviceCommandStatus(command.id)).status, 'queued');
  assert.equal((await listDeviceCommands({ deviceId: IVA_IMAC_DEVICE_ID })).length, 1);

  console.log('Device-Control: wartenden Versandabbruch prüfen …');
  const canceledCommand = await enqueueDeviceCommand({ action: 'agent.status', requestedBy: 'test-cancel' });
  const canceled = await cancelDeviceCommand({
    commandId: canceledCommand.id,
    reason: 'Erst die dauerhafte iMac-Verbindung prüfen.',
  });
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.cancelReason, 'Erst die dauerhafte iMac-Verbindung prüfen.');
  assert.equal(await claimNextDeviceCommand(IVA_IMAC_DEVICE_ID), null, 'abgebrochene Befehle werden nicht mehr ausgeführt');
  await assert.rejects(cancelDeviceCommand({ commandId: canceledCommand.id }), /Nur ein wartender/);

  console.log('Device-Control: iMac-Attestierung und Migrationssperre prüfen …');
  const deferredProjectCommand = await enqueueDeviceCommand({
    action: 'project.workflow.run', requestedBy: 'test-deferred',
    payload: { projectId: 'heat-hero', workflowId: 'planbar-weekly-export', displayName: 'Planbar-Forecast' },
  });
  assert.ok(Date.parse(deferredProjectCommand.expiresAt) - Date.now() > 23 * 60 * 60_000, 'iMac-Workflow wartet mindestens 23 Stunden auf die Attestierung');
  assert.equal(await claimNextDeviceCommand(IVA_IMAC_DEVICE_ID), null, 'auch der Forecast bleibt bis zum v2-Heartbeat unangetastet');
  const imacMetadata = {
    hostname: 'iMac-von-Nadine.local',
    protocolVersion: DEVICE_AGENT_PROTOCOL_VERSION,
    release: 'test-v2',
    workspace: '/Users/nadine/Library/Mobile Documents/com~apple~CloudDocs/IVA-Assistent/iva-core',
    iCloudAuthoritative: true,
    allowedActions: ['agent.status', 'computer.status'],
  };
  await assert.rejects(
    recordDeviceAgentHeartbeat({ deviceId: IVA_IMAC_DEVICE_ID, ...imacMetadata, hostname: 'MacBook-Air-von-Nadine.local' }),
    /kein iMac/,
  );
  const heartbeat = await recordDeviceAgentHeartbeat({ deviceId: IVA_IMAC_DEVICE_ID, ...imacMetadata });
  assert.equal(heartbeat.attested, true);
  assert.equal(heartbeat.hostname, 'imac-von-nadine');
  assert.equal((await deviceAgentStatus()).online, true);
  await assert.rejects(claimNextDeviceCommand(IVA_IMAC_DEVICE_ID), /Attestierung/);
  await assert.rejects(
    claimNextDeviceCommand(IVA_IMAC_DEVICE_ID, { ...imacMetadata, hostname: 'iMac-Ersatz.local' }),
    /gebundene iMac/,
  );
  const initialAttestedClaim = await claimNextDeviceCommand(IVA_IMAC_DEVICE_ID, imacMetadata);
  assert.equal(initialAttestedClaim.id, command.id);
  assert.ok(initialAttestedClaim.leaseToken.length >= 32);
  await assert.rejects(
    completeDeviceCommand({ deviceId: IVA_IMAC_DEVICE_ID, commandId: command.id, leaseToken: 'falsch', ok: true, agentMetadata: imacMetadata }),
    /ungültig/,
  );
  const initialCompleted = await completeDeviceCommand({
    deviceId: IVA_IMAC_DEVICE_ID,
    commandId: command.id,
    leaseToken: initialAttestedClaim.leaseToken,
    ok: true,
    result: { online: true },
    agentMetadata: imacMetadata,
  });
  assert.equal(initialCompleted.status, 'completed');
  assert.equal((await deviceCommandStatus(command.id)).result.online, true);
  const attestedClaim = await claimNextDeviceCommand(IVA_IMAC_DEVICE_ID, imacMetadata);
  assert.equal(attestedClaim.id, deferredProjectCommand.id, 'der Forecast wird erst nach dem v2-iMac-Heartbeat freigegeben');
  assert.equal(attestedClaim.claimedBy.hostname, 'imac-von-nadine');
  await assert.rejects(completeDeviceCommand({
    deviceId: IVA_IMAC_DEVICE_ID,
    commandId: deferredProjectCommand.id,
    leaseToken: attestedClaim.leaseToken,
    ok: true,
    agentMetadata: { ...imacMetadata, hostname: 'iMac-Ersatz.local' },
  }), /Attestierung/);
  await completeDeviceCommand({
    deviceId: IVA_IMAC_DEVICE_ID,
    commandId: deferredProjectCommand.id,
    leaseToken: attestedClaim.leaseToken,
    ok: true,
    result: { online: true },
    agentMetadata: imacMetadata,
  });
  const agentStatusCommand = await enqueueDeviceCommand({ action: 'agent.status', requestedBy: 'test' });
  const agentStatusClaim = await claimNextDeviceCommand(IVA_IMAC_DEVICE_ID, imacMetadata);
  assert.equal(agentStatusClaim.id, agentStatusCommand.id);
  await completeDeviceCommand({
    deviceId: IVA_IMAC_DEVICE_ID,
    commandId: agentStatusCommand.id,
    leaseToken: agentStatusClaim.leaseToken,
    ok: true,
    result: { online: true },
    agentMetadata: imacMetadata,
  });
  const planbarCommand = await enqueueDeviceCommand({ action: 'planbar.search.refresh', requestedBy: 'test' });
  assert.equal(planbarCommand.action, 'planbar.search.refresh');
  assert.deepEqual(planbarCommand.payload, {});
  const schedulingCommand = await enqueueDeviceCommand({
    action: 'planbar.customer.schedule',
    requestedBy: 'test',
    payload: {
      customerName: 'Stefanie Schneider', isoYear: 2026, week: 39,
      partnerId: 'enter', partnerName: 'Enter', partnerPrefix: 'EN', schedulingMode: 'enter-block-first', allowFreeResourceFallback: true,
      materialDeliverySpace: true, theftWeatherProtected: false, additionalInfo: 'Hofzufahrt',
    },
  });
  assert.equal(schedulingCommand.action, 'planbar.customer.schedule');
  assert.equal(schedulingCommand.payload.customerName, 'Stefanie Schneider');
  const duplicateSchedulingCommand = await enqueueDeviceCommand({
    action: 'planbar.customer.schedule',
    requestedBy: 'test-duplicate',
    payload: schedulingCommand.payload,
  });
  assert.equal(duplicateSchedulingCommand.id, schedulingCommand.id, 'derselbe offene Kunden-KW-Auftrag wird nicht doppelt eingereiht');
  await assert.rejects(enqueueDeviceCommand({
    action: 'planbar.customer.schedule',
    payload: { customerName: 'Stefanie Schneider', partnerId: 'heat-hero', partnerName: 'Heat Hero', partnerPrefix: 'HH', isoYear: 2026, week: 39 },
  }), /Materialfragen/);
  const projectWorkflowCommand = await enqueueDeviceCommand({
    action: 'project.workflow.run', requestedBy: 'test',
    payload: { projectId: 'heat-hero', workflowId: 'planbar-weekly-export', displayName: 'Meine Planbar-Liste' },
  });
  assert.deepEqual(projectWorkflowCommand.payload, { projectId: 'heat-hero', workflowId: 'planbar-weekly-export', displayName: 'Meine Planbar-Liste' });
  await assert.rejects(enqueueDeviceCommand({ action: 'project.workflow.run', payload: { projectId: 'heat-hero', workflowId: 'unbekannt' } }), /nicht freigegeben/);
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

  const { buildImacDeviceAgentLaunchAgent, verifyImacDeviceAgentConnection } = await import('../local-mac-helper/device-agent-launchd.mjs');
  console.log('Device-Control: LaunchAgent und Codex-Policy prüfen …');
  const plist = buildImacDeviceAgentLaunchAgent({
    nodePath: '/node',
    runnerPath: '/Users/nadine/Library/Application Support/IVA Mac Helper/runtime/imac-local-v4/local-mac-helper/device-agent-runner.mjs',
    workspace: '/Users/nadine/Library/Mobile Documents/com~apple~CloudDocs/IVA-Assistent/iva-core',
    forecastRoot: '/Users/nadine/Library/Application Support/IVA Mac Helper/runtime/imac-local-v4/outputs/planbar-weekly',
  });
  assert.match(plist, /runtime\/imac-local-v4\/local-mac-helper\/device-agent-runner\.mjs/);
  assert.match(plist, /<key>IVA_DEVICE_WORKSPACE<\/key>/);
  assert.match(plist, /<key>IVA_DEVICE_LOCAL_RUNTIME<\/key><string>true<\/string>/);
  assert.match(plist, /<key>IVA_PLANBAR_OUTPUT_ROOT<\/key>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.doesNotMatch(plist, /StartInterval/);
  const connectionStatuses = [
    { online: true, deviceId: IVA_IMAC_DEVICE_ID, hostname: 'imac-von-nadine', release: 'imac-local-v4', lastSeenAt: '2026-08-26T10:00:05.000Z' },
    { online: true, deviceId: IVA_IMAC_DEVICE_ID, hostname: 'imac-von-nadine', release: 'imac-local-v4', lastSeenAt: '2026-08-26T10:00:20.000Z' },
  ];
  const verifiedConnection = await verifyImacDeviceAgentConnection({
    baselineLastSeenAt: '2026-08-26T10:00:00.000Z',
    getStatus: async () => connectionStatuses.shift() || connectionStatuses.at(-1),
    timeoutMs: 100,
    pollMs: 1,
    minimumAdvanceMs: 10_000,
  });
  assert.equal(verifiedConnection.verified, true);
  assert.equal(verifiedConnection.secondVerifiedHeartbeatAt, '2026-08-26T10:00:20.000Z');
  await assert.rejects(
    verifyImacDeviceAgentConnection({
      baselineLastSeenAt: '2026-08-26T10:00:00.000Z',
      getStatus: async () => ({ online: true, release: 'imac-local-v4', lastSeenAt: '2026-08-26T10:00:05.000Z' }),
      timeoutMs: 20,
      pollMs: 1,
      minimumAdvanceMs: 10_000,
    }),
    /keine zwei fortlaufenden Railway-Heartbeats/,
    'ein einzelner oder stehengebliebener Heartbeat darf die Installation nicht grün melden',
  );
  const { codexTaskPolicy, inferProjectWorkflowStatus, startProjectWorkflowTask } = await import('../local-mac-helper/codex-tasks.mjs');
  const codexPolicy = codexTaskPolicy();
  assert.equal(codexPolicy.arbitraryWorkspace, false);
  assert.equal(codexPolicy.sandbox, 'workspace-write');
  assert.match(codexPolicy.workspace, /iva-core$/);
  const directForecast = await startProjectWorkflowTask({
    workflowId: 'planbar-weekly-export',
    findPreparedForecast: async () => ({ directory: '/prepared/forecast' }),
    sendPreparedForecast: async directory => ({ sent: true, sentFolderVerified: true, directory }),
  });
  assert.deepEqual(directForecast, { sent: true, sentFolderVerified: true, directory: '/prepared/forecast' });
  const bootstrapSource = await readFile(new URL('../IVA-iMac-einmalig-verbinden.command', import.meta.url), 'utf8');
  assert.match(bootstrapSource, /nodejs\.org\/dist\/\$\{node_version\}/);
  assert.match(bootstrapSource, /shasum -a 256/);
  assert.doesNotMatch(bootstrapSource, /run-imac-device-agent-once/);
  assert.doesNotMatch(bootstrapSource, /local-mac-helper\/cli\.mjs install-imac-device-agent/);
  assert.match(bootstrapSource, /local-mac-helper\/install-imac-device-agent\.mjs/);
  assert.match(bootstrapSource, /IVA lädt die aktuelle iMac-Komponente aus iCloud/);
  assert.match(bootstrapSource, /IVA-DIREKTSTART 8817760/);
  assert.match(bootstrapSource, /Zwei fortlaufende Railway-Heartbeats wurden bestätigt/);
  const finalBootstrapSource = await readFile(new URL('../IVA-iMac-JETZT-fertigstellen.command', import.meta.url), 'utf8');
  assert.match(finalBootstrapSource, /8817760c6fbb986a028ec583974513042f531c58/);
  assert.match(finalBootstrapSource, /c5b2a1fcfb007c74a7cb85ed6d11601218be722772186c3158a0a2bb9db04171/);
  assert.match(finalBootstrapSource, /IVA_DEVICE_RUNTIME_SOURCE="\$snapshot"/);
  assert.match(finalBootstrapSource, /4\/4 – Dauerverbindung wird umgeschaltet und doppelt geprüft/);
  const codexTaskSource = await readFile(new URL('../local-mac-helper/codex-tasks.mjs', import.meta.url), 'utf8');
  assert.match(codexTaskSource, /'exec', '--approve-for-me'/);
  assert.match(codexTaskSource, /withMacWakeGuard\(\(\) => runCodexTaskWithoutWakeGuard/);
  assert.match(codexTaskSource, /delete childEnv\.IVA_MAC_WAKE_GUARD_ACTIVE/);
  assert.doesNotMatch(codexTaskSource, /'--sandbox'[^\n]+?'--approve-for-me'/, 'Codex CLI erlaubt --sandbox nicht zusammen mit --approve-for-me');
  assert.equal(inferProjectWorkflowStatus('Status: **fachlich blockiert**.\n\nGrund: Pflichtdaten fehlen.'), 'blocked');
  assert.equal(inferProjectWorkflowStatus('Status: technisch blockiert\nKeine Schreibaktion.'), 'blocked');
  assert.equal(inferProjectWorkflowStatus('Status: erfolgreich\nKeine Blocker vorhanden.'), '');
  const deviceAgentRunnerSource = await readFile(new URL('../local-mac-helper/device-agent-runner.mjs', import.meta.url), 'utf8');
  assert.match(deviceAgentRunnerSource, /DEVICE_AGENT_HARD_TIMEOUT_MS = 240_000/, 'der äußere Agent darf die 180-Sekunden-Planbar-Prüfung nicht vorzeitig abbrechen');
  assert.match(deviceAgentRunnerSource, /DEVICE_AGENT_POLL_INTERVAL_MS = 15_000/);
  assert.match(deviceAgentRunnerSource, /await reportBootstrapHeartbeat\(\)/);
  assert.match(deviceAgentRunnerSource, /'X-IVA-Agent-Workspace': metadata\.workspace/);
  assert.match(deviceAgentRunnerSource, /spawn\('\/usr\/bin\/caffeinate', \['-s', '-w'/);
  assert.match(deviceAgentRunnerSource, /updateLocalRunnerFromIcloud/);
  const deviceAgentRuntimeSource = await readFile(new URL('../local-mac-helper/device-agent.mjs', import.meta.url), 'utf8');
  assert.match(deviceAgentRuntimeSource, /runtimeMode: process\.env\.IVA_DEVICE_LOCAL_RUNTIME === 'true' \? 'local' : 'icloud'/);
  assert.match(deviceAgentRuntimeSource, /'codex\.task\.start'/);
  assert.match(deviceAgentRunnerSource, /LOCAL_RUNTIME \? path\.join\(LOCAL_HELPER_DIR, 'device-agent\.mjs'\)/);
  assert.match(deviceAgentRunnerSource, /scheduleLocalRuntimeMigration/);
  assert.match(deviceAgentRunnerSource, /de\.iva\.device-agent-migrator/);
  assert.match(deviceAgentRunnerSource, /IVA_DEVICE_MIGRATOR/);
  assert.match(deviceAgentRunnerSource, /ensureVerifiedBootstrapSnapshot/);
  assert.match(deviceAgentRunnerSource, /c5b2a1fcfb007c74a7cb85ed6d11601218be722772186c3158a0a2bb9db04171/);
  assert.match(deviceAgentRunnerSource, /IVA_DEVICE_RUNTIME_SOURCE/);
  assert.doesNotMatch(deviceAgentRunnerSource, /preserveTimestamps:\s*true/);
  assert.match(deviceAgentRunnerSource, /error\?\.code === 'ENOENT'/);
  const deviceAgentLaunchdSource = await readFile(new URL('../local-mac-helper/device-agent-launchd.mjs', import.meta.url), 'utf8');
  assert.match(deviceAgentLaunchdSource, /previousPlist/);
  assert.match(deviceAgentLaunchdSource, /vorheriger Agent wurde wiederhergestellt/);
  assert.match(deviceAgentLaunchdSource, /IVA_DEVICE_RUNTIME_SOURCE/);
  assert.doesNotMatch(deviceAgentLaunchdSource, /preserveTimestamps:\s*true/);
  const planbarForecastSource = await readFile(new URL('../local-mac-helper/planbar-forecast-mail.mjs', import.meta.url), 'utf8');
  assert.match(planbarForecastSource, /IVA_PLANBAR_OUTPUT_ROOT/);
  const dedicatedInstallerSource = await readFile(new URL('../local-mac-helper/install-imac-device-agent.mjs', import.meta.url), 'utf8');
  assert.match(dedicatedInstallerSource, /IVA_DEVICE_MIGRATOR/);
  assert.match(dedicatedInstallerSource, /currentPlist\.includes\(imacDeviceAgentLocalRunnerFile\(\)\)/);
  assert.match(deviceAgentRunnerSource, /deviceAgentSourceFingerprint/);
  assert.ok(
    deviceAgentRunnerSource.indexOf('await reportBootstrapHeartbeat()') < deviceAgentRunnerSource.indexOf('await loadDeviceAgent()'),
    'der eigenständige Heartbeat läuft vor dem vollständigen iCloud-Modulimport',
  );

  const { assertImacExecutionHost, imacDeviceAgentPolicy, isAllowedImacExecutionHost, isAuthoritativeIcloudWorkspace } = await import('../local-mac-helper/device-agent.mjs');
  const deviceAgentSource = await readFile(new URL('../local-mac-helper/device-agent.mjs', import.meta.url), 'utf8');
  assert.match(deviceAgentSource, /status_probe/);
  assert.match(deviceAgentSource, /probe-retry-required/);
  assert.equal(isAllowedImacExecutionHost('iMac-von-Nadine.local'), true);
  assert.equal(isAllowedImacExecutionHost('MacBook-Air-von-Nadine.local'), false);
  assert.equal(isAllowedImacExecutionHost('Arbeitsrechner.local', 'Arbeitsrechner.local'), true);
  assert.throws(() => assertImacExecutionHost('MacBook-Air-von-Nadine.local'), /darf auf diesem Rechner nicht laufen/);
  assert.equal(isAuthoritativeIcloudWorkspace('/Users/nadine/Library/Mobile Documents/com~apple~CloudDocs/IVA-Assistent/iva-core'), true);
  assert.equal(isAuthoritativeIcloudWorkspace('/Users/nadine/iva-core'), false);
  const devicePolicy = imacDeviceAgentPolicy();
  assert.equal(devicePolicy.protocolVersion, DEVICE_AGENT_PROTOCOL_VERSION);
  assert.equal(devicePolicy.iCloudAuthoritative, isAuthoritativeIcloudWorkspace(devicePolicy.workspace));
  assert.equal(devicePolicy.allowedActions.includes('agent.status'), true);
  assert.equal(devicePolicy.allowedActions.includes('portal.login'), true);
  assert.equal(devicePolicy.allowedActions.includes('portal.credentials.status'), true);
  assert.equal(devicePolicy.allowedActions.includes('project.workflow.run'), true);
  assert.equal(devicePolicy.allowedActions.includes('planbar.customer.schedule'), true);

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

  const { planbarSkill } = await import('../skills/planbar.js');
  let planbarDispatch = null;
  const planbarTools = planbarSkill({
    searchPlanbarAppointments: async () => ({ matches: [] }),
    getProject: async () => ({ customerSchedulingPartners: [{ id: 'heat-hero', name: 'Heat Hero', prefix: 'HH', schedulingMode: 'free-resource' }] }),
    enqueueDeviceCommand: async input => {
      planbarDispatch = input;
      return { id: '44444444-4444-4444-8444-444444444444', deviceId: IVA_IMAC_DEVICE_ID, status: 'queued', ...input };
    },
    deviceCommandStatus: async id => ({ id, status: 'completed' }),
  });
  const scheduled = await planbarTools.scheduleCustomerInPlanbar.execute({
    customerName: 'Stefanie Schneider', isoYear: 2026, week: 39,
    partnerId: 'enter', partnerName: 'Enter', partnerPrefix: 'EN', schedulingMode: 'enter-block-first', allowFreeResourceFallback: true,
    materialDeliverySpace: true, theftWeatherProtected: false,
  });
  assert.equal(scheduled.queued, true);
  assert.equal(planbarDispatch.action, 'planbar.customer.schedule');
  assert.equal(planbarDispatch.payload.week, 39);
  assert.equal((await planbarTools.listPlanbarCustomerTypes.execute({})).customerTypes[0].prefix, 'HH');
  console.log('PASS IVA Device Control: ausgehender Gerätekanal, Lease-Schutz und enge Aktions-Positivliste.');
} finally {
  await rm(root, { recursive: true, force: true });
}
