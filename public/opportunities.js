const $ = id => document.getElementById(id);
const token = () => localStorage.getItem('iva_token') || '';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const lines = value => String(value || '').split(/\n|,/).map(item => item.trim().replace(/^#/, '')).filter(Boolean);
const money = value => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Number(value) || 0);
let state = { status: null, settings: null, opportunities: [], filter: '' };

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function setBusy(button, busy, text) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy; button.textContent = busy ? text : button.dataset.label;
}

function renderMetrics() {
  const counts = state.status?.counts || {};
  const cards = [
    ['Ideen', counts.opportunities || 0], ['≥ 75 Punkte', counts.highPotential || 0], ['Im Test', counts.validation || 0], ['Scans', counts.runs || 0], ['Übergaben offen', counts.pendingHandoffs || 0],
  ];
  $('metrics').innerHTML = cards.map(([label, value]) => `<div class="metric"><b>${esc(value)}</b><small>${esc(label)}</small></div>`).join('');
}

function renderStatus() {
  const status = state.status || {};
  $('providerDot').className = 'dot' + (status.configured ? ' on' : '');
  $('providerTitle').textContent = status.configured ? 'Instagram-Research ist verbunden' : 'Instagram-Research braucht noch Apify';
  $('providerText').textContent = status.configured ? status.provider : 'Railway-Variable APIFY_TOKEN fehlt noch.';
  $('statusNotice').innerHTML = status.ready
    ? `Wochenlauf aktiv: <b>${esc(status.weekly?.schedule || 'Montag 08:30')}</b>. Der Scan hat ein Kostenlimit und setzt nichts automatisch um.`
    : `Der Bereich ist fertig, aber echte Instagram-Signale starten erst mit <b>APIFY_TOKEN</b>. Bis dahin erfindet IVA bewusst keine Ideen aus dem Nichts.`;
}

function fillSettings() {
  const settings = state.settings || {};
  $('hashtags').value = (settings.hashtags || []).join('\n');
  $('seedAccounts').value = (settings.seedAccounts || []).join('\n');
  $('maxBudget').value = settings.maxInitialBudgetEur ?? 500;
  $('maxSetup').value = settings.maxSetupHours ?? 20;
  $('maxOngoing').value = settings.maxOngoingHoursPerWeek ?? 3;
  $('topIdeas').value = settings.topIdeasPerPitch ?? 5;
  $('notes').value = settings.notes || '';
  $('weeklyEnabled').checked = settings.weeklyEnabled === true;
}

function sourceLinks(item) {
  if (!item.sources?.length) return '<span class="muted">Noch keine direkte Quelle gespeichert</span>';
  return item.sources.map((source, index) => `<a class="source" href="${esc(source.url || '#')}" target="_blank" rel="noopener">${esc(source.account ? '@' + source.account.replace(/^@/, '') : 'Quelle ' + (index + 1))}</a>`).join('');
}

function opportunityCard(item) {
  const high = Number(item.score || 0) >= 75;
  const statusLabel = { new: 'Neu', watch: 'Beobachten', validate: 'Testen', selected: 'Ausgewählt', rejected: 'Verworfen' }[item.status] || item.status;
  return `<article class="opportunity ${high ? 'high' : ''}" data-id="${esc(item.id)}">
    <div class="opp-head"><div><span class="tag ${Number(item.score || 0) < 50 ? 'warn' : ''}">${esc(statusLabel)}</span><h3>${esc(item.title)}</h3><div class="summary">${esc(item.summary)}</div></div><div class="score" style="--score:${Math.max(0, Math.min(100, Number(item.score || 0)))}%"><div><b>${esc(item.score || 0)}</b><small>von 100</small></div></div></div>
    <div class="facts"><div class="fact"><small>Aufbau</small><b>${esc(item.setupHours || 0)} Std.</b></div><div class="fact"><small>Laufend</small><b>${esc(item.ongoingHoursPerWeek || 0)} Std./Woche</b></div><div class="fact"><small>Startbudget</small><b>${esc(money(item.initialBudgetEur))}</b></div></div>
    <div class="section"><b>Modell</b><p>${esc(item.offer || item.monetization || 'noch zu schärfen')}</p></div>
    <div class="section"><b>KI-Hebel</b><p>${esc(item.aiLeverage || 'noch zu prüfen')}</p></div>
    <div class="section"><b>7-Tage-Test</b><p>${esc(item.firstValidation || 'noch festzulegen')}</p></div>
    <div class="section"><b>Belege & Grenzen</b><p>${esc(item.evidence || 'noch nicht ausreichend belegt')}</p>${item.evidenceLimits ? `<p class="muted">Grenze: ${esc(item.evidenceLimits)}</p>` : ''}<div class="sources">${sourceLinks(item)}</div></div>
    ${item.risks ? `<div class="notice"><b>Haken:</b> ${esc(item.risks)}</div>` : ''}
    <div class="actions"><button class="btn" data-action="watch">Beobachten</button><button class="btn" data-action="validate">7-Tage-Test</button><button class="btn danger" data-action="rejected">Verwerfen</button><button class="btn primary" data-action="handoff">Umsetzung vorbereiten</button></div><div class="handoff-result"></div>
  </article>`;
}

