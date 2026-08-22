const $ = id => document.getElementById(id);
const token = () => localStorage.getItem('iva_token') || '';
const state = { status: null, portfolio: null, settings: null, watchlist: [], drafts: [], selectedInstrument: null };
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const euro = (value, currency = 'EUR') => new Intl.NumberFormat('de-DE', { style: 'currency', currency: currency || 'EUR', maximumFractionDigits: 2 }).format(Number(value) || 0);
const num = (value, digits = 2) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: digits }).format(Number(value) || 0);

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(json?.error || `HTTP ${response.status}`);
  return json;
}
function notify(message, type = '') { const box = $('notice'); box.hidden = false; box.className = `notice ${type}`; box.textContent = message; }
function busy(button, active, label = 'Bitte warten …') { if (!button) return; if (active) { button.dataset.label = button.textContent; button.textContent = label; button.disabled = true; } else { button.textContent = button.dataset.label || button.textContent; button.disabled = false; } }

function renderMetrics() {
  const p = state.portfolio; const currency = p?.balance?.currency || state.settings?.referenceCurrency || 'EUR';
  const cards = [
    ['Depotwert', p ? euro(p.balance.totalValue, currency) : '–'],
    ['Liquidität', p ? `${num(p.risk.metrics.cashPct)} %` : '–'],
    ['Positionen', p?.positions?.length ?? '–'],
    ['Größte Position', p ? `${num(p.risk.metrics.largestPositionPct)} %` : '–'],
    ['Offene Orders', p?.openOrders?.length ?? '–'],
    ['Saxo', state.status?.connection?.authorized ? (state.status.connection.environment === 'live' ? 'LIVE' : 'SIM') : 'offen'],
  ];
  $('metrics').innerHTML = cards.map(([label, value]) => `<div class="metric"><b>${esc(value)}</b><small>${esc(label)}</small></div>`).join('');
}

function renderConnection() {
  const c = state.status?.connection || {};
  $('connect').hidden = !c.configured || c.authorized;
  const badge = c.authorized ? `<span class="badge green"><i class="dot"></i>${esc(c.environment)} verbunden</span>` : c.configured ? '<span class="badge yellow"><i class="dot"></i>Verbindung offen</span>' : '<span class="badge red"><i class="dot"></i>Setup fehlt</span>';
  if (!c.configured) {
    $('connectionCard').innerHTML = `<div class="card-head"><div><h2>Saxo OpenAPI einrichten</h2><div class="muted small">Der Saxo-Handelsaccount allein enthält noch keine API-App.</div></div>${badge}</div><ol class="setup-steps"><li>Im Saxo Developer Portal zuerst eine persönliche <b>SIM-App</b> mit Authorization Code Grant anlegen.</li><li>Redirect-URL exakt als <b>https://iva-core-production.up.railway.app/oauth/saxo/callback</b> eintragen.</li><li>App Key, Secret und einen neuen Token-Schlüssel als Railway-Secrets setzen.</li><li>Nach grünem SIM-Test und finanziertem Konto bei Saxo die separate LIVE-App beantragen.</li></ol><div class="notice error">Noch fehlend: ${esc((c.missing || []).join(', ') || 'Konfiguration')}</div>`;
    return;
  }
  const permissionNote = c.saxoAppTradingPermission
    ? '<div class="notice">Die Saxo-App besitzt Handelsberechtigung. IVAs eigener Orderversand bleibt dennoch technisch gesperrt.</div>'
    : '';
  $('connectionCard').innerHTML = `<div class="card-head"><div><h2>Saxo-Verbindung</h2><div class="muted small">${esc(c.setup || '')}</div></div>${badge}</div>${permissionNote}${c.authorized ? `<div class="notice good">OAuth-Tokens liegen verschlüsselt im Railway-Volume. Modus: lesen, analysieren und Saxo-Precheck.</div><button class="btn danger" id="disconnect">Verbindung trennen</button>` : '<div class="notice">Klicke oben auf „Saxo verbinden“. Login und Freigabe erfolgen ausschließlich bei Saxo.</div>'}`;
  $('disconnect')?.addEventListener('click', disconnect);
}

