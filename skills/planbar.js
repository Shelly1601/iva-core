import { tool } from 'ai';
import { z } from 'zod';

export function planbarSkill({ searchPlanbarAppointments, addCustomerSchedulingRequest, deviceCommandStatus, getProject, listAgentRuns }) {
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
      description: 'Startet „Kunde terminieren“ über den zentralen iMac. ZUERST eindeutigen Kunden und zulässigen Montag-bis-Freitag-Slot in Planbar speichern und rücklesen, DANACH Angebots-/TMB-Auswertung und Ergänzungen. Fehlende Angebotsnummer, Beschreibung oder optionale Kontaktfelder verhindern nicht die Reservierung; nichts erfinden. Partner, Name, KW und Materialantworten müssen eindeutig sein. Heat Hero=HH, Enter=EN/ENTER-Block zuerst, D Warmte=DW. Ein freier Enter-Ersatzplatz erfordert die ausdrückliche Freigabe im Auftrag. Keine zweite Bestätigung. Nur der Reservierungsnachweis belegt den gesicherten Slot; offene Angaben/Nacharbeiten getrennt melden. Nach verifizierter Anlage folgen die eng freigegebenen Pipedrive- und nativen WhatsApp-Schritte. Keine Doppelanlage und keine Rücknahme des gesicherten Slots bei Folgefehlern.',
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
        const project = await addCustomerSchedulingRequest('heat-hero', input);
        const dispatch = project?.schedulingDispatch;
        if (!dispatch) throw new Error('Der Terminierungsauftrag konnte nicht übernommen werden.');
        return {
          queued: dispatch.status === 'queued',
          commandId: dispatch.commandId,
          deviceId: dispatch.deviceId,
          status: dispatch.status,
          executionVerified: false,
          message: project.customerSchedulingRequests[0].schedulingSummary,
        };
      },
    }),
    checkPlanbarSchedulingDispatch: tool({
      description: 'Prüft den Übergabestatus eines gestarteten Planbar-Terminierungsworkflows. Ein abgeschlossener Geräteauftrag mit jobId bedeutet, dass der lokale operative Codex-Lauf gestartet wurde; es bedeutet noch nicht automatisch, dass Planbar bereits verifiziert gespeichert ist.',
      parameters: z.object({ commandId: z.string().uuid() }),
      execute: async ({ commandId }) => {
        const command = await deviceCommandStatus(commandId);
        const jobId = command?.result?.jobId;
        const runs = jobId && listAgentRuns ? await listAgentRuns({ limit: 500 }) : [];
        const run = runs.find(item => item.jobId === jobId);
        return { command, taskStatus: run?.status || null, slotReserved: run?.planbarProgress?.reservation?.verified === true, planbarProgress: run?.planbarProgress || null, resultPreview: run?.resultPreview || '' };
      },
    }),
  };
}

export const planbarSkillMeta = { id: 'planbar', toolNames: ['searchPlanbar', 'listPlanbarCustomerTypes', 'scheduleCustomerInPlanbar', 'checkPlanbarSchedulingDispatch'] };
