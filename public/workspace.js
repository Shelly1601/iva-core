const MODES = {
  beratung: { label: 'Beratungsmodus', sub: 'Geführte Beratung mit zentraler Dokumentation.' },
  kunde: { label: 'Kundenmaske', sub: 'Alle Kundendaten und nächsten Schritte an einer Stelle.' },
  energie: { label: 'Energieplaner', sub: 'TMB, Gebäude, Räume, Heizkörper, Fotos und Dokumente in einer Fallakte.' },
};
const PHOTO_CATEGORIES = {
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
const LS_TOKEN = 'iva_token';
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
let mode = MODES[params.get('mode')] ? params.get('mode') : 'beratung';
let current = null;
let rooms = [];
let photoAssignments = [];
let pendingPhotoCategory = '';

function headers(extra = {}) {
  return { Authorization: 'Bearer ' + (localStorage.getItem(LS_TOKEN) || ''), ...extra };
}

async function api(path, opts = {}) {
  const response = await fetch(path, { ...opts, headers: headers({ 'Content-Type': 'application/json', ...(opts.headers || {}) }) });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(json?.error || ('HTTP ' + response.status));
  return json;
}

function status(text, type = '') {
  const element = $('status');
  element.textContent = text;
  element.className = 'status ' + type;
}

function val(id) {
  return $(id)?.value?.trim?.() || '';
}

function checked(id) {
  return Boolean($(id)?.checked);
}

function setVal(id, value) {
  if ($(id)) $(id).value = value ?? '';
}

function setChecked(id, value) {
  if ($(id)) $(id).checked = Boolean(value);
}

function uid() {
  return globalThis.crypto?.randomUUID?.() || ('id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
}

function normalizeRadiator(radiator = {}) {
  return {
    id: radiator.id || uid(),
    type: radiator.type || '',
    panelType: radiator.panelType || '',
    width: radiator.width || '',
    height: radiator.height || '',
    depth: radiator.depth || '',
    notes: radiator.notes || '',
  };
}

function normalizeRoom(room = {}, fallbackHeight = '') {
  const legacy = [room.radiator, room.radiatorSize].filter(Boolean).join(' - ');
  const radiators = Array.isArray(room.radiators) ? room.radiators : (legacy ? [{ notes: legacy }] : []);
  return {
    id: room.id || uid(),
    floor: room.floor || '',
    name: room.name || '',
    use: room.use || '',
    area: room.area || '',
    height: room.height || fallbackHeight || '',
    radiators: radiators.map(normalizeRadiator),
  };
}

function normalizePhotoAssignments(data = {}, files = []) {
  const existingFiles = new Set(files.filter(file => file.kind === 'photo').map(file => file.id));
  const assignments = (Array.isArray(data.photoAssignments) ? data.photoAssignments : [])
    .filter(item => existingFiles.has(item.fileId))
    .map(item => ({ fileId: item.fileId, category: PHOTO_CATEGORIES[item.category] ? item.category : 'sonstiges', note: item.note || '' }));
  for (const fileId of existingFiles) {
    if (!assignments.some(item => item.fileId === fileId)) assignments.push({ fileId, category: 'sonstiges', note: '' });
  }
  return assignments;
}

function photoChecklistItems() {
  const energySource = val('energySource').toLowerCase();
  const tankRelevant = energySource.includes('öl') || Boolean(val('tanks'));
  const pvRelevant = checked('pvPresent') || checked('solarThermal');
  const floorHeatingRelevant = checked('underfloorHeating');
  const radiatorRelevant = rooms.some(room => room.radiators?.length);
  const consumptionRelevant = val('billAvailable') === 'true';
  return [
    { category: 'gebaeude-aussen', title: 'Gebäude außen', detail: 'Gesamtansicht und relevante Hausseite fotografieren.', requirement: 'Pflicht' },
    { category: 'waermepumpe-standort', title: 'Geplanter Wärmepumpen-Standort', detail: 'Übersicht mit Wand, Fenstern, Grundstücksgrenze und Abständen.', requirement: 'Pflicht' },
    { category: 'heizraum', title: 'Heizraum als Übersicht', detail: 'So fotografieren, dass Platz und Zugänglichkeit erkennbar sind.', requirement: 'Pflicht' },
    { category: 'bestandsheizung', title: 'Heizung und Typenschild', detail: 'Gesamtanlage sowie Hersteller-/Leistungsschild aufnehmen.', requirement: 'Pflicht' },
    { category: 'hydraulik', title: 'Rohre, Pumpen und Speicher', detail: 'Anschlüsse, Rohrdurchmesser, Pumpen und vorhandene Speicher.', requirement: 'Pflicht' },
    { category: 'elektro-verteilung', title: 'Elektroverteilung', detail: 'Kompletter Schaltschrank mit freien Plätzen.', requirement: 'Pflicht' },
    { category: 'zaehler', title: 'Zähleranlage', detail: 'Zähler und Umgebung vollständig und lesbar.', requirement: 'Pflicht' },
    { category: 'leitungsweg', title: 'Zugang und Leitungsweg', detail: 'Weg vom Außenstandort bis zum Heizraum dokumentieren.', requirement: 'Pflicht' },
    { category: 'tank-lager', title: 'Tank oder Brennstofflager', detail: 'Gesamtansicht, Anschlüsse und Zugänglichkeit.', requirement: 'Wenn vorhanden', relevant: tankRelevant },
    { category: 'pv-solar', title: 'PV oder Solarthermie', detail: 'Wechselrichter, Speicher beziehungsweise Solarstation.', requirement: 'Wenn vorhanden', relevant: pvRelevant },
    { category: 'fussbodenheizung', title: 'Fußbodenheizungs-Verteiler', detail: 'Verteiler, Kreise und Beschriftungen gut lesbar.', requirement: 'Wenn vorhanden', relevant: floorHeatingRelevant },
    { category: 'heizkoerper', title: 'Heizkörper', detail: 'Je Bauart mindestens ein Foto; Maße separat erfassen.', requirement: 'Wenn erfasst', relevant: radiatorRelevant },
    { category: 'verbrauch-nachweis', title: 'Verbrauchsnachweis', detail: 'Letzte Jahresabrechnung oder Verbrauchsanzeige.', requirement: 'Wenn vorhanden', relevant: consumptionRelevant },
  ];
}

function renderPhotoChecklist() {
  const root = $('photoChecklist');
  if (!root) return;
  root.innerHTML = '';
  const items = photoChecklistItems();
  const relevantItems = items.filter(item => item.requirement === 'Pflicht' || item.relevant);
  let completed = 0;
  for (const item of items) {
    const count = photoAssignments.filter(assignment => assignment.category === item.category).length;
    const relevant = item.requirement === 'Pflicht' || item.relevant;
    const done = count > 0;
    if (relevant && done) completed += 1;
    const card = document.createElement('div');
    card.className = 'photo-check' + (done ? ' done' : '') + (!relevant ? ' not-needed' : '');
    const mark = document.createElement('div');
    mark.className = 'checkmark';
    mark.textContent = done ? '✓' : (relevant ? '○' : '–');
    const copy = document.createElement('div');
    const title = document.createElement('b');
    title.textContent = item.title + (count ? ` (${count})` : '');
    const detail = document.createElement('small');
    detail.textContent = relevant ? item.detail : 'Nach den bisherigen Angaben aktuell nicht nötig.';
    const tag = document.createElement('span');
    tag.className = 'tag' + (item.requirement === 'Pflicht' ? '' : ' conditional');
    tag.textContent = item.requirement;
    copy.append(title, detail, tag);
    const button = document.createElement('button');
    button.className = 'mini-btn';
    button.type = 'button';
    button.textContent = done ? '+ weiteres' : '+ Foto';
    button.disabled = !relevant;
    button.addEventListener('click', () => {
      pendingPhotoCategory = item.category;
      $('photoInput').click();
    });
    card.append(mark, copy, button);
    root.appendChild(card);
  }
  $('photoChecklistCount').textContent = `${completed} von ${relevantItems.length} erledigt`;
  $('photoChecklistHint').textContent = completed === relevantItems.length
    ? 'Alle aktuell erforderlichen Fotopunkte sind abgedeckt.'
    : `${relevantItems.length - completed} Fotopunkte fehlen noch.`;
}

function showMode() {
  for (const name of Object.keys(MODES)) $(name + 'Card').hidden = name !== mode;
  document.querySelectorAll('[data-energy-card]').forEach(card => { card.hidden = mode !== 'energie'; });
  $('roomsCard').hidden = mode !== 'energie';
  $('pdfBtn').textContent = mode === 'energie' ? 'TMB-PDF erstellen' : 'PDF-Vorschau';
  $('pdfBtn2').hidden = mode !== 'energie';
  $('modeLabel').textContent = MODES[mode].label;
  $('pageSub').textContent = MODES[mode].sub;
  document.title = 'IVA · ' + MODES[mode].label;
}

function fresh(nextMode = mode) {
  mode = nextMode;
  current = null;
  rooms = [];
  photoAssignments = [];
  history.replaceState({}, '', location.pathname + '?mode=' + mode);
  document.querySelectorAll('input:not([type=file]),textarea').forEach(input => {
    if (input.type === 'checkbox') input.checked = false;
    else input.value = '';
  });
  document.querySelectorAll('select').forEach(select => { select.selectedIndex = 0; });
  setVal('consumptionUnit', 'kWh');
  setVal('upgradeNeeded', 'unknown');
  $('pageTitle').textContent = ({ beratung: 'Neue Beratung', kunde: 'Neue Kundenakte', energie: 'Neue Energieplanung' })[mode];
  $('statusBadge').textContent = 'Entwurf';
  renderRooms();
  renderFiles();
  renderNotes();
  renderPhotoChecklist();
  showMode();
  updateCompletion();
  document.querySelectorAll('.case').forEach(element => element.classList.remove('active'));
  status('Neue Fallakte - noch nicht gespeichert.');
}

function collectEnergyData() {
  return {
    schemaVersion: 'iva-tmb-1.0',
    assessment: {
      visitDate: val('visitDate'), adviser: val('adviser'), recorderEmail: val('recorderEmail'),
      leadSource: val('leadSource'), salesRep: val('salesRep'),
    },
    building: {
      type: val('buildingType'), year: val('buildingYear'), floors: val('buildingFloors'), floorHeight: val('floorHeight'),
      heatedArea: val('heatedArea'), units: val('buildingUnits'), occupants: val('occupants'), construction: val('construction'),
      glazing: val('glazing'), roof: val('roof'), basement: val('basement'), exteriorInsulation: val('exteriorInsulation'),
      roofInsulation: val('roofInsulation'), basementInsulation: val('basementInsulation'),
    },
    existingHeating: {
      energySource: val('energySource'), manufacturer: val('heatingManufacturer'), model: val('heatingModel'),
      installationYear: val('heatingYear'), nominalPower: val('nominalPower'), boilerLocation: val('boilerLocation'),
      systemType: val('systemType'), pipeSystem: val('pipeSystem'), pipeDiameter: val('pipeDiameter'),
      flowTemperature: val('flowTemperature'), hotWater: val('hotWater'), tanks: val('tanks'),
      annualConsumption: val('annualConsumption'), consumptionUnit: val('consumptionUnit'),
      consumptionPeriod: val('consumptionPeriod'), billAvailable: val('billAvailable') === 'true',
    },
    heatPump: {
      status: 'captured', desiredPosition: val('desiredPosition'), indoorPosition: val('indoorPosition'), distance: val('hpDistance'),
      accessWidth: val('accessWidth'), levelDifference: val('levelDifference'), route: val('hpRoute'),
      refrigerantPreference: val('refrigerantPreference'), manufacturerPreference: val('manufacturerPreference'), notes: val('hpNotes'),
    },
    site: {
      protectedBuilding: checked('protectedBuilding'), noiseSensitive: checked('noiseSensitive'),
      craneRequired: checked('craneRequired'), accessNotes: val('accessNotes'),
    },
    hydraulics: {
      underfloorHeating: checked('underfloorHeating'), circulationPumps: val('circulationPumps'),
      bufferTank: val('bufferTank'), notes: val('hydraulicNotes'),
    },
    electrical: {
      serviceAmps: val('serviceAmps'), meterType: val('meterType'), freeSlots: val('freeSlots'),
      cabinetNotes: val('cabinetNotes'), upgradeNeeded: val('upgradeNeeded') || 'unknown',
    },
    pv: {
      status: 'captured', present: checked('pvPresent'), power: val('pvPower'), batteryPresent: checked('batteryPresent'),
      batteryCapacity: val('batteryCapacity'), solarThermal: checked('solarThermal'),
    },
    rooms,
    photoAssignments,
    calculation: current?.data?.calculation || { status: 'not-started' },
    declaration: {
      reviewed: checked('reviewed'), reviewedBy: val('reviewedBy'), reviewedAt: val('reviewedAt'), notes: val('declarationNotes'),
    },
  };
}

function collect() {
  const data = mode === 'energie'
    ? collectEnergyData()
    : mode === 'beratung'
      ? { appointmentAt: val('appointmentAt'), topic: val('topic'), goal: val('goal'), facts: val('facts'), recommendation: val('recommendation') }
      : { project: val('project'), company: val('company'), relationship: val('relationship'), nextStep: val('nextStep') };
  return {
    mode,
    title: val('title'),
    customer: { name: val('customerName'), address: val('customerAddress'), email: val('customerEmail'), phone: val('customerPhone') },
    data,
    visit: {
      consent: {
        granted: checked('consentGranted'),
        grantedAt: checked('consentGranted') ? (current?.visit?.consent?.grantedAt || new Date().toISOString()) : null,
        method: val('consentMethod'),
      },
      plaud: { recordingId: val('plaudRecordingId'), status: val('plaudRecordingId') ? 'linked' : 'not-linked' },
    },
  };
}

async function save() {
  status('speichert ...');
  try {
    const body = collect();
    if (!current) current = await api('/api/workspaces', { method: 'POST', body: JSON.stringify(body) });
    else current = await api('/api/workspaces/' + current.id, { method: 'PATCH', body: JSON.stringify(body) });
    history.replaceState({}, '', location.pathname + '?mode=' + mode + '&id=' + current.id);
    apply(current);
    await loadList();
    status('Gespeichert · ' + new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }), 'ok');
    return current;
  } catch (error) {
    status('Fehler: ' + error.message, 'err');
    throw error;
  }
}

