const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const boundedInteger = (value, min, max, fallback = 0) => Math.min(max, Math.max(min, Math.round(finite(value, fallback))));

export const PV_PRICE_VERSION = 'sol-living-sigenergy-2026-08-07';
export const PV_MODULE = Object.freeze({
  manufacturer: 'AIKO',
  powerW: 485,
  widthM: 1.134,
  heightM: 1.757,
  sourceUrl: 'https://aikosolar.com/wp-content/uploads/2024/06/Neostar-2N_188-AIKO-A-MAH54Mw_450-485W_1757x1134x30mm_wbwf_DS_EN_2405_V1.5.pdf',
});

export const HEAT_PUMP_CONVERSION_TYPES = Object.freeze({
  'oil-liters': Object.freeze({ label: 'Heizöl', unit: 'Liter/Jahr', energyFactorKwh: 10 }),
  'gas-kwh': Object.freeze({ label: 'Erdgas', unit: 'kWh/Jahr', energyFactorKwh: 1 }),
  'gas-m3': Object.freeze({ label: 'Erdgas', unit: 'm³/Jahr', energyFactorKwh: 10 }),
});

export function calculateHeatPumpElectricity(input = {}) {
  const source = String(input.source || 'oil-liters');
  const sourceConfig = HEAT_PUMP_CONVERSION_TYPES[source];
  if (!sourceConfig) throw new Error('Unbekannter Energieträger für die Wärmepumpen-Umrechnung.');

  const annualConsumption = Math.max(0, finite(input.annualConsumption));
  const seasonalPerformanceFactor = finite(input.seasonalPerformanceFactor, 4);
  if (seasonalPerformanceFactor < 1.5 || seasonalPerformanceFactor > 8) {
    throw new Error('Die Jahresarbeitszahl muss zwischen 1,5 und 8 liegen.');
  }
  const boilerEfficiencyPercent = finite(input.boilerEfficiencyPercent, 100);
  if (boilerEfficiencyPercent < 50 || boilerEfficiencyPercent > 100) {
    throw new Error('Der Bestandswirkungsgrad muss zwischen 50 und 100 Prozent liegen.');
  }

  const fossilEnergyKwh = annualConsumption * sourceConfig.energyFactorKwh;
  const usefulHeatKwh = fossilEnergyKwh * boilerEfficiencyPercent / 100;
  const heatPumpElectricityKwh = usefulHeatKwh / seasonalPerformanceFactor;
  const roundedElectricityKwh = Math.round(heatPumpElectricityKwh);

  return {
    status: 'planning-estimate',
    input: {
      source,
      annualConsumption,
      seasonalPerformanceFactor,
      boilerEfficiencyPercent,
    },
    source: { ...sourceConfig },
    result: {
      fossilEnergyKwh: Math.round(fossilEnergyKwh),
      usefulHeatKwh: Math.round(usefulHeatKwh),
      heatPumpElectricityKwh: roundedElectricityKwh,
    },
    formula: source === 'gas-kwh'
      ? `${annualConsumption.toLocaleString('de-DE')} kWh × ${boilerEfficiencyPercent} % ÷ JAZ ${seasonalPerformanceFactor} = ${roundedElectricityKwh.toLocaleString('de-DE')} kWh Strom/Jahr`
      : `${annualConsumption.toLocaleString('de-DE')} ${sourceConfig.unit.split('/')[0]} × ${sourceConfig.energyFactorKwh} kWh × ${boilerEfficiencyPercent} % ÷ JAZ ${seasonalPerformanceFactor} = ${roundedElectricityKwh.toLocaleString('de-DE')} kWh Strom/Jahr`,
    assumptions: [
      'Faustformel für die frühe Beratung; keine Heizlast- oder Verbrauchsgarantie.',
      'Heizöl und Gas in m³ werden für den Schnellcheck gerundet mit 10 kWh je Einheit angesetzt.',
      '100 % Bestandswirkungsgrad bildet die einfache Faustformel ohne Kesselverlustkorrektur ab.',
    ],
    sources: [
      {
        title: 'Bundesverband Wärmepumpe: Endenergiebedarf durch Jahresarbeitszahl teilen',
        url: 'https://www.waermepumpe.de/verbraucher/darum-waermepumpe/fragen-sie-die-experten/antwort-der-experten/wie-kann-ich-die-stromkosten-fuer-meine-waermepumpe-errechnen/',
      },
      {
        title: 'Umweltbundesamt: Bedeutung und Praxiswerte der Jahresarbeitszahl',
        url: 'https://www.umweltbundesamt.de/themen/klima-energie/erneuerbare-energien/umgebungswaerme-waermepumpen',
      },
    ],
  };
}

