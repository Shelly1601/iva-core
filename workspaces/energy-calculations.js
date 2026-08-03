const HEAT_LOAD_RULES_VERSION = 'iva-heat-load-preplan-1.0';
const FUNDING_RULES_VERSION = 'kfw-458-2026-07-21';

export const ENERGY_SOURCES = {
  heatLoad: [
    {
      label: 'DIN: Heizlastberechnung in Deutschland',
      url: 'https://www.din.de/de/mitwirken/normenausschuesse/nhrs/pressemitteilung-nationale-ergaenzung-zur-din-en-12831-1-und-anwendung-821826',
      note: 'Eine normgerechte Berechnung verwendet DIN EN 12831-1 zusammen mit DIN/TS 12831-1 und den nationalen Randbedingungen.',
    },
  ],
  funding: [
    {
      label: 'KfW 458 – Heizungsförderung für Privatpersonen',
      url: 'https://www.kfw.de/inlandsfoerderung/Privatpersonen/Bestehende-Immobilie/F%C3%B6rderprodukte/Heizungsf%C3%B6rderung-f%C3%BCr-Privatpersonen-Wohngeb%C3%A4ude-%28458%29/',
      asOf: '2026-07-21',
    },
    {
      label: 'KfW Produktdokumente 458',
      url: 'https://www.kfw.de/partner/KfW-Partnerportal/Service/Dokumente-zum-Produkt/458/index.jsp',
      asOf: '2026-07',
    },
  ],
};

function numberValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function missingField(missing, path, label, roomId = '') {
  missing.push({ path, label, roomId });
}

function component(room, key, label, missing) {
  const envelope = room.envelope || {};
  const area = numberValue(envelope[`${key}Area`]);
  const uValue = numberValue(envelope[`${key}UValue`]);
  const roomLabel = room.name || room.id || 'Raum';
  if (area === null || area < 0) missingField(missing, `rooms.${room.id}.envelope.${key}Area`, `${roomLabel}: ${label}-Fläche (mindestens 0)`, room.id);
  if (area !== null && area > 0 && (uValue === null || uValue <= 0)) missingField(missing, `rooms.${room.id}.envelope.${key}UValue`, `${roomLabel}: positiver U-Wert ${label}`, room.id);
  return { label, area, uValue: area === 0 ? 0 : uValue };
}

/**
 * Transparente technische Vorplanung nach H = Summe(U*A) plus Lüftungswärme.
 * Sie ist ausdrücklich keine normgerechte DIN-Heizlastberechnung.
 */
