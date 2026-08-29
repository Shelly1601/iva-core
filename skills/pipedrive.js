import { tool } from 'ai';
import { z } from 'zod';

const WRITE_CONFIRMATION = 'Pipedrive schreiben';

function compactDealBundle(bundle = {}) {
  return {
    deal: bundle.deal || null,
    person: bundle.person || null,
    organization: bundle.organization || null,
    notes: Array.isArray(bundle.notes) ? bundle.notes.slice(0, 100) : [],
    files: Array.isArray(bundle.files) ? bundle.files.slice(0, 100) : [],
    activities: Array.isArray(bundle.activities) ? bundle.activities.slice(0, 100) : [],
  };
}

export function pipedriveSkill({
  status,
  searchDeals,
  listDeals,
  getDealBundle,
  createDealNote,
  updateDealStage,
  updateDealField,
}) {
  return {
    getPipedriveStatus: tool({
      description: 'Prueft IVAs direkte Pipedrive-Verbindung. Verwenden, wenn unklar ist, ob Live-Lesen oder Schreiben aktuell bereit ist.',
      parameters: z.object({ livePruefung: z.boolean().optional() }),
      execute: async ({ livePruefung }) => status({ probe: livePruefung === true }),
    }),
    searchPipedriveDeals: tool({
      description: 'Sucht Deals live im verbundenen Pipedrive, zum Beispiel nach Kundenname, Firma, Deal-Titel, E-Mail, Telefonnummer, Auftrags- oder Lead-ID. Bei Personennamen zuerst dieses Werkzeug verwenden und keinen aehnlichen Treffer stillschweigend auswaehlen.',
      parameters: z.object({
        suche: z.string().min(2),
        exakt: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      execute: async ({ suche, exakt, limit }) => searchDeals(suche, { exactMatch: exakt === true, limit: limit || 20 }),
    }),
    listPipedriveDeals: tool({
      description: 'Liest offene oder abgeschlossene Pipedrive-Deals einer Pipeline oder Phase live aus. Fuer Workflow-Listen und Phasenpruefungen verwenden; Pipedrive bleibt die fuehrende Datenquelle.',
      parameters: z.object({
        pipelineId: z.number().int().positive().optional(),
        stageId: z.number().int().positive().optional(),
        status: z.enum(['open', 'won', 'lost', 'deleted', 'all']).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        cursor: z.string().optional(),
      }),
      execute: async input => listDeals(input),
    }),
    getPipedriveDeal: tool({
      description: 'Liest einen eindeutig bestimmten Pipedrive-Deal mit Person, Organisation, Notizen, Dateien und Aktivitaeten live aus. Erst nach eindeutiger Suche oder mit einer bereits belegten Deal-ID verwenden.',
      parameters: z.object({ dealId: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]) }),
      execute: async ({ dealId }) => compactDealBundle(await getDealBundle(dealId)),
    }),
    addPipedriveDealNote: tool({
      description: `Fuegt einem eindeutig bestimmten Deal eine signierte IVA-Notiz hinzu. Nur aufrufen, wenn Nadine genau diese Notiz in ihrer aktuellen Nachricht ausdruecklich beauftragt oder mit „${WRITE_CONFIRMATION}“ bestaetigt hat. Das Werkzeug prueft Dubletten und liest die Notiz nach dem Speichern erneut.`,
      parameters: z.object({
        dealId: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]),
        text: z.string().min(1).max(20_000),
        confirmation: z.literal(WRITE_CONFIRMATION),
      }),
      execute: async input => createDealNote(input),
    }),
    movePipedriveDealStage: tool({
      description: `Verschiebt einen eindeutig bestimmten Pipedrive-Deal kontrolliert von einer erwarteten in eine freigegebene Zielphase. Nur aufrufen, wenn Nadine genau diese Phasenverschiebung aktuell ausdruecklich beauftragt oder mit „${WRITE_CONFIRMATION}“ bestaetigt hat. Vorher Deal und Ist-Phase lesen; nachher wird die Zielphase erneut geprueft.`,
      parameters: z.object({
        dealId: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]),
        expectedStageId: z.number().int().positive(),
        targetStageId: z.number().int().positive(),
        confirmation: z.literal(WRITE_CONFIRMATION),
      }),
      execute: async input => updateDealStage(input),
    }),
    updatePipedriveDealField: tool({
      description: `Aktualisiert genau ein freigegebenes Deal-Feld mit Schutz gegen parallele Aenderungen und Ruecklesepruefung. Erlaubt sind Deal-Titel, Wert, Waehrung, erwartetes Abschlussdatum, Wahrscheinlichkeit sowie die bekannten Heat-Hero-Felder. Nur aufrufen, wenn Nadine genau diese Aenderung aktuell ausdruecklich beauftragt oder mit „${WRITE_CONFIRMATION}“ bestaetigt hat. Den erwarteten aktuellen Wert immer unmittelbar vorher mit getPipedriveDeal lesen.`,
      parameters: z.object({
        dealId: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]),
        field: z.enum(['title', 'value', 'currency', 'expectedCloseDate', 'probability', 'salesPartner', 'leadId', 'salesStructure', 'salesId', 'installationWeek', 'orderNumber', 'plant', 'projectManager', 'installationTeam', 'transferredToHero']),
        expectedValue: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()])), z.null()]),
        value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()])), z.null()]),
        confirmation: z.literal(WRITE_CONFIRMATION),
      }),
      execute: async input => updateDealField(input),
    }),
  };
}

export const pipedriveSkillMeta = {
  id: 'pipedrive',
  toolNames: [
    'getPipedriveStatus',
    'searchPipedriveDeals',
    'listPipedriveDeals',
    'getPipedriveDeal',
    'addPipedriveDealNote',
    'movePipedriveDealStage',
    'updatePipedriveDealField',
  ],
};
