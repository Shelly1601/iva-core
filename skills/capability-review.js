import { tool } from 'ai';
import { z } from 'zod';

export function capabilityReviewSkill({ evaluateCapability, listCapabilityReviews }) {
  return {
    assessCapability: tool({
      description: 'Pflichtpruefung vor neuen Tools, Agenten oder kopierten Reel-Ideen: misst echten zusaetzlichen Nutzen, Doppelung, Kosten, Belege, Rechte und Sicherheitsrisiken. Erst das Ergebnis entscheidet zwischen bestehendem Agenten, neuem Agenten, Beobachtung oder Ablehnung.',
      parameters: z.object({
        title: z.string(), problem: z.string(), existingAgent: z.string().optional(),
        expectedRunsPerMonth: z.number().min(0).optional(), minutesSavedPerRun: z.number().min(0).optional(),
        setupHours: z.number().min(0).optional(), monthlyCostEur: z.number().min(0).optional(),
        currentCoveragePercent: z.number().min(0).max(100).optional(), distinctWorkflow: z.boolean().optional(),
        requiresExternalTool: z.boolean().optional(), officialEvidence: z.array(z.string()).optional(),
        rightsClear: z.boolean().optional(), securityReviewed: z.boolean().optional(), personalData: z.boolean().optional(),
        externalWrite: z.boolean().optional(), copiesProtectedWork: z.boolean().optional(), risks: z.array(z.string()).optional(),
      }),
      execute: async input => evaluateCapability(input),
    }),
    listCapabilityReviews: tool({
      description: 'Listet die bereits geprueften Instagram-/Tool-Ideen mit Entscheidung und Zielagent. Dient als Duplikat- und Hype-Schutz.',
      parameters: z.object({ category: z.string().optional(), decision: z.string().optional() }),
      execute: async input => ({ reviews: listCapabilityReviews(input) }),
    }),
  };
}

export const capabilityReviewSkillMeta = { id: 'capabilityReview', toolNames: ['assessCapability', 'listCapabilityReviews'] };
