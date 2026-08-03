const LS_TOKEN = 'iva_token';
const LS_SESSION = 'iva_customer_session';
const $ = id => document.getElementById(id);
const state = {
  customers: [],
  workspaces: [],
  current: null,
  currentWorkspace: null,
  references: null,
  prepared: null,
  sessionId: localStorage.getItem(LS_SESSION) || (globalThis.crypto?.randomUUID?.() || `customers-${Date.now()}`),
};
localStorage.setItem(LS_SESSION, state.sessionId);

function headers(extra = {}) {
  return { Authorization: 'Bearer ' + (localStorage.getItem(LS_TOKEN) || ''), ...extra };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: headers({ 'Content-Type': 'application/json', ...(options.headers || {}) }),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(json?.error || `HTTP ${response.status}`);
  return json;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function initials(name) {
  return clean(name).split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || 'K';
}

function showNotice(message, type = '') {
  const notice = $('notice');
  notice.textContent = message;
  notice.className = `notice ${type}`.trim();
  notice.hidden = false;
}

function hideNotice() {
  $('notice').hidden = true;
}

function setSync(connected, text) {
  $('syncDot').className = `sync-dot ${connected ? 'on' : 'off'}`;
  $('syncText').textContent = text;
}

function sourceAddress(customer) {
  return customer.address || [customer.street, [customer.zip, customer.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

function localCustomer(workspace) {
  const customer = workspace.customer || {};
  return {
    id: `local:${workspace.id}`,
    externalId: customer.id || '',
    name: customer.name || workspace.title || 'Neue Kundenakte',
    email: customer.email || '',
    phone: customer.phone || '',
    address: customer.address || '',
    source: 'iva',
    workspace,
  };
}

function mergeCustomers(qonektoCustomers, workspaces) {
  const externalIds = new Set(qonektoCustomers.map(customer => String(customer.id)));
  const localOnly = workspaces
    .filter(workspace => !workspace.customer?.id || !externalIds.has(String(workspace.customer.id)))
    .map(localCustomer);
  return [
    ...qonektoCustomers.map(customer => ({ ...customer, source: 'qonekto' })),
    ...localOnly,
  ].sort((a, b) => clean(a.name).localeCompare(clean(b.name), 'de'));
}

function renderCustomerList() {
  const root = $('customerList');
  const query = clean($('customerSearch').value).toLocaleLowerCase('de');
  const customers = state.customers.filter(customer => !query || [customer.name, customer.email, customer.phone, customer.address, customer.city]
    .some(value => clean(value).toLocaleLowerCase('de').includes(query)));
  root.innerHTML = '';
  if (!customers.length) {
    root.innerHTML = '<div class="empty-list">Keine passenden Kunden gefunden.</div>';
    return;
  }
  for (const customer of customers) {
    const button = document.createElement('button');
    button.className = `customer-row${state.current?.listId === customer.id ? ' active' : ''}`;
    button.type = 'button';
    button.dataset.customerId = customer.id;
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = initials(customer.name);
    const copy = document.createElement('span');
    copy.className = 'customer-copy';
    const name = document.createElement('b');
    const detail = document.createElement('small');
    name.textContent = customer.name;
    detail.textContent = customer.email || customer.phone || sourceAddress(customer) || `Kunden-ID ${customer.externalId || customer.id}`;
    copy.append(name, detail);
    const source = document.createElement('span');
    source.className = `source-pill${customer.source === 'iva' ? ' local' : ''}`;
    source.textContent = customer.source === 'iva' ? 'Entwurf' : 'Blau';
    button.append(avatar, copy, source);
    button.addEventListener('click', () => openCustomer(customer.id));
    root.appendChild(button);
  }
}

async function loadCustomers({ force = false, keepSelection = true } = {}) {
  hideNotice();
  setSync(false, 'Qonekto wird geladen …');
  const previousId = keepSelection ? state.current?.listId : '';
  let qonekto = { customers: [], connected: false };
  let qonektoError = null;
  try {
    const search = clean($('customerSearch').value);
    qonekto = await api(`/api/customers?limit=100${search ? `&search=${encodeURIComponent(search)}` : ''}${force ? '&force=1' : ''}`);
    setSync(true, `${qonekto.total ?? qonekto.customers.length} Kunden aus Qonekto`);
  } catch (error) {
    qonektoError = error;
    setSync(false, 'Qonekto nicht erreichbar');
  }
  try {
    state.workspaces = await api('/api/workspaces?mode=kunde');
  } catch {
    state.workspaces = [];
  }
  state.customers = mergeCustomers(qonekto.customers || [], state.workspaces);
  renderCustomerList();
  if (qonektoError) showNotice(`Qonekto konnte gerade nicht geladen werden: ${qonektoError.message}. Deine IVA-Entwürfe bleiben sichtbar.`, 'error');
  if (previousId && state.customers.some(customer => customer.id === previousId)) await openCustomer(previousId, { force });
}

function findLocalWorkspace(customerId) {
  return state.workspaces.find(workspace => String(workspace.customer?.id || '') === String(customerId)) || null;
}

async function ensureWorkspace(customer) {
  if (state.currentWorkspace) return state.currentWorkspace;
  const workspace = await api('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify({
      mode: 'kunde',
      title: `${customer.name || 'Kunde'} · Kundenakte`,
      customer: {
        id: customer.id || '',
        name: customer.name || '',
        email: customer.email || '',
        phone: customer.mobile || customer.phone || '',
        address: sourceAddress(customer),
      },
      data: { project: 'Goals & Concepts', company: customer.company || '', relationship: 'Qonekto / Blau Direkt', nextStep: '' },
    }),
  });
  state.workspaces.unshift(workspace);
  state.currentWorkspace = workspace;
  return workspace;
}

function displayValue(value) {
  if (value === true) return 'Ja';
  if (value === false) return 'Nein';
  if (Array.isArray(value)) return value.map(item => typeof item === 'object' ? JSON.stringify(item) : String(item)).join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return clean(value);
}

function dateValue(value) {
  if (!value) return '–';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? clean(value) : date.toLocaleDateString('de-DE');
}

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return clean(value) || '–';
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(number);
}

