const $ = id => document.getElementById(id);
const token = () => localStorage.getItem('iva_token') || '';
const state = {
  status: null, portfolio: null, settings: null, mandate: null, readiness: null, knowledge: null,
  watchlist: [], drafts: [], analyses: [], journal: [], calibration: null, opportunities: [],
  selectedInstrument: null, analysisInstrument: null, currentAnalysis: null,
};
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const euro = (value, currency = 'EUR') => new Intl.NumberFormat('de-DE', { style: 'currency', currency: currency || 'EUR', maximumFractionDigits: 2 }).format(Number(value) || 0);
const num = (value, digits = 2) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: digits }).format(Number(value) || 0);
const pctValue = value => value === null || value === undefined ? '–' : `${Number(value) >= 0 ? '+' : ''}${num(value)} %`;
function safeUrl(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.toString() : ''; } catch { return ''; } }

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
  $('watchlist').innerHTML = state.watchlist.length ? state.watchlist.map(item => `<div class="item"><div class="draft"><div><b>${esc(item.description || item.symbol)}</b><small>${esc(item.symbol)} · ${esc(item.assetType)} · ${esc(item.exchangeId || 'Saxo')}</small>${item.thesis ? `<small>These: ${esc(item.thesis)}</small>` : ''}</div><div class="actions"><button class="btn primary" data-analyze-watch="${esc(item.key)}">Analyse</button><button class="btn" data-draft-watch="${esc(item.key)}">Entwurf</button><button class="btn danger" data-remove-watch="${esc(item.key)}">Entfernen</button></div></div></div>`).join('') : '<div class="empty">Noch kein Instrument beobachtet.</div>';
}
function renderDrafts() {
  $('drafts').innerHTML = state.drafts.length ? state.drafts.map(item => { const check = item.precheck; const okay = item.status === 'prechecked'; return `<div class="item"><div class="draft"><div><b>${esc(item.direction)} ${esc(num(item.amount, 6))} · ${esc(item.instrument.description || item.instrument.symbol)}</b><small>${esc(item.orderType)}${item.orderPrice ? ` @ ${esc(num(item.orderPrice, 4))}` : ''} · ${esc(item.accountId || 'Konto noch offen')} · ${esc(item.status)}</small><small>These: ${esc(item.thesis)}</small>${check ? `<div class="precheck ${okay ? 'positive' : 'negative'}">${okay ? '✓ Saxo-Precheck und IVA-Grenzen bestanden.' : `Blockiert: ${esc((check.IvaChecks?.blocks || []).join(' ') || check.PreCheckResult)}`}${check.EstimatedTotalCostInAccountCurrency ? `<br>Kosten/Bedarf geschätzt: ${esc(euro(check.EstimatedTotalCostInAccountCurrency, state.portfolio?.balance?.currency || 'EUR'))}` : ''}</div>` : ''}</div><button class="btn primary" data-precheck="${esc(item.id)}" ${item.status === 'archived' ? 'disabled' : ''}>Saxo-Precheck</button></div></div>`; }).join('') : '<div class="empty">Noch kein Orderentwurf.</div>';
}
function renderAccounts() {
  const accounts = state.portfolio?.accounts || [];
  $('draftAccount').innerHTML = `<option value="">Konto auswählen</option>${accounts.filter(item => item.active).map(item => `<option value="${esc(item.accountKey)}" data-id="${esc(item.accountId)}">${esc(item.displayName || item.accountId)} · ${esc(item.currency)}</option>`).join('')}`;
}

function renderKnowledge() {
  const status = state.knowledge?.status;
  const playbook = state.knowledge?.playbook;
  if (!status || !playbook) { $('knowledgeStatus').innerHTML = '<div class="empty">Wissensstatus nicht geladen.</div>'; return; }
  $('knowledgeStatus').innerHTML = `<div class="item"><b>${esc(status.playbookVersion)}</b><small>${esc(status.lensCount)} Prüflinsen · ${esc(status.sourceTiers)} Quellenstufen</small></div><div class="item"><b>Deterministischer Chartkern</b><small>${esc((status.deterministicAnalytics || []).join(' · '))}</small></div><div class="item"><b>Research-Schutz</b><small>${esc((status.researchSafeguards || []).join(' · '))}</small></div><div class="item"><b>Leitsatz</b><small>${esc(playbook.doctrine?.[0] || '')}</small></div>`;
}

