const $ = id => document.getElementById(id);
const TOKEN_KEY = 'iva_token';
const state = { projects: [], current: null, activeFolderId: 'all', capacityOffset: 0, uploading: false, planbarRefreshing: false, logoUrls: new Map() };
const MANUAL_WORKFLOW_IDS = new Set(['workflow-protocol-summaries', 'funding-monitor', 'planbar-weekly-export', 'planbar-completion-morning', 'montage-required-fields-morning']);

function token() { return localStorage.getItem(TOKEN_KEY) || ''; }
function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function label(value) { return ({ idea: 'Idee', planned: 'Geplant', foundation: 'Basis vorhanden', prepared: 'Vorbereitet', active: 'Aktiv', paused: 'Pausiert', blocked: 'Blockiert', complete: 'Fertig' })[value] || value || 'Geplant'; }
function formatDate(value) { return value ? new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : ''; }
function formatBytes(value) { const bytes = Number(value) || 0; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
function showToast(message, error = false) { const toast = $('toast'); toast.textContent = message; toast.className = `toast${error ? ' error' : ''}`; clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.add('hidden'), 3600); }
function initials(value) { return String(value || 'P').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toLocaleUpperCase('de-DE'); }
function websiteLabel(value) { try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return 'Website'; } }
function instagramLabel(value) { try { return `@${new URL(value).pathname.split('/').filter(Boolean)[0] || 'Instagram'}`; } catch { return 'Instagram'; } }
function projectLogo(project, large = false) {
  const source = state.logoUrls.get(project.id);
  return `<span class="project-logo${large ? ' brand-logo-large' : ''}">${source ? `<img src="${esc(source)}" alt="Logo ${esc(project.name)}">` : esc(initials(project.name))}</span>`;
}

function isoWeekInfo(value) {
  const date = new Date(value);
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  return { isoYear: utc.getUTCFullYear(), week: Math.ceil((((utc - yearStart) / 86400000) + 1) / 7) };
}

function schedulingWeekOptions() {
  const today = new Date();
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const options = [];
  for (let offset = 0; offset < 53; offset += 1) {
    const date = new Date(monday);
    date.setDate(monday.getDate() + (offset * 7));
    const { isoYear, week } = isoWeekInfo(date);
    options.push(`<option value="${isoYear}-${week}">KW ${week} · ${isoYear}</option>`);
  }
  return options.join('');
}

function planbarCapacityOverview(project) {
  const snapshot = project.planbarCapacity;
  const allWeeks = Array.isArray(snapshot?.weeks) ? snapshot.weeks : [];
  if (!allWeeks.length) return '<div class="capacity-overview"><div class="muted">Freie Planbar-Plätze wurden noch nicht eingelesen.</div></div>';
  const size = 4;
  const maxOffset = Math.max(0, allWeeks.length - size);
  const offset = Math.max(0, Math.min(maxOffset, state.capacityOffset));
  const weeks = allWeeks.slice(offset, offset + size);
  const total = weeks.reduce((sum, item) => sum + Number(item.freeSlots || 0), 0);
  const next = allWeeks.find(item => Number(item.freeSlots) > 0);
  const range = weeks.length ? `KW ${weeks[0].week}–${weeks.at(-1).week}` : '';
  const cards = weeks.map(item => `<div class="capacity-week${item.freeSlots > 0 ? ' has-slots' : ''}"><span>KW ${esc(item.week)}</span><strong>${esc(item.freeSlots)}</strong><small>${item.freeSlots === 1 ? 'freier Platz' : 'freie Plätze'}</small></div>`).join('');
  return `<div class="capacity-overview"><div class="capacity-head"><div><div class="eyebrow">Freie Montageplätze</div><div class="capacity-summary"><strong>${esc(total)} freie Plätze</strong> in ${esc(range)}${next ? ` · nächster freier Termin: <b>KW ${esc(next.week)}/${esc(next.isoYear)}</b>` : ''}</div></div><div class="capacity-nav"><button id="capacityPrev" type="button" aria-label="Vier Wochen zurück" ${offset === 0 ? 'disabled' : ''}>←</button><button id="capacityNext" type="button" aria-label="Vier Wochen weiter" ${offset === maxOffset ? 'disabled' : ''}>→</button></div></div><div class="capacity-grid">${cards}</div><div class="capacity-source">Stand ${esc(formatDate(snapshot.updatedAt))} · jede Ressource zählt nur bei vollständig freien fünf Tagen von Montag bis Freitag · ohne Dawid Service und Antonio Lausic</div></div>`;
}

function planbarSearchPanel() {
  return `<section class="planbar-search" aria-labelledby="planbarSearchTitle"><div class="planbar-search-head"><div><div class="eyebrow">Schnell finden · rein lesend</div><h3 id="planbarSearchTitle">Planbar-Suche</h3><div class="muted">Kundenname, Hersteller oder Stichwort eingeben – IVA zeigt KW, sichtbaren Zeitraum und aktuelles Team.</div></div><button class="btn" id="refreshPlanbarSearch" type="button">↻ Planbar aktualisieren</button></div><form class="planbar-search-form" id="planbarSearchForm"><label><span>Name, Hersteller oder Stichwort</span><input id="planbarSearchQuery" maxlength="220" autocomplete="off" required placeholder="z. B. Schneider oder Cuderos"></label><label><span>Zeitraum</span><select id="planbarSearchWeeks"><option value="0">gesamter Datenstand</option><option value="3">nächste 3 Wochen</option><option value="6">nächste 6 Wochen</option><option value="12">nächste 12 Wochen</option></select></label><div class="planbar-search-actions"><button class="btn primary" type="submit">Suchen</button></div></form><div class="planbar-search-results" id="planbarSearchResults"><div class="planbar-search-empty">Suchbegriff eingeben oder den Planbar-Stand aktualisieren.</div></div><div class="planbar-search-meta" id="planbarSearchMeta"></div></section>`;
}

function schedulingHistory(project) {
  return `<h3>Terminierungsaufträge · Live-Status</h3>${(project.customerSchedulingRequests || []).slice(0, 10).map(request => `<p><b>${esc(request.customerName)} · KW ${esc(request.week)}/${esc(request.isoYear)}</b><br><span role="status">${esc(request.schedulingSummary || 'Status wird geprüft …')}</span></p>`).join('')}`;
}

