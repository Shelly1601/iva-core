import { tool } from 'ai';
import { z } from 'zod';

export function accountingSkill({ listAccountingEntities, listAccountingDocuments, getAccountingDocument, accountingSummary }) {
  return {
    getAccountingSummary: tool({
      description: 'Liest die IVA-Buchhaltungsübersicht für einen Monat. Liefert Vollständigkeit, offene Prüfungen und Summen, aber keine Steuerfreigabe.',
      parameters: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }),
      execute: async ({ month }) => await accountingSummary({ month }),
    }),
    listAccountingEntities: tool({
      description: 'Listet die in IVA getrennt geführten Firmen und Rechtsträger samt Gewinnermittlungs- und Umsatzsteuerstatus.',
      parameters: z.object({}),
      execute: async () => ({ entities: await listAccountingEntities() }),
    }),
    listAccountingDocuments: tool({
      description: 'Listet Belege aus IVAs eigener Belegablage. Optional nach Monat, Firma, Prüfstatus oder Suchbegriff filtern.',
      parameters: z.object({
        month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
        status: z.enum(['ready', 'review', 'blocked', 'green', 'yellow', 'red']).optional(),
        entityId: z.string().optional(),
        search: z.string().max(200).optional(),
      }),
      execute: async input => ({ documents: await listAccountingDocuments(input) }),
    }),
    getAccountingDocument: tool({
      description: 'Liest die strukturierten Angaben und offenen Prüfhinweise eines einzelnen IVA-Belegs. Das Original wird nicht verändert.',
      parameters: z.object({ id: z.string() }),
      execute: async ({ id }) => await getAccountingDocument(id),
    }),
  };
}

export const accountingSkillMeta = { id: 'accounting', toolNames: ['getAccountingSummary', 'listAccountingEntities', 'listAccountingDocuments', 'getAccountingDocument'] };
