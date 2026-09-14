import { tool } from 'ai';
import { z } from 'zod';

export function specialistSkill({ runner, parentRunId = '', context = '', projectId = '' }) {
  if (!runner || typeof runner.run !== 'function' || typeof runner.status !== 'function') throw new TypeError('Specialist runner is required.');
  return {
    getIvaAgentRoster: tool({
      description: 'Zeigt IVAs echte ausführbare Fachagenten und die begrenzte Lese-Runtime. runtimeAvailable belegt die technische Ausführbarkeit, nicht eine geprüfte Kontoanbindung. Vor Delegation passende agentId wählen.',
      parameters: z.object({}),
      execute: async () => runner.status({ projectId }),
    }),
    delegateIvaTasks: tool({
      description: 'Beauftragt bis zu drei echte IVA-Fachagenten mit abgegrenzten Lese-, Recherche- oder Analyseaufträgen. Jeder Agent erhält einen eigenen Modelllauf, seine Fachrolle und ausschließlich freigegebene Lesewerkzeuge. Zwei arbeiten parallel. Für unterschiedliche Fachperspektiven passende IDs aus getIvaAgentRoster wählen. Keine Schreibaktionen, keine rekursive Delegation. Ergebnisse mit Quellen, Werkzeugbelegen und Datenlücken im Hauptauftrag zusammenführen; fehlgeschlagene Ergebnisse niemals als erledigt ausgeben.',
      parameters: z.object({ tasks: z.array(z.object({ agentId: z.string().min(1).max(100), task: z.string().min(1).max(3000) })).min(1).max(3) }),
      execute: async ({ tasks }, options) => runner.run({ tasks, parentRunId, projectId, context: typeof context === 'function' ? context() : context, abortSignal: options?.abortSignal }),
    }),
  };
}

export const specialistSkillMeta = { id: 'specialists', toolNames: ['getIvaAgentRoster', 'delegateIvaTasks'] };
