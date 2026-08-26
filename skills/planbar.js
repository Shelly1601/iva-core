import { tool } from 'ai';
import { z } from 'zod';

export function planbarSkill({ searchPlanbarAppointments, enqueueDeviceCommand, deviceCommandStatus, getProject }) {
  return {
    searchPlanbar: tool({
      description: 'Sucht im zuletzt verifizierten Planbar-Stand nach Kundenname, Hersteller oder einem Stichwort aus der Auftragsbeschreibung. Liefert Kalenderwoche, Zeitraum und aktuelles Team. Für Formulierungen wie „in den nächsten drei Wochen“ weeks=3 verwenden. Die Suche verändert Planbar nicht.',
      parameters: z.object({
        suche: z.string().min(2).max(220),
        wochen: z.number().int().min(1).max(16).optional(),
      }),
      execute: async ({ suche, wochen }) => searchPlanbarAppointments({ query: suche, weeks: wochen || 0 }),
    }),
    listPlanbarCustomerTypes: tool({
      description: 'Liest die aktuell in der Heat-Hero-Projektakte gespeicherten Kundentypen, Planbar-Kürzel und Terminierungsmodi. Vor einer Terminierung verwenden, wenn der Partner nicht einer der eindeutigen Standardtypen Heat Hero, Enter oder D Warmte ist oder wenn Nadine nach den Auswahlmöglichkeiten fragt.',
      parameters: z.object({}),
      execute: async () => {
        const project = await getProject('heat-hero');
        return { customerTypes: project?.customerSchedulingPartners || [] };
      },
    }),
    scheduleCustomerInPlanbar: tool({
      description: 'Startet den vollständigen lokalen Workflow „Kunde terminieren“ direkt auf Nadines iMac. Verwenden, sobald Nadine einen eindeutig benannten Kunden und eine Kalenderwoche terminieren lässt. Kundentyp/Partner, Planbar-Kürzel und beide Materialfragen müssen eindeutig sein; nur fehlende Pflichtangaben kurz erfragen. Standardtypen: Heat Hero=HH/freier Fünf-Tage-Platz, Enter=EN/ENTER-Block zuerst, D Warmte=DW/freier Fünf-Tage-Platz. Bei Enter zusätzlich erfragen, ob bei fehlendem ENTER-Block ersatzweise ein vollständig freier Montag-bis-Freitag-Platz verwendet werden darf. Der Auftrag selbst ist die Freigabe, keine zusätzliche Bestätigung verlangen. Der Workflow prüft Pipedrive und Angebotsbelege, verifiziert Planbar sichtbar und sendet erst danach genau eine Bestätigung über die native WhatsApp-App in die richtige Community-Gruppe.',
      parameters: z.object({
        customerName: z.string().min(3).max(220),
        partnerId: z.string().min(1).max(80),
        partnerName: z.string().min(1).max(80),
        partnerPrefix: z.string().regex(/^[A-Z0-9]{1,6}$/),
        schedulingMode: z.enum(['free-resource', 'enter-block-first']),
        allowFreeResourceFallback: z.boolean().describe('Nur für Enter: true, wenn bei fehlendem vollständigem ENTER-Block ersatzweise ein vollständig freier Montag-bis-Freitag-Platz verwendet werden darf.'),
        isoYear: z.number().int().min(2000).max(2100),
        week: z.number().int().min(1).max(53),
        materialDeliverySpace: z.boolean().describe('Ob der Kunde Material einige Tage vor Montagebeginn annehmen kann.'),
        theftWeatherProtected: z.boolean().describe('Ob die Materiallagerung diebstahl- und wettersicher ist.'),
        additionalInfo: z.string().max(2000).optional(),
      }),
      execute: async input => {
        const command = await enqueueDeviceCommand({
          action: 'planbar.customer.schedule',
          payload: input,
          requestedBy: 'iva-planbar',
          requestText: `${input.customerName} in KW ${input.week}/${input.isoYear} terminieren`,
        });
        return {
          queued: true,
          commandId: command.id,
          deviceId: command.deviceId,
          status: command.status,
          message: 'Der vollständige Planbar-Terminierungsworkflow wurde direkt an Nadines iMac übergeben.',
        };
      },
    }),
    checkPlanbarSchedulingDispatch: tool({
      description: 'Prüft den Übergabestatus eines gestarteten Planbar-Terminierungsworkflows. Ein abgeschlossener Geräteauftrag mit jobId bedeutet, dass der lokale operative Codex-Lauf gestartet wurde; es bedeutet noch nicht automatisch, dass Planbar bereits verifiziert gespeichert ist.',
      parameters: z.object({ commandId: z.string().uuid() }),
      execute: async ({ commandId }) => ({ command: await deviceCommandStatus(commandId) }),
    }),
  };
}

export const planbarSkillMeta = { id: 'planbar', toolNames: ['searchPlanbar', 'listPlanbarCustomerTypes', 'scheduleCustomerInPlanbar', 'checkPlanbarSchedulingDispatch'] };
