const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const workspaceId = params.get('workspaceId') || '';
const token = () => localStorage.getItem('iva_token') || '';
const state = { catalog: null, quote: null, heatPumpConversion: null, workspace: null, ready: false, timer: null, heatPumpTimer: null };

function headers(extra = {}) {
  return { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json', ...extra };
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: headers(options.headers || {}) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

function setStatus(text, type = '') {
  $('status').textContent = text;
  $('status').className = 'status ' + type;
}

function number(id, fallback = 0) {
  const value = $(id)?.value;
  return value === '' || value === undefined ? fallback : Number(value);
}

function setValue(id, value) {
  if ($(id)) $(id).value = value ?? '';
}

function money(value) {
  return Number(value || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

function integer(value) {
  return Number(value || 0).toLocaleString('de-DE', { maximumFractionDigits: 0 });
}

function fillDefaults() {
  const defaults = state.catalog.defaults || {};
  for (const [id, value] of Object.entries(defaults)) {
    if (!$(id)) continue;
    if ($(id).type === 'checkbox') $(id).checked = Boolean(value);
    else setValue(id, value);
  }
  $('autoModules').checked = true;
  $('moduleCount').disabled = true;
}

function populateInverters(selected = '') {
  const family = $('inverterFamily').value || 'tp';
  const list = state.catalog?.inverters?.[family] || [];
  $('inverterId').replaceChildren(new Option('Automatisch passend wählen', ''));
  for (const item of list) {
    const detail = item.maxInputKwp ? ` · max. ${item.maxInputKwp} kWp Eingang` : ` · ${item.nominalKw} kW`;
    $('inverterId').appendChild(new Option(item.label + detail, item.id));
  }
  if (list.some(item => item.id === selected)) $('inverterId').value = selected;
}

function renderCatalog() {
  populateInverters();
  for (const warranty of state.catalog.warranties || []) $('warrantyId').appendChild(new Option(`${warranty.label} · ${money(warranty.price)}`, warranty.id));
  $('addOns').replaceChildren();
  for (const item of state.catalog.addOns || []) {
    const card = document.createElement('div'); card.className = 'addon';
    const label = document.createElement('label');
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = item.id; input.dataset.addOn = 'true';
    const text = document.createElement('span'); text.textContent = item.label;
    const price = document.createElement('b'); price.className = 'price'; price.textContent = money(item.price);
    label.append(input, text, price); card.appendChild(label); $('addOns').appendChild(card);
  }
  $('versionBadge').textContent = state.catalog.validFrom ? `Stand ${new Date(state.catalog.validFrom + 'T12:00:00').toLocaleDateString('de-DE')}` : 'Preisstand';
}

function applySavedInput(input = {}) {
  const ids = [
    'householdConsumptionKwh', 'heatPumpConsumptionKwh', 'evConsumptionKwh', 'targetCoveragePercent',
    'specificYieldKwhPerKwp', 'usableRoofAreaM2', 'layoutFactorPercent', 'moduleCount',
    'storage6Qty', 'storage9Qty', 'warrantyId', 'intermediateMeters', 'dismantleModules', 'metalReplacementTiles',
  ];
  for (const id of ids) if (input[id] !== undefined) setValue(id, input[id]);
  if (input.moduleCount) { $('autoModules').checked = false; $('moduleCount').disabled = false; }
  if (input.inverterFamily) $('inverterFamily').value = input.inverterFamily;
  populateInverters(input.inverterId || '');
  if (input.basicEquipment !== undefined) $('basicEquipment').checked = Boolean(input.basicEquipment);
  const selected = new Set(input.addOnIds || []);
  document.querySelectorAll('[data-add-on]').forEach(element => { element.checked = selected.has(element.value); });
}

function inputPayload() {
  return {
    householdConsumptionKwh: number('householdConsumptionKwh'),
    heatPumpConsumptionKwh: number('heatPumpConsumptionKwh'),
    evConsumptionKwh: number('evConsumptionKwh'),
    targetCoveragePercent: number('targetCoveragePercent', 100),
    specificYieldKwhPerKwp: number('specificYieldKwhPerKwp', 950),
    usableRoofAreaM2: number('usableRoofAreaM2'),
    layoutFactorPercent: number('layoutFactorPercent', 85),
    moduleCount: $('autoModules').checked ? undefined : number('moduleCount'),
    inverterFamily: $('inverterFamily').value,
    inverterId: $('inverterId').value,
    basicEquipment: $('basicEquipment').checked,
    storage6Qty: number('storage6Qty'),
    storage9Qty: number('storage9Qty'),
    warrantyId: $('warrantyId').value,
    addOnIds: [...document.querySelectorAll('[data-add-on]:checked')].map(element => element.value),
    intermediateMeters: number('intermediateMeters'),
    dismantleModules: number('dismantleModules'),
    metalReplacementTiles: number('metalReplacementTiles'),
  };
}

function heatPumpPayload() {
  return {
    source: $('hpSource').value,
    annualConsumption: number('hpAnnualConsumption'),
    seasonalPerformanceFactor: number('hpSeasonalPerformanceFactor', 4),
    boilerEfficiencyPercent: number('hpBoilerEfficiencyPercent', 100),
  };
}

function renderHeatPumpConversion(conversion) {
  state.heatPumpConversion = conversion;
  const result = conversion.result || {};
  $('hpElectricityResult').textContent = `${integer(result.heatPumpElectricityKwh)} kWh/Jahr`;
  $('hpHeatResult').textContent = `angesetzte Nutzwärme: ${integer(result.usefulHeatKwh)} kWh/Jahr`;
  $('hpFormula').textContent = conversion.formula || 'Faustformel berechnet';
  $('hpConsumptionUnit').textContent = conversion.source?.unit || 'pro Jahr';
  $('applyHeatPumpBtn').disabled = !Number.isFinite(Number(result.heatPumpElectricityKwh));
}

async function convertHeatPump({ quiet = true } = {}) {
  if (!quiet) setStatus('Wärmepumpenstrom wird überschlägig umgerechnet …');
  try {
    const conversion = await api('/api/energy/heat-pump-electricity/calculate', {
      method: 'POST',
      body: JSON.stringify(heatPumpPayload()),
    });
    renderHeatPumpConversion(conversion);
    if (!quiet) setStatus('Wärmepumpenstrom ist als Planungswert berechnet.', 'ok');
  } catch (error) {
    state.heatPumpConversion = null;
    $('hpElectricityResult').textContent = '–';
    $('hpHeatResult').textContent = 'Eingaben bitte prüfen';
    $('hpFormula').textContent = error.message;
    $('applyHeatPumpBtn').disabled = true;
    if (!quiet) setStatus('Umrechnungsfehler: ' + error.message, 'err');
  }
}

function scheduleHeatPumpConversion() {
  if (!state.ready) return;
  clearTimeout(state.heatPumpTimer);
  state.heatPumpTimer = setTimeout(() => convertHeatPump(), 220);
}

function applyHeatPumpConversion() {
  const electricity = state.heatPumpConversion?.result?.heatPumpElectricityKwh;
  if (!Number.isFinite(Number(electricity))) return;
  setValue('heatPumpConsumptionKwh', Math.round(Number(electricity)));
  scheduleCalculate();
  setStatus(`${integer(electricity)} kWh Wärmepumpenstrom wurden in den Modulschnellrechner übernommen.`, 'ok');
  $('heatPumpConsumptionKwh').focus({ preventScroll: true });
}

function renderQuote(quote) {
  state.quote = quote;
  const sizing = quote.sizing || {};
  $('metricModules').textContent = integer(sizing.selectedModules);
  $('metricRoof').textContent = sizing.roofCapacityModules === null ? `Bedarf: ${integer(sizing.demandModules)} Module` : `Dach grob: ${integer(sizing.roofCapacityModules)} · Bedarf: ${integer(sizing.demandModules)}`;
  $('metricKwp').textContent = `${Number(sizing.systemKwp || 0).toLocaleString('de-DE')} kWp`;
  $('metricYield').textContent = `${integer(sizing.estimatedAnnualProductionKwh)} kWh`;
  $('metricStorage').textContent = `${integer(sizing.storageCapacityKwh)} kWh`;
  $('metricInverter').textContent = sizing.selectedInverter?.label || 'Wechselrichter offen';
  $('metricPrice').textContent = money(quote.price?.total);
  $('totalPrice').textContent = money(quote.price?.total);
  $('totalMeta').textContent = `${sizing.selectedModules} Module · ${Number(sizing.systemKwp || 0).toLocaleString('de-DE')} kWp`;

  $('breakdown').replaceChildren();
  for (const item of quote.price?.breakdown || []) {
    const row = document.createElement('div'); row.className = 'line';
    const left = document.createElement('div'); const label = document.createElement('span'); const meta = document.createElement('small');
    label.textContent = item.label; meta.textContent = item.quantity > 1 ? `${item.quantity} × ${money(item.unitPrice)}` : 'einmalig'; left.append(label, meta);
    const amount = document.createElement('b'); amount.textContent = money(item.total); row.append(left, amount); $('breakdown').appendChild(row);
  }

  $('notes').replaceChildren();
  for (const text of quote.warnings || []) {
    const note = document.createElement('div'); note.className = 'note warn'; note.textContent = text; $('notes').appendChild(note);
  }
  for (const text of quote.notices || []) {
    const note = document.createElement('div'); note.className = 'note'; note.textContent = text; $('notes').appendChild(note);
  }
}

async function calculate({ quiet = false } = {}) {
  if (!state.catalog) return;
  if (!quiet) setStatus('Preis und Dimensionierung werden berechnet …');
  try {
    const quote = await api('/api/energy/pv-price/calculate', { method: 'POST', body: JSON.stringify(inputPayload()) });
    renderQuote(quote);
    if ($('autoModules').checked) setValue('moduleCount', quote.sizing.selectedModules);
    setStatus('Aktuell berechnet · unverbindliche Erstindikation', 'ok');
  } catch (error) {
    state.quote = null;
    setStatus('Rechenfehler: ' + error.message, 'err');
  }
}

function scheduleCalculate() {
  if (!state.ready) return;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => calculate({ quiet: true }), 280);
}

async function loadWorkspace() {
  if (!workspaceId) {
    $('caseState').textContent = 'Ohne Fallakte geöffnet. Rechnen ist möglich; zum Speichern bitte aus einer Energie-Fallakte starten.';
    $('saveBtn').disabled = true;
    return;
  }
  state.workspace = await api('/api/workspaces/' + encodeURIComponent(workspaceId));
  if (state.workspace.mode !== 'energie') throw new Error('Die gewählte Fallakte ist keine Energieplanung.');
  const customer = state.workspace.customer?.name || 'Kunde noch offen';
  $('caseState').replaceChildren();
  const title = document.createElement('b'); title.textContent = customer;
  const detail = document.createTextNode(` · ${state.workspace.title}`);
  $('caseState').append(title, detail);
  $('saveBtn').disabled = false;
  $('backLink').href = `/workspace?mode=energie&id=${encodeURIComponent(workspaceId)}`;
  const saved = state.workspace.data?.pv?.pricePlanning;
  if (saved?.input) applySavedInput(saved.input);
  else {
    const pv = state.workspace.data?.pv || {};
    if (pv.power) {
      const modules = Math.round(Number(pv.power) / (state.catalog.module.powerW / 1000));
      if (modules >= 8 && modules <= 70) { $('autoModules').checked = false; $('moduleCount').disabled = false; setValue('moduleCount', modules); }
    }
    if (pv.batteryCapacity) {
      const capacity = Number(pv.batteryCapacity);
      setValue('storage9Qty', capacity >= 9 ? Math.max(1, Math.round(capacity / 9)) : 0);
      setValue('storage6Qty', capacity > 0 && capacity < 9 ? 1 : 0);
    }
  }
}

async function saveQuote() {
  if (!workspaceId) return;
  setStatus('PV-Planung wird in der Fallakte gespeichert …');
  try {
    const result = await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/energy/pv-price/calculate`, { method: 'POST', body: JSON.stringify(inputPayload()) });
    state.workspace = result.workspace; renderQuote(result.quote);
    setStatus('PV-Planung ist in der gemeinsamen Fallakte gespeichert.', 'ok');
  } catch (error) { setStatus('Speicherfehler: ' + error.message, 'err'); }
}

function bind() {
  $('calculateBtn').addEventListener('click', () => calculate());
  $('saveBtn').addEventListener('click', saveQuote);
  $('applyHeatPumpBtn').addEventListener('click', applyHeatPumpConversion);
  $('autoModules').addEventListener('change', () => { $('moduleCount').disabled = $('autoModules').checked; scheduleCalculate(); });
  $('inverterFamily').addEventListener('change', () => { populateInverters(); scheduleCalculate(); });
  document.querySelectorAll('[data-hp-converter]').forEach(element => element.addEventListener('input', scheduleHeatPumpConversion));
  document.querySelectorAll('input:not([data-hp-converter]),select:not([data-hp-converter])').forEach(element => element.addEventListener('input', scheduleCalculate));
  $('ivaHelper').addEventListener('click', () => window.open('/cockpit', '_blank', 'noopener'));
}

async function init() {
  try {
    state.catalog = await api('/api/energy/pv-price/catalog');
    fillDefaults(); renderCatalog(); await loadWorkspace(); bind(); state.ready = true;
    await Promise.all([calculate(), convertHeatPump()]);
  } catch (error) {
    const hint = error.message === 'unauthorized' ? 'API-Token fehlt oder stimmt nicht. Bitte im IVA-Cockpit hinterlegen.' : error.message;
    setStatus('Startfehler: ' + hint, 'err');
  }
}

init();