const BASE_PRICE = 1282;
const BASIC_EQUIPMENT_PRICE = 641.64;

const INVERTERS_TP = [
  { id: 'tp-5', label: 'EC 5.0 TP', nominalKw: 5, maxInputKwp: 8, price: 1933.94 },
  { id: 'tp-6', label: 'EC 6.0 TP', nominalKw: 6, maxInputKwp: 9.6, price: 2289.78 },
  { id: 'tp-8', label: 'EC 8.0 TP', nominalKw: 8, maxInputKwp: 12.8, price: 2382.61 },
  { id: 'tp-10', label: 'EC 10.0 TP', nominalKw: 10, maxInputKwp: 16, price: 2457.97 },
  { id: 'tp-12', label: 'EC 12.0 TP', nominalKw: 12, maxInputKwp: 19.2, price: 2924.11 },
  { id: 'tp-15', label: 'EC 15.0 TP', nominalKw: 15, maxInputKwp: 24, price: 3264.49 },
  { id: 'tp-17', label: 'EC 17.0 TP', nominalKw: 17, maxInputKwp: 27.2, price: 3448.14 },
  { id: 'tp-20', label: 'EC 20.0 TP', nominalKw: 20, maxInputKwp: 32, price: 3651.27 },
  { id: 'tp-25', label: 'EC 25.0 TP', nominalKw: 25, maxInputKwp: 40, price: 4254.66 },
  { id: 'tp-30', label: 'EC 30.0 TP', nominalKw: 30, maxInputKwp: 48, price: 4765.22 },
];

const INVERTERS_TP2 = [
  { id: 'tp2-3', label: 'EC 3.0 TP + Battery Controller', nominalKw: 3, price: 1188.28 },
  { id: 'tp2-4', label: 'EC 4.0 TP + Battery Controller', nominalKw: 4, price: 1204.22 },
  { id: 'tp2-5', label: 'EC 5.0 TP + Battery Controller', nominalKw: 5, price: 1220.18 },
  { id: 'tp2-6', label: 'EC 6.0 TP + Battery Controller', nominalKw: 6, price: 1331.82 },
  { id: 'tp2-8', label: 'EC 8.0 TP + Battery Controller', nominalKw: 8, price: 1402.01 },
  { id: 'tp2-10', label: 'EC 10.0 TP + Battery Controller', nominalKw: 10, price: 1475.38 },
  { id: 'tp2-12', label: 'EC 12.0 TP + Battery Controller', nominalKw: 12, price: 1523.22 },
];

const WARRANTIES = [
  { id: 'bat-6', label: '5 Jahre Verlängerung · SigenStor BAT 6.0', price: 290.52 },
  { id: 'bat-9', label: '5 Jahre Verlängerung · SigenStor BAT 10.0 (9 kWh)', price: 370.9 },
  { id: 'ec-5-8', label: '5 Jahre Verlängerung · Energy Controller 5–8 kW', price: 241.15 },
  { id: 'ec-10-15', label: '5 Jahre Verlängerung · Energy Controller 10–15 kW', price: 322.95 },
  { id: 'ec-17-30', label: '5 Jahre Verlängerung · Energy Controller 17–30 kW', price: 485.13 },
  { id: 'hybrid-tp2', label: '5 Jahre Verlängerung · Sigen Hybrid TP2 3–12 kW', price: 273.59 },
  { id: 'gateway', label: '5 Jahre Verlängerung · Gateway HomePro TP', price: 193.21 },
];

