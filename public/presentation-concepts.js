export const PRESENTATION_CONCEPTS = [
  {
    id: 'iva-premium',
    label: 'IVA Premium Value Story',
    publicLabel: 'Ganzheitliches Entscheidungskonzept',
    ready: true,
    description: 'Kompakte, belegte Value Story mit Ausgangslage, Nutzen, USPs, Zahlen, Einwandvorwegnahme und nächstem Schritt.',
  },
  {
    id: 'goto',
    label: 'GO-TO-Konzept',
    publicLabel: 'Ganzheitliches Beratungskonzept',
    ready: false,
    description: 'Die Präsentationsstruktur ist vorbereitet. Eigene GO-TO-Methodik, Formulierungen und Gestaltungsregeln werden erst nach Prüfung der Originalunterlagen aktiviert.',
  },
  {
    id: 'custom',
    label: 'Eigenes Konzept',
    publicLabel: 'Individuelles Beratungskonzept',
    ready: true,
    description: 'Eigener Konzeptname, Nutzenversprechen, USPs, Tonalität, Design und Handlungsaufforderung werden in der Fallakte gespeichert.',
  },
];

export const PRESENTATION_DESIGNS = {
  'executive-blue': { label: 'Executive Blue', accent: '#176b9b', accent2: '#28b6a8', dark: '#0d2036', soft: '#eaf4f8' },
  'iva-night': { label: 'IVA Night Premium', accent: '#247fba', accent2: '#18a999', dark: '#0e1b30', soft: '#edf5fb' },
  'warm-premium': { label: 'Warm Premium', accent: '#9b592f', accent2: '#d19b47', dark: '#2b201c', soft: '#faf3e9' },
};

