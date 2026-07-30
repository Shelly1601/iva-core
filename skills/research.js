// Research-Skill: wrapt askArchitect (Router zwischen Knowledge und Web-Research).
// Tool-Beschreibung 1:1 wie zuvor - IVAs Anweisungen an dieses Tool haengen
// woertlich an dieser Description.
import { tool } from 'ai';
import { z } from 'zod';

export function researchSkill({ askArchitect }) {
  return {
    askArchitect: tool({
      description: 'Router fuer Fach- UND Recherche-Anfragen. Delegiert intern an: knowledge (zeitloses Fachwissen zu Finanz/Versicherung/Vorsorge/Rente OHNE Aktualitaets-Anspruch) ODER web-research (aktuelle oeffentliche Fakten: Gesetze, Grenzwerte, Sozialversicherungs-Beitragsbemessungsgrenzen, Steuersaetze, Freibetraege, Foerderbedingungen, Produktdatenblaetter, Versicherungsbedingungen, Preise, Nachrichten, Wetter, Oeffnungszeiten, allgemeine Live-Recherche im Web). PFLICHT fuer JEDE Frage nach einem konkreten aktuellen Wert (Grenzwerte, Steuersaetze, Freibetraege, Beitraege, Preise, Datum-abhaengige Fakten) - solche Werte NIEMALS aus dem Kopf beantworten oder schaetzen, IMMER diesen Router nutzen. NICHT fuer eigene Systeme (Kalender/Mails/CRM/Leads/Kampagnen/Todos) - dafuer die direkten Tools. Ergebnis-Formen: { source:"knowledge", answer } | { source:"web-research", result: { overallConfidence, claims[], answerBrief, gaps[], unverifiedNotice? } } | { source:"architect", question|note }. WICHTIG bei web-research: wenn overallConfidence "unknown" ist ODER unverifiedNotice gesetzt ist, antworte woertlich "Ich konnte dazu gerade keine verlaessliche Information finden." - nichts erfinden, nichts hinzuschaetzen, nicht mit eigenem Wissen mischen. Sonst uebernimm ausschliesslich die recherchierten Werte.',
      parameters: z.object({ intent: z.string() }),
      execute: async ({ intent }) => {
        const t0 = Date.now();
        console.log(`[${new Date().toISOString()}] [IVA] tool askArchitect start | intent="${String(intent).slice(0, 80)}"`);
        const res = await askArchitect(intent);
        console.log(`[${new Date().toISOString()}] [IVA] tool askArchitect finished | source=${res?.source || 'n/a'} | duration=${Date.now() - t0}ms`);
        return res;
      },
    }),
  };
}

export const researchSkillMeta = { id: 'research', toolNames: ['askArchitect'] };
