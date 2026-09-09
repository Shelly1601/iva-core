const $ = id => document.getElementById(id);
const token = () => localStorage.getItem('iva_token') || '';
const state = { entries: [], current: null, status: null, imports: [], capabilities: null, importPolling: false };
const kindLabels = { knowledge: 'Eigenes Wissen', course: 'Kurs', document: 'Dokument', link: 'Link / Quelle' };

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(json?.error || `HTTP ${response.status}`);
  return json;
}
async function upload(path, file) {
  const fallback = file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : file.name.toLowerCase().endsWith('.md') ? 'text/markdown' : 'text/plain';
  const query = new URLSearchParams({ name: file.name, mime: file.type || fallback });
  const response = await fetch(`${path}?${query}`, { method: 'POST', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': query.get('mime') }, body: file });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(json?.error || `HTTP ${response.status}`);
  return json;
}
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const tagList = value => [...new Set(String(value || '').split(/[,\n]/).map(item => item.trim()).filter(Boolean))];
function notify(message, type = '') { const box = $('globalNotice'); box.hidden = false; box.className = `notice ${type}`; box.textContent = message; }
function setBusy(button, busy, text = 'Bitte warten …') { if (busy) { button.dataset.label = button.textContent; button.textContent = text; button.disabled = true; } else { button.textContent = button.dataset.label || button.textContent; button.disabled = false; } }

function renderMetrics() {
  const s = state.status || {};
  $('metrics').innerHTML = [['Einträge', s.total || 0], ['Für IVA bereit', s.ready || 0], ['Material fehlt', s.needsMaterial || 0], ['Kurse', s.courses || 0]].map(([label, value]) => `<div class="metric"><b>${esc(value)}</b><small>${esc(label)}</small></div>`).join('');
}
function renderEntries() {
  $('entryList').innerHTML = state.entries.length ? state.entries.map(item => `<article class="entry" data-entry-id="${esc(item.id)}"><div class="entry-head"><h3>${esc(item.title)}</h3><span class="tag ${esc(item.status)}">${item.status === 'ready' ? 'Für IVA bereit' : 'Material fehlt'}</span></div><p>${esc(item.preview || (item.sourceUrl ? 'Quelle vorgemerkt – Lernmaterial ergänzen.' : 'Noch kein Lerninhalt hinterlegt.'))}</p><div class="tags"><span class="tag">${esc(kindLabels[item.kind] || item.kind)}</span><span class="tag">${esc(item.category)}</span>${item.wordCount ? `<span class="tag">${esc(item.wordCount)} Wörter</span>` : ''}${(item.tags || []).slice(0, 3).map(tag => `<span class="tag">${esc(tag)}</span>`).join('')}</div></article>`).join('') : '<div class="empty">Noch kein Wissen hinterlegt. Klicke auf „Wissen hinzufügen“ und gib IVA den ersten Inhalt.</div>';
}
const importStatusLabels = { queued: 'Wartet', running: 'Läuft', recovering: 'Repariert & läuft weiter', completed: 'Fertig', blocked: 'Aktion nötig', incomplete: 'Fortsetzen', failed: 'Fortsetzen', timed_out: 'Fortsetzen' };
function renderImports() {
  const ready = state.capabilities?.ready === true;
  $('importConnection').textContent = ready ? 'iMac bereit' : state.capabilities?.device?.online ? 'iMac aktualisiert Verbindung' : 'iMac verbindet sich';
  $('importConnection').className = `tag ${ready ? 'ready' : 'needs-material'}`;
  const jobs = state.imports || [];
  $('importJobs').innerHTML = jobs.length ? jobs.map(job => {
    const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
    const statusClass = job.status === 'completed' ? 'completed' : job.actionRequired ? 'blocked' : '';
    const resume = ['blocked', 'failed', 'incomplete', 'timed_out'].includes(job.status)
      ? `<button class="mini-btn" data-resume-import="${esc(job.id)}">Fortsetzen</button>` : '';
    const drive = job.status === 'completed' && job.archiveFolderUrl
      ? `<a class="mini-btn" href="${esc(job.archiveFolderUrl)}" target="_blank" rel="noopener">Lernakte öffnen</a>` : '';
    return `<article class="import-job ${statusClass}"><div class="import-job-head"><b>${esc(job.title)}</b><span class="tag ${esc(job.status)}">${esc(importStatusLabels[job.status] || job.status)}</span></div><small>${esc(job.mode === 'iva-drive' ? 'IVA + Google Drive' : 'Nur IVA')} · ${esc(job.sourceHost || '')}</small><div class="import-progress-head"><strong>${esc(job.phase || 'Aufnahme')}</strong><span>${esc(progress)} %</span></div><div class="import-progress" role="progressbar" aria-label="${esc(job.title)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${esc(progress)}"><span style="width:${esc(progress)}%"></span></div><small>${esc(job.detail || 'Der Import wird vorbereitet.')}</small>${job.active ? '<small class="import-live">● Aktualisiert sich automatisch</small>' : ''}<div class="import-job-actions">${resume}${drive}</div></article>`;
  }).join('') : '<div class="muted">Noch kein automatischer Import gestartet.</div>';
}

function base64Bytes(value) {
  const binary = atob(String(value || ''));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
function bytesBase64(value) {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
async function encryptCredentials(metadata, credentials) {
  if (!globalThis.crypto?.subtle || !metadata?.publicKey) throw new Error('Die sichere iMac-Verschlüsselung ist noch nicht bereit.');
  const publicKey = await crypto.subtle.importKey('spki', base64Bytes(metadata.publicKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const contentKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, contentKey, new TextEncoder().encode(JSON.stringify(credentials)));
  const rawKey = await crypto.subtle.exportKey('raw', contentKey);
  const wrappedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, rawKey);
  return { version: 1, algorithm: 'RSA-OAEP-256+A256GCM', wrappedKey: bytesBase64(wrappedKey), iv: bytesBase64(iv), ciphertext: bytesBase64(ciphertext) };
}
function resetForm() {
  state.current = null; $('entryForm').reset(); $('sourceOwner').value = 'own'; $('kind').value = 'knowledge'; $('formTitle').textContent = 'Neuen Inhalt aufnehmen'; $('deleteEntry').hidden = true; $('formState').textContent = ''; $('detail').hidden = true;
}
function fillForm(item) {
  state.current = item; $('formTitle').textContent = item.title; $('title').value = item.title || ''; $('kind').value = item.kind || 'knowledge'; $('category').value = item.category || ''; $('sourceUrl').value = item.sourceUrl || ''; $('sourceOwner').value = item.sourceOwner || 'own'; $('tags').value = (item.tags || []).join(', '); $('content').value = item.content || ''; $('notes').value = item.notes || ''; $('document').value = ''; $('deleteEntry').hidden = false;
  $('detail').hidden = false; $('detail').innerHTML = `<div class="entry-head"><div><div class="eyebrow">${esc(item.status === 'ready' ? 'Für IVA verfügbar' : 'Noch nicht gelernt')}</div><h2>${esc(item.title)}</h2></div>${item.document ? `<button class="btn" id="openDocument">${esc(item.document.name)} öffnen</button>` : ''}</div><div class="notice ${item.status === 'ready' ? 'good' : ''}">${item.status === 'ready' ? `IVA kann diesen Inhalt jetzt durchsuchen und für Antworten verwenden. ${esc(item.wordCount)} Wörter sind erfasst.` : 'Der Eintrag ist vorgemerkt. Ergänze Text, Transkript oder eine Datei, damit IVA das Wissen wirklich verwenden kann.'}</div>${item.preview ? `<div class="preview">${esc(item.preview)}</div>` : ''}`;
  $('openDocument')?.addEventListener('click', () => openDocument(item.id));
}
function payload() { return { title: $('title').value.trim(), kind: $('kind').value, category: $('category').value.trim(), sourceUrl: $('sourceUrl').value.trim(), sourceOwner: $('sourceOwner').value, tags: tagList($('tags').value), content: $('content').value.trim(), notes: $('notes').value.trim() }; }

async function loadAll(query = '') {
  const suffix = query ? `?query=${encodeURIComponent(query)}` : '';
  const [status, result, imports, capabilities] = await Promise.all([api('/api/knowledge/status'), api(`/api/knowledge${suffix}`), api('/api/knowledge/imports?limit=12'), api('/api/knowledge/import-capabilities')]);
  state.status = status; state.entries = result.entries || []; state.imports = imports.imports || []; state.capabilities = capabilities; renderMetrics(); renderEntries(); renderImports();
}
async function loadImports() {
  if (state.importPolling) return;
  state.importPolling = true;
  try {
    const [imports, capabilities] = await Promise.all([api('/api/knowledge/imports?limit=12'), api('/api/knowledge/import-capabilities')]);
    state.imports = imports.imports || []; state.capabilities = capabilities; renderImports();
  } finally { state.importPolling = false; }
}

async function startImport() {
  const button = $('startImport');
  const title = $('title').value.trim();
  const sourceUrl = $('sourceUrl').value.trim();
  if (!title || !sourceUrl) return notify('Für die automatische Aufnahme fehlen Titel oder Kurslink.', 'error');
  const username = $('loginUsername').value;
  const password = $('loginPassword').value;
  const totp = $('loginTotp').value;
  if ((username && !password) || (!username && password) || (totp && (!username || !password))) return notify('Bitte Benutzername und Passwort gemeinsam angeben – oder alle Zugangsfelder leer lassen und die bestehende Sitzung verwenden.', 'error');
  setBusy(button, true, 'Wird sicher übergeben …'); $('importState').textContent = '';
  try {
    let credentialEnvelope = null;
    if (username || password || totp) {
      if (!state.capabilities?.ready) await loadImports();
      credentialEnvelope = await encryptCredentials(state.capabilities?.credentialEnvelope, { username, password, totp });
    }
    const result = await api('/api/knowledge/imports', { method: 'POST', body: JSON.stringify({
      title,
      sourceUrl,
      category: $('category').value.trim(),
      sourceOwner: $('sourceOwner').value,
      tags: tagList($('tags').value),
      notes: $('notes').value.trim(),
      mode: document.querySelector('input[name="importMode"]:checked')?.value || 'iva-only',
      accessMode: $('accessMode').value,
      credentialEnvelope,
    }) });
    $('loginUsername').value = ''; $('loginPassword').value = ''; $('loginTotp').value = '';
    $('importState').textContent = 'Gestartet.'; notify('Der Wissensimport läuft jetzt auf dem iMac und aktualisiert den Fortschritt automatisch.', 'good');
    state.imports = [result.import, ...state.imports.filter(item => item.id !== result.import.id)]; renderImports();
    await loadAll($('searchInput').value.trim());
  } catch (error) { $('importState').textContent = error.message; notify(error.message, 'error'); }
  finally { setBusy(button, false); }
}

async function resumeImport(id) {
  const button = document.querySelector(`[data-resume-import="${CSS.escape(id)}"]`);
  if (button) setBusy(button, true, 'Startet …');
  try {
    const username = $('loginUsername').value;
    const password = $('loginPassword').value;
    const totp = $('loginTotp').value;
    if ((username && !password) || (!username && password) || (totp && (!username || !password))) throw new Error('Bitte Benutzername und Passwort gemeinsam angeben – oder die gespeicherten Zugangsdaten verwenden.');
    let credentialEnvelope = null;
    if (username || password || totp) {
      if (!state.capabilities?.ready) await loadImports();
      credentialEnvelope = await encryptCredentials(state.capabilities?.credentialEnvelope, { username, password, totp });
    }
    await api(`/api/knowledge/imports/${encodeURIComponent(id)}/resume`, { method: 'POST', body: JSON.stringify({ credentialEnvelope }) });
    $('loginUsername').value = ''; $('loginPassword').value = ''; $('loginTotp').value = '';
    notify('Der gespeicherte Wissensimport wird am ersten offenen Punkt fortgesetzt.', 'good');
    await loadImports();
  } catch (error) { notify(error.message, 'error'); if (button) setBusy(button, false); }
}
async function saveEntry(event) {
  event.preventDefault(); const button = event.submitter; setBusy(button, true, 'IVA nimmt es auf …'); $('formState').textContent = '';
  try {
    let item = state.current ? await api(`/api/knowledge/${encodeURIComponent(state.current.id)}`, { method: 'PATCH', body: JSON.stringify(payload()) }) : await api('/api/knowledge', { method: 'POST', body: JSON.stringify(payload()) });
    const file = $('document').files[0];
    if (file) { $('formState').textContent = 'Datei wird gelesen …'; item = await upload(`/api/knowledge/${encodeURIComponent(item.id)}/document`, file); }
    await loadAll($('searchInput').value.trim()); fillForm(item); $('formState').textContent = 'Gespeichert.'; notify(item.status === 'ready' ? 'Das Wissen ist gespeichert und für IVA verfügbar.' : 'Die Quelle ist vorgemerkt. Ergänze noch Lernmaterial, damit IVA sie verwenden kann.', item.status === 'ready' ? 'good' : '');
  } catch (error) { $('formState').textContent = error.message; notify(error.message, 'error'); } finally { setBusy(button, false); }
}
async function selectEntry(id) { try { const item = await api(`/api/knowledge/${encodeURIComponent(id)}`); fillForm(item); $('entryForm').scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (error) { notify(error.message, 'error'); } }
async function removeEntry() {
  if (!state.current || !confirm(`Wissenseintrag „${state.current.title}“ samt Datei wirklich löschen?`)) return;
  const button = $('deleteEntry'); setBusy(button, true, 'Löscht …');
  try { await api(`/api/knowledge/${encodeURIComponent(state.current.id)}`, { method: 'DELETE' }); resetForm(); await loadAll($('searchInput').value.trim()); notify('Wissenseintrag und zugehörige Datei wurden gelöscht.', 'good'); } catch (error) { notify(error.message, 'error'); setBusy(button, false); }
}
async function openDocument(id) {
  try { const response = await fetch(`/api/knowledge/${encodeURIComponent(id)}/document`, { headers: { Authorization: `Bearer ${token()}` } }); if (!response.ok) throw new Error(`HTTP ${response.status}`); const url = URL.createObjectURL(await response.blob()); const popup = window.open(url, '_blank', 'noopener'); if (!popup) location.assign(url); setTimeout(() => URL.revokeObjectURL(url), 60_000); } catch (error) { notify(`Dokument konnte nicht geöffnet werden: ${error.message}`, 'error'); }
}

$('entryForm').addEventListener('submit', saveEntry); $('newEntry').addEventListener('click', () => { resetForm(); $('title').focus(); }); $('deleteEntry').addEventListener('click', removeEntry);
$('startImport').addEventListener('click', startImport);
$('importJobs').addEventListener('click', event => { const button = event.target.closest('[data-resume-import]'); if (button) void resumeImport(button.dataset.resumeImport); });
$('entryList').addEventListener('click', event => { const card = event.target.closest('[data-entry-id]'); if (card) void selectEntry(card.dataset.entryId); });
$('searchButton').addEventListener('click', () => loadAll($('searchInput').value.trim()).catch(error => notify(error.message, 'error'))); $('searchInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('searchButton').click(); } });
loadAll().catch(error => notify(error.message.includes('401') ? 'Bitte zuerst im Cockpit den IVA-API-Token speichern.' : error.message, 'error'));
setInterval(() => { if (state.imports.some(item => item.active)) loadImports().catch(error => notify(`Fortschritt konnte kurz nicht aktualisiert werden: ${error.message}`, 'error')); }, 4_000);
