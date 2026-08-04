import { tool } from 'ai';
import { z } from 'zod';

export function opportunitiesSkill({ listOpportunities, runOpportunityScout, prepareOpportunityHandoff }) {
  return {
    listOpportunities: tool({
      description: 'Listet IVAs quellengepruefte Chancenideen, nach Potenzial-Score sortiert. Scores sind Priorisierung, keine Einkommensgarantie.',
      parameters: z.object({ status: z.enum(['new', 'watch', 'validate', 'rejected', 'selected']).optional(), limit: z.number().min(1).max(30).optional() }),
      execute: async ({ status, limit }) => ({ opportunities: await listOpportunities({ status, limit: limit || 10 }) }),
    }),
    runOpportunityScout: tool({
      description: 'Startet auf ausdruecklichen Wunsch einen neuen Instagram-Chancencheck via Apify und bewertet echte Quellen nach Nachfrage, KI-Hebel, Aufwand und Risiko. Kann bis zu drei Minuten dauern und verursacht begrenzte Apify-/KI-Nutzung.',
      parameters: z.object({ confirmed: z.boolean().describe('true nur wenn Nadine den aktuellen Scan ausdruecklich angefordert hat') }),
      execute: async ({ confirmed }) => confirmed ? await runOpportunityScout({ trigger: 'chat' }) : ({ ok: false, error: 'Bitte den Live-Scan zuerst ausdruecklich bestaetigen.' }),
    }),
    prepareOpportunityHandoff: tool({
      description: 'Bereitet fuer eine ausgewaehlte Chancenidee die Uebergabe an Marketing-, Kurs-, Web- oder Sales-Agent vor. Startet noch keine Umsetzung; gibt eine exakte Bestaetigungsformel zurueck.',
      parameters: z.object({ opportunityId: z.string() }),
      execute: async ({ opportunityId }) => await prepareOpportunityHandoff(opportunityId),
    }),
  };
}

export const opportunitiesSkillMeta = { id: 'opportunities', toolNames: ['listOpportunities', 'runOpportunityScout', 'prepareOpportunityHandoff'] };
