const $ = id => document.getElementById(id);
const token = () => localStorage.getItem('iva_token') || '';
const state = { status: null, types: [], current: null };
const days = [{ id: 'mon', label: 'Mo' }, { id: 'tue', label: 'Di' }, { id: 'wed', label: 'Mi' }, { id: 'thu', label: 'Do' }, { id: 'fri', label: 'Fr' }];

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(json?.error || `HTTP ${response.status}`);
  return json;
}
function clean(value) { return String(value || '').trim(); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]); }
function notice(message, type = '') { $('notice').hidden = false; $('notice').className = `notice ${type}`; $('notice').textContent = message; }
function renderWeek(availability = {}) {
  $('week').innerHTML = days.map(day => { const window = availability[day.id]?.[0] || {}; return `<div class="day"><b>${day.label}</b><input type="time" data-day="${day.id}" data-kind="start" value="${window.start || ''}"><input type="time" data-day="${day.id}" data-kind="end" value="${window.end || ''}"></div>`; }).join('');
}
function renderStatus() {
  const status = state.status;
  $('readiness').className = `status${status.liveReady ? ' ready' : ''}`;
  $('readiness').innerHTML = status.liveReady
    ? `<b>Bereit für echte Terminlinks</b><small>${escapeHtml(status.calendarProvider)} · ${escapeHtml(status.mailProvider)}</small>`
    : '<b>Vorschaumodus – noch keine echten Buchungen</b><small>Terminarten und Links können vorbereitet werden. Live-Schaltung bleibt gesperrt, bis Kalender-Schreibzugriff und Bestätigungs-E-Mail real getestet sind.</small>';
  $('active').disabled = !status.liveReady;
}
function renderTypes() {
  $('typeList').innerHTML = state.types.length ? state.types.map(type => `<button class="type${state.current?.id === type.id ? ' active' : ''}" data-id="${type.id}"><b>${escapeHtml(type.name)}</b><small>${type.durationMinutes} Min. · ${type.active ? 'live' : 'Entwurf'}</small></button>`).join('') : '<div class="muted">Noch keine Terminart.</div>';
  document.querySelectorAll('.type').forEach(button => button.addEventListener('click', () => selectType(button.dataset.id)));
}
function selectType(id) {
  state.current = state.types.find(type => type.id === id) || null;
  const type = state.current || {};
  $('formTitle').textContent = type.id ? type.name : 'Neue Terminart'; $('name').value = type.name || ''; $('slug').value = type.slug || ''; $('duration').value = String(type.durationMinutes || 30); $('locationKind').value = type.locationKind || 'video'; $('locationDetails').value = type.locationDetails || ''; $('minNotice').value = String(type.minNoticeHours || 24); $('maxDays').value = String(type.maxDaysAhead || 60); $('description').value = type.description || ''; $('active').checked = type.active === true;
  renderWeek(type.availability || { mon: [{ start: '09:00', end: '17:00' }], tue: [{ start: '09:00', end: '17:00' }], wed: [{ start: '09:00', end: '17:00' }], thu: [{ start: '09:00', end: '17:00' }], fri: [{ start: '09:00', end: '15:00' }] });
  const share = $('shareLink'); share.hidden = !type.id; if (type.id) { const url = `${location.origin}/book/${type.slug}`; share.innerHTML = `<b>${type.active ? 'Teilbarer Terminlink' : 'Vorschau-Link – noch nicht öffentlich aktiv'}</b><code>${escapeHtml(url)}</code><button class="btn" type="button" id="copyLink">Link kopieren</button>`; $('copyLink').addEventListener('click', async () => { await navigator.clipboard.writeText(url); notice('Terminlink wurde kopiert.', 'success'); }); }
  renderTypes();
}
function availabilityValue() {
  const out = { sun: [], sat: [] };
  for (const day of days) { const start = document.querySelector(`[data-day="${day.id}"][data-kind="start"]`).value; const end = document.querySelector(`[data-day="${day.id}"][data-kind="end"]`).value; out[day.id] = start && end ? [{ start, end }] : []; }
  return out;
}
async function saveType(event) {
  event.preventDefault();
  try {
    const body = { name: clean($('name').value), slug: clean($('slug').value), durationMinutes: Number($('duration').value), locationKind: $('locationKind').value, locationDetails: clean($('locationDetails').value), minNoticeHours: Number($('minNotice').value), maxDaysAhead: Number($('maxDays').value), description: clean($('description').value), availability: availabilityValue(), active: $('active').checked };
    const saved = state.current?.id ? await api(`/api/scheduling/types/${state.current.id}`, { method: 'PATCH', body: JSON.stringify(body) }) : await api('/api/scheduling/types', { method: 'POST', body: JSON.stringify(body) });
    await load(); selectType(saved.id); notice('Terminart wurde gespeichert.', 'success');
  } catch (error) { notice(error.message, 'error'); }
}
async function load() {
  try { [state.status, state.types] = await Promise.all([api('/api/scheduling/status'), api('/api/scheduling/types')]); renderStatus(); renderTypes(); if (!state.current && state.types[0]) selectType(state.types[0].id); else if (!state.types.length) selectType(''); }
  catch (error) { notice(error.message.includes('401') ? 'Bitte zuerst im Cockpit den IVA-API-Token eintragen.' : error.message, 'error'); }
}
$('newType').addEventListener('click', () => { state.current = null; selectType(''); }); $('typeForm').addEventListener('submit', saveType); load();
