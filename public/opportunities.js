const $ = id => document.getElementById(id);
const token = () => localStorage.getItem('iva_token') || '';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const lines = value => String(value || '').split(/\n|,/).map(item => item.trim().replace(/^#/, '')).filter(Boolean);
const linkLines = value => [...new Set(String(value || '').split(/\r?\n/).map(item => item.trim().replace(/^[-*•\d.)\s]+/, '')).filter(Boolean))];
const money = value => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Number(value) || 0);
const array = value => Array.isArray(value) ? value : [];
const scoreValue = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
const scoreText = value => scoreValue(value) === null ? 'Offen' : `${scoreValue(value)}/100`;
const safeUrl = value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; } };
const sourceLink = (url, label, className = 'source') => safeUrl(url) ? `<a class="${className}" href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : `<span class="muted">${esc(label)} · keine gültige Adresse</span>`;
const days = { monday: 'Montag', tuesday: 'Dienstag', wednesday: 'Mittwoch', thursday: 'Donnerstag', friday: 'Freitag', saturday: 'Samstag', sunday: 'Sonntag' };
const dateText = value => { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : ''; };
let state = { status: null, marketResearchStatus: null, settings: null, opportunities: [], linkChecks: [], marketAnalyses: [], watchSources: [], filter: '' };
let visibleLinkResults = [];

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, signal: options.signal || AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(typeof data.error === 'string' ? data.error : data.error?.message || `HTTP ${response.status}`); error.payload = data; error.status = response.status; throw error; }
  return data;
}

const jobStates = new Map(), jobPromises = new Map();
const terminalJobs = new Set(['completed', 'failed', 'interrupted']);
const jobLabels = { 'check-link': 'Linkprüfung', scout: 'Chancenscan', 'market-research': 'Marktrecherche' };
const jobStatusLabels = { queued: 'Wartet', running: 'Läuft', completed: 'Fertig', failed: 'Nicht abgeschlossen', interrupted: 'Unterbrochen', paused: 'Verbindung pausiert' };
const pendingStorageKey = 'iva_opportunity_jobs';
function pendingJobs() { try { return array(JSON.parse(sessionStorage.getItem(pendingStorageKey) || '[]')).filter(item => /^[a-f\d-]{36}$/i.test(item.id) && Object.hasOwn(jobLabels, item.kind)).slice(0, 30); } catch { return []; } }
function rememberJobs() { try { sessionStorage.setItem(pendingStorageKey, JSON.stringify([...jobStates.values()].filter(item => !terminalJobs.has(item.status)).map(({ id, kind }) => ({ id, kind })))); } catch {} }
function renderJobProgress() {
  const rows = [...jobStates.values()].filter(job=>job.status!=='completed').slice(-10);
  $('jobPanel').hidden = !rows.length;
  $('jobList').innerHTML = rows.map(job => `<div class="job-row"><span class="job-indicator ${terminalJobs.has(job.status) ? job.status : ''}" aria-hidden="true"></span><div><b>${esc(jobLabels[job.kind] || 'Auswertung')}</b> <span class="progress-label">${esc(jobStatusLabels[job.status] || 'Läuft')}</span><div class="job-message">${esc(job.message || 'Status wird geladen …')}</div>${job.status === 'paused' ? `<button class="btn" data-resume-job="${esc(job.id)}">Status erneut laden</button>` : ''}</div><small>${esc(dateText(job.startedAt || job.submittedAt))}</small></div>`).join('');
}
function updateJob(job) {
  const { result, ...progress } = job;
  jobStates.set(job.id, { ...jobStates.get(job.id), ...progress });
  const finished = [...jobStates.values()].filter(item => terminalJobs.has(item.status));
  for (const old of finished.slice(0, Math.max(0, finished.length - 10))) jobStates.delete(old.id);
  rememberJobs(); renderJobProgress();
}
async function followJob(initial) {
  if (jobPromises.has(initial.id)) return jobPromises.get(initial.id);
  updateJob(initial);
  const promise = (async () => {
    let job = initial, misses = 0;
    while (true) {
      if (job.status === 'completed') return job.result;
      if (job.status === 'failed' || job.status === 'interrupted') throw new Error(job.error?.message || job.message || 'Die Auswertung wurde nicht abgeschlossen.');
      try {
        const data = await api(`/api/opportunities/jobs/${encodeURIComponent(job.id)}`);
        if (!data.job) throw Object.assign(new Error('Der gespeicherte Job ist nicht mehr abrufbar.'), { status: 404 });
        job = data.job; misses = 0; updateJob(job);
      } catch (error) {
        misses++;
        if (error.status === 404) { updateJob({ ...job, status: 'interrupted', message: 'Der gespeicherte Job ist nicht mehr abrufbar.' }); throw error; }
        if (error.status === 401 || error.status === 403 || misses >= 3) {
          updateJob({ ...job, status: 'paused', message: 'Die Statusverbindung ist unterbrochen. Ein gestarteter Job läuft auf dem Server weiter; lade den Status erneut.' });
          error.resumable = true; throw error;
        }
        updateJob({ ...job, message: 'Verbindung wird wiederhergestellt. Der Job läuft im Hintergrund weiter.' });
      }
      if (!terminalJobs.has(job.status)) await new Promise(resolve => setTimeout(resolve, misses ? 4000 : document.hidden ? 5000 : 1500));
    }
  })().finally(() => jobPromises.delete(initial.id));
  jobPromises.set(initial.id, promise); return promise;
}
async function runJob(kind, input) {
  const { job } = await api('/api/opportunities/jobs', { method: 'POST', body: JSON.stringify({ kind, input }) });
  if (!job?.id) throw new Error('Die Auswertung konnte nicht als Hintergrundjob gestartet werden.');
  return followJob(job);
}
async function resumeJob(job) {
  try {
    const result = await followJob({ ...job, status: 'running', message: 'Gespeicherter Status wird geladen …' });
    if (job.kind === 'check-link') renderLinkResults([...visibleLinkResults.filter(item => item.id !== result.id && item.url !== result.url), result]);
    await loadAll({ fill: false });
  } catch (error) { if (!error.resumable) await loadAll({ fill: false }); }
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
  const settings = state.settings || {};
  const schedule = `${settings.cadence === 'weekly' ? days[settings.weeklyDay] || 'Montag' : 'Täglich'} ${settings.weeklyTime || '08:30'} · Europe/Berlin`;
  $('statusNotice').innerHTML = status.ready
    ? `Radar-Läufe ${settings.weeklyEnabled ? 'aktiv' : 'pausiert'}: <b>${esc(schedule)}</b>.${lastRunText}`
    : `Der Bereich ist fertig, startet echte Quellen aber erst, wenn <b>${esc((status.missing || []).join(', ') || 'die fehlende Konfiguration')}</b> gesetzt ist. Bis dahin erfindet IVA bewusst keine Ideen aus dem Nichts.`;
}

function fillSettings() {
  const settings = state.settings || {};
  $('hashtags').value = (settings.hashtags || []).join('\n');
  $('seedAccounts').value = (settings.seedAccounts || []).join('\n');
  $('tiktokAccounts').value = array(settings.tiktokAccounts).join('\n');
  $('keywords').value = array(settings.keywords).join('\n');
  $('includeCurated').checked = settings.includeCurated === true;
  $('maxBudget').value = settings.maxInitialBudgetEur ?? 500;
  $('maxSetup').value = settings.maxSetupHours ?? 20;
  $('maxOngoing').value = settings.maxOngoingHoursPerWeek ?? 3;
  $('topIdeas').value = settings.topIdeasPerPitch ?? 5;
  $('notes').value = settings.notes || '';
  $('weeklyEnabled').checked = settings.weeklyEnabled === true;
  $('cadence').value = settings.cadence === 'weekly' ? 'weekly' : 'daily';
  $('weeklyDay').value = settings.weeklyDay || 'monday';
  $('weeklyTime').value = settings.weeklyTime || '08:30';
  $('weeklyDayField').hidden = $('cadence').value !== 'weekly';
}

function sourceLinks(item) {
  if (!item.sources?.length) return '<span class="muted">Noch keine direkte Quelle gespeichert</span>';
  return item.sources.map((source, index) => sourceLink(source.url, source.account ? '@' + source.account.replace(/^@/, '') : 'Quelle ' + (index + 1))).join('');
}

function opportunityCard(item) {
  const high = Number(item.score || 0) >= 75;
  const statusLabel = { new: 'Neu', watch: 'Beobachten', validate: 'Testen', selected: 'Ausgewählt', rejected: 'Verworfen' }[item.status] || item.status;
  return `<article class="opportunity compact-opportunity ${high ? 'high' : ''}" data-id="${esc(item.id)}">
    <div class="opp-head"><span class="tag ${Number(item.score || 0) < 50 ? 'warn' : ''}">${esc(statusLabel)}</span><h3>${esc(item.title)}</h3><div class="summary">${esc(shortReason(item.summary, 'Noch kein Kurzfazit gespeichert.'))}</div></div>
    <details class="compact-report"><summary>Bericht ansehen</summary><div class="compact-report-body"><div class="report-rating"><span class="muted">Chancenbewertung · keine Erfolgswahrscheinlichkeit</span><b>${esc(scoreText(item.score))}</b></div>
    <div class="facts"><div class="fact"><small>Aufbau</small><b>${esc(item.setupHours || 0)} Std.</b></div><div class="fact"><small>Laufend</small><b>${esc(item.ongoingHoursPerWeek || 0)} Std./Woche</b></div><div class="fact"><small>Startbudget</small><b>${esc(money(item.initialBudgetEur))}</b></div></div>
    <div class="section"><b>Modell</b><p>${esc(item.offer || item.monetization || 'noch zu schärfen')}</p></div>
    <div class="section"><b>KI-Hebel</b><p>${esc(item.aiLeverage || 'noch zu prüfen')}</p></div>
    <div class="section"><b>7-Tage-Test</b><p>${esc(item.firstValidation || 'noch festzulegen')}</p></div>
    <div class="section"><b>Belege & Grenzen</b><p>${esc(item.evidence || 'noch nicht ausreichend belegt')}</p>${item.evidenceLimits ? `<p class="muted">Grenze: ${esc(item.evidenceLimits)}</p>` : ''}<div class="sources">${sourceLinks(item)}</div></div>
    ${item.risks ? `<div class="notice"><b>Haken:</b> ${esc(item.risks)}</div>` : ''}
    <div class="actions"><a class="btn primary" href="/product-creator?opportunityId=${encodeURIComponent(item.id)}${item.projectId ? '&projectId=' + encodeURIComponent(item.projectId) : ''}">Als Produkt umsetzen</a><button class="btn" data-action="watch">Beobachten</button><button class="btn" data-action="validate">7-Tage-Test</button><button class="btn danger" data-action="rejected">Verwerfen</button>${item.projectId ? `<a class="btn primary" href="/projects?id=${encodeURIComponent(item.projectId)}">Projekt öffnen</a>` : `<button class="btn primary" data-action="handoff">${high ? 'Hat Potenzial · Projekt erstellen?' : 'Projekt aus Idee erstellen?'}</button>`}</div><div class="handoff-result"></div></div></details>
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
const listHtml = values => array(values).length ? `<ul class="compact-list">${values.map(value => `<li>${esc(value)}</li>`).join('')}</ul>` : '<div class="muted">Noch offen.</div>';
const dimensionLabels = { feasibility: 'Technische Machbarkeit', demand: 'Nachfrage', economics: 'Wirtschaftlichkeit', execution: 'Umsetzbarkeit', evidence: 'Beleglage' };
const riskLabels = { legal: 'Recht', platform: 'Plattformen', financial: 'Finanzen', operational: 'Betrieb', reputation: 'Reputation' };
const riskLevel = value => ({ low: 'Niedrig', medium: 'Mittel', high: 'Hoch', unknown: 'Offen' })[value] || 'Offen';
const claimStatus = value => ({ supported: 'Gestützt', contradicted: 'Widersprochen', mixed: 'Gemischte Belege', unverified: 'Nicht belegt' })[value] || 'Nicht belegt';
const timestamp = item => typeof item?.startSeconds === 'number' ? `${item.startSeconds}${typeof item.endSeconds === 'number' ? '–' + item.endSeconds : ''} s` : item?.timestamp || '';
function shortReason(value, fallback) {
  const text = String(value || fallback || '').replace(/\s+/g, ' ').trim();
  const sentence = text.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() || text;
  if (sentence.length <= 210) return sentence;
  const cut = sentence.slice(0, 207); return cut.slice(0, Math.max(150, cut.lastIndexOf(' '))) + '…';
}
function assessmentSignal(item) {
  const assessment = item?.assessment || {}, videoMissing = item?.media?.isVideo && item?.media?.coverage && !item.media.coverage.visual && !item.media.coverage.audio;
  if (!item || item.status !== 'complete' || assessment.verdict === 'insufficient-evidence' || videoMissing) return { color: 'grey', label: 'Noch nicht belastbar geprüft', reason: item?.status === 'failed' ? 'Die Prüfung konnte nicht abgeschlossen werden.' : videoMissing ? 'Der eigentliche Videoinhalt konnte noch nicht geprüft werden.' : shortReason(assessment.summary, 'Für eine Einschätzung fehlen noch verlässliche Belege.') };
  const verdicts = { 'strong-fit': ['green', 'Funktioniert'], 'test-first': ['yellow', 'Funktioniert bedingt'], watch: ['yellow', 'Funktioniert bedingt'], 'not-recommended': ['red', 'Funktioniert nicht'] };
  const mapped = verdicts[assessment.verdict];
  if (!mapped) return { color: 'grey', label: 'Noch nicht belastbar geprüft', reason: 'Es liegt noch keine ausreichend begründete Einschätzung vor.' };
  let reason = assessment.summary;
  if (mapped[0] === 'red') {
    const weakest = array(assessment.dimensions).filter(row => scoreValue(row.score) !== null && row.reason).sort((a, b) => a.score - b.score)[0];
    if (weakest) reason = `${dimensionLabels[weakest.id] || 'Bewertung'}: ${weakest.reason}`;
  }
  return { color: mapped[0], label: mapped[1], reason: shortReason(reason, mapped[0] === 'green' ? 'Die geprüften Grundlagen sprechen für die Idee.' : mapped[0] === 'yellow' ? 'Die Idee braucht einen begrenzten Test und die Klärung offener Punkte.' : 'IVA empfiehlt die Idee in der geprüften Form nicht.') };
}
function signalHtml(signal) {
  return `<div class="signal-summary ${signal.color}" data-signal="${signal.color}"><span class="signal-lights" aria-hidden="true">${['red', 'yellow', 'green'].map(color => `<i class="${color}${color === signal.color ? ' active' : ''}"></i>`).join('')}</span><div><div class="signal-caption">IVA-Einschätzung</div><strong class="signal-label">${esc(signal.label)}</strong><p class="signal-reason">${esc(signal.reason)}</p></div></div>`;
}
let resultRenderCount = 0;
function evidenceReferences(ids, sources, prefix) {
  return array(ids).filter(id => sources.some(source => source.id === id)).map(id => `<a class="source-ref" href="#${prefix}-${esc(id)}">${esc(id)}</a>`).join('');
}
function dimensionsHtml(assessment, sources, prefix) {
  return `<div class="section"><b>Bewertungsdimensionen</b><p class="muted">0–100 Punkte als begründete Einschätzung, keine Erfolgswahrscheinlichkeit. Höher bedeutet eine bessere Ausgangslage. Fehlende Grundlage bleibt offen.</p><div class="dimension-grid">${Object.entries(dimensionLabels).map(([id, label]) => {
    const item = array(assessment.dimensions).find(value => value.id === id) || {}; const score = scoreValue(item.score);
    return `<div class="dimension"><div class="dimension-head"><b>${esc(label)}</b><span>${esc(scoreText(item.score))}</span></div><div class="dimension-track ${score === null ? 'unknown' : ''}" ${score === null ? 'aria-label="Noch keine belastbare Bewertung"' : `role="meter" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${score}"`}><span style="width:${score === null ? 0 : score}%"></span></div><p>${esc(item.reason || 'Die nötige Grundlage fehlt noch.')}</p>${evidenceReferences(item.sourceIds, sources, prefix)}</div>`;
  }).join('')}</div></div>`;
}
function riskMatrixHtml(assessment, sources, prefix) {
  return `<details class="evidence-detail"><summary>Risikomatrix · mögliche Folgen und Gegenmaßnahmen</summary><div class="risk-grid">${Object.entries(riskLabels).map(([id, label]) => {
    const item = array(assessment.riskMatrix).find(value => value.id === id) || {}; const level = ['low', 'medium', 'high'].includes(item.level) ? item.level : 'unknown';
    return `<div class="risk-card"><div class="dimension-head"><strong>${esc(label)}</strong><span class="tag risk-level ${level}">${esc(riskLevel(level))}</span></div><div class="muted section">Eintritt · qualitativ: ${esc(riskLevel(item.likelihood))}</div><div class="section"><b>Mögliche Folge</b><p>${esc(item.impact || 'Noch nicht belastbar eingeordnet.')}</p></div><div class="section"><b>Gegenmaßnahme</b><p>${esc(item.mitigation || 'Noch festzulegen.')}</p></div>${evidenceReferences(item.sourceIds, sources, prefix)}</div>`;
  }).join('')}</div></details>`;
}
function implementationHtml(assessment) {
  const options = array(assessment.implementationOptions);
  const validation = assessment.validation || {};
  return `<details class="evidence-detail"><summary>Konkrete Wege zur Umsetzung</summary>${options.length ? `<div class="option-grid">${options.map((option, index) => `<div class="option-card"><span class="tag">Option ${index + 1}</span><h3>${esc(option.name || 'Umsetzungsweg')}</h3><p class="summary">${esc(option.approach)}</p><div class="section"><b>Nutzen, Aufwand und Abwägung</b><p>${esc(option.tradeoff || 'Noch genauer zu prüfen.')}</p></div><div class="section"><b>Verbleibendes Risiko</b><p>${esc(option.residualRisk || 'Noch offen.')}</p></div>${array(option.steps).length ? `<ol class="compact-list">${option.steps.map(step => `<li>${esc(step)}</li>`).join('')}</ol>` : ''}</div>`).join('')}</div>` : '<div class="muted">Es liegt noch kein hinreichend begründeter Umsetzungsweg vor.</div>'}</details>
    <div class="notice"><b>Nächster kleiner Test</b><p>${esc(validation.action || assessment.nextTest || 'Zuerst einen prüfbaren Testweg festlegen.')}</p><div class="validation-grid">${[['Hypothese', validation.hypothesis], ['Erfolgskriterium', validation.successMetric], ['Abbruchkriterium', validation.stopCondition], ['Geschätzte Testkosten', validation.estimatedCost]].map(([label, value]) => `<div class="section"><b>${label}</b><p>${esc(value || 'Noch offen.')}</p></div>`).join('')}</div></div>`;
}
function mediaHtml(item) {
  const media = item.media || {}, coverage = media.coverage || {};
  if (!media.isVideo && !coverage.caption && !coverage.transcript && !coverage.visual && !coverage.audio) return coverage.page ? '<div class="coverage"><span class="available">Originalseite gelesen</span></div>' : '';
  const segments = array(media.transcriptSegments);
  const transcript = segments.length ? segments.map(row => `[${timestamp(row)}] ${row.text || ''}`).join('\n') : typeof media.transcript === 'string' ? media.transcript : '';
  const gaps = [...new Set([...array(media.gaps), ...array(media.warnings)])];
  return `<div class="coverage">${[['caption', 'Beitragstext'], ['visual', 'Bild'], ['audio', 'Ton'], ['transcript', 'Transkript']].map(([key, label]) => `<span class="${coverage[key] === true ? 'available' : ''}">${label}: ${coverage[key] === true ? 'Belege vorhanden' : 'nicht belegt'}</span>`).join('')}</div><details class="evidence-detail"><summary>Originalquelle · Beobachtungen, Transkript und Grenzen</summary>
    <p class="muted">Ein Beitragstext ist kein Videotranskript. Zeitmarken und Beobachtungen sind Modellauswertungen des Videos; sie belegen weder eine lückenlose Erfassung noch die Wahrheit einer Behauptung.${media.provider ? ` Auswertung: ${esc(media.provider)}.` : ''}</p>
    ${transcript && coverage.transcript ? `<div class="section"><b>Transkript mit Zeitmarken</b><pre class="transcript">${esc(transcript)}</pre></div>` : '<div class="muted">Kein bestätigtes gesprochenes Transkript gespeichert.</div>'}
    ${array(media.visualObservations).length ? `<div class="section"><b>Bildbeobachtungen</b>${listHtml(media.visualObservations.map(row => `${timestamp(row)} · ${row.text || ''}`))}</div>` : ''}
    ${array(media.audioObservations).length ? `<div class="section"><b>Tonbeobachtungen</b>${listHtml(media.audioObservations.map(row => `${timestamp(row)} · ${row.text || ''}`))}</div>` : ''}
    ${array(media.claims).length ? `<div class="section"><b>Aussagen aus der Quelle · nicht unabhängig bestätigt</b>${listHtml(media.claims.map(row => typeof row === 'string' ? row : `${timestamp(row) ? timestamp(row) + ' · ' : ''}${row.text || row.claim || ''}`))}</div>` : ''}
    ${gaps.length ? `<div class="section"><b>Lücken und Einschränkungen der Auswertung</b>${listHtml(gaps)}</div>` : ''}
    ${item.sourceExcerpt ? `<details class="evidence-detail"><summary>Gespeicherter Auszug der Originalquelle</summary><pre class="transcript">${esc(item.sourceExcerpt)}</pre></details>` : ''}</details>`;
}
function researchHtml(assessment, research, prefix) {
  const sources = array(research.sources);
  const kindLabel = { 'page-read': 'Seite gelesen', 'search-extract': 'Inhalt über Websuche gelesen', 'search-snippet': 'Nur Suchauszug' };
  return `<details class="evidence-detail"><summary>Behauptungen im Quellencheck</summary>${array(assessment.claimChecks).length ? assessment.claimChecks.map(check => `<div class="claim-check"><span class="tag ${check.status === 'contradicted' ? 'bad' : check.status === 'supported' ? '' : 'warn'}">${esc(claimStatus(check.status))}</span><p><strong>${esc(check.claim)}</strong></p><p>${esc(check.finding || 'Noch keine belastbare Feststellung.')}</p>${evidenceReferences(check.sourceIds, sources, prefix) || '<span class="muted">Keine externe Quelle zugeordnet.</span>'}</div>`).join('') : '<div class="muted">Es liegen noch keine einzeln geprüften Behauptungen vor.</div>'}</details>
    <details class="evidence-detail"><summary>Recherchequellen · ${sources.length} gespeicherte Quellen</summary><div class="source-count">${esc(research.readSourceCount ?? 0)} inhaltlich gelesen · ${esc(research.independentDomainCount ?? 0)} unterschiedliche Domains. Unterschiedliche Domains allein garantieren keine unabhängigen Aussagen.</div>${sources.map(source => `<article class="research-source" id="${prefix}-${esc(source.id)}"><div class="actions"><span class="tag">${esc(source.id)}</span><span class="muted">${esc(kindLabel[source.kind] || 'Quellenstatus offen')}</span></div><p>${sourceLink(source.url, source.title || source.domain || 'Quelle öffnen', '')}</p><small class="muted">${esc(source.domain || '')}${source.retrievedAt ? ' · Gelesen ' + esc(dateText(source.retrievedAt)) : ''}${source.publishedAt ? ' · Veröffentlicht ' + esc(source.publishedAt) : ''}</small>${source.text ? `<p>${esc(source.text)}</p>` : '<p>Kein Textauszug gespeichert.</p>'}</article>`).join('') || '<div class="muted">Noch keine zusätzlichen Quellen gespeichert.</div>'}${array(research.queries).length ? `<div class="section"><b>Verwendete Suchfragen</b>${listHtml(research.queries.map(row => row.query))}</div>` : ''}${array(research.warnings).length ? `<div class="section"><b>Offene Punkte der Recherche</b>${listHtml(research.warnings)}</div>` : ''}</details>`;
}

