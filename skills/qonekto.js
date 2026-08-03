import { tool } from 'ai';
import { z } from 'zod';

export function qonektoSkill({
  sessionId,
  qonektoStatus,
  listQonektoTools,
  callQonektoReadTool,
  prepareQonektoWriteAction,
}) {
  return {
    qonektoStatus: tool({
      description: 'Prueft ausschliesslich, ob IVAs sichere Qonekto-/Blau-direkt-MCP-Leseverbindung erreichbar ist. Ruft keine Kundendaten ab und veraendert nichts.',
      parameters: z.object({}),
      execute: async () => qonektoStatus(),
    }),
    listQonektoTools: tool({
      description: 'Listet die von IVA freigegebenen Qonekto-/Blau-direkt-Werkzeuge samt Modus. mode=read darf sofort mit callQonektoReadTool ausgefuehrt werden. mode=write-with-confirmation darf ausschliesslich mit prepareQonektoWrite vorbereitet werden und benoetigt danach Nadines exakte Bestaetigung. Destruktive Werkzeuge werden nicht angezeigt.',
      parameters: z.object({
        search: z.string().optional().describe('Optionaler Suchbegriff fuer passende Qonekto-Werkzeuge, z. B. Kunde, Vertrag oder Dokument.'),
      }),
      execute: async ({ search }) => listQonektoTools({ search }),
    }),
    callQonektoReadTool: tool({
      description: 'Fuehrt genau ein zuvor gelistetes READ-ONLY-Werkzeug in Qonekto/Blau direkt aus. Darf ausschliesslich zum Lesen/Suchen/Abrufen genutzt werden. IVA blockiert unbekannte und schreibende Werkzeuge serverseitig, auch wenn der Token mehr Rechte besitzt.',
      parameters: z.object({
        toolName: z.string().min(1).describe('Exakter Name eines read-Werkzeugs aus listQonektoTools.'),
        arguments: z.record(z.unknown()).optional().describe('Argumente gemaess inputSchema des gelisteten Qonekto-Werkzeugs.'),
      }),
      execute: async ({ toolName, arguments: args }) => callQonektoReadTool(toolName, args || {}),
    }),
    prepareQonektoWrite: tool({
      description: 'Bereitet eine veraendernde Qonekto-/Blau-direkt-Aktion vor, fuehrt sie aber NOCH NICHT aus. Nur fuer Werkzeuge mit mode=write-with-confirmation aus listQonektoTools. Zeige Nadine danach Werkzeug und Aenderungen, frage "Willst du das wirklich machen?" und verlange exakt: "Ja, Qonekto-Aenderung ausfuehren". Erst eine spaetere Nutzernachricht mit genau diesem Satz loest die serverseitig gespeicherte Aktion aus. Niemals behaupten, die Aenderung sei bereits erfolgt.',
      parameters: z.object({
        toolName: z.string().min(1).describe('Exakter Name eines write-with-confirmation-Werkzeugs aus listQonektoTools.'),
        arguments: z.record(z.unknown()).optional().describe('Vollstaendige Argumente gemaess inputSchema des Qonekto-Werkzeugs.'),
      }),
      execute: async ({ toolName, arguments: args }) => prepareQonektoWriteAction({
        sessionId,
        toolName,
        args: args || {},
      }),
    }),
  };
}

export const qonektoSkillMeta = {
  id: 'qonekto',
  toolNames: ['qonektoStatus', 'listQonektoTools', 'callQonektoReadTool', 'prepareQonektoWrite'],
};
