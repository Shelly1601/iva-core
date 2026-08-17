import { tool } from 'ai';
import { z } from 'zod';

export function opportunitiesSkill({ listOpportunities, runOpportunityScout, checkOpportunityLink, runOpportunityMarketResearch, listOpportunityWatchSources, prepareOpportunityHandoff }) {
  return {
    listOpportunities: tool({
      description: 'Listet IVAs quellengepruefte Chancenideen, nach Potenzial-Score sortiert. Scores sind Priorisierung, keine Einkommensgarantie.',
      parameters: z.object({ status: z.enum(['new', 'watch', 'validate', 'rejected', 'selected']).optional(), limit: z.number().min(1).max(30).optional() }),
      execute: async ({ status, limit }) => ({ opportunities: await listOpportunities({ status, limit: limit || 10 }) }),
    }),
    runOpportunityScout: tool({
      description: 'Startet auf ausdruecklichen Wunsch einen neuen Instagram-Chancencheck via Apify und bewertet echte Quellen nach Nachfrage, KI-Hebel, Aufwand und Risiko. Kann bis zu drei Minuten dauern und verursacht begrenzte Apify-/KI-Nutzung.',
      parameters: z.object({ confirmed: z.boolean().describe('true nur wenn Nadine den aktuellen Scan ausdruecklich angefordert hat') }),
      execute: async ({ confirmed }) => confirmed ? await runOpportunityScout({ trigger: 'chat' }) : ({ ok: false, error: 'Bitte den Live-Scan zuerst ausdruecklich bestaetigen.' }),
    }),
    checkOpportunityLink: tool({
      description: 'Prüft einen einzelnen öffentlichen Link wahlweise auf Nutzen für eine IVA-Integration oder als Business-Chance. Trennt sichtbare Belege, Annahmen und Datenlücken und startet keine Umsetzung.',
      parameters: z.object({
        url: z.string().url(),
        mode: z.enum(['iva-integration', 'business']).describe('iva-integration für „Für IVA-Integration testen“, business für „Für Business checken“'),
      }),
      execute: async ({ url, mode }) => await checkOpportunityLink({ url, mode }),
    }),
    researchOpportunityMarket: tool({
      description: 'Recherchiert zu einem Thema passende Instagram-Profile, Fachwebseiten und weitere öffentliche Quellen, bewertet deren Content- und Beobachtungswert und speichert die Marktanalyse. Die regelmäßige Beobachtung wird erst nach separater Quellenauswahl aktiv.',
      parameters: z.object({
        topic: z.string().min(2).max(240),
        keywords: z.array(z.string().min(1).max(120)).max(12).optional(),
        region: z.string().max(120).optional(),
        language: z.string().max(80).optional(),
        confirmed: z.boolean().describe('true nur wenn Nadine die aktuelle kostenpflichtige Web-/Instagram-Recherche ausdrücklich angefordert hat'),
      }),
      execute: async ({ confirmed, ...input }) => confirmed ? await runOpportunityMarketResearch(input) : ({ ok: false, error: 'Bitte die aktuelle Marktanalyse zuerst ausdrücklich bestätigen.' }),
    }),
    listOpportunityWatchSources: tool({
      description: 'Listet die von Nadine ausgewählten Profile und Webseiten, auf die der regelmäßige Chancenradar zusätzlich schaut. Die freie Neuentdeckung bleibt parallel aktiv.',
      parameters: z.object({}),
      execute: async () => ({ sources: await listOpportunityWatchSources() }),
    }),
    prepareOpportunityHandoff: tool({
      description: 'Bereitet fuer eine ausgewaehlte Chancenidee die Uebergabe an Marketing-, Kurs-, Web- oder Sales-Agent vor. Startet noch keine Umsetzung; gibt eine exakte Bestaetigungsformel zurueck.',
      parameters: z.object({ opportunityId: z.string() }),
      execute: async ({ opportunityId }) => await prepareOpportunityHandoff(opportunityId),
    }),
  };
}

export const opportunitiesSkillMeta = { id: 'opportunities', toolNames: ['listOpportunities', 'runOpportunityScout', 'checkOpportunityLink', 'researchOpportunityMarket', 'listOpportunityWatchSources', 'prepareOpportunityHandoff'] };
