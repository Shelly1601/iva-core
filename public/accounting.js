const $ = id => document.getElementById(id);
const state = { summary: null, entities: [], categories: [], documents: [], current: null };
const categoryLabels = {
  arbeitsmittel: 'Arbeitsmittel', software: 'Software & KI', telekommunikation: 'Telefon & Internet', marketing: 'Marketing',
  fortbildung: 'Fortbildung', versicherung: 'Versicherungen', 'bank-steuerberatung': 'Bank & Steuerberatung', fremdleistung: 'Fremdleistungen',
  reise: 'Reise', bewirtung: 'Bewirtung', geschenk: 'Geschenke', buero: 'Büro & Coworking', fahrzeug: 'Fahrzeug', sonstiges: 'Sonstiges', privat: 'Privat / nicht buchen',
};

function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function authHeaders(extra = {}) { return { Authorization: 'Bearer ' + (localStorage.getItem('iva_token') || ''), ...extra }; }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...authHeaders({ 'Content-Type': 'application/json' }), ...(options.headers || {}) } });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(json?.error || `HTTP ${response.status}`);
  return json;
}
function euro(value) { return Number(value || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }); }
function month() { return $('month').value || new Date().toISOString().slice(0, 7); }
function entityName(id) { return state.entities.find(item => item.id === id)?.name || 'Nicht zugeordnet'; }
function setBusy(button, busy, label = 'bitte warten …') { if (!button.dataset.label) button.dataset.label = button.textContent; button.disabled = busy; button.textContent = busy ? label : button.dataset.label; }

function entityOptions(includeAll = false) {
  const first = includeAll ? '<option value="">Alle Firmen</option>' : '<option value="">Noch nicht zugeordnet</option>';
  return first + state.entities.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
}

function renderSummary() {
  const summary = state.summary || { counts: {}, totals: {}, completeness: 0 };
  const items = [
    ['Belege', summary.counts?.all || 0], ['Vollständig', summary.counts?.ready || 0], ['Noch klären', summary.counts?.review || 0],
    ['Gesperrt', summary.counts?.blocked || 0], ['Erfasst', euro(summary.totals?.gross || 0)],
  ];
  $('metrics').innerHTML = items.map(([label, value]) => `<div class="metric"><b>${esc(value)}</b><small>${esc(label)}</small></div>`).join('');
}

function renderEntities() {
  const uploadValue = $('uploadEntity').value;
  const filterValue = $('entityFilter').value;
  $('uploadEntity').innerHTML = entityOptions(false);
  $('detailEntity').innerHTML = entityOptions(false);
  $('entityFilter').innerHTML = entityOptions(true);
  if (state.entities.some(item => item.id === uploadValue)) $('uploadEntity').value = uploadValue;
  if (state.entities.some(item => item.id === filterValue)) $('entityFilter').value = filterValue;
  $('entities').innerHTML = state.entities.length ? state.entities.map(item => `<div class="entity"><div><b>${esc(item.name)}</b><small>${esc(item.taxMode === 'euer' ? 'EÜR' : item.taxMode === 'bilanz' ? 'Bilanz' : 'Gewinnermittlung offen')}</small></div><small>${esc(item.vatStatus === 'regular' ? 'regelbesteuert' : item.vatStatus === 'small-business' ? 'Kleinunternehmer' : item.vatStatus === 'exempt' ? 'steuerbefreit' : 'USt offen')}</small></div>`).join('') : '<div class="empty">Lege zuerst deine Firma beziehungsweise den Rechtsträger an.</div>';
}

function renderCategories() {
  $('category').innerHTML = state.categories.map(item => `<option value="${esc(item)}">${esc(categoryLabels[item] || item)}</option>`).join('');
}

