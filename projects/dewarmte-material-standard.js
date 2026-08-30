const item = (quantity, material, note, needsClarification = false, translations = {}) => Object.freeze({
  quantity, material, note, needsClarification,
  translations: Object.freeze(Object.fromEntries(Object.entries(translations).map(([language, value]) => [language, Object.freeze(value)]))),
});

const tr = (enQuantity, enMaterial, enNote, nlQuantity, nlMaterial, nlNote) => ({
  en: { quantity: enQuantity, material: enMaterial, note: enNote },
  nl: { quantity: nlQuantity, material: nlMaterial, note: nlNote },
});

const dewarmteItems = Object.freeze([
  item('1 Stk.', 'Monoblock-Wärmepumpe Pomp MP', 'Außengerät; Aufstellung im Vorgarten.', false, tr('1 pc.', 'Pomp MP monobloc heat pump', 'Outdoor unit; installed in the front garden.', '1 st.', 'Monoblock-warmtepomp Pomp MP', 'Buitenunit; plaatsing in de voortuin.')),
  item('1 Stk.', 'Warmwasser-Wärmepumpe Pomp T', '200 Liter; Aufstellung im Heizungsraum.', false, tr('1 pc.', 'Pomp T domestic hot-water heat pump', '200 litres; installed in the boiler room.', '1 st.', 'Warmtapwater-warmtepomp Pomp T', '200 liter; plaatsing in de stookruimte.')),
  item('1 Satz', 'Fundamentmaterial für Pomp MP', 'Abmessungen nach Hersteller- und Aufstellvorgaben.', false, tr('1 set', 'Foundation materials for Pomp MP', 'Dimensions according to manufacturer and installation requirements.', '1 set', 'Fundatiemateriaal voor Pomp MP', 'Afmetingen volgens de voorschriften van fabrikant en opstelling.')),
  item('1 Satz', 'Gummifüße (Bigfoots)', 'Zuordnung, Traglast und Ausführung vor Bestellung klären.', true, tr('1 set', 'Rubber feet (Bigfoots)', 'Confirm allocation, load rating and design before ordering.', '1 set', 'Rubberen voeten (Bigfoots)', 'Toewijzing, draagvermogen en uitvoering vóór bestelling afstemmen.')),
  item('1 Stk.', 'Steuerungseinheit', 'Montage und Einbindung für Pomp MP / Pomp T.', false, tr('1 pc.', 'Control unit', 'Installation and integration for Pomp MP / Pomp T.', '1 st.', 'Regeleenheid', 'Montage en integratie voor Pomp MP / Pomp T.')),
  item('1 Stk.', 'Tado-Thermostat', 'Genauen Lieferumfang und Zuordnung vor Bestellung klären.', true, tr('1 pc.', 'Tado thermostat', 'Confirm the exact scope of supply and allocation before ordering.', '1 st.', 'Tado-thermostaat', 'Exacte leveringsomvang en toewijzing vóór bestelling afstemmen.')),
  item('2 m', 'Steuerungskabel Pomp T', 'Datenkabel zwischen Pomp T und Steuerungseinheit.', false, tr('2 m', 'Pomp T control cable', 'Data cable between Pomp T and the control unit.', '2 m', 'Besturingskabel Pomp T', 'Datakabel tussen Pomp T en de regeleenheid.')),
  item('nach Weg', 'SG-ready-Signalkabel', 'SOL SIGNAAL YY DCA S2 2x1,5, grau R100; Länge vor Ort festlegen.', false, tr('as routed', 'SG-ready signal cable', 'SOL SIGNAAL YY DCA S2 2x1.5, grey R100; determine length on site.', 'volgens tracé', 'SG-ready-signaalkabel', 'SOL SIGNAAL YY DCA S2 2x1,5, grijs R100; lengte ter plaatse bepalen.')),
]);

