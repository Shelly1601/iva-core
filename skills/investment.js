import { tool } from 'ai';
import { z } from 'zod';

const instrument = z.object({
  uic: z.number().int().positive(),
  assetType: z.string().min(1).max(80),
  symbol: z.string().max(120).optional(),
  description: z.string().max(300).optional(),
  exchangeId: z.string().max(100).optional(),
  currency: z.string().max(3).optional(),
});

export function investmentSkill({ investment }) {
  return {
    getInvestmentStatus: tool({
      description: 'Prueft Saxo-Verbindung, verfuegbare Investment-Funktionen und den sicheren naechsten Einrichtungsschritt. Sendet keine Order.',
      parameters: z.object({}),
      execute: async () => await investment.status({ probe: false }),
    }),
    getInvestmentPortfolio: tool({
      description: 'Liest das aktuelle Saxo-Depot mit Kontowert, Liquiditaet, Positionen, offenen Orders, Performance und IVAs regelbasierter Risikoanalyse. Liefert Daten von Saxo, aber keine Renditegarantie und sendet keine Order.',
      parameters: z.object({}),
      execute: async () => await investment.portfolio(),
    }),
    getInvestmentRiskReport: tool({
      description: 'Prueft das aktuelle Saxo-Depot gegen Nadines hinterlegte Grenzen fuer Einzelpositionen, Liquiditaet, Margin, Short- und Hebelprodukte. Keine Anlageentscheidung wird automatisch getroffen.',
      parameters: z.object({}),
      execute: async () => await investment.riskReport(),
    }),
    searchSaxoInstruments: tool({
      description: 'Sucht handelbare Aktien, ETFs, Fonds und Anleihen direkt in Saxos Instrumentenreferenz. Das Suchergebnis ist noch keine Empfehlung.',
      parameters: z.object({ query: z.string().min(2).max(120), accountKey: z.string().max(200).optional() }),
      execute: async input => ({ instruments: await investment.searchInstruments(input) }),
    }),
    listInvestmentWatchlist: tool({
      description: 'Listet IVAs interne Investment-Watchlist samt festgehaltener These und Warnmarken.',
      parameters: z.object({}),
      execute: async () => ({ items: await investment.listWatchlist() }),
    }),
    addInvestmentWatchlistItem: tool({
      description: 'Nimmt ein zuvor eindeutig ueber Saxo identifiziertes Instrument in die IVA-Watchlist auf. Fuehrt keinen Kauf aus.',
      parameters: instrument.extend({ thesis: z.string().max(5000).optional(), targetPrice: z.number().positive().optional(), alertBelow: z.number().positive().optional(), alertAbove: z.number().positive().optional() }),
      execute: async input => await investment.addWatchlist(input),
    }),
    listInvestmentOrderDrafts: tool({
      description: 'Listet interne Orderentwuerfe und Saxo-Precheck-Ergebnisse. Ein Entwurf oder Precheck ist keine ausgefuehrte Order.',
      parameters: z.object({ status: z.enum(['draft', 'prechecked', 'blocked', 'archived']).optional() }),
      execute: async input => ({ items: await investment.listOrderDrafts(input) }),
    }),
    createInvestmentOrderDraft: tool({
      description: 'Erstellt nur einen internen, nachvollziehbaren Orderentwurf mit Investmentthese. Sendet niemals eine Order an Saxo. Ein spaeterer Saxo-Precheck erfolgt getrennt.',
      parameters: z.object({
        instrument,
        accountKey: z.string().max(200).optional(),
        accountId: z.string().max(120).optional(),
        direction: z.enum(['Buy', 'Sell']),
        amount: z.number().positive(),
        orderType: z.enum(['Market', 'Limit']),
        orderPrice: z.number().positive().optional(),
        durationType: z.enum(['DayOrder', 'GoodTillCancel']).optional(),
        thesis: z.string().min(10).max(8000),
        invalidation: z.string().max(4000).optional(),
        horizon: z.string().max(300).optional(),
        notes: z.string().max(5000).optional(),
      }),
      execute: async input => await investment.createOrderDraft(input),
    }),
  };
}

export const investmentSkillMeta = {
  id: 'investment',
  toolNames: ['getInvestmentStatus', 'getInvestmentPortfolio', 'getInvestmentRiskReport', 'searchSaxoInstruments', 'listInvestmentWatchlist', 'addInvestmentWatchlistItem', 'listInvestmentOrderDrafts', 'createInvestmentOrderDraft'],
};
