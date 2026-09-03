import { tool } from 'ai';
import { z } from 'zod';

export function knowledgeLibrarySkill({ listKnowledgeLibrary, knowledgeLibraryStatus, assessKnowledgeSourceCandidate, knowledgeBaseStatus, searchKnowledgeBase, createKnowledgeEntry }) {
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
    getPersonalKnowledgeBaseStatus: tool({
      description: 'Zeigt Umfang und Verarbeitungsstand von Nadines persönlicher IVA-Wissensdatenbank mit eigenen Texten, Kursen und Dokumenten.',
      parameters: z.object({}),
      execute: async () => knowledgeBaseStatus(),
    }),
    searchPersonalKnowledgeBase: tool({
      description: 'Durchsucht Nadines persönliche Wissensdatenbank. Nutze dieses Werkzeug immer, wenn sie nach Wissen aus ihren eigenen Kursen, Unterlagen, Notizen oder hinterlegten Quellen fragt.',
      parameters: z.object({ query: z.string(), limit: z.number().int().min(1).max(12).optional() }),
      execute: async ({ query, limit }) => ({ query, results: await searchKnowledgeBase(query, { limit }) }),
    }),
    addPersonalKnowledge: tool({
      description: 'Speichert von Nadine ausdrücklich diktiertes oder eingefügtes Wissen in ihrer persönlichen Wissensdatenbank. Ein Link ohne Lerninhalt wird nur als Quelle vorgemerkt und gilt noch nicht als gelernt.',
      parameters: z.object({
        title: z.string(), kind: z.enum(['knowledge', 'course', 'document', 'link']).optional(), category: z.string().optional(),
        sourceUrl: z.string().optional(), tags: z.array(z.string()).optional(), content: z.string().optional(), notes: z.string().optional(),
        sourceOwner: z.enum(['own', 'licensed', 'public-reference']).optional(),
      }),
      execute: async input => createKnowledgeEntry(input),
    }),
  };
}

export const knowledgeLibrarySkillMeta = { id: 'knowledgeLibrary', toolNames: ['getKnowledgeLibraryStatus', 'listKnowledgeLibrary', 'assessKnowledgeSourceCandidate', 'getPersonalKnowledgeBaseStatus', 'searchPersonalKnowledgeBase', 'addPersonalKnowledge'] };