function renderOpportunities() {
  const items = state.opportunities.filter(item => !state.filter || item.status === state.filter);
  $('opportunityList').innerHTML = items.length ? items.map(opportunityCard).join('') : '<div class="empty">Für diesen Filter gibt es noch keine Chance.</div>';
}

async function loadAll({ fill = true } = {}) {
  try {
    const [status, settings, opportunities] = await Promise.all([api('/api/opportunities/status'), api('/api/opportunities/settings'), api('/api/opportunities?limit=200')]);
    state = { ...state, status, settings, opportunities };
    renderMetrics(); renderStatus(); if (fill) fillSettings(); renderOpportunities();
  } catch (error) {
    $('statusNotice').textContent = `Laden fehlgeschlagen: ${error.message}. Falls IVA geschützt ist, API-Token im Cockpit speichern.`;
  }
}

$('saveSettings').addEventListener('click', async () => {
  const button = $('saveSettings'); setBusy(button, true, 'Speichert …'); $('settingsState').textContent = '';
  try {
    state.settings = await api('/api/opportunities/settings', { method: 'PATCH', body: JSON.stringify({
      weeklyEnabled: $('weeklyEnabled').checked, hashtags: lines($('hashtags').value), seedAccounts: lines($('seedAccounts').value),
      maxInitialBudgetEur: Number($('maxBudget').value), maxSetupHours: Number($('maxSetup').value), maxOngoingHoursPerWeek: Number($('maxOngoing').value), topIdeasPerPitch: Number($('topIdeas').value), notes: $('notes').value,
    }) });
    $('settingsState').textContent = 'Gespeichert.'; await loadAll({ fill: false });
  } catch (error) { $('settingsState').textContent = error.message; } finally { setBusy(button, false); }
});

$('runScout').addEventListener('click', async () => {
  const button = $('runScout'); setBusy(button, true, 'Instagram wird geprüft …');
  try {
    const result = await api('/api/opportunities/scout', { method: 'POST', body: '{}' });
    $('statusNotice').innerHTML = `Scan fertig: <b>${result.run?.sourceCount || 0} Quellen</b>, <b>${result.opportunities?.length || 0} belastbare Ideen</b>.`;
    await loadAll({ fill: false });
  } catch (error) { $('statusNotice').textContent = error.message; } finally { setBusy(button, false); }
});

$('filters').addEventListener('click', event => {
  const button = event.target.closest('[data-status]'); if (!button) return;
  state.filter = button.dataset.status; document.querySelectorAll('.filter').forEach(item => item.classList.toggle('active', item === button)); renderOpportunities();
});

$('opportunityList').addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const card = button.closest('[data-id]'); const id = card?.dataset.id; if (!id) return;
  setBusy(button, true, '…');
  try {
    if (button.dataset.action === 'handoff') {
      const handoff = await api(`/api/opportunities/${encodeURIComponent(id)}/handoff`, { method: 'POST', body: '{}' });
      card.querySelector('.handoff-result').innerHTML = `<div class="confirm">Vorbereitet für ${esc(handoff.targetAgent)}. Zum tatsächlichen Start bestätige später exakt:<br>${esc(handoff.confirmation)}</div>`;
    } else {
      await api(`/api/opportunities/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.action }) });
      await loadAll({ fill: false });
    }
  } catch (error) { card.querySelector('.handoff-result').textContent = error.message; } finally { setBusy(button, false); }
});

$('ivaHelper').addEventListener('click', () => location.href = '/cockpit');
loadAll();
