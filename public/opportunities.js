const $ = id => document.getElementById(id);
const token = () => localStorage.getItem('iva_token') || '';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const lines = value => String(value || '').split(/\n|,/).map(item => item.trim().replace(/^#/, '')).filter(Boolean);
const linkLines = value => [...new Set(String(value || '').split(/\r?\n/).map(item => item.trim().replace(/^[-*•\d.)\s]+/, '')).filter(Boolean))];
const money = value => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Number(value) || 0);
let state = { status: null, marketResearchStatus: null, settings: null, opportunities: [], linkChecks: [], marketAnalyses: [], watchSources: [], filter: '' };

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || `HTTP ${response.status}`); error.payload = data; throw error; }
  return data;
}

function setBusy(button, busy, text) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy; button.textContent = busy ? text : button.dataset.label;
}

function renderMetrics() {
  const counts = state.status?.counts || {};
  const cards = [
    ['Ideen', counts.opportunities || 0], ['≥ 75 Punkte', counts.highPotential || 0], ['Im Test', counts.validation || 0], ['Scans', counts.runs || 0], ['Link-Checks', counts.linkChecks || 0], ['Marktanalysen', counts.marketAnalyses || 0], ['Radar-Quellen', counts.watchSources || 0], ['Übergaben offen', counts.pendingHandoffs || 0],
  ];
  $('metrics').innerHTML = cards.map(([label, value]) => `<div class="metric"><b>${esc(value)}</b><small>${esc(label)}</small></div>`).join('');
}

