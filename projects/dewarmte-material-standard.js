const item = (quantity, material, note, needsClarification = false) => Object.freeze({
  quantity, material, note, needsClarification,
});

const dewarmteItems = Object.freeze([
  item('1 Stk.', 'Monoblock-Wärmepumpe Pomp MP', 'Außengerät; Aufstellung im Vorgarten.'),
  item('1 Stk.', 'Warmwasser-Wärmepumpe Pomp T', '200 Liter; Aufstellung im Heizungsraum.'),
  item('1 Satz', 'Fundamentmaterial für Pomp MP', 'Abmessungen nach Hersteller- und Aufstellvorgaben.'),
  item('1 Satz', 'Gummifüße (Bigfoots)', 'Zuordnung, Traglast und Ausführung vor Bestellung klären.', true),
  item('1 Stk.', 'Steuerungseinheit', 'Montage und Einbindung für Pomp MP / Pomp T.'),
  item('1 Stk.', 'Tado-Thermostat', 'Genauen Lieferumfang und Zuordnung vor Bestellung klären.', true),
  item('2 m', 'Steuerungskabel Pomp T', 'Datenkabel zwischen Pomp T und Steuerungseinheit.'),
  item('nach Weg', 'SG-ready-Signalkabel', 'SOL SIGNAAL YY DCA S2 2x1,5, grau R100; Länge vor Ort festlegen.'),
]);

const heatHeroItems = Object.freeze([
  item('5 m', 'Erdleitung / Schutzrohr', 'Für Pomp MP; tatsächliche Rohrmeter vor Bestellung bestätigen.'),
  item('ca. 7 m', 'Heizungsrohrleitung Pomp MP', 'Ca. 3 m außen und 4 m innen; Henco 20 mm / 3/4 Zoll.'),
  item('1 Satz', 'Adapter und Fittings Pomp MP', 'Übergang Henco 20 mm / 3/4 Zoll auf Stahl 22 mm / 3/4 Zoll; Stückzahl nach Leitungsweg.'),
  item('1 Stk.', 'Pufferspeicher 20 Liter mit Bypass', 'Hydraulische Einbindung und Anschlüsse vor Bestellung bestätigen.', true),
  item('1 Stk.', 'Magnetfilter', 'Anschlussgröße gemäß Installationsplanung bestätigen.'),
  item('ca. 1 m', 'Warmwasserrohr Pomp T', 'Kupfer 22 mm / 3/4 Zoll.'),
  item('ca. 1 m', 'Heizungs-/Quellrohr Pomp T', 'Stahl 22 mm / 3/4 Zoll.'),
  item('1 Satz', 'Anschlussmaterial Warmwasser-Zirkulation', 'Benötigte Verbinder und Absperrungen vor Ort festlegen.'),
  item('1 Satz', 'Elektroanschluss Pomp MP', 'Kabellänge und Schutzorgane vor Ort prüfen.'),
]);

export const DEWARMTE_MATERIAL_STANDARD = Object.freeze({
  specVersion: 2,
  cover: Object.freeze({
    source: 'installation-planning',
    sourcePage: 1,
    resultPage: 1,
    preserveUnchanged: true,
    title: 'Deckblatt aus der Installationsplanung',
  }),
  sections: Object.freeze([
    Object.freeze({ id: 'dewarmte', title: 'DeWarmte Material', orderPageTitle: 'Materialbestellung DeWarmte', items: dewarmteItems, standardListPending: true }),
    Object.freeze({ id: 'heat-hero', title: 'HEAT|Hero Material', orderPageTitle: 'Materialbestellung HEAT|Hero', items: heatHeroItems, standardListPending: false }),
  ]),
  orderAppendix: Object.freeze({
    enabled: true,
    sectionOrder: Object.freeze(['heat-hero', 'dewarmte']),
    separatePagePerSection: true,
    repeatProjectData: true,
    detachable: true,
  }),
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
      orderPageTitle: section.orderPageTitle,
      items: section.items.map(entry => ({ ...entry })),
      standardListPending: section.standardListPending,
    })),
    orderAppendix: {
      ...DEWARMTE_MATERIAL_STANDARD.orderAppendix,
      sectionOrder: [...DEWARMTE_MATERIAL_STANDARD.orderAppendix.sectionOrder],
    },
    unclassifiedHeading: DEWARMTE_MATERIAL_STANDARD.unclassifiedHeading,
    classificationSource: DEWARMTE_MATERIAL_STANDARD.classificationSource,
  };
}