function renderDocuments() {
  $('documents').innerHTML = state.documents.length ? state.documents.map(document => {
    const light = document.assessment?.trafficLight || 'yellow';
    const date = document.invoiceDate ? new Date(document.invoiceDate + 'T12:00:00').toLocaleDateString('de-DE') : 'Datum offen';
    return `<button class="document" data-document="${esc(document.id)}"><span class="light ${esc(light)}"></span><span><b>${esc(document.vendor || document.file?.name || 'Neuer Beleg')}</b><small>${esc(entityName(document.entityId))} · ${esc(categoryLabels[document.category] || document.category)} · ${esc(date)}</small><small>${esc(document.assessment?.reason || '')}</small></span><span class="amount">${euro(document.amountGross)}<small>${esc(light === 'green' ? 'vollständig' : light === 'red' ? 'gesperrt' : 'noch klären')}</small></span></button>`;
  }).join('') : '<div class="empty">Für diesen Zeitraum sind noch keine Belege vorhanden.</div>';
  document.querySelectorAll('[data-document]').forEach(button => button.addEventListener('click', () => openDocument(button.dataset.document)));
}

function renderAll() { renderSummary(); renderEntities(); renderCategories(); renderDocuments(); }

async function loadAll() {
  const query = new URLSearchParams({ month: month() });
  if ($('statusFilter').value) query.set('status', $('statusFilter').value);
  if ($('entityFilter').value) query.set('entityId', $('entityFilter').value);
  if ($('search').value.trim()) query.set('search', $('search').value.trim());
  const [summary, entities, categories, documents] = await Promise.all([
    api('/api/accounting/summary?month=' + encodeURIComponent(month())), api('/api/accounting/entities'), api('/api/accounting/categories'), api('/api/accounting/documents?' + query),
  ]);
  state.summary = summary; state.entities = entities; state.categories = categories; state.documents = documents; renderAll();
}

