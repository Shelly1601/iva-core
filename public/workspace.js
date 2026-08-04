import { calculateCorporateBenefits } from './corporate-benefits-calculator.js';
import { applyBkvOfferSelection, findBkvOffer } from './bkv-offer-catalog.js';

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
let adviceCatalog = { groups: [], modules: [], connectors: {} };
let selectedAdviceModules = [];
let adviceModuleData = {};
let activeAdviceModuleId = '';

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

function adviceModule(id) {
  return adviceCatalog.modules.find(module => module.id === id) || null;
}

async function loadAdviceCatalog() {
  try {
    adviceCatalog = await api('/api/advice/catalog');
    const select = $('adviceModuleSelect');
    select.innerHTML = '<option value="">Modul wählen</option>';
    for (const group of adviceCatalog.groups || []) {
      const optionGroup = document.createElement('optgroup');
      optionGroup.label = group.label;
      for (const module of (adviceCatalog.modules || []).filter(item => item.group === group.id && (!item.launchMode || item.launchMode === 'beratung'))) {
        const option = document.createElement('option');
        option.value = module.id; option.textContent = module.title;
        optionGroup.appendChild(option);
      }
      select.appendChild(optionGroup);
    }
  } catch (error) {
    status('Beratungsmodule konnten nicht geladen werden: ' + error.message, 'err');
  }
}

function moduleDefaults(module) {
  const defaults = {};
  for (const section of module?.sections || []) {
    for (const field of section.fields || []) if (field.value !== undefined) defaults[field.key] = String(field.value);
  }
  return defaults;
}

function ensureAdviceModule(id) {
  const module = adviceModule(id);
  if (!module) return false;
  if (!selectedAdviceModules.includes(id)) selectedAdviceModules.push(id);
  adviceModuleData[id] = { ...moduleDefaults(module), ...(adviceModuleData[id] || {}) };
  activeAdviceModuleId = id;
  renderAdviceModules();
  return true;
}

function removeAdviceModule(id) {
  selectedAdviceModules = selectedAdviceModules.filter(moduleId => moduleId !== id);
  if (activeAdviceModuleId === id) activeAdviceModuleId = selectedAdviceModules[0] || '';
  renderAdviceModules();
}

function numeric(value) {
  let normalized = String(value ?? '').replace(/\s/g, '');
  if (normalized.includes(',')) normalized = normalized.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(?:\.\d{3})+$/.test(normalized)) normalized = normalized.replace(/\./g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function euro(value) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Number.isFinite(value) ? value : 0);
}

function euroExact(value) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number.isFinite(value) ? value : 0);
}

function percent(value) {
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 }).format(Number.isFinite(value) ? value : 0) + ' %';
}

function futureValue(initial, monthly, annualRate, years) {
  const months = Math.max(0, Math.round(years * 12));
  const rate = annualRate / 100 / 12;
  if (!months) return initial;
  if (!rate) return initial + monthly * months;
  return initial * Math.pow(1 + rate, months) + monthly * ((Math.pow(1 + rate, months) - 1) / rate);
}

function remainingLoan(principal, annualInterest, annualRepayment, years) {
  const monthlyRate = annualInterest / 100 / 12;
  const payment = principal * ((annualInterest + annualRepayment) / 100) / 12;
  const months = Math.max(0, Math.round(years * 12));
  if (!principal || !months) return { payment, remaining: principal };
  if (!monthlyRate) return { payment, remaining: Math.max(0, principal - payment * months) };
  const remaining = principal * Math.pow(1 + monthlyRate, months) - payment * ((Math.pow(1 + monthlyRate, months) - 1) / monthlyRate);
  return { payment, remaining: Math.max(0, remaining) };
}

function calculateAdvice(module, data) {
  if (module.calculator === 'corporate-benefits') {
    const corporate = calculateCorporateBenefits(data);
    return {
      title: 'Firmenvorsorge-Business-Case · Szenario',
      items: [
        { label: 'Heutige Kostenbasis', value: euro(corporate.baseline.totalAnnual) + ' / Jahr' },
        { label: 'Modelliertes Einsparpotenzial', value: euro(corporate.scenario.potentialSavingsAnnual) + ' / Jahr' },
        { label: 'bKV-Kosten', value: euro(corporate.scenario.bkvCostAnnual) + ' / Jahr' },
        { label: 'bKV + bAV-Arbeitgeberkosten', value: euro(corporate.scenario.totalConceptCostAnnual) + ' / Jahr' },
        { label: 'Szenario-Saldo nach Vorsorgewerk', value: euro(corporate.scenario.netAfterConcept) + ' / Jahr' },
        { label: 'Reinvestierbar nach bKV', value: euro(corporate.scenario.reinvestmentCapacityMonthly) + ' je Person / Monat' },
      ],
      note: corporate.note,
      corporate,
    };
  }
  if (module.calculator === 'financial-summary') {
    const income = numeric(data.monthlyIncome), expenses = numeric(data.monthlyExpenses || data.essentialExpenses);
    return { title: 'Finanzübersicht', items: [{ label: 'Freier Cashflow', value: euro(income - expenses) + ' / Monat' }, { label: 'Nettovermögen', value: euro(numeric(data.assets) - numeric(data.liabilities)) }, { label: 'Liquiditätsreichweite', value: expenses ? `${(numeric(data.liquidAssets || data.liquidityReserve) / expenses).toFixed(1)} Monate` : '–' }] };
  }
  if (module.calculator === 'business-summary') {
    const employees = Math.max(1, numeric(data.employees));
    return { title: 'Unternehmensübersicht', items: [{ label: 'Liquidität abzüglich Schulden', value: euro(numeric(data.liquidity) - numeric(data.liabilities)) }, { label: 'Umsatz je Beschäftigtem', value: euro(numeric(data.annualRevenue) / employees) }, { label: 'Erfasste Schlüsselpersonen', value: data.keyPersons ? 'Ja' : 'Noch offen' }] };
  }
  if (module.calculator === 'retirement-gap') {
    const years = Math.max(0, numeric(data.retirementAge) - numeric(data.currentAge));
    const desiredFuture = numeric(data.desiredNetPension) * Math.pow(1 + numeric(data.inflation) / 100, years);
    const gap = Math.max(0, desiredFuture - numeric(data.expectedPension) - numeric(data.existingPrivatePension));
    const neededCapital = numeric(data.withdrawalRate) ? gap * 12 / (numeric(data.withdrawalRate) / 100) : 0;
    const remainingCapital = Math.max(0, neededCapital - numeric(data.existingCapital));
    const monthly = years ? futureValue(0, 1, numeric(data.returnRate), years) : 0;
    return { title: 'Vorsorgebedarf · Modellrechnung', items: [{ label: 'Projizierter Netto-Wunsch', value: euro(desiredFuture) + ' / Monat' }, { label: 'Versorgungslücke', value: euro(gap) + ' / Monat' }, { label: 'Zusätzliches Kapital', value: euro(remainingCapital) }, { label: 'Erforderliche Sparrate', value: monthly ? euro(remainingCapital / monthly) + ' / Monat' : '–' }], note: 'Vereinfachte Modellrechnung; Steuern, Krankenversicherung, Rentendynamik und konkrete Produktkosten sind noch nicht berücksichtigt.' };
  }
  if (module.calculator === 'depot-comparison') {
    const years = numeric(data.years), months = years * 12, tax = numeric(data.taxRate) / 100;
    const scenario = suffix => {
      const initial = numeric(data['initial' + suffix]), monthly = numeric(data['monthly' + suffix]);
      const gross = futureValue(initial, monthly, numeric(data['return' + suffix]) - numeric(data['cost' + suffix]), years);
      const paid = initial + monthly * months, gain = Math.max(0, gross - paid);
      return Math.max(0, gross - gain * tax);
    };
    return { title: 'Vermögensvergleich · vereinfachte Nettobetrachtung', items: [{ label: data.scenarioAName || 'Variante A', value: euro(scenario('A')) }, { label: data.scenarioBName || 'Variante B', value: euro(scenario('B')) }, { label: 'Differenz', value: euro(Math.abs(scenario('A') - scenario('B'))) }], note: 'Die Steuer wird pauschal auf den modellierten Gewinn angewendet. Produktindividuelle Besteuerung, Teilfreistellung, Versicherungsprivilegien und Abschlusskosten müssen separat ergänzt werden.' };
  }
  if (module.calculator === 'property-financing') {
    const price = numeric(data.purchasePrice), ancillary = price * numeric(data.ancillaryPercent) / 100;
    const loan = Math.max(0, price + ancillary - numeric(data.equity));
    const result = remainingLoan(loan, numeric(data.interestRate), numeric(data.repaymentRate), numeric(data.years));
    const rent = numeric(data.monthlyRent), maintenance = numeric(data.maintenance);
    return { title: 'Immobilienrechnung', items: [{ label: 'Finanzierungsbedarf', value: euro(loan) }, { label: 'Monatliche Annuität', value: euro(result.payment) }, { label: 'Restschuld', value: euro(result.remaining) }, { label: 'Bruttomietrendite', value: price ? percent(rent * 12 / price * 100) : '–' }, { label: 'Monatlicher Cashflow vor Steuer', value: euro(rent - maintenance - result.payment) }] };
  }
  return null;
}

