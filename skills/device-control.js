import { tool } from 'ai';
import { z } from 'zod';

export function deviceControlSkill({ enqueueDeviceCommand, deviceCommandStatus }) {
  return {
    sendCommandToImac: tool({
      description: 'Sendet auf Nadines ausdrücklichen Wunsch einen eng freigegebenen Befehl an ihren M1-iMac. Der iMac holt den Befehl ausgehend ab; es wird kein offener Fernzugriff eingerichtet. Unterstützt Statusprüfung, einen gesperrten Fördermonitor-Prüflauf, Review-Übersicht und das Öffnen freigegebener Apps.',
      parameters: z.object({
        action: z.enum(['computer.status', 'funding.monitor.status', 'funding.monitor.run', 'funding.reviews.list', 'app.open']),
        app: z.enum(['Microsoft Outlook', 'Google Chrome', 'WhatsApp', 'Codex']).optional(),
        confirmed: z.boolean().describe('true nur wenn Nadine ausdrücklich gesagt hat, dass die Aktion auf dem iMac ausgeführt werden soll'),
        requestText: z.string().max(500).optional(),
      }),
      execute: async ({ action, app, confirmed, requestText }) => {
        if (!confirmed) return { queued: false, error: 'Bitte den iMac-Befehl zuerst ausdrücklich bestätigen.' };
        const command = await enqueueDeviceCommand({ action, payload: app ? { app } : {}, requestedBy: 'iva-chat', requestText });
        return { queued: true, commandId: command.id, deviceId: command.deviceId, action: command.action, expiresAt: command.expiresAt };
      },
    }),
    getImacCommandStatus: tool({
      description: 'Prüft den Status eines zuvor an Nadines iMac gesendeten Befehls.',
      parameters: z.object({ commandId: z.string().uuid() }),
      execute: async ({ commandId }) => ({ command: await deviceCommandStatus(commandId) }),
    }),
  };
}

export const deviceControlSkillMeta = { id: 'deviceControl', toolNames: ['sendCommandToImac', 'getImacCommandStatus'] };