async function uploadFiles(files) {
  if (!files?.length) return;
  $('uploadState').textContent = `${files.length} Datei(en) werden gespeichert …`;
  let uploaded = 0;
  for (const file of files) {
    const query = new URLSearchParams({ name: file.name, mime: file.type || 'application/octet-stream', entityId: $('uploadEntity').value });
    const response = await fetch('/api/accounting/documents?' + query, { method: 'POST', headers: authHeaders({ 'Content-Type': file.type || 'application/octet-stream' }), body: file });
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${file.name}: ${json?.error || `HTTP ${response.status}`}`);
    uploaded += 1;
  }
  $('uploadState').textContent = `${uploaded} Beleg(e) unverändert gespeichert. Bitte offene Angaben prüfen.`;
  await loadAll();
}

function showHospitality() { $('hospitalityFields').style.display = $('category').value === 'bewirtung' ? 'block' : 'none'; }

function openDocument(id) {
  const document = state.documents.find(item => item.id === id);
  if (!document) return;
  state.current = document;
  $('detailTitle').textContent = document.vendor || document.file?.name || 'Beleg';
  $('detailEntity').value = document.entityId || '';
  $('vendor').value = document.vendor || '';
  $('invoiceDate').value = document.invoiceDate || '';
  $('invoiceNumber').value = document.invoiceNumber || '';
  $('category').value = document.category || 'sonstiges';
  $('amountNet').value = document.amountNet || '';
  $('vatAmount').value = document.vatAmount || '';
  $('amountGross').value = document.amountGross || '';
  $('privateShare').value = document.privateShare || 0;
  $('businessPurpose').value = document.businessPurpose || '';
  $('hospitalityOccasion').value = document.hospitality?.occasion || '';
  $('hospitalityParticipants').value = document.hospitality?.participants || '';
  const assessment = document.assessment || {};
  $('assessment').className = 'notice' + (assessment.trafficLight === 'green' ? ' ok' : '');
  $('assessment').textContent = `${assessment.trafficLight === 'green' ? 'Grün' : assessment.trafficLight === 'red' ? 'Rot' : 'Gelb'} · ${assessment.reason || 'Prüfung offen'}`;
  $('audit').textContent = `Original: ${document.file?.name || '–'} · SHA-256 ${String(document.file?.sha256 || '').slice(0, 14)}… · ${document.audit?.length || 0} protokollierte Aktion(en)`;
  $('detailState').textContent = '';
  showHospitality();
  $('drawer').classList.add('open');
}

async function saveDocument() {
  if (!state.current) return;
  const button = $('saveDocument'); setBusy(button, true, 'speichert …');
  try {
    const updated = await api('/api/accounting/documents/' + state.current.id, { method: 'PATCH', body: JSON.stringify({
      entityId: $('detailEntity').value, vendor: $('vendor').value, invoiceDate: $('invoiceDate').value,
      invoiceNumber: $('invoiceNumber').value, category: $('category').value, amountNet: $('amountNet').value,
      vatAmount: $('vatAmount').value, amountGross: $('amountGross').value, privateShare: $('privateShare').value,
      businessPurpose: $('businessPurpose').value,
      hospitality: { occasion: $('hospitalityOccasion').value, participants: $('hospitalityParticipants').value },
    }) });
    state.current = updated; $('detailState').textContent = 'Gespeichert und neu geprüft.'; await loadAll(); openDocument(updated.id);
  } catch (error) { $('detailState').textContent = error.message; } finally { setBusy(button, false); }
}

async function openOriginal() {
  if (!state.current) return;
  try {
    const response = await fetch('/api/accounting/documents/' + state.current.id + '/file', { headers: authHeaders() });
    if (!response.ok) throw new Error('Original konnte nicht geladen werden.');
    const url = URL.createObjectURL(await response.blob()); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) { $('detailState').textContent = error.message; }
}

async function createEntity() {
  const button = $('createEntity'); setBusy(button, true, 'speichert …');
  try {
    const entity = await api('/api/accounting/entities', { method: 'POST', body: JSON.stringify({ name: $('entityName').value, taxMode: $('entityTaxMode').value, vatStatus: $('entityVat').value }) });
    $('entityName').value = ''; await loadAll(); $('uploadEntity').value = entity.id;
  } catch (error) { $('uploadState').textContent = error.message; } finally { setBusy(button, false); }
}

async function exportMonth() {
  const button = $('export'); setBusy(button, true, 'erstellt …');
  try {
    const response = await fetch('/api/accounting/export.csv?month=' + encodeURIComponent(month()), { headers: authHeaders() });
    if (!response.ok) throw new Error('Export konnte nicht erstellt werden.');
    const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `IVA-Buchhaltung-${month()}.csv`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (error) { $('uploadState').textContent = error.message; } finally { setBusy(button, false); }
}

$('month').value = new Date().toISOString().slice(0, 7);
$('files').addEventListener('change', event => uploadFiles(event.target.files).catch(error => { $('uploadState').textContent = error.message; }).finally(() => { event.target.value = ''; }));
for (const event of ['dragenter', 'dragover']) $('drop').addEventListener(event, value => { value.preventDefault(); $('drop').classList.add('drag'); });
for (const event of ['dragleave', 'drop']) $('drop').addEventListener(event, value => { value.preventDefault(); $('drop').classList.remove('drag'); });
$('drop').addEventListener('drop', event => uploadFiles(event.dataTransfer.files).catch(error => { $('uploadState').textContent = error.message; }));
$('month').addEventListener('change', () => loadAll().catch(error => { $('uploadState').textContent = error.message; }));
$('statusFilter').addEventListener('change', () => loadAll().catch(error => { $('uploadState').textContent = error.message; }));
$('entityFilter').addEventListener('change', () => loadAll().catch(error => { $('uploadState').textContent = error.message; }));
let searchTimer; $('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadAll().catch(error => { $('uploadState').textContent = error.message; }), 250); });
$('reload').addEventListener('click', () => loadAll().catch(error => { $('uploadState').textContent = error.message; }));
$('createEntity').addEventListener('click', createEntity);
$('saveDocument').addEventListener('click', saveDocument);
$('openOriginal').addEventListener('click', openOriginal);
$('closeDrawer').addEventListener('click', () => $('drawer').classList.remove('open'));
$('category').addEventListener('change', showHospitality);
$('export').addEventListener('click', exportMonth);
$('ivaHelper').addEventListener('click', () => window.open('/cockpit', '_blank', 'noopener'));

loadAll().catch(error => { $('uploadState').textContent = `Buchhaltung konnte nicht geladen werden: ${error.message}. Prüfe den API-Token im Cockpit.`; });