function patternHtml(technical) {
  const patterns = technical?.patterns || [];
  return patterns.length ? `<div class="chips">${patterns.map(item => `<span class="chip" title="${esc(item.evidence)}">${esc(item.label)}</span>`).join('')}</div>` : '<div class="muted small">Kein regelbasiertes Muster aktiv.</div>';
}

function renderAnalysis(analysis) {
  state.currentAnalysis = analysis || null;
  if (!analysis) { $('analysisResult').innerHTML = '<div class="empty">Wähle ein Saxo-Instrument und starte die Analyse.</div>'; return; }
  const daily = analysis.market?.technical || {};
  const weekly = analysis.market?.weeklyTechnical || {};
  const metrics = daily.metrics || {};
  const gate = analysis.decisionGate || {};
  const claims = analysis.sourceResearch?.claims || [];
  const currency = analysis.instrument?.currency || analysis.market?.details?.currency || 'EUR';
  $('analysisState').className = `badge ${gate.passed ? 'green' : 'yellow'}`;
  $('analysisState').textContent = gate.passed ? 'Quellen-Gate bestanden' : 'Research offen';
  $('journalReferencePrice').value = metrics.latestPrice || '';
  $('journalInstrument').value = `${analysis.instrument?.description || analysis.instrument?.symbol} · ${analysis.instrument?.assetType}`;
  const sourceHtml = claims.length ? `<h3 style="margin-top:16px">Geprüfte Quellenclaims</h3>${claims.slice(0, 12).map(claim => { const links = (claim.sources || []).map(source => { const url = safeUrl(source.url); return url ? `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(source.title || new URL(url).hostname)}</a>` : ''; }).filter(Boolean).join(' · '); return `<div class="claim"><b>${esc(claim.statement)}</b><small>${esc(claim.confidence || 'unknown')} · ${claim.verified ? 'verifiziert' : 'offen'}</small>${links ? `<small>${links}</small>` : ''}</div>`; }).join('')}` : '<div class="notice">Aktuelle Fundamental-, Ereignis- und Makroquellen fehlen noch. „+ Quellenresearch“ ergänzt die verifizierte Faktenbasis.</div>';
  $('analysisResult').innerHTML = `<div class="analysis-metrics"><div><b>${esc(num(metrics.latestPrice, 6))}</b><small>Letzter Saxo-Kurs · ${esc(currency)}</small></div><div><b>${esc(pctValue(metrics.return20dPct))}</b><small>20 Perioden</small></div><div><b>${esc(pctValue(metrics.return60dPct))}</b><small>60 Perioden</small></div><div><b>${esc(num(metrics.rsi14))}</b><small>RSI 14</small></div><div><b>${esc(pctValue(metrics.realizedVol20Pct))}</b><small>Volatilität 20</small></div><div><b>${esc(pctValue(metrics.maxDrawdownPct))}</b><small>Max. Drawdown</small></div><div><b>${esc(daily.state?.trend || 'offen')}</b><small>Tagestrend</small></div><div><b>${esc(weekly.state?.trend || 'offen')}</b><small>Wochentrend</small></div></div><h3>Erkannte Chartmuster · Tag</h3>${patternHtml(daily)}<h3 style="margin-top:13px">Erkannte Chartmuster · Woche</h3>${patternHtml(weekly)}<div class="notice ${gate.passed ? 'good' : ''}"><b>Decision-Gate: ${esc(gate.status || 'offen')}</b><br>${esc((gate.blockers || []).join(' ') || gate.note || '')}</div>${sourceHtml}<div class="muted small">Daten: ${esc(analysis.market?.freshness?.status || 'offen')} · letzte Periode ${esc(analysis.market?.freshness?.lastSampleAt || '–')} · Saxo-Verzögerung ${esc(analysis.market?.freshness?.delayedByMinutes || 0)} Min. · Technischer Score ist keine Kauf-/Verkaufsempfehlung.</div>`;
}