function linkResultHtml(item) {
  const signal = assessmentSignal(item);
  if (!item || item.status !== 'complete') {
    if (item?.status === 'pending') signal.reason = 'Die Auswertung läuft im Hintergrund. Das Ergebnis ist noch offen.';
    return `<article class="link-result-card compact-result"><div class="link-result-head compact-head"><h3>${esc(item?.sourceTitle || 'Link-Check')}</h3></div>${signalHtml(signal)}<details class="compact-report"><summary>Bericht ansehen</summary><div class="compact-report-body"><p class="summary">${esc(item?.error || 'Es liegt noch kein abgeschlossener Bericht vor.')}</p>${item?.url ? sourceLink(item.url, 'Originalquelle öffnen') : ''}</div></details></article>`;
  }
  const assessment = item.assessment || {}, research = item.research || {}, sources = array(research.sources), prefix = `evidence-${++resultRenderCount}`;
  return `<article class="link-result-card compact-result"><div class="link-result-head compact-head"><h3>${esc(assessment.headline || item.sourceTitle || 'Link-Check')}</h3></div>${signalHtml(signal)}
    <details class="compact-report"><summary>Bericht ansehen</summary><div class="compact-report-body"><div class="report-rating"><div><span class="tag">${esc(modeLabel(item.mode))}</span><p class="summary">${esc(assessment.summary)}</p></div><div class="link-score">${esc(scoreText(assessment.score))}<div class="score-note">Bewertung, keine Erfolgswahrscheinlichkeit</div></div></div>
    <div class="actions"><span class="tag ${assessment.verdict === 'strong-fit' ? '' : 'warn'}">${esc(verdictLabel(assessment.verdict))}</span>${sourceLink(item.finalUrl || item.url, 'Originalquelle öffnen')}<span class="muted">${esc(dateText(item.checkedAt || item.createdAt))}</span></div>
    ${item.question ? `<div class="section"><b>Deine Frage</b><p>${esc(item.question)}</p></div>` : ''}
    ${item.classificationReason ? `<div class="section"><b>Warum hier einsortiert?</b><p>${esc(item.classificationReason)}</p></div>` : ''}
    ${mediaHtml(item)}
    <div class="section"><b>Was ist es?</b><p>${esc(assessment.whatItIs || 'Noch nicht klar genug erkennbar.')}</p></div>
    ${dimensionsHtml(assessment, sources, prefix)}
    <div class="link-columns"><div><div class="section"><b>Direkt belegt</b>${listHtml(assessment.evidence)}</div><div class="section"><b>Passung & Nutzen</b>${listHtml(assessment.fit)}</div></div><div><div class="section"><b>Annahmen & Datenlücken</b>${listHtml([...(assessment.assumptions || []), ...(assessment.gaps || [])])}</div><div class="section"><b>Risiken</b>${listHtml(assessment.risks)}</div></div></div>
    <div class="section"><b>Kosten & Aufwand</b><p>${esc(assessment.costsAndEffort || 'Noch zu verifizieren.')}</p></div>
    ${researchHtml(assessment, research, prefix)}${riskMatrixHtml(assessment, sources, prefix)}${implementationHtml(assessment)}<div class="actions"><a class="btn primary" href="/product-creator?opportunityId=${encodeURIComponent(item.id)}">Idee als Produkt ausarbeiten</a></div></div></details></article>`;
}

