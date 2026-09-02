import { tool } from 'ai';
import { z } from 'zod';

const technicalContext = {
  system: z.string().min(2).max(100),
  action: z.string().min(2).max(140),
  step: z.string().min(2).max(140),
  error: z.string().min(3).max(1000),
};

export function incidentMemorySkill({ runId, workflowId, recordIncident, markPreventiveLessonUsed }) {
  return {
    recordTechnicalIncident: tool({
      description: 'Protokolliert eine tatsächliche technische Laufstörung intern und sanitisiert. Bei Browser-, UI-, Login-, Verbindungs-, Tool- oder Dateifehlern sofort verwenden, während der fachliche Auftrag weiter repariert wird. Keine Zugangsdaten oder unnötigen Personendaten übergeben.',
      parameters: z.object({ ...technicalContext, severity: z.enum(['low', 'medium', 'high', 'critical']).optional() }),
      execute: async input => ({ recorded: true, incident: await recordIncident({ ...input, runId, workflowId, source: 'iva-chat', status: 'open' }) }),
    }),
    resolveTechnicalIncident: tool({
      description: 'Markiert eine zuvor in diesem Lauf aufgetretene technische Störung erst nach erfolgreicher Reparatur und konkreter Verifikation als gelöst. Das Fehlersignal muss dasselbe wie bei recordTechnicalIncident sein. Automatische Prävention nur für sichere, idempotente Reparaturen erlauben.',
      parameters: z.object({
        ...technicalContext,
        cause: z.string().min(3).max(1000),
        remedy: z.string().min(3).max(1200),
        evidence: z.string().min(3).max(1000),
        safeToAutoApply: z.boolean(),
      }),
      execute: async input => ({ resolved: true, incident: await recordIncident({ ...input, runId, workflowId, source: 'iva-chat', status: 'resolved' }) }),
    }),
    markTechnicalPreventionUsed: tool({
      description: 'Protokolliert, dass eine vor dem Lauf geladene verifizierte Prävention angewendet wurde. prevented=true nur setzen, wenn der konkrete Wiederholungsfehler nachweislich vermieden wurde.',
      parameters: z.object({ fingerprint: z.string().regex(/^[a-f0-9]{24}$/), prevented: z.boolean(), evidence: z.string().min(3).max(600) }),
      execute: async input => ({ recorded: true, incident: await markPreventiveLessonUsed(input.fingerprint, { runId, prevented: input.prevented, evidence: input.evidence }) }),
    }),
  };
}

export const incidentMemorySkillMeta = { id: 'incidentMemory', toolNames: ['recordTechnicalIncident', 'resolveTechnicalIncident', 'markTechnicalPreventionUsed'] };