const ADD_ONS = [
  { id: 'gateway-homepro', label: 'Sigen Energy Gateway HomePro TP dreiphasig', price: 1624.51 },
  { id: 'ev-ac-11-socket', label: 'Sigen EV AC Charger 11 kW · Ladedose Typ 2', price: 1033.78 },
  { id: 'ev-ac-11-cable', label: 'Sigen EV AC Charger 11 kW · 5 m Kabel Typ 2', price: 1139.27 },
  { id: 'ev-ac-22-socket', label: 'Sigen EV AC Charger 22 kW · Ladedose Typ 2', price: 1139.27 },
  { id: 'ev-ac-22-cable', label: 'Sigen EV AC Charger 22 kW · 5 m Kabel Typ 2', price: 1244.75 },
  { id: 'ev-dc-12-5m', label: 'SigenStor EV DC Charging Module 12,5 kW · 5 m', price: 4182.58 },
  { id: 'ev-dc-12-7-5m', label: 'SigenStor EV DC Charging Module 12,5 kW · 7,5 m', price: 4316.2 },
  { id: 'ev-dc-12-10m', label: 'SigenStor EV DC Charging Module 12,5 kW · 10 m', price: 4430.48 },
  { id: 'ev-dc-25-5m', label: 'SigenStor EV DC Charging Module 25 kW · 5 m', price: 5397.44 },
  { id: 'ev-dc-25-7-5m', label: 'SigenStor EV DC Charging Module 25 kW · 7,5 m', price: 5564.47 },
  { id: 'ev-dc-25-10m', label: 'SigenStor EV DC Charging Module 25 kW · 10 m', price: 5643.58 },
  { id: 'meter-merge', label: 'Zählerzusammenlegung', price: 290 },
  { id: 'grounding', label: 'Tiefenerder setzen und gemäß DIN 18014 einbinden', price: 507.5 },
  { id: 'bke-az', label: 'BKE-AZ Adapterplatte', price: 217.5 },
  { id: 'wlan', label: 'WLAN-Repeater / DLAN', price: 217.5 },
  { id: 'second-visit', label: 'Zweite Anfahrt / Netzbetreibertermin', price: 507.5 },
  { id: 'wallbox-install', label: 'Wallbox-Installation inklusive bis zu 10 m Kabel', price: 580 },
  { id: 'cabinet-bypass', label: 'Zählerschrankerweiterung (Bypass)', price: 1276 },
  { id: 'cabinet-replacement', label: 'Zählerschrankaustausch', price: 2900 },
  { id: 'long-cabling', label: 'String- und Systemverkabelung ab 20 m', price: 200 },
  { id: 'satellite', label: 'Satellitenschüssel abbauen / versetzen', price: 500 },
  { id: 'solar-thermal-removal', label: 'Solarthermie abbauen', price: 750 },
];

const QUANTITY_ITEMS = [
  { id: 'intermediateMeters', label: 'Zwischenzähler', unitPrice: 362.5 },
  { id: 'dismantleModules', label: 'Bestandsmodule demontieren', unitPrice: 60 },
  { id: 'metalReplacementTiles', label: 'Blechersatzziegel', unitPrice: 60 },
];

const MODULE_PACKAGE_SMALL = Object.freeze({
  8: 7900.05,
  9: 8000.58,
  10: 8101.12,
  11: 8201.66,
  12: 8301.46,
});

function modulePackagePrice(moduleCount) {
  if (MODULE_PACKAGE_SMALL[moduleCount]) return MODULE_PACKAGE_SMALL[moduleCount];
  return roundMoney(8686.94 + (moduleCount - 13) * 385.476);
}

function publicItems(items) {
  return items.map(item => ({ ...item }));
}

export function pvPriceCatalog() {
  return {
    version: PV_PRICE_VERSION,
    validFrom: '2026-08-07',
    module: { ...PV_MODULE, areaM2: roundMoney(PV_MODULE.widthM * PV_MODULE.heightM) },
    range: { minimumModules: 8, maximumModules: 70 },
    defaults: {
      householdConsumptionKwh: 4000,
      heatPumpConsumptionKwh: 0,
      evConsumptionKwh: 0,
      targetCoveragePercent: 100,
      specificYieldKwhPerKwp: 950,
      layoutFactorPercent: 85,
      basicEquipment: true,
      storage6Qty: 0,
      storage9Qty: 1,
      inverterFamily: 'tp',
    },
    basePrice: BASE_PRICE,
    basicEquipmentPrice: BASIC_EQUIPMENT_PRICE,
    storage: [
      { id: 'storage-6', label: 'SigenStor 6 kWh Speicherblock', capacityKwh: 6, price: 3032.41 },
      { id: 'storage-9', label: 'SigenStor 9 kWh Speicherblock', capacityKwh: 9, price: 3898.82 },
    ],
    inverters: { tp: publicItems(INVERTERS_TP), tp2: publicItems(INVERTERS_TP2) },
    warranties: publicItems(WARRANTIES),
    addOns: publicItems(ADD_ONS),
    quantities: publicItems(QUANTITY_ITEMS),
    notices: [
      'Unverbindliche Preisindikation auf Basis des Sol-Living B2C-Preisrechners mit Versionsstand 07.08.2026.',
      'Eine mögliche Cloover-Transaktionsgebühr ist nicht enthalten.',
      'Für die Dachschätzung ist das AIKO Neostar 2N mit 485 W und 1,757 × 1,134 m als Arbeitsannahme hinterlegt; das tatsächlich angebotene Modulmodell ist vor dem Angebot abzugleichen.',
      'Dachbelegung, Statik, Verschattung, Netzanschluss und elektrische Eignung müssen vor einem Angebot fachlich geprüft werden.',
    ],
  };
}

