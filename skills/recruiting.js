import { tool } from 'ai';
import { z } from 'zod';

export function recruitingSkill({ createCandidateSearchPlan, screenResumeAgainstCriteria, createInterviewGuide }) {
  return {
    createCandidateSearchPlan: tool({
      description: 'Erstellt aus einem Stellenprofil eine belegbare manuelle LinkedIn-Recruiter-Suche mit Suchbegriffen, Filtern und Pruefreihenfolge. Ruft keine Profile ab und verschickt nichts.',
      parameters: z.object({
        role: z.string(), mustHave: z.array(z.string()).min(1), niceToHave: z.array(z.string()).optional(),
        locations: z.array(z.string()).optional(), remote: z.string().optional(), languages: z.array(z.string()).optional(),
        seniority: z.array(z.string()).optional(), industries: z.array(z.string()).optional(),
      }),
      execute: async input => createCandidateSearchPlan(input),
    }),
    screenResumeAgainstCriteria: tool({
      description: 'Prueft einen bereitgestellten Lebenslauftext ausschliesslich gegen explizite jobrelevante Muss-/Kann-Kriterien und nennt Belegstellen sowie offene Fragen. Keine automatische Eignungs-, Zu- oder Absageentscheidung.',
      parameters: z.object({ role: z.string(), cvText: z.string(), mustHave: z.array(z.string()).min(1), niceToHave: z.array(z.string()).optional() }),
      execute: async input => screenResumeAgainstCriteria(input),
    }),
    createInterviewGuide: tool({
      description: 'Erstellt einen strukturierten Interviewleitfaden mit identischen Kernfragen und nachvollziehbarer Bewertungsrubrik fuer die Stellenkriterien.',
      parameters: z.object({ role: z.string(), mustHave: z.array(z.string()).min(1), niceToHave: z.array(z.string()).optional(), durationMinutes: z.number().min(20).max(120).optional() }),
      execute: async input => createInterviewGuide(input),
    }),
  };
}

export const recruitingSkillMeta = { id: 'recruiting', toolNames: ['createCandidateSearchPlan', 'screenResumeAgainstCriteria', 'createInterviewGuide'] };
