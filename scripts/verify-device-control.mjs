import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, readlink, realpath, symlink, writeFile, rm } from 'node:fs/promises';

const root = await mkdtemp(path.join(os.tmpdir(), 'iva-device-control-'));
process.env.DATA_DIR = root;
try {
  const { deviceCommandNeedsImmediateUiLock } = await import('../local-mac-helper/device-agent.mjs');
  assert.equal(deviceCommandNeedsImmediateUiLock('project.workflow.run'), false, 'Workflow-Starts müssen ohne UI-Sperre eingereiht werden; der Worker wartet selbst auf den freien iMac');
  assert.equal(deviceCommandNeedsImmediateUiLock('app.open'), true, 'Direkte App-Bedienung bleibt UI-gesperrt');
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
    allowedActions: ['agent.status', 'computer.status', 'funding.monitor.status', 'funding.legacy-monitor.suspend', 'project.workflow.run', 'planbar.search.refresh', 'planbar.customer.schedule', 'portal.login', 'portal.credentials.status', 'codex.task.start', 'codex.task.status', 'app.open'],
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
  const { allowedActions: _omittedForHeaderOnlyClaim, ...headerOnlyMetadata } = imacMetadata;
  const agentStatusClaim = await claimNextDeviceCommand(IVA_IMAC_DEVICE_ID, headerOnlyMetadata);
  assert.equal(agentStatusClaim.id, agentStatusCommand.id);
  assert.equal(agentStatusClaim.claimedBy.allowedActions.includes('agent.status'), true, 'der GET-Abruf übernimmt die zuvor attestierte Positivliste');
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
  const duplicatePlanbarCommand = await enqueueDeviceCommand({ action: 'planbar.search.refresh', requestedBy: 'second-visitor' });
  assert.equal(duplicatePlanbarCommand.id, planbarCommand.id, 'parallele direkte Planbar-Reads teilen denselben queued/running Command');
  const busyPlanbarClaim = await claimNextDeviceCommand(IVA_IMAC_DEVICE_ID, { ...imacMetadata, uiBusy: true });
  assert.equal(busyPlanbarClaim.id, planbarCommand.id, 'die reine Planbar-Live-Lesung darf trotz belegter UI sofort laufen');
  await completeDeviceCommand({
    deviceId: IVA_IMAC_DEVICE_ID,
    commandId: planbarCommand.id,
    leaseToken: busyPlanbarClaim.leaseToken,
    ok: true,
    result: { refreshMode: 'direct-live-read' },
    agentMetadata: { ...imacMetadata, uiBusy: true },
  });
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
  assert.deepEqual(projectWorkflowCommand.payload, { projectId: 'heat-hero', workflowId: 'planbar-weekly-export', displayName: 'Meine Planbar-Liste', runMode: 'manual' });
  const installationPlanCommand = await enqueueDeviceCommand({
    action: 'project.workflow.run', requestedBy: 'test-installation-plan',
    payload: { projectId: 'heat-hero', workflowId: 'installation-plan-material-list', displayName: 'Installationsplan als Materialliste' },
  });
  assert.equal(installationPlanCommand.payload.workflowId, 'installation-plan-material-list');
  const dewarmteCommand = await enqueueDeviceCommand({
    action: 'project.workflow.run', requestedBy: 'test-dewarmte-link',
    payload: {
      projectId: 'dewarmte', workflowId: 'dewarmte-link-to-material-pdf', displayName: 'Link → Materialliste',
      sourceUrl: 'https://docs.google.com/document/d/test/edit#section', deliveryMode: 'email-draft', recipientEmail: 'nadine@example.com',
    },
  });
  assert.equal(dewarmteCommand.payload.sourceUrl, 'https://docs.google.com/document/d/test/edit');
  assert.equal(dewarmteCommand.payload.deliveryMode, 'email-draft');
  assert.equal(dewarmteCommand.payload.supplementaryText || '', '');
  await assert.rejects(enqueueDeviceCommand({
    action: 'project.workflow.run', payload: { projectId: 'dewarmte', workflowId: 'dewarmte-link-to-material-pdf', sourceUrl: 'https://localhost/plan.pdf' },
  }), /öffentlichen HTTPS-Link/);
  const fundingSequenceCommand = await enqueueDeviceCommand({
    action: 'project.workflow.run', requestedBy: 'test-funding-scheduler',
    payload: { projectId: 'heat-hero', workflowId: 'funding-daily-sequence', displayName: 'Förderung – Tageslauf 1 → 2 → 3' },
  });
  assert.equal(fundingSequenceCommand.payload.workflowId, 'funding-daily-sequence');
  const duplicateFundingSequence = await enqueueDeviceCommand({
    action: 'project.workflow.run', requestedBy: 'test-funding-retry', payload: fundingSequenceCommand.payload,
  });
  assert.equal(duplicateFundingSequence.id, fundingSequenceCommand.id, 'derselbe offene Förder-Tageslauf wird nicht doppelt eingereiht');
  const suspendLegacyFunding = await enqueueDeviceCommand({ action: 'funding.legacy-monitor.suspend', requestedBy: 'test' });
  assert.equal(suspendLegacyFunding.action, 'funding.legacy-monitor.suspend');
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
  assert.equal(codexCommand.payload.mode, 'build');
  assert.deepEqual(codexCommand.payload.acceptanceCriteria, ['Tests grün']);
  const operationalCodexCommand = await enqueueDeviceCommand({
    action: 'codex.task.start', requestedBy: 'test-operation',
    payload: { title: 'iMac-Dateiprüfung', requestId: 'test-operation-1', prompt: 'Prüfe den gemeinsamen Arbeitsordner auf dem iMac rein lesend.', mode: 'operational' },
  });
  assert.equal(operationalCodexCommand.payload.mode, 'operational');
  const duplicateOperationalCodexCommand = await enqueueDeviceCommand({
    action: 'codex.task.start', requestedBy: 'test-operation-retry',
    payload: { title: 'Anderer Titel', requestId: 'test-operation-1', prompt: 'Dieser Auftrag darf nicht zusätzlich eingereiht werden.', mode: 'operational' },
  });
  assert.equal(duplicateOperationalCodexCommand.id, operationalCodexCommand.id, 'dieselbe offene iMac-Operations-ID wird nur einmal eingereiht');
  const chatGptCommand = await enqueueDeviceCommand({ action: 'app.open', payload: { app: 'ChatGPT' }, requestedBy: 'test' });
  assert.deepEqual(chatGptCommand.payload, { app: 'ChatGPT' });
  await assert.rejects(enqueueDeviceCommand({ action: 'codex.task.status', payload: { jobId: '../falsch' } }), /Ungültige/);
  await assert.rejects(enqueueDeviceCommand({ action: 'shell.run', payload: { command: 'rm -rf /' } }), /nicht freigegeben/);
  await assert.rejects(enqueueDeviceCommand({ action: 'app.open', payload: { app: 'Terminal' } }), /nicht freigegeben/);

  const { buildImacDeviceAgentLaunchAgent, verifyImacDeviceAgentConnection } = await import('../local-mac-helper/device-agent-launchd.mjs');
  const { DEVICE_AGENT_RELEASE } = await import('../local-mac-helper/device-agent.mjs');
  console.log('Device-Control: LaunchAgent und Codex-Policy prüfen …');
  const plist = buildImacDeviceAgentLaunchAgent({
    nodePath: '/node',
    runnerPath: '/Users/nadine/Library/Application Support/IVA Mac Helper/runtime/imac-central-v5/local-mac-helper/device-agent-runner.mjs',
    workspace: '/Users/nadine/Library/Mobile Documents/com~apple~CloudDocs/IVA-Assistent/iva-core',
    forecastRoot: '/Users/nadine/Library/Application Support/IVA Mac Helper/runtime/imac-central-v5/outputs/planbar-weekly',
  });
  assert.match(plist, /runtime\/imac-central-v5\/local-mac-helper\/device-agent-runner\.mjs/);
  assert.match(plist, /<key>IVA_DEVICE_WORKSPACE<\/key>/);
  assert.match(plist, /<key>IVA_DEVICE_LOCAL_RUNTIME<\/key><string>true<\/string>/);
  assert.match(plist, /<key>IVA_PLANBAR_OUTPUT_ROOT<\/key>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.doesNotMatch(plist, /StartInterval/);
  const connectionStatuses = [
    { online: true, deviceId: IVA_IMAC_DEVICE_ID, hostname: 'imac-von-nadine', release: DEVICE_AGENT_RELEASE, lastSeenAt: '2026-08-26T10:00:05.000Z' },
    { online: true, deviceId: IVA_IMAC_DEVICE_ID, hostname: 'imac-von-nadine', release: DEVICE_AGENT_RELEASE, lastSeenAt: '2026-08-26T10:00:20.000Z' },
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
      getStatus: async () => ({ online: true, release: DEVICE_AGENT_RELEASE, lastSeenAt: '2026-08-26T10:00:05.000Z' }),
      timeoutMs: 20,
      pollMs: 1,
      minimumAdvanceMs: 10_000,
    }),
    /keine zwei fortlaufenden Railway-Heartbeats/,
    'ein einzelner oder stehengebliebener Heartbeat darf die Installation nicht grün melden',
  );
  const { codexJobIdForRequest, codexTaskPolicy, inferProjectWorkflowStatus, startProjectWorkflowTask } = await import('../local-mac-helper/codex-tasks.mjs');
  const stableJobId = codexJobIdForRequest('same-command');
  assert.equal(codexJobIdForRequest('same-command'), stableJobId);
  assert.match(stableJobId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(codexJobIdForRequest('other-command'), stableJobId);
  const codexPolicy = codexTaskPolicy();
  assert.equal(codexPolicy.arbitraryWorkspace, false);
  assert.equal(codexPolicy.sandbox, 'workspace-write');
  assert.equal(path.isAbsolute(codexPolicy.workspace), true);
  assert.equal(codexPolicy.iCloudMaterialization, true);
  const { materializeIcloudWorkspace } = await import('../local-mac-helper/icloud-workspace.mjs');
  let downloadRequested = false;
  const downloadTargets = [];
  let readAttempts = 0;
  const materialized = await materializeIcloudWorkspace({
    workspace: '/Users/nadine/Library/Mobile Documents/com~apple~CloudDocs/IVA-Assistent/iva-core',
    exec: async (command, args) => {
      assert.equal(command, '/usr/bin/brctl');
      assert.equal(args[0], 'download');
      downloadRequested = true;
      downloadTargets.push(args[1]);
    },
    read: async () => {
      readAttempts += 1;
      if (readAttempts === 1) throw Object.assign(new Error('Resource deadlock avoided'), { code: 'EDEADLK' });
      return Buffer.from('ready');
    },
    waitFn: async () => {},
  });
  assert.equal(downloadRequested, true);
  assert.equal(materialized.materialized, true);
  assert.equal(materialized.probes.length, 4);
  assert.equal(downloadTargets.some(target => target.endsWith('/AGENTS.md')), true, 'die übergeordnete Regeldatei wird gezielt materialisiert');
  assert.equal(readAttempts, 5, 'ein vorübergehender iCloud-Deadlock wird wiederholt');
  const directForecast = await startProjectWorkflowTask({
    workflowId: 'planbar-weekly-export',
    runMode: 'automatic',
    automationSlotKey: 'planbar-weekly-export:weekly:2026-W35',
    startTask: async request => ({ status: 'queued', workflowId: request.workflowId, prompt: request.prompt }),
  });
  assert.equal(directForecast.status, 'queued');
  assert.equal(directForecast.workflowId, 'planbar-weekly-export');
  assert.match(directForecast.prompt, /--run-mode automatic --automation-slot/);
  const directManualForecast = await startProjectWorkflowTask({
    workflowId: 'planbar-weekly-export',
    runMode: 'manual',
    requestId: 'planbar-weekly-export:manual:1787983200000',
    startTask: async request => ({ status: 'queued', workflowId: request.workflowId, prompt: request.prompt }),
  });
  assert.equal(directManualForecast.status, 'queued');
  assert.equal(directManualForecast.workflowId, 'planbar-weekly-export');
  assert.match(directManualForecast.prompt, /--run-mode manual --delivery-run/);
  const directInstallationPlan = await startProjectWorkflowTask({
    workflowId: 'installation-plan-material-list',
    requestId: 'installation-plan-material-list:test',
    startTask: async request => ({ status: 'queued', workflowId: request.workflowId, prompt: request.prompt, acceptanceCriteria: request.acceptanceCriteria }),
  });
  assert.equal(directInstallationPlan.workflowId, 'installation-plan-material-list');
  assert.match(directInstallationPlan.prompt, /ausschließlich lesend/);
  assert.match(directInstallationPlan.prompt, /HEAT\|Hero Material/);
  assert.match(directInstallationPlan.prompt, /Bestellseiten.*HEAT\|Hero und DeWarmte/);
  assert.equal(directInstallationPlan.acceptanceCriteria.some(item => /nichts.*gelöscht/.test(item)), true);
  const directDewarmte = await startProjectWorkflowTask({
    workflowId: 'dewarmte-link-to-material-pdf',
    requestId: 'dewarmte-link-pdf:test',
    workflowInput: { sourceUrl: 'https://example.com/installation.pdf', deliveryMode: 'email-send', recipientEmail: 'nadine@example.com' },
    startTask: async request => ({ projectId: request.projectId, workflowId: request.workflowId, prompt: request.prompt }),
  });
  assert.equal(directDewarmte.projectId, 'dewarmte');
  assert.match(directDewarmte.prompt, /publish-dewarmte-pdf/);
  assert.match(directDewarmte.prompt, /deliver-dewarmte-pdf/);
  assert.match(directDewarmte.prompt, /unveränderte erste Seite der Installationsplanung/);
  assert.match(directDewarmte.prompt, /DeWarmte Material/);
  assert.match(directDewarmte.prompt, /HEAT\|Hero Material/);
  assert.match(directDewarmte.prompt, /dewarmte-order-pages\.mjs/);
  assert.match(directDewarmte.prompt, /progress .* implementing/);
  assert.match(directDewarmte.prompt, /progress .* testing/);
  assert.doesNotMatch(directDewarmte.prompt, /Postfachsuche durchführen/);
  const dewarmteSupplementRequest = 'dewarmte-link-pdf:supplement-test';
  const dewarmteSupplementJobId = codexJobIdForRequest(dewarmteSupplementRequest);
  const directDewarmteSupplement = await startProjectWorkflowTask({
    workflowId: 'dewarmte-link-to-material-pdf', requestId: dewarmteSupplementRequest,
    workflowInput: {
      sourceUrl: 'https://example.com/installation.pdf', deliveryMode: 'download',
      supplementaryText: 'Stahl/Kupfer und Pressfittings bevorzugen.',
      supplementaryPdfId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', supplementaryPdfName: 'Startvoorraad.pdf',
      supplementaryPdfPath: path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper', 'dewarmte-inputs', dewarmteSupplementJobId, 'Startvoorraad.pdf'),
    },
    startTask: async request => ({ prompt: request.prompt, acceptanceCriteria: request.acceptanceCriteria }),
  });
  assert.match(directDewarmteSupplement.prompt, /Stahl\/Kupfer und Pressfittings/);
  assert.match(directDewarmteSupplement.prompt, /Startvoorraad\.pdf/);
  assert.match(directDewarmteSupplement.prompt, /spätestens drei Tage/);
  assert.equal(directDewarmteSupplement.acceptanceCriteria.some(item => /Vergleichskontext/.test(item)), true);
  const bootstrapSource = await readFile(new URL('../IVA-iMac-einmalig-verbinden.command', import.meta.url), 'utf8');
  assert.match(bootstrapSource, /nodejs\.org\/dist\/\$\{node_version\}/);
  assert.match(bootstrapSource, /shasum -a 256/);
  assert.doesNotMatch(bootstrapSource, /run-imac-device-agent-once/);
  assert.doesNotMatch(bootstrapSource, /local-mac-helper\/cli\.mjs install-imac-device-agent/);
  assert.match(bootstrapSource, /local-mac-helper\/install-imac-device-agent\.mjs/);
  assert.match(bootstrapSource, /IVA lädt die aktuelle iMac-Komponente aus iCloud/);
  assert.match(bootstrapSource, /IVA-DIREKTSTART B332BDF/);
  assert.match(bootstrapSource, /workspace\/\.\.\/AGENTS\.md/);
  assert.match(bootstrapSource, /Zwei fortlaufende Railway-Heartbeats wurden bestätigt/);
  const finalBootstrapSource = await readFile(new URL('../IVA-iMac-JETZT-fertigstellen.command', import.meta.url), 'utf8');
  assert.match(finalBootstrapSource, /b332bdf18ad5eb25eda85f5f60326115133c1f4f/);
  assert.match(finalBootstrapSource, /97848c3288d809cdaf2b23f9df9ccad727aa369d663ff8a7ea2ccc2290421231/);
  assert.match(finalBootstrapSource, /workspace\/\.\.\/AGENTS\.md/);
  assert.match(finalBootstrapSource, /IVA_DEVICE_RUNTIME_SOURCE="\$snapshot"/);
  assert.match(finalBootstrapSource, /4\/4 – Dauerverbindung wird umgeschaltet und doppelt geprüft/);
  const codexTaskSource = await readFile(new URL('../local-mac-helper/codex-tasks.mjs', import.meta.url), 'utf8');
  assert.match(codexTaskSource, /'exec', '--approve-for-me'/);
  assert.match(codexTaskSource, /withMacWakeGuard\(\(\) => runCodexTaskWithoutWakeGuard/);
  assert.match(codexTaskSource, /delete childEnv\.IVA_MAC_WAKE_GUARD_ACTIVE/);
  assert.match(codexTaskSource, /request\.mode === 'operational'/);
  assert.match(codexTaskSource, /materializeIcloudWorkspace/);
  assert.doesNotMatch(codexTaskSource, /'--sandbox'[^\n]+?'--approve-for-me'/, 'Codex CLI erlaubt --sandbox nicht zusammen mit --approve-for-me');
  const centralInstallerSource = await readFile(new URL('../local-mac-helper/install-central-runtime.mjs', import.meta.url), 'utf8');
  assert.match(centralInstallerSource, /requiredRelease: DEVICE_AGENT_RELEASE/, 'Bundle-Schema und Agent-Release-ID bleiben getrennt');
  assert.equal(inferProjectWorkflowStatus('Status: **fachlich blockiert**.\n\nGrund: Pflichtdaten fehlen.'), 'blocked');
  assert.equal(inferProjectWorkflowStatus('Status: technisch blockiert\nKeine Schreibaktion.'), 'blocked');
  assert.equal(inferProjectWorkflowStatus('Ergebnis: technisch blockiert\nKeine Schreibaktion.'), 'blocked');
  assert.equal(inferProjectWorkflowStatus('Technischer Blocker: Outlook-Konto nicht erreichbar.'), 'blocked');
  assert.equal(inferProjectWorkflowStatus('Status: erfolgreich\nKeine Blocker vorhanden.'), '');
  const deviceAgentRunnerSource = await readFile(new URL('../local-mac-helper/device-agent-runner.mjs', import.meta.url), 'utf8');
  assert.match(deviceAgentRunnerSource, /DEVICE_AGENT_HARD_TIMEOUT_MS = 240_000/, 'der äußere Agent darf die 180-Sekunden-Planbar-Prüfung nicht vorzeitig abbrechen');
  assert.match(deviceAgentRunnerSource, /DEVICE_AGENT_POLL_INTERVAL_MS = 15_000/);
  assert.match(deviceAgentRunnerSource, /await reportBootstrapHeartbeat\(\)/);
  assert.match(deviceAgentRunnerSource, /'funding\.legacy-monitor\.suspend'/);
  assert.match(deviceAgentRunnerSource, /'X-IVA-Agent-Workspace': metadata\.workspace/);
  assert.match(deviceAgentRunnerSource, /spawn\('\/usr\/bin\/caffeinate', \['-s', '-w'/);
  assert.match(deviceAgentRunnerSource, /updateLocalRunnerFromIcloud/);
  const deviceAgentRuntimeSource = await readFile(new URL('../local-mac-helper/device-agent.mjs', import.meta.url), 'utf8');
  assert.match(deviceAgentRuntimeSource, /runtimeMode: process\.env\.IVA_DEVICE_LOCAL_RUNTIME === 'true' \? 'local' : 'icloud'/);
  assert.match(deviceAgentRuntimeSource, /'codex\.task\.start'/);
  assert.match(deviceAgentRuntimeSource, /revision: 'append'/);
  assert.match(deviceAgentRuntimeSource, /ChatGPT: Object\.freeze\(\['\/Applications\/ChatGPT\.app'/);
  assert.match(deviceAgentRuntimeSource, /background-integrations\.mjs/);
  assert.doesNotMatch(deviceAgentRuntimeSource, /chrome-pipedrive-status\.mjs/);
  assert.match(deviceAgentRunnerSource, /LOCAL_RUNTIME \? path\.join\(LOCAL_HELPER_DIR, 'device-agent\.mjs'\)/);
  assert.match(deviceAgentRunnerSource, /scheduleLocalRuntimeMigration/);
  assert.match(deviceAgentRunnerSource, /de\.iva\.device-agent-migrator/);
  assert.match(deviceAgentRunnerSource, /IVA_DEVICE_MIGRATOR/);
  assert.match(deviceAgentRunnerSource, /ensureVerifiedBootstrapSnapshot/);
  assert.match(deviceAgentRunnerSource, /97848c3288d809cdaf2b23f9df9ccad727aa369d663ff8a7ea2ccc2290421231/);
  assert.match(deviceAgentRunnerSource, /IVA_DEVICE_RUNTIME_SOURCE/);
  assert.doesNotMatch(deviceAgentRunnerSource, /preserveTimestamps:\s*true/);
  assert.match(deviceAgentRunnerSource, /error\?\.code === 'ENOENT'/);
  const deviceAgentLaunchdSource = await readFile(new URL('../local-mac-helper/device-agent-launchd.mjs', import.meta.url), 'utf8');
  assert.match(deviceAgentLaunchdSource, /previousPlist/);
  assert.match(deviceAgentLaunchdSource, /vorheriger Agent wurde wiederhergestellt/);
  assert.match(deviceAgentLaunchdSource, /IVA_DEVICE_RUNTIME_SOURCE/);
  assert.match(deviceAgentLaunchdSource, /runtime-package\.json/);
  assert.match(deviceAgentLaunchdSource, /npm, \['install', '--omit=dev'/);
  assert.match(deviceAgentLaunchdSource, /materializeIcloudWorkspace/);
  assert.doesNotMatch(deviceAgentLaunchdSource, /preserveTimestamps:\s*true/);
  const planbarForecastSource = await readFile(new URL('../local-mac-helper/planbar-forecast-mail.mjs', import.meta.url), 'utf8');
  assert.match(planbarForecastSource, /IVA_PLANBAR_OUTPUT_ROOT/);
  const dedicatedInstallerSource = await readFile(new URL('../local-mac-helper/install-imac-device-agent.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(dedicatedInstallerSource, /IVA_DEVICE_MIGRATOR/);
  assert.match(dedicatedInstallerSource, /installImacDeviceAgentLaunchd/);
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
  assert.equal(devicePolicy.allowedActions.includes('funding.legacy-monitor.suspend'), true);

  console.log('Device-Control: gleichzeitige Zugriffe und ehrliche Bereitschaft prüfen …');
  const beforeConcurrent = (await listDeviceCommands({ limit: 500 })).length;
  await Promise.all(Array.from({ length: 30 }, (_, i) => Promise.all([
    enqueueDeviceCommand({ action: 'agent.status', requestText: `concurrent-${i}` }),
    recordDeviceAgentHeartbeat({ ...imacMetadata }),
  ])));
  assert.equal((await listDeviceCommands({ limit: 500 })).length, beforeConcurrent + 30, 'kein Befehl darf durch einen Heartbeat überschrieben werden');
  const simultaneousClaims = await Promise.all(Array.from({ length: 8 }, () => claimNextDeviceCommand(IVA_IMAC_DEVICE_ID, imacMetadata)));
  assert.equal(new Set(simultaneousClaims.map(item => item.id)).size, 8, 'jede Lease gehört zu genau einem Abruf');
  assert.equal((await deviceAgentStatus()).dispatchReady, true);
  const diskStore = JSON.parse(await readFile(path.join(root, 'device-commands.json'), 'utf8'));
  diskStore.agents[IVA_IMAC_DEVICE_ID].lastPolledAt = '2020-01-01T00:00:00Z';
  await writeFile(path.join(root, 'device-commands.json'), JSON.stringify(diskStore));
  await recordDeviceAgentHeartbeat({ ...imacMetadata });
  assert.equal((await deviceAgentStatus()).dispatchReady, false, 'Heartbeat allein belegt keine Befehlsabholung');
  const mutation = await enqueueDeviceCommand({ action: 'app.open', payload: { app: 'WhatsApp' } });
  const retryStore = JSON.parse(await readFile(path.join(root, 'device-commands.json'), 'utf8'));
  const pendingMutation = retryStore.commands.find(item => item.id === mutation.id);
  Object.assign(pendingMutation, { status: 'running', leaseExpiresAt: '2020-01-01T00:00:00Z', attempts: 1 });
  await writeFile(path.join(root, 'device-commands.json'), JSON.stringify(retryStore));
  await claimNextDeviceCommand(IVA_IMAC_DEVICE_ID, imacMetadata);
  assert.equal((await deviceCommandStatus(mutation.id)).status, 'failed');
  assert.match((await deviceCommandStatus(mutation.id)).error, /Keine automatische Wiederholung/);

  console.log('Device-Control: zentrales Laufzeitpaket und UI-Serialisierung prüfen …');
  const { buildCentralRuntimeBundle, validateCentralRuntimeBundle, prepareCentralRuntime, activateCentralRuntime } = await import('../local-mac-helper/central-runtime.mjs');
  const bundle = await buildCentralRuntimeBundle(path.resolve(fileURLToPath(new URL('..', import.meta.url))));
  validateCentralRuntimeBundle(bundle);
  assert.ok(bundle.files.some(file => file.path === 'operations/customer-scheduling.js'));
  assert.ok(bundle.files.every(file => !/\.env|outputs\//.test(file.path)));
  const corrupt = structuredClone(bundle);
  corrupt.files[0].content = Buffer.from('corrupt').toString('base64');
  assert.throws(() => validateCentralRuntimeBundle(corrupt), /Inhaltsprüfung/);
  const escaped = structuredClone(bundle);
  escaped.files[0].path = '../escape.mjs';
  assert.throws(() => validateCentralRuntimeBundle(escaped), /Laufzeitpfad/);
  const runtimeRoot = path.join(root, 'runtime-test');
  const target = await prepareCentralRuntime(bundle, { root: runtimeRoot, exec: async () => ({ stdout: '' }) });
  await activateCentralRuntime(target, { root: runtimeRoot });
  assert.equal(JSON.parse(await readFile(path.join(runtimeRoot, 'current/release.json'), 'utf8')).revision, bundle.revision);

  const dependencySource = path.join(root, 'dependency-source');
  const dependencyAlias = path.join(root, 'dependency-current');
  const reuseRoot = path.join(root, 'runtime-reuse-test');
  await mkdir(path.join(dependencySource, 'node_modules'), { recursive: true });
  await writeFile(path.join(dependencySource, 'package.json'), await readFile(path.join(target, 'package.json')));
  await symlink(dependencySource, dependencyAlias);
  const reusedTarget = await prepareCentralRuntime(bundle, { root: reuseRoot, dependencyRoot: dependencyAlias, exec: async () => ({ stdout: '' }) });
  assert.equal(await readlink(path.join(reusedTarget, 'node_modules')), await realpath(path.join(dependencySource, 'node_modules')),
    'ein Release darf nie über den beweglichen current-Link auf seine Abhängigkeiten zeigen');
  await assert.rejects(prepareCentralRuntime(corrupt, { root: runtimeRoot, exec: async () => ({}) }), /Inhaltsprüfung/);
  assert.equal(JSON.parse(await readFile(path.join(runtimeRoot, 'current/release.json'), 'utf8')).revision, bundle.revision, 'fehlerhaftes Update lässt den aktiven Stand stehen');
  const { withImacExecutionLock } = await import('../local-mac-helper/ui-execution-lock.mjs');
  let active = 0, maximum = 0;
  await Promise.all(Array.from({ length: 4 }, () => withImacExecutionLock(async () => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
  }, { root: path.join(root, 'ui-lock'), pollMs: 2 })));
  assert.equal(maximum, 1, 'zwei Aufträge dürfen den Bildschirm nicht gleichzeitig bedienen');

  console.log('Device-Control: selbstheilenden Förderlaufzeit-Abgleich prüfen …');
  const { FUNDING_RUNTIME_MARKER, FUNDING_RUNTIME_MAX_UPDATE_ATTEMPTS, fundingRuntimeUpdatePrompt, reconcileFundingImacRuntime, summarizeFundingRuntimeCommands } = await import('../device-control/funding-runtime-reconciler.js');
  assert.match(fundingRuntimeUpdatePrompt(), /IVA-iMac-JETZT-fertigstellen\.command/);
  assert.match(fundingRuntimeUpdatePrompt(), /Starte keinen Förderlauf/);
  let queuedRuntimeCommand = null;
  const updateQueued = await reconcileFundingImacRuntime({
    getStatus: async () => ({ ...imacMetadata, attested: true, online: true, allowedActions: ['codex.task.start', 'agent.status'] }),
    enqueue: async input => { queuedRuntimeCommand = { id: 'runtime-update', ...input }; return queuedRuntimeCommand; },
    listCommands: async () => [],
  });
  assert.equal(updateQueued.status, 'runtime_update_queued');
  assert.equal(queuedRuntimeCommand.action, 'codex.task.start');
  assert.equal(queuedRuntimeCommand.payload.requestId, FUNDING_RUNTIME_MARKER);
  assert.equal(queuedRuntimeCommand.payload.mode, 'operational');
  const materializationBlocked = await reconcileFundingImacRuntime({
    getStatus: async () => ({ ...imacMetadata, attested: true, online: true, allowedActions: ['codex.task.start', 'agent.status'] }),
    enqueue: async () => { throw new Error('nach der begrenzten Zahl identischer iCloud-Fehler darf kein weiterer Minutenlauf starten'); },
    listCommands: async () => Array.from({ length: FUNDING_RUNTIME_MAX_UPDATE_ATTEMPTS }, (_, index) => ({
      id: `failed-${index}`, action: 'codex.task.start', status: 'failed',
      payload: { requestId: FUNDING_RUNTIME_MARKER }, error: 'AGENTS.md EAGAIN -11',
    })),
  });
  assert.equal(materializationBlocked.status, 'blocked_icloud_materialization');
  assert.equal(materializationBlocked.attempts, FUNDING_RUNTIME_MAX_UPDATE_ATTEMPTS);
  let queuedSuspendCommand = null;
  const suspendQueued = await reconcileFundingImacRuntime({
    getStatus: async () => ({ ...imacMetadata, attested: true, online: true }),
    enqueue: async input => { queuedSuspendCommand = { id: 'legacy-suspend', ...input }; return queuedSuspendCommand; },
    listCommands: async () => [],
  });
  assert.equal(suspendQueued.status, 'legacy_monitor_suspend_queued');
  assert.equal(queuedSuspendCommand.action, 'funding.legacy-monitor.suspend');
  let queuedFundingCatchup = null;
  const runtimeCatchupQueued = await reconcileFundingImacRuntime({
    getStatus: async () => ({ ...imacMetadata, attested: true, online: true }),
    enqueue: async input => { queuedFundingCatchup = { id: 'funding-catchup', ...input }; return queuedFundingCatchup; },
    listCommands: async () => [{
      id: 'legacy-suspend', action: 'funding.legacy-monitor.suspend', status: 'completed',
      requestText: `[${FUNDING_RUNTIME_MARKER}] geprüft`,
      result: { suspended: true, loaded: false, plistRetained: true },
    }],
  });
  assert.equal(runtimeCatchupQueued.status, 'ready_funding_catchup_queued');
  assert.equal(queuedFundingCatchup.action, 'project.workflow.run');
  assert.equal(queuedFundingCatchup.payload.workflowId, 'funding-daily-sequence');
  const runtimeReady = await reconcileFundingImacRuntime({
    getStatus: async () => ({ ...imacMetadata, attested: true, online: true }),
    enqueue: async () => { throw new Error('bei vorhandenem Tageslauf darf nichts doppelt eingereiht werden'); },
    listCommands: async () => [{
      id: 'legacy-suspend', action: 'funding.legacy-monitor.suspend', status: 'completed',
      requestText: `[${FUNDING_RUNTIME_MARKER}] geprüft`,
      result: { suspended: true, loaded: false, plistRetained: true },
    }, {
      id: 'funding-catchup', action: 'project.workflow.run', status: 'running',
      createdAt: new Date().toISOString(), requestText: `[${FUNDING_RUNTIME_MARKER}] nachholen`,
      payload: { projectId: 'heat-hero', workflowId: 'funding-daily-sequence' },
    }],
  });
  assert.equal(runtimeReady.status, 'ready');
  assert.equal(runtimeReady.legacyMonitorSuspended, true);
  assert.equal(runtimeReady.fundingCatchupCommandId, 'funding-catchup');
  const diagnostic = summarizeFundingRuntimeCommands([
    { id: 'runtime-update', action: 'codex.task.start', status: 'completed', payload: { requestId: FUNDING_RUNTIME_MARKER }, result: { jobId: 'job-1' } },
    { id: 'legacy-suspend', action: 'funding.legacy-monitor.suspend', status: 'completed', requestText: `[${FUNDING_RUNTIME_MARKER}] geprüft`, result: { suspended: true, loaded: false, plistRetained: true } },
    { id: 'funding-catchup', action: 'project.workflow.run', status: 'running', requestText: `[${FUNDING_RUNTIME_MARKER}] nachholen`, payload: { workflowId: 'funding-daily-sequence' } },
  ]);
  assert.equal(diagnostic.runtimeUpdate.jobId, 'job-1');
  assert.equal(diagnostic.legacyMonitorSuspension.suspended, true);
  assert.equal(diagnostic.legacyMonitorSuspension.loaded, false);
  assert.equal(diagnostic.fundingCatchup.status, 'running');

  const { builderSkill } = await import('../skills/builder.js');
  console.log('Device-Control: Builder-Werkzeug prüfen …');
  let dispatched = null;
  const tools = builderSkill({
    captureImprovementRequest: async input => ({ id: '11111111-1111-4111-8111-111111111111', ...input }),
    markImprovementRequestDispatched: async (id, value) => { dispatched = { id, ...value }; },
    enqueueDeviceCommand: async input => ({ id: '22222222-2222-4222-8222-222222222222', deviceId: IVA_IMAC_DEVICE_ID, status: 'queued', ...input }),
    deviceCommandStatus: async id => ({ id, status: 'completed' }),
    listAgentRuns: async () => [{
      jobId: '66666666-6666-4666-8666-666666666666',
      status: 'completed', phase: 'completed', progress: 100,
      resultPreview: 'Live geprüft', error: '', updatedAt: new Date().toISOString(),
    }],
  });
  const notOrdered = await tools.startIvaBuild.execute({ title: 'Test', request: 'Eine echte Funktion bauen', explicitlyOrdered: false });
  assert.equal(notOrdered.queued, false);
  const ordered = await tools.startIvaBuild.execute({ title: 'Test', request: 'Eine echte Funktion bauen', explicitlyOrdered: true, acceptanceCriteria: ['Tests grün'] });
  assert.equal(ordered.queued, true);
  assert.equal(dispatched.commandId, ordered.commandId);
  const completedBuild = await tools.checkIvaBuildTask.execute({ jobId: '66666666-6666-4666-8666-666666666666' });
  assert.equal(completedBuild.executionVerified, true);
  assert.equal(completedBuild.resultPreview, 'Live geprüft');

  const { deviceControlSkill } = await import('../skills/device-control.js');
  let portalDispatch = null;
  const deviceTools = deviceControlSkill({
    enqueueDeviceCommand: async input => {
      portalDispatch = input;
      return { id: '33333333-3333-4333-8333-333333333333', deviceId: IVA_IMAC_DEVICE_ID, expiresAt: new Date().toISOString(), ...input };
    },
    deviceCommandStatus: async id => ({ id, status: 'completed' }),
    listAgentRuns: async () => [{
      jobId: '55555555-5555-4555-8555-555555555555',
      externalKey: 'codex-task:55555555-5555-4555-8555-555555555555',
      status: 'completed', phase: 'completed', progress: 100,
      resultPreview: 'Hostname: imac-von-nadine', error: '', updatedAt: new Date().toISOString(),
    }],
  });
  const loginDispatch = await deviceTools.ensureImacPortalLogin.execute({ service: 'pipedrive' });
  assert.equal(loginDispatch.queued, true);
  assert.equal(portalDispatch.action, 'portal.login');
  assert.deepEqual(portalDispatch.payload, { service: 'pipedrive' });
  const operationalDispatch = await deviceTools.runTaskOnImac.execute({
    title: 'iMac-Dateiprüfung',
    request: 'Prüfe den gemeinsamen Arbeitsordner auf dem iMac rein lesend.',
    acceptanceCriteria: ['Hostname und Arbeitsordner sind belegt.'],
    confirmed: true,
  });
  assert.equal(operationalDispatch.queued, true);
  assert.equal(portalDispatch.action, 'codex.task.start');
  assert.equal(portalDispatch.payload.mode, 'operational');
  assert.equal(operationalDispatch.executionVerified, false);
  const taskStatus = await deviceTools.getImacTaskStatus.execute({ jobId: '55555555-5555-4555-8555-555555555555' });
  assert.equal(taskStatus.executionVerified, true);
  assert.equal(taskStatus.resultPreview, 'Hostname: imac-von-nadine');

  const { planbarSkill } = await import('../skills/planbar.js');
  let planbarDispatch = null;
  const planbarTools = planbarSkill({
    searchPlanbarAppointments: async () => ({ matches: [] }),
    getProject: async () => ({ customerSchedulingPartners: [{ id: 'heat-hero', name: 'Heat Hero', prefix: 'HH', schedulingMode: 'free-resource' }] }),
    addCustomerSchedulingRequest: async (id, input) => {
      assert.equal(id, 'heat-hero');
      planbarDispatch = { action: 'planbar.customer.schedule', payload: input };
      return { schedulingDispatch: { commandId: '44444444-4444-4444-8444-444444444444', deviceId: IVA_IMAC_DEVICE_ID, status: 'queued' }, customerSchedulingRequests: [{ schedulingSummary: 'Automatisch übergeben; kein Slot bestätigt.' }] };
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