function renderAnalysisHistory() {
  $('analysisHistory').innerHTML = state.analyses.length ? state.analyses.slice(0, 20).map(item => `<div class="item"><div class="draft"><div><b>${esc(item.instrument?.description || item.instrument?.symbol)}</b><small>${esc(item.mode)} · ${esc(new Date(item.createdAt).toLocaleString('de-DE'))} · Gate ${esc(item.decisionGate?.status || 'offen')}</small></div><button class="btn" data-analysis-id="${esc(item.id)}">Öffnen</button></div></div>`).join('') : '<div class="empty">Noch keine Analyse gespeichert.</div>';
}

function fillMandate() {
  const m = state.mandate; if (!m) return;
  $('monthlyAmount').value = m.monthlyAmount; $('mandateCurrency').value = m.currency; $('analysisCadence').value = m.analysisCadence; $('autonomyStage').value = m.autonomyStage; $('reservePct').value = m.reservePct; $('maxMonthlyLossPct').value = m.maxMonthlyLossPct; $('maxDrawdownPct').value = m.maxDrawdownPct; $('maxPortfolioVolatilityPct').value = m.maxPortfolioVolatilityPct; $('mandateObjective').value = m.objective || ''; $('allowOptionsContracts').checked = m.allowOptionsContracts === true; $('allowLeveragedProducts').checked = m.allowLeveragedProducts === true;
}

function renderReadiness() {
  const r = state.readiness;
  if (!r) { $('autonomyReadiness').innerHTML = '<div class="empty">Noch nicht geprüft.</div>'; return; }
  $('autonomyReadiness').innerHTML = `<span class="badge ${r.eligibleForLiveReview ? 'green' : 'yellow'}"><i class="dot"></i>${r.eligibleForLiveReview ? 'LIVE-Review möglich' : 'Bewährung läuft'}</span><div class="analysis-metrics"><div><b>${esc(r.calibration?.reviewedCount || 0)}</b><small>bewertete Prognosen</small></div><div><b>${esc(r.calibration?.calibrationScore ?? '–')}</b><small>Kalibrierung</small></div><div><b>${esc(r.observedMonths)}</b><small>Beobachtungsmonate</small></div><div><b>${esc(r.evidenceSupportedResearchRuns)}</b><small>belastbare Researchs</small></div></div>${(r.blockers || []).map(item => `<div class="risk yellow"><b>Noch offen</b><small>${esc(item)}</small></div>`).join('')}<div class="notice">LIVE-Orderausführung: technisch gesperrt. ${esc(r.principle || '')}</div>`;
}

function renderOpportunities(result = null) {
  const candidates = result?.candidates || state.opportunities;
  $('opportunityResults').innerHTML = candidates.length ? `<div class="item-list">${candidates.map((item, index) => { const daily = item.market?.technical; const weekly = item.market?.weeklyTechnical; return `<div class="item"><div class="draft"><div><b>${esc(item.instrument?.description || item.instrument?.symbol)}</b><small>Research-Priorität ${esc(item.researchPriority?.score || 0)}/100 · ${esc(item.researchPriority?.classification || 'offen')}</small><small>Tag ${esc(daily?.state?.trend || 'offen')} · Woche ${esc(weekly?.state?.trend || 'offen')} · ${esc((daily?.patterns || []).map(pattern => pattern.label).slice(0, 3).join(' · ') || 'kein aktives Muster')}</small></div><button class="btn primary" data-opportunity-analysis="${index}">Analysieren</button></div></div>`; }).join('')}</div><div class="notice">${esc(result?.nextAction || '')}</div>` : '<div class="empty">Die Watchlist enthält noch keine scanbaren Instrumente.</div>';
}

function renderJournal() {
  const c = state.calibration || {};
  $('calibrationBadge').textContent = c.reviewedCount ? `${num(c.calibrationScore)} / 100 · n=${c.reviewedCount}` : 'Noch offen';
  $('calibrationBadge').className = `badge ${c.reviewedCount >= 10 ? 'green' : 'yellow'}`;
  $('journalItems').innerHTML = state.journal.length ? state.journal.map(item => `<div class="item"><div class="draft"><div><b>${esc(item.instrument?.description || item.instrument?.symbol)}</b><small>P(positiv) ${esc(item.probabilityPositiveReturnPct)} % · ${esc(item.horizonDays)} Tage · Referenz ${esc(num(item.referencePrice, 6))}</small><small>These: ${esc(item.thesis)}</small>${item.review ? `<div class="precheck ${item.review.actualPositive ? 'positive' : 'negative'}">Rendite ${esc(pctValue(item.review.actualReturnPct))} · Brier ${esc(item.review.brierScore)} · Kalibrierung ${esc(item.review.calibrationScore)}</div>` : ''}</div>${item.status === 'open' ? `<button class="btn" data-review-journal="${esc(item.id)}">Review</button>` : ''}</div></div>`).join('') : '<div class="empty">Noch keine Prognose vorab dokumentiert.</div>';
}

