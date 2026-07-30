// Calendar-Skill: Kalender + Calendly-Buchungen. Deps aus index.js.
import { tool } from 'ai';
import { z } from 'zod';

export function calendarSkill({ getEventsRaw, getCalendlyEvents, fmtEvents }) {
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
  };
}

export const calendarSkillMeta = { id: 'calendar', toolNames: ['getCalendar', 'getCalendly'] };