function selectInverter(family, requestedId, systemKwp) {
  const list = family === 'tp2' ? INVERTERS_TP2 : INVERTERS_TP;
  if (requestedId) {
    const selected = list.find(item => item.id === requestedId);
    if (!selected) throw new Error('Der gewählte Wechselrichter gehört nicht zur ausgewählten Baureihe.');
    return selected;
  }
  if (family === 'tp2') return list.find(item => item.nominalKw >= systemKwp) || list.at(-1);
  return list.find(item => item.maxInputKwp >= systemKwp) || list.at(-1);
}

function normalizedAddOns(value) {
  const requested = [...new Set(Array.isArray(value) ? value.map(String) : [])];
  const unknown = requested.filter(id => !ADD_ONS.some(item => item.id === id));
  if (unknown.length) throw new Error('Unbekannte Zusatzposition: ' + unknown.join(', '));
  return requested;
}

export function calculatePvPrice(input = {}) {
  const moduleAreaM2 = PV_MODULE.widthM * PV_MODULE.heightM;
  const householdConsumptionKwh = Math.max(0, finite(input.householdConsumptionKwh, 4000));
  const heatPumpConsumptionKwh = Math.max(0, finite(input.heatPumpConsumptionKwh));
  const evConsumptionKwh = Math.max(0, finite(input.evConsumptionKwh));
  const totalConsumptionKwh = roundMoney(householdConsumptionKwh + heatPumpConsumptionKwh + evConsumptionKwh);
  const targetCoveragePercent = Math.min(160, Math.max(20, finite(input.targetCoveragePercent, 100)));
  const specificYieldKwhPerKwp = Math.min(1300, Math.max(650, finite(input.specificYieldKwhPerKwp, 950)));
  const demandKwp = totalConsumptionKwh * targetCoveragePercent / 100 / specificYieldKwhPerKwp;
  const demandModules = Math.max(1, Math.ceil(demandKwp / (PV_MODULE.powerW / 1000)));
  const usableRoofAreaM2 = Math.max(0, finite(input.usableRoofAreaM2));
  const layoutFactorPercent = Math.min(100, Math.max(40, finite(input.layoutFactorPercent, 85)));
  const roofCapacityModules = usableRoofAreaM2
    ? Math.floor(usableRoofAreaM2 * layoutFactorPercent / 100 / moduleAreaM2)
    : null;

  const automaticModules = Math.min(70, roofCapacityModules === null ? demandModules : Math.min(demandModules, roofCapacityModules));
  const moduleCount = input.moduleCount === '' || input.moduleCount === null || input.moduleCount === undefined
    ? automaticModules
    : boundedInteger(input.moduleCount, 0, 200);
  if (moduleCount < 8 || moduleCount > 70) {
    throw new Error(`Der aktuelle Sol-Living-Preisstand unterstützt 8 bis 70 Module. Ermittelt wurden ${moduleCount}.`);
  }

  const systemKwp = roundMoney(moduleCount * PV_MODULE.powerW / 1000);
  const inverterFamily = input.inverterFamily === 'tp2' ? 'tp2' : 'tp';
  const inverter = selectInverter(inverterFamily, String(input.inverterId || ''), systemKwp);
  const basicEquipment = input.basicEquipment === undefined ? true : Boolean(input.basicEquipment);
  const storage6Qty = boundedInteger(input.storage6Qty, 0, 10);
  const storage9Qty = boundedInteger(input.storage9Qty, 0, 10, input.storage6Qty === undefined && input.storage9Qty === undefined ? 1 : 0);
  const warrantyId = String(input.warrantyId || '');
  const warranty = warrantyId ? WARRANTIES.find(item => item.id === warrantyId) : null;
  if (warrantyId && !warranty) throw new Error('Unbekannte Garantieverlängerung.');
  const selectedAddOnIds = normalizedAddOns(input.addOnIds);
  const selectedAddOns = ADD_ONS.filter(item => selectedAddOnIds.includes(item.id));

  const breakdown = [
    { id: 'base', label: 'Grund-/Premiumservice laut Preisrechner', quantity: 1, unitPrice: BASE_PRICE, total: BASE_PRICE },
    { id: 'modules', label: `${moduleCount} × AIKO 485 W inklusive PV-Dach-/Modulpaket`, quantity: 1, unitPrice: modulePackagePrice(moduleCount), total: modulePackagePrice(moduleCount) },
  ];
  if (basicEquipment) breakdown.push({ id: 'basic', label: 'Sigenergy-Grundausstattung', quantity: 1, unitPrice: BASIC_EQUIPMENT_PRICE, total: BASIC_EQUIPMENT_PRICE });
  breakdown.push({ id: inverter.id, label: inverter.label, quantity: 1, unitPrice: inverter.price, total: inverter.price });
  if (storage6Qty) breakdown.push({ id: 'storage-6', label: 'SigenStor 6 kWh Speicherblock', quantity: storage6Qty, unitPrice: 3032.41, total: roundMoney(storage6Qty * 3032.41) });
  if (storage9Qty) breakdown.push({ id: 'storage-9', label: 'SigenStor 9 kWh Speicherblock', quantity: storage9Qty, unitPrice: 3898.82, total: roundMoney(storage9Qty * 3898.82) });
  if (warranty) breakdown.push({ id: warranty.id, label: warranty.label, quantity: 1, unitPrice: warranty.price, total: warranty.price });
  for (const item of selectedAddOns) breakdown.push({ id: item.id, label: item.label, quantity: 1, unitPrice: item.price, total: item.price });
  for (const item of QUANTITY_ITEMS) {
    const quantity = boundedInteger(input[item.id], 0, 200);
    if (quantity) breakdown.push({ id: item.id, label: item.label, quantity, unitPrice: item.unitPrice, total: roundMoney(quantity * item.unitPrice) });
  }

  const warnings = [];
  if (roofCapacityModules !== null && moduleCount > roofCapacityModules) warnings.push(`Die Schnellschätzung der nutzbaren Dachfläche reicht nur für etwa ${roofCapacityModules} Module.`);
  if (moduleCount < demandModules) warnings.push(`Für die gewählte Jahresenergiebilanz wären rechnerisch etwa ${demandModules} Module nötig.`);
  if (demandModules > 70) warnings.push('Der rechnerische Bedarf liegt oberhalb der aktuell hinterlegten Preisstaffel von 70 Modulen.');
  if (inverterFamily === 'tp' && inverter.maxInputKwp < systemKwp) warnings.push('Die maximal hinterlegte PV-Eingangsleistung des Wechselrichters liegt unter der Anlagenleistung.');
  if (inverterFamily === 'tp2' && systemKwp > inverter.nominalKw * 1.6) warnings.push('TP2-Dimensionierung bitte technisch prüfen; der Schnellrechner nutzt hier nur eine grobe Leistungsauswahl.');
  if (!usableRoofAreaM2) warnings.push('Keine nutzbare Dachfläche angegeben; die Modulanzahl wurde nur aus dem Jahresverbrauch abgeleitet.');

  return {
    status: warnings.length ? 'estimate-with-notes' : 'estimate',
    version: PV_PRICE_VERSION,
    calculatedAt: new Date().toISOString(),
    input: {
      householdConsumptionKwh, heatPumpConsumptionKwh, evConsumptionKwh, targetCoveragePercent,
      specificYieldKwhPerKwp, usableRoofAreaM2, layoutFactorPercent, moduleCount,
      inverterFamily, inverterId: inverter.id, basicEquipment, storage6Qty, storage9Qty,
      warrantyId, addOnIds: selectedAddOnIds,
      intermediateMeters: boundedInteger(input.intermediateMeters, 0, 200),
      dismantleModules: boundedInteger(input.dismantleModules, 0, 200),
      metalReplacementTiles: boundedInteger(input.metalReplacementTiles, 0, 200),
    },
    sizing: {
      totalConsumptionKwh,
      demandKwp: roundMoney(demandKwp),
      demandModules,
      roofCapacityModules,
      selectedModules: moduleCount,
      systemKwp,
      estimatedAnnualProductionKwh: Math.round(systemKwp * specificYieldKwhPerKwp),
      moduleAreaM2: roundMoney(moduleAreaM2),
      selectedInverter: { ...inverter, family: inverterFamily },
      storageCapacityKwh: storage6Qty * 6 + storage9Qty * 9,
    },
    price: {
      currency: 'EUR',
      total: roundMoney(breakdown.reduce((sum, item) => sum + item.total, 0)),
      breakdown,
      transactionFeeIncluded: false,
    },
    warnings,
    notices: pvPriceCatalog().notices,
  };
}
