// CRM-Skill: Leads aus HeatHero + Mein CRM. Deps aus index.js.
import { tool } from 'ai';
import { z } from 'zod';

export function crmSkill({ fetchAllLeads }) {
  return {
    getLeads: tool({
      description: 'Ruft Leads ab. Ohne projekt: alle. Mit projekt: nur dieses.',
      parameters: z.object({ projekt: z.string().optional() }),
      execute: async ({ projekt }) => {
        let list = await fetchAllLeads();
        if (projekt) list = list.filter(x => x.projekt.toLowerCase().includes(projekt.toLowerCase()));
        return list.map(x => ({
          projekt: x.projekt,
          gruppe: x.gruppe,
          fehler: x.fehler,
          leads: x.leads ? JSON.stringify(x.leads).slice(0, 5000) : null,
        }));
      },
    }),
  };
}

export const crmSkillMeta = { id: 'crm', toolNames: ['getLeads'] };
