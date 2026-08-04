export const BKV_OFFERS = [
  {
    id: 'allianz-meinegesundheit',
    provider: 'Allianz',
    tariff: 'MeineGesundheit',
    label: 'Allianz · MeineGesundheit',
    priceDate: '2026',
    minimumEmployees: 5,
    sourceUrl: 'https://www.allianz.de/business/betriebliche-krankenversicherung/',
    highlights: ['Budgettarif', 'ambulant, Zahn und Sehhilfe', 'Gesundheitsservices für Familienangehörige'],
    budgets: [
      { annual: 300, monthly: 13.9 }, { annual: 600, monthly: 22.9 }, { annual: 900, monthly: 32.9 },
      { annual: 1200, monthly: 41.9 }, { annual: 1500, monthly: 49.9 },
    ],
  },
  {
    id: 'hallesche-feelfree',
    provider: 'Hallesche',
    tariff: 'FEELfree',
    label: 'Hallesche · FEELfree',
    priceDate: 'öffentliche Tarifseite, Abruf 04.08.2026',
    sourceUrl: 'https://www.hallesche.de/geschaeftskunden/betriebliche-krankenversicherung/feelfree',
    highlights: ['Budgettarif', 'ambulant und dental', 'digitale Gesundheitsservices'],
    budgets: [
      { annual: 300, monthly: 9.95 }, { annual: 600, monthly: 19.75 }, { annual: 900, monthly: 28.27 },
      { annual: 1200, monthly: 36.16 }, { annual: 1500, monthly: 42.24 },
    ],
  },
  {
    id: 'hallesche-feelfree-plus',
    provider: 'Hallesche',
    tariff: 'FEELfree_plus',
    label: 'Hallesche · FEELfree_plus',
    priceDate: 'öffentliche Tarifseite, Abruf 04.08.2026',
    sourceUrl: 'https://www.hallesche.de/geschaeftskunden/betriebliche-krankenversicherung/feelfree',
    highlights: ['Budgettarif', 'FEELfree-Leistungen', 'zusätzlich Vorsorge und Schutzimpfungen'],
    budgets: [
      { annual: 300, monthly: 12.99 }, { annual: 600, monthly: 22.88 }, { annual: 900, monthly: 32.75 },
      { annual: 1200, monthly: 41.96 }, { annual: 1500, monthly: 49 },
    ],
  },
  {
    id: 'barmenia-bessergesund',
    provider: 'Barmenia',
    tariff: 'BesserGesund Budget',
    label: 'Barmenia · BesserGesund Budget',
    priceDate: 'Beitragstabelle 2026 · ohne Beitragsbefreiung',
    sourceUrl: 'https://media.barmenia.de/media/global_media/dokumente/content_dokumente/subwebs_1/barmenia_firmenloesungen/bkv_1/beratung_begleitung/WK2051.pdf',
    highlights: ['Budgettarif', 'separate Zahn- und Vorsorgebausteine verfügbar', 'Beitrag mit oder ohne Beitragsbefreiung'],
    budgets: [
      { annual: 300, monthly: 12.9 }, { annual: 600, monthly: 20.8 }, { annual: 900, monthly: 29 },
    ],
  },
  {
    id: 'axa-flexmed-easy-premium',
    provider: 'AXA',
    tariff: 'FlexMed easy Premium',
    label: 'AXA · FlexMed easy Premium',
    priceDate: 'Tarifübersicht 10/2025 · inkl. Beitragsbefreiung',
    minimumEmployees: 5,
    sourceUrl: 'https://entry.axa.de/axa-makler/pb/site/me-2022/get/documents_E1832769458/makler-extranet/AXA_Makler/Firmen_Industrie/Mitarbeitendenabsicherung/Betriebliche%20Krankenversicherung/Budgettarif/Vergleich%20der%20FlexMed%20Budget-Tarife_10-2025.pdf',
    highlights: ['Premium-Budgettarif', 'ambulant und Zahn', 'Psychotherapie und Krankenhaustagegeld laut Tarifübersicht'],
    budgets: [
      { annual: 300, monthly: 13.59 }, { annual: 600, monthly: 24.3 }, { annual: 900, monthly: 30.86 },
      { annual: 1200, monthly: 39.18 }, { annual: 1500, monthly: 46.33 },
    ],
  },
  {
    id: 'gothaer-flexselect-premium',
    provider: 'Gothaer',
    tariff: 'FlexSelect Premium',
    label: 'Gothaer · FlexSelect Premium',
    priceDate: 'Preis bitte aktuell anfragen',
    minimumEmployees: 5,
    sourceUrl: 'https://partner.gothaer.de/microsite/bkv.html',
    highlights: ['Budgettarif', '300 bis 1.250 Euro Budget', 'digitale Services und Familienoption'],
    budgets: [{ annual: 300 }, { annual: 500 }, { annual: 750 }, { annual: 1000 }, { annual: 1250 }],
  },
  {
    id: 'sdk-gesundwerker-budget',
    provider: 'SDK',
    tariff: 'Gesundwerker BudgetTarife',
    label: 'SDK · Gesundwerker BudgetTarife',
    priceDate: 'Preis bitte aktuell anfragen',
    sourceUrl: 'https://gesundwerker.sdk.de/gesundheitskonzept/betriebliche-krankenversicherung/budgettarife',
    highlights: ['AmbulantBudget und ZahnBudget getrennt wählbar', '500, 1.000 oder 1.500 Euro', 'ServicePLUS inklusive'],
    budgets: [{ annual: 500 }, { annual: 1000 }, { annual: 1500 }],
  },
  {
    id: 'dkv-budgetbausteine',
    provider: 'DKV',
    tariff: 'Budgetbausteine',
    label: 'DKV · Budgetbausteine',
    priceDate: 'Beitrag abhängig von Belegschaft und Branche',
    sourceUrl: 'https://www.dkv.com/betriebliche-krankenversicherung.html',
    highlights: ['300, 600, 900 oder 1.200 Euro Budget', 'keine Gesundheitsprüfung', 'Arbeitgeber- und Leistungsportal'],
    budgets: [{ annual: 300 }, { annual: 600 }, { annual: 900 }, { annual: 1200 }],
  },
];

