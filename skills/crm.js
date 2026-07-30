// CRM-Skill: eigenstaendiges Heat Hero CRM + getrenntes Multi CRM. Deps aus index.js.
import { tool } from 'ai';
import { z } from 'zod';

export function crmSkill({ fetchAllLeads, searchHeatHeroLeads, updateHeatHeroLeadStatus }) {
  return {
    getLeads: tool({
      description: 'Ruft Leads aus allen getrennten CRM-Systemen ab. Ohne projekt: alle. Mit projekt: nur dieses. „Heat Hero CRM (eigenstaendig)“ und „Heat Hero (im Multi CRM)“ sind verschiedene Datenquellen.',
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
    findHeatHeroLeads: tool({
      description: 'Sucht Kunden ausschliesslich im eigenstaendigen grossen Heat Hero CRM, zum Beispiel nach Name, E-Mail oder Telefonnummer. Nicht fuer den Heat-Hero-Anteil im Multi CRM verwenden.',
      parameters: z.object({
        suche: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async ({ suche, limit }) => searchHeatHeroLeads(suche, limit || 20),
    }),
    updateHeatHeroLeadStatus: tool({
      description: 'Aendert den Status eines Kunden ausschliesslich im eigenstaendigen grossen Heat Hero CRM. Nur aufrufen, wenn Nadine die konkrete Statusaenderung in ihrer aktuellen Nachricht ausdruecklich beauftragt oder bestaetigt hat. Vorher den Kunden mit findHeatHeroLeads eindeutig bestimmen. Die Aenderung wird im CRM protokolliert.',
      parameters: z.object({
        leadId: z.string().min(1),
        status: z.string().min(1),
        grund: z.string().optional(),
      }),
      execute: async ({ leadId, status, grund }) => updateHeatHeroLeadStatus(leadId, status, grund),
    }),
  };
}

export const crmSkillMeta = { id: 'crm', toolNames: ['getLeads', 'findHeatHeroLeads', 'updateHeatHeroLeadStatus'] };