async function loadPortfolio() {
  if (!state.status?.connection?.ready) { state.portfolio = null; renderMetrics(); renderChart(); renderPositions(); renderRisks(); renderOrders(); return; }
  try { state.portfolio = await api('/api/investment/portfolio'); renderMetrics(); renderChart(); renderPositions(); renderRisks(); renderOrders(); renderAccounts(); }
  catch (error) { notify(`Saxo-Depot konnte nicht geladen werden: ${error.message}`, 'error'); }
}
async function loadAll() {
  try {
    const [status, settings, watch, drafts, mandate, readiness, analyses, journal, knowledge, opportunities] = await Promise.all([
      api('/api/investment/status'), api('/api/investment/settings'), api('/api/investment/watchlist'), api('/api/investment/order-drafts'),
      api('/api/investment/mandate'), api('/api/investment/autonomy-readiness'), api('/api/investment/analyses?limit=50'), api('/api/investment/journal?limit=200'), api('/api/investment/knowledge'), api('/api/investment/opportunities/latest'),
    ]);
    state.status = status; state.settings = settings; state.watchlist = watch.items || []; state.drafts = drafts.items || [];
    state.mandate = mandate; state.readiness = readiness; state.analyses = analyses.items || []; state.journal = journal.items || []; state.calibration = journal.calibration; state.knowledge = knowledge;
    state.opportunities = opportunities.item?.candidates || [];
    renderConnection(); renderMetrics(); fillSettings(); renderWatchlist(); renderDrafts(); renderKnowledge(); renderAnalysisHistory(); fillMandate(); renderReadiness(); renderJournal(); if (opportunities.item) renderOpportunities(opportunities.item); await loadPortfolio();
  } catch (error) { notify(token() ? error.message : 'Bitte zuerst im IVA-Cockpit den API-Token hinterlegen.', 'error'); }
}
async function connect() { const button = $('connect'); busy(button, true, 'Öffnet Saxo …'); try { const { url } = await api('/api/investment/saxo/auth-url'); location.assign(url); } catch (error) { notify(error.message, 'error'); busy(button, false); } }
async function disconnect() { if (!confirm('Saxo-Verbindung wirklich trennen? Die verschlüsselten OAuth-Tokens werden aus IVA entfernt.')) return; try { await api('/api/investment/saxo/disconnect', { method: 'POST', body: JSON.stringify({ confirmation: 'SAXO VERBINDUNG TRENNEN' }) }); state.portfolio = null; await loadAll(); notify('Saxo-Verbindung wurde getrennt.', 'good'); } catch (error) { notify(error.message, 'error'); } }

async function saveSettings(event) { event.preventDefault(); const button = event.submitter; busy(button, true, 'Speichert …'); try { state.settings = await api('/api/investment/settings', { method: 'PATCH', body: JSON.stringify({ objective: $('objective').value, horizonYears: Number($('horizonYears').value), riskLevel: $('riskLevel').value, minCashPct: Number($('minCashPct').value), maxPositionPct: Number($('maxPositionPct').value), maxOrderValuePct: Number($('maxOrderValuePct').value), referenceCurrency: $('referenceCurrency').value.toUpperCase(), notes: $('strategyNotes').value, allowShorting: $('allowShorting').checked, allowMargin: $('allowMargin').checked, allowedAssetTypes: [...document.querySelectorAll('[name="assetType"]:checked')].map(input => input.value) }) }); $('settingsState').textContent = 'Gespeichert.'; if (state.portfolio) await loadPortfolio(); } catch (error) { $('settingsState').textContent = error.message; } finally { busy(button, false); } }

