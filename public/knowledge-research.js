const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const split = value => [...new Set(String(value || '').split(/[,\n]/).map(v => v.trim()).filter(Boolean))];
const state = { plans: [], current: null, loading: false, loaded: false, fingerprint: '', posting: false, requestId: crypto.randomUUID(), requestPayload: '' };
const labels = { queued: 'Wartet', running: 'Recherchiert', succeeded: 'Wissen gespeichert', unchanged: 'Keine Änderung', failed: 'Aktion nötig', interrupted: 'Unterbrochen', canceled: 'Gestoppt' };
const frequencyLabels = { once: 'Einmalig', daily: 'Täglich', weekly: 'Wöchentlich', monthly: 'Monatlich' };
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '–';
async function api(path = '', options = {}) {
  const response = await fetch(`/api/knowledge/research${path}`, { ...options, headers: { Authorization: `Bearer ${localStorage.getItem('iva_token') || ''}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || (response.status === 401 ? 'Bitte zuerst im Cockpit anmelden.' : `Abruf fehlgeschlagen (${response.status}).`));
  return body;
}
function message(text, error = false) { $('researchFormState').textContent = text; $('researchFormState').dataset.error = String(error); }
function syncSchedule() {
  const frequency = $('researchFrequency').value;
  for (const [field, input, visible] of [['researchTimeField', 'researchTime', frequency !== 'once'], ['researchWeekdayField', 'researchWeekday', frequency === 'weekly'], ['researchMonthdayField', 'researchMonthday', frequency === 'monthly']]) {
    $(field).hidden = !visible; $(input).disabled = !visible;
  }
  $('researchScheduleHint').textContent = frequency === 'once' ? (state.current ? 'Der bestehende Auftrag wird gespeichert. Für eine erneute Recherche „Jetzt starten“ verwenden.' : 'Startet nach dem Speichern. Du kannst den Bereich danach schließen.') : 'Erster Lauf zur nächsten gewählten Uhrzeit in Berlin. Weitere Läufe automatisch, auch bei geschlossenem Browser. Mit „Jetzt starten“ geht es vorher los.';
  $('researchSave').textContent = state.current ? 'Änderungen speichern' : frequency === 'once' ? 'Recherche starten' : 'Recherche einplanen';
}
function reset() {
  state.current = null; state.requestId = crypto.randomUUID(); state.requestPayload = ''; $('researchForm').reset(); $('researchFormTitle').textContent = 'Was soll IVA herausfinden?'; $('researchCancel').hidden = true; $('researchFilters').open = false; syncSchedule();
}
function edit(plan) {
  state.current = plan.id;
  for (const [id, key] of [['researchTopic', 'topic'], ['researchCategory', 'category'], ['researchKeywords', 'keywords'], ['researchExclude', 'excludeTerms'], ['researchDomains', 'domains'], ['researchRegion', 'region'], ['researchObjective', 'objective'], ['researchMaxSources', 'maxSources']]) $(id).value = Array.isArray(plan[key]) ? plan[key].join(', ') : plan[key] ?? '';
  $('researchFrequency').value = plan.schedule.frequency; $('researchTime').value = plan.schedule.time || '09:00'; $('researchWeekday').value = String(plan.schedule.weekday ?? 1); $('researchMonthday').value = String(plan.schedule.dayOfMonth ?? 1);
  $('researchFormTitle').textContent = 'Recherche bearbeiten'; $('researchCancel').hidden = false; $('researchFilters').open = true; $('researchPanel').open = true; syncSchedule(); message(plan.enabled ? '' : 'Dieser Auftrag ist pausiert. Speichern setzt ihn nicht automatisch fort.'); $('researchTopic').focus();
}
function render() {
  const detailsOpen = new Set([...document.querySelectorAll('#researchList details[open]')].map(el => el.dataset.report));
  $('researchCount').textContent = state.plans.length ? `${state.plans.length} ${state.plans.length === 1 ? 'Auftrag' : 'Aufträge'}` : 'Filter öffnen';
  $('researchList').innerHTML = state.plans.length ? state.plans.map(plan => {
    const run = plan.latestRun;
    const active = ['queued', 'running'].includes(run?.status);
    const status = !plan.enabled ? 'Pausiert' : labels[run?.status] || 'Eingeplant';
    const tone = !plan.enabled ? 'warn' : ['failed', 'interrupted'].includes(run?.status) ? 'error' : ['succeeded', 'unchanged'].includes(run?.status) ? 'good' : 'warn';
    const details = [run?.error, ...(run?.limitations || [])].filter(Boolean);
    return `<article class="import-job research-plan" data-plan="${escape(plan.id)}"><div class="import-job-head"><b>${escape(plan.topic)}</b><span class="tag" data-tone="${tone}">${escape(status)}</span></div><div class="research-meta">${escape(plan.category)} · ${escape(frequencyLabels[plan.schedule.frequency] || plan.schedule.frequency)}<br>${plan.enabled && plan.nextRunAt ? `Nächster Lauf: ${escape(date(plan.nextRunAt))} · Berlin` : !plan.enabled ? 'Automatische Läufe pausiert' : active ? 'Der Auftrag läuft im Hintergrund.' : 'Kein weiterer Lauf geplant.'}</div>${run?.completedAt ? `<small>Letzter Lauf: ${escape(date(run.completedAt))}${run.sourceCount ? ` · ${escape(run.sourceCount)} Quellen` : ''}</small>` : ''}<div class="import-job-actions"><button class="mini-btn" data-action="run" ${active || !plan.enabled ? 'disabled' : ''}>${active ? 'Lauf aktiv' : 'Jetzt starten'}</button><button class="mini-btn" data-action="edit">Bearbeiten</button><button class="mini-btn" data-action="toggle">${plan.enabled ? 'Pausieren' : 'Fortsetzen'}</button>${plan.knowledgeEntryId ? '<button class="mini-btn" data-action="result">Wissen ansehen</button>' : ''}</div>${run ? `<details data-report="${escape(plan.id)}" ${detailsOpen.has(plan.id) ? 'open' : ''}><summary>Bericht & Details</summary><div class="preview">${escape([`Status: ${labels[run.status] || run.status}`, run.sourceCount ? `Gelesene Quellen: ${run.sourceCount}` : '', ...details].filter(Boolean).join('\n\n'))}</div></details>` : ''}</article>`;
  }).join('') : '<div class="empty">Noch kein Auftrag angelegt. Thema und Kategorie reichen für die erste Recherche.</div>';
}
async function load() {
  if (state.loading) return;
  state.loading = true;
  try {
    const result = await api();
    state.plans = result.plans || []; state.loaded = true; render();
    const capability = result.capabilities || {};
    $('researchCapability').hidden = capability.ready !== false;
    $('researchCapability').textContent = capability.message || (capability.missing || []).join(' · ') || 'Die Recherche ist noch nicht vollständig verbunden. Der Auftrag kann gespeichert werden; fehlende Anbindungen werden hier angezeigt.';
    const fingerprint = JSON.stringify(state.plans.map(p => [p.id, p.knowledgeEntryId, p.latestRun?.id, p.latestRun?.status]));
    if (state.fingerprint && state.fingerprint !== fingerprint && state.plans.some(p => p.knowledgeEntryId)) window.dispatchEvent(new Event('knowledge-research-updated'));
    state.fingerprint = fingerprint;
  } finally { state.loading = false; }
}
function accept(plan) { state.plans = [plan, ...state.plans.filter(p => p.id !== plan.id)]; render(); }
$('researchForm').addEventListener('submit', async event => {
  event.preventDefault(); if (state.posting) return;
  state.posting = true; $('researchSave').disabled = true; message('Auftrag wird gespeichert …');
  const editing = state.current;
  try {
    const payload = { topic: $('researchTopic').value.trim(), category: $('researchCategory').value.trim(), keywords: split($('researchKeywords').value), excludeTerms: split($('researchExclude').value), domains: split($('researchDomains').value), region: $('researchRegion').value.trim(), objective: $('researchObjective').value.trim(), maxSources: Number($('researchMaxSources').value), schedule: { frequency: $('researchFrequency').value, time: $('researchTime').value, weekday: Number($('researchWeekday').value), dayOfMonth: Number($('researchMonthday').value), timeZone: 'Europe/Berlin' } };
    if (!editing) {
      const fingerprint = JSON.stringify(payload);
      if (state.requestPayload && state.requestPayload !== fingerprint) state.requestId = crypto.randomUUID();
      state.requestPayload = fingerprint; payload.requestId = state.requestId;
    }
    const result = await api(editing ? `/${encodeURIComponent(editing)}` : '', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    accept(result.plan); reset(); message(editing ? 'Änderungen gespeichert.' : payload.schedule.frequency === 'once' ? 'Recherche gespeichert und eingereiht. Den Fortschritt siehst du bei deinen Aufträgen.' : 'Recherche eingeplant. IVA übernimmt die nächsten Läufe automatisch.');
    try { await load(); } catch { message('Der Auftrag ist gespeichert. Die Anzeige wird beim nächsten Abruf aktualisiert.'); }
  } catch (error) { message(error.message, true); }
  finally { state.posting = false; $('researchSave').disabled = false; syncSchedule(); }
});
$('researchList').addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]'); if (!button || button.disabled) return;
  const plan = state.plans.find(p => p.id === button.closest('[data-plan]').dataset.plan); if (!plan) return;
  if (button.dataset.action === 'edit') return edit(plan);
  if (button.dataset.action === 'result') return window.dispatchEvent(new CustomEvent('knowledge-research-open-entry', { detail: { id: plan.knowledgeEntryId } }));
  button.disabled = true;
  try {
    const result = await api(`/${encodeURIComponent(plan.id)}${button.dataset.action === 'run' ? '/run' : ''}`, { method: button.dataset.action === 'run' ? 'POST' : 'PATCH', body: JSON.stringify(button.dataset.action === 'run' ? {} : { enabled: !plan.enabled }) });
    accept(result.plan); message(button.dataset.action === 'run' ? 'Recherche eingereiht.' : result.plan.enabled ? 'Recherche fortgesetzt.' : 'Recherche pausiert.');
    try { await load(); } catch { message('Änderung gespeichert. Die Anzeige wird beim nächsten Abruf aktualisiert.'); }
  } catch (error) { message(error.message, true); button.disabled = false; }
});
$('researchFrequency').addEventListener('change', syncSchedule);
$('researchCancel').addEventListener('click', () => { reset(); message(''); });
$('researchRefresh').addEventListener('click', () => { void load().catch(error => message(error.message, true)); });
$('researchPanel').addEventListener('toggle', () => { if ($('researchPanel').open) void load().catch(error => message(error.message, true)); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && $('researchPanel').open) void load().catch(error => message(error.message, true)); });
syncSchedule();
void load().catch(error => message(error.message, true));
setInterval(() => { if (!document.hidden && $('researchPanel').open) void load().catch(error => message(error.message, true)); }, 10000);
