const $ = id => document.getElementById(id);
const token = () => localStorage.getItem('iva_token') || '';
const state = { status: null, roles: [], current: null, selectedCandidate: null };
const statusLabels = { new: 'Neu', review: 'Prüfen', 'contact-planned': 'Kontakt geplant', contacted: 'Kontaktiert', interview: 'Interview', hold: 'Zurückgestellt', rejected: 'Abgesagt', hired: 'Eingestellt' };

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(json?.error || `HTTP ${response.status}`);
  return json;
}
async function upload(path, file) {
  const query = new URLSearchParams({ name: file.name, mime: file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/plain') });
  const response = await fetch(`${path}?${query}`, { method: 'POST', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': query.get('mime') }, body: file });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(json?.error || `HTTP ${response.status}`);
  return json;
}
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const lines = value => [...new Set(String(value || '').split(/\n|,/).map(item => item.trim()).filter(Boolean))];
const displayLines = value => (value || []).join('\n');
function notify(message, type = '') { const box = $('globalNotice'); box.hidden = false; box.className = `notice ${type}`; box.textContent = message; }
function setBusy(button, busy, busyText = 'Bitte warten …') { if (!button) return; if (busy) { button.dataset.label = button.textContent; button.textContent = busyText; button.disabled = true; } else { button.textContent = button.dataset.label || button.textContent; button.disabled = false; } }

function renderMetrics() {
  const counts = state.status?.counts || {};
  const cards = [['Stellen', counts.roles || 0], ['Aktiv', counts.activeRoles || 0], ['Kandidaten', counts.candidates || 0], ['Im Interview', counts.interview || 0], ['Eingestellt', counts.hired || 0]];
  $('metrics').innerHTML = cards.map(([label, value]) => `<div class="metric"><b>${esc(value)}</b><small>${esc(label)}</small></div>`).join('');
}
function renderRoles() {
  $('roleList').innerHTML = state.roles.length ? state.roles.map(role => `<button class="role${state.current?.id === role.id ? ' active' : ''}" data-role-id="${esc(role.id)}"><b>${esc(role.role)}</b><small>${esc(role.project || 'Ohne Projekt')} · ${esc(role.status)}</small></button>`).join('') : '<div class="empty">Noch keine Stelle angelegt.</div>';
}
function resetRoleForm() {
  state.current = null; state.selectedCandidate = null;
  $('roleForm').reset(); $('roleStatus').value = 'active'; $('roleFormTitle').textContent = 'Neue Stelle'; $('deleteRole').hidden = true;
  ['searchCard', 'candidateAddCard', 'candidateListCard', 'candidateDetail', 'guideCard'].forEach(id => { $(id).hidden = true; });
  renderRoles();
}
function fillRole(role) {
  $('roleFormTitle').textContent = role.role; $('role').value = role.role || ''; $('project').value = role.project || ''; $('description').value = role.description || '';
  $('mustHave').value = displayLines(role.mustHave); $('niceToHave').value = displayLines(role.niceToHave); $('titles').value = displayLines(role.titles); $('excludedTerms').value = displayLines(role.excludedTerms);
  $('locations').value = displayLines(role.locations); $('remote').value = role.remote || ''; $('languages').value = displayLines(role.languages); $('industries').value = displayLines(role.industries); $('seniority').value = displayLines(role.seniority); $('roleStatus').value = role.status || 'active';
  $('deleteRole').hidden = false; ['searchCard', 'candidateAddCard', 'candidateListCard', 'guideCard'].forEach(id => { $(id).hidden = false; });
}
function rolePayload() {
  return { role: $('role').value.trim(), project: $('project').value.trim(), description: $('description').value.trim(), mustHave: lines($('mustHave').value), niceToHave: lines($('niceToHave').value), titles: lines($('titles').value), excludedTerms: lines($('excludedTerms').value), locations: lines($('locations').value), remote: $('remote').value.trim(), languages: lines($('languages').value), industries: lines($('industries').value), seniority: lines($('seniority').value), status: $('roleStatus').value };
}
function renderSearchPlan() {
  const plan = state.current?.searchPlan || {};
  $('searchList').innerHTML = (plan.queries || []).map(item => `<div class="search-row"><b>${esc(item.label)}</b><code>${esc(item.query)}</code><button class="btn small" data-copy-query="${esc(item.id)}">Kopieren</button><a class="btn primary small" href="${esc(item.url)}" target="_blank" rel="noopener">LinkedIn öffnen ↗</a></div>`).join('') || '<div class="empty">Noch kein Suchplan verfügbar.</div>';
  const filters = plan.filters || {};
  $('filterHint').textContent = `Danach manuell filtern: Standort ${filters.location?.join(', ') || 'offen'} · Remote ${filters.remote || 'offen'} · Sprachen ${filters.languages?.join(', ') || 'offen'} · Branche ${filters.industries?.join(', ') || 'offen'}`;
}
function renderGuide() {
  const guide = state.current?.interviewGuide;
  $('guide').innerHTML = guide?.agenda?.map(item => `<details><summary>${esc(item.minutes)} Min. · ${esc(item.topic)}</summary>${item.questions?.length ? item.questions.map(question => `<p><b>${esc(question.criterion)}:</b> ${esc(question.question)}</p>`).join('') : '<p>Für diesen Abschnitt die gleiche Struktur bei allen Kandidaten verwenden.</p>'}</details>`).join('') || '<div class="empty">Noch kein Leitfaden.</div>';
}
function candidateCard(item) {
  const screening = item.screening;
  const score = screening?.evidenceScore;
  const evidenced = screening?.mustHave?.filter(entry => entry.status === 'evidenced').length || 0;
  const total = screening?.mustHave?.length || state.current?.mustHave?.length || 0;
  return `<article class="candidate" data-candidate-id="${esc(item.id)}"><div class="candidate-head"><div><h3>${esc(item.name || 'LinkedIn-Kandidat')}</h3><div class="muted small">${esc(item.headline || item.location || 'Profilangaben noch ergänzen')}</div></div><div class="score">${score == null ? '–' : esc(score)}</div></div><div class="tags"><span class="tag">${esc(statusLabels[item.status] || item.status)}</span><span class="tag ${screening ? '' : 'warn'}">${screening ? `${evidenced}/${total} Muss belegt` : 'Text/PDF fehlt'}</span>${item.document ? '<span class="tag">PDF</span>' : ''}</div><select class="input" data-candidate-status><option value="new">Neu</option><option value="review">Prüfen</option><option value="contact-planned">Kontakt geplant</option><option value="contacted">Kontaktiert</option><option value="interview">Interview</option><option value="hold">Zurückgestellt</option><option value="rejected">Abgesagt</option><option value="hired">Eingestellt</option></select><div class="actions"><button class="btn" data-view-candidate>Details & Belege</button>${item.linkedInUrl ? `<a class="btn" href="${esc(item.linkedInUrl)}" target="_blank" rel="noopener">LinkedIn ↗</a>` : ''}</div></article>`;
}
function renderCandidates() {
  const items = state.current?.candidates || [];
  $('candidateList').innerHTML = items.length ? items.map(candidateCard).join('') : '<div class="empty" style="grid-column:1/-1">Noch kein Kandidat. Öffne eine Suche und übernimm die ersten interessanten Profile.</div>';
  $('candidateList').querySelectorAll('[data-candidate-id]').forEach(card => { const item = items.find(candidate => candidate.id === card.dataset.candidateId); const select = card.querySelector('[data-candidate-status]'); if (item && select) select.value = item.status; });
}
const evidenceHtml = items => (items || []).map(item => `<div class="evidence-item"><b class="${item.status === 'evidenced' ? 'ok' : 'open'}">${item.status === 'evidenced' ? '✓ Belegt' : '? Offen'} · ${esc(item.criterion)}</b><small>${esc(item.evidence || 'Im bereitgestellten Text nicht gefunden.')}</small></div>`).join('') || '<div class="muted">Keine Kriterien.</div>';
function renderCandidateDetail(candidate) {
  state.selectedCandidate = candidate; const screening = candidate.screening; const card = $('candidateDetail'); card.hidden = false;
  card.innerHTML = `<div class="actions" style="justify-content:space-between"><div><div class="eyebrow">Kandidatenprüfung</div><h2>${esc(candidate.name || 'Kandidat')}</h2><div class="muted">${esc(candidate.headline || '')}${candidate.location ? ` · ${esc(candidate.location)}` : ''}</div></div><button class="btn danger" id="deleteCandidate">Kandidat löschen</button></div>
    ${screening ? `<div class="notice good"><b>${esc(screening.evidenceScore)} % der gewichteten Kriterien sind im vorhandenen Text belegt.</b> Nicht gefundene Angaben bleiben offen und sind keine automatische Ablehnung.</div><div class="evidence"><div class="evidence-box"><h3>Muss-Kriterien</h3>${evidenceHtml(screening.mustHave)}</div><div class="evidence-box"><h3>Wunsch-Kriterien</h3>${evidenceHtml(screening.niceToHave)}</div></div>${screening.openQuestions?.length ? `<div class="notice"><b>Im Gespräch klären:</b><br>${screening.openQuestions.map(esc).join('<br>')}</div>` : ''}` : '<div class="notice">Noch kein bewertbarer Text vorhanden. Lade eine PDF hoch oder ergänze manuell belegte Profilangaben.</div>'}
    <div class="fields"><div class="field full"><label>Ergänzende belegte Profilangaben</label><textarea class="input" id="detailProfileText">${esc(candidate.profileText || '')}</textarea></div><div class="field full"><label>Eigene Notizen</label><textarea class="input" id="detailNotes">${esc(candidate.notes || '')}</textarea></div><div class="field"><label>Aufbewahrung prüfen am</label><input class="input" type="date" id="retentionReviewAt" value="${esc(candidate.retentionReviewAt || '')}"></div><div class="field"><label>Dokument</label><div class="filebox">${candidate.document ? `<button class="btn" type="button" id="openCandidateDocument">${esc(candidate.document.name)} öffnen</button>` : '<span class="muted">Keine Datei</span>'}<input id="detailFile" type="file" accept="application/pdf,text/plain,.pdf,.txt" style="margin-top:8px"></div></div></div><div class="actions"><button class="btn primary" id="saveCandidateDetail">Angaben speichern & neu prüfen</button><span class="muted" id="detailState"></span></div>`;
  $('deleteCandidate').addEventListener('click', deleteCandidate);
  $('saveCandidateDetail').addEventListener('click', saveCandidateDetail);
  $('openCandidateDocument')?.addEventListener('click', () => openCandidateDocument(candidate.id));
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function openCandidateDocument(candidateId) {
  try {
    const response = await fetch(`/api/recruiting/candidates/${encodeURIComponent(candidateId)}/document`, { headers: { Authorization: `Bearer ${token()}` } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const url = URL.createObjectURL(await response.blob());
    const popup = window.open(url, '_blank', 'noopener');
    if (!popup) location.assign(url);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) { notify(`Dokument konnte nicht geöffnet werden: ${error.message}`, 'error'); }
}

async function loadAll(preferredRoleId = state.current?.id) {
  [state.status, state.roles] = await Promise.all([api('/api/recruiting/status'), api('/api/recruiting/roles')]); renderMetrics();
  const id = preferredRoleId && state.roles.some(role => role.id === preferredRoleId) ? preferredRoleId : state.roles[0]?.id;
  if (id) await selectRole(id); else resetRoleForm();
}
async function selectRole(id) {
  state.current = await api(`/api/recruiting/roles/${encodeURIComponent(id)}`); state.selectedCandidate = null; $('candidateDetail').hidden = true;
  fillRole(state.current); renderRoles(); renderSearchPlan(); renderCandidates(); renderGuide();
}
async function saveRole(event) {
  event.preventDefault(); const button = event.submitter; setBusy(button, true, 'Speichert …'); $('roleState').textContent = '';
  try {
    const saved = state.current?.id ? await api(`/api/recruiting/roles/${encodeURIComponent(state.current.id)}`, { method: 'PATCH', body: JSON.stringify(rolePayload()) }) : await api('/api/recruiting/roles', { method: 'POST', body: JSON.stringify(rolePayload()) });
    await loadAll(saved.id); $('roleState').textContent = 'Gespeichert.'; notify('Stelle und kostenlose LinkedIn-Suchen sind bereit.', 'good');
  } catch (error) { $('roleState').textContent = error.message; } finally { setBusy(button, false); }
}
async function deleteRole() {
  if (!state.current || !confirm(`Stelle „${state.current.role}“ und alle zugehörigen Kandidaten wirklich löschen?`)) return;
  const button = $('deleteRole'); setBusy(button, true, 'Löscht …');
  try { await api(`/api/recruiting/roles/${encodeURIComponent(state.current.id)}`, { method: 'DELETE' }); await loadAll(''); notify('Stelle und zugehörige Kandidatendaten wurden gelöscht.', 'good'); }
  catch (error) { notify(error.message, 'error'); setBusy(button, false); }
}
async function addCandidate(event) {
  event.preventDefault(); if (!state.current) return; const button = event.submitter; setBusy(button, true, 'Wird angelegt …'); $('candidateState').textContent = '';
  try {
    let candidate = await api(`/api/recruiting/roles/${encodeURIComponent(state.current.id)}/candidates`, { method: 'POST', body: JSON.stringify({ name: $('candidateName').value.trim(), linkedInUrl: $('candidateUrl').value.trim(), headline: $('candidateHeadline').value.trim(), location: $('candidateLocation').value.trim(), profileText: $('candidateText').value.trim() }) });
    const file = $('candidateFile').files[0]; if (file) { $('candidateState').textContent = 'PDF wird gelesen …'; candidate = await upload(`/api/recruiting/candidates/${encodeURIComponent(candidate.id)}/document`, file); }
    $('candidateForm').reset(); await selectRole(state.current.id); renderCandidateDetail(candidate); $('candidateState').textContent = 'Angelegt und geprüft.'; await refreshStatus();
  } catch (error) { $('candidateState').textContent = error.message; } finally { setBusy(button, false); }
}
async function refreshStatus() { state.status = await api('/api/recruiting/status'); renderMetrics(); }
async function saveCandidateDetail() {
  const candidate = state.selectedCandidate; if (!candidate) return; const button = $('saveCandidateDetail'); setBusy(button, true, 'Prüft neu …');
  try {
    let updated = await api(`/api/recruiting/candidates/${encodeURIComponent(candidate.id)}`, { method: 'PATCH', body: JSON.stringify({ profileText: $('detailProfileText').value, notes: $('detailNotes').value, retentionReviewAt: $('retentionReviewAt').value }) });
    const file = $('detailFile').files[0]; if (file) updated = await upload(`/api/recruiting/candidates/${encodeURIComponent(candidate.id)}/document`, file);
    await selectRole(state.current.id); renderCandidateDetail(updated); $('detailState').textContent = 'Gespeichert und neu geprüft.';
  } catch (error) { $('detailState').textContent = error.message; setBusy(button, false); }
}
async function deleteCandidate() {
  const candidate = state.selectedCandidate; if (!candidate || !confirm(`Kandidat „${candidate.name || 'ohne Namen'}“ samt Datei wirklich löschen?`)) return;
  try { await api(`/api/recruiting/candidates/${encodeURIComponent(candidate.id)}`, { method: 'DELETE' }); $('candidateDetail').hidden = true; await selectRole(state.current.id); await refreshStatus(); notify('Kandidat und gespeicherte Datei wurden gelöscht.', 'good'); }
  catch (error) { notify(error.message, 'error'); }
}

$('roleList').addEventListener('click', event => { const button = event.target.closest('[data-role-id]'); if (button) void selectRole(button.dataset.roleId); });
$('roleForm').addEventListener('submit', saveRole); $('newRole').addEventListener('click', resetRoleForm); $('deleteRole').addEventListener('click', deleteRole); $('candidateForm').addEventListener('submit', addCandidate);
$('searchList').addEventListener('click', async event => { const button = event.target.closest('[data-copy-query]'); if (!button) return; const item = state.current?.searchPlan?.queries?.find(query => query.id === button.dataset.copyQuery); if (!item) return; await navigator.clipboard.writeText(item.query); button.textContent = 'Kopiert'; setTimeout(() => { button.textContent = 'Kopieren'; }, 1200); });
$('candidateList').addEventListener('click', async event => { const card = event.target.closest('[data-candidate-id]'); if (!card) return; const id = card.dataset.candidateId; if (event.target.closest('[data-view-candidate]')) { try { renderCandidateDetail(await api(`/api/recruiting/candidates/${encodeURIComponent(id)}`)); } catch (error) { notify(error.message, 'error'); } } });
$('candidateList').addEventListener('change', async event => { if (!event.target.matches('[data-candidate-status]')) return; const card = event.target.closest('[data-candidate-id]'); try { await api(`/api/recruiting/candidates/${encodeURIComponent(card.dataset.candidateId)}`, { method: 'PATCH', body: JSON.stringify({ status: event.target.value }) }); await selectRole(state.current.id); await refreshStatus(); } catch (error) { notify(error.message, 'error'); } });
$('refreshCandidates').addEventListener('click', () => state.current && selectRole(state.current.id));

loadAll().catch(error => notify(error.message.includes('401') ? 'Bitte zuerst im Cockpit den IVA-API-Token speichern.' : error.message, 'error'));