async function searchInstruments() { const button = $('instrumentSearch'); busy(button, true, 'Sucht …'); try { const result = await api(`/api/investment/instruments?q=${encodeURIComponent($('instrumentQuery').value)}`); $('instrumentResults').innerHTML = result.instruments.length ? result.instruments.map((item, index) => `<div class="result"><div><b>${esc(item.description || item.symbol)}</b><small>${esc(item.symbol)} · ${esc(item.assetType)} · ${esc(item.exchangeId)} · ${esc(item.currency)}</small></div><button class="btn primary" data-analyze-result="${index}">Analyse</button><button class="btn" data-watch-result="${index}">Watchlist</button><button class="btn" data-draft-result="${index}">Entwurf</button></div>`).join('') : '<div class="empty">Kein handelbares Instrument gefunden.</div>'; $('instrumentResults').dataset.items = JSON.stringify(result.instruments); } catch (error) { notify(error.message, 'error'); } finally { busy(button, false); } }
function resultItem(index) { try { return JSON.parse($('instrumentResults').dataset.items || '[]')[Number(index)]; } catch { return null; } }
async function addWatch(item) { if (!item) return; const thesis = prompt('Optionale Beobachtungsthese (noch keine Kaufentscheidung):', '') ?? ''; try { await api('/api/investment/watchlist', { method: 'POST', body: JSON.stringify({ ...item, thesis }) }); ({ items: state.watchlist } = await api('/api/investment/watchlist')); renderWatchlist(); notify('Instrument zur Watchlist hinzugefügt.', 'good'); } catch (error) { notify(error.message, 'error'); } }
function selectDraftInstrument(item) { if (!item) return; state.selectedInstrument = item; $('draftInstrument').value = `${item.description || item.symbol} · ${item.symbol || item.uic} · ${item.assetType}`; document.querySelector('[data-tab="drafts"]').click(); $('draftAmount').focus(); }
function selectAnalysisInstrument(item) { if (!item) return; state.analysisInstrument = item; $('analysisInstrument').value = `${item.description || item.symbol} · ${item.symbol || item.uic} · ${item.assetType}`; $('journalInstrument').value = `${item.description || item.symbol} · ${item.assetType}`; document.querySelector('[data-tab="analysis"]').click(); }

async function runAnalysis() { if (!state.analysisInstrument) { notify('Bitte zuerst ein Instrument über Suche oder Watchlist auswählen.', 'error'); return; } const button = $('runAnalysis'); busy(button, true, 'Analysiert Charts …'); try { const analysis = await api('/api/investment/analysis', { method: 'POST', body: JSON.stringify({ instrument: state.analysisInstrument }) }); renderAnalysis(analysis); state.analyses = (await api('/api/investment/analyses?limit=50')).items || []; renderAnalysisHistory(); notify('Tages- und Wochenchart wurden analysiert. Es wurde keine Order gesendet.', 'good'); } catch (error) { notify(error.message, 'error'); } finally { busy(button, false); } }
async function runResearch() { if (!state.analysisInstrument) { notify('Bitte zuerst ein Instrument auswählen.', 'error'); return; } if (!confirm('Aktuellen Quellenresearch mit Such- und KI-Nutzung starten? Das kann bis zu zwei Minuten dauern.')) return; const button = $('runResearch'); busy(button, true, 'Prüft Originalquellen …'); try { const analysis = await api('/api/investment/research', { method: 'POST', body: JSON.stringify({ instrument: state.analysisInstrument, confirmation: 'QUELLENRESEARCH STARTEN' }) }); renderAnalysis(analysis); state.analyses = (await api('/api/investment/analyses?limit=50')).items || []; state.readiness = await api('/api/investment/autonomy-readiness'); renderAnalysisHistory(); renderReadiness(); notify('Quellenresearch und Gegenprüfung abgeschlossen.', 'good'); } catch (error) { notify(error.message, 'error'); } finally { busy(button, false); } }

async function scanOpportunities() { const button = $('scanOpportunities'); busy(button, true, 'Analysiert Watchlist …'); try { const result = await api('/api/investment/opportunities/scan', { method: 'POST', body: JSON.stringify({ limit: 20 }) }); state.opportunities = result.candidates || []; renderOpportunities(result); notify('Chancen-Radar abgeschlossen. Das Ranking priorisiert Research, nicht Orders.', 'good'); } catch (error) { notify(error.message, 'error'); } finally { busy(button, false); } }