export const BKV_OFFER_OPTIONS = [
  ...BKV_OFFERS.map(offer => ({ value: offer.id, label: offer.label })),
  { value: 'manual', label: 'Anderer / eigener Tarif' },
];

export const BKV_BUDGET_OPTIONS = [300, 500, 600, 750, 900, 1000, 1200, 1250, 1500]
  .map(value => ({ value: String(value), label: `${new Intl.NumberFormat('de-DE').format(value)} € Jahresbudget` }));

export function findBkvOffer(id) {
  return BKV_OFFERS.find(offer => offer.id === id) || null;
}

export function applyBkvOfferSelection(data = {}, changedKey = 'bkvOfferId') {
  const offer = findBkvOffer(data.bkvOfferId);
  if (!offer) return data;
  if (changedKey === 'bkvOfferId') {
    data.bkvProvider = offer.provider;
    data.bkvTariff = offer.tariff;
    const available = offer.budgets.map(item => String(item.annual));
    if (!available.includes(String(data.bkvBudgetLevel || ''))) data.bkvBudgetLevel = String(offer.budgets[0]?.annual || '');
  }
  const budget = offer.budgets.find(item => String(item.annual) === String(data.bkvBudgetLevel || ''));
  data.bkvAnnualBudget = budget ? `${new Intl.NumberFormat('de-DE').format(budget.annual)} € Jahresbudget` : '';
  data.bkvMonthlyPremium = Number.isFinite(budget?.monthly) ? String(budget.monthly).replace('.', ',') : '';
  return data;
}

export const BKV_CATALOG_SOURCES = BKV_OFFERS.map(offer => ({
  id: `bkv-offer-${offer.id}`,
  title: `${offer.provider} · ${offer.tariff}`,
  publisher: offer.provider,
  year: offer.priceDate,
  url: offer.sourceUrl,
  scope: `${offer.highlights.join(' · ')}. Beiträge sind nur eine öffentliche Vorbelegung und vor Verwendung über ein aktuelles Angebot zu bestätigen.`,
}));