function customerSchedulingSection(project) {
  if (project.id !== 'heat-hero') return '';
  const partners = (project.customerSchedulingPartners || []).length
    ? project.customerSchedulingPartners
    : [
        { id: 'heat-hero', name: 'Heat Hero', prefix: 'HH', schedulingMode: 'free-resource' },
        { id: 'enter', name: 'Enter', prefix: 'EN', schedulingMode: 'enter-block-first' },
        { id: 'd-warmte', name: 'D Warmte', prefix: 'DW', schedulingMode: 'free-resource' },
      ];
  const partnerOptions = partners.map(partner => `<option value="${esc(partner.id)}" data-mode="${esc(partner.schedulingMode)}" data-prefix="${esc(partner.prefix)}">${esc(partner.name)} (${esc(partner.prefix)})</option>`).join('');
  const partnerConfig = partners.map(partner => `${partner.name}=${partner.prefix}`).join('\n');
  const latest = (project.customerSchedulingRequests || [])[0];
  const latestSummary = latest
    ? `Zuletzt: <b>${esc(latest.customerName)}</b> · ${esc(latest.partnerName || 'Heat Hero')} (${esc(latest.partnerPrefix || 'HH')}) · KW ${esc(latest.week)}/${esc(latest.isoYear)} · Material vorher: ${latest.materialDeliverySpace ? 'Ja' : 'Nein'} · geschützt: ${latest.theftWeatherProtected ? 'Ja' : 'Nein'}${latest.allowFreeResourceFallback ? ' · Enter darf freien Platz nutzen' : ''}${latest.additionalInfo ? ' · Zusatzinfo vorhanden' : ''}<br><span id="planbarSchedulingStatus" role="status">${esc(latest.schedulingSummary || 'Noch kein gesicherter Planbar-Slot bestätigt.')}</span>`
    : 'Zuerst den Slot in Planbar sichern, danach fehlende Angaben ergänzen. Noch kein Kunde vorgemerkt.';
  return `<details class="workflow-launcher workflow-launcher-disclosure" aria-labelledby="customerSchedulingTitle"><summary><div class="workflow-launcher-head"><div><div class="eyebrow">Operativer Workflow</div><h2 id="customerSchedulingTitle">Kunde terminieren</h2><div class="muted">${latestSummary}</div></div><span class="workflow-tag">Planbar + Pipedrive</span></div></summary><div class="workflow-launcher-body"><div class="muted scheduling-intro">Kundentyp, Kunde, Kalenderwoche und Materialannahme erfassen. IVA verwendet automatisch das gespeicherte Planbar-Kürzel, wählt den passenden Block-/Freiplatzweg und meldet den verifizierten Termin anschließend in WhatsApp.</div>${planbarCapacityOverview(project)}${planbarSearchPanel()}<form class="schedule-form" id="customerSchedulingForm"><label><span>Kundenname</span><input id="scheduleCustomerName" name="customerName" maxlength="220" autocomplete="off" required placeholder="Vorname Nachname"></label><label><span>Kundentyp / Partner</span><select id="schedulePartner" name="partnerId" required>${partnerOptions}</select></label><label><span>Kalenderwoche</span><select id="scheduleWeek" name="week" required>${schedulingWeekOptions()}</select></label><button class="btn primary" type="submit">Jetzt terminieren</button><div class="schedule-checks"><label class="schedule-check"><input id="scheduleMaterialDeliverySpace" type="checkbox"><span class="schedule-question">Hat der Kunde Platz, Material einige Tage vor Montagebeginn anzunehmen?</span><span class="schedule-answer" data-answer-for="scheduleMaterialDeliverySpace">Nein</span></label><label class="schedule-check"><input id="scheduleTheftWeatherProtected" type="checkbox"><span class="schedule-question">Diebstahl- und wettersicher?</span><span class="schedule-answer" data-answer-for="scheduleTheftWeatherProtected">Nein</span></label><label class="schedule-check" id="scheduleEnterFallbackRow" hidden><input id="scheduleAllowFreeResourceFallback" type="checkbox"><span class="schedule-question">Enter: Falls kein vollständiger ENTER-Block vorhanden ist, einen vollständig freien Montag-bis-Freitag-Platz verwenden?</span><span class="schedule-answer" data-answer-for="scheduleAllowFreeResourceFallback">Nein</span></label></div><label class="schedule-extra"><span>Zusatzinfo · optional</span><textarea id="scheduleAdditionalInfo" maxlength="2000" placeholder="Nur ausfüllen, wenn diese Information zusätzlich in Planbar stehen soll."></textarea></label></form><details class="schedule-partner-settings"><summary>Kundentypen und Planbar-Kürzel verwalten</summary><div class="muted">Eine Zeile pro Typ im Format Name=Kürzel. Enter behält dabei automatisch seinen speziellen Block-Workflow.</div><textarea id="schedulePartnerPrefixes" maxlength="2000">${esc(partnerConfig)}</textarea><button class="btn" id="saveSchedulePartners" type="button">Kürzel speichern</button></details></div></details>`;
}

function forgetProjectLogo(projectId) {
  const existing = state.logoUrls.get(projectId);
  if (existing) URL.revokeObjectURL(existing);
  state.logoUrls.delete(projectId);
}