function renderLinkResults(items) {
  visibleLinkResults = array(items).filter(Boolean);
  const root = $('linkResults');
  root.hidden = false;
  root.innerHTML = visibleLinkResults.map(linkResultHtml).join('');
}

function renderLinkHistory() {
  const items = (state.linkChecks || []).slice(0, 6);
  $('linkHistory').innerHTML = items.length ? `<div class="eyebrow">Letzte Link-Checks</div>` + items.map(item => { const signal = assessmentSignal(item); return `<div class="history-item"><div><button class="filter" data-history-id="${esc(item.id)}">${esc(item.assessment?.headline || item.sourceTitle || 'Link-Check')}</button> <small>${esc(modeLabel(item.mode))}</small></div><span class="signal-history ${signal.color}">${esc(signal.label)}</span></div>`; }).join('') : '';
}

const marketTypeLabel = value => ({ instagram: 'Instagram', tiktok: 'TikTok', website: 'Webseite', newsletter: 'Newsletter', youtube: 'YouTube', linkedin: 'LinkedIn', podcast: 'Podcast', other: 'Weitere Quelle' })[value] || value;
const cadenceLabel = value => ({ daily: 'täglich', weekly: 'wöchentlich', monthly: 'monatlich', quarterly: 'vierteljährlich' })[value] || value || 'regelmäßig';
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
    <div class="actions">${sourceLink(source.url, 'Quelle öffnen')}<span class="tag ${source.monitoringValue === 'high' ? '' : 'warn'}">${esc(cadenceLabel(source.cadence))} prüfen</span>${source.sampleSize ? `<span class="tag">${esc(source.sampleSize)} Inhalte geprüft</span>` : ''}</div>
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
    ? state.watchSources.map(source => `<span class="watch-pill">${sourceLink(source.url, ['instagram', 'tiktok'].includes(source.type) && source.handle ? '@' + source.handle : source.name, '')}<small class="muted">${esc(cadenceLabel(source.cadence))}</small><button title="Nicht mehr regelmäßig prüfen" aria-label="${esc(source.name || source.handle)} nicht mehr beobachten" data-watch-source="${esc(source.id)}" data-watch-enabled="false">×</button></span>`).join('')
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
      cadence: $('cadence').value, weeklyTime: $('weeklyTime').value, weeklyDay: $('weeklyDay').value, keywords: lines($('keywords').value), tiktokAccounts: lines($('tiktokAccounts').value), includeCurated: $('includeCurated').checked,
      maxInitialBudgetEur: Number($('maxBudget').value), maxSetupHours: Number($('maxSetup').value), maxOngoingHoursPerWeek: Number($('maxOngoing').value), topIdeasPerPitch: Number($('topIdeas').value), notes: $('notes').value,
    }) });
    $('settingsState').textContent = 'Gespeichert.'; await loadAll({ fill: false });
  } catch (error) { $('settingsState').textContent = error.message; } finally { setBusy(button, false); }
});