function applyEnergy(data = {}) {
  const building = data.building || {};
  const assessment = data.assessment || {};
  const heating = data.existingHeating || {};
  const heatPump = data.heatPump || {};
  const site = data.site || {};
  const hydraulics = data.hydraulics || {};
  const electrical = data.electrical || {};
  const pv = data.pv || {};
  const declaration = data.declaration || {};
  rooms = (Array.isArray(data.rooms) ? data.rooms : []).map(room => normalizeRoom(room, building.floorHeight));
  photoAssignments = normalizePhotoAssignments(data, current?.files || []);
  const fields = {
    visitDate: assessment.visitDate, adviser: assessment.adviser, recorderEmail: assessment.recorderEmail,
    leadSource: assessment.leadSource, salesRep: assessment.salesRep,
    buildingType: building.type, buildingYear: building.year, buildingFloors: building.floors, floorHeight: building.floorHeight,
    heatedArea: building.heatedArea, buildingUnits: building.units, occupants: building.occupants, construction: building.construction,
    glazing: building.glazing, roof: building.roof, basement: building.basement, exteriorInsulation: building.exteriorInsulation,
    roofInsulation: building.roofInsulation, basementInsulation: building.basementInsulation,
    energySource: heating.energySource, heatingManufacturer: heating.manufacturer, heatingModel: heating.model,
    heatingYear: heating.installationYear, nominalPower: heating.nominalPower, boilerLocation: heating.boilerLocation,
    systemType: heating.systemType, pipeSystem: heating.pipeSystem, pipeDiameter: heating.pipeDiameter,
    flowTemperature: heating.flowTemperature, hotWater: heating.hotWater, tanks: heating.tanks,
    annualConsumption: heating.annualConsumption, consumptionUnit: heating.consumptionUnit || 'kWh',
    consumptionPeriod: heating.consumptionPeriod, billAvailable: String(Boolean(heating.billAvailable)),
    desiredPosition: heatPump.desiredPosition, indoorPosition: heatPump.indoorPosition, hpDistance: heatPump.distance,
    accessWidth: heatPump.accessWidth, levelDifference: heatPump.levelDifference, hpRoute: heatPump.route,
    refrigerantPreference: heatPump.refrigerantPreference, manufacturerPreference: heatPump.manufacturerPreference, hpNotes: heatPump.notes,
    accessNotes: site.accessNotes, circulationPumps: hydraulics.circulationPumps, bufferTank: hydraulics.bufferTank,
    hydraulicNotes: hydraulics.notes, serviceAmps: electrical.serviceAmps, meterType: electrical.meterType,
    freeSlots: electrical.freeSlots, cabinetNotes: electrical.cabinetNotes, upgradeNeeded: electrical.upgradeNeeded || 'unknown',
    pvPower: pv.power, batteryCapacity: pv.batteryCapacity, reviewedBy: declaration.reviewedBy,
    reviewedAt: declaration.reviewedAt, declarationNotes: declaration.notes,
  };
  for (const [id, value] of Object.entries(fields)) setVal(id, value);
  setChecked('protectedBuilding', site.protectedBuilding);
  setChecked('noiseSensitive', site.noiseSensitive);
  setChecked('craneRequired', site.craneRequired);
  setChecked('underfloorHeating', hydraulics.underfloorHeating);
  setChecked('pvPresent', pv.present);
  setChecked('batteryPresent', pv.batteryPresent);
  setChecked('solarThermal', pv.solarThermal);
  setChecked('reviewed', declaration.reviewed);
}