async function refreshProjectLogo(project) {
  forgetProjectLogo(project.id);
  if (!project.logo) return;
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/logo?v=${encodeURIComponent(project.logo.sha256 || '')}`, { headers: { Authorization: `Bearer ${token()}` } });
    if (!response.ok) return;
    state.logoUrls.set(project.id, URL.createObjectURL(await response.blob()));
  } catch { /* Initialen bleiben als sichere Rückfallebene sichtbar. */ }
}

function logoMime(file) {
  if (['image/png', 'image/jpeg', 'image/webp'].includes(file?.type)) return file.type;
  const extension = String(file?.name || '').toLowerCase().split('.').pop();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' })[extension] || '';
}

async function uploadProjectLogo(projectId, file) {
  if (!file) return null;
  if (file.size > 5 * 1024 * 1024) throw new Error('Das Logo ist größer als 5 MB.');
  const mime = logoMime(file);
  if (!mime) throw new Error('Bitte ein PNG-, JPG- oder WebP-Logo auswählen.');
  const query = new URLSearchParams({ name: file.name, mime });
  return api(`/api/projects/${encodeURIComponent(projectId)}/logo?${query}`, { method: 'POST', headers: { 'Content-Type': mime }, body: file });
}

async function api(path, options = {}) {
  const headers = { Authorization: `Bearer ${token()}`, ...(options.headers || {}) };
  let body = options.body;
  if (body && Object.getPrototypeOf(body) === Object.prototype) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const response = await fetch(path, { ...options, headers, body });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function replaceProject(project) {
  const index = state.projects.findIndex(item => item.id === project.id);
  if (index >= 0) state.projects[index] = project;
  else state.projects.push(project);
  state.current = project;
}

function renderList() {
  $('projectList').innerHTML = state.projects.map(project => `<div class="project-row"><button class="project-main ${state.current?.id === project.id ? 'active' : ''}" data-project-id="${esc(project.id)}">${projectLogo(project)}<span class="project-copy"><b>${esc(project.name)}</b><small class="muted">${esc(project.websiteUrl ? websiteLabel(project.websiteUrl) : label(project.status))}</small></span></button><button class="project-trash" data-delete-id="${esc(project.id)}" title="Projektakte löschen" aria-label="${esc(project.name)} löschen">🗑</button></div>`).join('');
  document.querySelectorAll('[data-project-id]').forEach(button => { button.onclick = () => selectProject(button.dataset.projectId); });
  document.querySelectorAll('[data-delete-id]').forEach(button => { button.onclick = event => { event.stopPropagation(); removeProject(button.dataset.deleteId); }; });
}

function brandSection(project) {
  const website = project.websiteUrl
    ? `<a class="brand-link" href="${esc(project.websiteUrl)}" target="_blank" rel="noopener">↗ ${esc(websiteLabel(project.websiteUrl))}</a>`
    : '<span class="brand-link missing">＋ Website fehlt</span>';
  const instagram = project.instagramUrl
    ? `<a class="brand-link" href="${esc(project.instagramUrl)}" target="_blank" rel="noopener">◎ ${esc(instagramLabel(project.instagramUrl))}</a>`
    : '<span class="brand-link missing">＋ Instagram fehlt</span>';
  return `<section class="brand-card">${projectLogo(project, true)}<div class="brand-info"><div class="eyebrow">Markenprofil</div><h2>${esc(project.name)}</h2><div class="muted brand-hint">${esc(project.description || 'Logo, Website und Social-Profil machen das Projekt auf einen Blick erkennbar.')}</div><div class="brand-links">${website}${instagram}</div></div><button class="btn brand-action" id="editBrand">Marke bearbeiten</button></section>`;
}

function folderTree(project) {
  const folders = project.folders || [];
  const renderChildren = (parentId, depth = 0) => folders
    .filter(folder => (folder.parentId || null) === parentId)
    .sort((a, b) => a.name.localeCompare(b.name, 'de'))
    .map(folder => `<button class="folder-btn ${state.activeFolderId === folder.id ? 'active' : ''}" data-folder-id="${esc(folder.id)}" style="padding-left:${8 + depth * 17}px"><span>📁</span><span>${esc(folder.name)}</span></button>${renderChildren(folder.id, depth + 1)}`)
    .join('');
  return `<button class="folder-btn ${state.activeFolderId === 'all' ? 'active' : ''}" data-folder-id="all"><span>▦</span><span>Alle Dateien</span></button><button class="folder-btn ${state.activeFolderId === 'root' ? 'active' : ''}" data-folder-id="root"><span>⌂</span><span>Ohne Ordner</span></button>${renderChildren(null)}`;
}

function currentFolderName(project) {
  if (state.activeFolderId === 'all') return 'Alle Dateien';
  if (state.activeFolderId === 'root') return 'Ohne Ordner';
  return (project.folders || []).find(folder => folder.id === state.activeFolderId)?.name || 'Alle Dateien';
}

function notesSection(project) {
  const notes = [...(project.notes || [])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return `<section class="card"><div class="section-head"><div><div class="eyebrow">Ganz oben in der Projektakte</div><h2>Notizen, Ideen & Absprachen</h2><div class="muted">Alles, was zum Projekt festgehalten werden soll.</div></div><span class="badge active">${notes.length} ${notes.length === 1 ? 'Notiz' : 'Notizen'}</span></div><div class="note-compose"><textarea id="noteText" maxlength="12000" placeholder="Idee, Gesprächsnotiz oder Absprache eintragen …"></textarea><button class="btn primary" id="addNote">＋ Notiz hinzufügen</button></div><div class="note-list">${notes.length ? notes.map(note => `<article class="note"><p>${esc(note.text)}</p><small>${esc(formatDate(note.createdAt))}</small></article>`).join('') : '<div class="muted">Noch keine Notiz – hier kannst du die erste Idee festhalten.</div>'}</div></section>`;
}

function archiveSection(project) {
  const selectedFiles = (project.files || []).filter(file => state.activeFolderId === 'all' || (state.activeFolderId === 'root' ? !file.folderId : file.folderId === state.activeFolderId));
  const folderById = new Map((project.folders || []).map(folder => [folder.id, folder]));
  return `<section class="card"><div class="section-head"><div><div class="eyebrow">Dokumente dauerhaft zuordnen</div><h2>Projektakte</h2><div class="muted">Ordner und Unterordner anlegen, mehrere Dateien auswählen oder hier hineinziehen.</div></div><button class="btn" id="newFolder">＋ Ordner</button></div><div class="archive-layout"><nav class="folders" aria-label="Projektordner">${folderTree(project)}</nav><div class="files-panel"><h3>${esc(currentFolderName(project))}</h3><div class="dropzone" id="dropzone"><b>＋ Dateien hier hineinziehen</b><small>oder klicken und mehrere Dokumente auswählen · maximal 25 MB je Datei</small></div><div class="upload-status" id="uploadStatus"></div><div class="file-list">${selectedFiles.length ? selectedFiles.map(file => `<article class="file"><div class="file-icon">DOC</div><div><b>${esc(file.name)}</b><small>${esc(folderById.get(file.folderId)?.name || 'Ohne Ordner')} · ${esc(formatBytes(file.bytes))} · ${esc(formatDate(file.createdAt))}</small></div><button class="btn" data-open-file="${esc(file.id)}">Öffnen</button></article>`).join('') : '<div class="muted">In dieser Ansicht liegen noch keine Dokumente.</div>'}</div></div></div></section>`;
}

function operationalSections(project) {
  const automations = project.automations || [];
  const phases = project.phases || [];
  const areas = project.areas || [];
  const workflowCards = automations.map(item => {
    const canRunNow = ['active', 'paused'].includes(item.status) && MANUAL_WORKFLOW_IDS.has(item.id);
    const action = canRunNow ? 'run' : 'prepare';
    const actionLabel = canRunNow ? '▶ Jetzt auslösen' : '✦ Mit IVA fertig bauen';
    const actionHint = canRunNow
      ? 'Diesen Workflow jetzt einmal außerplanmäßig starten'
      : 'IVA/Codex beauftragen, den fehlenden Ausführungsweg vollständig zu bauen, zu testen und live auszuliefern';
    return `<article class="automation"><div class="automation-top"><label class="automation-name"><span>Name</span><input value="${esc(item.name)}" maxlength="220" data-workflow-name="${esc(item.id)}" aria-label="Workflow-Name bearbeiten"></label><label class="switch" title="${esc(item.toggleAvailable ? 'Workflow an- oder ausschalten' : 'Noch nicht ausführbar')}"><input type="checkbox" data-project-automation="${esc(item.id)}" ${item.enabled ? 'checked' : ''} ${item.toggleAvailable ? '' : 'disabled'}><span class="slider"></span></label></div><div class="automation-state"><span class="badge ${esc(item.status)}">${esc(item.enabled ? 'An' : item.toggleAvailable ? 'Aus' : label(item.status))}</span></div><div class="automation-actions"><button class="btn" type="button" data-workflow-save="${esc(item.id)}">Name speichern</button><button class="btn ${canRunNow ? 'primary' : 'finish'}" type="button" data-workflow-action="${action}" data-workflow-id="${esc(item.id)}" title="${esc(actionHint)}">${actionLabel}</button></div><details class="automation-details"><summary>Details anzeigen</summary><p>${esc(item.purpose)}</p><div class="meta"><div><span>Zeitplan</span><b>${esc(item.schedule)}</b></div><div><span>Ausführung</span><b>${esc(item.execution)}</b></div></div><div class="rule"><b>Sicherheitsregel:</b> ${esc(item.safety)}</div><div class="next"><b>Nächster Schritt:</b> ${esc(item.nextStep)}</div></details></article>`;
  }).join('');
  return `${automations.length ? `<section class="card"><h2>Automationen und Workflows</h2><div class="muted">Namen direkt anpassen und speichern. Laufende Workflows kannst du sofort manuell auslösen; geplante oder blockierte Abläufe gibst du mit „Mit IVA fertig bauen“ als vollständigen Umsetzungsauftrag zurück.</div><div class="metrics"><div class="metric"><b>${automations.filter(item => item.enabled).length}</b><small>eingeschaltet</small></div><div class="metric"><b>${automations.filter(item => item.toggleAvailable && !item.enabled).length}</b><small>ausgeschaltet</small></div><div class="metric"><b>${automations.filter(item => item.status === 'prepared').length}</b><small>vorbereitet</small></div><div class="metric"><b>${automations.filter(item => ['planned', 'blocked'].includes(item.status)).length}</b><small>noch fertigzubauen</small></div></div><div class="automation-grid">${workflowCards}</div></section>` : ''}${phases.length ? `<section class="card"><h2>Projektphasen</h2><div class="muted">Roadmap und aktueller Stand.</div>${phases.map(item => `<div class="road"><strong>${esc(item.phase)}</strong><div><b>${esc(item.name)}</b><small>${esc(item.result)}</small></div><span class="badge ${esc(item.status)}">${esc(label(item.status))}</span></div>`).join('')}</section>` : ''}${areas.length ? `<section class="card"><h2>Unterbereiche</h2><div class="muted">Arbeitsbereiche, Verantwortung und nächste Schritte.</div><div class="item-grid">${areas.map(item => `<article class="item"><div class="head"><h3>${esc(item.name)}</h3><span class="badge ${esc(item.status)}">${esc(label(item.status))}</span></div><p>${esc(item.summary)}</p><div class="next"><b>Nächster Schritt:</b> ${esc(item.nextStep)}</div></article>`).join('')}</div></section>` : ''}`;
}

function collapseProjectSections() {
  document.querySelectorAll('#content > section.card').forEach(section => {
    const heading = section.querySelector('h2');
    if (!heading) return;
    const title = heading.textContent;
    const subtitle = section.querySelector('.muted')?.textContent || '';
    const details = document.createElement('details');
    details.className = 'card project-disclosure';
    const summary = document.createElement('summary');
    summary.innerHTML = `<div class="summary-copy"><h2>${esc(title)}</h2>${subtitle ? `<div class="muted">${esc(subtitle)}</div>` : ''}</div>`;
    const body = document.createElement('div');
    body.className = 'disclosure-body';
    heading.remove();
    const subtitleNode = [...section.querySelectorAll('.muted')].find(node => node.textContent === subtitle);
    if (subtitleNode) subtitleNode.remove();
    while (section.firstChild) body.appendChild(section.firstChild);
    details.append(summary, body);
    section.replaceWith(details);
  });
}

function bindProjectActions() {
  const capacityPrev = $('capacityPrev');
  const capacityNext = $('capacityNext');
  if (capacityPrev) capacityPrev.onclick = () => { state.capacityOffset = Math.max(0, state.capacityOffset - 4); render(); };
  if (capacityNext) capacityNext.onclick = () => {
    const maxOffset = Math.max(0, (state.current?.planbarCapacity?.weeks?.length || 0) - 4);
    state.capacityOffset = Math.min(maxOffset, state.capacityOffset + 4);
    render();
  };
  const schedulingForm = $('customerSchedulingForm');
  if (schedulingForm) {
    schedulingForm.onsubmit = requestCustomerScheduling;
    document.querySelectorAll('[data-answer-for]').forEach(answer => {
      const input = $(answer.dataset.answerFor);
      const sync = () => { answer.textContent = input.checked ? 'Ja' : 'Nein'; };
      input.onchange = sync;
      sync();
    });
    const partner = $('schedulePartner');
    const syncPartnerMode = () => {
      const isEnter = partner?.selectedOptions?.[0]?.dataset.mode === 'enter-block-first';
      const row = $('scheduleEnterFallbackRow');
      if (row) row.hidden = !isEnter;
      if (!isEnter && $('scheduleAllowFreeResourceFallback')) {
        $('scheduleAllowFreeResourceFallback').checked = false;
        $('scheduleAllowFreeResourceFallback').dispatchEvent(new Event('change'));
      }
    };
    if (partner) partner.onchange = syncPartnerMode;
    syncPartnerMode();
  }
  const savePartners = $('saveSchedulePartners');
  if (savePartners) savePartners.onclick = saveCustomerSchedulingPartners;
  const planbarSearchForm = $('planbarSearchForm');
  if (planbarSearchForm) planbarSearchForm.onsubmit = searchPlanbar;
  const refreshPlanbarSearchButton = $('refreshPlanbarSearch');
  if (refreshPlanbarSearchButton) refreshPlanbarSearchButton.onclick = refreshPlanbarSearch;
  $('editBrand').onclick = openBrandDialog;
  $('addNote').onclick = addNote;
  $('newFolder').onclick = openFolderDialog;
  document.querySelectorAll('[data-folder-id]').forEach(button => { button.onclick = () => { state.activeFolderId = button.dataset.folderId; render(); }; });
  document.querySelectorAll('[data-open-file]').forEach(button => { button.onclick = () => openFile(button.dataset.openFile); });
  document.querySelectorAll('[data-project-automation]').forEach(input => { input.onchange = () => toggleProjectAutomation(input); });
  document.querySelectorAll('[data-workflow-save]').forEach(button => { button.onclick = () => saveWorkflowName(button); });
  document.querySelectorAll('[data-workflow-action]').forEach(button => { button.onclick = () => runOrPrepareWorkflow(button); });
  const dropzone = $('dropzone');
  dropzone.onclick = () => { if (!state.uploading) $('fileInput').click(); };
  ['dragenter', 'dragover'].forEach(type => dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(type => dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.remove('drag'); }));
  dropzone.addEventListener('drop', event => uploadFiles([...event.dataTransfer.files]));
}

function render() {
  renderList();
  const project = state.current;
  if (!project) {
    $('category').textContent = 'IVA · Projekte';
    $('title').textContent = 'Noch keine Projektakte';
    $('description').textContent = 'Lege mit dem Plus dein erstes Projekt an.';
    $('content').innerHTML = '<div class="empty">＋ Neues Projekt anlegen, anschließend Notizen, Ordner und Dokumente hinzufügen.</div>';
    return;
  }
  if (!['all', 'root'].includes(state.activeFolderId) && !(project.folders || []).some(folder => folder.id === state.activeFolderId)) state.activeFolderId = 'all';
  $('category').textContent = `IVA · ${project.category || 'Projekt'}`;
  $('title').textContent = project.name;
  $('description').textContent = project.description || 'Projektakte für Ideen, Absprachen und Dokumente.';
  const objective = project.objective || project.description;
  $('content').innerHTML = `${customerSchedulingSection(project)}${brandSection(project)}${notesSection(project)}${objective ? `<section class="hero"><div class="eyebrow">Zielbild</div><h2>${esc(objective)}</h2></section>` : ''}${archiveSection(project)}${operationalSections(project)}`;
  collapseProjectSections();
  if ($('customerSchedulingForm')) $('customerSchedulingForm').insertAdjacentHTML('afterend', `<section id="schedulingHistory" class="capacity-overview">${schedulingHistory(project)}</section>`);
  if ($('customerSchedulingForm')) {
    $('customerSchedulingForm').insertAdjacentHTML('beforebegin', '<div class="capacity-overview"><b>Terminlink für Heat-Hero-Kunden und Vertriebspartner</b><p class="muted">Ein gemeinsamer Link, bei jeder neuen Anfrage eine leere Maske. Kein Zugang zu IVA oder anderen Kundenakten.</p><button class="btn" id="copyPublicSchedulingLink" type="button">Terminlink kopieren</button> <a class="btn" href="/heat-hero/termin" target="_blank" rel="noopener">Terminseite öffnen</a></div>');
    $('copyPublicSchedulingLink').onclick = async () => {
      const url = new URL('/heat-hero/termin', location.origin).href;
      try { await navigator.clipboard.writeText(url); showToast('Terminlink kopiert – bereit zum Einfügen in Ihre E-Mail.'); }
      catch { showToast(`Terminlink: ${url}`); }
    };
  }
  bindProjectActions();
}

async function requestCustomerScheduling(event) {
  event.preventDefault();
  if (!state.current) return;
  const customerName = $('scheduleCustomerName').value.trim();
  const [isoYear, week] = $('scheduleWeek').value.split('-').map(Number);
  const partnerId = $('schedulePartner').value;
  const materialDeliverySpace = $('scheduleMaterialDeliverySpace').checked;
  const theftWeatherProtected = $('scheduleTheftWeatherProtected').checked;
  const additionalInfo = $('scheduleAdditionalInfo').value.trim();
  const allowFreeResourceFallback = $('scheduleAllowFreeResourceFallback').checked;
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    const project = await api(`/api/projects/${encodeURIComponent(state.current.id)}/customer-scheduling-requests`, {
      method: 'POST',
      body: { customerName, partnerId, isoYear, week, materialDeliverySpace, theftWeatherProtected, allowFreeResourceFallback, additionalInfo },
    });
    replaceProject(project);
    render();
    showToast(project.schedulingDispatch?.status === 'retrying'
      ? `${customerName}: Die automatische Übergabe wird erneut versucht.`
      : `${customerName} für KW ${week}/${isoYear} direkt an den Planbar-Workflow übergeben.`);
  } catch (error) { showToast(error.message, true); }
  finally { if (submit && document.body.contains(submit)) submit.disabled = false; }
}

async function saveCustomerSchedulingPartners() {
  if (!state.current || !$('schedulePartnerPrefixes')) return;
  const lines = $('schedulePartnerPrefixes').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const existing = state.current.customerSchedulingPartners || [];
  try {
    const customerSchedulingPartners = lines.map((line, index) => {
      const separator = line.lastIndexOf('=');
      if (separator < 1) throw new Error(`Zeile ${index + 1}: Bitte Name=Kürzel verwenden.`);
      const name = line.slice(0, separator).trim();
      const prefix = line.slice(separator + 1).trim().toUpperCase();
      if (!name || !/^[A-Z0-9]{1,6}$/.test(prefix)) throw new Error(`Zeile ${index + 1}: Kürzel muss 1 bis 6 Buchstaben oder Zahlen haben.`);
      const previous = existing.find(item => item.name.toLocaleLowerCase('de-DE') === name.toLocaleLowerCase('de-DE') || item.prefix === prefix);
      return {
        id: previous?.id || name.toLocaleLowerCase('de-DE').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
        name,
        prefix,
        schedulingMode: previous?.schedulingMode || (prefix === 'EN' ? 'enter-block-first' : 'free-resource'),
      };
    });
    const project = await api(`/api/projects/${encodeURIComponent(state.current.id)}`, {
      method: 'PATCH',
      body: { customerSchedulingPartners },
    });
    replaceProject(project);
    render();
    showToast('Kundentypen und Planbar-Kürzel gespeichert.');
  } catch (error) { showToast(error.message, true); }
}

function formatPlanbarDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(`${value}T12:00:00`));
}

function planbarEndDate(value) {
  if (!value) return '';
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() - 1);
  return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
}

function renderPlanbarSearchResults(result) {
  const container = $('planbarSearchResults');
  const meta = $('planbarSearchMeta');
  if (!container || !meta) return;
  if (!result.indexedAppointments) {
    container.innerHTML = '<div class="planbar-search-empty">Noch kein Planbar-Datenstand vorhanden. Bitte einmal „Planbar aktualisieren“ drücken.</div>';
  } else if (!result.matches.length) {
    container.innerHTML = `<div class="planbar-search-empty">Kein Treffer für „${esc(result.query)}“${result.weeks ? ` in den nächsten ${esc(result.weeks)} Wochen` : ''}.</div>`;
  } else {
    container.innerHTML = result.matches.map(item => `<article class="planbar-hit"><div class="planbar-hit-week">KW ${esc(item.week)}/${esc(item.isoYear)}</div><div><b>${esc(item.customerName)}</b><small>${esc(formatPlanbarDate(item.startDate))}–${esc(planbarEndDate(item.endDateExclusive))}${item.description ? ` · ${esc(item.description.slice(0, 180))}` : ''}</small></div><div class="planbar-hit-team">${esc(item.team)}</div></article>`).join('');
  }
  const freshness = result.stale ? ' · Stand älter als 36 Stunden – bitte aktualisieren' : '';
  meta.textContent = result.indexedAppointments ? `Planbar-Stand ${formatDate(result.updatedAt)} · ${result.indexedAppointments} Termine eingelesen${freshness}` : '';
}

async function searchPlanbar(event) {
  event?.preventDefault();
  if (!state.current || state.current.id !== 'heat-hero') return;
  const query = $('planbarSearchQuery').value.trim();
  const weeks = Number($('planbarSearchWeeks').value) || 0;
  const submit = event?.submitter;
  if (submit) submit.disabled = true;
  try {
    const params = new URLSearchParams({ query });
    if (weeks) params.set('weeks', String(weeks));
    const result = await api(`/api/projects/heat-hero/planbar-search?${params}`);
    renderPlanbarSearchResults(result);
  } catch (error) {
    if ($('planbarSearchResults')) $('planbarSearchResults').innerHTML = `<div class="planbar-search-empty">${esc(error.message)}</div>`;
  } finally { if (submit) submit.disabled = false; }
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Refresh just the receipt text: never erase a form the user is filling out.
setInterval(async () => {
  if (document.hidden || state.current?.id !== 'heat-hero' || !$('planbarSchedulingStatus')) return;
  try {
    const latestId = state.current.customerSchedulingRequests?.[0]?.id;
    const project = await api('/api/projects/heat-hero');
    const latest = project.customerSchedulingRequests?.find(item => item.id === latestId);
    if (state.current?.id === 'heat-hero' && state.current.customerSchedulingRequests?.[0]?.id === latestId && latest && $('planbarSchedulingStatus')) {
      $('planbarSchedulingStatus').textContent = latest.schedulingSummary || 'Noch kein gesicherter Planbar-Slot bestätigt.';
      for (const request of project.customerSchedulingRequests || []) {
        const previous = state.current.customerSchedulingRequests?.find(item => item.id === request.id);
        if (previous && previous.status !== request.status && ['failed', 'blocked', 'expired', 'incomplete', 'completed', 'details_pending', 'reserved'].includes(request.status)) {
          showToast(`${request.customerName}: ${request.schedulingSummary}`, ['failed', 'blocked', 'expired'].includes(request.status));
        }
      }
      state.current.customerSchedulingRequests = project.customerSchedulingRequests;
      if ($('schedulingHistory')) $('schedulingHistory').innerHTML = schedulingHistory(project);
    }
  } catch { /* Keep the last verified receipt during a temporary network error. */ }
}, 15000);

async function refreshPlanbarSearch() {
  if (state.planbarRefreshing) return;
  const button = $('refreshPlanbarSearch');
  state.planbarRefreshing = true;
  if (button) { button.disabled = true; button.textContent = 'Planbar wird gelesen …'; }
  try {
    const queued = await api('/api/devices/imac-nadine/commands', {
      method: 'POST',
      body: { action: 'planbar.search.refresh', requestedBy: 'projects-planbar-search', requestText: 'Planbar-Suchindex rein lesend aktualisieren' },
    });
    let command = queued.command;
    for (let attempt = 0; attempt < 60 && !['completed', 'failed', 'expired', 'canceled'].includes(command.status); attempt += 1) {
      await pause(2000);
      command = (await api(`/api/devices/imac-nadine/commands/${encodeURIComponent(command.id)}`)).command;
    }
    if (command.status !== 'completed') throw new Error(command.error || 'Der iMac hat die Planbar-Aktualisierung nicht rechtzeitig abgeschlossen.');
    const count = Number(command.result?.appointmentCount || 0);
    showToast(`Planbar aktualisiert: ${count} Kundentermine eingelesen.`);
    if ($('planbarSearchQuery')?.value.trim()) await searchPlanbar();
    else if ($('planbarSearchMeta')) $('planbarSearchMeta').textContent = `Aktualisiert ${formatDate(command.result?.updatedAt)} · ${count} Termine eingelesen`;
  } catch (error) { showToast(error.message, true); }
  finally {
    state.planbarRefreshing = false;
    if (button && document.body.contains(button)) { button.disabled = false; button.textContent = '↻ Planbar aktualisieren'; }
  }
}

async function toggleProjectAutomation(input) {
  if (!state.current) return;
  input.disabled = true;
  try {
    const project = await api(`/api/projects/${encodeURIComponent(state.current.id)}/automations/${encodeURIComponent(input.dataset.projectAutomation)}`, { method: 'PATCH', body: { enabled: input.checked } });
    replaceProject(project);
    render();
    showToast(`Workflow ${input.checked ? 'eingeschaltet' : 'ausgeschaltet'}.`);
  } catch (error) {
    input.checked = !input.checked;
    input.disabled = false;
    showToast(error.message, true);
  }
}

async function saveWorkflowName(button) {
  if (!state.current) return;
  const workflowId = button.dataset.workflowSave;
  const input = document.querySelector(`[data-workflow-name="${CSS.escape(workflowId)}"]`);
  const name = input?.value.trim() || '';
  button.disabled = true;
  try {
    const project = await api(`/api/projects/${encodeURIComponent(state.current.id)}/automations/${encodeURIComponent(workflowId)}`, { method: 'PATCH', body: { name } });
    replaceProject(project);
    render();
    showToast(`Workflow-Name als „${name}“ gespeichert.`);
  } catch (error) { showToast(error.message, true); }
  finally { if (document.body.contains(button)) button.disabled = false; }
}

async function runOrPrepareWorkflow(button) {
  if (!state.current) return;
  const workflowId = button.dataset.workflowId;
  const workflow = (state.current.automations || []).find(item => item.id === workflowId);
  const action = button.dataset.workflowAction;
  const question = action === 'run'
    ? `„${workflow?.name || 'Workflow'}“ jetzt einmal außerplanmäßig auslösen?`
    : `IVA/Codex jetzt beauftragen, „${workflow?.name || 'diesen Workflow'}“ vollständig fertigzubauen, zu testen und live auszuliefern?`;
  if (!window.confirm(question)) return;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = action === 'run' ? 'Wird gestartet …' : 'Wird an IVA übergeben …';
  try {
    const result = await api(`/api/projects/${encodeURIComponent(state.current.id)}/automations/${encodeURIComponent(workflowId)}/${action}`, { method: 'POST' });
    showToast(result.message || (action === 'run' ? 'Workflow wurde gestartet.' : 'Fertigstellungsauftrag wurde an IVA übergeben.'));
  } catch (error) { showToast(error.message, true); }
  finally {
    if (document.body.contains(button)) { button.disabled = false; button.textContent = original; }
  }
}

function selectProject(id) {
  state.current = state.projects.find(project => project.id === id) || state.projects[0] || null;
  state.activeFolderId = 'all';
  state.capacityOffset = 0;
  if (state.current) history.replaceState({}, '', `/projects?id=${encodeURIComponent(state.current.id)}`);
  else history.replaceState({}, '', '/projects');
  render();
}

async function load() {
  try {
    state.projects = await api('/api/projects');
    await Promise.all(state.projects.map(project => refreshProjectLogo(project)));
    const id = new URLSearchParams(location.search).get('id');
    state.current = state.projects.find(project => project.id === id) || state.projects[0] || null;
    render();
    $('status').className = 'status on';
    $('status').textContent = 'aktuell';
  } catch (error) {
    $('status').className = 'status';
    $('status').textContent = error.message;
  }
}

function openBrandDialog() {
  if (!state.current) return;
  $('brandForm').reset();
  $('brandName').value = state.current.name || '';
  $('brandCategory').value = state.current.category || '';
  $('brandWebsite').value = state.current.websiteUrl || '';
  $('brandInstagram').value = state.current.instagramUrl || '';
  $('brandDescription').value = state.current.description || '';
  $('removeBrandLogo').classList.toggle('hidden', !state.current.logo);
  $('brandDialog').showModal();
  setTimeout(() => $('brandName').focus(), 0);
}

async function saveBrand(event) {
  event.preventDefault();
  if (!state.current) return;
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    let project = await api(`/api/projects/${encodeURIComponent(state.current.id)}`, {
      method: 'PATCH',
      body: {
        name: $('brandName').value.trim(),
        category: $('brandCategory').value.trim(),
        websiteUrl: $('brandWebsite').value.trim(),
        instagramUrl: $('brandInstagram').value.trim(),
        description: $('brandDescription').value.trim(),
      },
    });
    const file = $('brandLogo').files[0];
    let logoError = '';
    if (file) {
      try { project = await uploadProjectLogo(project.id, file); }
      catch (error) { logoError = error.message; }
    }
    replaceProject(project);
    state.projects.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    if (file && !logoError) await refreshProjectLogo(project);
    $('brandDialog').close();
    render();
    showToast(logoError ? `Markenprofil gespeichert, Logo nicht übernommen: ${logoError}` : 'Markenprofil gespeichert.', Boolean(logoError));
  } catch (error) { showToast(error.message, true); }
  finally { if (submit) submit.disabled = false; }
}

async function removeBrandLogo() {
  if (!state.current?.logo || !window.confirm('Logo aus diesem Projekt entfernen?')) return;
  try {
    const project = await api(`/api/projects/${encodeURIComponent(state.current.id)}/logo`, { method: 'DELETE' });
    forgetProjectLogo(project.id);
    replaceProject(project);
    $('removeBrandLogo').classList.add('hidden');
    render();
    showToast('Logo entfernt.');
  } catch (error) { showToast(error.message, true); }
}

async function addNote() {
  const text = $('noteText').value.trim();
  if (!text || !state.current) return;
  try {
    const project = await api(`/api/projects/${encodeURIComponent(state.current.id)}/notes`, { method: 'POST', body: { text } });
    replaceProject(project);
    render();
    showToast('Notiz gespeichert.');
  } catch (error) { showToast(error.message, true); }
}

function openFolderDialog() {
  const parent = (state.current?.folders || []).find(folder => folder.id === state.activeFolderId);
  $('folderParentHint').textContent = parent ? `Der neue Ordner wird Unterordner von „${parent.name}“.` : 'Der neue Ordner wird auf der obersten Ebene angelegt.';
  $('folderName').value = '';
  $('folderDialog').showModal();
  setTimeout(() => $('folderName').focus(), 0);
}

async function createFolder(event) {
  event.preventDefault();
  if (!state.current) return;
  const parentId = (state.current.folders || []).some(folder => folder.id === state.activeFolderId) ? state.activeFolderId : null;
  try {
    const project = await api(`/api/projects/${encodeURIComponent(state.current.id)}/folders`, { method: 'POST', body: { name: $('folderName').value.trim(), parentId } });
    const newFolder = (project.folders || []).find(folder => !(state.current.folders || []).some(old => old.id === folder.id));
    replaceProject(project);
    state.activeFolderId = newFolder?.id || parentId || 'all';
    $('folderDialog').close();
    render();
    showToast('Ordner angelegt.');
  } catch (error) { showToast(error.message, true); }
}

async function uploadFiles(files) {
  if (!state.current || state.uploading || !files.length) return;
  if (files.length > 20) { showToast('Bitte höchstens 20 Dateien auf einmal auswählen.', true); return; }
  state.uploading = true;
  const projectId = state.current.id;
  const folderId = (state.current.folders || []).some(folder => folder.id === state.activeFolderId) ? state.activeFolderId : '';
  let uploaded = 0;
  try {
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} ist größer als 25 MB.`);
      if ($('uploadStatus')) $('uploadStatus').textContent = `${uploaded + 1} von ${files.length}: ${file.name}`;
      const query = new URLSearchParams({ name: file.name, mime: file.type || 'application/octet-stream' });
      if (folderId) query.set('folderId', folderId);
      await api(`/api/projects/${encodeURIComponent(projectId)}/files?${query}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      uploaded += 1;
    }
    const project = await api(`/api/projects/${encodeURIComponent(projectId)}`);
    replaceProject(project);
    render();
    showToast(`${uploaded} ${uploaded === 1 ? 'Datei' : 'Dateien'} gespeichert.`);
  } catch (error) { showToast(`${uploaded} gespeichert · ${error.message}`, true); }
  finally { state.uploading = false; $('fileInput').value = ''; }
}

async function openFile(fileId) {
  if (!state.current) return;
  const popup = window.open('about:blank', '_blank');
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(state.current.id)}/files/${encodeURIComponent(fileId)}`, { headers: { Authorization: `Bearer ${token()}` } });
    if (!response.ok) throw new Error('Dokument konnte nicht geöffnet werden.');
    const objectUrl = URL.createObjectURL(await response.blob());
    if (popup) popup.location = objectUrl;
    else window.location.href = objectUrl;
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  } catch (error) { if (popup) popup.close(); showToast(error.message, true); }
}

