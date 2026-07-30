// Mails-Skill: eingehende Mails ueber alle Konten. Deps aus index.js.
import { tool } from 'ai';
import { z } from 'zod';

export function mailsSkill({ loadMailAccounts, fetchInbox }) {
  return {
    getMails: tool({
      description: 'Liest die neuesten E-Mails. Feld "bereich" = Firma (aus Empfaenger).',
      parameters: z.object({ proKonto: z.number().optional() }),
      execute: async ({ proKonto }) => {
        let all = [];
        for (const acc of loadMailAccounts()) {
          try { all = all.concat(await fetchInbox(acc, proKonto || 12)); }
          catch (e) { all.push({ konto: acc.label, fehler: e.message }); }
        }
        return { count: all.length, mails: all };
      },
    }),
  };
}

export const mailsSkillMeta = { id: 'mails', toolNames: ['getMails'] };