function renderCalculation(root, module, data) {
  const result = calculateAdvice(module, data);
  if (!result) return;
  data.calculation = { ...result, calculatedAt: new Date().toISOString() };
  const card = document.createElement('div'); card.className = 'calc-result';
  const heading = document.createElement('h3'); heading.textContent = result.title; card.appendChild(heading);
  const grid = document.createElement('div'); grid.className = 'calc-grid';
  for (const item of result.items) {
    const value = document.createElement('div'); value.className = 'calc-value';
    const label = document.createElement('span'); label.textContent = item.label;
    const amount = document.createElement('b'); amount.textContent = item.value;
    value.append(label, amount); grid.appendChild(value);
  }
  card.appendChild(grid);
  if (result.corporate) renderCorporateBenefits(card, result.corporate);
  if (result.note) { const note = document.createElement('div'); note.className = 'hint'; note.textContent = result.note; card.appendChild(note); }
  root.appendChild(card);
}

function corporateHeading(text) {
  const heading = document.createElement('h4');
  heading.className = 'corporate-heading';
  heading.textContent = text;
  return heading;
}

function renderCorporateBenefits(card, result) {
  const selectedBkv = result.products?.bkv || {};
  if (selectedBkv.provider || selectedBkv.tariff) {
    const product = document.createElement('div'); product.className = 'corporate-block';
    product.appendChild(corporateHeading('bKV-Tarifvorauswahl · öffentlich recherchiert'));
    const offer = document.createElement('div'); offer.className = 'offer-card';
    const offerHead = document.createElement('div'); offerHead.className = 'offer-head';
    const offerTitle = document.createElement('div');
    const provider = document.createElement('strong'); provider.textContent = selectedBkv.provider || 'Anbieter offen';
    const tariff = document.createElement('span'); tariff.textContent = selectedBkv.tariff || 'Tarif offen';
    offerTitle.append(provider, tariff);
    const price = document.createElement('b');
    price.textContent = selectedBkv.premium > 0 ? `${euroExact(selectedBkv.premium)} / Monat` : 'aktuelles Angebot erforderlich';
    offerHead.append(offerTitle, price); offer.appendChild(offerHead);
    const meta = document.createElement('div'); meta.className = 'offer-meta';
    for (const text of [selectedBkv.budget, selectedBkv.priceDate ? `Preisstand: ${selectedBkv.priceDate}` : '']) {
      if (!text) continue;
      const item = document.createElement('span'); item.textContent = text; meta.appendChild(item);
    }
    offer.appendChild(meta);
    if (selectedBkv.highlights?.length) {
      const highlights = document.createElement('ul'); highlights.className = 'offer-highlights';
      for (const text of selectedBkv.highlights) { const item = document.createElement('li'); item.textContent = text; highlights.appendChild(item); }
      offer.appendChild(highlights);
    }
    if (selectedBkv.sourceUrl) {
      const source = document.createElement('a'); source.className = 'offer-source'; source.href = selectedBkv.sourceUrl;
      source.target = '_blank'; source.rel = 'noopener'; source.textContent = 'Offizielle Produktquelle öffnen ↗'; offer.appendChild(source);
    }
    product.appendChild(offer);
    const disclaimer = document.createElement('div'); disclaimer.className = 'hint';
    disclaimer.textContent = 'Nur Vorbelegung für die Beratung: Beitrag, Kollektivvoraussetzungen, Leistungsumfang und Steuerweg vor Abschluss mit einem aktuellen Angebot bestätigen.';
    product.appendChild(disclaimer); card.appendChild(product);
  }

  const flow = document.createElement('div'); flow.className = 'corporate-block';
  flow.appendChild(corporateHeading('Kosten, Hebel und Finanzierung'));
  const max = Math.max(1, result.baseline.totalAnnual, result.scenario.potentialSavingsAnnual, result.scenario.totalConceptCostAnnual);
  const bars = [
    ['Fehlzeiten', result.baseline.absenceCostAnnual, 'loss'],
    ['Fluktuation', result.baseline.turnoverCostAnnual, 'loss'],
    ['Szenario-Einsparung', result.scenario.potentialSavingsAnnual, 'saving'],
    ['bKV-Kosten', result.scenario.bkvCostAnnual, 'cost'],
    ['bAV-Arbeitgeberkosten', result.scenario.bavEmployerCostAnnual, 'cost'],
    ['Saldo nach Vorsorgewerk', result.scenario.netAfterConcept, result.scenario.netAfterConcept >= 0 ? 'saving' : 'loss'],
  ];
  for (const [labelText, amount, kind] of bars) {
    const row = document.createElement('div'); row.className = 'impact-row';
    const label = document.createElement('span'); label.textContent = labelText;
    const track = document.createElement('div'); track.className = 'impact-track';
    const fill = document.createElement('i'); fill.className = kind; fill.style.width = `${Math.min(100, Math.abs(amount) / max * 100)}%`; track.appendChild(fill);
    const value = document.createElement('b'); value.textContent = euro(amount);
    row.append(label, track, value); flow.appendChild(row);
  }
  const scenarioHint = document.createElement('div'); scenarioHint.className = 'scenario-strip';
  scenarioHint.textContent = `Break-even der bKV allein über Fehlzeiten: ${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 }).format(result.scenario.breakEvenSavedDays)} vermiedene Tage je Person · Modell-ROI des Gesamtpakets: ${percent(result.scenario.roiPercent)}`;
  flow.appendChild(scenarioHint); card.appendChild(flow);

  const pitch = document.createElement('div'); pitch.className = 'corporate-block'; pitch.appendChild(corporateHeading('Gesprächsleitfaden · vertrieblich, aber sauber'));
  const list = document.createElement('ol'); list.className = 'pitch-list';
  for (const text of result.narrative) { const item = document.createElement('li'); item.textContent = text; list.appendChild(item); }
  pitch.appendChild(list); card.appendChild(pitch);

  const rollout = document.createElement('div'); rollout.className = 'corporate-block'; rollout.appendChild(corporateHeading('Umsetzungsprozess · aus den Referenzunterlagen abgeleitet'));
  const rolloutList = document.createElement('ol'); rolloutList.className = 'pitch-list rollout-list';
  for (const text of result.implementationPlaybook || []) { const item = document.createElement('li'); item.textContent = text; rolloutList.appendChild(item); }
  rollout.appendChild(rolloutList);
  const basis = document.createElement('div'); basis.className = 'hint'; basis.textContent = result.documentBasisNote || '';
  rollout.appendChild(basis); card.appendChild(rollout);

  const payroll = document.createElement('div'); payroll.className = 'corporate-block'; payroll.appendChild(corporateHeading('Musterabrechnung · bAV, PKV, Sachbezüge und VL'));
  const payrollTable = document.createElement('div'); payrollTable.className = 'benefit-table';
  const payrollRows = [
    ['Versicherungsstatus', result.payroll.payrollType === 'pkv' ? 'Privat versichert' : 'Gesetzlich versichert'],
    ['Steuerklasse', result.payroll.taxClass || 'nicht erfasst'],
    ['Monatsbrutto Mitarbeitender', euro(result.payroll.grossSalary)],
    ['Geldwerter Vorteil / Sachbezug', '+ ' + euro(result.payroll.nonCashBenefit)],
    ['Weitere steuerpflichtige Bezüge', '+ ' + euro(result.payroll.otherTaxableBenefits)],
    ['bKV als individuell versteuerter Bezug', '+ ' + euro(result.payroll.taxableBkv)],
    ['Entgeltumwandlung', '− ' + euro(result.payroll.employeeDeferral)],
    ['Vereinfachtes Steuer-/SV-Brutto', euro(result.payroll.estimatedTaxableGross)],
    ['PKV-/PV-Beitrag Mitarbeitender', '− ' + euro(result.payroll.employeePkvContribution)],
    ['Arbeitgeberzuschuss PKV/PV', '+ ' + euro(result.payroll.employerPkvSubsidy)],
    ['Vermögenswirksame Leistungen Arbeitgeber', '+ ' + euro(result.payroll.employerVl)],
    ['Vermögenswirksame Leistungen Mitarbeitender', '− ' + euro(result.payroll.employeeVl)],
    [`Arbeitgeberzuschuss (${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(result.payroll.employerSubsidyPercent)} %)`, '+ ' + euro(result.payroll.employerSubsidyMonthly)],
    ['Zusätzlicher Arbeitgeberbeitrag', '+ ' + euro(result.payroll.extraEmployerBav)],
    ['Gesamtbeitrag in die Versorgung', euro(result.payroll.insuranceContributionMonthly)],
    ['Gesamter Arbeitgeberaufwand Benefits / Monat', euro(result.payroll.employerBenefitSpendMonthly)],
    ['Referenz-Netto laut Unternehmensabrechnung', result.payroll.referenceNetPay ? euro(result.payroll.referenceNetPay) : 'nicht hinterlegt'],
    [`Geschätzter Nettoaufwand (${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(result.payroll.estimatedNetImpactPercent)} % Planfaktor)`, 'ca. ' + euro(result.payroll.estimatedEmployeeNetImpact)],
  ];
  for (const [labelText, valueText] of payrollRows) {
    const row = document.createElement('div'); row.className = 'benefit-row compact';
    const label = document.createElement('span'); label.textContent = labelText;
    const value = document.createElement('b'); value.textContent = valueText;
    row.append(label, value); payrollTable.appendChild(row);
  }
  payroll.appendChild(payrollTable);
  const payrollHint = document.createElement('div'); payrollHint.className = 'hint'; payrollHint.textContent = 'Keine echte Entgeltabrechnung: Steuerklasse und einzelne Lohnbestandteile können erfasst werden, die exakte Berechnung von Lohnsteuer, Kirchensteuer, Beitragsbemessungsgrenzen, Sozialversicherung und PKV-Zuschuss bleibt aber Sache der Lohnabrechnung. Eine Unternehmens-Musterabrechnung kann unten als PDF oder Bild zur Akte geladen werden.';
  payroll.appendChild(payrollHint); card.appendChild(payroll);

  const comparison = document.createElement('div'); comparison.className = 'corporate-block'; comparison.appendChild(corporateHeading('Benefit-Vergleich · Kosten, Steuer, Nutzen'));
  const comparisonTable = document.createElement('div'); comparisonTable.className = 'benefit-table';
  const head = document.createElement('div'); head.className = 'benefit-row head';
  for (const text of ['Benefit', 'Kosten / Monat', 'Arbeitgeber / Jahr', 'Steuerlicher Aspekt', 'Nutzen']) { const cell = document.createElement('b'); cell.textContent = text; head.appendChild(cell); }
  comparisonTable.appendChild(head);
  for (const benefit of result.benefitComparison) {
    const row = document.createElement('div'); row.className = 'benefit-row' + (benefit.featured ? ' featured' : '');
    for (const text of [benefit.label, euro(benefit.monthlyPerEmployee), euro(benefit.annualEmployerCost), benefit.tax, benefit.use]) {
      const cell = document.createElement('span'); cell.textContent = text; row.appendChild(cell);
    }
    comparisonTable.appendChild(row);
  }
  comparison.appendChild(comparisonTable); card.appendChild(comparison);

  const ranking = document.createElement('div'); ranking.className = 'corporate-block'; ranking.appendChild(corporateHeading('Benefit-Ranking bei der Arbeitgeberwahl'));
  const rankingCopy = document.createElement('p'); rankingCopy.className = 'hint'; rankingCopy.textContent = 'Anteil „extrem stark“, „sehr stark“ oder „ziemlich stark“ darauf achtend. ARAG-/YouGov-Studie 2024, Arbeitnehmer n=1.047.'; ranking.appendChild(rankingCopy);
  for (const entry of result.preferenceRanking) {
    const row = document.createElement('div'); row.className = 'ranking-row' + (entry.featured ? ' featured' : '');
    const label = document.createElement('span'); label.textContent = entry.label;
    const track = document.createElement('div'); track.className = 'ranking-track';
    const fill = document.createElement('i'); fill.style.width = `${entry.value}%`; track.appendChild(fill);
    const value = document.createElement('b'); value.textContent = `${entry.value} %`;
    row.append(label, track, value); ranking.appendChild(row);
  }
  const stats = document.createElement('div'); stats.className = 'study-stats';
  for (const [valueText, copy] of [['80 %', 'finden wichtig, dass der Arbeitgeber etwas für Gesundheit tut (ARAG/YouGov 2024).'], ['45 %', 'bewerten bKV höher als andere Firmen-Extras (PKV/Civey 2026).'], ['25 %', 'bewerten bKV höher als eine Gehaltserhöhung (PKV/Civey 2026).']]) {
    const stat = document.createElement('div'); const value = document.createElement('b'); value.textContent = valueText; const text = document.createElement('span'); text.textContent = copy; stat.append(value, text); stats.appendChild(stat);
  }
  ranking.appendChild(stats); card.appendChild(ranking);

  const sources = document.createElement('div'); sources.className = 'corporate-block'; sources.appendChild(corporateHeading('Quellen & Prüfbasis'));
  const sourceList = document.createElement('div'); sourceList.className = 'source-list';
  for (const source of result.sources) {
    const link = document.createElement(source.url ? 'a' : 'div');
    if (source.url) { link.href = source.url; link.target = '_blank'; link.rel = 'noopener'; }
    else link.className = 'source-item';
    const title = document.createElement('b'); title.textContent = `${source.title} · ${source.year}`;
    const detail = document.createElement('span'); detail.textContent = source.scope;
    link.append(title, detail);
    if (source.providedFile) { const file = document.createElement('span'); file.className = 'source-file'; file.textContent = `Bereitgestellte Datei: ${source.providedFile}`; link.appendChild(file); }
    sourceList.appendChild(link);
  }
  sources.appendChild(sourceList); card.appendChild(sources);
}