export function calculateHeatLoad(input = {}) {
  const building = input.building || {};
  const rooms = Array.isArray(input.rooms) ? input.rooms : [];
  const missing = [];
  const outdoor = numberValue(building.designOutdoorTemperature);
  const bridgePercent = numberValue(building.thermalBridgePercent);
  if (outdoor === null) missingField(missing, 'building.designOutdoorTemperature', 'Norm-Außentemperatur am Gebäudestandort');
  if (bridgePercent === null || bridgePercent < 0 || bridgePercent > 50) missingField(missing, 'building.thermalBridgePercent', 'Wärmebrücken-Zuschlag zwischen 0 und 50 Prozent');
  if (!rooms.length) missingField(missing, 'rooms', 'Mindestens ein beheizter Raum');

  const prepared = rooms.map(room => {
    const roomMissing = [];
    const area = numberValue(room.area);
    const height = numberValue(room.height || building.floorHeight);
    const indoor = numberValue(room.targetTemperature);
    const airChanges = numberValue(room.airChanges);
    const components = [
      component(room, 'externalWall', 'Außenwand', roomMissing),
      component(room, 'window', 'Fenster', roomMissing),
      component(room, 'ceiling', 'Decke/Dach', roomMissing),
      component(room, 'floor', 'Boden/Kellerdecke', roomMissing),
    ];
    const roomLabel = room.name || room.id || 'Raum';
    if (area === null || area <= 0) missingField(roomMissing, `rooms.${room.id}.area`, `${roomLabel}: positive Grundfläche`, room.id);
    if (height === null || height <= 0) missingField(roomMissing, `rooms.${room.id}.height`, `${roomLabel}: positive Raumhöhe`, room.id);
    if (indoor === null) missingField(roomMissing, `rooms.${room.id}.targetTemperature`, `${roomLabel}: Soll-Raumtemperatur`, room.id);
    if (indoor !== null && outdoor !== null && indoor <= outdoor) missingField(roomMissing, `rooms.${room.id}.targetTemperature`, `${roomLabel}: Solltemperatur muss über der Außentemperatur liegen`, room.id);
    if (airChanges === null || airChanges < 0) missingField(roomMissing, `rooms.${room.id}.airChanges`, `${roomLabel}: Luftwechselrate ab 0`, room.id);
    missing.push(...roomMissing);
    return { room, area, height, indoor, airChanges, components, complete: roomMissing.length === 0 };
  });

  if (missing.length) {
    return {
      status: 'data-required',
      rulesVersion: HEAT_LOAD_RULES_VERSION,
      missing,
      rooms: [],
      totalWatts: null,
      totalKw: null,
      dinCompliant: false,
      notice: 'Noch keine belastbare Heizlast-Vorplanung: Die markierten Eingaben fehlen. Eine normgerechte Auslegung nach DIN EN 12831-1 / DIN/TS 12831-1 ist hiervon getrennt.',
      sources: ENERGY_SOURCES.heatLoad,
    };
  }

  const roomResults = prepared.map(entry => {
    const deltaT = Math.max(0, entry.indoor - outdoor);
    const transmissionCoefficient = entry.components.reduce((sum, item) => sum + item.area * item.uValue, 0);
    const transmissionWithBridges = transmissionCoefficient * (1 + bridgePercent / 100);
    const volume = entry.area * entry.height;
    const ventilationCoefficient = 0.34 * entry.airChanges * volume;
    const watts = (transmissionWithBridges + ventilationCoefficient) * deltaT;
    return {
      roomId: entry.room.id,
      name: entry.room.name || 'Raum',
      floor: entry.room.floor || '',
      deltaT: round(deltaT, 1),
      volumeM3: round(volume, 1),
      transmissionWatts: round(transmissionWithBridges * deltaT),
      ventilationWatts: round(ventilationCoefficient * deltaT),
      totalWatts: round(watts),
      wattsPerM2: entry.area > 0 ? round(watts / entry.area, 1) : null,
      components: entry.components.map(item => ({ ...item, heatLossWatts: round(item.area * item.uValue * deltaT) })),
    };
  });
  const totalWatts = roomResults.reduce((sum, room) => sum + room.totalWatts, 0);
  return {
    status: 'preliminary',
    rulesVersion: HEAT_LOAD_RULES_VERSION,
    calculatedAt: new Date().toISOString(),
    outdoorTemperature: outdoor,
    thermalBridgePercent: bridgePercent,
    totalWatts,
    totalKw: round(totalWatts / 1000, 2),
    rooms: roomResults,
    dinCompliant: false,
    formula: 'Σ(U × A) × (1 + Wärmebrückenzuschlag) + 0,34 × Luftwechsel × Raumvolumen; multipliziert mit ΔT',
    notice: 'Technische Vorplanung aus den erfassten Bauteilen. Für die finale Wärmepumpenauslegung ist eine normgerechte Heizlast nach DIN EN 12831-1 zusammen mit DIN/TS 12831-1 erforderlich.',
    sources: ENERGY_SOURCES.heatLoad,
  };
}

export function eligibleCostCap(unitsValue) {
  const units = Math.max(1, Math.floor(numberValue(unitsValue) || 1));
  if (units <= 1) return 28_000;
  if (units <= 6) return 28_000 + (units - 1) * 15_000;
  return 28_000 + 5 * 15_000 + (units - 6) * 8_000;
}

