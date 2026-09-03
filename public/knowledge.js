const $ = id => document.getElementById(id);
const token = () => localStorage.getItem('iva_token') || '';
const state = { entries: [], current: null, status: null };
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
  const [status, result] = await Promise.all([api('/api/knowledge/status'), api(`/api/knowledge${suffix}`)]);
  state.status = status; state.entries = result.entries || []; renderMetrics(); renderEntries();
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
$('entryList').addEventListener('click', event => { const card = event.target.closest('[data-entry-id]'); if (card) void selectEntry(card.dataset.entryId); });
$('searchButton').addEventListener('click', () => loadAll($('searchInput').value.trim()).catch(error => notify(error.message, 'error'))); $('searchInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('searchButton').click(); } });
loadAll().catch(error => notify(error.message.includes('401') ? 'Bitte zuerst im Cockpit den IVA-API-Token speichern.' : error.message, 'error'));