function apply(workspace) {
  current = workspace;
  mode = workspace.mode;
  setVal('title', workspace.title);
  setVal('customerName', workspace.customer?.name);
  setVal('customerAddress', workspace.customer?.address);
  setVal('customerEmail', workspace.customer?.email);
  setVal('customerPhone', workspace.customer?.phone);
  $('pageTitle').textContent = workspace.title;
  $('statusBadge').textContent = ({ draft: 'Entwurf', active: 'Aktiv', review: 'Prüfung', complete: 'Fertig' })[workspace.status] || 'Entwurf';
  if (mode === 'energie') applyEnergy(workspace.data || {});
  if (mode === 'beratung') {
    setVal('appointmentAt', workspace.data?.appointmentAt); setVal('topic', workspace.data?.topic); setVal('goal', workspace.data?.goal);
    setVal('facts', workspace.data?.facts); setVal('recommendation', workspace.data?.recommendation);
  }
  if (mode === 'kunde') {
    setVal('project', workspace.data?.project); setVal('company', workspace.data?.company);
    setVal('relationship', workspace.data?.relationship); setVal('nextStep', workspace.data?.nextStep);
  }
  setChecked('consentGranted', workspace.visit?.consent?.granted);
  setVal('consentMethod', workspace.visit?.consent?.method);
  setVal('plaudRecordingId', workspace.visit?.plaud?.recordingId);
  $('plaudState').textContent = workspace.visit?.plaud?.recordingId
    ? 'PLAUD-Aufnahme verknüpft: ' + workspace.visit.plaud.recordingId
    : 'PLAUD-Konto noch nicht mit dieser Fallakte verknüpft.';
  showMode();
  renderRooms();
  renderFiles();
  renderNotes();
  updateCompletion();
  renderPhotoChecklist();
  document.querySelectorAll('.case').forEach(element => element.classList.toggle('active', element.dataset.id === workspace.id));
}

