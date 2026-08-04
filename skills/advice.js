import { tool } from 'ai';
import { z } from 'zod';

export function adviceSkill({ publicAdviceCatalog, listAdviceKnowledge }) {
  return {
    listAdviceModules: tool({
      description: 'Listet die vorhandenen IVA-Beratungsmodule fuer Finanzplanung, DIN-orientierte Analyse, Firmenvorsorge, bKV/bAV, Altersvorsorge, Depotvergleich, Vertragsvergleich, Immobilien, GKV und Energie.',
      parameters: z.object({ group: z.enum(['finance', 'retirement', 'insurance', 'property', 'health', 'corporate', 'energy']).optional() }),
      execute: async ({ group }) => {
        const catalog = publicAdviceCatalog();
        return { modules: catalog.modules.filter(module => !group || module.group === group).map(module => ({ id: module.id, title: module.title, short: module.short, status: module.status, notice: module.notice || '' })) };
      },
    }),
    searchAdviceKnowledge: tool({
      description: 'Durchsucht IVAs quellenbasierte Beratungs-Wissensbibliothek nach Versicherer, Produkt, Tarif, Jahr oder Dokument. Keine Treffer niemals durch geratene Produktleistungen ersetzen.',
      parameters: z.object({ search: z.string().min(2).max(200), category: z.string().max(100).optional() }),
      execute: async ({ search, category }) => await listAdviceKnowledge({ search, category, limit: 30 }),
    }),
  };
}

export const adviceSkillMeta = { id: 'advice', toolNames: ['listAdviceModules', 'searchAdviceKnowledge'] };
