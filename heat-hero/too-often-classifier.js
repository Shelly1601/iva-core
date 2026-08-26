import { generateObject } from 'ai';
import { z } from 'zod';
import { checkBudget, chooseModel, recordUsage } from '../core/router.js';

const ReplyClassificationSchema = z.object({
  decision: z.enum(['reclamation', 'follow_up', 'manual_review']),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(500),
  evidenceQuote: z.string().max(500),
});

const SYSTEM = `Du klassifizierst ausschließlich die sichtbare Rückmeldung eines Wärmepumpen-Leads, der zuvor telefonisch zu oft nicht erreicht wurde.

Erlaubte Entscheidungen:
- reclamation: Der Kunde lehnt eindeutig ab, hat bereits anderweitig gekauft, erklärt die Anfrage für erledigt oder bittet eindeutig um Abschluss/Austragung.
- follow_up: Der Kunde bestätigt Interesse oder bittet um Rückruf. Ein konkreter Rückrufzeitpunkt wird separat deterministisch geprüft.
- manual_review: Frage, Widerspruch, Zurückstellung ohne klaren Zeitpunkt, unklare Aussage oder alles andere.

Regeln:
- Zitiere als evidenceQuote exakt eine kurze, unveränderte Stelle aus der Kundenrückmeldung.
- Ignoriere nicht die Rückmeldung, aber behandle zitierten alten Mailverlauf nicht als Kundenaussage.
- Im Zweifel immer manual_review. Nichts erfinden.
- Eine Löschbitte ist keine Erlaubnis, Daten automatisch zu löschen; sie kann zusätzlich zu reclamation vorliegen.`;

export async function classifyTooOftenReplyWithAi(message = {}) {
  const customerText = String(message.customerText || '').trim().slice(0, 20_000);
  if (!customerText) return { decision: 'manual_review', confidence: 0, reason: 'Kein lesbarer Nachrichtentext.', evidenceQuote: '' };
  const routed = chooseModel({ task: 'classification' });
  await checkBudget(routed);
  const { object, usage } = await generateObject({
    model: routed.model,
    schema: ReplyClassificationSchema,
    temperature: 0,
    system: SYSTEM,
    prompt: `Betreff: ${String(message.subject || '(kein Betreff)').slice(0, 500)}\nDatum: ${String(message.date || '')}\n\nKundenrückmeldung:\n${customerText}`,
  });
  await recordUsage(routed, usage);
  return object;
}
