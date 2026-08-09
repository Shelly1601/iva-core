import { tool } from 'ai';
import { z } from 'zod';

export function knowledgeLibrarySkill({ listKnowledgeLibrary, knowledgeLibraryStatus, assessKnowledgeSourceCandidate }) {
  return {
    getKnowledgeLibraryStatus: tool({
      description: 'Zeigt Umfang und Schutzregeln von IVAs versionierter Wissensmediathek.',
      parameters: z.object({}),
      execute: async () => knowledgeLibraryStatus(),
    }),
    listKnowledgeLibrary: tool({
      description: 'Listet kuratierte Quellen samt Autoritaet, Nutzungsrechten, erlaubter Verwendung und Sperren. Nur aktiv verifizierte Quellen duerfen als Retrieval-Quelle dienen.',
      parameters: z.object({ domain: z.string().optional(), status: z.string().optional() }),
      execute: async input => ({ sources: listKnowledgeLibrary(input) }),
    }),
    assessKnowledgeSourceCandidate: tool({
      description: 'Prueft eine neue Wissensquelle vor Aufnahme. Die Pruefung aktiviert oder kopiert noch keinen Inhalt.',
      parameters: z.object({
        title: z.string(), url: z.string(), publisher: z.string().optional(), rightsBasis: z.string().optional(),
        intendedUse: z.string().optional(), legalBasis: z.string().optional(), isPrimarySource: z.boolean().optional(),
        rightsConfirmed: z.boolean().optional(), containsPersonalData: z.boolean().optional(),
      }),
      execute: async input => assessKnowledgeSourceCandidate(input),
    }),
  };
}

export const knowledgeLibrarySkillMeta = { id: 'knowledgeLibrary', toolNames: ['getKnowledgeLibraryStatus', 'listKnowledgeLibrary', 'assessKnowledgeSourceCandidate'] };