function refreshAdviceCalculation(moduleId) {
  const module = adviceModule(moduleId);
  const root = $('adviceSpecific');
  root.querySelector('.calc-result')?.remove();
  if (module) renderCalculation(root, module, adviceModuleData[moduleId] || {});
}

async function searchModuleKnowledge(module, root) {
  const data = adviceModuleData[module.id] || {};
  const queries = [
    { side: 'Altvertrag', query: [data.oldCompany, data.oldTariff, data.oldYear].filter(Boolean).join(' ') },
    { side: 'Neuvertrag', query: [data.newCompany, data.newTariff, data.newYear].filter(Boolean).join(' ') },
  ].filter(item => item.query);
  const hits = root.querySelector('.knowledge-hits');
  if (!queries.length) {
    hits.innerHTML = '<div class="muted">Bitte zuerst Gesellschaft, Tarif oder Tarifstand des Alt- beziehungsweise Neuvertrags eingeben.</div>';
    return;
  }
  hits.innerHTML = '<div class="muted">Quellen werden durchsucht …</div>';
  try {
    const results = await Promise.all(queries.map(async item => ({
      ...item,
      result: await api('/api/advice/knowledge?limit=30&search=' + encodeURIComponent(item.query)),
    })));
    hits.innerHTML = '';
    let hitCount = 0;
    for (const { side, result } of results) {
      for (const source of result.sources || []) {
        hitCount += 1;
        const row = document.createElement('div'); row.className = 'knowledge-hit';
        const title = document.createElement('b'); title.textContent = `${side} · ${source.title}`;
        const detail = document.createElement('small'); detail.textContent = [source.provider, source.tariff, source.year, source.scope].filter(Boolean).join(' · ');
        const link = document.createElement('a'); link.href = source.url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Originalquelle öffnen ↗'; link.className = 'linkbtn';
        row.append(title, detail, link); hits.appendChild(row);
      }
    }
    if (!hitCount) hits.innerHTML = '<div class="muted">Keine belastbare Originalquelle gefunden. Bitte Versicherungsbedingungen oder Produktinformationsblatt unten als Dokument hochladen.</div>';
  } catch (error) { hits.innerHTML = '<div class="muted">Wissenssuche fehlgeschlagen: ' + error.message + '</div>'; }
}

