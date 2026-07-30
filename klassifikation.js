// Mail-Klassifikation: nimmt eine Liste von Mail-Metadaten (aus fetchInbox
// in index.js), klassifiziert jede via Claude Haiku in eine von 5 Kategorien
// und liefert einen CRM-Aktions-Vorschlag pro Mail. Keine Schreib-Effekte
// aufs CRM - nur Vorschlaege.
//
// Nadines vier Ziel-Kategorien plus "sonstiges" als Auffang. "sonstiges" ist
// bewusst da: ohne Auffang wuerde das Modell die vier Kategorien ueberdehnen.
import { generateObject } from 'ai';
import { z } from 'zod';
import { chooseModel, recordUsage, checkBudget } from './core/router.js';

export const KATEGORIEN = [
  'disqualifiziert',
  'keine_antwort',
  'erneut_anrufen',
  'rueckfrage_offen',
  'sonstiges',
];

const AKTIONEN = [
  'wiedervorlage',    // in X Tagen erneut checken
  'disqualifizieren', // Lead schliessen
  'antworten',        // Nadine antwortet manuell
  'anruf',            // Nadine ruft an
  'notiz',            // nur Notiz am Lead
  'keine',            // nichts tun
];

const KlassifikationSchema = z.object({
  ergebnisse: z.array(z.object({
    index: z.number().int().min(0),
    kategorie: z.enum(KATEGORIEN),
    begruendung: z.string().max(300),
    vorschlag: z.object({
      aktion: z.enum(AKTIONEN),
      hinweis: z.string().max(300),
    }),
  })),
});

const SYSTEM = `Du bist ein disziplinierter Klassifikator fuer eingehende Geschaeftsmails
einer Finanz- und Versicherungsmaklerin. Du bekommst pro Mail: Absender, Empfaenger-
Adresse, Betreff, Bereich (Marke) und ob sie ungelesen ist. Optional einen Kurz-
Preview. Deine Aufgabe: jede Mail in EINE der folgenden Kategorien einordnen:

- disqualifiziert: Kunde/Interessent lehnt ab, storniert, "kein Interesse", "bitte keine Werbung"
- keine_antwort: automatische Antworten (Abwesenheit, Auto-Reply, Bounce, Zustellstatus, Newsletter, Systemmail)
- erneut_anrufen: Kunde bittet um Rueckruf, Terminvorschlag, Voicemail-Notification, "melde mich"
- rueckfrage_offen: Kunde stellt eine Frage oder wartet auf Rueckmeldung, die Nadine beantworten muss
- sonstiges: alles andere (Info-Mail ohne Aktion, Rechnung, interne Weiterleitung)

Regeln:
- Wenn Absender "noreply", "no-reply", "mailer-daemon", "postmaster" → keine_antwort
- Wenn Betreff "Abwesenheit", "Out of Office", "Auto-Reply", "Delivery Status" → keine_antwort
- Wenn Betreff/Preview "kein Interesse", "abbestellen", "Absage", "Storno" → disqualifiziert
- Wenn Betreff/Preview "Rueckruf", "melden Sie sich", "Termin", "Anruf" → erneut_anrufen
- Wenn Betreff mit "Re:" beginnt UND Fragezeichen/"Frage"/"koennen Sie" → rueckfrage_offen
- Im Zweifel: sonstiges. NIEMALS raten.

Fuer jede Mail auch einen CRM-Vorschlag geben (aktion + Hinweis). Nadine
entscheidet spaeter, ob sie den Vorschlag ausfuehrt. Nichts wird automatisch
ins CRM geschrieben.

Antworte ausschliesslich strukturiert nach Schema. Kein Vorwort, kein Nachwort.`;

// Klassifiziert eine Liste von Mails in EINEM Modell-Aufruf.
// Input:  [{ von, an, bereich, betreff, ungelesen, preview? }, ...]
// Output: [{...original, kategorie, begruendung, vorschlag: { aktion, hinweis } }, ...]
//         + { modell, dauerMs, tokensIn?, tokensOut? } als _meta am Ende
export async function klassifiziereMailBatch(mails, { temperature = 0 } = {}) {
  const routed = chooseModel({ task: 'classification' });
  if (!Array.isArray(mails) || mails.length === 0) {
    return { ergebnisse: [], _meta: { modell: routed.modelId, dauerMs: 0, hinweis: 'leere Eingabe' } };
  }
  const lines = mails.map((m, i) => {
    const preview = m.preview ? ` | preview="${String(m.preview).replace(/\s+/g, ' ').slice(0, 200)}"` : '';
    return `[${i}] bereich=${m.bereich || '?'} | an=${m.an || '?'} | von=${m.von || '?'} | ungelesen=${m.ungelesen ? 'ja' : 'nein'} | betreff="${String(m.betreff || '').replace(/\s+/g, ' ').slice(0, 200)}"${preview}`;
  }).join('\n');
  const prompt = `Hier sind ${mails.length} Mails, indiziert von 0 bis ${mails.length - 1}. Klassifiziere jede exakt einmal. Antworte mit dem Feld ergebnisse als Array von ${mails.length} Objekten.

${lines}`;
  await checkBudget(routed);
  const t0 = Date.now();
  const { object, usage } = await generateObject({
    model: routed.model,
    schema: KlassifikationSchema,
    system: SYSTEM,
    prompt,
    temperature,
  });
  await recordUsage(routed, usage);
  const dauerMs = Date.now() - t0;
  // Ergebnisse per index mit Original-Mails verknuepfen (defensiv, falls Modell
  // Reihenfolge oder Index vertauscht).
  const byIndex = new Map();
  for (const e of (object.ergebnisse || [])) byIndex.set(e.index, e);
  const ergebnisse = mails.map((m, i) => {
    const e = byIndex.get(i);
    if (!e) return { ...m, kategorie: 'sonstiges', begruendung: '(Modell hat diesen Index nicht klassifiziert)', vorschlag: { aktion: 'keine', hinweis: '' }, _fehler: 'kein_ergebnis' };
    return { ...m, kategorie: e.kategorie, begruendung: e.begruendung, vorschlag: e.vorschlag };
  });
  return {
    ergebnisse,
    _meta: {
      modell: routed.modelId,
      dauerMs,
      tokensIn: usage?.promptTokens ?? null,
      tokensOut: usage?.completionTokens ?? null,
      anzahl: mails.length,
    },
  };
}