async function removeProject(id) {
  const project = state.projects.find(item => item.id === id);
  if (!project) return;
  const confirmed = window.confirm(`Projektakte „${project.name}“ wirklich dauerhaft löschen?\n\nNotizen, Ordner und Projektdateien werden entfernt. Kundenakten, Pipedrive und Qonekto/Blau Direkt bleiben unverändert.`);
  if (!confirmed) return;
  try {
    await api(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
    forgetProjectLogo(id);
    state.projects = state.projects.filter(item => item.id !== id);
    if (state.current?.id === id) state.current = state.projects[0] || null;
    state.activeFolderId = 'all';
    if (state.current) history.replaceState({}, '', `/projects?id=${encodeURIComponent(state.current.id)}`);
    else history.replaceState({}, '', '/projects');
    render();
    showToast(`Projekt „${project.name}“ wurde dauerhaft gelöscht.`);
  } catch (error) { showToast(error.message, true); }
}

$('token').value = token();
$('saveToken').onclick = () => { localStorage.setItem(TOKEN_KEY, $('token').value.trim()); load(); };
$('newProject').onclick = () => { $('projectForm').reset(); $('projectDialog').showModal(); setTimeout(() => $('projectName').focus(), 0); };
$('projectForm').onsubmit = async event => {
  event.preventDefault();
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    const description = $('projectDescription').value.trim();
    let project = await api('/api/projects', { method: 'POST', body: { name: $('projectName').value.trim(), category: $('projectCategory').value.trim(), websiteUrl: $('projectWebsite').value.trim(), instagramUrl: $('projectInstagram').value.trim(), description, objective: description, status: 'idea' } });
    const file = $('projectLogo').files[0];
    let logoError = '';
    if (file) {
      try {
        project = await uploadProjectLogo(project.id, file);
        await refreshProjectLogo(project);
      } catch (error) { logoError = error.message; }
    }
    state.projects.push(project);
    state.projects.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    $('projectDialog').close();
    selectProject(project.id);
    showToast(logoError ? `Projekt angelegt, Logo nicht übernommen: ${logoError}` : 'Projektakte angelegt.', Boolean(logoError));
  } catch (error) { showToast(error.message, true); }
  finally { if (submit) submit.disabled = false; }
};
$('brandForm').onsubmit = saveBrand;
$('removeBrandLogo').onclick = removeBrandLogo;
$('folderForm').onsubmit = createFolder;
document.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => $(button.dataset.close).close(); });
$('fileInput').onchange = event => uploadFiles([...event.target.files]);
$('ivaHelper').onclick = () => { location.href = '/cockpit'; };
load();
