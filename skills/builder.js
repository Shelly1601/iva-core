import { tool } from 'ai';
import { z } from 'zod';

export function builderSkill({ captureImprovementRequest, markImprovementRequestDispatched, enqueueDeviceCommand, deviceCommandStatus, listAgentRuns }) {
  return {
    startIvaBuild: tool({
      description: 'Startet einen von Nadine ausdrücklich beauftragten IVA-Code- oder Systemumbau ohne weitere Planbestätigung im lokalen Codex. Verwenden, wenn sie klar sagt „mach das“, „bau das“, „setz das um“ oder gleichbedeutend. Der lokale Codex befolgt AGENTS.md und übernimmt Implementierung, Tests, Commit, Push, Railway-Deployment und Live-Prüfung. Bei einer bloßen Idee ohne Umsetzungsauftrag stattdessen nur captureImprovementRequest verwenden.',
      parameters: z.object({
        title: z.string().min(3).max(180),
        request: z.string().min(10).max(12_000).describe('Der vollständige Bauauftrag mit relevantem Gesprächskontext.'),
        desiredOutcome: z.string().min(3).max(3000).optional(),
        acceptanceCriteria: z.array(z.string().max(500)).max(12).optional(),
        priority: z.enum(['low', 'normal', 'high']).optional(),
        explicitlyOrdered: z.boolean().describe('true, wenn Nadine die Umsetzung ausdrücklich beauftragt hat; keine erneute Bestätigung verlangen'),
      }),
      execute: async input => {
        if (!input.explicitlyOrdered) return { queued: false, error: 'Es liegt noch kein ausdrücklicher Umsetzungsauftrag vor.' };
        const request = await captureImprovementRequest({
          title: input.title,
          description: input.request,
          desiredOutcome: input.desiredOutcome || input.request,
          acceptanceCriteria: input.acceptanceCriteria,
          priority: input.priority || 'high',
          area: 'iva-core',
        });
        const command = await enqueueDeviceCommand({
          action: 'codex.task.start',
          payload: {
            prompt: input.request,
            title: input.title,
            requestId: request.id,
            acceptanceCriteria: input.acceptanceCriteria || [],
          },
          requestedBy: 'iva-builder',
          requestText: input.title,
        });
        await markImprovementRequestDispatched(request.id, { commandId: command.id });
        return {
          queued: true,
          requestId: request.id,
          commandId: command.id,
          deviceId: command.deviceId,
          status: command.status,
          message: 'Der vollständige Bauauftrag ist ohne weitere Rückfrageschleife an Codex auf Nadines iMac übergeben.',
        };
      },
    }),
    checkIvaBuildDispatch: tool({
      description: 'Prüft, ob ein an den iMac gesendeter IVA-Bauauftrag lokal von Codex angenommen wurde. Wenn das Ergebnis eine jobId enthält, kann damit anschließend checkIvaBuildTask verwendet werden.',
      parameters: z.object({ commandId: z.string().uuid() }),
      execute: async ({ commandId }) => ({ command: await deviceCommandStatus(commandId) }),
    }),
    checkIvaBuildTask: tool({
      description: 'Prüft den tatsächlichen Status eines bereits gestarteten Codex-Bau- oder operativen iMac-Auftrags. Nur status completed mit resultPreview belegt ein fertiges Ergebnis.',
      parameters: z.object({ jobId: z.string().min(20).max(80) }),
      execute: async ({ jobId }) => {
        if (typeof listAgentRuns === 'function') {
          const runs = await listAgentRuns({ limit: 500 });
          const run = runs.find(item => item.jobId === jobId || item.externalKey === `codex-task:${jobId}`);
          if (run) {
            const completed = run.status === 'completed';
            return {
              found: true,
              jobId,
              status: run.status,
              phase: run.phase,
              progress: run.progress,
              executionVerified: completed,
              resultPreview: completed ? run.resultPreview : '',
              error: run.error || '',
              updatedAt: run.updatedAt,
            };
          }
        }
        const command = await enqueueDeviceCommand({
          action: 'codex.task.status', payload: { jobId }, requestedBy: 'iva-builder', requestText: 'Codex-Bauauftrag prüfen',
        });
        return { found: false, queued: true, executionVerified: false, commandId: command.id, deviceId: command.deviceId, action: command.action };
      },
    }),
  };
}

export const builderSkillMeta = { id: 'builder', toolNames: ['startIvaBuild', 'checkIvaBuildDispatch', 'checkIvaBuildTask'] };
