const $ = id => document.getElementById(id);
const TOKEN_KEY = 'iva_token';
const state = { projects: [], current: null, activeFolderId: 'all', uploading: false };

function token() { return localStorage.getItem(TOKEN_KEY) || ''; }
function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function label(value) { return ({ idea: 'Idee', planned: 'Geplant', foundation: 'Basis vorhanden', prepared: 'Vorbereitet', active: 'Aktiv', paused: 'Pausiert', blocked: 'Blockiert', complete: 'Fertig' })[value] || value || 'Geplant'; }
function formatDate(value) { return value ? new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : ''; }
function formatBytes(value) { const bytes = Number(value) || 0; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
function showToast(message, error = false) { const toast = $('toast'); toast.textContent = message; toast.className = `toast${error ? ' error' : ''}`; clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.add('hidden'), 3600); }

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
  $('projectList').innerHTML = state.projects.map(project => `<div class="project-row"><button class="project-main ${state.current?.id === project.id ? 'active' : ''}" data-project-id="${esc(project.id)}"><b>${esc(project.name)}</b><small class="muted">${esc(label(project.status))}</small></button><button class="project-trash" data-delete-id="${esc(project.id)}" title="Projektakte löschen" aria-label="${esc(project.name)} löschen">🗑</button></div>`).join('');
  document.querySelectorAll('[data-project-id]').forEach(button => { button.onclick = () => selectProject(button.dataset.projectId); });
  document.querySelectorAll('[data-delete-id]').forEach(button => { button.onclick = event => { event.stopPropagation(); removeProject(button.dataset.deleteId); }; });
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
  return `${automations.length ? `<section class="card"><h2>Automationen und Workflows</h2><div class="muted">Jeden ausführbaren Ablauf hier direkt an- oder ausschalten. Details bleiben standardmäßig zugeklappt.</div><div class="metrics"><div class="metric"><b>${automations.filter(item => item.enabled).length}</b><small>eingeschaltet</small></div><div class="metric"><b>${automations.filter(item => item.toggleAvailable && !item.enabled).length}</b><small>ausgeschaltet</small></div><div class="metric"><b>${automations.filter(item => item.status === 'prepared').length}</b><small>vorbereitet</small></div><div class="metric"><b>${automations.filter(item => item.status === 'planned').length}</b><small>geplant</small></div></div><div class="automation-grid">${automations.map(item => `<article class="automation"><div class="automation-top"><div><h3>${esc(item.name)}</h3><span class="badge ${esc(item.status)}">${esc(item.enabled ? 'An' : item.toggleAvailable ? 'Aus' : label(item.status))}</span></div><label class="switch" title="${esc(item.toggleAvailable ? 'Workflow an- oder ausschalten' : 'Noch nicht ausführbar')}"><input type="checkbox" data-project-automation="${esc(item.id)}" ${item.enabled ? 'checked' : ''} ${item.toggleAvailable ? '' : 'disabled'}><span class="slider"></span></label></div><details class="automation-details"><summary>Details anzeigen</summary><p>${esc(item.purpose)}</p><div class="meta"><div><span>Zeitplan</span><b>${esc(item.schedule)}</b></div><div><span>Ausführung</span><b>${esc(item.execution)}</b></div></div><div class="rule"><b>Sicherheitsregel:</b> ${esc(item.safety)}</div><div class="next"><b>Nächster Schritt:</b> ${esc(item.nextStep)}</div></details></article>`).join('')}</div></section>` : ''}${phases.length ? `<section class="card"><h2>Projektphasen</h2><div class="muted">Roadmap und aktueller Stand.</div>${phases.map(item => `<div class="road"><strong>${esc(item.phase)}</strong><div><b>${esc(item.name)}</b><small>${esc(item.result)}</small></div><span class="badge ${esc(item.status)}">${esc(label(item.status))}</span></div>`).join('')}</section>` : ''}${areas.length ? `<section class="card"><h2>Unterbereiche</h2><div class="muted">Arbeitsbereiche, Verantwortung und nächste Schritte.</div><div class="item-grid">${areas.map(item => `<article class="item"><div class="head"><h3>${esc(item.name)}</h3><span class="badge ${esc(item.status)}">${esc(label(item.status))}</span></div><p>${esc(item.summary)}</p><div class="next"><b>Nächster Schritt:</b> ${esc(item.nextStep)}</div></article>`).join('')}</div></section>` : ''}`;
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
  $('addNote').onclick = addNote;
  $('newFolder').onclick = openFolderDialog;
  document.querySelectorAll('[data-folder-id]').forEach(button => { button.onclick = () => { state.activeFolderId = button.dataset.folderId; render(); }; });
  document.querySelectorAll('[data-open-file]').forEach(button => { button.onclick = () => openFile(button.dataset.openFile); });
  document.querySelectorAll('[data-project-automation]').forEach(input => { input.onchange = () => toggleProjectAutomation(input); });
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
  $('content').innerHTML = `${notesSection(project)}${objective ? `<section class="hero"><div class="eyebrow">Zielbild</div><h2>${esc(objective)}</h2></section>` : ''}${archiveSection(project)}${operationalSections(project)}`;
  collapseProjectSections();
  bindProjectActions();
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

function selectProject(id) {
  state.current = state.projects.find(project => project.id === id) || state.projects[0] || null;
  state.activeFolderId = 'all';
  if (state.current) history.replaceState({}, '', `/projects?id=${encodeURIComponent(state.current.id)}`);
  else history.replaceState({}, '', '/projects');
  render();
}

async function load() {
  try {
    state.projects = await api('/api/projects');
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
  try {
    const description = $('projectDescription').value.trim();
    const project = await api('/api/projects', { method: 'POST', body: { name: $('projectName').value.trim(), category: $('projectCategory').value.trim(), description, objective: description, status: 'idea' } });
    state.projects.push(project);
    state.projects.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    $('projectDialog').close();
    selectProject(project.id);
    showToast('Projektakte angelegt.');
  } catch (error) { showToast(error.message, true); }
};
$('folderForm').onsubmit = createFolder;
document.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => $(button.dataset.close).close(); });
$('fileInput').onchange = event => uploadFiles([...event.target.files]);
$('ivaHelper').onclick = () => { location.href = '/cockpit'; };
load();