function createAdviceField(moduleId, spec, data, moduleRoot) {
  const wrap = document.createElement('div'); wrap.className = 'advice-field' + (spec.wide ? ' wide' : '');
  const label = document.createElement('label'); label.textContent = spec.label;
  if (spec.unit) { const unit = document.createElement('em'); unit.textContent = spec.unit; label.appendChild(unit); }
  let input;
  if (spec.type === 'textarea') input = document.createElement('textarea');
  else if (spec.type === 'select') {
    input = document.createElement('select');
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'bitte wählen'; input.appendChild(empty);
    const offer = spec.key === 'bkvBudgetLevel' ? findBkvOffer(data.bkvOfferId) : null;
    const options = offer ? offer.budgets.map(item => ({ value: String(item.annual), label: `${new Intl.NumberFormat('de-DE').format(item.annual)} € Jahresbudget${Number.isFinite(item.monthly) ? ` · ${euroExact(item.monthly)} / Monat` : ' · Preis anfragen'}` })) : (spec.options || []);
    for (const entry of options) {
      const option = document.createElement('option');
      option.value = typeof entry === 'object' ? entry.value : entry;
      option.textContent = typeof entry === 'object' ? entry.label : entry;
      input.appendChild(option);
    }
  } else {
    input = document.createElement('input'); input.type = spec.type === 'text' ? 'text' : 'text';
    if (spec.type !== 'text') input.inputMode = 'decimal';
  }
  input.dataset.adviceKey = spec.key;
  input.value = data[spec.key] ?? spec.value ?? '';
  if (spec.placeholder) input.placeholder = spec.placeholder;
  input.addEventListener('input', () => {
    data[spec.key] = input.value;
    if (moduleId === 'corporate-benefits' && ['bkvOfferId', 'bkvBudgetLevel'].includes(spec.key)) {
      applyBkvOfferSelection(data, spec.key);
      renderAdviceActiveModule();
      return;
    }
    refreshAdviceCalculation(moduleId);
  });
  wrap.append(label, input); return wrap;
}