function renderChart() {
  const series = state.portfolio?.performance?.series || [];
  if (series.length < 2) { $('chart').innerHTML = `<div class="empty">${state.portfolio?.performance?.unavailable ? 'Performance ist in dieser Saxo-Umgebung nicht verfügbar.' : 'Noch keine ausreichende Zeitreihe.'}</div>`; return; }
  const values = series.map(item => item.value); const min = Math.min(...values); const max = Math.max(...values); const range = max - min || 1;
  const points = series.map((item, i) => `${(i / (series.length - 1)) * 100},${96 - ((item.value - min) / range) * 88}`).join(' ');
  const first = values[0]; const last = values.at(-1); const change = first ? ((last / first) - 1) * 100 : 0;
  $('performanceBadge').textContent = `${change >= 0 ? '+' : ''}${num(change)} %`;
  $('performanceBadge').className = `badge ${change >= 0 ? 'green' : 'red'}`;
  $('chart').innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Saxo-Wertentwicklung"><defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22e6d6" stop-opacity=".26"/><stop offset="1" stop-color="#22e6d6" stop-opacity="0"/></linearGradient></defs><polygon points="0,100 ${points} 100,100" fill="url(#fill)"/><polyline points="${points}" fill="none" stroke="#22e6d6" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}

function renderPositions() {
  const p = state.portfolio; const currency = p?.balance?.currency || 'EUR'; const items = p?.positions || [];
  $('positionCount').textContent = `${items.length} Position${items.length === 1 ? '' : 'en'}`;
  if (!items.length) { $('positions').innerHTML = '<div class="empty">Keine offene Position.</div>'; return; }
  $('positions').innerHTML = `<table class="table"><thead><tr><th>Instrument</th><th>Anlageklasse</th><th class="num">Menge</th><th class="num">Kurs</th><th class="num">Exposure</th><th class="num">Gewicht</th><th class="num">G/V</th></tr></thead><tbody>${items.map(item => `<tr><td><strong>${esc(item.description || item.symbol || item.id)}</strong><small>${esc(item.symbol || '')}${item.currentPriceDelayMinutes ? ` · ${esc(item.currentPriceDelayMinutes)} Min. verzögert` : ''}</small></td><td>${esc(item.assetType)}</td><td class="num">${num(item.amount, 6)}</td><td class="num">${num(item.currentPrice, 4)}</td><td class="num">${euro(item.exposureInBaseCurrency, currency)}</td><td class="num">${num(item.weightPct)} %</td><td class="num ${item.profitLoss >= 0 ? 'positive' : 'negative'}">${euro(item.profitLoss, currency)}</td></tr>`).join('')}</tbody></table>`;
}