function fieldElement(labelText, value, onInput, { type = 'input', options = [] } = {}) {
  const wrap = document.createElement('div');
  const label = document.createElement('label');
  const input = document.createElement(type === 'select' ? 'select' : 'input');
  label.textContent = labelText;
  if (type === 'select') {
    for (const optionValue of options) {
      const optionElement = document.createElement('option');
      optionElement.value = optionValue;
      optionElement.textContent = optionValue || 'bitte wählen';
      input.appendChild(optionElement);
    }
  }
  input.value = value || '';
  input.addEventListener('input', () => { onInput(input.value); updateCompletion(); });
  wrap.append(label, input);
  return wrap;
}

function renderRooms() {
  $('rooms').innerHTML = '';
  if (!rooms.length) {
    $('rooms').innerHTML = '<div class="muted">Noch keine Räume angelegt.</div>';
    updateCompletion();
    renderPhotoChecklist();
    return;
  }
  rooms.forEach((room, roomIndex) => {
    const card = document.createElement('div');
    card.className = 'room-card';
    const head = document.createElement('div');
    head.className = 'room-head';
    const title = document.createElement('strong');
    title.textContent = (roomIndex + 1) + '. ' + (room.name || 'Neuer Raum');
    const actions = document.createElement('div');
    const addRadiatorButton = document.createElement('button');
    addRadiatorButton.className = 'mini-btn';
    addRadiatorButton.textContent = '+ Heizkörper';
    addRadiatorButton.addEventListener('click', () => {
      room.radiators.push(normalizeRadiator());
      renderRooms();
    });
    const deleteRoomButton = document.createElement('button');
    deleteRoomButton.className = 'mini-btn danger';
    deleteRoomButton.textContent = 'Raum löschen';
    deleteRoomButton.addEventListener('click', () => { rooms.splice(roomIndex, 1); renderRooms(); });
    actions.append(addRadiatorButton, deleteRoomButton);
    head.append(title, actions);
    const roomFields = document.createElement('div');
    roomFields.className = 'room-fields';
    const roomSpecs = [
      ['Etage', 'floor'], ['Raum', 'name'], ['Nutzung', 'use'], ['Fläche m²', 'area'], ['Höhe m', 'height'],
    ];
    for (const [label, key] of roomSpecs) {
      roomFields.appendChild(fieldElement(label, room[key], value => { room[key] = value; if (key === 'name') title.textContent = (roomIndex + 1) + '. ' + (value || 'Neuer Raum'); }));
    }
    const radiatorList = document.createElement('div');
    radiatorList.className = 'radiators';
    if (!room.radiators.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = 'Noch kein Heizkörper in diesem Raum erfasst.';
      radiatorList.appendChild(empty);
    }
    room.radiators.forEach((radiator, radiatorIndex) => {
      const radiatorElement = document.createElement('div');
      radiatorElement.className = 'radiator';
      const radiatorHead = document.createElement('div');
      radiatorHead.className = 'radiator-head';
      const radiatorTitle = document.createElement('strong');
      radiatorTitle.textContent = 'Heizkörper ' + (radiatorIndex + 1);
      const deleteButton = document.createElement('button');
      deleteButton.className = 'mini-btn danger';
      deleteButton.textContent = 'entfernen';
      deleteButton.addEventListener('click', () => { room.radiators.splice(radiatorIndex, 1); renderRooms(); });
      radiatorHead.append(radiatorTitle, deleteButton);
      const radiatorFields = document.createElement('div');
      radiatorFields.className = 'radiator-grid';
      radiatorFields.append(
        fieldElement('Bauart', radiator.type, value => { radiator.type = value; }, { type: 'select', options: ['', 'Plattenheizkörper', 'Kompaktheizkörper', 'Röhrenheizkörper', 'Badheizkörper', 'Konvektor', 'Sonstiges'] }),
        fieldElement('Typ', radiator.panelType, value => { radiator.panelType = value; }, { type: 'select', options: ['', '10', '11', '21', '22', '33'] }),
        fieldElement('Breite mm', radiator.width, value => { radiator.width = value; }),
        fieldElement('Höhe mm', radiator.height, value => { radiator.height = value; }),
        fieldElement('Tiefe mm', radiator.depth, value => { radiator.depth = value; }),
        fieldElement('Hinweis', radiator.notes, value => { radiator.notes = value; }),
      );
      radiatorElement.append(radiatorHead, radiatorFields);
      radiatorList.appendChild(radiatorElement);
    });
    card.append(head, roomFields, radiatorList);
    $('rooms').appendChild(card);
  });
  updateCompletion();
  renderPhotoChecklist();
}