function datum(label, value, { full = false, link = '' } = {}) {
  const safeValue = clean(value) || '–';
  const content = link && safeValue !== '–'
    ? `<a class="link" href="${escapeHtml(link)}">${escapeHtml(safeValue)}</a>`
    : `<b>${escapeHtml(safeValue)}</b>`;
  return `<div class="datum${full ? ' full' : ''}"><span>${escapeHtml(label)}</span>${content}</div>`;
}

function normalizeNote(note) {
  if (typeof note === 'string') return { text: note, meta: 'Qonekto-Archiv' };
  return {
    text: clean(note?.text ?? note?.inhalt ?? note?.notiz ?? note?.beschreibung ?? note?.betreff) || displayValue(note),
    meta: [note?.art, note?.type, note?.created_at || note?.erstellt_am].filter(Boolean).join(' · ') || 'Qonekto-Archiv',
  };
}

function contractRows(contracts) {
  if (!contracts.length) return '<div class="empty-card">Keine Verträge zu diesem Kunden gefunden.</div>';
  return `<div class="contract-list">${contracts.map(contract => `
    <div class="contract">
      <div><b>${escapeHtml(contract.category || 'Vertrag')}</b><small>${escapeHtml(contract.company || 'Gesellschaft nicht hinterlegt')}</small></div>
      <div><span class="status-chip">${escapeHtml(contract.status || 'Status offen')}</span><small>${escapeHtml(contract.policyNumber || 'ohne Versicherungsscheinnummer')}</small></div>
      <div><b>${escapeHtml(contract.risk || '–')}</b><small>${escapeHtml([dateValue(contract.start), contract.paymentFrequency].filter(Boolean).join(' · '))}</small></div>
      <div class="premium"><b>${escapeHtml(money(contract.netPremium))}</b><small>netto</small></div>
    </div>`).join('')}</div>`;
}

