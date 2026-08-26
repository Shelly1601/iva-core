const LS_TOKEN = 'iva_token';
const LS_SESSION = 'iva_customer_session';
const DEFAULT_BROKER_ID = '009T7N';
const KNOWN_SALUTATION_LABELS = { 1: 'Herr', 2: 'Frau', 7: 'Firma' };
const SALUTATION_LABELS = { male: 'Mann', female: 'Frau', diverse: 'Divers', company: 'Firma' };
const $ = id => document.getElementById(id);
const state = {
  customers: [],
  workspaces: [],
  current: null,
  currentWorkspace: null,
  references: null,
  lumitConfig: null,
  lumitApplication: null,
  prepared: null,
  preparedContext: null,
  addressSearchTimer: null,
  addressSearchSerial: 0,
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

function workspaceQonektoDraft(workspace) {
  return workspace?.data?.qonektoDraft && typeof workspace.data.qonektoDraft === 'object'
    ? workspace.data.qonektoDraft
    : {};
}

function localCustomer(workspace) {
  const customer = workspace.customer || {};
  const draft = workspaceQonektoDraft(workspace);
  const salutationKey = customer.salutationKey || workspace.data?.qonektoLabels?.salutationKey || '';
  return {
    id: `local:${workspace.id}`,
    externalId: customer.id || '',
    name: customer.name || draft.firma || [draft.vorname, draft.nachname].filter(Boolean).join(' ') || workspace.title || 'Neue Kundenakte',
    firstName: customer.firstName || draft.vorname || '',
    lastName: customer.lastName || draft.nachname || '',
    company: customer.company || draft.firma || '',
    legalForm: customer.legalForm || draft.rechtsform || '',
    email: customer.email || draft.kommunikation?.email || '',
    phone: customer.phone || draft.kommunikation?.telefon || '',
    street: customer.street || draft.strasse || '',
    zip: customer.zip || draft.plz || '',
    city: customer.city || draft.ort || '',
    address: customer.address || [draft.strasse, [draft.plz, draft.ort].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    brokerId: customer.brokerId || draft.vermittler_id || '',
    salutationKey,
    salutation: customer.salutation || workspace.data?.qonektoLabels?.salutation || SALUTATION_LABELS[salutationKey] || '',
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
    const row = document.createElement('div');
    row.className = `customer-row${state.current?.listId === customer.id ? ' active' : ''}`;
    row.dataset.customerId = customer.id;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `Kundenakte ${customer.name} öffnen`);
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
    source.textContent = customer.source === 'iva' ? 'IVA' : 'Blau';
    const actions = document.createElement('span');
    actions.className = 'customer-actions';
    actions.appendChild(source);
    if (customer.source === 'iva' && customer.workspace?.id) {
      const trash = document.createElement('button');
      trash.type = 'button';
      trash.className = 'quick-delete';
      trash.textContent = '🗑';
      trash.title = `IVA-Kundenakte ${customer.name} löschen`;
      trash.setAttribute('aria-label', `IVA-Kundenakte ${customer.name} löschen`);
      trash.addEventListener('click', event => {
        event.stopPropagation();
        quickDeleteLocalCustomer(customer);
      });
      actions.appendChild(trash);
    }
    row.append(avatar, copy, actions);
    row.addEventListener('click', () => openCustomer(customer.id));
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openCustomer(customer.id); }
    });
    root.appendChild(row);
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
  if (qonektoError) showNotice(`Qonekto konnte gerade nicht geladen werden: ${qonektoError.message}. Deine IVA-Kundenakten bleiben sichtbar.`, 'error');
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
        salutationKey: customer.salutationKey || '',
        salutation: customer.salutation || '',
        firstName: customer.firstName || '',
        lastName: customer.lastName || '',
        company: customer.company || '',
        legalForm: customer.legalForm || '',
        email: customer.email || '',
        phone: customer.mobile || customer.phone || '',
        street: customer.street || '',
        zip: customer.zip || '',
        city: customer.city || '',
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
  const entries = [];
  const collect = (value, prefix = '', depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 4 || entries.length >= 30) return;
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix} · ${key}` : key;
      if (!prefix && excluded.has(key)) continue;
      if (child === null || child === '' || child === undefined) continue;
      if (Array.isArray(child)) {
        const scalars = child.filter(item => item === null || typeof item !== 'object');
        if (scalars.length) entries.push([path, scalars.join(', ')]);
        child.filter(item => item && typeof item === 'object').forEach((item, index) => collect(item, `${path} ${index + 1}`, depth + 1));
      } else if (typeof child === 'object') collect(child, path, depth + 1);
      else entries.push([path, child]);
      if (entries.length >= 30) break;
    }
  };
  collect(raw);
  if (!entries.length) return '<div class="empty-card">Keine weiteren Stammdaten übermittelt.</div>';
  return `<div class="raw-grid">${entries.map(([key, value]) => `<div class="raw-item"><span>${escapeHtml(key.replaceAll('_', ' '))}</span><b>${escapeHtml(displayValue(value))}</b></div>`).join('')}</div>`;
}

const DOCUMENT_CATEGORY_LABELS = {
  general: 'Allgemein', floorplan: 'Grundriss', 'consumption-proof': 'Verbrauch', offer: 'Angebot', tmb: 'TMB', contract: 'Vertrag', invoice: 'Rechnung', heating: 'Heizung / Wärmepumpe', pv: 'Photovoltaik', correspondence: 'Korrespondenz', other: 'Sonstiges',
};
let pendingDocumentFiles = [];

function documentCategoryLabel(category) {
  return DOCUMENT_CATEGORY_LABELS[category] || DOCUMENT_CATEGORY_LABELS.general;
}

function formatFileSize(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function meetingRows(meetings = []) {
  if (!meetings.length) return '<div class="empty-card">Noch kein Gespräch in dieser Kundenakte hinterlegt.</div>';
  return `<div class="note-list">${meetings.slice().sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || ''))).map(meeting => {
    const source = meeting.source === 'plaud' ? 'PLAUD' : (meeting.source || 'Gespräch');
    const summary = clean(meeting.internalSummary || meeting.customerSummary) || 'Gespräch ist hinterlegt; eine geprüfte Zusammenfassung fehlt noch.';
    return `<div class="note"><span class="conversation-source${meeting.source === 'plaud' ? ' plaud' : ''}">${escapeHtml(source)}</span><b>${escapeHtml(meeting.title || 'Kundengespräch')}</b><div>${escapeHtml(summary)}</div><small>${escapeHtml(dateValue(meeting.occurredAt))}${meeting.externalId ? ` · Aufnahme ${escapeHtml(meeting.externalId)}` : ''}</small></div>`;
  }).join('')}</div>`;
}

function renderDetail(detail, listId) {
  const customer = detail.customer;
  const workspace = state.currentWorkspace;
  const localNotes = workspace?.notes || [];
  const localFiles = workspace?.files || [];
  const meetings = Array.isArray(workspace?.data?.meetings) ? workspace.data.meetings : [];
  const archiveNotes = (detail.archiveNotes || []).map(normalizeNote);
  const contracts = detail.contracts || [];
  const companies = new Set(contracts.map(contract => contract.company).filter(Boolean)).size;
  const sourceIsLocal = detail.source === 'iva';
  const customerUrl = !sourceIsLocal && customer.id ? `https://www.maklerinfo.biz/maklerportal/?show=kunde&kunde=${encodeURIComponent(customer.id)}` : '';
  const detailRoot = $('customerDetail');
  detailRoot.innerHTML = `
    <div class="detail-head">
      <div class="identity"><span class="avatar">${escapeHtml(initials(customer.name))}</span><div><div class="identity-line"><span class="${sourceIsLocal ? 'live-badge local-badge' : 'live-badge'}">${sourceIsLocal ? 'IVA-Kundenakte' : 'Qonekto live'}</span><span>Kunden-ID ${escapeHtml(customer.id || 'noch nicht an Blau Direkt übertragen')}</span></div><h1>${escapeHtml(customer.name)}</h1><div class="muted">${escapeHtml(sourceAddress(customer) || 'Adresse noch nicht hinterlegt')}</div></div></div>
      <div class="top-actions">${customerUrl ? `<a class="btn" href="${escapeHtml(customerUrl)}" target="_blank" rel="noopener">In Blau Direkt öffnen ↗</a>` : ''}<button class="btn" id="refreshDetail">↻ Aktualisieren</button></div>
    </div>
    <div class="stats"><div class="stat"><span>Verträge</span><b>${contracts.length}</b></div><div class="stat"><span>Gespräche</span><b>${meetings.length}</b></div><div class="stat"><span>Notizen gesamt</span><b>${localNotes.length + archiveNotes.length}</b></div><div class="stat"><span>Dokumente</span><b>${localFiles.length}</b></div></div>
    <section class="quick-start-panel">
      <div class="quick-start-head"><h2>Was möchtest du für diesen Kunden tun?</h2><span>Erst die grobe Richtung wählen – Details öffnen sich danach.</span></div>
      <div class="quick-start-grid">
        <button class="service primary-action" id="tmbAssistantBtn"><b>⌁ TMB geführt aufnehmen</b><small>CRM- und PLAUD-Daten übernehmen, nur Lücken abfragen, danach alles prüfen</small></button>
        <button class="service" id="newConsultationBtn"><b>◌ Beratung starten</b><small>Beratung mit diesem Kunden vorausfüllen</small></button>
        <button class="service" id="uploadDocumentBtn"><b>＋ Dokumente hinzufügen</b><small>Mehrere Dateien auswählen oder hineinziehen</small></button>
      </div>
    </section>
    <div class="record-sections">
      <details class="record-section">
        <summary><span class="section-icon">⌂</span><span class="section-title"><b>Kontakt & Stammdaten</b><small>${escapeHtml(customer.email || customer.mobile || customer.phone || sourceAddress(customer) || 'Kontaktdaten prüfen')}</small></span><span class="section-chevron">›</span></summary>
        <div class="section-body"><div class="data-grid">
          ${datum('Anrede', customer.salutation)}${datum('Vermittler-ID', customer.brokerId)}
          ${datum(customer.company ? 'Firma' : 'Vorname', customer.company || customer.firstName)}${datum(customer.company ? 'Rechtsform' : 'Nachname', customer.company ? customer.legalForm : customer.lastName)}
          ${datum('E-Mail', customer.email, { link: customer.email ? `mailto:${customer.email}` : '' })}
          ${datum('Telefon', customer.mobile || customer.phone, { link: customer.mobile || customer.phone ? `tel:${customer.mobile || customer.phone}` : '' })}
          ${datum('Straße', customer.street)}${datum('PLZ / Ort', [customer.zip, customer.city].filter(Boolean).join(' '))}
          ${datum('Geburtsdatum', dateValue(customer.birthDate))}${datum('Beruf', customer.profession)}
          ${datum('simplr', customer.simplrUsername || 'nicht verknüpft')}
        </div></div>
      </details>
      <details class="record-section">
        <summary><span class="section-icon">▤</span><span class="section-title"><b>Verträge & Gesellschaften</b><small>${contracts.length} Verträge bei ${companies} Gesellschaft${companies === 1 ? '' : 'en'}</small></span><span class="section-chevron">›</span></summary>
        <div class="section-body">${contractRows(contracts)}</div>
      </details>
      <details class="record-section">
        <summary><span class="section-icon">◌</span><span class="section-title"><b>Gespräche & Notizen</b><small>${meetings.length} Gespräch${meetings.length === 1 ? '' : 'e'} · ${localNotes.length + archiveNotes.length} ${(localNotes.length + archiveNotes.length) === 1 ? 'Notiz' : 'Notizen'}</small></span><span class="section-chevron">›</span></summary>
        <div class="section-body">
          <h2>Gespräche <span class="tag">PLAUD & IVA</span></h2>${meetingRows(meetings)}
          <div style="height:18px"></div><h2>IVA-Arbeitsnotizen <span class="tag">nur deine Akte</span></h2><div class="note-list">${localNotes.length ? localNotes.slice().reverse().map(note => `<div class="note"><b>${escapeHtml(note.text)}</b><small>${escapeHtml(note.source || 'manual')} · ${escapeHtml(new Date(note.createdAt).toLocaleString('de-DE'))}</small></div>`).join('') : '<div class="empty-card">Noch keine IVA-Notizen.</div>'}</div><div class="composer"><textarea id="noteDraft" placeholder="Notiz, Wiedervorlage oder nächsten Schritt eintragen …"></textarea><button class="btn primary" id="saveNoteBtn">Speichern</button></div>
          <div style="height:18px"></div><h2>Qonekto-Archiv <span class="tag">gelesen</span></h2><div class="note-list">${archiveNotes.length ? archiveNotes.slice(0, 20).map(note => `<div class="note"><b>${escapeHtml(note.text)}</b><small>${escapeHtml(note.meta)}</small></div>`).join('') : '<div class="empty-card">Keine Archivnotizen übermittelt.</div>'}</div>
        </div>
      </details>
      <details class="record-section">
        <summary><span class="section-icon">▱</span><span class="section-title"><b>Dokumente</b><small>${localFiles.length} Unterlagen · Grundrisse, Nachweise, Angebote und TMBs</small></span><span class="section-chevron">›</span></summary>
        <div class="section-body"><h2>Dokumente in IVA <span class="tag">Kundenakte</span><button class="doc-plus" id="addDocumentInline" title="Dokumente hinzufügen" aria-label="Dokumente hinzufügen">+</button></h2><div class="document-hint">Alle Unterlagen bleiben direkt diesem Kunden zugeordnet.</div><div class="files">${localFiles.length ? localFiles.slice().sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).map(file => `<div class="file"><div class="file-copy"><span class="file-category">${escapeHtml(documentCategoryLabel(file.category))}</span><b>${escapeHtml(file.name)}</b><small>${escapeHtml(formatFileSize(file.bytes))} · ${escapeHtml(file.createdAt ? new Date(file.createdAt).toLocaleString('de-DE') : 'Datum unbekannt')}</small></div><button class="btn ghost open-file" data-file-id="${escapeHtml(file.id)}">Öffnen</button></div>`).join('') : '<div class="empty-card">Noch keine Dokumente. Klicke auf das Plus und ziehe mehrere Dateien direkt in die Kundenakte.</div>'}</div></div>
      </details>
      <details class="record-section">
        <summary><span class="section-icon">⚙</span><span class="section-title"><b>Service & Vorgänge</b><small>Änderungen, Gesellschaften, LUMIT und Blau Direkt</small></span><span class="section-chevron">›</span></summary>
        <div class="section-body"><div class="service-grid">
          ${sourceIsLocal ? '<button class="service" id="transferLocalCustomerBtn"><b>↗ An Blau Direkt übertragen</b><small>Daten prüfen und Qonekto-Anlage separat bestätigen</small></button>' : ''}
          <button class="service" id="editAddressBtn"><b>✎ Kontaktdaten bearbeiten</b><small>${sourceIsLocal ? 'Direkt in der IVA-Kundenakte speichern' : 'Bei Blau Direkt vorbereiten und ausdrücklich bestätigen'}</small></button>
          <button class="service" id="messageCompanyBtn" ${contracts.length ? '' : 'disabled'}><b>✉ Gesellschaft anschreiben</b><small>Vertragsbezogenen Entwurf anlegen</small></button>
          <button class="service" id="lumitApplicationBtn" ${sourceIsLocal ? 'disabled' : ''}><b>☀ LUMIT-Antrag</b><small>Online abschließen und als servicierten Antrag übernehmen</small></button>
          ${sourceIsLocal ? '<button class="service danger" id="deleteLocalCustomerBtn"><b>× IVA-Kundenakte löschen</b><small>Löscht nur diese lokale IVA-Akte – niemals Pipedrive oder Blau Direkt</small></button>' : ''}
        </div></div>
      </details>
      <details class="record-section">
        <summary><span class="section-icon">⋯</span><span class="section-title"><b>Weitere Kundendaten</b><small>Zusätzliche Felder aus der angebundenen Datenquelle</small></span><span class="section-chevron">›</span></summary>
        <div class="section-body">${rawCustomerFields(customer)}</div>
      </details>
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
      raw: workspace.data || {},
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
    // List Kunde und Show Kunde liefern je nach Qonekto-Version verschiedene
    // Feldmengen. Zusammengeführt bleibt die Akte auch bei Teilantworten nutzbar.
    if (listed.source !== 'iva') {
      detail.customer = {
        ...listed,
        ...(detail.customer || {}),
        id: detail.customer?.id || listed.id,
        name: detail.customer?.name && !/^Kunde\b/.test(detail.customer.name) ? detail.customer.name : listed.name,
        raw: { ...(listed.raw || {}), ...(detail.customer?.raw || {}) },
      };
    }
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
  $('transferLocalCustomerBtn')?.addEventListener('click', prepareLocalCustomerTransfer);
  $('editAddressBtn')?.addEventListener('click', openAddressDialog);
  $('deleteLocalCustomerBtn')?.addEventListener('click', deleteLocalCustomer);
  $('messageCompanyBtn')?.addEventListener('click', openMessageDialog);
  $('uploadDocumentBtn')?.addEventListener('click', openDocumentDialog);
  $('addDocumentInline')?.addEventListener('click', openDocumentDialog);
  $('tmbAssistantBtn')?.addEventListener('click', openTmbAssistant);
  $('newConsultationBtn')?.addEventListener('click', openConsultation);
  $('lumitApplicationBtn')?.addEventListener('click', openLumitDialog);
  $('saveNoteBtn')?.addEventListener('click', saveNote);
  document.querySelectorAll('.open-file').forEach(button => button.addEventListener('click', () => openLocalFile(button.dataset.fileId)));
}

function currentCustomer() {
  return state.current?.detail?.customer || state.current?.customer || null;
}

async function removeLocalCustomerWorkspace(workspace, customerName) {
  await api(`/api/workspaces/${encodeURIComponent(workspace.id)}?mode=kunde`, { method: 'DELETE' });
  state.workspaces = state.workspaces.filter(item => item.id !== workspace.id);
  state.customers = state.customers.filter(item => item.id !== `local:${workspace.id}`);
  if (state.current?.listId === `local:${workspace.id}` || state.currentWorkspace?.id === workspace.id) {
    state.current = null;
    state.currentWorkspace = null;
    $('customerDetail').hidden = true;
    $('customerDetail').innerHTML = '';
    $('emptyState').hidden = false;
  }
  renderCustomerList();
  showNotice(`Die IVA-Kundenakte „${customerName || workspace.title}“ einschließlich ihrer lokalen Dokumente und Notizen wurde gelöscht. Pipedrive, Qonekto und Blau Direkt blieben unverändert.`, 'success');
}

async function quickDeleteLocalCustomer(customer) {
  const workspace = customer?.workspace;
  if (!workspace?.id || customer.source !== 'iva') return;
  const customerName = customer.name || workspace.title;
  const confirmed = window.confirm(`IVA-Kundenakte „${customerName}“ wirklich dauerhaft löschen?\n\nDabei werden diese IVA-Akte sowie ihre lokalen Dokumente und Notizen entfernt. Pipedrive, Qonekto und Blau Direkt bleiben unverändert.`);
  if (!confirmed) return;
  try {
    await removeLocalCustomerWorkspace(workspace, customerName);
  } catch (error) {
    showNotice(`IVA-Kundenakte „${customerName}“ konnte nicht gelöscht werden: ${error.message}`, 'error');
  }
}

async function deleteLocalCustomer() {
  const workspace = state.currentWorkspace;
  const customer = currentCustomer();
  if (!workspace?.id || state.current?.detail?.source !== 'iva') return;
  const customerName = customer?.name || workspace.title;
  const confirmed = window.confirm(`IVA-Kundenakte „${customerName}“ wirklich dauerhaft löschen?\n\nDabei werden diese IVA-Akte sowie ihre lokalen Dokumente und Notizen entfernt. Pipedrive, Qonekto und Blau Direkt bleiben unverändert.`);
  if (!confirmed) return;
  try {
    await removeLocalCustomerWorkspace(workspace, customerName);
  } catch (error) { showNotice(`IVA-Kundenakte konnte nicht gelöscht werden: ${error.message}`, 'error'); }
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

function showSelectedDocumentFiles(files) {
  pendingDocumentFiles = [...(files || [])].slice(0, 20);
  const container = $('selectedDocumentFiles');
  if (!container) return;
  container.innerHTML = pendingDocumentFiles.length
    ? pendingDocumentFiles.map(file => `<div class="selected-file">${escapeHtml(file.name)} · ${escapeHtml(formatFileSize(file.size))}</div>`).join('')
    : '<div class="muted">Noch keine Dateien ausgewählt · maximal 25 MB je Datei</div>';
}

function openDocumentDialog() {
  $('documentCategory').value = 'general';
  $('documentInput').value = '';
  showSelectedDocumentFiles([]);
  $('documentDialog').showModal();
}

function closeDocumentDialog() {
  $('documentDialog').close();
  $('documentInput').value = '';
  showSelectedDocumentFiles([]);
}

async function uploadDocuments(files, category) {
  try {
    const selected = [...(files || [])].slice(0, 20);
    if (!selected.length) throw new Error('Bitte mindestens eine Datei auswählen oder in das Feld ziehen.');
    const workspace = await ensureWorkspace(currentCustomer());
    const completed = [];
    const failed = [];
    for (const [index, file] of selected.entries()) {
      showNotice(`Dokument ${index + 1} von ${selected.length} wird hochgeladen: ${file.name}`);
      try {
        const query = new URLSearchParams({ kind: 'document', category, name: file.name, mime: file.type || 'application/octet-stream' });
        const response = await fetch(`/api/workspaces/${workspace.id}/files?${query}`, {
          method: 'POST', headers: headers({ 'Content-Type': file.type || 'application/octet-stream' }), body: file,
        });
        const json = await response.json().catch(() => null);
        if (!response.ok) throw new Error(json?.error || `HTTP ${response.status}`);
        completed.push(file.name);
      } catch (error) {
        failed.push({ file, error: error.message });
      }
    }
    state.currentWorkspace = await api(`/api/workspaces/${workspace.id}`);
    renderDetail(state.current.detail, state.current.listId);
    if (failed.length) {
      showSelectedDocumentFiles(failed.map(item => item.file));
      showNotice(`${completed.length} gespeichert, ${failed.length} fehlgeschlagen: ${failed.map(item => `${item.file.name} (${item.error})`).join(' · ')}`, 'error');
      return;
    }
    closeDocumentDialog();
    showNotice(`${completed.length} Dokument${completed.length === 1 ? '' : 'e'} wurden unter „${documentCategoryLabel(category)}“ in IVAs Kundenakte abgelegt.`, 'success');
  } catch (error) { showNotice(`Upload fehlgeschlagen: ${error.message}`, 'error'); }
}

function openConsultation() {
  const customer = currentCustomer();
  const query = new URLSearchParams({ customerId: customer.id || '', customerName: customer.name || '', customerEmail: customer.email || '', customerPhone: customer.mobile || customer.phone || '', customerAddress: sourceAddress(customer) });
  window.open(`/advice?${query}`, '_blank', 'noopener');
}

async function openTmbAssistant() {
  const button = $('tmbAssistantBtn');
  if (button) button.disabled = true;
  showNotice('IVA übernimmt vorhandene CRM-, Qonekto- und PLAUD-Angaben in die TMB. Es wird noch nichts versendet.');
  try {
    const customerWorkspace = await ensureWorkspace(currentCustomer());
    const result = await api(`/api/workspaces/${encodeURIComponent(customerWorkspace.id)}/tmb/prepare`, {
      method: 'POST', body: JSON.stringify({ useAi: true }),
    });
    const query = new URLSearchParams({ mode: 'energie', id: result.workspace.id, assistant: '1', from: 'customers' });
    location.href = `/workspace?${query}`;
  } catch (error) {
    showNotice(`TMB konnte nicht vorbereitet werden: ${error.message}`, 'error');
    if (button) button.disabled = false;
  }
}

function openAddressDialog() {
  const customer = currentCustomer();
  const salutationKey = salutationKeyFor(customer);
  if (salutationKey === 'diverse' && customer.salutationId) $('editSalutation').querySelector('option[value="diverse"]').dataset.externalId = clean(customer.salutationId);
  $('editSalutation').value = salutationKey;
  $('editBroker').value = customer.brokerId || DEFAULT_BROKER_ID;
  $('editFirstName').value = customer.firstName || '';
  $('editLastName').value = customer.lastName || '';
  $('editCompany').value = customer.company || '';
  $('editLegalForm').value = customer.legalForm || '';
  $('editEmail').value = customer.email || '';
  $('editPhone').value = customer.mobile || customer.phone || '';
  $('editStreet').value = customer.street || '';
  $('editZip').value = customer.zip || '';
  $('editCity').value = customer.city || '';
  setPartyFields('edit', salutationKey);
  $('editCustomerHint').textContent = state.current?.detail?.source === 'iva'
    ? 'Diese Angaben werden direkt in der lokalen IVA-Kundenakte gespeichert.'
    : 'Die Änderung bei Blau Direkt wird zuerst vorbereitet und erst nach deiner ausdrücklichen Bestätigung ausgeführt.';
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

async function loadLumitConfig() {
  if (!state.lumitConfig) state.lumitConfig = await api('/api/lumit/config');
  return state.lumitConfig;
}

async function openLumitDialog() {
  try {
    const config = await loadLumitConfig();
    state.lumitApplication = null;
    $('lumitStartMode').value = 'immediate';
    $('lumitRequestedStartDate').value = new Date().toLocaleDateString('sv-SE');
    $('lumitRequestedStartDate').disabled = true;
    $('lumitOperationalReadinessDate').value = '';
    $('lumitApplicationNumber').value = '';
    $('lumitApplicationPdf').value = '';
    $('lumitCompletionConfirmed').checked = false;
    $('lumitAgencyConfirmed').checked = false;
    $('lumitBrokerConfirmed').checked = false;
    $('lumitDigitalDeliveryConsent').checked = false;
    $('lumitAgency').textContent = config.agency.display;
    $('lumitBroker').textContent = config.brokerNumber;
    $('lumitEmail').textContent = config.submissionEmail;
    $('lumitResult').hidden = true;
    $('lumitResult').innerHTML = '';
    $('lumitPolicyPdf').value = '';
    $('lumitPolicyNumber').value = '';
    $('lumitTotalPrice').value = '';
    $('lumitInsurancePremium').value = '';
    $('lumitServiceFee').value = '';
    $('lumitCustomerSalutation').value = 'neutral';
    $('lumitInsuredTechnologies').value = '';
    $('lumitPropertyInsuranceIncluded').checked = false;
    $('lumitPropertyHazardsIncluded').checked = false;
    $('lumitYieldLossIncluded').checked = false;
    $('lumitOperatorLiabilityIncluded').checked = false;
    $('lumitAssemblyCoverIncluded').checked = false;
    $('lumitTrustBadge1').value = '';
    $('lumitTrustBadge2').value = '';
    $('lumitPolicyReviewed').checked = false;
    $('lumitPackageResult').hidden = true;
    $('lumitPackageResult').innerHTML = '';
    const customer = currentCustomer();
    if (customer?.id) {
      const existing = await api(`/api/lumit/applications?customerId=${encodeURIComponent(customer.id)}&limit=1`);
      state.lumitApplication = existing?.[0] || null;
    }
    renderLumitPackageSection();
    $('lumitDialog').showModal();
  } catch (error) { showNotice(`LUMIT-Ablauf konnte nicht geladen werden: ${error.message}`, 'error'); }
}

function renderLumitPackageSection() {
  const application = state.lumitApplication;
  const section = $('lumitPackageSection');
  section.hidden = !application;
  if (!application) return;
  $('lumitPackageApplication').textContent = `${application.label} · ${application.applicationNumber || application.applicationFileName}`;
  const result = $('lumitPackageResult');
  const packageDocument = application.customerPackage;
  $('approveLumitCustomerPackage').hidden = !packageDocument?.documentId || application.steps?.customerPackageApproved === true;
  if (!packageDocument?.documentId) return;
  result.hidden = false;
  result.innerHTML = '';
  const status = document.createElement('strong');
  status.textContent = application.steps?.customerPackageApproved ? 'Kundenpaket geprüft und freigegeben.' : 'Kundenpaket erstellt – Freigabe noch offen.';
  const note = document.createElement('p');
  note.textContent = 'Die Mannheimer-Originalpolice ist unverändert enthalten und bleibt zusätzlich separat in der Kundenakte. Es wurde nichts an den Kunden versendet.';
  const download = document.createElement('a');
  download.className = 'btn';
  download.target = '_blank';
  download.rel = 'noopener';
  download.href = `/api/workspaces/${encodeURIComponent(application.workspaceId)}/files/${encodeURIComponent(packageDocument.documentId)}`;
  download.textContent = 'Gesamtdokument prüfen';
  result.append(status, note, download);
}

async function openLumitCalculator() {
  try {
    const config = await loadLumitConfig();
    window.open(config.calculatorUrl, '_blank', 'noopener');
  } catch (error) { showNotice(`Mannheimer-Rechner konnte nicht geöffnet werden: ${error.message}`, 'error'); }
}

async function createLumitPostProcess() {
  const customer = currentCustomer();
  const file = $('lumitApplicationPdf').files?.[0];
  if (!customer?.id) return showNotice('Der Kunde muss zuerst in Qonekto/Blau Direkt angelegt sein.', 'error');
  if (!file || file.type !== 'application/pdf') return showNotice('Bitte das nach Abschluss erzeugte Antrags-PDF auswählen.', 'error');
  if (!$('lumitCompletionConfirmed').checked || !$('lumitAgencyConfirmed').checked || !$('lumitBrokerConfirmed').checked || !$('lumitDigitalDeliveryConsent').checked) {
    return showNotice('Bitte Onlineabschluss, Nummern und Einwilligung zur digitalen Policenzustellung vollständig kontrollieren.', 'error');
  }
  $('createLumitPostProcess').disabled = true;
  try {
    const workspace = await ensureWorkspace(customer);
    const query = new URLSearchParams({ kind: 'lumit-application', name: file.name, mime: 'application/pdf' });
    const uploadResponse = await fetch(`/api/workspaces/${workspace.id}/files?${query}`, {
      method: 'POST', headers: headers({ 'Content-Type': 'application/pdf' }), body: file,
    });
    const storedFile = await uploadResponse.json().catch(() => null);
    if (!uploadResponse.ok) throw new Error(storedFile?.error || `PDF-Upload HTTP ${uploadResponse.status}`);

    const application = await api('/api/lumit/applications', {
      method: 'POST',
      body: JSON.stringify({
        customerId: customer.id,
        customerName: customer.name,
        workspaceId: workspace.id,
        applicationDocumentId: storedFile.id,
        applicationFileName: storedFile.name,
        applicationNumber: clean($('lumitApplicationNumber').value),
        requestedStartMode: clean($('lumitStartMode').value),
        requestedStartDate: clean($('lumitRequestedStartDate').value),
        operationalReadinessDate: clean($('lumitOperationalReadinessDate').value),
        completionConfirmed: true,
        agencyNumberConfirmed: true,
        brokerNumberConfirmed: true,
        policyDigitalDeliveryConsentConfirmed: true,
      }),
    });
    state.lumitApplication = application;
    state.currentWorkspace = await api(`/api/workspaces/${workspace.id}`);
    const result = $('lumitResult');
    result.hidden = false;
    result.innerHTML = '';
    const title = document.createElement('strong');
    title.textContent = application.duplicate ? 'Dieser Nachprozess war bereits angelegt.' : 'IVA-Nachprozess wurde angelegt.';
    const copy = document.createElement('p');
    copy.textContent = `Noch offen: E-Mail an ${application.submissionEmail}, Anlage als „${application.label}“, PDF-Upload und Bestätigung des digitalen Policenwegs. Nach Policeneingang folgen Hauswertschutz-Prüfung, Kundenpaket und deine ausdrückliche Freigabe. IVA leitet nichts automatisch an den Kunden weiter.`;
    const mail = document.createElement('a');
    mail.className = 'btn';
    mail.href = application.handoff.mailto;
    mail.textContent = 'E-Mail-Entwurf öffnen';
    result.append(title, copy, mail);
    renderLumitPackageSection();
    renderDetail(state.current.detail, state.current.listId);
    showNotice('LUMIT-PDF gespeichert und Nachprozess vorbereitet. E-Mail und Blau-direkt-Anlage sind noch offen.', 'success');
  } catch (error) { showNotice(`LUMIT-Nachprozess konnte nicht angelegt werden: ${error.message}`, 'error'); }
  finally { $('createLumitPostProcess').disabled = false; }
}

async function uploadLumitWorkspaceFile(workspaceId, file, kind) {
  const query = new URLSearchParams({ kind, name: file.name, mime: file.type || 'application/octet-stream' });
  const response = await fetch(`/api/workspaces/${workspaceId}/files?${query}`, {
    method: 'POST', headers: headers({ 'Content-Type': file.type || 'application/octet-stream' }), body: file,
  });
  const stored = await response.json().catch(() => null);
  if (!response.ok) throw new Error(stored?.error || `Datei-Upload HTTP ${response.status}`);
  return stored;
}

async function createLumitCustomerPackage() {
  const application = state.lumitApplication;
  const policy = $('lumitPolicyPdf').files?.[0];
  const trustBadgeFiles = [$('lumitTrustBadge1').files?.[0], $('lumitTrustBadge2').files?.[0]].filter(Boolean);
  if (!application?.id) return showNotice('Zuerst muss der servicierte LUMIT-Antrag angelegt sein.', 'error');
  if (!policy || policy.type !== 'application/pdf') return showNotice('Bitte die unveränderte Mannheimer-Originalpolice als PDF auswählen.', 'error');
  if (!clean($('lumitInsuredTechnologies').value)) return showNotice('Bitte die in der Police versicherte Energietechnik eintragen.', 'error');
  if (!$('lumitPolicyReviewed').checked) return showNotice('Bitte die Hauswertschutz-Prüfung der Police ausdrücklich bestätigen.', 'error');
  if (!$('lumitOfficialScopeConfirmed').checked) return showNotice('Bitte den konkreten Versicherungsumfang mit Police und besonderen Vereinbarungen abgleichen und bestätigen.', 'error');
  $('createLumitCustomerPackage').disabled = true;
  try {
    const policyStored = await uploadLumitWorkspaceFile(application.workspaceId, policy, 'lumit-policy-original');
    const trustBadgeStored = [];
    for (const badge of trustBadgeFiles) trustBadgeStored.push(await uploadLumitWorkspaceFile(application.workspaceId, badge, 'lumit-brand-asset'));
    const packageResult = await api(`/api/lumit/applications/${encodeURIComponent(application.id)}/customer-package`, {
      method: 'POST',
      body: JSON.stringify({
        policyDocumentId: policyStored.id,
        policyReviewedByHauswertschutz: true,
        policyNumber: clean($('lumitPolicyNumber').value),
        totalPrice: clean($('lumitTotalPrice').value),
        insurancePremium: clean($('lumitInsurancePremium').value),
        serviceFee: clean($('lumitServiceFee').value),
        billingPeriod: clean($('lumitBillingPeriod').value),
        servicePackageName: clean($('lumitServicePackageName').value),
        customerSalutation: clean($('lumitCustomerSalutation').value),
        claimsWhatsapp: clean($('lumitClaimsWhatsapp').value),
        claimsEmail: clean($('lumitClaimsEmail').value),
        claimsAvailability: clean($('lumitClaimsAvailability').value),
        claimsServiceHours: clean($('lumitClaimsServiceHours').value),
        claimsChannelsReady: $('lumitClaimsChannelsReady').checked,
        insuredTechnologies: clean($('lumitInsuredTechnologies').value),
        propertyInsuranceIncluded: $('lumitPropertyInsuranceIncluded').checked,
        propertyHazardsIncluded: $('lumitPropertyHazardsIncluded').checked,
        yieldLossIncluded: $('lumitYieldLossIncluded').checked,
        operatorLiabilityIncluded: $('lumitOperatorLiabilityIncluded').checked,
        assemblyCoverIncluded: $('lumitAssemblyCoverIncluded').checked,
        officialScopeConfirmed: $('lumitOfficialScopeConfirmed').checked,
        trustBadgeDocumentIds: trustBadgeStored.map(item => item.id),
      }),
    });
    state.lumitApplication = packageResult.application;
    state.currentWorkspace = await api(`/api/workspaces/${application.workspaceId}`);
    renderLumitPackageSection();
    renderDetail(state.current.detail, state.current.listId);
    showNotice('Hauswertschutz-Gesamtdokument erstellt. Es ist noch nicht freigegeben und wurde nicht versendet.', 'success');
  } catch (error) { showNotice(`Kundenpaket konnte nicht erstellt werden: ${error.message}`, 'error'); }
  finally { $('createLumitCustomerPackage').disabled = false; }
}

async function approveLumitCustomerPackage() {
  const application = state.lumitApplication;
  if (!application?.customerPackage?.documentId) return showNotice('Es gibt noch kein Kundenpaket zur Freigabe.', 'error');
  $('approveLumitCustomerPackage').disabled = true;
  try {
    state.lumitApplication = await api(`/api/lumit/applications/${encodeURIComponent(application.id)}/steps/customerPackageApproved`, {
      method: 'PATCH', body: JSON.stringify({ completed: true }),
    });
    renderLumitPackageSection();
    showNotice('Kundenpaket freigegeben. IVA hat es weiterhin nicht automatisch versendet.', 'success');
  } catch (error) { showNotice(`Freigabe fehlgeschlagen: ${error.message}`, 'error'); }
  finally { $('approveLumitCustomerPackage').disabled = false; }
}

async function loadReferences() {
  if (state.references) return state.references;
  try {
    state.references = await api('/api/customers/references');
  } catch (error) {
    showNotice(`Qonekto-Referenzdaten konnten nicht geladen werden: ${error.message}. Eine lokale IVA-Kundenakte ist trotzdem möglich.`, 'error');
    state.references = { salutations: [], brokers: [] };
  }
  populateCustomerReferences();
  return state.references;
}

function referenceOptionLabel(item, kind) {
  const id = clean(item?.id);
  let label = clean(item?.label);
  if (!label || label === id || /^\d+$/.test(label)) {
    if (kind === 'salutation') label = KNOWN_SALUTATION_LABELS[id] || `Weitere Anrede (ID ${id})`;
    else if (kind === 'broker' && id === DEFAULT_BROKER_ID) label = 'Nadine Sell';
    else label = id;
  }
  return `${label}${label === id ? '' : ` · ${id}`}`;
}

function populateCustomerReferences() {
  const diverseReference = (state.references?.salutations || []).find(item => /divers|nicht.?bin/i.test(clean(item.label)));
  for (const select of [$('newSalutation'), $('editSalutation')]) {
    const diverseOption = select?.querySelector('option[value="diverse"]');
    if (diverseOption && diverseReference?.id) diverseOption.dataset.externalId = clean(diverseReference.id);
  }

  const brokers = [...(state.references?.brokers || [])];
  if (!brokers.some(item => clean(item.id) === DEFAULT_BROKER_ID)) brokers.unshift({ id: DEFAULT_BROKER_ID, label: 'Nadine Sell' });
  const brokerSelect = $('newBroker');
  brokerSelect.innerHTML = '';
  for (const item of brokers) {
    const option = document.createElement('option');
    option.value = clean(item.id);
    option.textContent = referenceOptionLabel(item, 'broker');
    brokerSelect.appendChild(option);
  }
  brokerSelect.value = DEFAULT_BROKER_ID;
}

function salutationKeyFor(customer = {}) {
  if (SALUTATION_LABELS[customer.salutationKey]) return customer.salutationKey;
  if (clean(customer.salutationId) === '1') return 'male';
  if (clean(customer.salutationId) === '2') return 'female';
  if (clean(customer.salutationId) === '7') return 'company';
  const value = clean(customer.salutation).toLocaleLowerCase('de');
  if (customer.company || /firma|unternehmen|company/.test(value)) return 'company';
  if (/frau|weiblich|female/.test(value)) return 'female';
  if (/divers|nicht.?bin/.test(value)) return 'diverse';
  if (/herr|mann|männlich|male/.test(value)) return 'male';
  return '';
}

function setPartyFields(prefix, key = '') {
  const company = key === 'company';
  $(`${prefix}FirstNameField`).hidden = company;
  $(`${prefix}LastNameField`).hidden = company;
  $(`${prefix}CompanyField`).hidden = !company;
  $(`${prefix}LegalFormField`).hidden = !company;
  $(`${prefix}LastName`).required = !company;
  $(`${prefix}Company`).required = company;
  $(`${prefix}LegalForm`).required = company;
}

function externalSalutationId(prefix) {
  return clean($(`${prefix}Salutation`).selectedOptions[0]?.dataset.externalId);
}

async function openNewCustomer() {
  $('newCustomerForm').reset();
  hideAddressSuggestions();
  $('newTransferToQonekto').checked = false;
  setPartyFields('new', '');
  if ($('newBroker').querySelector(`option[value="${DEFAULT_BROKER_ID}"]`)) $('newBroker').value = DEFAULT_BROKER_ID;
  $('newCustomerDialog').showModal();
  await loadReferences();
  $('newBroker').value = DEFAULT_BROKER_ID;
}

function closeNewCustomerDialog() {
  clearTimeout(state.addressSearchTimer);
  hideAddressSuggestions();
  $('newCustomerForm').reset();
  if ($('newCustomerDialog').open) $('newCustomerDialog').close();
}

function hideAddressSuggestions() {
  const root = $('addressSuggestions');
  root.hidden = true;
  root.innerHTML = '';
  $('newStreet').setAttribute('aria-expanded', 'false');
}

function renderAddressSuggestions(suggestions = [], { loading = false } = {}) {
  const root = $('addressSuggestions');
  root.innerHTML = '';
  if (loading) {
    root.innerHTML = '<div class="address-empty">Passende Adressen werden gesucht …</div>';
  } else if (!suggestions.length) {
    root.innerHTML = '<div class="address-empty">Keine eindeutige Adresse gefunden. Du kannst die Felder weiterhin manuell ausfüllen.</div>';
  } else {
    for (const suggestion of suggestions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'address-suggestion';
      button.setAttribute('role', 'option');
      const title = document.createElement('b');
      title.textContent = suggestion.label;
      const detail = document.createElement('small');
      detail.textContent = [suggestion.district, suggestion.state].filter(Boolean).join(' · ');
      button.append(title, detail);
      button.addEventListener('click', () => applyAddressSuggestion(suggestion));
      root.appendChild(button);
    }
  }
  root.hidden = false;
  $('newStreet').setAttribute('aria-expanded', 'true');
}

function addressSearchQuery() {
  return [clean($('newStreet').value), clean($('newZip').value), clean($('newCity').value)].filter(Boolean).join(' ');
}

function queueAddressSuggestions() {
  clearTimeout(state.addressSearchTimer);
  const query = addressSearchQuery();
  if (!$('newCustomerDialog').open || query.length < 4) return hideAddressSuggestions();
  state.addressSearchTimer = setTimeout(() => loadAddressSuggestions(query), 350);
}

async function loadAddressSuggestions(query) {
  const serial = ++state.addressSearchSerial;
  renderAddressSuggestions([], { loading: true });
  try {
    const result = await api(`/api/address-suggestions?q=${encodeURIComponent(query)}&limit=6`);
    if (serial !== state.addressSearchSerial || query !== addressSearchQuery()) return;
    renderAddressSuggestions(result.suggestions || []);
  } catch {
    if (serial !== state.addressSearchSerial) return;
    hideAddressSuggestions();
  }
}

function applyAddressSuggestion(suggestion) {
  $('newStreet').value = suggestion.streetLine || [suggestion.street, suggestion.houseNumber].filter(Boolean).join(' ');
  $('newZip').value = suggestion.postcode || '';
  $('newCity').value = suggestion.city || '';
  hideAddressSuggestions();
  $('newEmail').focus();
}

function newCustomerValues() {
  const salutationKey = clean($('newSalutation').value);
  return {
    anrede_id: externalSalutationId('new'),
    vermittler_id: clean($('newBroker').value),
    vorname: salutationKey === 'company' ? '' : clean($('newFirstName').value),
    nachname: salutationKey === 'company' ? '' : clean($('newLastName').value),
    firma: salutationKey === 'company' ? clean($('newCompany').value) : '',
    rechtsform: salutationKey === 'company' ? clean($('newLegalForm').value) : '',
    strasse: clean($('newStreet').value),
    plz: clean($('newZip').value),
    ort: clean($('newCity').value),
    kommunikation: { email: clean($('newEmail').value), telefon: clean($('newPhone').value) },
  };
}

function newCustomerLabels() {
  const salutationKey = clean($('newSalutation').value);
  return {
    salutation: SALUTATION_LABELS[salutationKey] || '',
    salutationKey,
    broker: clean($('newBroker').selectedOptions[0]?.textContent).replace(/\s+·\s+\S+$/, ''),
  };
}

async function patchLocalWorkspace(workspaceId, patch) {
  const updated = await api(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: 'PATCH', body: JSON.stringify(patch),
  });
  const workspaceIndex = state.workspaces.findIndex(item => item.id === workspaceId);
  if (workspaceIndex >= 0) state.workspaces[workspaceIndex] = updated;
  if (state.currentWorkspace?.id === workspaceId) state.currentWorkspace = updated;
  const customerIndex = state.customers.findIndex(item => item.id === `local:${workspaceId}`);
  if (customerIndex >= 0) state.customers[customerIndex] = localCustomer(updated);
  return updated;
}

async function saveLocalCustomer() {
  const values = newCustomerValues();
  const form = $('newCustomerForm');
  if (!form.reportValidity()) return;
  const transferRequested = $('newTransferToQonekto').checked;
  const labels = newCustomerLabels();
  $('saveLocalCustomer').disabled = true;
  try {
    const name = values.firma || [values.vorname, values.nachname].filter(Boolean).join(' ');
    const now = new Date().toISOString();
    const workspace = await api('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'kunde', title: `${name} · Kundenakte`,
        status: 'active',
        customer: {
          name, salutationKey: labels.salutationKey, salutation: labels.salutation,
          firstName: values.vorname, lastName: values.nachname, company: values.firma, legalForm: values.rechtsform,
          email: values.kommunikation.email, phone: values.kommunikation.telefon,
          street: values.strasse, zip: values.plz, city: values.ort, brokerId: values.vermittler_id,
          address: [values.strasse, [values.plz, values.ort].filter(Boolean).join(' ')].filter(Boolean).join(', '),
        },
        data: {
          project: 'Goals & Concepts', company: values.firma || '',
          relationship: transferRequested ? 'IVA-Kundenakte · Qonekto-Übertragung vorbereitet' : 'IVA-Kundenakte · noch nicht in Qonekto angelegt',
          nextStep: transferRequested ? 'Qonekto-Anlage ausdrücklich bestätigen' : 'Bei Bedarf an Blau Direkt übertragen',
          qonektoDraft: values,
          qonektoLabels: labels,
          qonektoSync: { requested: transferRequested, status: transferRequested ? 'preparing' : 'local-only', updatedAt: now },
        },
      }),
    });
    state.workspaces.unshift(workspace);
    const customer = localCustomer(workspace);
    state.customers.push(customer);
    state.customers.sort((a, b) => clean(a.name).localeCompare(clean(b.name), 'de'));
    closeNewCustomerDialog();
    renderCustomerList();
    await openCustomer(customer.id);
    if (!transferRequested) {
      showNotice('Kundenakte wurde vollständig in IVA gespeichert. An Blau Direkt wurde nichts übertragen.', 'success');
      return;
    }
    if (!values.anrede_id) {
      await patchLocalWorkspace(workspace.id, {
        data: { qonektoSync: { requested: false, status: 'local-only', updatedAt: new Date().toISOString() }, relationship: 'IVA-Kundenakte · noch nicht in Qonekto angelegt', nextStep: 'Qonekto-Anrede für Divers prüfen und Übertragung erneut starten' },
      });
      showNotice('Die IVA-Kundenakte wurde gespeichert. Für „Divers“ hat Qonekto keine eindeutige Anrede-ID geliefert; deshalb wurde noch nichts übertragen.', 'error');
      return;
    }
    const prepared = await prepareAction('create-customer', '', values, { workspaceId: workspace.id, values, labels });
    if (!prepared) {
      await patchLocalWorkspace(workspace.id, {
        data: { qonektoSync: { requested: true, status: 'prepare-failed', updatedAt: new Date().toISOString() }, nextStep: 'Qonekto-Übertragung erneut vorbereiten' },
      });
    }
  } catch (error) { showNotice(`Kundenakte konnte nicht gespeichert werden: ${error.message}`, 'error'); }
  finally { $('saveLocalCustomer').disabled = false; }
}

async function prepareAction(kind, customerId, values, context = null) {
  try {
    state.prepared = await api('/api/customers/actions/prepare', {
      method: 'POST',
      body: JSON.stringify({ sessionId: state.sessionId, kind, customerId, values }),
    });
    const pre = document.createElement('pre');
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.wordBreak = 'break-word';
    const preview = kind === 'create-customer' && context?.labels
      ? { ...values, anrede: context.labels.salutation, vermittler: `${context.labels.broker} · ${values.vermittler_id}` }
      : (state.prepared.changes || values);
    pre.textContent = JSON.stringify(preview, null, 2);
    $('confirmSummary').innerHTML = '';
    $('confirmSummary').appendChild(pre);
    $('newCustomerDialog').open && $('newCustomerDialog').close();
    $('addressDialog').open && $('addressDialog').close();
    state.preparedContext = { kind, customerId, values, ...(context || {}) };
    $('confirmDialog').showModal();
    if (context?.workspaceId) {
      await patchLocalWorkspace(context.workspaceId, {
        data: { qonektoSync: { requested: true, status: 'awaiting-confirmation', updatedAt: new Date().toISOString() }, nextStep: 'Qonekto-Anlage ausdrücklich bestätigen' },
      });
    }
    return true;
  } catch (error) {
    showNotice(`Qonekto-Aktion konnte nicht vorbereitet werden: ${error.message}`, 'error');
    return false;
  }
}

async function prepareLocalCustomerTransfer() {
  const workspace = state.currentWorkspace;
  const values = workspaceQonektoDraft(workspace);
  if (!workspace?.id || (!values.nachname && !values.firma)) return showNotice('In dieser IVA-Akte fehlen die gespeicherten Qonekto-Stammdaten.', 'error');
  if (!values.anrede_id) return showNotice('Vor der Übertragung muss in der Kundenakte eine Anrede ergänzt werden.', 'error');
  const labels = workspace.data?.qonektoLabels || {};
  await prepareAction('create-customer', '', values, { workspaceId: workspace.id, values, labels });
}

function editCustomerValues() {
  const salutationKey = clean($('editSalutation').value);
  return {
    anrede_id: externalSalutationId('edit'),
    vermittler_id: clean($('editBroker').value) || DEFAULT_BROKER_ID,
    vorname: salutationKey === 'company' ? '' : clean($('editFirstName').value),
    nachname: salutationKey === 'company' ? '' : clean($('editLastName').value),
    firma: salutationKey === 'company' ? clean($('editCompany').value) : '',
    rechtsform: salutationKey === 'company' ? clean($('editLegalForm').value) : '',
    strasse: clean($('editStreet').value),
    plz: clean($('editZip').value),
    ort: clean($('editCity').value),
    kommunikation: { email: clean($('editEmail').value), telefon: clean($('editPhone').value) },
  };
}

async function prepareAddress() {
  const form = $('addressDialog').querySelector('form');
  if (!form.reportValidity()) return;
  const customer = currentCustomer();
  const values = editCustomerValues();
  const salutationKey = clean($('editSalutation').value);
  const salutation = SALUTATION_LABELS[salutationKey] || '';
  if (state.current?.detail?.source !== 'iva') {
    await prepareAction('update-customer', customer.id, values);
    return;
  }
  const workspace = state.currentWorkspace;
  if (!workspace?.id) return showNotice('Die lokale IVA-Kundenakte wurde nicht gefunden.', 'error');
  const name = values.firma || [values.vorname, values.nachname].filter(Boolean).join(' ');
  try {
    const updated = await patchLocalWorkspace(workspace.id, {
      title: `${name} · Kundenakte`, status: 'active',
      customer: {
        name, salutationKey, salutation, firstName: values.vorname, lastName: values.nachname,
        company: values.firma, legalForm: values.rechtsform, email: values.kommunikation.email,
        phone: values.kommunikation.telefon, street: values.strasse, zip: values.plz, city: values.ort,
        brokerId: values.vermittler_id,
        address: [values.strasse, [values.plz, values.ort].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      },
      data: {
        company: values.firma,
        qonektoDraft: values,
        qonektoLabels: { salutation, salutationKey, broker: values.vermittler_id === DEFAULT_BROKER_ID ? 'Nadine Sell' : '' },
      },
    });
    const local = localCustomer(updated);
    state.current.customer = local;
    state.current.detail = localDetail(updated);
    $('addressDialog').close();
    renderCustomerList();
    renderDetail(state.current.detail, state.current.listId);
    showNotice('Kontaktdaten wurden in der IVA-Kundenakte gespeichert.', 'success');
  } catch (error) { showNotice(`Kontaktdaten konnten nicht gespeichert werden: ${error.message}`, 'error'); }
}

async function executePreparedAction() {
  if (!state.prepared) return;
  $('executeConfirm').disabled = true;
  try {
    const context = state.preparedContext;
    const result = await api('/api/customers/actions/confirm', {
      method: 'POST',
      body: JSON.stringify({ sessionId: state.sessionId, confirmation: state.prepared.confirmationPhrase }),
    });
    $('confirmDialog').close();
    state.prepared = null;
    state.preparedContext = null;
    if (result.ok && context?.workspaceId && context.kind === 'create-customer') {
      await linkCreatedWorkspace(context.workspaceId, context.values);
    }
    showNotice(result.message, result.ok ? 'success' : 'error');
    await loadCustomers({ force: true, keepSelection: true });
  } catch (error) { showNotice(`Änderung wurde nicht ausgeführt: ${error.message}`, 'error'); }
  finally { $('executeConfirm').disabled = false; }
}

async function linkCreatedWorkspace(workspaceId, values) {
  let matched = null;
  try {
    const search = clean(values?.kommunikation?.email) || clean(values?.nachname);
    const response = await api(`/api/customers?limit=25&search=${encodeURIComponent(search)}&force=1`);
    const expectedEmail = clean(values?.kommunikation?.email).toLocaleLowerCase('de');
    const expectedName = clean([values?.vorname, values?.nachname].filter(Boolean).join(' ')).toLocaleLowerCase('de');
    const candidates = (response.customers || []).filter(customer => {
      if (expectedEmail && clean(customer.email).toLocaleLowerCase('de') === expectedEmail) return true;
      return expectedName && clean(customer.name).toLocaleLowerCase('de') === expectedName;
    });
    if (candidates.length === 1) matched = candidates[0];
  } catch { /* Die Anlage ist erfolgt; Verknüpfung kann beim nächsten Abgleich nachgeholt werden. */ }
  const updatedAt = new Date().toISOString();
  await patchLocalWorkspace(workspaceId, {
    customer: matched?.id ? { id: matched.id } : {},
    data: {
      relationship: matched?.id ? 'Qonekto / Blau Direkt' : 'Qonekto-Anlage ausgeführt · ID-Abgleich offen',
      nextStep: matched?.id ? '' : 'Qonekto-Kunden-ID beim nächsten Abgleich verknüpfen',
      qonektoSync: { requested: true, status: matched?.id ? 'linked' : 'submitted', qonektoCustomerId: matched?.id || '', updatedAt },
    },
  });
}

async function cancelPreparedAction() {
  const context = state.preparedContext;
  state.prepared = null;
  state.preparedContext = null;
  $('confirmDialog').close();
  if (context?.workspaceId && context.kind === 'create-customer') {
    try {
      await patchLocalWorkspace(context.workspaceId, {
        data: {
          relationship: 'IVA-Kundenakte · noch nicht in Qonekto angelegt',
          nextStep: 'Bei Bedarf an Blau Direkt übertragen',
          qonektoSync: { requested: false, status: 'local-only', updatedAt: new Date().toISOString() },
        },
      });
    } catch { /* Der Abbruch der externen Aktion bleibt trotzdem wirksam. */ }
  }
  showNotice('Abgebrochen. In Qonekto wurde nichts verändert.');
}

$('customerSearch').addEventListener('input', renderCustomerList);
$('customerSearch').addEventListener('search', renderCustomerList);
$('refreshCustomers').addEventListener('click', () => loadCustomers({ force: true }));
$('newCustomerBtn').addEventListener('click', openNewCustomer);
$('emptyNewBtn').addEventListener('click', openNewCustomer);
$('newCustomerForm').addEventListener('submit', event => { event.preventDefault(); saveLocalCustomer(); });
$('newSalutation').addEventListener('change', event => setPartyFields('new', event.target.value));
$('editSalutation').addEventListener('change', event => setPartyFields('edit', event.target.value));
$('closeNewCustomer').addEventListener('click', closeNewCustomerDialog);
$('cancelNewCustomer').addEventListener('click', closeNewCustomerDialog);
$('newCustomerDialog').addEventListener('cancel', event => { event.preventDefault(); closeNewCustomerDialog(); });
['newStreet', 'newZip', 'newCity'].forEach(id => $(id).addEventListener('input', queueAddressSuggestions));
$('newStreet').addEventListener('keydown', event => {
  if (event.key === 'Escape') hideAddressSuggestions();
  if (event.key === 'ArrowDown') {
    const first = $('addressSuggestions').querySelector('.address-suggestion');
    if (first) { event.preventDefault(); first.focus(); }
  }
});
$('addressSuggestions').addEventListener('keydown', event => {
  if (event.key === 'Escape') { hideAddressSuggestions(); $('newStreet').focus(); }
});
document.addEventListener('click', event => {
  if (!event.target.closest('.address-field')) hideAddressSuggestions();
});
$('prepareAddress').addEventListener('click', prepareAddress);
$('saveMessageDraft').addEventListener('click', saveMessageDraft);
$('openLumitCalculator').addEventListener('click', openLumitCalculator);
$('lumitStartMode').addEventListener('change', event => {
  const specified = event.target.value === 'specified-date';
  $('lumitRequestedStartDate').disabled = !specified;
  if (!$('lumitRequestedStartDate').value) $('lumitRequestedStartDate').value = new Date().toLocaleDateString('sv-SE');
});
$('createLumitPostProcess').addEventListener('click', createLumitPostProcess);
$('createLumitCustomerPackage').addEventListener('click', createLumitCustomerPackage);
$('approveLumitCustomerPackage').addEventListener('click', approveLumitCustomerPackage);
$('executeConfirm').addEventListener('click', executePreparedAction);
$('cancelConfirm').addEventListener('click', cancelPreparedAction);
$('closeConfirm').addEventListener('click', cancelPreparedAction);
$('documentForm').addEventListener('submit', event => {
  event.preventDefault();
  uploadDocuments(pendingDocumentFiles, $('documentCategory').value);
});
$('closeDocumentDialog').addEventListener('click', closeDocumentDialog);
$('cancelDocumentUpload').addEventListener('click', closeDocumentDialog);
$('documentInput').addEventListener('change', event => showSelectedDocumentFiles(event.target.files));
const documentDropzone = $('documentDropzone');
documentDropzone.addEventListener('click', event => {
  if (event.target !== $('documentInput')) $('documentInput').click();
});
documentDropzone.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('documentInput').click(); }
});
for (const eventName of ['dragenter', 'dragover']) documentDropzone.addEventListener(eventName, event => {
  event.preventDefault();
  documentDropzone.classList.add('dragging');
});
for (const eventName of ['dragleave', 'drop']) documentDropzone.addEventListener(eventName, event => {
  event.preventDefault();
  documentDropzone.classList.remove('dragging');
});
documentDropzone.addEventListener('drop', event => showSelectedDocumentFiles(event.dataTransfer?.files));
$('ivaHelper').addEventListener('click', () => window.open('/cockpit', '_blank', 'noopener'));

loadCustomers({ keepSelection: false });
