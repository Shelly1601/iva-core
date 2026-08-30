const checkedHeatHeroItems = Object.freeze([
  'Erdleitung / Schutzrohr',
  'Heizungsrohrleitung Pomp MP',
  'Adapter und Fittings Pomp MP',
  'Pufferspeicher 20 Liter mit Bypass',
  'Magnetfilter',
  'Warmwasserrohr Pomp T',
  'Heizungs-/Quellrohr Pomp T',
  'Anschlussmaterial Warmwasser-Zirkulation',
  'Elektroanschluss Pomp MP',
]);

export const DEWARMTE_MATERIAL_STANDARD = Object.freeze({
  specVersion: 1,
  cover: Object.freeze({
    source: 'installation-planning',
    sourcePage: 1,
    resultPage: 1,
    preserveUnchanged: true,
    title: 'Deckblatt aus der Installationsplanung',
  }),
  sections: Object.freeze([
    Object.freeze({ id: 'dewarmte', title: 'DeWarmte Material', items: Object.freeze([]), standardListPending: true }),
    Object.freeze({ id: 'heat-hero', title: 'HEAT|Hero Material', items: checkedHeatHeroItems, standardListPending: false }),
  ]),
  unclassifiedHeading: 'Vor finaler Bestellung klären',
  classificationSource: 'Nadines markierte Materialliste vom 30.08.2026',
});

export function dewarmteMaterialStandardSummary() {
  return {
    specVersion: DEWARMTE_MATERIAL_STANDARD.specVersion,
    cover: { ...DEWARMTE_MATERIAL_STANDARD.cover },
    sections: DEWARMTE_MATERIAL_STANDARD.sections.map(section => ({
      id: section.id,
      title: section.title,
      items: [...section.items],
      standardListPending: section.standardListPending,
    })),
    unclassifiedHeading: DEWARMTE_MATERIAL_STANDARD.unclassifiedHeading,
    classificationSource: DEWARMTE_MATERIAL_STANDARD.classificationSource,
  };
}