function rawCustomerFields(customer) {
  const raw = customer.raw || {};
  const excluded = new Set(['ameise_id', 'id', 'vorname', 'nachname', 'titel', 'strasse', 'plz', 'ort', 'email', 'telefon', 'mobil', 'kommunikationen', 'details']);
  const entries = Object.entries(raw)
    .filter(([key, value]) => !excluded.has(key) && value !== null && value !== '' && value !== undefined && typeof value !== 'object')
    .slice(0, 18);
  if (!entries.length) return '<div class="empty-card">Keine weiteren Stammdaten übermittelt.</div>';
  return `<div class="raw-grid">${entries.map(([key, value]) => `<div class="raw-item"><span>${escapeHtml(key.replaceAll('_', ' '))}</span><b>${escapeHtml(displayValue(value))}</b></div>`).join('')}</div>`;
}

function renderDetail(detail, listId) {
  const customer = detail.customer;
  const workspace = state.currentWorkspace;
  const localNotes = workspace?.notes || [];
  const localFiles = workspace?.files || [];
  const archiveNotes = (detail.archiveNotes || []).map(normalizeNote);
  const contracts = detail.contracts || [];
  const sourceIsLocal = detail.source === 'iva';
  const customerUrl = !sourceIsLocal && customer.id ? `https://www.maklerinfo.biz/maklerportal/?show=kunde&kunde=${encodeURIComponent(customer.id)}` : '';
  const detailRoot = $('customerDetail');
  detailRoot.innerHTML = `
    <div class="detail-head">
      <div class="identity"><span class="avatar">${escapeHtml(initials(customer.name))}</span><div><div class="identity-line"><span class="${sourceIsLocal ? 'live-badge local-badge' : 'live-badge'}">${sourceIsLocal ? 'IVA-Entwurf' : 'Qonekto live'}</span><span>Kunden-ID ${escapeHtml(customer.id || 'noch nicht vergeben')}</span></div><h1>${escapeHtml(customer.name)}</h1><div class="muted">${escapeHtml(sourceAddress(customer) || 'Adresse noch nicht hinterlegt')}</div></div></div>
      <div class="top-actions">${customerUrl ? `<a class="btn" href="${escapeHtml(customerUrl)}" target="_blank" rel="noopener">In Blau Direkt öffnen ↗</a>` : ''}<button class="btn" id="refreshDetail">↻ Aktualisieren</button></div>
    </div>
    <div class="stats"><div class="stat"><span>Verträge</span><b>${contracts.length}</b></div><div class="stat"><span>Gesellschaften</span><b>${new Set(contracts.map(contract => contract.company).filter(Boolean)).size}</b></div><div class="stat"><span>IVA-Notizen</span><b>${localNotes.length}</b></div><div class="stat"><span>Dokumente</span><b>${localFiles.length}</b></div></div>
    <div class="grid">
      <section class="card"><h2>Kontaktdaten <span class="tag">Stammdaten</span></h2><div class="data-grid">
        ${datum('E-Mail', customer.email, { link: customer.email ? `mailto:${customer.email}` : '' })}
        ${datum('Telefon', customer.mobile || customer.phone, { link: customer.mobile || customer.phone ? `tel:${customer.mobile || customer.phone}` : '' })}
        ${datum('Straße', customer.street)}${datum('PLZ / Ort', [customer.zip, customer.city].filter(Boolean).join(' '))}
        ${datum('Geburtsdatum', dateValue(customer.birthDate))}${datum('Beruf', customer.profession)}
        ${datum('Vermittler-ID', customer.brokerId)}${datum('simplr', customer.simplrUsername || 'nicht verknüpft')}
      </div></section>
      <section class="card"><h2>Service & Aktionen <span class="tag">mit Sicherheitsabfrage</span></h2><div class="service-grid">
        <button class="service" id="editAddressBtn" ${sourceIsLocal ? 'disabled' : ''}><b>⌂ Adresse ändern</b><small>Vorbereiten, prüfen, ausdrücklich bestätigen</small></button>
        <button class="service" id="messageCompanyBtn" ${contracts.length ? '' : 'disabled'}><b>✉ Gesellschaft anschreiben</b><small>Vertragsbezogenen Entwurf anlegen</small></button>
        <button class="service" id="uploadDocumentBtn"><b>↑ Dokument ablegen</b><small>PDF oder Bild in die IVA-Akte</small></button>
        <button class="service" id="newConsultationBtn"><b>◌ Beratung starten</b><small>Mit diesem Kunden vorausfüllen</small></button>
      </div></section>
      <section class="card full"><h2>Verträge <span class="tag">Blau Direkt</span></h2>${contractRows(contracts)}</section>
      <section class="card"><h2>IVA-Arbeitsnotizen <span class="tag">nur deine Akte</span></h2><div class="note-list">${localNotes.length ? localNotes.slice().reverse().map(note => `<div class="note"><b>${escapeHtml(note.text)}</b><small>${escapeHtml(note.source || 'manual')} · ${escapeHtml(new Date(note.createdAt).toLocaleString('de-DE'))}</small></div>`).join('') : '<div class="empty-card">Noch keine IVA-Notizen.</div>'}</div><div class="composer"><textarea id="noteDraft" placeholder="Notiz, Wiedervorlage oder nächsten Schritt eintragen …"></textarea><button class="btn primary" id="saveNoteBtn">Speichern</button></div></section>
      <section class="card"><h2>Qonekto-Archiv <span class="tag">gelesen</span></h2><div class="note-list">${archiveNotes.length ? archiveNotes.slice(0, 20).map(note => `<div class="note"><b>${escapeHtml(note.text)}</b><small>${escapeHtml(note.meta)}</small></div>`).join('') : '<div class="empty-card">Keine Archivnotizen übermittelt.</div>'}</div></section>
      <section class="card"><h2>Dokumente in IVA</h2><div class="files">${localFiles.length ? localFiles.map(file => `<div class="file"><div><b>${escapeHtml(file.name)}</b><small>${escapeHtml(file.kind)} · ${Math.max(1, Math.round(file.bytes / 1024))} KB</small></div><button class="btn ghost open-file" data-file-id="${escapeHtml(file.id)}">Öffnen</button></div>`).join('') : '<div class="empty-card">Noch keine lokalen Dokumente.</div>'}</div></section>
      <section class="card"><h2>Weitere Kundendaten</h2>${rawCustomerFields(customer)}</section>
    </div>`;
  $('emptyState').hidden = true;
  detailRoot.hidden = false;
  bindDetailEvents(listId);
}

