const HEAT_LOAD_RULES_VERSION = 'iva-heat-load-preplan-1.0';
export const FUNDING_RULES_VERSION = 'kfw-458-2026-07-21';
export const FUNDING_RULES_CHECKED_AT = '2026-09-15';
const FUNDING_RULES_START = '2026-07-21';
const FUNDING_SCHEDULE_END = '2030-12-31';

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
    {
      label: 'KfW Merkblatt 458, gültig ab 21.07.2026',
      url: 'https://www.kfw.de/PDF/Download-Center/F%C3%B6rderprogramme-(Inlandsf%C3%B6rderung)/PDF-Dokumente/6000005131_M_458.pdf',
      asOf: '2026-07-21',
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

export function eligibleCostCap(unitsValue, applicationDate = FUNDING_RULES_START) {
  const units = numberValue(unitsValue), day = fundingDateKey(applicationDate);
  if (!Number.isInteger(units) || units < 1 || !day || day < FUNDING_RULES_START || day > FUNDING_SCHEDULE_END) return null;
  let reductions = 0;
  for (let year = 2027; year <= 2030; year++) for (const month of ['02', '08']) if (day >= `${year}-${month}-01`) reductions++;
  const firstUnit = 28_000 - 750 * reductions;
  if (units <= 6) return firstUnit + (units - 1) * 15_000;
  return firstUnit + 5 * 15_000 + (units - 6) * 8_000;
}

export function incomeBonusRate(incomeValue, eligibleMinorChild = false) {
  const income = numberValue(incomeValue);
  if (income === null) return 0;
  const shift = eligibleMinorChild === true ? 10_000 : 0;
  if (income <= 30_000 + shift) return 40;
  if (income <= 40_000 + shift) return 30;
  if (income <= 50_000 + shift) return 10;
  return 0;
}

export function climateSpeedBonusRate(now = new Date()) {
  const day = fundingDateKey(now);
  if (!day || day < FUNDING_RULES_START || day > FUNDING_SCHEDULE_END) return null;
  if (day < '2027-02-01') return 16;
  if (day < '2027-08-01') return 12;
  if (day < '2028-02-01') return 8;
  if (day < '2028-08-01') return 4;
  return 0;
}

function validDateValue(value) {
  const day = fundingDateKey(value);
  return day ? new Date(day + 'T12:00:00Z') : null;
}

function fundingDateKey(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value) : null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + 'T12:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function formatPercent(value) {
  return `${round(value, 2).toLocaleString('de-DE')} %`;
}

export function buildKfw458NoteSummary(result = {}) {
  if (result.calculationReady === false || !Number.isFinite(result.estimatedGrant)) return `Förderhöhe noch nicht belastbar berechenbar: ${(result.blockers || []).slice(0, 3).join(' ')}`;
  const units = Math.max(1, Math.floor(numberValue(result.units) || 1));
  const bonuses = result.bonuses || {};
  const child = result.incomeBonusRequested !== true ? 'nicht angesetzt' : result.eligibleMinorChild === true ? 'ja (+10.000 EUR Einkommensgrenze)' : 'nein';
  const income = bonuses.income > 0 ? formatPercent(bonuses.income) : result.incomeBonusRequested === false ? 'nicht beantragt' : 'nein';
  const climate = bonuses.climateSpeed > 0 ? formatPercent(bonuses.climateSpeed) : 'nein';
  const components = `Grund ${formatPercent(bonuses.base || 0)} | Einkommen ${income} | Kind u18: ${child} | Klimageschwindigkeit ${climate}`;
  if (units > 1 && result.selfUsed === true) {
    return `${round(result.estimatedGrant, 2).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} € - ${formatPercent(result.buildingBaseRate || 0)} Gesamtgebäude / ${formatPercent(result.selfUsedUnitRate || 0)} selbst genutzte WE - ${components}${result.unitRateCapped ? ` | gedeckelt auf ${formatPercent(result.maximumUnitRate)}` : ''}`;
  }
  if (units > 1) {
    return `${round(result.estimatedGrant, 2).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} € - ${formatPercent(result.buildingBaseRate || 0)} Gesamtgebäude - ${components}`;
  }
  const displayedRate = result.selfUsed === true ? result.selfUsedUnitRate : result.buildingBaseRate;
  return `${formatPercent(displayedRate || 0)} - ${components}${result.unitRateCapped ? ` | gedeckelt auf ${formatPercent(result.maximumUnitRate)}` : ''}`;
}