export function incomeBonusRate(incomeValue, eligibleMinorChild = false) {
  const income = numberValue(incomeValue);
  if (income === null || income < 0) return 0;
  const shift = eligibleMinorChild ? 10_000 : 0;
  if (income <= 30_000 + shift) return 40;
  if (income <= 40_000 + shift) return 30;
  if (income <= 50_000 + shift) return 10;
  return 0;
}

export function climateSpeedBonusRate(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return 0;
  if (date < new Date('2027-02-01T00:00:00+01:00')) return 16;
  if (date < new Date('2027-08-01T00:00:00+02:00')) return 12;
  if (date < new Date('2028-02-01T00:00:00+01:00')) return 8;
  if (date < new Date('2028-08-01T00:00:00+02:00')) return 4;
  return 0;
}

export function calculateKfw458Funding(input = {}, now = new Date()) {
  const units = Math.max(1, Math.floor(numberValue(input.units) || 1));
  const projectCosts = Math.max(0, numberValue(input.projectCosts) || 0);
  const ageYears = numberValue(input.existingBuildingAgeYears);
  const privateOwner = input.applicantType === 'private-owner';
  const selfUsed = input.selfUsed === true;
  const climateBonus = selfUsed && input.climateBonusEligible === true ? climateSpeedBonusRate(now) : 0;
  const incomeBonus = selfUsed ? incomeBonusRate(input.householdIncome, input.eligibleMinorChild === true) : 0;
  const baseBonus = privateOwner ? 30 : 0;
  const uncappedRate = baseBonus + climateBonus + incomeBonus;
  const rate = Math.min(80, uncappedRate);
  const costCap = eligibleCostCap(units);
  const eligibleCosts = Math.min(projectCosts, costCap);
  const amount = round(eligibleCosts * rate / 100, 2);
  const blockers = [];
  const checks = [];
  if (!privateOwner) blockers.push('Programm 458 richtet sich hier an private Eigentümerinnen und Eigentümer von Wohngebäuden.');
  else checks.push('Private Eigentümerschaft angegeben.');
  if (ageYears === null) blockers.push('Alter des bestehenden Wohngebäudes bzw. Datum der Bauanzeige fehlt.');
  else if (ageYears < 5) blockers.push('Bauantrag/Bauanzeige des bestehenden Wohngebäudes muss zum Antragszeitpunkt mindestens fünf Jahre zurückliegen.');
  else checks.push('Mindestalter des bestehenden Gebäudes erfüllt.');
  if (projectCosts <= 0) blockers.push('Förderfähige Projektkosten fehlen.');
  if (input.contractConditional !== true) blockers.push('Der Liefer-/Leistungsvertrag muss die Förderzusage als aufschiebende oder auflösende Bedingung enthalten.');
  if (input.applicationBeforeStart !== true) blockers.push('Der Antrag muss vor Vorhabenbeginn gestellt werden.');
  if (input.hydraulicBalancingPlanned !== true) blockers.push('Hydraulischer Abgleich bzw. die geforderte Optimierung der Heizungsanlage ist noch nicht bestätigt.');
  const effectiveDate = now.toISOString().slice(0, 10);
  return {
    status: blockers.length ? 'precheck-incomplete' : 'precheck-positive',
    rulesVersion: FUNDING_RULES_VERSION,
    rulesAsOf: '2026-07-21',
    calculatedAt: new Date().toISOString(),
    effectiveDate,
    units,
    projectCosts,
    eligibleCostCap: costCap,
    eligibleCosts,
    bonuses: { base: baseBonus, climateSpeed: climateBonus, income: incomeBonus },
    uncappedRate,
    rate,
    estimatedGrant: amount,
    blockers,
    checks,
    notice: 'Unverbindlicher Förder-Vorcheck, keine Förderzusage. IVA verwendet den ausgewiesenen KfW-Regelstand; vor Antragstellung sind das aktuelle Merkblatt und die Bestätigung zum Antrag durch Fachunternehmen oder Energieeffizienz-Expertin/-Experten maßgeblich.',
    sources: ENERGY_SOURCES.funding,
  };
}
