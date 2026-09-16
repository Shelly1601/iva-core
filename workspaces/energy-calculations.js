const HEAT_LOAD_RULES_VERSION = 'iva-heat-load-preplan-1.0';
export const FUNDING_RULES_VERSION = 'kfw-458-2026-07-21';
export const FUNDING_RULES_CHECKED_AT = '2026-09-16';
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
  let text = String(value ?? '').trim().replace(/\s/g, '');
  if (!text || !/^[+-]?(?:\d+(?:[.,]\d+)?|\d{1,3}(?:\.\d{3})+(?:,\d+)?)$/.test(text)) return null;
  if (text.includes(',')) text = text.replace(/\./g, '').replace(',', '.');
  else if (/^[+-]?\d{1,3}(?:\.\d{3})+$/.test(text)) text = text.replace(/\./g, '');
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
    const height = numberValue(room.height === '' || room.height == null ? building.floorHeight : room.height);
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
    if (!roomMissing.length && outdoor !== null && bridgePercent !== null) {
      const transmission = components.reduce((sum, part) => sum + part.area * part.uValue, 0);
      const estimate = (transmission * (1 + bridgePercent / 100) + 0.34 * airChanges * area * height) * (indoor - outdoor);
      if (!Number.isFinite(estimate) || !Number.isFinite(estimate / area)) missingField(roomMissing, `rooms.${room.id}`, `${roomLabel}: Größen außerhalb des berechenbaren Bereichs`, room.id);
    }
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
  if (!Number.isSafeInteger(units) || units < 1 || !day || day < FUNDING_RULES_START || day > FUNDING_SCHEDULE_END) return null;
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
  if (result.canUseForFundingNote !== true || !Number.isFinite(result.estimatedGrant)) return `Förderhöhe noch nicht belastbar berechenbar: ${(result.blockers || []).slice(0, 3).join(' ')}`;
  const units = Math.max(1, Math.floor(numberValue(result.units) || 1));
  const bonuses = result.bonuses || {};
  const child = result.eligibleMinorChild === null ? 'offen' : result.eligibleMinorChild === true ? 'ja' : 'nein';
  const income = bonuses.income === null ? 'offen' : bonuses.income > 0 ? formatPercent(bonuses.income) : result.incomeBonusRequested !== true ? 'nicht beantragt' : 'nein';
  const climate = bonuses.climateSpeed === null ? 'offen' : bonuses.climateSpeed > 0 ? formatPercent(bonuses.climateSpeed) : 'nein';
  const components = `Grund ${formatPercent(bonuses.base || 0)} | Tempo ${climate} | Einkommen ${income}${result.incomeBonusRequested === true ? ` | Kinder: ${child}` : ''}${result.estimateOnly ? ' | vorläufig' : ''}`;
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
  const blockers = [], rateIssues = [], bonusQuestions = [], checks = [];
  const supplied = value => value !== undefined && value !== null && value !== '';
  const bonusQuestion = text => { if (!bonusQuestions.includes(text)) bonusQuestions.push(text); };
  const applicationDate = validDateValue(input.applicationDate);
  const applicationDay = fundingDateKey(input.applicationDate);
  const effectiveDate = fundingDateKey(now);
  const supplementary = input.applicationKind === 'supplementary';
  const baseApplicationDay = fundingDateKey(input.baseApplicationDate);
  const rulesDateAssumed = supplementary ? !supplied(input.baseApplicationDate) : !supplied(input.applicationDate);
  const rulesDay = (supplementary ? baseApplicationDay : applicationDay) || (rulesDateAssumed ? effectiveDate : null);
  if (supplied(input.applicationDate) && !applicationDay) rateIssues.push('Das eingetragene Antragsdatum ist ungültig.');
  if (supplementary && supplied(input.baseApplicationDate) && !baseApplicationDay) rateIssues.push('Das eingetragene Datum des Basisantrags ist ungültig.');
  if (rulesDateAssumed) checks.push('Vorläufige Berechnung nach aktuellem Regelstand; kein Antragsdatum unterstellt.');
  if (rulesDay && rulesDay < FUNDING_RULES_START) rateIssues.push('Für Anträge bis einschließlich 20.07.2026 muss das frühere KfW-Regelwerk separat berechnet werden.');
  if (rulesDay && rulesDay > FUNDING_SCHEDULE_END) rateIssues.push('Für diesen Antragszeitpunkt muss ein neuer KfW-Regelstand verifiziert werden.');
  if (supplementary && baseApplicationDay && applicationDay && baseApplicationDay > applicationDay) rateIssues.push('Der Basisantrag darf nicht nach dem Zusatzantrag eingehen.');
  if (input.rulesVersion && input.rulesVersion !== FUNDING_RULES_VERSION) rateIssues.push('Der übergebene KfW-Regelstand stimmt nicht mit dem geprüften Regelwerk überein.');
  if (!effectiveDate) rateIssues.push('Das Datum der Berechnung ist ungültig.');
  const rulesSupported = Boolean(rulesDay && rulesDay >= FUNDING_RULES_START && rulesDay <= FUNDING_SCHEDULE_END);
  const isProjection = Boolean(applicationDay && effectiveDate && applicationDay > effectiveDate);
  if (isProjection) blockers.push('Das Antragsdatum liegt in der Zukunft. Die ausgewiesene Planung beruht auf der veröffentlichten Staffel; vor dem tatsächlichen Antrag aktuelle Regeln erneut prüfen.');
  if (rulesSupported) checks.push(`Regelstand ab 21.07.2026; Fördersätze und Kostengrenze zum ${rulesDay}${supplementary ? ' (Basisantrag)' : ''}.`);
  const suppliedUnits = numberValue(input.units);
  const unitsKnown = suppliedUnits !== null && Number.isSafeInteger(suppliedUnits) && suppliedUnits >= 1;
  const units = unitsKnown ? suppliedUnits : 1;
  const projectCosts = Math.max(0, numberValue(input.projectCosts) ?? numberValue(input.offerGrossPrice) ?? numberValue(input.offerPrice) ?? 0);
  const costBasis = input.eligibleCostsConfirmedByBza === true ? 'bza' : 'offer';
  const ageYears = numberValue(input.existingBuildingAgeYears);
  const privateOwner = input.applicantType === 'private-owner';
  const selfUsedKnown = typeof input.selfUsed === 'boolean';
  const selfUsed = input.selfUsed === true;
  const incomeBonusRequested = input.incomeBonusRequested === true;
  const incomeReferenceDay = applicationDay || effectiveDate;
  const incomeYear = validDateValue(incomeReferenceDay)?.getUTCFullYear();
  const requiredTaxYears = incomeYear ? [incomeYear - 3, incomeYear - 2] : [];
  let verifiedIncome = null, verifiedMinorChild = false, incomeEvidenceComplete = false, incomeBonusKnown = !incomeBonusRequested || selfUsedKnown && !selfUsed;
  if (!selfUsedKnown) bonusQuestion('Eigennutzung offen.');
  if (selfUsed && incomeBonusRequested === true) {
    const evidence = input.incomeEvidence || {}, assessments = Array.isArray(evidence.assessments) ? evidence.assessments : [];
    const annual = requiredTaxYears.map(year => assessments.filter(row => row?.year === year && row.verified === true && typeof row.sourceId === 'string' && row.sourceId.trim() && typeof row.householdTaxableIncome === 'number' && Number.isFinite(row.householdTaxableIncome)));
    incomeEvidenceComplete = evidence.householdComplete === true && annual.length === 2 && annual.every(rows => rows.length === 1);
    let incomeInputsValid = incomeEvidenceComplete;
    if (!incomeEvidenceComplete) bonusQuestion(`Einkommensbonus: Steuerbescheide ${requiredTaxYears.join('/')} vollständig prüfen.`);
    else {
      verifiedIncome = annual[0][0].householdTaxableIncome / 2 + annual[1][0].householdTaxableIncome / 2;
      const suppliedIncome = numberValue(input.householdIncome);
      if (suppliedIncome !== null && Math.abs(suppliedIncome - verifiedIncome) > 0.005) { incomeInputsValid = false; bonusQuestion('Einkommensbonus: widersprüchliche Einkommensangaben klären.'); }
      checks.push(`Haushalts-zvE aus vollständig erfassten Steuerbescheiden ${requiredTaxYears.join('/')} gemittelt.`);
    }
    if (typeof input.eligibleMinorChild !== 'boolean') { incomeInputsValid = false; bonusQuestion('Einkommensbonus: Kind unter 18 im Haushalt klären.'); }
    if (input.eligibleMinorChild === true) {
      const child = input.childEvidence || {};
      verifiedMinorChild = child.verified === true && child.minor === true && child.childBenefitEligible === true && child.mainResidenceMatched === true && typeof child.sourceId === 'string' && Boolean(child.sourceId.trim()) && fundingDateKey(child.applicationDate || child.asOf) === incomeReferenceDay;
      if (!verifiedMinorChild) { incomeInputsValid = false; bonusQuestion('Einkommensbonus: Kinderangaben bestätigen.'); }
    }
    if (supplementary && baseApplicationDay && applicationDay && baseApplicationDay.slice(0, 4) !== applicationDay.slice(0, 4)) { incomeInputsValid = false; bonusQuestion('Einkommensbonus: Steuerbezugsjahre des Zusatzantrags bestätigen.'); }
    incomeBonusKnown = incomeInputsValid;
  }
  const climateBonusKnown = selfUsedKnown && (!selfUsed || typeof input.climateBonusEligible === 'boolean');
  if (selfUsed && !climateBonusKnown) bonusQuestion('Heizungsart/Alter für Tempobonus klären.');
  const climateBonus = climateBonusKnown ? selfUsed && input.climateBonusEligible === true && rulesSupported ? climateSpeedBonusRate(rulesDay) : 0 : null;
  const incomeBonus = incomeBonusKnown ? selfUsed && incomeBonusRequested ? incomeBonusRate(verifiedIncome, verifiedMinorChild) : 0 : null;
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
  const unitAllocationKnown = !selfUsed || units === 1 || buildingStructure === 'unpartitioned' || buildingStructure === 'weg' && ownershipShare !== null;
  if (!unitAllocationKnown) bonusQuestion(buildingStructure === 'weg' ? 'Miteigentumsanteil für persönliche Boni klären.' : 'WEG oder ungeteiltes Mehrfamilienhaus klären.');
  const additionalUnitRate = unitAllocationKnown ? Math.max(0, selfUsedUnitRate - buildingBaseRate) : 0;
  const selfUsedUnitAdditionalGrant = round(selfUsedUnitEligibleCosts * additionalUnitRate / 100, 2);
  const amount = round(buildingBaseGrant + selfUsedUnitAdditionalGrant, 2);
  const effectiveBuildingRate = eligibleCosts > 0 ? round(amount / eligibleCosts * 100, 2) : 0;
  if (!privateOwner) blockers.push('Programm 458 richtet sich hier an private Eigentümerinnen und Eigentümer von Wohngebäuden.');
  else checks.push('Private Eigentümerschaft angegeben.');
  if (!unitsKnown) blockers.push('Die Anzahl der abgeschlossenen Wohneinheiten ist nicht eindeutig belegt.');

  if (ageYears === null) blockers.push('Alter des bestehenden Wohngebäudes bzw. Datum der Bauanzeige fehlt.');
  else if (ageYears < 5) blockers.push('Bauantrag/Bauanzeige des bestehenden Wohngebäudes muss zum Antragszeitpunkt mindestens fünf Jahre zurückliegen.');
  else checks.push('Mindestalter des bestehenden Gebäudes erfüllt.');
  if (projectCosts < 300) blockers.push('Die förderfähigen Projektkosten müssen mindestens 300 Euro brutto betragen.');
  checks.push(costBasis === 'bza' ? 'Förderfähige Kosten laut BzA bestätigt.' : 'Angebotspreis als vorläufige Kostenbasis verwendet und auf den Förderhöchstbetrag begrenzt.');
  if (input.contractConditional !== true) blockers.push('Der Liefer-/Leistungsvertrag muss die Förderzusage als aufschiebende oder auflösende Bedingung enthalten.');
  if (input.applicationBeforeStart !== true) blockers.push('Der Antrag muss vor Vorhabenbeginn gestellt werden.');
  if (input.hydraulicBalancingPlanned !== true) blockers.push('Hydraulischer Abgleich bzw. die geforderte Optimierung der Heizungsanlage ist noch nicht bestätigt.');
  if (!unitsKnown || !privateOwner || projectCosts < 300) rateIssues.push('Eigentümerschaft, Wohneinheiten oder Angebotspreis klären.');
  if (input.allUnitsAffected === false || Number(input.previousEligibleCosts || 0) > 0) rateIssues.push('Teilanlagen und bereits ausgeschöpfte Gebäudekostengrenzen benötigen eine gesonderte anteilige Berechnung.');
  blockers.push(...rateIssues, ...bonusQuestions);
  const calculationReady = rateIssues.length === 0;
  const knownExclusion = ageYears !== null && ageYears < 5 || input.contractConditional === false || input.applicationBeforeStart === false;
  const calculationComplete = calculationReady && bonusQuestions.length === 0;
  const estimateOnly = rulesDateAssumed || costBasis === 'offer' || !calculationComplete || blockers.length > 0;
  const result = {
    status: blockers.length ? 'precheck-incomplete' : estimateOnly ? 'precheck-estimate' : 'precheck-positive',
    rulesVersion: FUNDING_RULES_VERSION,
    rulesAsOf: '2026-07-21',
    rulesCheckedAt: FUNDING_RULES_CHECKED_AT,
    rulesApplicationDate: rulesDay,
    rulesDateAssumed,
    costBasis,
    estimateOnly,
    calculationComplete,
    bonusQuestions,
    bonusStatus: { climateSpeed: climateBonusKnown ? 'known' : 'open', income: incomeBonusKnown ? incomeBonusRequested ? 'known' : 'not-requested' : 'open', allocation: unitAllocationKnown ? 'known' : 'open' },
    publishedScheduleThrough: FUNDING_SCHEDULE_END,
    isProjection,
    calculationReady,
    canUseForFundingNote: calculationReady && !knownExclusion && !isProjection,
    calculatedAt: new Date().toISOString(),
    effectiveDate,
    applicationDate: applicationDate ? applicationDate.toISOString().slice(0, 10) : null,
    units,
    selfUsed: selfUsedKnown ? selfUsed : null,
    eligibleMinorChild: incomeBonusRequested && !incomeBonusKnown ? null : verifiedMinorChild,
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