function addRoom() {
  rooms.push(normalizeRoom({ height: val('floorHeight') }));
  renderRooms();
}

function kindLabel(kind) {
  return ({ floorplan: 'Grundriss', elevation: 'Seitenansicht', photo: 'Foto', 'tmb-template': 'TMB-Referenz', document: 'Dokument', audio: 'Audio' })[kind] || kind;
}

function renderFiles() {
  $('files').innerHTML = '';
  const files = current?.files || [];
  photoAssignments = normalizePhotoAssignments({ photoAssignments }, files);
  if (!files.length) {
    $('files').innerHTML = '<div class="muted">Noch keine Dateien.</div>';
    renderPhotoChecklist();
    return;
  }
  files.forEach(file => {
    const row = document.createElement('div');
    row.className = 'file';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('b');
    name.textContent = file.name;
    const details = document.createElement('small');
    details.textContent = kindLabel(file.kind) + ' · ' + Math.max(1, Math.round(file.bytes / 1024)) + ' KB';
    meta.append(name, details);
    row.appendChild(meta);
    if (file.kind === 'photo') {
      const assignment = photoAssignments.find(item => item.fileId === file.id);
      const photoFields = document.createElement('div');
      photoFields.className = 'photo-fields';
      const select = document.createElement('select');
      for (const [category, label] of Object.entries(PHOTO_CATEGORIES)) {
        const optionElement = document.createElement('option');
        optionElement.value = category;
        optionElement.textContent = label;
        select.appendChild(optionElement);
      }
      select.value = assignment.category;
      select.addEventListener('change', () => { assignment.category = select.value; renderPhotoChecklist(); });
      const note = document.createElement('input');
      note.placeholder = 'Foto kurz beschreiben';
      note.value = assignment.note;
      note.addEventListener('input', () => { assignment.note = note.value; });
      photoFields.append(select, note);
      row.appendChild(photoFields);
    }
    const open = document.createElement('button');
    open.className = 'linkbtn';
    open.textContent = 'Öffnen';
    open.addEventListener('click', () => openFile(file));
    row.appendChild(open);
    $('files').appendChild(row);
  });
  renderPhotoChecklist();
}