async function saveMandate(event) { event.preventDefault(); const button = event.submitter; busy(button, true, 'Speichert …'); try { state.mandate = await api('/api/investment/mandate', { method: 'PATCH', body: JSON.stringify({ monthlyAmount: Number($('monthlyAmount').value), currency: $('mandateCurrency').value.toUpperCase(), analysisCadence: $('analysisCadence').value, autonomyStage: $('autonomyStage').value, reservePct: Number($('reservePct').value), maxMonthlyLossPct: Number($('maxMonthlyLossPct').value), maxDrawdownPct: Number($('maxDrawdownPct').value), maxPortfolioVolatilityPct: Number($('maxPortfolioVolatilityPct').value), objective: $('mandateObjective').value, allowOptionsContracts: $('allowOptionsContracts').checked, allowLeveragedProducts: $('allowLeveragedProducts').checked }) }); state.readiness = await api('/api/investment/autonomy-readiness'); fillMandate(); renderReadiness(); $('mandateState').textContent = 'Mandat gespeichert.'; } catch (error) { $('mandateState').textContent = error.message; } finally { busy(button, false); } }

async function saveJournal(event) { event.preventDefault(); if (!state.analysisInstrument) { $('journalState').textContent = 'Bitte zuerst im Analyse-Labor ein Instrument auswählen.'; return; } const button = event.submitter; busy(button, true, 'Speichert …'); try { await api('/api/investment/journal', { method: 'POST', body: JSON.stringify({ instrument: state.analysisInstrument, analysisId: state.currentAnalysis?.id || '', referencePrice: Number($('journalReferencePrice').value), horizonDays: Number($('journalHorizonDays').value), probabilityPositiveReturnPct: Number($('journalProbability').value), expectedReturnPct: $('journalExpectedReturn').value === '' ? undefined : Number($('journalExpectedReturn').value), thesis: $('journalThesis').value, counterThesis: $('journalCounter').value, invalidation: $('journalInvalidation').value }) }); const journal = await api('/api/investment/journal?limit=200'); state.journal = journal.items || []; state.calibration = journal.calibration; renderJournal(); $('journalForm').reset(); $('journalInstrument').value = `${state.analysisInstrument.description || state.analysisInstrument.symbol} · ${state.analysisInstrument.assetType}`; $('journalReferencePrice').value = state.currentAnalysis?.market?.technical?.metrics?.latestPrice || ''; $('journalHorizonDays').value = 30; $('journalProbability').value = 55; $('journalState').textContent = 'Prognose vorab gespeichert.'; } catch (error) { $('journalState').textContent = error.message; } finally { busy(button, false); } }

async function reviewJournal(id) { const actualPrice = Number(prompt('Schlusskurs am Review-Zeitpunkt:', '') || 0); if (!actualPrice) return; const notes = prompt('Was hat die These bestätigt oder widerlegt?', '') ?? ''; try { await api(`/api/investment/journal/${encodeURIComponent(id)}/review`, { method: 'POST', body: JSON.stringify({ actualPrice, notes }) }); const journal = await api('/api/investment/journal?limit=200'); state.journal = journal.items || []; state.calibration = journal.calibration; state.readiness = await api('/api/investment/autonomy-readiness'); renderJournal(); renderReadiness(); notify('Review gespeichert und Kalibrierung aktualisiert.', 'good'); } catch (error) { notify(error.message, 'error'); } }

async function saveDraft(event) { event.preventDefault(); if (!state.selectedInstrument) { $('draftState').textContent = 'Bitte zuerst ein Instrument über die Suche oder Watchlist auswählen.'; return; } const button = event.submitter; busy(button, true, 'Speichert …'); const account = $('draftAccount').selectedOptions[0]; try { await api('/api/investment/order-drafts', { method: 'POST', body: JSON.stringify({ instrument: state.selectedInstrument, accountKey: $('draftAccount').value, accountId: account?.dataset.id || '', direction: $('draftDirection').value, amount: Number($('draftAmount').value), orderType: $('draftType').value, orderPrice: $('draftType').value === 'Limit' ? Number($('draftPrice').value) : undefined, durationType: $('draftDuration').value, thesis: $('draftThesis').value, invalidation: $('draftInvalidation').value, horizon: $('draftHorizon').value }) }); ({ items: state.drafts } = await api('/api/investment/order-drafts')); renderDrafts(); $('draftForm').reset(); state.selectedInstrument = null; $('draftInstrument').value = ''; renderAccounts(); $('draftState').textContent = 'Entwurf gespeichert – noch nichts an Saxo gesendet.'; } catch (error) { $('draftState').textContent = error.message; } finally { busy(button, false); } }
async function precheck(id, button) { busy(button, true, 'Saxo prüft …'); try { await api(`/api/investment/order-drafts/${encodeURIComponent(id)}/precheck`, { method: 'POST', body: '{}' }); ({ items: state.drafts } = await api('/api/investment/order-drafts')); renderDrafts(); notify('Precheck abgeschlossen. Es wurde keine Order gesendet.', 'good'); } catch (error) { notify(error.message, 'error'); busy(button, false); } }