function renderAdviceActiveModule() {
  const root = $('adviceSpecific'); root.innerHTML = '';
  const module = adviceModule(activeAdviceModuleId);
  $('adviceModuleNotice').hidden = !module?.notice;
  $('adviceModuleNotice').textContent = module?.notice || '';
  if (!module) {
    root.innerHTML = '<div class="module"><strong>Noch kein Fachmodul ausgewählt</strong><p>Wähle oben ein Modul. In dieser Beratungsakte kannst du anschließend weitere Module ergänzen.</p><span class="module-state">Gemeinsame Kunden- und Dokumentenakte ist bereit</span></div>';
    return;
  }
  const data = adviceModuleData[module.id] || (adviceModuleData[module.id] = moduleDefaults(module));
  for (const section of module.sections || []) {
    const card = document.createElement('section'); card.className = 'advice-section';
    const heading = document.createElement('h3'); heading.textContent = section.title; card.appendChild(heading);
    const fields = document.createElement('div'); fields.className = 'advice-fields';
    for (const spec of section.fields || []) fields.appendChild(createAdviceField(module.id, spec, data, root));
    card.appendChild(fields); root.appendChild(card);
  }
  renderCalculation(root, module, data);
  if (module.knowledgeSearch) {
    const card = document.createElement('section'); card.className = 'advice-section';
    card.innerHTML = '<h3>Originalquellen für den Vergleich</h3><div class="hint">IVA sucht nach Gesellschaft, Tarif und Tarifstand. Ohne Originalquelle wird keine Leistungsaussage erzeugt.</div><div style="height:9px"></div><div class="knowledge-hits"></div>';
    const button = document.createElement('button'); button.className = 'btn'; button.type = 'button'; button.textContent = 'Wissensdatenbank durchsuchen';
    button.addEventListener('click', () => searchModuleKnowledge(module, card)); card.insertBefore(button, card.querySelector('.knowledge-hits'));
    root.appendChild(card);
  }
  if (module.id === 'gkv-comparison') {
    const gkv = adviceCatalog.connectors?.gkv || {};
    const card = document.createElement('section'); card.className = 'advice-section';
    card.innerHTML = `<h3>${gkv.configured ? (gkv.provider || 'GKV-Portal') + ' verbunden' : 'GKV-Portal noch nicht verbunden'}</h3><div class="hint">${gkv.configured ? 'Kundendaten bleiben in der Beratungsakte; der eigentliche Tarifvergleich öffnet sich im angebundenen Portal.' : 'Das Datenmodell ist vorbereitet. Später werden nur Anbieter und Start-/API-URL ergänzt.'}</div>`;
    if (gkv.configured) { const link = document.createElement('a'); link.className = 'btn'; link.textContent = 'Vergleich öffnen'; link.href = gkv.launchUrl; link.target = '_blank'; link.rel = 'noopener'; card.appendChild(link); }
    root.appendChild(card);
  }
  if (module.id === 'energy-tariff-comparison') {
    const connector = adviceCatalog.connectors?.energyTariffs || {};
    const card = document.createElement('section'); card.className = 'advice-section';
    const heading = document.createElement('h3'); heading.textContent = `${connector.provider || 'EnergyPartner24'} · Strom & Gas`;
    const hint = document.createElement('div'); hint.className = 'hint'; hint.textContent = connector.reason || 'Die Tarifanfrage wird vorbereitet und in dieser Beratungsakte gespeichert.';
    const result = document.createElement('div'); result.className = 'muted'; result.style.marginTop = '9px';
    const lastRequest = Array.isArray(current?.data?.tariffRequests) ? current.data.tariffRequests.at(-1) : null;
    if (lastRequest) result.textContent = lastRequest.missing?.length
      ? `Letzte Anfrage unvollständig · offen: ${lastRequest.missing.join(', ')}`
      : 'Letzte Tarifanfrage wurde vorbereitet und in dieser Akte gespeichert.';
    const prepare = document.createElement('button'); prepare.className = 'btn primary'; prepare.type = 'button'; prepare.textContent = 'Tarifanfrage vorbereiten';
    prepare.addEventListener('click', async () => {
      try {
        await save();
        const response = await api(`/api/workspaces/${current.id}/energy/tariffs/prepare`, {
          method: 'POST', body: JSON.stringify({
            commodity: data.commodity,
            annualConsumptionKwh: numeric(data.annualConsumptionKwh),
            postalCode: data.postalCode,
            city: data.city,
            meterType: data.meterType,
            currentSupplier: data.currentSupplier,
            currentTariff: data.currentTariff,
            desiredStartDate: data.desiredStartDate,
            notes: data.notes,
          }),
        });
        current = response.workspace;
        const missing = response.request?.missing || [];
        apply(current);
        status(missing.length ? 'Tarifanfrage gespeichert · Angaben fehlen noch.' : 'Tarifanfrage vorbereitet.', missing.length ? '' : 'ok');
      } catch (error) {
        result.textContent = 'Vorbereitung fehlgeschlagen: ' + error.message;
        status('Tarifanfrage fehlgeschlagen: ' + error.message, 'err');
      }
    });
    card.append(heading, hint, prepare);
    if (connector.launchUrl) {
      const open = document.createElement('a'); open.className = 'btn'; open.textContent = 'EnergyPartner öffnen'; open.style.marginLeft = '8px';
      open.href = connector.launchUrl; open.target = '_blank'; open.rel = 'noopener';
      card.appendChild(open);
    }
    card.appendChild(result); root.appendChild(card);
  }
}