function localDetail(workspace) {
  const customer = localCustomer(workspace);
  return {
    source: 'iva',
    customer: {
      ...customer,
      id: customer.externalId,
      street: '', zip: '', city: '', raw: workspace.data || {},
    },
    contracts: [], archiveNotes: [], additionalAddresses: [], relations: [], claims: [],
  };
}

async function openCustomer(listId, { force = false } = {}) {
  hideNotice();
  const listed = state.customers.find(customer => customer.id === listId);
  if (!listed) return;
  state.current = { listId, customer: listed };
  state.currentWorkspace = listed.source === 'iva' ? listed.workspace : findLocalWorkspace(listed.id);
  renderCustomerList();
  $('emptyState').hidden = true;
  $('customerDetail').hidden = false;
  $('customerDetail').innerHTML = '<div class="empty-state"><div><div class="orb">···</div><h2>Kundenakte wird geladen</h2></div></div>';
  try {
    const detail = listed.source === 'iva'
      ? localDetail(listed.workspace)
      : await api(`/api/customers/${encodeURIComponent(listed.id)}${force ? '?force=1' : ''}`);
    state.current.detail = detail;
    renderDetail(detail, listId);
    if (detail.warnings?.length) showNotice('Ein Teil der Zusatzdaten konnte nicht geladen werden. Stammdaten und verfügbare Bereiche werden trotzdem angezeigt.');
  } catch (error) {
    $('customerDetail').hidden = true;
    $('emptyState').hidden = false;
    showNotice(`Kundenakte konnte nicht geladen werden: ${error.message}`, 'error');
  }
}

