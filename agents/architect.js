import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { answer as knowledgeAnswer } from './knowledge.js';

// System Architect. Reiner Router: entscheidet, ob Knowledge uebernimmt.
// Formuliert NIEMALS selbst eine Fachantwort. Keine Rechnungen, keine
// Erklaerungen, keine Empfehlungen. Ausgabe ist immer ein JSON-Objekt in
// einer von drei Formen (siehe PlanSchema). Enforcement passiert dreifach:
// Prompt-Regel, Zod-Schema (kein content/answer-Feld existiert), Laenge-Cap
// auf note/clarify (verhindert Fachvortrag durch die Hintertuer).
const ARCH_SYSTEM = `Du bist der System Architect. Du bist ein Router, keine Fachinstanz. Deine EINZIGE Aufgabe ist zu entscheiden, wer die Anfrage bearbeitet.

Verfuegbar ist genau ein Sub-Agent:
- knowledge: reines Fachwissen zu Finanz, Versicherung, Vorsorge, Rente. Erklaert, rechnet, vergleicht, empfiehlt. Hat keinen Datenzugriff (kein CRM, keine Mails, kein Kalender, kein Web).

Du beantwortest NIEMALS selbst eine Fachfrage. Du rechnest nichts, erklaerst nichts, empfiehlst nichts, vergleichst nichts. Wenn du dabei ertappst, wie du Inhalte formulierst - stopp, entscheide stattdessen.

Deine Ausgabe ist ausschliesslich EIN JSON-Objekt in genau einer der drei Formen. Keine Prosa davor oder danach. Keine Markdown-Fences. Keine Erklaerung.

Form A - Frage an Knowledge weiterreichen:
{"action":"call-knowledge","question":"<die praezise Fachfrage, die knowledge beantworten soll>"}

Form B - Rueckfrage an Nadine, wenn die Intent unklar ist:
{"action":"clarify","clarify":"<kurze Rueckfrage, max 1 Satz>"}

Form C - passt nicht zu Knowledge:
{"action":"not-relevant","note":"<max 1 Satz warum nicht, keine Fachantwort>"}

Regeln fuer die Entscheidung:
- Finanz/Versicherung/Vorsorge/Rente/Steuer-Grundlagen ohne Live-Daten -> call-knowledge.
- Braucht Live-Daten oder eine Aktion (Mails, Kalender, CRM, Leads, Web, Kampagnen, Bilder) -> not-relevant. Knowledge hat keinen Datenzugriff.
- Small Talk, Meinung, Business-Strategie ausserhalb Finanz -> not-relevant.
- Intent mehrdeutig -> clarify.

Nur das JSON. Nichts sonst.`;

const PlanSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('call-knowledge'), question: z.string().min(1).max(1000) }),
  z.object({ action: z.literal('clarify'), clarify: z.string().min(1).max(300) }),
  z.object({ action: z.literal('not-relevant'), note: z.string().min(1).max(200) })
]);

function extractJson(text) {
  const s = String(text || '').trim();
  const cleaned = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

async function planOnce(intent, strictReminder = '') {
  const { text } = await generateText({
    model: anthropic('claude-haiku-4-5-20251001'),
    system: ARCH_SYSTEM + (strictReminder ? '\n\n' + strictReminder : ''),
    prompt: `Nadine fragt: "${intent}"\n\nWelche Aktion?`,
    temperature: 0
  });
  const raw = extractJson(text);
  if (!raw) return null;
  const parsed = PlanSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function askArchitect(intent) {
  const q = String(intent || '').trim();
  if (!q) return { source: 'architect', note: 'Keine Anfrage.' };

  let plan = await planOnce(q);
  if (!plan) plan = await planOnce(q, 'WICHTIG: Antworte ausschliesslich mit einem einzigen JSON-Objekt, keine Prosa, keine Markdown-Fences.');
  if (!plan) return { source: 'architect', note: 'Router-Antwort nicht parseable.' };

  if (plan.action === 'call-knowledge') {
    const ans = await knowledgeAnswer(plan.question);
    return { source: 'knowledge', answer: ans };
  }
  if (plan.action === 'clarify') return { source: 'architect', question: plan.clarify };
  return { source: 'architect', note: plan.note };
}
