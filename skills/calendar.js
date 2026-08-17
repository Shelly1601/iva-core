// Calendar-Skill: Kalender + Calendly-Buchungen. Deps aus index.js.
import { tool } from 'ai';
import { z } from 'zod';

export function calendarSkill({ getEventsRaw, getCalendlyEvents, fmtEvents, listAppointmentTypes, createAppointmentType }) {
  return {
    getCalendar: tool({
      description: 'Liest Termine aus den Kalendern.',
      parameters: z.object({ days: z.number().optional() }),
      execute: async ({ days }) => {
        const ev = fmtEvents(await getEventsRaw(days || 7));
        return { count: ev.length, events: ev };
      },
    }),
    getCalendly: tool({
      description: 'Liest kommende Calendly-Buchungen.',
      parameters: z.object({ days: z.number().optional() }),
      execute: async ({ days }) => await getCalendlyEvents(days || 14),
    }),
    getIvaAppointmentTypes: tool({
      description: 'Listet IVAs eigene Terminarten und zeigt, welche nur Entwurf beziehungsweise bereits live sind.',
      parameters: z.object({}),
      execute: async () => ({ appointmentTypes: await listAppointmentTypes() }),
    }),
    createIvaAppointmentTypeDraft: tool({
      description: 'Legt eine neue IVA-Terminart als sicheren Entwurf an. Der teilbare Link wird nicht automatisch live geschaltet.',
      parameters: z.object({
        name: z.string().min(2),
        durationMinutes: z.number().int().min(15).max(240),
        description: z.string().optional(),
        locationKind: z.enum(['phone', 'video', 'onsite']).optional(),
        locationDetails: z.string().optional(),
      }),
      execute: async input => await createAppointmentType(input),
    }),
  };
}

export const calendarSkillMeta = { id: 'calendar', toolNames: ['getCalendar', 'getCalendly', 'getIvaAppointmentTypes', 'createIvaAppointmentTypeDraft'] };
