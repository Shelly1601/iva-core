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
    getInvestmentKnowledgeStatus: tool({
      description: 'Zeigt IVAs Investment-Playbook, Quellenhierarchie, Analyse-Linsen und deterministische Chartverfahren. Das ist der Qualitaetsstandard fuer Analysen, keine Renditegarantie.',
      parameters: z.object({ assetType: z.string().max(80).optional() }),
      execute: async ({ assetType }) => ({ status: investment.getInvestmentKnowledge(), playbook: investment.getInvestmentPlaybook(assetType || '') }),
    }),
    analyzeInvestmentInstrument: tool({
      description: 'Analysiert ein eindeutig identifiziertes Saxo-Instrument im Tages- und Wochenchart. Berechnet Trends, Renditen, SMA 20/50/200, RSI, ATR, Volatilitaet, Drawdown, Unterstuetzung/Widerstand und belegte Chartmuster. Beruecksichtigt Depotkontext und Datenverzoegerung. Das Ergebnis ist keine Orderfreigabe.',
      parameters: z.object({ instrument, accountKey: z.string().max(200).optional() }),
      execute: async input => await investment.analyzeInstrument(input),
    }),
    researchInvestmentInstrument: tool({
      description: 'Startet fuer ein Saxo-Instrument zusaetzlich zum Multi-Timeframe-Chart einen aktuellen Quellenresearch mit Originalquellen, Claim-Verifikation, Gegenpruefung und Gegenhypothese. Kann bis zu zwei Minuten dauern und nutzt begrenzte Such-/KI-Ressourcen. Start nur nach ausdruecklicher Bestaetigung; keine Orderausfuehrung.',
      parameters: z.object({ instrument, accountKey: z.string().max(200).optional(), confirmed: z.boolean() }),
      execute: async ({ confirmed, ...input }) => confirmed
        ? await investment.researchInstrument(input)
        : ({ ok: false, error: 'Bitte den aktuellen Quellenresearch zuerst ausdruecklich bestaetigen.' }),
    }),
    scanInvestmentOpportunities: tool({
      description: 'Prueft die IVA-Watchlist konsequent ueber Tages- und Wochencharts, erkennt Trends und Muster und priorisiert Kandidaten fuer tieferen Quellenresearch. Das Ranking ist keine Renditeprognose und sendet keine Order.',
      parameters: z.object({ limit: z.number().int().min(1).max(20).optional() }),
      execute: async input => await investment.screenOpportunities(input),
    }),
    getInvestmentMandate: tool({
      description: 'Zeigt monatliches Investmentbudget, Verlust-/Drawdown-Limits, Analyse-Takt, Autonomiestufe und die belegten Voraussetzungen fuer eine spaetere LIVE-Autonomie.',
      parameters: z.object({}),
      execute: async () => ({ mandate: await investment.getMandate(), readiness: await investment.autonomyReadiness() }),
    }),
    updateInvestmentMandate: tool({
      description: 'Aktualisiert das persoenliche monatliche IVA-Investmentmandat. Unbegrenztes Risiko und direkte LIVE-Autonomie sind technisch nicht zulaessig; moeglich sind beobachten, vorschlagen und SIM-autonom.',
      parameters: z.object({
        objective: z.string().max(800).optional(), monthlyAmount: z.number().min(0).max(10_000_000).optional(), currency: z.string().length(3).optional(),
        analysisCadence: z.enum(['daily', 'weekdays', 'weekly']).optional(), autonomyStage: z.enum(['observe', 'propose', 'sim-auto']).optional(),
        reservePct: z.number().min(0).max(100).optional(), maxMonthlyLossPct: z.number().min(0.5).max(50).optional(),
        maxDrawdownPct: z.number().min(1).max(80).optional(), maxPortfolioVolatilityPct: z.number().min(1).max(100).optional(),
        maxNewPositionsPerMonth: z.number().int().min(1).max(50).optional(), allowOptionsContracts: z.boolean().optional(),
        allowLeveragedProducts: z.boolean().optional(), notes: z.string().max(5000).optional(),
      }),
      execute: async input => await investment.updateMandate(input),
    }),
    listInvestmentAnalyses: tool({
      description: 'Listet gespeicherte Markt- und Quellenanalysen mit Datenstand, Quellenabdeckung und Decision-Gate.',
      parameters: z.object({ limit: z.number().int().min(1).max(100).optional(), key: z.string().max(200).optional() }),
      execute: async input => ({ items: await investment.listAnalyses(input) }),
    }),
    listInvestmentJournal: tool({
      description: 'Listet vorab dokumentierte Investmentprognosen und Reviews. Zeigt Kalibrierung statt nachtraeglicher Erfolgserzaehlungen.',
      parameters: z.object({ status: z.enum(['open', 'reviewed']).optional(), limit: z.number().int().min(1).max(500).optional() }),
      execute: async input => ({ items: await investment.listJournal(input), calibration: await investment.calibrationSummary() }),
    }),
    createInvestmentJournalEntry: tool({
      description: 'Speichert vor einer Entscheidung These, staerkste Gegenhypothese, Widerlegung, Referenzkurs, Horizont und Wahrscheinlichkeit eines positiven Kursverlaufs. Fuehrt keinen Handel aus.',
      parameters: z.object({
        instrument, analysisId: z.string().max(100).optional(), thesis: z.string().min(20).max(8000), counterThesis: z.string().min(10).max(5000),
        invalidation: z.string().min(10).max(5000), referencePrice: z.number().positive(), probabilityPositiveReturnPct: z.number().min(5).max(95),
        expectedReturnPct: z.number().min(-100).max(10000).optional(), horizonDays: z.number().int().min(1).max(3650), risks: z.array(z.string().max(200)).max(20).optional(), notes: z.string().max(5000).optional(),
      }),
      execute: async input => await investment.createJournalEntry(input),
    }),
    reviewInvestmentJournalEntry: tool({
      description: 'Bewertet eine vorab gespeicherte Prognose mit dem tatsaechlichen Review-Kurs und aktualisiert Brier-Score sowie Kalibrierung. Aendert keine Order.',
      parameters: z.object({ id: z.string().min(1).max(100), actualPrice: z.number().positive(), thesisHeld: z.boolean().optional(), notes: z.string().max(5000).optional() }),
      execute: async ({ id, ...input }) => await investment.reviewJournalEntry(id, input),
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
  toolNames: [
    'getInvestmentStatus', 'getInvestmentPortfolio', 'getInvestmentRiskReport', 'searchSaxoInstruments',
    'getInvestmentKnowledgeStatus', 'analyzeInvestmentInstrument', 'researchInvestmentInstrument', 'scanInvestmentOpportunities',
    'getInvestmentMandate', 'updateInvestmentMandate', 'listInvestmentAnalyses', 'listInvestmentJournal', 'createInvestmentJournalEntry', 'reviewInvestmentJournalEntry',
    'listInvestmentWatchlist', 'addInvestmentWatchlistItem', 'listInvestmentOrderDrafts', 'createInvestmentOrderDraft',
  ],
};
