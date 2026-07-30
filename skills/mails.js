// Mails-Skill: eingehende Mails ueber alle Konten. Deps aus index.js.
import { tool } from 'ai';
import { z } from 'zod';

export function mailsSkill({ loadMailAccounts, fetchInbox }) {
  return {
    getMails: tool({
      description: 'Liest die neuesten E-Mails. Optional aus einem benannten Ordner wie "Regler" und/oder nur aus einem bestimmten Konto. Feld "bereich" = Firma (aus Empfaenger).',
      parameters: z.object({
        proKonto: z.number().int().min(1).max(50).optional(),
        ordner: z.string().min(1).optional(),
        konto: z.string().min(1).optional(),
      }),
      execute: async ({ proKonto, ordner, konto }) => {
        let all = [];
        let accounts = loadMailAccounts();
        if (konto) {
          const needle = konto.toLowerCase();
          accounts = accounts.filter(acc => `${acc.label} ${acc.user}`.toLowerCase().includes(needle));
        }
        for (const acc of accounts) {
          try { all = all.concat(await fetchInbox(acc, proKonto || 12, ordner || 'INBOX')); }
          catch (e) { all.push({ konto: acc.label, ordner: ordner || 'INBOX', fehler: e.message }); }
        }
        return { count: all.filter(x => !x.fehler).length, ordner: ordner || 'INBOX', mails: all };
      },
    }),
  };
}

export const mailsSkillMeta = { id: 'mails', toolNames: ['getMails'] };