function renderRisks() {
  const risk = state.portfolio?.risk;
  if (!risk) { $('riskBadge').textContent = 'Ohne Daten'; $('risks').innerHTML = '<div class="empty">Nach der Saxo-Verbindung erscheint hier die Prüfung.</div>'; return; }
  $('riskBadge').className = `badge ${risk.status}`; $('riskBadge').innerHTML = `<i class="dot"></i>${risk.status === 'green' ? 'Im Rahmen' : risk.status === 'yellow' ? 'Prüfen' : 'Grenze verletzt'}`;
  $('risks').innerHTML = risk.warnings.length ? risk.warnings.map(item => `<div class="risk ${esc(item.severity)}"><b>${esc(item.title)}</b><small>${esc(item.detail)}</small></div>`).join('') : '<div class="notice good">Keine Verletzung der hinterlegten Risikogrenzen erkannt.</div>';
}
function renderOrders() {
  const items = state.portfolio?.openOrders || [];
  $('openOrders').innerHTML = items.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Instrument</th><th>Richtung</th><th>Typ</th><th class="num">Menge</th><th class="num">Preis</th><th>Status</th></tr></thead><tbody>${items.map(item => `<tr><td>${esc(item.description || item.symbol || item.uic)}</td><td>${esc(item.direction)}</td><td>${esc(item.type)}</td><td class="num">${num(item.amount, 6)}</td><td class="num">${num(item.price, 4)}</td><td>${esc(item.status)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Keine offene Saxo-Order.</div>';
}

function fillSettings() {
  const s = state.settings; if (!s) return;
  $('objective').value = s.objective || ''; $('horizonYears').value = s.horizonYears; $('riskLevel').value = s.riskLevel; $('minCashPct').value = s.minCashPct; $('maxPositionPct').value = s.maxPositionPct; $('maxOrderValuePct').value = s.maxOrderValuePct; $('referenceCurrency').value = s.referenceCurrency; $('strategyNotes').value = s.notes || ''; $('allowShorting').checked = s.allowShorting === true; $('allowMargin').checked = s.allowMargin === true;
  document.querySelectorAll('[name="assetType"]').forEach(input => { input.checked = s.allowedAssetTypes.includes(input.value); });
}
function renderWatchlist() {
  $('watchlist').innerHTML = state.watchlist.length ? state.watchlist.map(item => `<div class="item"><div class="draft"><div><b>${esc(item.description || item.symbol)}</b><small>${esc(item.symbol)} · ${esc(item.assetType)} · ${esc(item.exchangeId || 'Saxo')}</small>${item.thesis ? `<small>These: ${esc(item.thesis)}</small>` : ''}</div><div class="actions"><button class="btn" data-draft-watch="${esc(item.key)}">Entwurf</button><button class="btn danger" data-remove-watch="${esc(item.key)}">Entfernen</button></div></div></div>`).join('') : '<div class="empty">Noch kein Instrument beobachtet.</div>';
}
function renderDrafts() {
  $('drafts').innerHTML = state.drafts.length ? state.drafts.map(item => { const check = item.precheck; const okay = item.status === 'prechecked'; return `<div class="item"><div class="draft"><div><b>${esc(item.direction)} ${esc(num(item.amount, 6))} · ${esc(item.instrument.description || item.instrument.symbol)}</b><small>${esc(item.orderType)}${item.orderPrice ? ` @ ${esc(num(item.orderPrice, 4))}` : ''} · ${esc(item.accountId || 'Konto noch offen')} · ${esc(item.status)}</small><small>These: ${esc(item.thesis)}</small>${check ? `<div class="precheck ${okay ? 'positive' : 'negative'}">${okay ? '✓ Saxo-Precheck und IVA-Grenzen bestanden.' : `Blockiert: ${esc((check.IvaChecks?.blocks || []).join(' ') || check.PreCheckResult)}`}${check.EstimatedTotalCostInAccountCurrency ? `<br>Kosten/Bedarf geschätzt: ${esc(euro(check.EstimatedTotalCostInAccountCurrency, state.portfolio?.balance?.currency || 'EUR'))}` : ''}</div>` : ''}</div><button class="btn primary" data-precheck="${esc(item.id)}" ${item.status === 'archived' ? 'disabled' : ''}>Saxo-Precheck</button></div></div>`; }).join('') : '<div class="empty">Noch kein Orderentwurf.</div>';
}
function renderAccounts() {
  const accounts = state.portfolio?.accounts || [];
  $('draftAccount').innerHTML = `<option value="">Konto auswählen</option>${accounts.filter(item => item.active).map(item => `<option value="${esc(item.accountKey)}" data-id="${esc(item.accountId)}">${esc(item.displayName || item.accountId)} · ${esc(item.currency)}</option>`).join('')}`;
}

async function loadPortfolio() {
  if (!state.status?.connection?.ready) { state.portfolio = null; renderMetrics(); renderChart(); renderPositions(); renderRisks(); renderOrders(); return; }
  try { state.portfolio = await api('/api/investment/portfolio'); renderMetrics(); renderChart(); renderPositions(); renderRisks(); renderOrders(); renderAccounts(); }
  catch (error) { notify(`Saxo-Depot konnte nicht geladen werden: ${error.message}`, 'error'); }
}
async function loadAll() {
  try {
    [state.status, state.settings, { items: state.watchlist }, { items: state.drafts }] = await Promise.all([api('/api/investment/status'), api('/api/investment/settings'), api('/api/investment/watchlist'), api('/api/investment/order-drafts')]);
    renderConnection(); renderMetrics(); fillSettings(); renderWatchlist(); renderDrafts(); await loadPortfolio();
  } catch (error) { notify(token() ? error.message : 'Bitte zuerst im IVA-Cockpit den API-Token hinterlegen.', 'error'); }
}
async function connect() { const button = $('connect'); busy(button, true, 'Öffnet Saxo …'); try { const { url } = await api('/api/investment/saxo/auth-url'); location.assign(url); } catch (error) { notify(error.message, 'error'); busy(button, false); } }
async function disconnect() { if (!confirm('Saxo-Verbindung wirklich trennen? Die verschlüsselten OAuth-Tokens werden aus IVA entfernt.')) return; try { await api('/api/investment/saxo/disconnect', { method: 'POST', body: JSON.stringify({ confirmation: 'SAXO VERBINDUNG TRENNEN' }) }); state.portfolio = null; await loadAll(); notify('Saxo-Verbindung wurde getrennt.', 'good'); } catch (error) { notify(error.message, 'error'); } }

async function saveSettings(event) { event.preventDefault(); const button = event.submitter; busy(button, true, 'Speichert …'); try { state.settings = await api('/api/investment/settings', { method: 'PATCH', body: JSON.stringify({ objective: $('objective').value, horizonYears: Number($('horizonYears').value), riskLevel: $('riskLevel').value, minCashPct: Number($('minCashPct').value), maxPositionPct: Number($('maxPositionPct').value), maxOrderValuePct: Number($('maxOrderValuePct').value), referenceCurrency: $('referenceCurrency').value.toUpperCase(), notes: $('strategyNotes').value, allowShorting: $('allowShorting').checked, allowMargin: $('allowMargin').checked, allowedAssetTypes: [...document.querySelectorAll('[name="assetType"]:checked')].map(input => input.value) }) }); $('settingsState').textContent = 'Gespeichert.'; if (state.portfolio) await loadPortfolio(); } catch (error) { $('settingsState').textContent = error.message; } finally { busy(button, false); } }

async function searchInstruments() { const button = $('instrumentSearch'); busy(button, true, 'Sucht …'); try { const result = await api(`/api/investment/instruments?q=${encodeURIComponent($('instrumentQuery').value)}`); $('instrumentResults').innerHTML = result.instruments.length ? result.instruments.map((item, index) => `<div class="result"><div><b>${esc(item.description || item.symbol)}</b><small>${esc(item.symbol)} · ${esc(item.assetType)} · ${esc(item.exchangeId)} · ${esc(item.currency)}</small></div><button class="btn" data-watch-result="${index}">Watchlist</button><button class="btn primary" data-draft-result="${index}">Entwurf</button></div>`).join('') : '<div class="empty">Kein handelbares Instrument gefunden.</div>'; $('instrumentResults').dataset.items = JSON.stringify(result.instruments); } catch (error) { notify(error.message, 'error'); } finally { busy(button, false); } }
function resultItem(index) { try { return JSON.parse($('instrumentResults').dataset.items || '[]')[Number(index)]; } catch { return null; } }
async function addWatch(item) { if (!item) return; const thesis = prompt('Optionale Beobachtungsthese (noch keine Kaufentscheidung):', '') ?? ''; try { await api('/api/investment/watchlist', { method: 'POST', body: JSON.stringify({ ...item, thesis }) }); ({ items: state.watchlist } = await api('/api/investment/watchlist')); renderWatchlist(); notify('Instrument zur Watchlist hinzugefügt.', 'good'); } catch (error) { notify(error.message, 'error'); } }
function selectDraftInstrument(item) { if (!item) return; state.selectedInstrument = item; $('draftInstrument').value = `${item.description || item.symbol} · ${item.symbol || item.uic} · ${item.assetType}`; document.querySelector('[data-tab="drafts"]').click(); $('draftAmount').focus(); }

async function saveDraft(event) { event.preventDefault(); if (!state.selectedInstrument) { $('draftState').textContent = 'Bitte zuerst ein Instrument über die Suche oder Watchlist auswählen.'; return; } const button = event.submitter; busy(button, true, 'Speichert …'); const account = $('draftAccount').selectedOptions[0]; try { await api('/api/investment/order-drafts', { method: 'POST', body: JSON.stringify({ instrument: state.selectedInstrument, accountKey: $('draftAccount').value, accountId: account?.dataset.id || '', direction: $('draftDirection').value, amount: Number($('draftAmount').value), orderType: $('draftType').value, orderPrice: $('draftType').value === 'Limit' ? Number($('draftPrice').value) : undefined, durationType: $('draftDuration').value, thesis: $('draftThesis').value, invalidation: $('draftInvalidation').value, horizon: $('draftHorizon').value }) }); ({ items: state.drafts } = await api('/api/investment/order-drafts')); renderDrafts(); $('draftForm').reset(); state.selectedInstrument = null; $('draftInstrument').value = ''; renderAccounts(); $('draftState').textContent = 'Entwurf gespeichert – noch nichts an Saxo gesendet.'; } catch (error) { $('draftState').textContent = error.message; } finally { busy(button, false); } }
async function precheck(id, button) { busy(button, true, 'Saxo prüft …'); try { await api(`/api/investment/order-drafts/${encodeURIComponent(id)}/precheck`, { method: 'POST', body: '{}' }); ({ items: state.drafts } = await api('/api/investment/order-drafts')); renderDrafts(); notify('Precheck abgeschlossen. Es wurde keine Order gesendet.', 'good'); } catch (error) { notify(error.message, 'error'); busy(button, false); } }

document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => { document.querySelectorAll('[data-tab]').forEach(item => item.classList.toggle('active', item === button)); document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== button.dataset.tab; }); }));
$('connect').addEventListener('click', connect); $('refresh').addEventListener('click', loadAll); $('settingsForm').addEventListener('submit', saveSettings); $('instrumentSearch').addEventListener('click', searchInstruments); $('instrumentQuery').addEventListener('keydown', event => { if (event.key === 'Enter') searchInstruments(); }); $('draftType').addEventListener('change', () => { $('draftPrice').disabled = $('draftType').value !== 'Limit'; }); $('draftForm').addEventListener('submit', saveDraft);
$('instrumentResults').addEventListener('click', event => { const watch = event.target.closest('[data-watch-result]'); const draft = event.target.closest('[data-draft-result]'); if (watch) void addWatch(resultItem(watch.dataset.watchResult)); if (draft) selectDraftInstrument(resultItem(draft.dataset.draftResult)); });
$('watchlist').addEventListener('click', async event => { const remove = event.target.closest('[data-remove-watch]'); const draft = event.target.closest('[data-draft-watch]'); if (remove) { await api(`/api/investment/watchlist/${encodeURIComponent(remove.dataset.removeWatch)}`, { method: 'DELETE' }); ({ items: state.watchlist } = await api('/api/investment/watchlist')); renderWatchlist(); } if (draft) selectDraftInstrument(state.watchlist.find(item => item.key === draft.dataset.draftWatch)); });
$('drafts').addEventListener('click', event => { const button = event.target.closest('[data-precheck]'); if (button) void precheck(button.dataset.precheck, button); });
const callback = new URLSearchParams(location.search).get('saxo'); if (callback === 'connected') notify('Saxo wurde verbunden. Depotdaten werden jetzt geladen.', 'good'); else if (callback === 'denied') notify('Die Saxo-Freigabe wurde nicht erteilt.', 'error'); else if (callback === 'error') notify('Die Saxo-Verbindung konnte nicht abgeschlossen werden. Prüfe App und Redirect-URL.', 'error');
void loadAll();
