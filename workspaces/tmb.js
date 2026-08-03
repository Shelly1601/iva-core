import crypto from 'crypto';

export const TMB_SCHEMA_VERSION = 'iva-tmb-1.0';

export const TMB_PHOTO_CATEGORIES = [
  'gebaeude-aussen',
  'waermepumpe-standort',
  'heizraum',
  'bestandsheizung',
  'tank-lager',
  'hydraulik',
  'elektro-verteilung',
  'zaehler',
  'leitungsweg',
  'grundriss-markierung',
  'heizkoerper',
  'fussbodenheizung',
  'pv-solar',
  'verbrauch-nachweis',
  'sonstiges',
];

export const TMB_PHOTO_LABELS = {
  'gebaeude-aussen': 'Gebäude außen',
  'waermepumpe-standort': 'Geplanter Wärmepumpen-Standort',
  heizraum: 'Heizraum',
  bestandsheizung: 'Bestandsheizung',
  'tank-lager': 'Tank / Brennstofflager',
  hydraulik: 'Hydraulik / Rohrleitungen',
  'elektro-verteilung': 'Elektroverteilung',
  zaehler: 'Zähleranlage',
  leitungsweg: 'Leitungsweg',
  'grundriss-markierung': 'Grundriss / Markierung',
  heizkoerper: 'Heizkörper',
  fussbodenheizung: 'Fußbodenheizung / Verteiler',
  'pv-solar': 'PV / Solarthermie',
  'verbrauch-nachweis': 'Verbrauchsnachweis',
  sonstiges: 'Sonstiges',
};

export function initialEnergyData() {
  return {
    schemaVersion: TMB_SCHEMA_VERSION,
    assessment: {
      visitDate: '',
      adviser: '',
      recorderEmail: '',
      leadSource: '',
      salesRep: '',
    },
    building: {
      type: '',
      year: '',
      floors: '',
      floorHeight: '',
      heatedArea: '',
      units: '',
      occupants: '',
      construction: '',
      glazing: '',
      roof: '',
      basement: '',
      exteriorInsulation: '',
      roofInsulation: '',
      basementInsulation: '',
      designOutdoorTemperature: '',
      thermalBridgePercent: '',
    },
    existingHeating: {
      energySource: '',
      manufacturer: '',
      model: '',
      installationYear: '',
      nominalPower: '',
      boilerLocation: '',
      systemType: '',
      pipeSystem: '',
      pipeDiameter: '',
      flowTemperature: '',
      hotWater: '',
      tanks: '',
      annualConsumption: '',
      consumptionUnit: 'kWh',
      consumptionPeriod: '',
      billAvailable: false,
    },
    heatPump: {
      status: 'not-started',
      desiredPosition: '',
      indoorPosition: '',
      distance: '',
      accessWidth: '',
      levelDifference: '',
      route: '',
      refrigerantPreference: '',
      manufacturerPreference: '',
      notes: '',
    },
    electrical: {
      serviceAmps: '',
      meterType: '',
      freeSlots: '',
      cabinetNotes: '',
      upgradeNeeded: 'unknown',
    },
    hydraulics: {
      underfloorHeating: false,
      circulationPumps: '',
      bufferTank: '',
      notes: '',
    },
    pv: {
      status: 'not-started',
      present: false,
      power: '',
      batteryPresent: false,
      batteryCapacity: '',
      solarThermal: false,
    },
    site: {
      protectedBuilding: false,
      noiseSensitive: false,
      craneRequired: false,
      accessNotes: '',
    },
    rooms: [],
    photoAssignments: [],
    calculation: { status: 'not-started' },
    funding: {
      applicantType: 'private-owner',
      selfUsed: false,
      existingBuildingAgeYears: '',
      projectCosts: '',
      householdIncome: '',
      eligibleMinorChild: false,
      climateBonusEligible: false,
      contractConditional: false,
      applicationBeforeStart: false,
      hydraulicBalancingPlanned: false,
      result: null,
    },
    declaration: {
      reviewed: false,
      reviewedBy: '',
      reviewedAt: '',
      notes: '',
    },
  };
}

export function normalizeRoom(room = {}, fallbackHeight = '') {
  const legacyRadiator = [room.radiator, room.radiatorSize].filter(Boolean).join(' - ');
  const radiators = Array.isArray(room.radiators) ? room.radiators : (legacyRadiator ? [{ notes: legacyRadiator }] : []);
  return {
    id: room.id || crypto.randomUUID(),
    floor: room.floor || '',
    name: room.name || '',
    use: room.use || '',
    area: room.area || '',
    height: room.height || fallbackHeight || '',
    targetTemperature: room.targetTemperature || '',
    airChanges: room.airChanges || '',
    envelope: {
      externalWallArea: room.envelope?.externalWallArea || '',
      externalWallUValue: room.envelope?.externalWallUValue || '',
      windowArea: room.envelope?.windowArea || '',
      windowUValue: room.envelope?.windowUValue || '',
      ceilingArea: room.envelope?.ceilingArea || '',
      ceilingUValue: room.envelope?.ceilingUValue || '',
      floorArea: room.envelope?.floorArea || '',
      floorUValue: room.envelope?.floorUValue || '',
    },
    radiators: radiators.map(radiator => ({
      id: radiator?.id || crypto.randomUUID(),
      type: radiator?.type || '',
      panelType: radiator?.panelType || '',
      width: radiator?.width || '',
      height: radiator?.height || '',
      depth: radiator?.depth || '',
      notes: radiator?.notes || '',
    })),
  };
}

export function normalizeEnergyData(data = {}) {
  const initial = initialEnergyData();
  const merged = {
    ...initial,
    ...data,
    assessment: { ...initial.assessment, ...(data.assessment || {}) },
    building: { ...initial.building, ...(data.building || {}) },
    existingHeating: { ...initial.existingHeating, ...(data.existingHeating || {}) },
    heatPump: { ...initial.heatPump, ...(data.heatPump || {}) },
    electrical: { ...initial.electrical, ...(data.electrical || {}) },
    hydraulics: { ...initial.hydraulics, ...(data.hydraulics || {}) },
    pv: { ...initial.pv, ...(data.pv || {}) },
    site: { ...initial.site, ...(data.site || {}) },
    calculation: { ...initial.calculation, ...(data.calculation || {}) },
    funding: { ...initial.funding, ...(data.funding || {}) },
    declaration: { ...initial.declaration, ...(data.declaration || {}) },
  };
  merged.schemaVersion = TMB_SCHEMA_VERSION;
  merged.rooms = (Array.isArray(data.rooms) ? data.rooms : []).map(room => normalizeRoom(room, merged.building.floorHeight));
  merged.photoAssignments = Array.isArray(data.photoAssignments) ? data.photoAssignments : [];
  return merged;
}