function bindDetailEvents(listId) {
  $('refreshDetail')?.addEventListener('click', () => openCustomer(listId, { force: true }));
  $('editAddressBtn')?.addEventListener('click', openAddressDialog);
  $('messageCompanyBtn')?.addEventListener('click', openMessageDialog);
  $('uploadDocumentBtn')?.addEventListener('click', () => $('documentInput').click());
  $('newConsultationBtn')?.addEventListener('click', openConsultation);
  $('saveNoteBtn')?.addEventListener('click', saveNote);
  document.querySelectorAll('.open-file').forEach(button => button.addEventListener('click', () => openLocalFile(button.dataset.fileId)));
}

function currentCustomer() {
  return state.current?.detail?.customer || state.current?.customer || null;
}

async function saveNote() {
  const draft = clean($('noteDraft')?.value);
  if (!draft) return;
  try {
    const workspace = await ensureWorkspace(currentCustomer());
    state.currentWorkspace = await api(`/api/workspaces/${workspace.id}/notes`, { method: 'POST', body: JSON.stringify({ text: draft, source: 'kundenportal' }) });
    const index = state.workspaces.findIndex(item => item.id === state.currentWorkspace.id);
    if (index >= 0) state.workspaces[index] = state.currentWorkspace;
    renderDetail(state.current.detail, state.current.listId);
    showNotice('Notiz wurde in IVAs Kundenakte gespeichert.', 'success');
  } catch (error) { showNotice(`Notiz konnte nicht gespeichert werden: ${error.message}`, 'error'); }
}