$('runScout').addEventListener('click', async () => {
  const button = $('runScout'); setBusy(button, true, 'Quellen werden geprüft …');
  try {
    const result = await runJob('scout', {});
    const warningText = result.warnings?.length ? ` ${result.warnings.length} Teilquelle(n) waren nicht erreichbar; der Lauf wurde mit den übrigen Quellen beendet.` : '';
    await loadAll({ fill: false });
    $('statusNotice').innerHTML = `Scan fertig: <b>${result.run?.sourceCount || 0} Quellen</b>, <b>${result.opportunities?.length || 0} belastbare Ideen</b>.${esc(warningText)}`;
  } catch (error) { $('statusNotice').textContent = error.resumable ? 'Der Chancenscan läuft im Hintergrund. Lade seinen Status oben erneut.' : error.message; } finally { setBusy(button, false); }
});

$('checkLinks').addEventListener('click', async () => {
  const urls = linkLines($('linkUrls').value);
  if (!urls.length) { $('linkState').textContent = 'Bitte zuerst mindestens einen Link einfügen.'; $('linkUrls').focus(); return; }
  if (urls.length > 10) { $('linkState').textContent = 'Bitte höchstens zehn Links pro Lauf einfügen.'; $('linkUrls').focus(); return; }
  const button = $('checkLinks');
  setBusy(button, true, `${urls.length} Link${urls.length === 1 ? '' : 's'} werden geprüft …`);
  $('linkResults').hidden = true;
  const question = $('linkQuestion').value.trim();
  const results = urls.map(url => ({ status: 'pending', url, error: 'Originalquelle, zusätzliche Belege und Umsetzungsoptionen werden geprüft.' }));
  $('linkState').textContent = `${urls.length} Link${urls.length === 1 ? '' : 's'} werden als Hintergrundjobs gestartet. Den aktuellen Schritt siehst du im Fortschrittsbereich.`;
  await Promise.all(urls.map(async (url, index) => {
    try {
      results[index] = await runJob('check-link', { url, mode: 'auto', question });
    } catch (error) {
      results[index] = error.payload?.linkCheck || { status: error.resumable ? 'pending' : 'failed', url, error: error.resumable ? 'Die Statusverbindung wurde unterbrochen. Die gestartete Auswertung läuft im Hintergrund weiter.' : error.message };
    }
    renderLinkResults(results);
  }));
  const business = results.filter(item => item.status === 'complete' && item.mode === 'business').length;
  const iva = results.filter(item => item.status === 'complete' && item.mode === 'iva-integration').length;
  const failed = results.filter(item => item.status !== 'complete').length;
  $('linkState').textContent = `${business} Business-Chance${business === 1 ? '' : 'n'}, ${iva} IVA-Erweiterung${iva === 1 ? '' : 'en'}${failed ? `, ${failed} noch nicht vollständig geprüft` : ''}. Gespeicherte Checks erscheinen im Verlauf.`;
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
    const result = await runJob('market-research', { topic, keywords: lines($('marketKeywords').value), region: $('marketRegion').value, language: $('marketLanguage').value });
    $('marketState').textContent = `${result.sources?.length || 0} sinnvolle Beobachtungsquellen gefunden. Wähle aus, welche in die regelmäßigen Läufe sollen.`;
    await loadAll({ fill: false });
  } catch (error) {
    $('marketState').textContent = error.resumable ? 'Die Marktrecherche läuft im Hintergrund. Lade ihren Status oben erneut.' : error.message;
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

$('watchType').addEventListener('change', () => { $('watchAddress').placeholder = $('watchType').value === 'website' ? 'https://beispiel.de' : '@beispielkonto'; });
$('cadence').addEventListener('change', () => { $('weeklyDayField').hidden = $('cadence').value !== 'weekly'; });
$('watchSourceForm').addEventListener('submit', async event => {
  event.preventDefault();
  const type = $('watchType').value, raw = $('watchAddress').value.trim();
  let url, handle = '', name;
  try {
    if (type === 'website') {
      url = safeUrl(raw); if (!url || !url.startsWith('https://')) throw new Error('Bitte eine vollständige öffentliche HTTPS-Adresse eingeben.'); name = new URL(url).hostname;
    } else {
      if (/^https?:\/\//i.test(raw)) {
        const parsed = new URL(raw), expected = type === 'instagram' ? 'instagram.com' : 'tiktok.com';
        if (parsed.protocol !== 'https:' || ![expected, `www.${expected}`].includes(parsed.hostname) || parsed.username || parsed.password || parsed.port) throw new Error('Bitte eine öffentliche Profil-URL der ausgewählten Plattform eingeben.');
        handle = parsed.pathname.replace(/^\/@?/, '').replace(/\/$/, '');
      } else handle = raw.replace(/^@/, '');
      if (!/^[a-z\d._]{1,30}$/i.test(handle) || ['reel', 'reels', 'p', 'explore', 'accounts', 'stories'].includes(handle.toLowerCase())) throw new Error('Bitte einen gültigen Profil-Handle eingeben; einzelne Posts gehören oben in die Linkprüfung.');
      url = type === 'instagram' ? `https://www.instagram.com/${handle}/` : `https://www.tiktok.com/@${handle}`; name = '@' + handle;
    }
    const button = $('addWatchSource'); setBusy(button, true, 'Speichert …');
    try {
      await api('/api/opportunities/watch-sources', { method: 'PUT', body: JSON.stringify({ enabled: true, source: { type, url, handle, name, cadence: $('watchCadence').value, reason: 'Vom Nutzer für regelmäßige Beobachtung ausgewählt.', evidence: [], sampleSize: 0 } }) });
      $('watchAddress').value = ''; await loadAll({ fill: false }); $('watchState').textContent = 'Quelle hinzugefügt. Inhalte werden beim nächsten passenden Radar-Lauf geprüft.';
    } finally { setBusy(button, false); }
  } catch (error) { $('watchState').textContent = error.message; }
});
$('jobList').addEventListener('click', event => { const button = event.target.closest('[data-resume-job]'); if (button) { const job = jobStates.get(button.dataset.resumeJob); if (job) void resumeJob(job); } });
$('linkResults').addEventListener('click', event => {
  const link = event.target.closest('.source-ref'); if (!link) return;
  const target = document.getElementById(link.getAttribute('href').slice(1)); if (!target) return;
  const details = target.closest('details'); if (details) details.open = true;
});

$('linkHistory').addEventListener('click', event => {
  const button = event.target.closest('[data-history-id]'); if (!button) return;
  const item = state.linkChecks.find(entry => entry.id === button.dataset.historyId);
  if (item) { renderLinkResults([item]); $('linkResults').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
});

$('filters').addEventListener('click', event => {
  const button = event.target.closest('[data-status]'); if (!button) return;
  state.filter = button.dataset.status; $('filters').querySelectorAll('.filter').forEach(item => item.classList.toggle('active', item === button)); renderOpportunities();
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
loadAll().then(() => { for (const job of pendingJobs()) void resumeJob(job); });