const heatHeroItems = Object.freeze([
  item('5 m', 'Erdleitung / Schutzrohr', 'Für Pomp MP; tatsächliche Rohrmeter vor Bestellung bestätigen.', false, tr('5 m', 'Underground pipe / protective conduit', 'For Pomp MP; confirm the actual pipe length before ordering.', '5 m', 'Grondleiding / beschermbuis', 'Voor Pomp MP; werkelijke leidinglengte vóór bestelling bevestigen.')),
  item('ca. 7 m', 'Heizungsrohrleitung Pomp MP', 'Ca. 3 m außen und 4 m innen; Henco 20 mm / 3/4 Zoll.', false, tr('approx. 7 m', 'Pomp MP heating pipe', 'Approx. 3 m outdoors and 4 m indoors; Henco 20 mm / 3/4 inch.', 'ca. 7 m', 'Verwarmingsleiding Pomp MP', 'Ca. 3 m buiten en 4 m binnen; Henco 20 mm / 3/4 inch.')),
  item('1 Satz', 'Adapter und Fittings Pomp MP', 'Übergang Henco 20 mm / 3/4 Zoll auf Stahl 22 mm / 3/4 Zoll; Stückzahl nach Leitungsweg.', false, tr('1 set', 'Pomp MP adapters and fittings', 'Transition from Henco 20 mm / 3/4 inch to 22 mm / 3/4 inch steel; quantity according to route.', '1 set', 'Adapters en fittingen Pomp MP', 'Overgang Henco 20 mm / 3/4 inch naar staal 22 mm / 3/4 inch; aantal volgens leidingtracé.')),
  item('1 Stk.', 'Pufferspeicher 20 Liter mit Bypass', 'Hydraulische Einbindung und Anschlüsse vor Bestellung bestätigen.', true, tr('1 pc.', '20-litre buffer tank with bypass', 'Confirm hydraulic integration and connections before ordering.', '1 st.', 'Buffervat 20 liter met bypass', 'Hydraulische aansluiting en koppelingen vóór bestelling bevestigen.')),
  item('1 Stk.', 'Magnetfilter', 'Anschlussgröße gemäß Installationsplanung bestätigen.', false, tr('1 pc.', 'Magnetic filter', 'Confirm connection size against the installation plan.', '1 st.', 'Magneetfilter', 'Aansluitmaat volgens de installatieplanning bevestigen.')),
  item('ca. 1 m', 'Warmwasserrohr Pomp T', 'Kupfer 22 mm / 3/4 Zoll.', false, tr('approx. 1 m', 'Pomp T hot-water pipe', 'Copper 22 mm / 3/4 inch.', 'ca. 1 m', 'Warmwaterleiding Pomp T', 'Koper 22 mm / 3/4 inch.')),
  item('ca. 1 m', 'Heizungs-/Quellrohr Pomp T', 'Stahl 22 mm / 3/4 Zoll.', false, tr('approx. 1 m', 'Pomp T heating/source pipe', 'Steel 22 mm / 3/4 inch.', 'ca. 1 m', 'Verwarmings-/bronleiding Pomp T', 'Staal 22 mm / 3/4 inch.')),
  item('1 Satz', 'Anschlussmaterial Warmwasser-Zirkulation', 'Benötigte Verbinder und Absperrungen vor Ort festlegen.', false, tr('1 set', 'DHW circulation connection materials', 'Determine the required connectors and shut-off valves on site.', '1 set', 'Aansluitmateriaal warmtapwatercirculatie', 'Benodigde koppelingen en afsluiters ter plaatse bepalen.')),
  item('1 Satz', 'Elektroanschluss Pomp MP', 'Kabellänge und Schutzorgane vor Ort prüfen.', false, tr('1 set', 'Pomp MP electrical connection', 'Check cable length and protective devices on site.', '1 set', 'Elektrische aansluiting Pomp MP', 'Kabellengte en beveiligingen ter plaatse controleren.')),
]);

export const DEWARMTE_LANGUAGES = Object.freeze(['de', 'en', 'nl']);

export const DEWARMTE_MATERIAL_STANDARD = Object.freeze({
  specVersion: 3,
  languages: DEWARMTE_LANGUAGES,
  cover: Object.freeze({ source: 'installation-planning', sourcePage: 1, resultPage: 1, preserveUnchanged: true, title: 'Deckblatt aus der Installationsplanung' }),
  sections: Object.freeze([
    Object.freeze({ id: 'dewarmte', title: 'DeWarmte Material', orderPageTitle: 'Materialbestellung DeWarmte', items: dewarmteItems, standardListPending: true }),
    Object.freeze({ id: 'heat-hero', title: 'HEAT|Hero Material', orderPageTitle: 'Materialbestellung HEAT|Hero', items: heatHeroItems, standardListPending: false }),
  ]),
  orderAppendix: Object.freeze({ enabled: true, sectionOrder: Object.freeze(['heat-hero', 'dewarmte']), separatePagePerSection: true, repeatProjectData: true, detachable: true }),
  unclassifiedHeading: 'Vor finaler Bestellung klären',
  classificationSource: 'Nadines markierte Materialliste vom 30.08.2026',
});

export function localizedMaterialEntry(entry, language = 'de') {
  if (!DEWARMTE_LANGUAGES.includes(language)) throw new Error(`Nicht unterstützte Sprache: ${language}`);
  return language === 'de' ? { quantity: entry.quantity, material: entry.material, note: entry.note, needsClarification: entry.needsClarification }
    : { ...(entry.translations?.[language] || {}), needsClarification: entry.needsClarification };
}

export function dewarmteMaterialStandardSummary() {
  return {
    specVersion: DEWARMTE_MATERIAL_STANDARD.specVersion,
    languages: [...DEWARMTE_LANGUAGES],
    cover: { ...DEWARMTE_MATERIAL_STANDARD.cover },
    sections: DEWARMTE_MATERIAL_STANDARD.sections.map(section => ({
      id: section.id, title: section.title, orderPageTitle: section.orderPageTitle,
      items: section.items.map(entry => ({ ...entry, translations: { ...entry.translations } })), standardListPending: section.standardListPending,
    })),
    orderAppendix: { ...DEWARMTE_MATERIAL_STANDARD.orderAppendix, sectionOrder: [...DEWARMTE_MATERIAL_STANDARD.orderAppendix.sectionOrder] },
    unclassifiedHeading: DEWARMTE_MATERIAL_STANDARD.unclassifiedHeading,
    classificationSource: DEWARMTE_MATERIAL_STANDARD.classificationSource,
  };
}