export const PRESENTATION_EVIDENCE = [
  {
    id: 'retirement-level-2025', modules: ['financial-holistic', 'din-77230', 'retirement-planning'], value: '48 %',
    label: 'aktuelles Sicherungsniveau vor Steuern der gesetzlichen Rente', publisher: 'BMAS', year: '2025',
    title: 'Rentenversicherungsbericht 2025', url: 'https://www.bmas.de/DE/Service/Presse/Pressemitteilungen/2025/bundeskabinett-beschliesst-rentenversicherungsbericht-2025.html',
    scope: 'Das Sicherungsniveau ist keine individuelle Ersatzquote. Die persönliche Versorgungslücke muss separat berechnet werden.',
  },
  {
    id: 'household-wealth-real-2023', modules: ['financial-holistic', 'din-77230', 'depot-comparison'], value: '239.200 €',
    label: 'durchschnittliches reales Nettovermögen je Haushalt 2023', publisher: 'Deutsche Bundesbank', year: '2025',
    title: 'Private Haushalte und ihre Finanzen 2023', url: 'https://www.bundesbank.de/de/aufgaben/themen/bundesbank-studie-vermoegen-in-deutschland-steigen-nominal-gehen-aber-real-zurueck-ungleichheit-bleibt-unveraendert-954622',
    scope: 'Durchschnittswert; die Bundesbank weist zugleich auf den realen Rückgang gegenüber 2021 und große Unterschiede zwischen Haushalten hin.',
  },
  {
    id: 'household-financial-assets-2025', modules: ['depot-comparison'], value: '9.389 Mrd. €',
    label: 'Geldvermögen privater Haushalte im dritten Quartal 2025', publisher: 'Deutsche Bundesbank', year: '2026',
    title: 'Geldvermögensbildung Q3 2025', url: 'https://www.bundesbank.de/de/presse/pressenotizen/geldvermoegensbildung-und-aussenfinanzierung-in-deutschland-im-dritten-quartal-2025-936614',
    scope: 'Gesamtbestand; keine Aussage über passende Produkte oder zukünftige Renditen.',
  },
  {
    id: 'mortgage-rate-2026', modules: ['property-calculator'], value: '3,35 %',
    label: 'gewichteter Finanzierungskostensatz für Wohnungsbaukredite im Januar 2026', publisher: 'Deutsche Bundesbank', year: '2026',
    title: 'MFI-Zinsstatistik Januar 2026', url: 'https://www.bundesbank.de/resource/blob/990996/3d7cda244c87fa080bc3febf694752c0/472B63F073F071307366337C94F8C870/2026-03-04-mfi-zinsstatistik-download.pdf',
    scope: 'Marktindikator, kein persönliches Finanzierungsangebot. Beleihung, Bonität, Zinsbindung und Bankkonditionen verändern den Kundenzins.',
  },
  {
    id: 'gkv-additional-rate-2026', modules: ['gkv-comparison'], value: '2,9 %',
    label: 'durchschnittlicher GKV-Zusatzbeitragssatz 2026', publisher: 'Bundesgesundheitsministerium', year: '2026',
    title: 'Beiträge der gesetzlichen Krankenversicherung', url: 'https://www.bundesgesundheitsministerium.de/beitraege/seite',
    scope: 'Kassenindividuelle Zusatzbeiträge weichen ab; Leistung, Satzung und Service müssen zusätzlich verglichen werden.',
  },
  {
    id: 'energy-price-2025', modules: ['energy-tariff-comparison'], value: '40,1 ct/kWh',
    label: 'durchschnittlicher Strompreis für Haushalte im Frühjahr 2025', publisher: 'Bundesnetzagentur / Bundeskartellamt', year: '2025',
    title: 'Monitoringbericht Energie 2025', url: 'https://www.bundesnetzagentur.de/SharedDocs/Pressemitteilungen/DE/2025/20251126_Monitoringbericht.html',
    scope: 'Marktdurchschnitt; ein konkreter Tarifvergleich benötigt Adresse, Verbrauch, Preisgarantie und aktuelle Anbieterangebote.',
  },
  {
    id: 'energy-switches-2024', modules: ['energy-tariff-comparison'], value: '7,1 Mio.',
    label: 'Strom-Lieferantenwechsel im Jahr 2024', publisher: 'Bundesnetzagentur / Bundeskartellamt', year: '2025',
    title: 'Monitoringbericht Energie 2025', url: 'https://www.bundesnetzagentur.de/SharedDocs/Pressemitteilungen/DE/2025/20251126_Monitoringbericht.html',
    scope: 'Marktaktivität, keine individuelle Ersparniszusage.',
  },
  {
    id: 'heating-support-2026', modules: ['energy-planning'], value: 'bis 80 %',
    label: 'möglicher Gesamtfördersatz der KfW-Heizungsförderung unter aktuellen Voraussetzungen', publisher: 'KfW', year: 'Regelstand 21.07.2026',
    title: 'Heizungsförderung für Privatpersonen - Wohngebäude 458', url: 'https://www.kfw.de/inlandsfoerderung/Privatpersonen/Bestehende-Immobilie/F%C3%B6rderprodukte/Heizungsf%C3%B6rderung-f%C3%BCr-Privatpersonen-Wohngeb%C3%A4ude-%28458%29/',
    scope: 'Nur bei erfüllten Voraussetzungen und innerhalb der jeweiligen Kosten- und Bonusgrenzen; keine Förderzusage.',
  },
];

