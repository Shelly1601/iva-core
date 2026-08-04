const LS_TOKEN = 'iva_token';
const params = new URLSearchParams(location.search);
const $ = id => document.getElementById(id);
const state = { catalog: { groups: [], modules: [], connectors: {} }, customers: [], selectedCustomer: null, group: 'all' };

function headers(extra = {}) {
  return { Authorization: 'Bearer ' + (localStorage.getItem(LS_TOKEN) || ''), ...extra };
}

async function api(path, opts = {}) {
  const response = await fetch(path, { ...opts, headers: headers({ 'Content-Type': 'application/json', ...(opts.headers || {}) }) });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(json?.error || ('HTTP ' + response.status));
  return json;
}

function clean(value) { return String(value ?? '').trim(); }
function escapeHtml(value) { return clean(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }

function queryCustomer() {
  if (!params.get('customerId') && !params.get('customerName')) return null;
  return { id: clean(params.get('customerId')), name: clean(params.get('customerName')) || 'Ausgewählter Kunde', email: clean(params.get('customerEmail')), phone: clean(params.get('customerPhone')), address: clean(params.get('customerAddress')) };
}

function renderCustomerSelect() {
  const select = $('customerSelect');
  select.innerHTML = '<option value="">Kunde später zuordnen</option>';
  for (const customer of state.customers) {
    const option = document.createElement('option');
    option.value = customer.id;
    option.textContent = customer.name + (customer.city ? ` · ${customer.city}` : '');
    select.appendChild(option);
  }
  if (state.selectedCustomer) select.value = state.selectedCustomer.id;
  renderCustomerHint();
}

function renderCustomerHint() {
  const customer = state.selectedCustomer;
  $('customerHint').textContent = customer
    ? `${customer.name}${customer.email ? ' · ' + customer.email : ''}${customer.address ? ' · ' + customer.address : ''}`
    : 'Noch kein Kunde ausgewählt.';
}

async function loadCustomers(force = false) {
  const fromQuery = queryCustomer();
  try {
    const result = await api('/api/customers?limit=100' + (force ? '&force=1' : ''));
    state.customers = Array.isArray(result.customers) ? result.customers : [];
  } catch {
    state.customers = [];
  }
  if (fromQuery && !state.customers.some(customer => customer.id === fromQuery.id)) state.customers.unshift(fromQuery);
  state.selectedCustomer = fromQuery || state.customers.find(customer => customer.id === $('customerSelect')?.value) || null;
  renderCustomerSelect();
}

function renderFilters() {
  const root = $('filters'); root.innerHTML = '';
  const filters = [{ id: 'all', label: 'Alle Module' }, ...state.catalog.groups];
  for (const filter of filters) {
    const button = document.createElement('button');
    button.className = 'filter' + (state.group === filter.id ? ' active' : '');
    const count = filter.id === 'all' ? state.catalog.modules.length : state.catalog.modules.filter(module => module.group === filter.id).length;
    button.innerHTML = `${escapeHtml(filter.label)} <span>${count}</span>`;
    button.addEventListener('click', () => { state.group = filter.id; renderFilters(); renderModules(); });
    root.appendChild(button);
  }
}

function statusClass(module) {
  return module.status === 'ready' ? 'pill' : 'pill warn';
}

function moduleUrl(moduleId) {
  const module = state.catalog.modules.find(item => item.id === moduleId) || {};
  const customer = state.selectedCustomer;
  const launchMode = module.launchMode || 'beratung';
  const query = new URLSearchParams({ mode: launchMode });
  if (launchMode === 'beratung') query.set('adviceType', moduleId);
  if (customer) {
    query.set('customerId', customer.id || ''); query.set('customerName', customer.name || ''); query.set('customerEmail', customer.email || '');
    query.set('customerPhone', customer.mobile || customer.phone || ''); query.set('customerAddress', customer.address || '');
  }
  return '/workspace?' + query;
}

function renderModules() {
  const root = $('moduleGroups'); root.innerHTML = '';
  const groups = state.group === 'all' ? state.catalog.groups : state.catalog.groups.filter(group => group.id === state.group);
  for (const group of groups) {
    const modules = state.catalog.modules.filter(module => module.group === group.id);
    if (!modules.length) continue;
    const section = document.createElement('section');
    section.innerHTML = `<div class="group-head"><h2>${escapeHtml(group.label)}</h2><span>${modules.length} Module</span></div><div class="modules"></div>`;
    const moduleRoot = section.querySelector('.modules');
    for (const module of modules) {
      const article = document.createElement('article');
      article.className = 'module';
      article.innerHTML = `<div class="module-icon">${escapeHtml(module.icon)}</div><h3>${escapeHtml(module.title)}</h3><p>${escapeHtml(module.short)}</p><div class="module-foot"><span class="${statusClass(module)}">${escapeHtml(module.badge)}</span><a class="module-start" href="${escapeHtml(moduleUrl(module.id))}" target="_blank" rel="noopener">Beratung starten →</a></div>`;
      moduleRoot.appendChild(article);
    }
    root.appendChild(section);
  }
}

async function loadCatalog() {
  state.catalog = await api('/api/advice/catalog');
  const requestedGroup = clean(params.get('group'));
  if (state.catalog.groups.some(group => group.id === requestedGroup)) state.group = requestedGroup;
  renderFilters(); renderModules();
  const gkv = state.catalog.connectors?.gkv || {};
  $('gkvDot').classList.toggle('on', Boolean(gkv.configured));
  $('gkvTitle').textContent = gkv.configured ? `${gkv.provider || 'GKV-Portal'} verbunden` : 'Noch nicht verbunden';
  $('gkvCopy').textContent = gkv.configured ? 'Der Vergleichsrechner kann mit der Beratungsakte geöffnet werden.' : 'Benötigt später Anbieter und Start-/API-URL.';
  $('openGkv').hidden = !gkv.configured;
  if (gkv.configured) $('openGkv').href = gkv.launchUrl;
  const energy = state.catalog.connectors?.energyTariffs || {};
  $('energyDot').classList.toggle('on', Boolean(energy.comparisonEnabled));
  $('energyTitle').textContent = energy.comparisonEnabled ? `${energy.provider || 'EnergyPartner'} verbunden` : 'Anbindung vorbereitet';
  $('energyCopy').textContent = energy.reason || 'Tarifanfragen können bereits in der Beratungsakte vorbereitet werden.';
  $('openEnergyPortal').hidden = !energy.launchUrl;
  if (energy.launchUrl) $('openEnergyPortal').href = energy.launchUrl;
}

async function loadRecentCases() {
  try {
    const cases = await api('/api/workspaces?mode=beratung');
    $('recentCases').innerHTML = '';
    if (!cases.length) return $('recentCases').innerHTML = '<div class="muted">Noch keine Beratungsakte.</div>';
    for (const item of cases.slice(0, 8)) {
      const link = document.createElement('a'); link.className = 'case'; link.href = `/workspace?mode=beratung&id=${encodeURIComponent(item.id)}`;
      link.innerHTML = `<b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.customer?.name || 'ohne Kunde')} · ${new Date(item.updatedAt).toLocaleDateString('de-DE')}</small>`;
      $('recentCases').appendChild(link);
    }
  } catch { $('recentCases').innerHTML = '<div class="muted">Nicht verbunden.</div>'; }
}

function renderKnowledge(result) {
  $('knowledgeStatus').textContent = `${result.productDocumentCount} Produktdokumente · ${result.referenceCount} Grundlagen-/Benchmarkquellen`;
  $('knowledgeResults').innerHTML = '';
  for (const source of (result.sources || []).slice(0, 8)) {
    const row = document.createElement('div'); row.className = 'source';
    const title = document.createElement('b'); title.textContent = source.title;
    const detail = document.createElement('small'); detail.textContent = [source.provider, source.tariff, source.year, source.scope].filter(Boolean).join(' · ');
    row.append(title, detail);
    if (source.url) {
      const link = document.createElement('a'); link.href = source.url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Quelle öffnen ↗'; row.appendChild(link);
    } else if (source.providedFile) {
      const file = document.createElement('small'); file.textContent = `Bereitgestellte PDF: ${source.providedFile}`; row.appendChild(file);
    }
    $('knowledgeResults').appendChild(row);
  }
  if (!result.sources?.length) $('knowledgeResults').innerHTML = '<div class="muted">Noch keine passende Originalquelle hinterlegt. Dokument in der Beratungsakte hochladen oder Quelle ergänzen.</div>';
}

async function searchKnowledge() {
  try { renderKnowledge(await api('/api/advice/knowledge?limit=50&search=' + encodeURIComponent($('knowledgeSearch').value))); }
  catch (error) { $('knowledgeStatus').textContent = 'Wissensbibliothek nicht erreichbar: ' + error.message; }
}

$('customerSelect').addEventListener('change', () => { state.selectedCustomer = state.customers.find(customer => customer.id === $('customerSelect').value) || null; renderCustomerHint(); renderModules(); });
$('refreshCustomers').addEventListener('click', () => loadCustomers(true));
$('searchKnowledge').addEventListener('click', searchKnowledge);
$('knowledgeSearch').addEventListener('keydown', event => { if (event.key === 'Enter') searchKnowledge(); });
$('ivaHelper').addEventListener('click', () => window.open('/cockpit', '_blank', 'noopener'));

Promise.all([loadCatalog(), loadCustomers(), loadRecentCases(), searchKnowledge()]).catch(error => {
  $('moduleGroups').innerHTML = `<div class="notice">Beratungsmodule konnten nicht geladen werden: ${escapeHtml(error.message)}</div>`;
});
