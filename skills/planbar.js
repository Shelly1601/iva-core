import { tool } from 'ai';
import { z } from 'zod';

export function planbarSkill({ searchPlanbarAppointments }) {
  return {
    searchPlanbar: tool({
      description: 'Sucht im zuletzt verifizierten Planbar-Stand nach Kundenname, Hersteller oder einem Stichwort aus der Auftragsbeschreibung. Liefert Kalenderwoche, Zeitraum und aktuelles Team. Für Formulierungen wie „in den nächsten drei Wochen“ weeks=3 verwenden. Die Suche verändert Planbar nicht.',
      parameters: z.object({
        suche: z.string().min(2).max(220),
        wochen: z.number().int().min(1).max(16).optional(),
      }),
      execute: async ({ suche, wochen }) => searchPlanbarAppointments({ query: suche, weeks: wochen || 0 }),
    }),
  };
}

export const planbarSkillMeta = { id: 'planbar', toolNames: ['searchPlanbar'] };