async function openLocalFile(fileId) {
  if (!state.currentWorkspace) return;
  const response = await fetch(`/api/workspaces/${state.currentWorkspace.id}/files/${fileId}`, { headers: headers() });
  if (!response.ok) return showNotice('Dokument konnte nicht geöffnet werden.', 'error');
  const url = URL.createObjectURL(await response.blob());
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function uploadDocument(file) {
  try {
    const workspace = await ensureWorkspace(currentCustomer());
    const query = new URLSearchParams({ kind: 'document', name: file.name, mime: file.type || 'application/octet-stream' });
    const response = await fetch(`/api/workspaces/${workspace.id}/files?${query}`, {
      method: 'POST', headers: headers({ 'Content-Type': file.type || 'application/octet-stream' }), body: file,
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new Error(json?.error || `HTTP ${response.status}`);
    state.currentWorkspace = await api(`/api/workspaces/${workspace.id}`);
    renderDetail(state.current.detail, state.current.listId);
    showNotice(`${file.name} wurde in IVAs Kundenakte abgelegt.`, 'success');
  } catch (error) { showNotice(`Upload fehlgeschlagen: ${error.message}`, 'error'); }
}

function openConsultation() {
  const customer = currentCustomer();
  const query = new URLSearchParams({ mode: 'beratung', customerId: customer.id || '', customerName: customer.name || '', customerEmail: customer.email || '', customerPhone: customer.mobile || customer.phone || '', customerAddress: sourceAddress(customer) });
  window.open(`/workspace?${query}`, '_blank', 'noopener');
}

function openAddressDialog() {
  const customer = currentCustomer();
  $('editStreet').value = customer.street || '';
  $('editZip').value = customer.zip || '';
  $('editCity').value = customer.city || '';
  $('addressDialog').showModal();
}

function openMessageDialog() {
  const contracts = state.current?.detail?.contracts || [];
  const select = $('messageContract');
  select.innerHTML = '';
  for (const contract of contracts) {
    const option = document.createElement('option');
    option.value = contract.id;
    option.textContent = `${contract.company || 'Gesellschaft'} · ${contract.category || 'Vertrag'} · ${contract.policyNumber || 'ohne Nummer'}`;
    select.appendChild(option);
  }
  $('messageSubject').value = '';
  $('messageBody').value = '';
  $('messageDialog').showModal();
}

async function saveMessageDraft() {
  const contracts = state.current?.detail?.contracts || [];
  const contract = contracts.find(item => item.id === $('messageContract').value) || contracts[0];
  const subject = clean($('messageSubject').value);
  const body = clean($('messageBody').value);
  if (!subject || !body) return showNotice('Bitte Betreff und Nachricht ergänzen.', 'error');
  try {
    const workspace = await ensureWorkspace(currentCustomer());
    const text = `ENTWURF AN GESELLSCHAFT\nGesellschaft: ${contract?.company || 'nicht gewählt'}\nVertrag: ${contract?.policyNumber || contract?.id || '–'}\nBetreff: ${subject}\n\n${body}`;
    state.currentWorkspace = await api(`/api/workspaces/${workspace.id}/notes`, { method: 'POST', body: JSON.stringify({ text, source: 'gesellschaft-entwurf' }) });
    $('messageDialog').close();
    renderDetail(state.current.detail, state.current.listId);
    showNotice('Der Gesellschaftsentwurf ist sicher in der Kundenakte gespeichert. Es wurde noch nichts versendet.', 'success');
  } catch (error) { showNotice(`Entwurf konnte nicht gespeichert werden: ${error.message}`, 'error'); }
}

async function loadReferences() {
  if (state.references) return state.references;
  try {
    state.references = await api('/api/customers/references');
    for (const [selectId, items] of [['newSalutation', state.references.salutations || []], ['newBroker', state.references.brokers || []]]) {
      const select = $(selectId);
      const firstOption = select.children[0]?.cloneNode(true);
      select.innerHTML = '';
      if (firstOption) select.appendChild(firstOption);
      for (const item of items) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = `${item.label}${item.label === item.id ? '' : ` · ${item.id}`}`;
        select.appendChild(option);
      }
    }
  } catch (error) {
    showNotice(`Qonekto-Referenzdaten konnten nicht geladen werden: ${error.message}. Ein IVA-Entwurf ist trotzdem möglich.`, 'error');
    state.references = { salutations: [], brokers: [] };
  }
  return state.references;
}

async function openNewCustomer() {
  $('newCustomerForm').reset();
  $('newCustomerDialog').showModal();
  await loadReferences();
}

function newCustomerValues() {
  return {
    anrede_id: clean($('newSalutation').value),
    vermittler_id: clean($('newBroker').value),
    vorname: clean($('newFirstName').value),
    nachname: clean($('newLastName').value),
    strasse: clean($('newStreet').value),
    plz: clean($('newZip').value),
    ort: clean($('newCity').value),
    kommunikation: { email: clean($('newEmail').value), telefon: clean($('newPhone').value) },
  };
}

async function saveLocalCustomer() {
  const values = newCustomerValues();
  if (!values.nachname) return showNotice('Bitte mindestens den Nachnamen eintragen.', 'error');
  try {
    const name = [values.vorname, values.nachname].filter(Boolean).join(' ');
    const workspace = await api('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'kunde', title: `${name} · Kundenakte`,
        customer: { name, email: values.kommunikation.email, phone: values.kommunikation.telefon, address: [values.strasse, [values.plz, values.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ') },
        data: { project: 'Goals & Concepts', company: '', relationship: 'IVA-Entwurf – noch nicht in Qonekto angelegt', nextStep: 'Stammdaten prüfen und Qonekto-Anlage bestätigen' },
      }),
    });
    state.workspaces.unshift(workspace);
    const customer = localCustomer(workspace);
    state.customers.push(customer);
    state.customers.sort((a, b) => clean(a.name).localeCompare(clean(b.name), 'de'));
    $('newCustomerDialog').close();
    renderCustomerList();
    await openCustomer(customer.id);
    showNotice('Neue IVA-Kundenakte wurde als Entwurf gespeichert. In Qonekto wurde noch nichts verändert.', 'success');
  } catch (error) { showNotice(`Kundenakte konnte nicht gespeichert werden: ${error.message}`, 'error'); }
}

async function prepareAction(kind, customerId, values) {
  try {
    state.prepared = await api('/api/customers/actions/prepare', {
      method: 'POST',
      body: JSON.stringify({ sessionId: state.sessionId, kind, customerId, values }),
    });
    const pre = document.createElement('pre');
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.wordBreak = 'break-word';
    pre.textContent = JSON.stringify(state.prepared.changes || values, null, 2);
    $('confirmSummary').innerHTML = '';
    $('confirmSummary').appendChild(pre);
    $('newCustomerDialog').open && $('newCustomerDialog').close();
    $('addressDialog').open && $('addressDialog').close();
    $('confirmDialog').showModal();
  } catch (error) { showNotice(`Qonekto-Aktion konnte nicht vorbereitet werden: ${error.message}`, 'error'); }
}

async function prepareCreateCustomer() {
  const values = newCustomerValues();
  if (!values.nachname) return showNotice('Bitte mindestens den Nachnamen eintragen.', 'error');
  if (!values.anrede_id) return showNotice('Für die Anlage in Qonekto muss eine Anrede ausgewählt werden. Als IVA-Entwurf kannst du die Akte trotzdem speichern.', 'error');
  await prepareAction('create-customer', '', values);
}

async function prepareAddress() {
  const customer = currentCustomer();
  await prepareAction('update-customer', customer.id, { strasse: clean($('editStreet').value), plz: clean($('editZip').value), ort: clean($('editCity').value) });
}

async function executePreparedAction() {
  if (!state.prepared) return;
  $('executeConfirm').disabled = true;
  try {
    const result = await api('/api/customers/actions/confirm', {
      method: 'POST',
      body: JSON.stringify({ sessionId: state.sessionId, confirmation: state.prepared.confirmationPhrase }),
    });
    $('confirmDialog').close();
    state.prepared = null;
    showNotice(result.message, result.ok ? 'success' : 'error');
    await loadCustomers({ force: true, keepSelection: true });
  } catch (error) { showNotice(`Änderung wurde nicht ausgeführt: ${error.message}`, 'error'); }
  finally { $('executeConfirm').disabled = false; }
}

function cancelPreparedAction() {
  state.prepared = null;
  $('confirmDialog').close();
  showNotice('Abgebrochen. In Qonekto wurde nichts verändert.');
}

$('customerSearch').addEventListener('input', renderCustomerList);
$('customerSearch').addEventListener('search', renderCustomerList);
$('refreshCustomers').addEventListener('click', () => loadCustomers({ force: true }));
$('newCustomerBtn').addEventListener('click', openNewCustomer);
$('emptyNewBtn').addEventListener('click', openNewCustomer);
$('saveLocalCustomer').addEventListener('click', saveLocalCustomer);
$('prepareCreateCustomer').addEventListener('click', prepareCreateCustomer);
$('prepareAddress').addEventListener('click', prepareAddress);
$('saveMessageDraft').addEventListener('click', saveMessageDraft);
$('executeConfirm').addEventListener('click', executePreparedAction);
$('cancelConfirm').addEventListener('click', cancelPreparedAction);
$('closeConfirm').addEventListener('click', cancelPreparedAction);
$('documentInput').addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (file) uploadDocument(file);
  event.target.value = '';
});
$('ivaHelper').addEventListener('click', () => window.open('/cockpit', '_blank', 'noopener'));

loadCustomers({ keepSelection: false });
