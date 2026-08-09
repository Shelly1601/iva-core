import { tool } from 'ai';
import { z } from 'zod';

export function lumitSkill({
  lumitWorkflowConfig,
  listLumitApplications,
  createLumitServicedApplication,
  markLumitApplicationStep,
}) {
  return {
    getLumitWorkflow: tool({
      description: 'Liefert den verbindlichen Mannheimer-LUMIT-Ablauf mit Blau-direkt-Agenturnummer, Vermittlernummer, Rechnerlink, Zieladresse, PDF-Regel und gewuenschtem digitalen Policenweg. Veraendert nichts.',
      parameters: z.object({}),
      execute: async () => lumitWorkflowConfig(),
    }),
    listLumitServicedApplications: tool({
      description: 'Listet in IVA vorbereitete LUMIT-Vorgaenge vom Typ servicierter Antrag. Liest nur IVAs Nachprozessakte und veraendert weder Mannheimer noch Qonekto.',
      parameters: z.object({
        customerId: z.string().optional(),
        status: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      execute: async input => listLumitApplications(input),
    }),
    createLumitServicedApplication: tool({
      description: 'Legt NACH einem bestaetigten Mannheimer-Onlineabschluss einen lokalen IVA-Nachprozess als "servicierter Antrag" an. Erfordert das erzeugte Antrags-PDF, die Kontrolle von Agenturnummer 162-58556 und Vermittlernummer 009T7N sowie die dokumentierte Kundeneinwilligung zur digitalen Policenzustellung. Versendet noch keine E-Mail und schreibt noch nicht nach Qonekto.',
      parameters: z.object({
        customerId: z.string().min(1),
        customerName: z.string().min(1),
        workspaceId: z.string().min(1),
        applicationDocumentId: z.string().min(1),
        applicationFileName: z.string().min(1),
        applicationNumber: z.string().optional(),
        partnerId: z.string().optional(),
        requestedStartMode: z.enum(['immediate', 'specified-date']),
        requestedStartDate: z.string().optional(),
        operationalReadinessDate: z.string().optional(),
        note: z.string().optional(),
        completionConfirmed: z.literal(true),
        agencyNumberConfirmed: z.literal(true),
        brokerNumberConfirmed: z.literal(true),
        policyDigitalDeliveryConsentConfirmed: z.literal(true),
      }),
      execute: async input => createLumitServicedApplication(input),
    }),
    markLumitApplicationStep: tool({
      description: 'Markiert einen bereits tatsaechlich ausgefuehrten LUMIT-Nachprozess-Schritt in IVA. Darf E-Mail-Versand, Qonekto-Upload, Policeneingang, Hauswertschutz-Pruefung, Freigabe oder Kundenbereitstellung niemals selbst behaupten; nur nach realer Ausfuehrung markieren. Es gibt keine automatische Kundenweiterleitung.',
      parameters: z.object({
        id: z.string().min(1),
        step: z.enum(['emailSent', 'qonektoServicedApplicationCreated', 'qonektoDocumentUploaded', 'trackingHandedOff', 'policyDeliveryConfirmed', 'policyReceivedDigitally', 'policyReviewedByHauswertschutz', 'customerPackageApproved', 'customerPackageDelivered']),
        completed: z.boolean().optional(),
      }),
      execute: async ({ id, step, completed }) => markLumitApplicationStep(id, step, completed !== false),
    }),
  };
}

export const lumitSkillMeta = {
  id: 'lumit',
  toolNames: ['getLumitWorkflow', 'listLumitServicedApplications', 'createLumitServicedApplication', 'markLumitApplicationStep'],
};
