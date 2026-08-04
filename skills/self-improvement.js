import { tool } from 'ai';
import { z } from 'zod';

export function selfImprovementSkill({ savePronunciationCorrection, saveCommunicationPreference, captureImprovementRequest, listVoiceLearning }) {
  return {
    savePronunciationCorrection: tool({
      description: 'Speichert eine von Nadine ausdrücklich genannte Aussprachekorrektur dauerhaft. Sofort verwenden, wenn sie sagt, ein Begriff, Name oder Kürzel werde anders ausgesprochen. Nur Aussprache ändern, niemals die fachliche Bedeutung.',
      parameters: z.object({
        term: z.string().min(2).max(120).describe('Der geschriebene Begriff, der bisher falsch gesprochen wurde.'),
        spokenAs: z.string().min(2).max(180).describe('Die von Nadine gewünschte lautnahe Schreibweise.'),
        example: z.string().max(500).optional(),
      }),
      execute: async input => {
        const correction = await savePronunciationCorrection({ ...input, source: 'iva-chat' });
        return { ok: true, activeImmediately: true, term: correction.term, spokenAs: correction.spokenAs, message: `Aussprache ist ab der nächsten Sprachausgabe aktiv: ${correction.term} → ${correction.spokenAs}.` };
      },
    }),
    saveCommunicationPreference: tool({
      description: 'Speichert eine klare dauerhafte Korrektur von Nadine zu IVAs Kommunikationsstil, etwa kürzer sprechen, einen Ausdruck nicht mehr verwenden oder zuerst die Antwort nennen. Nur bei ausdrücklichem Feedback verwenden, nicht aus einer beiläufigen Bemerkung ableiten.',
      parameters: z.object({
        preference: z.string().min(3).max(500),
        context: z.string().max(100).optional(),
      }),
      execute: async input => {
        const item = await saveCommunicationPreference(input);
        return { ok: true, activeImmediately: true, preference: item.preference };
      },
    }),
    captureImprovementRequest: tool({
      description: 'Erfasst Nadines ausdrücklichen Wunsch nach einer neuen IVA-Funktion oder Systemänderung als kontrollierten Bauauftrag. Das Tool baut oder deployt noch nichts und darf niemals behaupten, die Funktion sei bereits umgesetzt.',
      parameters: z.object({
        title: z.string().min(3).max(180),
        description: z.string().min(3).max(4000),
        desiredOutcome: z.string().min(3).max(3000),
        acceptanceCriteria: z.array(z.string().max(500)).max(12).optional(),
        area: z.string().max(100).optional(),
        priority: z.enum(['low', 'normal', 'high']).optional(),
      }),
      execute: async input => {
        const request = await captureImprovementRequest(input);
        return { ok: true, status: request.status, requestId: request.id, title: request.title, codeChanged: false, deployed: false, next: 'Bauvorschlag und Tests erstellen; Code und Deployment separat bestätigen.' };
      },
    }),
    listSelfImprovements: tool({
      description: 'Zeigt gespeicherte Aussprachekorrekturen, Kommunikationspräferenzen und offene IVA-Bauaufträge.',
      parameters: z.object({}),
      execute: async () => listVoiceLearning(),
    }),
  };
}