const MODULE_COPY = {
  'financial-holistic': {
    headline: 'Finanzen ordnen. Prioritäten klären. Entscheidungen sicher treffen.',
    usps: ['Alle relevanten Finanzbereiche in einem Gesamtbild', 'Klare Prioritäten statt einzelner Produktentscheidungen', 'Liquidität, Risiko und Ziele gemeinsam betrachtet', 'Nachvollziehbarer Maßnahmenplan mit nächsten Schritten'],
    objections: [['„Das ist zu viel auf einmal.“', 'Die Analyse priorisiert: zuerst existenzielle Risiken und Liquidität, danach Vermögensaufbau und Komfortziele.'], ['„Ich möchte flexibel bleiben.“', 'Jede Empfehlung wird auf Verfügbarkeit, Änderbarkeit und Zeithorizont geprüft.']],
  },
  'retirement-planning': {
    headline: 'Aus einer abstrakten Rentenlücke wird ein konkreter Vorsorgeplan.',
    usps: ['Versorgungslücke in heutiger Kaufkraft sichtbar', 'Sparrate und Kapitalbedarf nachvollziehbar gerechnet', 'Bestehende Ansprüche und Verträge einbezogen', 'Szenarien können bei Lebensänderungen angepasst werden'],
    objections: [['„Dafür ist später noch Zeit.“', 'Ein längerer Anlagehorizont verteilt den Kapitalbedarf meist auf mehr Sparjahre und schafft mehr Handlungsoptionen.'], ['„Die Zukunft ist zu unsicher.“', 'Gerade deshalb werden Annahmen offengelegt und mehrere Szenarien statt einer Scheingenauigkeit gezeigt.']],
  },
  'depot-comparison': {
    headline: 'Kosten, Risiko, Flexibilität und Renditechance transparent vergleichen.',
    usps: ['Einheitliche Vergleichsbasis statt Produktwerbung', 'Kosten und Garantien sichtbar gegenübergestellt', 'Risikostreuung und Verfügbarkeit berücksichtigt', 'Quellen- und tarifstandbezogene Dokumentation'],
    objections: [['„Das günstigste Depot reicht.“', 'Preis ist ein Faktor. Entscheidend sind zusätzlich Strategie, Risiko, Steuerhülle, Verfügbarkeit und Betreuung.'], ['„Rendite kann niemand garantieren.“', 'Richtig. Deshalb trennt die Beratung belegte Kosten von Annahmen und vermeidet Renditeversprechen.']],
  },
  'property-calculator': {
    headline: 'Eine Finanzierung, die auch bei veränderten Rahmenbedingungen tragfähig bleibt.',
    usps: ['Rate, Tilgung und Restschuld gemeinsam betrachtet', 'Zins- und Belastungsszenarien sichtbar', 'Liquiditätsreserve bleibt Teil der Planung', 'Förderung und Nebenkosten werden nicht ausgeblendet'],
    objections: [['„Die Rate passt doch.“', 'Eine tragfähige Finanzierung betrachtet zusätzlich Restschuld, Reserven, Zinsbindung und mögliche Einkommensänderungen.'], ['„Wir nehmen einfach das niedrigste Angebot.“', 'Effektivzins, Sondertilgung, Bereitstellung, Flexibilität und Anschlussrisiko gehören in denselben Vergleich.']],
  },
  'gkv-comparison': {
    headline: 'Nicht nur Beiträge vergleichen - Leistung, Service und persönliche Passung entscheiden.',
    usps: ['Beitrag und Zusatzbeitrag transparent', 'Satzungsleistungen und Bonusprogramme einbezogen', 'Service und digitale Erreichbarkeit bewertet', 'Wechselentscheidung nachvollziehbar dokumentiert'],
    objections: [['„Die Leistungen sind doch überall gleich.“', 'Der gesetzliche Kern ist ähnlich, Zusatzleistungen, Satzung, Bonusprogramme und Service unterscheiden sich.'], ['„Ein Wechsel ist mir zu aufwendig.“', 'IVA strukturiert die Entscheidung und dokumentiert die erforderlichen nächsten Schritte.']],
  },
  'corporate-benefits': {
    headline: 'Gesundheit und Vorsorge als messbares Arbeitgeberkonzept - nicht als isolierter Benefit.',
    usps: ['Mitarbeiternutzen und Arbeitgeberkosten in einer Rechnung', 'Recruiting, Bindung und Versorgung gemeinsam gedacht', 'bKV sofort erlebbar, bAV langfristig wirksam', 'Kommunikation, Einführung und Nachhalten als Gesamtprozess'],
    objections: [['„Das ist zu teuer.“', 'Der Rechner stellt Beitrag, Break-even und frei gewählte Wirkungsszenarien transparent gegenüber - ohne Einspargarantie.'], ['„Unsere Mitarbeitenden nutzen das vielleicht nicht.“', 'Budget, Leistungen und Kommunikation werden an Belegschaft und Teilnahmeziel ausgerichtet; Nutzung wird nach Einführung gemessen.']],
  },
  'energy-tariff-comparison': {
    headline: 'Energiepreise transparent vergleichen - passend zu Adresse, Verbrauch und Vertragsrisiko.',
    usps: ['Grund- und Arbeitspreis gemeinsam bewertet', 'Preisgarantie und Laufzeit sichtbar', 'Bonusabhängigkeit transparent', 'Kundendaten und Verbrauch aus einer Fallakte'],
    objections: [['„Der Wechsel lohnt den Aufwand nicht.“', 'Die Entscheidung basiert auf einer konkreten Jahreskostenrechnung und nicht auf einem Lockpreis.'], ['„Was ist mit versteckten Bedingungen?“', 'Laufzeit, Preisgarantie, Bonus und Kündigungsregeln werden separat ausgewiesen.']],
  },
  'energy-planning': {
    headline: 'Technik, Wirtschaftlichkeit und Förderung in einer verständlichen Entscheidungsvorlage.',
    usps: ['Gebäude- und Verbrauchsdaten gemeinsam betrachtet', 'Heizlast und Anlagengröße nachvollziehbar vorgeplant', 'Fördervoraussetzungen separat geprüft', 'Varianten und offene Daten transparent dokumentiert'],
    objections: [['„Eine Wärmepumpe funktioniert bei uns nicht.“', 'Die Vorplanung prüft Heizlast, Heizflächen, Vorlauftemperatur und Gebäudeparameter statt pauschal zu urteilen.'], ['„Die Förderung ist zu unsicher.“', 'Voraussetzungen, offene Punkte und Regelstand werden sichtbar gemacht; eine Förderzusage wird nicht behauptet.']],
  },
};