document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => { document.querySelectorAll('[data-tab]').forEach(item => item.classList.toggle('active', item === button)); document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== button.dataset.tab; }); }));
$('connect').addEventListener('click', connect); $('refresh').addEventListener('click', loadAll); $('settingsForm').addEventListener('submit', saveSettings); $('instrumentSearch').addEventListener('click', searchInstruments); $('instrumentQuery').addEventListener('keydown', event => { if (event.key === 'Enter') searchInstruments(); }); $('draftType').addEventListener('change', () => { $('draftPrice').disabled = $('draftType').value !== 'Limit'; }); $('draftForm').addEventListener('submit', saveDraft); $('runAnalysis').addEventListener('click', runAnalysis); $('runResearch').addEventListener('click', runResearch); $('scanOpportunities').addEventListener('click', scanOpportunities); $('mandateForm').addEventListener('submit', saveMandate); $('journalForm').addEventListener('submit', saveJournal);
$('instrumentResults').addEventListener('click', event => { const analyze = event.target.closest('[data-analyze-result]'); const watch = event.target.closest('[data-watch-result]'); const draft = event.target.closest('[data-draft-result]'); if (analyze) selectAnalysisInstrument(resultItem(analyze.dataset.analyzeResult)); if (watch) void addWatch(resultItem(watch.dataset.watchResult)); if (draft) selectDraftInstrument(resultItem(draft.dataset.draftResult)); });
$('watchlist').addEventListener('click', async event => { const remove = event.target.closest('[data-remove-watch]'); const analyze = event.target.closest('[data-analyze-watch]'); const draft = event.target.closest('[data-draft-watch]'); if (remove) { await api(`/api/investment/watchlist/${encodeURIComponent(remove.dataset.removeWatch)}`, { method: 'DELETE' }); ({ items: state.watchlist } = await api('/api/investment/watchlist')); renderWatchlist(); } if (analyze) selectAnalysisInstrument(state.watchlist.find(item => item.key === analyze.dataset.analyzeWatch)); if (draft) selectDraftInstrument(state.watchlist.find(item => item.key === draft.dataset.draftWatch)); });
$('drafts').addEventListener('click', event => { const button = event.target.closest('[data-precheck]'); if (button) void precheck(button.dataset.precheck, button); });
$('analysisHistory').addEventListener('click', event => { const button = event.target.closest('[data-analysis-id]'); if (!button) return; const item = state.analyses.find(analysis => analysis.id === button.dataset.analysisId); if (item) { state.analysisInstrument = item.instrument; $('analysisInstrument').value = `${item.instrument.description || item.instrument.symbol} · ${item.instrument.symbol || item.instrument.uic} · ${item.instrument.assetType}`; renderAnalysis(item); } });
$('opportunityResults').addEventListener('click', event => { const button = event.target.closest('[data-opportunity-analysis]'); if (!button) return; const item = state.opportunities[Number(button.dataset.opportunityAnalysis)]; if (item?.instrument) selectAnalysisInstrument(item.instrument); });
$('journalItems').addEventListener('click', event => { const button = event.target.closest('[data-review-journal]'); if (button) void reviewJournal(button.dataset.reviewJournal); });
const callback = new URLSearchParams(location.search).get('saxo'); if (callback === 'connected') notify('Saxo wurde verbunden. Depotdaten werden jetzt geladen.', 'good'); else if (callback === 'denied') notify('Die Saxo-Freigabe wurde nicht erteilt.', 'error'); else if (callback === 'error') notify('Die Saxo-Verbindung konnte nicht abgeschlossen werden. Prüfe App und Redirect-URL.', 'error');
void loadAll();
