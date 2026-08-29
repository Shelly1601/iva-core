const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'blocked', 'timed_out', 'incomplete', 'stopped']);

function waiting(summary, result = {}) {
  return { status: 'waiting', summary, ...result };
}

function commandFailure(command, label) {
  const detail = command?.error || command?.cancelReason || `Status ${command?.status || 'unbekannt'}`;
  return new Error(`${label} auf dem iMac fehlgeschlagen: ${detail}`);
}

export function createPlanbarForecastAutomationHandler({
  getProject,
  deviceAgentStatus,
  enqueueDeviceCommand,
  deviceCommandStatus,
  deviceId = 'imac-nadine',
} = {}) {
  return async ({ slotKey, attempt, previousResult = {} }) => {
    const project = await getProject('heat-hero');
    const workflow = project?.automations?.find(item => item.id === 'planbar-weekly-export');
    if (workflow?.enabled !== true) {
      return {
        status: 'blocked',
        summary: 'Planbar-Forecast nicht ausgeführt: Der Projektschalter ist ausgeschaltet.',
        error: 'Planbar-Forecast muss in der Heat-Hero-Projektakte aktiv sein.',
      };
    }

    let commandId = previousResult.commandId || '';
    let jobId = previousResult.jobId || '';
    let statusCommandId = previousResult.statusCommandId || '';
    if (!commandId) {
      const imac = await deviceAgentStatus();
      if (imac.online !== true || imac.dispatchReady !== true) {
        return waiting('Planbar-Forecast wartet auf den erreichbaren, attestierten iMac.', { commandId, jobId, statusCommandId });
      }
      const command = await enqueueDeviceCommand({
        deviceId,
        action: 'project.workflow.run',
        payload: {
          projectId: 'heat-hero',
          workflowId: 'planbar-weekly-export',
          displayName: 'Planbar-Forecast als Excel-Listen',
          requestId: `${slotKey}:attempt:${attempt}`,
        },
        requestedBy: 'automation-planbar-weekly-export',
        requestText: `Planbar-Freitagsforecast zuverlässig ausführen (${slotKey})`,
      });
      commandId = command.id;
    }

    const command = await deviceCommandStatus(commandId);
    if (!command) throw new Error('Der iMac-Auftrag des Planbar-Forecasts ist nicht mehr auffindbar.');
    if (['queued', 'running'].includes(command.status)) {
      return waiting('Planbar-Forecast wurde an den iMac übergeben und wartet auf den lokalen Start.', { commandId, jobId, statusCommandId });
    }
    if (command.status !== 'completed') throw commandFailure(command, 'Planbar-Forecast');

    if (command.result?.sent === true) {
      if (command.result.sentFolderVerified !== true) {
        throw new Error('Outlook hat den Forecast übernommen, aber der Gesendet-Nachweis fehlt noch. Der nächste sichere Versuch prüft ausschließlich den vorhandenen Versand.');
      }
      return {
        commandId,
        sentFolderVerified: true,
        period: command.result.period || '',
        attachmentCount: Number(command.result.attachmentCount || 0),
        summary: `Planbar-Forecast ${command.result.period || ''} wurde versandt und im Outlook-Ordner „Gesendet“ verifiziert.`.trim(),
      };
    }

    jobId = command.result?.jobId || jobId;
    if (!jobId) throw new Error('Der iMac hat weder einen verifizierten Versand noch eine lokale Forecast-Auftrags-ID gemeldet.');

    if (statusCommandId) {
      const statusCommand = await deviceCommandStatus(statusCommandId);
      if (statusCommand && ['queued', 'running'].includes(statusCommand.status)) {
        return waiting('Der Planbar-Forecast läuft auf dem iMac; der Endstatus wird weiter verfolgt.', { commandId, jobId, statusCommandId });
      }
      if (statusCommand?.status === 'completed') {
        const local = statusCommand.result || {};
        if (TERMINAL_TASK_STATUSES.has(local.status)) {
          if (local.status === 'completed' && local.workflowProof?.sentFolderVerified === true) {
            return {
              commandId,
              jobId,
              sentFolderVerified: true,
              period: local.workflowProof.period || '',
              attachmentCount: Number(local.workflowProof.attachmentCount || 0),
              summary: `Planbar-Forecast ${local.workflowProof.period || ''} wurde versandt und im Outlook-Ordner „Gesendet“ verifiziert.`.trim(),
            };
          }
          throw new Error(local.error || local.detail || `Der lokale Forecast endete mit Status ${local.status}.`);
        }
      }
      statusCommandId = '';
    }

    const statusCommand = await enqueueDeviceCommand({
      deviceId,
      action: 'codex.task.status',
      payload: { jobId },
      requestedBy: 'automation-planbar-weekly-export',
      requestText: `Endstatus des Planbar-Forecasts prüfen (${slotKey})`,
    });
    return waiting('Der Planbar-Forecast läuft auf dem iMac; der Versand wird bis zum Outlook-Nachweis verfolgt.', {
      commandId,
      jobId,
      statusCommandId: statusCommand.id,
    });
  };
}

