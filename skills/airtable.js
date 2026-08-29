import { tool } from 'ai';
import { z } from 'zod';

export function airtableSkill({ status, listInstallationQueue, listWorkflowStage, searchRecords, getRecord }) {
  return {
    getAirtableStatus: tool({
      description: 'Prueft IVAs direkte, ausschliesslich lesende Airtable-Verbindung zur Heat-Hero-Workflow-Base.',
      parameters: z.object({ livePruefung: z.boolean().optional() }),
      execute: async ({ livePruefung }) => status({ probe: livePruefung === true }),
    }),
    listAirtableInstallationQueue: tool({
      description: 'Liest alle aktuell in „Installation Queue“ stehenden Heat-Hero-Faelle live aus Airtable. Fuer ENTER-/Planbar-Workflows verwenden; Airtable wird dabei niemals veraendert.',
      parameters: z.object({ maxRecords: z.number().int().min(1).max(2000).optional() }),
      execute: async input => listInstallationQueue(input),
    }),
    listAirtableWorkflowStage: tool({
      description: 'Liest Heat-Hero-Faelle einer benannten Airtable-Workflow-Stufe live aus, zum Beispiel Angebotserstellung, Installation, Nacharbeiten, Rechnungsstellung oder Abschluss. Airtable bleibt unveraendert.',
      parameters: z.object({
        stage: z.string().min(1).max(300),
        maxRecords: z.number().int().min(1).max(2000).optional(),
      }),
      execute: async input => listWorkflowStage(input),
    }),
    searchAirtableWorkflowRecords: tool({
      description: 'Sucht Heat-Hero-Workflow-Datensaetze live in Airtable nach Kunde, Projektanschrift, HERO-ID, E-Mail oder Telefonnummer. Keine aehnlichen Treffer stillschweigend auswaehlen.',
      parameters: z.object({
        suche: z.string().min(2),
        nurInstallationQueue: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      execute: async ({ suche, nurInstallationQueue, limit }) => searchRecords(suche, { installationQueueOnly: nurInstallationQueue === true, limit: limit || 20 }),
    }),
    getAirtableWorkflowRecord: tool({
      description: 'Liest einen eindeutig bestimmten Airtable-Workflow-Datensatz mit Kontakt-, Termin- und korrigierten Angebotsmetadaten. Anhangs-URLs und Geheimnisse werden nicht an das Modell ausgegeben.',
      parameters: z.object({ recordId: z.string().regex(/^rec[a-zA-Z0-9]+$/) }),
      execute: async ({ recordId }) => getRecord(recordId),
    }),
  };
}

export const airtableSkillMeta = {
  id: 'airtable',
  toolNames: ['getAirtableStatus', 'listAirtableInstallationQueue', 'listAirtableWorkflowStage', 'searchAirtableWorkflowRecords', 'getAirtableWorkflowRecord'],
};