function renderNotes() {
  $('notes').innerHTML = '';
  const notes = current?.notes || [];
  if (!notes.length) {
    $('notes').innerHTML = '<div class="muted">Noch keine Notizen.</div>';
    return;
  }
  notes.slice().reverse().forEach(note => {
    const row = document.createElement('div');
    row.className = 'file';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const text = document.createElement('b');
    text.textContent = note.text;
    const details = document.createElement('small');
    details.textContent = (note.source || 'manual') + ' · ' + new Date(note.createdAt).toLocaleString('de-DE');
    meta.append(text, details);
    row.appendChild(meta);
    $('notes').appendChild(row);
  });
}

async function openFile(file) {
  try {
    const response = await fetch('/api/workspaces/' + current.id + '/files/' + file.id, { headers: headers() });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const url = URL.createObjectURL(await response.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    status('Datei konnte nicht geöffnet werden: ' + error.message, 'err');
  }
}

async function upload(input) {
  if (!input.files?.length) return;
  try {
    if (!current) await save();
    const knownFileIds = new Set((current.files || []).map(file => file.id));
    for (const file of input.files) {
      status('lädt ' + file.name + ' hoch ...');
      const query = new URLSearchParams({ kind: input.dataset.kind, name: file.name, mime: file.type || 'application/octet-stream' });
      const response = await fetch('/api/workspaces/' + current.id + '/files?' + query, {
        method: 'POST', headers: headers({ 'Content-Type': file.type || 'application/octet-stream' }), body: file,
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) throw new Error(json?.error || ('HTTP ' + response.status));
    }
    current = await api('/api/workspaces/' + current.id);
    apply(current);
    if (input.dataset.kind === 'photo' && pendingPhotoCategory) {
      const newPhotoIds = (current.files || []).filter(file => file.kind === 'photo' && !knownFileIds.has(file.id)).map(file => file.id);
      for (const fileId of newPhotoIds) {
        const assignment = photoAssignments.find(item => item.fileId === fileId);
        if (assignment) assignment.category = pendingPhotoCategory;
      }
      current = await api('/api/workspaces/' + current.id, { method: 'PATCH', body: JSON.stringify({ data: { photoAssignments } }) });
      apply(current);
    }
    status(input.files.length + ' Datei(en) gespeichert und der Checkliste zugeordnet.', 'ok');
  } catch (error) {
    status('Upload-Fehler: ' + error.message, 'err');
  } finally {
    pendingPhotoCategory = '';
    input.value = '';
  }
}

async function addNote() {
  const text = val('noteDraft');
  if (!text) return;
  try {
    if (!current) await save();
    current = await api('/api/workspaces/' + current.id + '/notes', { method: 'POST', body: JSON.stringify({ text, source: 'manual' }) });
    $('noteDraft').value = '';
    renderNotes();
    await loadList();
    status('Notiz gespeichert.', 'ok');
  } catch (error) {
    status('Fehler: ' + error.message, 'err');
  }
}

async function loadList() {
  try {
    const list = await api('/api/workspaces');
    $('caseList').innerHTML = '';
    if (!list.length) {
      $('caseList').innerHTML = '<div class="muted">Noch keine Fallakten.</div>';
      return;
    }
    list.slice(0, 20).forEach(workspace => {
      const button = document.createElement('button');
      button.className = 'case' + (current?.id === workspace.id ? ' active' : '');
      button.dataset.id = workspace.id;
      const title = document.createElement('b');
      title.textContent = workspace.title;
      const details = document.createElement('small');
      details.textContent = MODES[workspace.mode]?.label + ' · ' + (workspace.customer?.name || 'ohne Kunde');
      button.append(title, details);
      button.addEventListener('click', () => loadOne(workspace.id));
      $('caseList').appendChild(button);
    });
  } catch {
    $('caseList').innerHTML = '<div class="muted">Nicht verbunden.</div>';
    status('Verbindung fehlt. API-Token im Cockpit prüfen.', 'err');
  }
}

async function loadOne(id) {
  try {
    status('lädt ...');
    const workspace = await api('/api/workspaces/' + id);
    history.replaceState({}, '', location.pathname + '?mode=' + workspace.mode + '&id=' + workspace.id);
    apply(workspace);
    status('Fallakte geladen.', 'ok');
  } catch (error) {
    status('Fehler: ' + error.message, 'err');
  }
}

function updateCompletion() {
  if (!$('completionFill')) return;
  const required = ['customerName', 'customerAddress', 'visitDate', 'adviser', 'buildingType', 'buildingYear', 'heatedArea', 'energySource', 'flowTemperature', 'annualConsumption', 'desiredPosition', 'indoorPosition', 'serviceAmps'];
  const completed = required.filter(id => val(id)).length + (rooms.length ? 1 : 0);
  const total = required.length + 1;
  const percentage = Math.round((completed / total) * 100);
  $('completionFill').style.width = percentage + '%';
  $('completionText').textContent = percentage + ' %';
}

function reportRow(parent, label, value) {
  if (value === undefined || value === null || value === '') return;
  const row = document.createElement('div');
  row.className = 'print-row';
  const name = document.createElement('b');
  const content = document.createElement('div');
  name.textContent = label;
  content.textContent = String(value);
  row.append(name, content);
  parent.appendChild(row);
}

function reportSection(root, title, rows) {
  const section = document.createElement('section');
  section.className = 'print-section';
  const heading = document.createElement('h2');
  heading.textContent = title;
  section.appendChild(heading);
  rows(section);
  root.appendChild(section);
}

function buildSimpleReport() {
  const collected = collect();
  const root = $('printReport');
  root.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'print-head';
  const left = document.createElement('div');
  const heading = document.createElement('h1');
  const subtitle = document.createElement('div');
  const date = document.createElement('div');
  heading.textContent = collected.title || MODES[mode].label;
  subtitle.textContent = 'IVA · ' + MODES[mode].label;
  date.textContent = new Date().toLocaleDateString('de-DE');
  left.append(heading, subtitle);
  head.append(left, date);
  root.appendChild(head);
  reportSection(root, 'Kunde', section => {
    reportRow(section, 'Name', collected.customer.name); reportRow(section, 'Adresse', collected.customer.address);
    reportRow(section, 'E-Mail', collected.customer.email); reportRow(section, 'Telefon', collected.customer.phone);
  });
  if (mode === 'beratung') reportSection(root, 'Beratung', section => {
    reportRow(section, 'Termin', collected.data.appointmentAt); reportRow(section, 'Thema', collected.data.topic);
    reportRow(section, 'Ziel', collected.data.goal); reportRow(section, 'Fakten', collected.data.facts);
    reportRow(section, 'Empfehlung', collected.data.recommendation);
  });
  if (mode === 'kunde') reportSection(root, 'Kundenakte', section => {
    reportRow(section, 'Projekt', collected.data.project); reportRow(section, 'Firma', collected.data.company);
    reportRow(section, 'Ausgangslage', collected.data.relationship); reportRow(section, 'Nächster Schritt', collected.data.nextStep);
  });
}

async function downloadTmbPdf() {
  try {
    if (mode !== 'energie') {
      buildSimpleReport();
      window.print();
      return;
    }
    await save();
    status('TMB-PDF wird erstellt ...');
    const response = await fetch('/api/workspaces/' + current.id + '/tmb.pdf', { headers: headers() });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.error || ('HTTP ' + response.status));
    }
    const disposition = response.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/i);
    const filename = match?.[1] || 'IVA-TMB.pdf';
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status('TMB-PDF wurde erstellt.', 'ok');
  } catch (error) {
    status('PDF-Fehler: ' + error.message, 'err');
  }
}

$('saveBtn').addEventListener('click', save);
$('pdfBtn').addEventListener('click', downloadTmbPdf);
$('pdfBtn2').addEventListener('click', downloadTmbPdf);
$('addRoomBtn').addEventListener('click', addRoom);
$('addNoteBtn').addEventListener('click', addNote);
$('addGeneralPhotoBtn').addEventListener('click', () => { pendingPhotoCategory = 'sonstiges'; $('photoInput').click(); });
document.querySelectorAll('[data-new]').forEach(button => button.addEventListener('click', () => fresh(button.dataset.new)));
document.querySelectorAll('input[type=file][data-kind]').forEach(input => input.addEventListener('change', () => upload(input)));
document.querySelectorAll('[data-trigger]').forEach(button => button.addEventListener('click', () => $(button.dataset.trigger).click()));
document.querySelectorAll('input:not([type=file]),select,textarea').forEach(input => input.addEventListener('input', () => { updateCompletion(); renderPhotoChecklist(); }));
window.addEventListener('beforeprint', () => { if (mode !== 'energie') buildSimpleReport(); });

showMode();
loadList().then(() => {
  const id = params.get('id');
  if (id) loadOne(id);
  else fresh(mode);
});
