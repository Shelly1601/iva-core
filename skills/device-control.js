import { tool } from 'ai';
import { z } from 'zod';

export function deviceControlSkill({ enqueueDeviceCommand, deviceCommandStatus }) {
  return {
    sendCommandToImac: tool({
      description: 'Sendet auf Nadines ausdrücklichen Wunsch einen eng freigegebenen Befehl an ihren M1-iMac. Der iMac holt den Befehl ausgehend ab; es wird kein offener Fernzugriff eingerichtet. Unterstützt Statusprüfung, einen gesperrten Fördermonitor-Prüflauf, Review-Übersicht und das Öffnen freigegebener Apps.',
      parameters: z.object({
        action: z.enum(['computer.status', 'funding.monitor.status', 'funding.monitor.run', 'funding.reviews.list', 'app.open']),
        app: z.enum(['Microsoft Outlook', 'Google Chrome', 'WhatsApp', 'Codex', 'ChatGPT']).optional(),
        confirmed: z.boolean().describe('true nur wenn Nadine ausdrücklich gesagt hat, dass die Aktion auf dem iMac ausgeführt werden soll'),
        requestText: z.string().max(500).optional(),
      }),
      execute: async ({ action, app, confirmed, requestText }) => {
        if (!confirmed) return { queued: false, error: 'Bitte den iMac-Befehl zuerst ausdrücklich bestätigen.' };
        const command = await enqueueDeviceCommand({ action, payload: app ? { app } : {}, requestedBy: 'iva-chat', requestText });
        return { queued: true, commandId: command.id, deviceId: command.deviceId, action: command.action, expiresAt: command.expiresAt };
      },
    }),
    runTaskOnImac: tool({
      description: 'Führt eine von Nadine ausdrücklich mit „oben“ oder „auf dem iMac“ beauftragte normale lokale Aktion über Codex direkt auf dem iMac aus, wenn keine engere freigegebene Geräteaktion passt. Für IVA-Code-, App- oder Systemänderungen ist startIvaBuild zu verwenden. Die Aktion erhält ausschließlich den gemeinsamen IVA-iCloud-Workspace; Erfolg wird erst nach Statusprüfung behauptet.',
      parameters: z.object({
        title: z.string().min(3).max(180),
        request: z.string().min(10).max(12_000),
        acceptanceCriteria: z.array(z.string().min(3).max(500)).max(12).optional(),
        confirmed: z.boolean().describe('true nur wenn Nadine die Ausführung oben beziehungsweise auf dem iMac ausdrücklich beauftragt hat'),
      }),
      execute: async ({ title, request, acceptanceCriteria = [], confirmed }) => {
        if (!confirmed) return { queued: false, error: 'Bitte die Ausführung auf dem iMac zuerst ausdrücklich bestätigen.' };
        const command = await enqueueDeviceCommand({
          action: 'codex.task.start',
          payload: { title, prompt: request, mode: 'operational', acceptanceCriteria },
          requestedBy: 'iva-imac-operation',
          requestText: title,
        });
        return { queued: true, commandId: command.id, deviceId: command.deviceId, action: command.action, expiresAt: command.expiresAt };
      },
    }),
    ensureImacPortalLogin: tool({
      description: 'Meldet IVA auf Nadines Mac selbstständig bei einem bereits freigegebenen Portal an. Zugangsdaten kommen aus dem lokalen macOS-Schlüsselbund; Panasonic-2FA kommt direkt aus dem fest hinterlegten Ente-Auth-Eintrag. Kein Secret wird an Railway, Chat oder Modell zurückgegeben. Normale Wiederanmeldungen benötigen keine erneute Freigabe; CAPTCHA, Kontosperre, externe Bestätigung oder fehlende lokale Zugänge werden konkret gemeldet.',
      parameters: z.object({
        service: z.enum(['panasonic', 'bosch', 'pipedrive', 'airtable', 'planbar']),
        requestText: z.string().max(500).optional(),
      }),
      execute: async ({ service, requestText }) => {
        const command = await enqueueDeviceCommand({
          action: 'portal.login',
          payload: { service },
          requestedBy: 'iva-login',
          requestText: requestText || `Bei ${service} anmelden`,
        });
        return { queued: true, commandId: command.id, deviceId: command.deviceId, service, expiresAt: command.expiresAt };
      },
    }),
    getImacCredentialStatus: tool({
      description: 'Prüft ohne Secret-Ausgabe, ob IVAs lokale Schlüsselbund-Einträge für ein freigegebenes Portal vorhanden sind.',
      parameters: z.object({ service: z.enum(['panasonic', 'bosch', 'pipedrive', 'airtable', 'planbar']) }),
      execute: async ({ service }) => {
        const command = await enqueueDeviceCommand({ action: 'portal.credentials.status', payload: { service }, requestedBy: 'iva-login-status' });
        return { queued: true, commandId: command.id, deviceId: command.deviceId, service, expiresAt: command.expiresAt };
      },
    }),
    getImacCommandStatus: tool({
      description: 'Prüft den Status eines zuvor an Nadines iMac gesendeten Befehls.',
      parameters: z.object({ commandId: z.string().uuid() }),
      execute: async ({ commandId }) => ({ command: await deviceCommandStatus(commandId) }),
    }),
  };
}

export const deviceControlSkillMeta = { id: 'deviceControl', toolNames: ['sendCommandToImac', 'runTaskOnImac', 'ensureImacPortalLogin', 'getImacCredentialStatus', 'getImacCommandStatus'] };
