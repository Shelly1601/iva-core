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
      description: 'Legt einen neuen leeren Arbeitsbereich an. mode: beratung | kunde | energie. Fuer Kundenakten aus einem CRM immer importCrmCustomerFile verwenden, damit Stammdaten, Notizen und Dublettenschutz erhalten bleiben.',
      parameters: z.object({ mode: z.enum(['beratung', 'kunde', 'energie']), title: z.string().optional(), customerName: z.string().optional(), customerAddress: z.string().optional() }),
      execute: async ({ mode, title, customerName, customerAddress }) => {
        const fingerprint = [mode, customerName, customerAddress].map(value => String(value || '').trim().toLocaleLowerCase('de')).join('|');
        return await workspaces.createWorkspace({
          mode,
          title,
          status: mode === 'kunde' ? 'active' : 'draft',
          customer: { name: customerName, address: customerAddress },
          data: mode === 'kunde' ? { idempotencyKey: `iva-chat:${fingerprint}` } : {},
        });
      },
    }),
    addWorkspaceNote: tool({
      description: 'Ergaenzt eine belegbare Notiz in einer IVA-Fallakte. Fehlende Werte niemals erfinden.',
      parameters: z.object({ id: z.string(), text: z.string(), source: z.string().optional() }),
      execute: async ({ id, text, source }) => await workspaces.addWorkspaceNote(id, text, source || 'iva-chat'),
    }),
    addWorkspaceMeeting: tool({
      description: 'Ordnet ein bereits ausgewertetes PLAUD-, Live-Coach- oder manuelles Gespraech einer IVA-Kundenakte zu. Nur nutzen, wenn die Einwilligung vor dem Gespraech dokumentiert wurde. Roh-Audio wird hier nicht gespeichert.',
      parameters: z.object({
        id: z.string(),
        source: z.enum(['plaud', 'live-coach', 'manual']),
        externalId: z.string().optional(),
        title: z.string(),
        occurredAt: z.string().optional(),
        internalSummary: z.string(),
        customerSummary: z.string(),
        decisions: z.array(z.string()).optional(),
        actionItems: z.array(z.string()).optional(),
        objections: z.array(z.string()).optional(),
        consentGranted: z.boolean(),
        consentMethod: z.string().optional(),
      }),
      execute: async ({ id, consentGranted, consentMethod, ...meeting }) => await workspaces.addWorkspaceMeeting(id, {
        ...meeting,
        consent: { granted: consentGranted, method: consentMethod || 'Durch Nadine vor dem Gespräch bestätigt' },
      }),
    }),
    createCustomerFollowUpDraft: tool({
      description: 'Erstellt aus einer oder mehreren geprueften Meeting-Zusammenfassungen einen Kunden-Follow-up-Entwurf. Das Werkzeug versendet niemals selbst.',
      parameters: z.object({ id: z.string(), meetingIds: z.array(z.string()).min(1), to: z.string().email().optional(), subject: z.string().optional() }),
      execute: async input => await workspaces.createWorkspaceFollowUpDraft(input.id, input),
    }),
  };
}

export const workspacesSkillMeta = { id: 'workspaces', toolNames: ['listWorkspaces', 'getWorkspace', 'createWorkspace', 'addWorkspaceNote', 'addWorkspaceMeeting', 'createCustomerFollowUpDraft'] };