function renderAdviceModules() {
  const root = $('adviceModulePills'); root.innerHTML = '';
  for (const id of selectedAdviceModules) {
    const module = adviceModule(id); if (!module) continue;
    const button = document.createElement('button'); button.className = 'module-pill' + (activeAdviceModuleId === id ? ' active' : '');
    button.type = 'button'; button.append(document.createTextNode(module.title));
    const remove = document.createElement('span'); remove.className = 'remove'; remove.textContent = '×'; remove.title = 'Modul entfernen';
    remove.addEventListener('click', event => { event.stopPropagation(); removeAdviceModule(id); }); button.appendChild(remove);
    button.addEventListener('click', () => { activeAdviceModuleId = id; renderAdviceModules(); }); root.appendChild(button);
  }
  renderAdviceActiveModule();
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
  if (nextMode === 'kunde') {
    location.href = '/customers';
    return;
  }
  mode = nextMode;
  current = null;
  rooms = [];
  photoAssignments = [];
  selectedAdviceModules = [];
  adviceModuleData = {};
  activeAdviceModuleId = '';
  history.replaceState({}, '', location.pathname + '?mode=' + mode);
  document.querySelectorAll('input:not([type=file]),textarea').forEach(input => {
    if (input.type === 'checkbox') input.checked = false;
    else input.value = '';
  });
  document.querySelectorAll('select').forEach(select => { select.selectedIndex = 0; });
  setVal('consumptionUnit', 'kWh');
  setVal('upgradeNeeded', 'unknown');
  setVal('fundingApplicantType', 'private-owner');
  renderHeatLoadResult(null);
  renderFundingResult(null);
  $('pageTitle').textContent = ({ beratung: 'Neue Beratung', kunde: 'Neue Kundenakte', energie: 'Neue Energieplanung' })[mode];
  $('statusBadge').textContent = 'Entwurf';
  if (params.get('customerName')) {
    setVal('customerName', params.get('customerName'));
    setVal('customerAddress', params.get('customerAddress'));
    setVal('customerEmail', params.get('customerEmail'));
    setVal('customerPhone', params.get('customerPhone'));
  }
  if (mode === 'beratung') {
    const requestedModule = params.get('adviceType');
    if (requestedModule) ensureAdviceModule(requestedModule);
    else renderAdviceModules();
    const selected = adviceModule(requestedModule);
    if (selected) {
      setVal('topic', selected.title);
      if (!val('title')) setVal('title', `${params.get('customerName') || 'Neue Beratung'} · ${selected.title}`);
      $('pageTitle').textContent = selected.title;
    }
  }
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
      designOutdoorTemperature: val('designOutdoorTemperature'), thermalBridgePercent: val('thermalBridgePercent'),
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
    funding: {
      applicantType: val('fundingApplicantType') || 'private-owner', selfUsed: checked('fundingSelfUsed'),
      existingBuildingAgeYears: val('existingBuildingAgeYears'), projectCosts: val('fundingProjectCosts'),
      householdIncome: val('householdIncome'), eligibleMinorChild: checked('eligibleMinorChild'),
      climateBonusEligible: checked('climateBonusEligible'), contractConditional: checked('contractConditional'),
      applicationBeforeStart: checked('applicationBeforeStart'), hydraulicBalancingPlanned: checked('hydraulicBalancingPlanned'),
      result: current?.data?.funding?.result || null,
    },
    declaration: {
      reviewed: checked('reviewed'), reviewedBy: val('reviewedBy'), reviewedAt: val('reviewedAt'), notes: val('declarationNotes'),
    },
  };
}

