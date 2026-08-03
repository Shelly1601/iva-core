import { tool } from 'ai';
import { z } from 'zod';

export function workspacesSkill({ workspaces }) {
  return {
    listWorkspaces: tool({
      description: 'Listet IVA-Arbeitsbereiche fuer Beratung, Kundenakte und Energieplanung. Optional nach mode filtern.',
      parameters: z.object({ mode: z.enum(['beratung', 'kunde', 'energie']).optional() }),
      execute: async ({ mode }) => ({ workspaces: await workspaces.listWorkspaces({ mode }) }),
    }),
    getWorkspace: tool({
      description: 'Liest eine bestehende IVA-Fallakte mit Kundendaten, Notizen, PLAUD-Status und Dateien.',
      parameters: z.object({ id: z.string() }),
      execute: async ({ id }) => await workspaces.getWorkspace(id),
    }),
    createWorkspace: tool({
      description: 'Legt einen neuen Arbeitsbereich an. mode: beratung | kunde | energie.',
      parameters: z.object({ mode: z.enum(['beratung', 'kunde', 'energie']), title: z.string().optional(), customerName: z.string().optional(), customerAddress: z.string().optional() }),
      execute: async ({ mode, title, customerName, customerAddress }) => await workspaces.createWorkspace({ mode, title, customer: { name: customerName, address: customerAddress } }),
    }),
    addWorkspaceNote: tool({
      description: 'Ergaenzt eine belegbare Notiz in einer IVA-Fallakte. Fehlende Werte niemals erfinden.',
      parameters: z.object({ id: z.string(), text: z.string(), source: z.string().optional() }),
      execute: async ({ id, text, source }) => await workspaces.addWorkspaceNote(id, text, source || 'iva-chat'),
    }),
  };
}

export const workspacesSkillMeta = { id: 'workspaces', toolNames: ['listWorkspaces', 'getWorkspace', 'createWorkspace', 'addWorkspaceNote'] };