const FALLBACK_COPY = {
  headline: 'Komplexe Ausgangslage. Klare Entscheidung. Nachvollziehbarer nächster Schritt.',
  usps: ['Persönliche Ausgangslage statt Standardempfehlung', 'Annahmen und Ergebnisse transparent', 'Alternativen nachvollziehbar verglichen', 'Empfehlung und nächste Schritte dokumentiert'],
  objections: [['„Ich möchte noch darüber nachdenken.“', 'Die Unterlage hält Nutzen, offene Fragen und Entscheidungskriterien kompakt fest.'], ['„Woher kommen die Aussagen?“', 'Zahlen und Leistungsbehauptungen werden mit Quellen, Tarifstand oder sichtbarer Annahme gekennzeichnet.']],
};

function clean(value, max = 2000) {
  return String(value ?? '').trim().slice(0, max);
}

export function normalizePresentationProfile(input = {}) {
  const conceptId = PRESENTATION_CONCEPTS.some(item => item.id === input.conceptId) ? input.conceptId : 'iva-premium';
  const designId = PRESENTATION_DESIGNS[input.designId] ? input.designId : 'executive-blue';
  const maxPages = [4, 6, 8, 10, 14].includes(Number(input.maxPages)) ? Number(input.maxPages) : 6;
  return {
    conceptId,
    conceptName: clean(input.conceptName, 120),
    bundleMode: ['compact', 'master'].includes(input.bundleMode) ? input.bundleMode : 'master',
    audience: ['private', 'management', 'hr', 'employees'].includes(input.audience) ? input.audience : 'private',
    tone: ['premium', 'management', 'emotional'].includes(input.tone) ? input.tone : 'premium',
    designId,
    maxPages,
    headline: clean(input.headline, 240),
    promise: clean(input.promise, 800),
    uspNotes: clean(input.uspNotes, 1200),
    cta: clean(input.cta, 600),
    welcomeSalutation: clean(input.welcomeSalutation, 160),
    welcomeTitle: clean(input.welcomeTitle, 220),
    welcomeText: clean(input.welcomeText, 1800),
    closingTitle: clean(input.closingTitle, 220),
    closingText: clean(input.closingText, 1400),
    signature: clean(input.signature, 320),
  };
}

export function presentationConcept(id) {
  return PRESENTATION_CONCEPTS.find(item => item.id === id) || PRESENTATION_CONCEPTS[0];
}

export function presentationDesign(id) {
  return PRESENTATION_DESIGNS[id] || PRESENTATION_DESIGNS['executive-blue'];
}

export function presentationCopy(moduleId, profile = {}) {
  const copy = MODULE_COPY[moduleId] || FALLBACK_COPY;
  const customUsps = clean(profile.uspNotes).split(/\n+/).map(item => item.replace(/^[-*•]\s*/, '').trim()).filter(Boolean).slice(0, 6);
  return {
    headline: clean(profile.headline, 240) || copy.headline,
    usps: customUsps.length ? customUsps : [...copy.usps],
    objections: copy.objections.map(item => [...item]),
  };
}

export function presentationEvidence(moduleIds = [], limit = 6) {
  const wanted = new Set(moduleIds);
  return PRESENTATION_EVIDENCE.filter(item => item.modules.some(id => wanted.has(id))).slice(0, Math.max(0, Math.min(Number(limit) || 6, 10))).map(item => ({ ...item, modules: [...item.modules] }));
}