function collect() {
  const data = mode === 'energie'
    ? collectEnergyData()
    : mode === 'beratung'
      ? { schemaVersion: 'iva-advice-1.0', appointmentAt: val('appointmentAt'), topic: val('topic'), goal: val('goal'), facts: val('facts'), recommendation: val('recommendation'), adviceModules: selectedAdviceModules, activeAdviceModule: activeAdviceModuleId, moduleData: adviceModuleData }
      : { project: val('project'), company: val('company'), relationship: val('relationship'), nextStep: val('nextStep') };
  return {
    mode,
    title: val('title'),
    customer: { id: current?.customer?.id || params.get('customerId') || '', name: val('customerName'), address: val('customerAddress'), email: val('customerEmail'), phone: val('customerPhone') },
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

function calcValue(label, value) {
  const box = document.createElement('div'); box.className = 'calc-value';
  const name = document.createElement('span'); const content = document.createElement('b');
  name.textContent = label; content.textContent = value; box.append(name, content); return box;
}

function renderHeatLoadResult(result = null) {
  const root = $('heatLoadResult'); if (!root) return;
  root.replaceChildren();
  const heading = document.createElement('h3');
  if (!result || result.status === 'not-started') {
    heading.textContent = 'Noch nicht berechnet';
    const note = document.createElement('div'); note.className = 'muted'; note.textContent = 'Fehlende Pflichtangaben werden nach dem Start konkret angezeigt.';
    root.append(heading, note); return;
  }
  if (result.status === 'data-required') {
    heading.textContent = `${result.missing?.length || 0} Angaben fehlen`;
    const list = document.createElement('div'); list.className = 'knowledge-hits';
    for (const item of (result.missing || []).slice(0, 14)) { const line = document.createElement('div'); line.className = 'knowledge-hit'; line.textContent = item.label; list.appendChild(line); }
    const note = document.createElement('div'); note.className = 'hint'; note.textContent = result.notice || '';
    root.append(heading, list, note); return;
  }
  heading.textContent = 'Heizlast-Vorplanung berechnet';
  const grid = document.createElement('div'); grid.className = 'calc-grid';
  grid.append(calcValue('Gesamt', `${Number(result.totalKw || 0).toLocaleString('de-DE')} kW`), calcValue('Räume', String(result.rooms?.length || 0)), calcValue('Status', 'Vorplanung, nicht DIN-Nachweis'));
  const note = document.createElement('div'); note.className = 'hint'; note.textContent = result.notice || '';
  root.append(heading, grid, note);
}

function renderFundingResult(result = null) {
  const root = $('fundingResult'); if (!root) return;
  root.replaceChildren();
  const heading = document.createElement('h3');
  if (!result) {
    heading.textContent = 'Noch nicht berechnet';
    const note = document.createElement('div'); note.className = 'muted'; note.textContent = 'Der Check ist keine Förderzusage und zeigt offene Voraussetzungen separat.';
    root.append(heading, note); return;
  }
  heading.textContent = result.status === 'precheck-positive' ? 'Förder-Vorcheck vollständig' : 'Förder-Vorcheck mit offenen Punkten';
  const euro = value => Number(value || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const grid = document.createElement('div'); grid.className = 'calc-grid';
  grid.append(calcValue('Fördersatz', `${result.rate || 0} %`), calcValue('Förderfähige Kosten', euro(result.eligibleCosts)), calcValue('Rechnerischer Zuschuss', euro(result.estimatedGrant)));
  root.append(heading, grid);
  if (result.blockers?.length) {
    const list = document.createElement('div'); list.className = 'knowledge-hits'; list.style.marginTop = '10px';
    for (const blocker of result.blockers) { const line = document.createElement('div'); line.className = 'knowledge-hit'; line.textContent = blocker; list.appendChild(line); }
    root.appendChild(list);
  }
  const note = document.createElement('div'); note.className = 'hint'; note.textContent = `${result.notice || ''} Regelstand: ${result.rulesAsOf || 'unbekannt'}.`;
  root.appendChild(note);
}

async function calculateEnergy() {
  try {
    status('Energiedaten werden gespeichert und geprüft ...');
    await save();
    const response = await api(`/api/workspaces/${current.id}/energy/calculate`, { method: 'POST', body: JSON.stringify({}) });
    current = response.workspace; apply(current);
    const missing = response.calculation?.missing?.length || 0;
    status(missing ? `Berechnung geprüft · ${missing} Angaben fehlen noch.` : 'Heizlast-Vorplanung und Fördercheck wurden berechnet.', missing ? '' : 'ok');
  } catch (error) { status('Rechenfehler: ' + error.message, 'err'); }
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
  const funding = data.funding || {};
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
    designOutdoorTemperature: building.designOutdoorTemperature, thermalBridgePercent: building.thermalBridgePercent,
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
    fundingApplicantType: funding.applicantType || 'private-owner', existingBuildingAgeYears: funding.existingBuildingAgeYears,
    fundingProjectCosts: funding.projectCosts, householdIncome: funding.householdIncome,
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
  setChecked('fundingSelfUsed', funding.selfUsed);
  setChecked('eligibleMinorChild', funding.eligibleMinorChild);
  setChecked('climateBonusEligible', funding.climateBonusEligible);
  setChecked('contractConditional', funding.contractConditional);
  setChecked('applicationBeforeStart', funding.applicationBeforeStart);
  setChecked('hydraulicBalancingPlanned', funding.hydraulicBalancingPlanned);
  renderHeatLoadResult(data.calculation);
  renderFundingResult(funding.result);
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
    selectedAdviceModules = Array.isArray(workspace.data?.adviceModules) ? workspace.data.adviceModules.filter(id => adviceModule(id)) : [];
    adviceModuleData = workspace.data?.moduleData && typeof workspace.data.moduleData === 'object' ? workspace.data.moduleData : {};
    activeAdviceModuleId = adviceModule(workspace.data?.activeAdviceModule) ? workspace.data.activeAdviceModule : (selectedAdviceModules[0] || '');
    setVal('appointmentAt', workspace.data?.appointmentAt); setVal('topic', workspace.data?.topic); setVal('goal', workspace.data?.goal);
    setVal('facts', workspace.data?.facts); setVal('recommendation', workspace.data?.recommendation);
    renderAdviceModules();
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
    const heatLoadTitle = document.createElement('strong');
    heatLoadTitle.textContent = 'Heizlast-Eingaben';
    heatLoadTitle.style.display = 'block';
    heatLoadTitle.style.marginTop = '14px';
    const heatLoadFields = document.createElement('div');
    heatLoadFields.className = 'room-fields';
    heatLoadFields.style.marginTop = '8px';
    const heatLoadSpecs = [
      ['Solltemperatur °C', 'targetTemperature'], ['Luftwechsel 1/h', 'airChanges'],
      ['Außenwand m²', 'externalWallArea'], ['U-Wert Außenwand', 'externalWallUValue'],
      ['Fenster m²', 'windowArea'], ['U-Wert Fenster', 'windowUValue'],
      ['Decke/Dach m²', 'ceilingArea'], ['U-Wert Decke/Dach', 'ceilingUValue'],
      ['Boden/Kellerdecke m²', 'floorArea'], ['U-Wert Boden', 'floorUValue'],
    ];
    for (const [label, key] of heatLoadSpecs) {
      const direct = key === 'targetTemperature' || key === 'airChanges';
      const source = direct ? room : room.envelope;
      heatLoadFields.appendChild(fieldElement(label, source[key], value => { source[key] = value; }));
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
    card.append(head, roomFields, heatLoadTitle, heatLoadFields, radiatorList);
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
  return ({ floorplan: 'Grundriss', elevation: 'Seitenansicht', photo: 'Foto', 'tmb-template': 'TMB-Referenz', document: 'Dokument', 'payroll-sample': 'Musterabrechnung', audio: 'Audio' })[kind] || kind;
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

function reportBar(parent, label, value) {
  const row = document.createElement('div'); row.className = 'print-bar-row';
  const name = document.createElement('b'); name.textContent = label;
  const track = document.createElement('div'); track.className = 'print-bar-track';
  const fill = document.createElement('i'); fill.style.width = `${Math.min(100, Math.max(0, Number(value) || 0))}%`; track.appendChild(fill);
  const amount = document.createElement('span'); amount.textContent = `${value} %`;
  row.append(name, track, amount); parent.appendChild(row);
}

function reportSubheading(parent, text) {
  const heading = document.createElement('h3'); heading.className = 'print-subheading'; heading.textContent = text; parent.appendChild(heading);
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
  if (mode === 'beratung') {
    for (const moduleId of collected.data.adviceModules || []) {
      const module = adviceModule(moduleId); const data = collected.data.moduleData?.[moduleId] || {};
      if (!module) continue;
      reportSection(root, module.title, section => {
        for (const moduleSection of module.sections || []) for (const spec of moduleSection.fields || []) reportRow(section, spec.label, data[spec.key]);
        const calculation = calculateAdvice(module, data);
        for (const item of calculation?.items || []) reportRow(section, item.label, item.value);
        if (calculation?.corporate) {
          const corporate = calculation.corporate;
          reportSubheading(section, 'bKV-Tarifvorauswahl');
          reportRow(section, 'Anbieter / Tarif', [corporate.products?.bkv?.provider, corporate.products?.bkv?.tariff].filter(Boolean).join(' · ') || 'nicht ausgewählt');
          reportRow(section, 'Budget', corporate.products?.bkv?.budget);
          reportRow(section, 'Öffentlicher Monatsbeitrag', corporate.products?.bkv?.premium ? euroExact(corporate.products.bkv.premium) : 'aktuelles Angebot erforderlich');
          reportRow(section, 'Preisstand', corporate.products?.bkv?.priceDate);
          reportRow(section, 'Offizielle Produktquelle', corporate.products?.bkv?.sourceUrl);
          reportSubheading(section, 'Finanzierungslogik');
          reportRow(section, 'Fehlzeitenkosten', euro(corporate.baseline.absenceCostAnnual));
          reportRow(section, 'Fluktuationskosten', euro(corporate.baseline.turnoverCostAnnual));
          reportRow(section, 'Modellierte Fehlzeitenersparnis', euro(corporate.scenario.absenceSavingsAnnual));
          reportRow(section, 'Modellierte Fluktuationsersparnis', euro(corporate.scenario.turnoverSavingsAnnual));
          reportRow(section, 'Break-even bKV', `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 }).format(corporate.scenario.breakEvenSavedDays)} vermiedene Krankheitstage je Person`);
          reportSubheading(section, 'Musterabrechnung · bAV, PKV, Sachbezüge und VL');
          reportRow(section, 'Versicherungsstatus', corporate.payroll.payrollType === 'pkv' ? 'PKV' : 'GKV');
          reportRow(section, 'Steuerklasse', corporate.payroll.taxClass);
          reportRow(section, 'Monatsbrutto', euro(corporate.payroll.grossSalary));
          reportRow(section, 'Geldwerter Vorteil / Sachbezug', euro(corporate.payroll.nonCashBenefit));
          reportRow(section, 'Weitere steuerpflichtige Bezüge', euro(corporate.payroll.otherTaxableBenefits));
          reportRow(section, 'Individuell versteuerte bKV', euro(corporate.payroll.taxableBkv));
          reportRow(section, 'Entgeltumwandlung', euro(corporate.payroll.employeeDeferral));
          reportRow(section, 'Vereinfachtes Steuer-/SV-Brutto', euro(corporate.payroll.estimatedTaxableGross));
          reportRow(section, 'PKV-/PV-Beitrag Mitarbeitender', euro(corporate.payroll.employeePkvContribution));
          reportRow(section, 'Arbeitgeberzuschuss PKV/PV', euro(corporate.payroll.employerPkvSubsidy));
          reportRow(section, 'VL Arbeitgeber', euro(corporate.payroll.employerVl));
          reportRow(section, 'VL Mitarbeitender', euro(corporate.payroll.employeeVl));
          reportRow(section, 'Arbeitgeberzuschuss', euro(corporate.payroll.employerSubsidyMonthly));
          reportRow(section, 'Zusätzlicher Arbeitgeberbeitrag', euro(corporate.payroll.extraEmployerBav));
          reportRow(section, 'Gesamtbeitrag Versorgung', euro(corporate.payroll.insuranceContributionMonthly));
          reportRow(section, 'Arbeitgeberaufwand Benefits / Monat', euro(corporate.payroll.employerBenefitSpendMonthly));
          reportRow(section, 'Referenz-Netto Unternehmensabrechnung', corporate.payroll.referenceNetPay ? euro(corporate.payroll.referenceNetPay) : 'nicht hinterlegt');
          reportRow(section, 'Geschätzter Nettoaufwand', euro(corporate.payroll.estimatedEmployeeNetImpact));
          reportSubheading(section, 'Umsetzungsprozess');
          for (const [index, step] of (corporate.implementationPlaybook || []).entries()) reportRow(section, `Schritt ${index + 1}`, step);
          reportRow(section, 'Einordnung der Referenzunterlagen', corporate.documentBasisNote);
          reportSubheading(section, 'Benefit-Ranking bei der Arbeitgeberwahl');
          for (const entry of corporate.preferenceRanking) reportBar(section, entry.label, entry.value);
          reportSubheading(section, 'Verwendete Quellen');
          for (const source of corporate.sources) reportRow(section, `${source.publisher} · ${source.year}`, source.url ? `${source.title} · ${source.url}` : `${source.title} · bereitgestellte PDF: ${source.providedFile || 'lokale Datei'}`);
        }
        if (calculation?.note) reportRow(section, 'Hinweis zur Modellrechnung', calculation.note);
        if (module.notice) reportRow(section, 'Fachlicher Hinweis', module.notice);
      });
    }
  }
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
$('calculateEnergyBtn').addEventListener('click', calculateEnergy);
$('addRoomBtn').addEventListener('click', addRoom);
$('addNoteBtn').addEventListener('click', addNote);
$('addAdviceModule').addEventListener('click', () => {
  const id = val('adviceModuleSelect');
  if (id) { ensureAdviceModule(id); $('adviceModuleSelect').value = ''; }
});
$('addGeneralPhotoBtn').addEventListener('click', () => { pendingPhotoCategory = 'sonstiges'; $('photoInput').click(); });
document.querySelectorAll('[data-new]').forEach(button => button.addEventListener('click', () => {
  if (button.dataset.new === 'beratung') location.href = '/advice';
  else fresh(button.dataset.new);
}));
document.querySelectorAll('input[type=file][data-kind]').forEach(input => input.addEventListener('change', () => upload(input)));
document.querySelectorAll('[data-trigger]').forEach(button => button.addEventListener('click', () => $(button.dataset.trigger).click()));
document.querySelectorAll('input:not([type=file]),select,textarea').forEach(input => input.addEventListener('input', () => { updateCompletion(); renderPhotoChecklist(); }));
window.addEventListener('beforeprint', () => { if (mode !== 'energie') buildSimpleReport(); });
$('ivaHelper').addEventListener('click', () => window.open('/cockpit', '_blank', 'noopener'));

async function initWorkspace() {
  await loadAdviceCatalog();
  showMode();
  await loadList();
  const id = params.get('id');
  if (id) loadOne(id);
  else fresh(mode);
}

initWorkspace();