function renderStatus() {
  const status = state.status || {};
  const lastRun = status.lastRun;
  const lastRunText = lastRun?.status === 'failed'
    ? `<br><b>Letzter Lauf fehlgeschlagen:</b> ${esc(lastRun.error || 'Unbekannter Fehler')}`
    : lastRun?.status === 'complete'
      ? `<br>Letzter Lauf: ${esc(lastRun.sourceCount || 0)} Quellen, ${esc(lastRun.ideaCount || 0)} Ideen${lastRun.sourceWarnings?.length ? `, ${esc(lastRun.sourceWarnings.length)} Teilquellen mit Warnung` : ''}.`
      : '';
  $('providerDot').className = 'dot' + (status.configured ? ' on' : '');
  $('providerTitle').textContent = status.configured ? 'Research und Auswertung sind verbunden' : 'Chancenradar ist noch nicht vollständig verbunden';
  $('providerText').textContent = status.configured ? status.provider : `In Railway fehlt noch: ${(status.missing || []).join(', ') || 'unbekannte Konfiguration'}.`;
  $('statusNotice').innerHTML = status.ready
    ? `Wochenlauf ${status.weekly?.enabled ? 'aktiv' : 'pausiert'}: <b>${esc(status.weekly?.schedule || 'Montag 08:30')}</b>. Der Scan hat ein Kostenlimit und setzt nichts automatisch um.${lastRunText}`
    : `Der Bereich ist fertig, startet echte Quellen aber erst, wenn <b>${esc((status.missing || []).join(', ') || 'die fehlende Konfiguration')}</b> gesetzt ist. Bis dahin erfindet IVA bewusst keine Ideen aus dem Nichts.`;
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
    <div class="actions"><button class="btn" data-action="watch">Beobachten</button><button class="btn" data-action="validate">7-Tage-Test</button><button class="btn danger" data-action="rejected">Verwerfen</button>${item.projectId ? `<a class="btn primary" href="/projects?id=${encodeURIComponent(item.projectId)}">Projekt öffnen</a>` : `<button class="btn primary" data-action="handoff">${high ? 'Hat Potenzial · Projekt erstellen?' : 'Projekt aus Idee erstellen?'}</button>`}</div><div class="handoff-result"></div>
  </article>`;
}

function renderOpportunities() {
  const items = state.opportunities.filter(item => !state.filter || item.status === state.filter);
  $('opportunityList').innerHTML = items.length ? items.map(opportunityCard).join('') : '<div class="empty">Für diesen Filter gibt es noch keine Chance.</div>';
}

const verdictLabel = value => ({
  'strong-fit': 'Starke Passung', 'test-first': 'Erst klein testen', watch: 'Beobachten',
  'not-recommended': 'Nicht empfohlen', 'insufficient-evidence': 'Noch nicht ausreichend belegt',
}[value] || value || 'Offen');
const modeLabel = value => value === 'iva-integration' ? 'IVA-Integration' : 'Business';
const listHtml = values => values?.length ? `<ul class="compact-list">${values.map(value => `<li>${esc(value)}</li>`).join('')}</ul>` : '<div class="muted">Keine belastbare Aussage möglich.</div>';

function linkResultHtml(item) {
  if (!item || item.status === 'failed') {
    return `<article class="link-result-card result-error"><b>Link-Check nicht abgeschlossen</b><p>${esc(item?.error || 'Der Link konnte nicht geprüft werden.')}</p>${item?.url ? `<a class="source" href="${esc(item.url)}" target="_blank" rel="noopener">Quelle öffnen</a>` : ''}</article>`;
  }
  const assessment = item.assessment || {};
  return `<article class="link-result-card"><div class="link-result-head"><div><span class="tag">${esc(modeLabel(item.mode))}</span><h3>${esc(assessment.headline || item.sourceTitle || 'Link-Check')}</h3><div class="summary">${esc(assessment.summary)}</div></div><div class="link-score">${esc(assessment.score || 0)}/100</div></div>
    <div class="actions"><span class="tag ${assessment.verdict === 'strong-fit' ? '' : 'warn'}">${esc(verdictLabel(assessment.verdict))}</span><a class="source" href="${esc(item.finalUrl || item.url)}" target="_blank" rel="noopener">Originalquelle öffnen</a></div>
    ${item.classificationReason ? `<div class="section"><b>Warum hier einsortiert?</b><p>${esc(item.classificationReason)}</p></div>` : ''}
    <div class="section"><b>Was ist es?</b><p>${esc(assessment.whatItIs || 'Noch nicht klar genug erkennbar.')}</p></div>
    <div class="link-columns"><div><div class="section"><b>Direkt belegt</b>${listHtml(assessment.evidence)}</div><div class="section"><b>Passung & Nutzen</b>${listHtml(assessment.fit)}</div></div><div><div class="section"><b>Annahmen & Datenlücken</b>${listHtml([...(assessment.assumptions || []), ...(assessment.gaps || [])])}</div><div class="section"><b>Risiken</b>${listHtml(assessment.risks)}</div></div></div>
    <div class="section"><b>Kosten & Aufwand</b><p>${esc(assessment.costsAndEffort || 'Noch zu verifizieren.')}</p></div>
    <div class="notice"><b>Nächster kleiner Test:</b> ${esc(assessment.nextTest || 'Offizielle Quelle und Testweg zuerst festlegen.')}</div></article>`;
}

function renderLinkResults(items) {
  const root = $('linkResults');
  root.hidden = false;
  root.innerHTML = items.map(linkResultHtml).join('');
}

function renderLinkHistory() {
  const items = (state.linkChecks || []).slice(0, 6);
  $('linkHistory').innerHTML = items.length ? `<div class="eyebrow">Letzte Link-Checks</div>` + items.map(item => `<div class="history-item"><div><button class="filter" data-history-id="${esc(item.id)}">${esc(item.assessment?.headline || item.sourceTitle || (item.status === 'failed' ? 'Fehlgeschlagener Check' : 'Link-Check'))}</button> <small>${esc(modeLabel(item.mode))}</small></div><small>${item.status === 'complete' ? `${esc(item.assessment?.score || 0)}/100 · ${esc(verdictLabel(item.assessment?.verdict))}` : esc(item.error)}</small></div>`).join('') : '';
}

const marketTypeLabel = value => ({ instagram: 'Instagram', website: 'Webseite', newsletter: 'Newsletter', youtube: 'YouTube', linkedin: 'LinkedIn', podcast: 'Podcast', other: 'Weitere Quelle' })[value] || value;
const cadenceLabel = value => ({ weekly: 'wöchentlich', monthly: 'monatlich', quarterly: 'vierteljährlich' })[value] || value;
const watchIdentity = source => `${source?.type || 'other'}:${String(source?.handle || source?.url || '').toLowerCase()}`;
const watched = source => state.watchSources.some(item => watchIdentity(item) === watchIdentity(source));

function findMarketSource(id) {
  for (const analysis of state.marketAnalyses || []) {
    const source = (analysis.sources || []).find(item => item.id === id);
    if (source) return { ...source, analysisId: analysis.id };
  }
  return state.watchSources.find(item => item.id === id) || null;
}

function marketSourceCard(source) {
  const isWatched = watched(source);
  return `<details class="market-source"><summary><div><div class="market-source-title"><span class="tag">${esc(marketTypeLabel(source.type))}</span><b>${esc(source.name)}</b></div><div class="muted">${esc(source.reason || 'Beobachtungswert wird noch genauer geprüft.')}</div></div><div class="market-source-score">${esc(source.score || 0)}</div></summary><div class="market-source-body">
    <div class="actions"><a class="source" href="${esc(source.url)}" target="_blank" rel="noopener">Quelle öffnen</a><span class="tag ${source.monitoringValue === 'high' ? '' : 'warn'}">${esc(cadenceLabel(source.cadence))} prüfen</span>${source.sampleSize ? `<span class="tag">${esc(source.sampleSize)} Inhalte geprüft</span>` : ''}</div>
    <div class="section"><b>Stärken</b>${listHtml(source.strengths)}</div><div class="section"><b>Themen & Muster</b>${listHtml([...(source.topics || []), ...(source.contentPatterns || [])])}</div><div class="section"><b>Beleglage</b>${listHtml(source.evidence)}</div>
    <button class="btn ${isWatched ? 'danger' : 'primary'}" data-watch-source="${esc(source.id)}" data-watch-enabled="${isWatched ? 'false' : 'true'}">${isWatched ? 'Nicht mehr regelmäßig prüfen' : 'Regelmäßig beobachten'}</button>
  </div></details>`;
}

function renderMarketResearch() {
  if (!$('marketState').textContent) {
    const marketStatus = state.marketResearchStatus || {};
    $('marketState').textContent = marketStatus.ready
      ? `Websuche bereit${marketStatus.instagramDetailReady ? ' · Instagram-Detailprüfung bereit' : ' · Instagram-Details derzeit nur aus Suchsignalen'}.`
      : `Für neue Marktanalysen fehlt noch: ${(marketStatus.missing || []).join(', ') || marketStatus.error || 'Research-Konfiguration'}.`;
  }
  const latest = state.marketAnalyses?.[0];
  if (!latest) {
    $('marketResults').innerHTML = '<div class="empty">Noch keine Marktanalyse. Gib ein Thema ein und lass IVA sinnvolle Beobachtungsquellen suchen.</div>';
  } else if (latest.status === 'failed') {
    $('marketResults').innerHTML = `<div class="notice"><b>Letzte Marktanalyse nicht abgeschlossen:</b> ${esc(latest.error)}</div>`;
  } else {
    $('marketResults').innerHTML = `<div class="market-overview"><div class="market-result-head"><div><span class="tag">${esc(latest.region)} · ${esc(latest.language)}</span><h3>${esc(latest.topic)}</h3><div class="summary">${esc(latest.summary)}</div></div><div class="market-source-score">${esc(latest.sources?.length || 0)} Quellen</div></div>
      ${latest.marketPatterns?.length ? `<div class="section"><b>Erkannte Marktmuster</b>${listHtml(latest.marketPatterns)}</div>` : ''}
      ${latest.blindSpots?.length ? `<div class="section"><b>Blinde Flecken</b>${listHtml(latest.blindSpots)}</div>` : ''}
      <div class="market-source-grid">${(latest.sources || []).map(marketSourceCard).join('')}</div>
      <div class="market-analysis-history">${state.marketAnalyses.length} gespeicherte Marktanalyse${state.marketAnalyses.length === 1 ? '' : 'n'} · Die neueste wird angezeigt.</div></div>`;
  }
  $('watchSourceList').innerHTML = state.watchSources.length
    ? state.watchSources.map(source => `<span class="watch-pill"><a href="${esc(source.url)}" target="_blank" rel="noopener">${esc(source.type === 'instagram' ? '@' + source.handle : source.name)}</a><button title="Nicht mehr regelmäßig prüfen" data-watch-source="${esc(source.id)}" data-watch-enabled="false">×</button></span>`).join('')
    : '<span class="muted">Noch keine feste Radar-Quelle ausgewählt.</span>';
}

async function loadAll({ fill = true } = {}) {
  try {
    const [status, marketResearchStatus, settings, opportunities, linkChecks, marketAnalyses, watchSources] = await Promise.all([api('/api/opportunities/status'), api('/api/opportunities/market-research/status'), api('/api/opportunities/settings'), api('/api/opportunities?limit=200'), api('/api/opportunities/link-checks?limit=20'), api('/api/opportunities/market-analyses?limit=20'), api('/api/opportunities/watch-sources')]);
    state = { ...state, status, marketResearchStatus, settings, opportunities, linkChecks, marketAnalyses, watchSources };
    renderMetrics(); renderStatus(); if (fill) fillSettings(); renderOpportunities(); renderLinkHistory(); renderMarketResearch();
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
  const button = $('runScout'); setBusy(button, true, 'Quellen werden geprüft …');
  try {
    const result = await api('/api/opportunities/scout', { method: 'POST', body: '{}' });
    const warningText = result.warnings?.length ? ` ${result.warnings.length} Teilquelle(n) waren nicht erreichbar; der Lauf wurde mit den übrigen Quellen beendet.` : '';
    $('statusNotice').innerHTML = `Scan fertig: <b>${result.run?.sourceCount || 0} Quellen</b>, <b>${result.opportunities?.length || 0} belastbare Ideen</b>.${esc(warningText)}`;
    await loadAll({ fill: false });
  } catch (error) { $('statusNotice').textContent = error.message; } finally { setBusy(button, false); }
});

$('checkLinks').addEventListener('click', async () => {
  const urls = linkLines($('linkUrls').value);
  if (!urls.length) { $('linkState').textContent = 'Bitte zuerst mindestens einen Link einfügen.'; $('linkUrls').focus(); return; }
  if (urls.length > 10) { $('linkState').textContent = 'Bitte höchstens zehn Links pro Lauf einfügen.'; $('linkUrls').focus(); return; }
  const button = $('checkLinks');
  setBusy(button, true, `${urls.length} Link${urls.length === 1 ? '' : 's'} werden geprüft …`);
  $('linkResults').hidden = true;
  const results = [];
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    $('linkState').textContent = `Prüfe Link ${index + 1} von ${urls.length}, lese die Quelle und sortiere sie automatisch ein. Instagram kann bis zu zwei Minuten dauern.`;
    try {
      results.push(await api('/api/opportunities/check-link', { method: 'POST', body: JSON.stringify({ url, mode: 'auto' }) }));
    } catch (error) {
      results.push(error.payload?.linkCheck || { status: 'failed', url, error: error.message });
    }
    renderLinkResults(results);
  }
  const business = results.filter(item => item.status === 'complete' && item.mode === 'business').length;
  const iva = results.filter(item => item.status === 'complete' && item.mode === 'iva-integration').length;
  const failed = results.filter(item => item.status !== 'complete').length;
  $('linkState').textContent = `Fertig: ${business} Business-Chance${business === 1 ? '' : 'n'}, ${iva} IVA-Erweiterung${iva === 1 ? '' : 'en'}${failed ? `, ${failed} nicht vollständig prüfbar` : ''}. Alles wurde im Verlauf gespeichert.`;
  await loadAll({ fill: false }).catch(() => {});
  renderLinkResults(results);
  setBusy(button, false);
});

$('runMarketResearch').addEventListener('click', async () => {
  const topic = $('marketTopic').value.trim();
  if (!topic) { $('marketState').textContent = 'Bitte zuerst ein Thema eingeben.'; $('marketTopic').focus(); return; }
  const button = $('runMarketResearch');
  setBusy(button, true, 'Markt wird analysiert …');
  $('marketState').textContent = 'IVA sucht Profile und Webseiten, liest Stichproben und bewertet den regelmäßigen Beobachtungswert. Das kann einige Minuten dauern.';
  try {
    const result = await api('/api/opportunities/market-research', { method: 'POST', body: JSON.stringify({ topic, keywords: lines($('marketKeywords').value), region: $('marketRegion').value, language: $('marketLanguage').value }) });
    $('marketState').textContent = `${result.sources?.length || 0} sinnvolle Beobachtungsquellen gefunden. Wähle aus, welche in die regelmäßigen Läufe sollen.`;
    await loadAll({ fill: false });
  } catch (error) {
    $('marketState').textContent = error.message;
    await loadAll({ fill: false }).catch(() => {});
  } finally { setBusy(button, false); }
});

async function toggleWatchSource(button) {
  const source = findMarketSource(button.dataset.watchSource);
  if (!source) return;
  setBusy(button, true, 'Speichert …');
  try {
    await api('/api/opportunities/watch-sources', { method: 'PUT', body: JSON.stringify({ source, enabled: button.dataset.watchEnabled === 'true' }) });
    await loadAll({ fill: false });
    $('marketState').textContent = button.dataset.watchEnabled === 'true' ? 'Quelle in die regelmäßigen Radar-Läufe übernommen.' : 'Quelle aus den regelmäßigen Läufen entfernt.';
  } catch (error) { $('marketState').textContent = error.message; setBusy(button, false); }
}

$('marketResults').addEventListener('click', event => { const button = event.target.closest('[data-watch-source]'); if (button) void toggleWatchSource(button); });
$('watchSourceList').addEventListener('click', event => { const button = event.target.closest('[data-watch-source]'); if (button) void toggleWatchSource(button); });

$('linkHistory').addEventListener('click', event => {
  const button = event.target.closest('[data-history-id]'); if (!button) return;
  const item = state.linkChecks.find(entry => entry.id === button.dataset.historyId);
  if (item) renderLinkResult(item);
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
      card.querySelector('.handoff-result').innerHTML = `<div class="confirm"><b>${esc(handoff.question)}</b><div class="actions"><button class="btn primary" data-confirm-project="${esc(id)}">Ja, Projektakte erstellen</button><button class="btn" data-dismiss-project>Nein, noch nicht</button></div></div>`;
    } else {
      await api(`/api/opportunities/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.action }) });
      await loadAll({ fill: false });
    }
  } catch (error) { card.querySelector('.handoff-result').textContent = error.message; } finally { setBusy(button, false); }
});