export function createProjectWorkflowAutomationHandler({
  projectId = 'heat-hero',
  workflowId,
  displayName,
  enabledWorkflowIds = [workflowId],
  requiredAllowedActions = [],
  getProject,
  deviceAgentStatus,
  enqueueDeviceCommand,
  deviceCommandStatus,
  deviceId = 'imac-nadine',
} = {}) {
  return async ({ slotKey, attempt, previousResult = {} }) => {
    const project = await getProject(projectId);
    const disabled = enabledWorkflowIds.filter(id => project?.automations?.find(item => item.id === id)?.enabled !== true);
    if (disabled.length) {
      return {
        status: 'blocked',
        summary: `${displayName} nicht ausgeführt: Projektschalter aus (${disabled.join(', ')}).`,
        error: 'Mindestens ein erforderlicher Projekt-Workflow ist ausgeschaltet.',
      };
    }

    let commandId = previousResult.commandId || '';
    let jobId = previousResult.jobId || '';
    let statusCommandId = previousResult.statusCommandId || '';
    if (!commandId) {
      const imac = await deviceAgentStatus();
      const missingActions = requiredAllowedActions.filter(action => !imac.allowedActions?.includes(action));
      if (imac.online !== true || imac.dispatchReady !== true || missingActions.length) {
        return waiting(`${displayName} wartet auf den erreichbaren, passenden iMac-Agenten.`, { commandId, jobId, statusCommandId });
      }
      const command = await enqueueDeviceCommand({
        deviceId,
        action: 'project.workflow.run',
        payload: { projectId, workflowId, displayName, requestId: `${slotKey}:attempt:${attempt}` },
        requestedBy: `automation-${workflowId}`,
        requestText: `${displayName} zuverlässig ausführen (${slotKey})`,
      });
      commandId = command.id;
    }

    const command = await deviceCommandStatus(commandId);
    if (!command) throw new Error(`Der iMac-Auftrag „${displayName}“ ist nicht mehr auffindbar.`);
    if (['queued', 'running'].includes(command.status)) {
      return waiting(`${displayName} wurde an den iMac übergeben und wartet auf den lokalen Start.`, { commandId, jobId, statusCommandId });
    }
    if (command.status !== 'completed') throw commandFailure(command, displayName);
    jobId = command.result?.jobId || jobId;
    if (!jobId) throw new Error(`Der iMac hat für „${displayName}“ keine lokale Auftrags-ID gemeldet.`);

    if (statusCommandId) {
      const statusCommand = await deviceCommandStatus(statusCommandId);
      if (statusCommand && ['queued', 'running'].includes(statusCommand.status)) {
        return waiting(`${displayName} läuft auf dem iMac; der Endstatus wird weiter verfolgt.`, { commandId, jobId, statusCommandId });
      }
      if (statusCommand?.status === 'completed') {
        const local = statusCommand.result || {};
        if (TERMINAL_TASK_STATUSES.has(local.status)) {
          if (local.status === 'completed') {
            return { commandId, jobId, summary: `${displayName} wurde auf dem iMac vollständig abgeschlossen.` };
          }
          throw new Error(local.error || local.detail || `Der lokale Workflow endete mit Status ${local.status}.`);
        }
      }
      statusCommandId = '';
    }

    const statusCommand = await enqueueDeviceCommand({
      deviceId,
      action: 'codex.task.status',
      payload: { jobId },
      requestedBy: `automation-${workflowId}`,
      requestText: `Endstatus prüfen: ${displayName} (${slotKey})`,
    });
    return waiting(`${displayName} läuft auf dem iMac und wird bis zum Endzustand verfolgt.`, {
      commandId,
      jobId,
      statusCommandId: statusCommand.id,
    });
  };
}