export function calculateKfw458Funding(input = {}, now = new Date()) {
  const blockers = [], rateIssues = [], checks = [];
  const applicationDate = validDateValue(input.applicationDate);
  const applicationDay = fundingDateKey(input.applicationDate);
  const effectiveDate = fundingDateKey(now);
  const supplementary = input.applicationKind === 'supplementary';
  const rulesDay = supplementary ? fundingDateKey(input.baseApplicationDate) : applicationDay;
  if (!applicationDay) rateIssues.push('Antragsdatum fehlt oder ist ungültig; der KfW-Regelstand kann nicht sicher zugeordnet werden.');
  if (supplementary && !rulesDay) rateIssues.push('Beim Zusatzantrag fehlt das Eingangsdatum des Basisantrags für die geltenden Fördersätze.');
  if (rulesDay && rulesDay < FUNDING_RULES_START) rateIssues.push('Für Anträge bis einschließlich 20.07.2026 muss das frühere KfW-Regelwerk separat berechnet werden.');
  if (rulesDay && rulesDay > FUNDING_SCHEDULE_END) rateIssues.push('Für diesen Antragszeitpunkt muss ein neuer KfW-Regelstand verifiziert werden.');
  if (supplementary && rulesDay && applicationDay && rulesDay > applicationDay) rateIssues.push('Der Basisantrag darf nicht nach dem Zusatzantrag eingehen.');
  if (input.rulesVersion && input.rulesVersion !== FUNDING_RULES_VERSION) rateIssues.push('Der übergebene KfW-Regelstand stimmt nicht mit dem geprüften Regelwerk überein.');
  if (!effectiveDate) rateIssues.push('Das Datum der Berechnung ist ungültig.');
  const rulesSupported = Boolean(rulesDay && rulesDay >= FUNDING_RULES_START && rulesDay <= FUNDING_SCHEDULE_END);
  const isProjection = Boolean(applicationDay && effectiveDate && applicationDay > effectiveDate);
  if (isProjection) blockers.push('Das Antragsdatum liegt in der Zukunft. Die ausgewiesene Planung beruht auf der veröffentlichten Staffel; vor dem tatsächlichen Antrag aktuelle Regeln erneut prüfen.');
  if (rulesSupported) checks.push(`Regelstand ab 21.07.2026; Fördersätze und Kostengrenze zum ${rulesDay}${supplementary ? ' (Basisantrag)' : ''}.`);
  const suppliedUnits = numberValue(input.units);
  const unitsKnown = suppliedUnits !== null && Number.isInteger(suppliedUnits) && suppliedUnits >= 1;
  const units = unitsKnown ? suppliedUnits : 1;
  const projectCosts = Math.max(0, numberValue(input.projectCosts) || 0);
  const ageYears = numberValue(input.existingBuildingAgeYears);
  const privateOwner = input.applicantType === 'private-owner';
  const selfUsedKnown = typeof input.selfUsed === 'boolean';
  const selfUsed = input.selfUsed === true;
  const incomeBonusRequested = typeof input.incomeBonusRequested === 'boolean' ? input.incomeBonusRequested : null;
  const incomeYear = applicationDate?.getUTCFullYear();
  const requiredTaxYears = incomeYear ? [incomeYear - 3, incomeYear - 2] : [];
  let verifiedIncome = null, verifiedMinorChild = false, incomeEvidenceComplete = false;
  if (selfUsed && incomeBonusRequested === null) rateIssues.push('Bitte ausdrücklich festhalten, ob der Einkommensbonus beantragt wird. Eine Einkommensangabe allein ist kein Antrag.');
  if (selfUsed && incomeBonusRequested === true) {
    const evidence = input.incomeEvidence || {}, assessments = Array.isArray(evidence.assessments) ? evidence.assessments : [];
    const annual = requiredTaxYears.map(year => assessments.filter(row => row?.year === year && row.verified === true && typeof row.sourceId === 'string' && row.sourceId.trim() && typeof row.householdTaxableIncome === 'number' && Number.isFinite(row.householdTaxableIncome)));
    incomeEvidenceComplete = evidence.householdComplete === true && annual.length === 2 && annual.every(rows => rows.length === 1);
    if (!incomeEvidenceComplete) rateIssues.push(`Für den beantragten Einkommensbonus fehlen vollständig geprüfte Einkommensteuerbescheide des relevanten Haushalts für ${requiredTaxYears.join(' und ') || 'die erforderlichen Bezugsjahre'}.`);
    else {
      verifiedIncome = annual[0][0].householdTaxableIncome / 2 + annual[1][0].householdTaxableIncome / 2;
      const suppliedIncome = numberValue(input.householdIncome);
      if (suppliedIncome !== null && Math.abs(suppliedIncome - verifiedIncome) > 0.005) rateIssues.push('Das eingetragene Haushaltseinkommen weicht vom Durchschnitt der geprüften Steuerbescheide ab.');
      checks.push(`Haushalts-zvE aus vollständig erfassten Steuerbescheiden ${requiredTaxYears.join('/')} gemittelt.`);
    }
    if (typeof input.eligibleMinorChild !== 'boolean') rateIssues.push('Es ist noch offen, ob ein kindergeldberechtigtes Kind unter 18 Jahren mit Hauptwohnsitz im Haushalt lebt.');
    if (input.eligibleMinorChild === true) {
      const child = input.childEvidence || {};
      verifiedMinorChild = child.verified === true && child.minor === true && child.childBenefitEligible === true && child.mainResidenceMatched === true && typeof child.sourceId === 'string' && Boolean(child.sourceId.trim()) && fundingDateKey(child.applicationDate) === applicationDay;
      if (!verifiedMinorChild) rateIssues.push('Für den Familienzuschlag fehlen Nachweise zu Minderjährigkeit, Kindergeldberechtigung und Hauptwohnsitz zum Antragszeitpunkt.');
    }
    if (supplementary && rulesDay && applicationDay && rulesDay.slice(0, 4) !== applicationDay.slice(0, 4)) rateIssues.push('Bei jahresübergreifendem Basis- und Zusatzantrag müssen die maßgeblichen Steuerbezugsjahre vor einer Einkommensbonus-Berechnung gesondert bestätigt werden.');
  }
  const climateBonus = selfUsed && input.climateBonusEligible === true && rulesSupported ? climateSpeedBonusRate(rulesDay) : 0;
  const incomeBonus = selfUsed && incomeBonusRequested === true && incomeEvidenceComplete ? incomeBonusRate(verifiedIncome, verifiedMinorChild) : 0;
  const baseBonus = privateOwner ? 30 : 0;
  const uncappedRate = baseBonus + climateBonus + incomeBonus;
  const maximumUnitRate = incomeBonus === 40 ? 80 : 70;
  const selfUsedUnitRate = selfUsed ? Math.min(maximumUnitRate, uncappedRate) : baseBonus;
  const unitRateCapped = selfUsed && selfUsedUnitRate < uncappedRate;
  const costCap = rulesSupported ? eligibleCostCap(units, rulesDay) : null;
  const eligibleCosts = costCap === null ? 0 : Math.min(projectCosts, costCap);
  const buildingBaseRate = baseBonus;
  const buildingBaseGrant = round(eligibleCosts * buildingBaseRate / 100, 2);
  const buildingStructure = units === 1
    ? 'single-unit'
    : ['weg', 'unpartitioned'].includes(input.buildingStructure) ? input.buildingStructure : null;
  const ownershipShareRaw = numberValue(input.ownershipSharePercent);
  const ownershipShare = ownershipShareRaw !== null && ownershipShareRaw > 0 && ownershipShareRaw <= 100 ? ownershipShareRaw / 100 : null;
  let selfUsedUnitEligibleCosts = 0;
  if (selfUsed) {
    if (units === 1) selfUsedUnitEligibleCosts = eligibleCosts;
    else if (buildingStructure === 'weg' && ownershipShare !== null) {
      selfUsedUnitEligibleCosts = Math.min(eligibleCosts * ownershipShare, costCap / units);
    } else if (buildingStructure === 'unpartitioned') {
      selfUsedUnitEligibleCosts = eligibleCosts / units;
    }
  }
  const additionalUnitRate = Math.max(0, selfUsedUnitRate - buildingBaseRate);
  const selfUsedUnitAdditionalGrant = round(selfUsedUnitEligibleCosts * additionalUnitRate / 100, 2);
  const amount = round(buildingBaseGrant + selfUsedUnitAdditionalGrant, 2);
  const effectiveBuildingRate = eligibleCosts > 0 ? round(amount / eligibleCosts * 100, 2) : 0;
  if (!privateOwner) blockers.push('Programm 458 richtet sich hier an private Eigentümerinnen und Eigentümer von Wohngebäuden.');
  else checks.push('Private Eigentümerschaft angegeben.');
  if (!unitsKnown) blockers.push('Die Anzahl der abgeschlossenen Wohneinheiten ist nicht eindeutig belegt.');
  if (!selfUsedKnown) blockers.push('Eigennutzung oder Vermietung ist nicht eindeutig belegt.');
  if (units > 1 && !buildingStructure) blockers.push('Bei mehreren Wohneinheiten fehlt die eindeutige Einordnung als WEG oder ungeteiltes Mehrfamilienhaus.');
  if (selfUsed && typeof input.climateBonusEligible !== 'boolean') blockers.push('Die Voraussetzungen des Klimageschwindigkeitsbonus sind nicht eindeutig belegt.');
  if (ageYears === null) blockers.push('Alter des bestehenden Wohngebäudes bzw. Datum der Bauanzeige fehlt.');
  else if (ageYears < 5) blockers.push('Bauantrag/Bauanzeige des bestehenden Wohngebäudes muss zum Antragszeitpunkt mindestens fünf Jahre zurückliegen.');
  else checks.push('Mindestalter des bestehenden Gebäudes erfüllt.');
  if (projectCosts < 300) blockers.push('Die förderfähigen Projektkosten müssen mindestens 300 Euro brutto betragen.');
  if (input.eligibleCostsConfirmedByBza !== true) blockers.push('Die förderfähigen Kosten sind noch nicht durch BzA/Fachunternehmen oder Energieeffizienz-Expertin/-Experten bestätigt.');
  else checks.push('Förderfähige Kosten laut BzA bestätigt.');
  if (selfUsed && units > 1 && buildingStructure === 'weg' && ownershipShare === null) {
    rateIssues.push('Für den Zusatzantrag in einer WEG fehlt ein gültiger Miteigentumsanteil über 0 und bis 100 Prozent.');
  }
  if (input.contractConditional !== true) blockers.push('Der Liefer-/Leistungsvertrag muss die Förderzusage als aufschiebende oder auflösende Bedingung enthalten.');
  if (input.applicationBeforeStart !== true) blockers.push('Der Antrag muss vor Vorhabenbeginn gestellt werden.');
  if (input.hydraulicBalancingPlanned !== true) blockers.push('Hydraulischer Abgleich bzw. die geforderte Optimierung der Heizungsanlage ist noch nicht bestätigt.');
  if (!unitsKnown || !selfUsedKnown || !privateOwner || projectCosts < 300 || units > 1 && !buildingStructure) rateIssues.push('Die grundlegenden Angaben zu Eigentümerschaft, Wohneinheiten, Nutzung, Gebäudeart oder Kosten sind noch nicht berechenbar.');
  if (selfUsed && typeof input.climateBonusEligible !== 'boolean') rateIssues.push('Die Bonusrate kann ohne geklärten Klimageschwindigkeitsbonus nicht berechnet werden.');
  if (input.allUnitsAffected === false || Number(input.previousEligibleCosts || 0) > 0) rateIssues.push('Teilanlagen und bereits ausgeschöpfte Gebäudekostengrenzen benötigen eine gesonderte anteilige Berechnung.');
  blockers.push(...rateIssues);
  const calculationReady = rateIssues.length === 0;
  const result = {
    status: blockers.length ? 'precheck-incomplete' : 'precheck-positive',
    rulesVersion: FUNDING_RULES_VERSION,
    rulesAsOf: '2026-07-21',
    rulesCheckedAt: FUNDING_RULES_CHECKED_AT,
    rulesApplicationDate: rulesDay,
    publishedScheduleThrough: FUNDING_SCHEDULE_END,
    isProjection,
    calculationReady,
    canUseForFundingNote: calculationReady && blockers.length === 0 && !isProjection,
    calculatedAt: new Date().toISOString(),
    effectiveDate,
    applicationDate: applicationDate ? applicationDate.toISOString().slice(0, 10) : null,
    units,
    selfUsed,
    eligibleMinorChild: verifiedMinorChild,
    incomeBonusRequested,
    requiredTaxYears: selfUsed && incomeBonusRequested === true ? requiredTaxYears : [],
    verifiedHouseholdIncome: verifiedIncome,
    incomeEvidenceComplete,
    buildingStructure,
    ownershipSharePercent: ownershipShareRaw,
    projectCosts,
    eligibleCostCap: costCap,
    eligibleCosts,
    bonuses: { base: baseBonus, climateSpeed: climateBonus, income: incomeBonus },
    uncappedRate,
    maximumUnitRate,
    unitRateCapped,
    buildingBaseRate,
    selfUsedUnitRate,
    additionalUnitRate,
    effectiveBuildingRate,
    rate: units > 1 ? effectiveBuildingRate : selfUsedUnitRate,
    buildingBaseGrant,
    selfUsedUnitEligibleCosts: round(selfUsedUnitEligibleCosts, 2),
    selfUsedUnitAdditionalGrant,
    estimatedGrant: amount,
    blockers,
    checks,
    notice: 'Unverbindlicher Förder-Vorcheck, keine Förderzusage. IVA verwendet den ausgewiesenen KfW-Regelstand; vor Antragstellung sind das aktuelle Merkblatt und die Bestätigung zum Antrag durch Fachunternehmen oder Energieeffizienz-Expertin/-Experten maßgeblich.',
    sources: ENERGY_SOURCES.funding,
  };
  if (!calculationReady) {
    for (const key of ['eligibleCostCap', 'eligibleCosts', 'uncappedRate', 'maximumUnitRate', 'buildingBaseRate', 'selfUsedUnitRate', 'additionalUnitRate', 'effectiveBuildingRate', 'rate', 'buildingBaseGrant', 'selfUsedUnitEligibleCosts', 'selfUsedUnitAdditionalGrant', 'estimatedGrant']) result[key] = null;
    result.bonuses = { base: null, climateSpeed: null, income: null };
    result.unitRateCapped = false;
  }
  result.noteSummary = buildKfw458NoteSummary(result);
  if (isProjection && calculationReady) result.noteSummary = 'Unverbindliche Planung zum künftigen Antragsdatum: ' + result.noteSummary;
  return result;
}