$('opportunityList').addEventListener('click', async event => {
  const dismiss = event.target.closest('[data-dismiss-project]');
  if (dismiss) { dismiss.closest('.handoff-result').innerHTML = ''; return; }
  const button = event.target.closest('[data-confirm-project]');
  if (!button) return;
  const card = button.closest('[data-id]');
  setBusy(button, true, 'Projektakte wird erstellt …');
  try {
    const result = await api(`/api/opportunities/${encodeURIComponent(button.dataset.confirmProject)}/project`, { method: 'POST', body: JSON.stringify({ confirmed: true }) });
    card.querySelector('.handoff-result').innerHTML = `<div class="confirm"><b>${result.created ? 'Projektakte erstellt.' : 'Projektakte war bereits vorhanden.'}</b><br>Validierung, Marke, Landingpage, Instagram, Meta, LinkedIn, Content, Publishing und Analytics liegen jetzt als einzelne Arbeitspakete bereit.<div class="actions"><a class="btn primary" href="/projects?id=${encodeURIComponent(result.project.id)}">Projekt jetzt öffnen</a></div></div>`;
    await loadAll({ fill: false });
  } catch (error) { card.querySelector('.handoff-result').textContent = error.message; setBusy(button, false); }
});

$('ivaHelper').addEventListener('click', () => location.href = '/cockpit');
loadAll();
