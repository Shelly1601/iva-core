(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const api = '/heat-hero-termin-api';
  const form = $('requestForm');
  let formToken = '', timer = null, cycle = 0, submitting = false, availableUntil = 0;
  let displayed = null, weekKey = '', refreshSucceeded = false;

  function showError(message = '') { $('error').textContent = message; $('error').hidden = !message; }
  function setRefreshState(state) {
    const button = $('refreshWeeks');
    button.dataset.state = state;
    button.disabled = state === 'loading';
    button.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
    button.textContent = state === 'loading' ? 'Verfügbarkeit wird geprüft …'
      : state === 'success' ? 'Aktuell geprüft ✓' : 'Verfügbarkeit erneut prüfen';
  }
  async function request(path, method = 'GET', body) {
    const response = await fetch(`${api}${path}`, { method, cache: 'no-store', credentials: 'omit',
      headers: { 'X-Form-Token': formToken, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25_000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Die Anfrage konnte nicht verarbeitet werden.');
    return data;
  }
  const date = value => new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
  const fullDate = value => new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
  const checkedAt = value => new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(new Date(value));
  const selectedWeek = () => document.querySelector('input[name="week"]:checked')?.value || '';
  const freeText = count => count === 1 ? 'Noch 1 Termin frei' : `Noch ${count} Termine frei`;

  function buildWeekCard(item, selected) {
    const value = `${item.isoYear}-${item.week}`;
    const label = document.createElement('label');
    label.className = 'week-card';
    const input = document.createElement('input');
    input.type = 'radio'; input.name = 'week'; input.value = value; input.required = true; input.checked = value === selected;
    const copy = document.createElement('span'); copy.className = 'week-card-copy';
    const title = document.createElement('strong'); title.textContent = `KW ${item.week}`;
    const range = document.createElement('span'); range.className = 'week-range'; range.textContent = `${date(item.startDate)}–${fullDate(item.endDate)}`;
    const count = document.createElement('span'); count.className = 'week-count'; count.textContent = freeText(item.availableBlocks);
    copy.append(title, range, count); label.append(input, copy);
    return label;
  }
  function displayWeeks(data, { canSubmit = false } = {}) {
    const weeks = Array.isArray(data.weeks) ? data.weeks : [];
    const key = JSON.stringify(weeks);
    if (key !== weekKey) {
      const selected = selectedWeek();
      const stillAvailable = selected && weeks.some(item => `${item.isoYear}-${item.week}` === selected);
      const cards = $('weekCards'); cards.replaceChildren();
      for (const item of weeks) cards.append(buildWeekCard(item, stillAvailable ? selected : ''));
      if (selected && !stillAvailable) showError('Die gewählte Woche ist nach der aktuellen Prüfung nicht mehr frei. Bitte wählen Sie eine andere Woche.');
      weekKey = key;
    }
    $('weekCards').classList.toggle('is-empty', !weeks.length);
    refreshSucceeded = canSubmit && data.status === 'ready' && !data.refreshing;
    $('submit').disabled = submitting || !weeks.length || !refreshSucceeded;
    availableUntil = Date.parse(data.expiresAt || '') || 0;
    displayed = data;
  }
  function showProgress(data) {
    if (data.phase === 'queued') {
      $('availabilityStatus').textContent = displayed?.weeks?.length
        ? 'Der bisherige Stand bleibt vorläufig sichtbar. Die neue Planbar-Prüfung wartet auf den attestierten iMac und startet automatisch.'
        : 'Die Planbar-Prüfung wartet auf den attestierten iMac und startet automatisch. Bitte lassen Sie die Seite geöffnet.';
    } else {
      $('availabilityStatus').textContent = displayed?.weeks?.length
        ? 'Der bisherige Stand bleibt vorläufig sichtbar. Planbar wird gerade neu geladen und vollständig geprüft …'
        : 'Planbar wird gerade neu geladen und auf freie Montagewochen geprüft …';
    }
  }
  function showSuccess(data) {
    $('availabilityStatus').textContent = data.weeks.length
      ? `Aktuell in Planbar geprüft: ${checkedAt(data.updatedAt)} Uhr. Wählen Sie eine der freien Montagewochen.`
      : `Aktuell in Planbar geprüft: ${checkedAt(data.updatedAt)} Uhr. Im geprüften Zeitraum sind derzeit keine freien Montagewochen verfügbar.`;
  }
  function backgroundError(error) {
    setRefreshState('error'); refreshSucceeded = false; $('submit').disabled = true; showError(error.message);
    if (displayed?.weeks?.length) {
      displayWeeks({ ...displayed, status: 'preview', refreshing: false }, { canSubmit: false });
      $('availabilityStatus').textContent = `Aktualisierung fehlgeschlagen. Angezeigt wird nur der vorläufige Stand vom ${checkedAt(displayed.updatedAt)} Uhr; eine Anfrage ist erst nach erfolgreicher neuer Prüfung möglich.`;
    } else {
      $('availabilityStatus').textContent = 'Die Verfügbarkeit konnte noch nicht aktuell bestätigt werden. Bitte starten Sie die Prüfung erneut.';
    }
  }
  const wait = delay => new Promise(resolve => { timer = setTimeout(resolve, delay); });

  async function refresh({ force = true } = {}) {
    const ownCycle = ++cycle;
    clearTimeout(timer); showError(); setRefreshState('loading'); refreshSucceeded = false; $('submit').disabled = true;
    try {
      if (!formToken) {
        const session = await request('/session');
        if (ownCycle !== cycle) return false;
        formToken = session.formToken;
        if (['ready', 'preview'].includes(session.availability?.status)) {
          displayWeeks({ ...session.availability, status: 'preview', refreshing: true }, { canSubmit: false });
          $('availabilityStatus').textContent = `Vorläufiger Planbar-Stand vom ${checkedAt(session.availability.updatedAt)} Uhr. Die aktuelle Prüfung startet automatisch …`;
        }
      }
      let result = await request('/availability', 'POST', { force });
      const started = Date.now();
      while (ownCycle === cycle) {
        if (['ready', 'preview'].includes(result.status) && Array.isArray(result.weeks)) {
          const completed = result.status === 'ready' && !result.refreshing;
          displayWeeks(result, { canSubmit: completed });
          if (completed) { showSuccess(result); setRefreshState('success'); return true; }
        }
        if (['error', 'unavailable'].includes(result.status)) throw new Error(result.message || 'Die aktuelle Planbar-Prüfung konnte nicht abgeschlossen werden. Bitte erneut versuchen.');
        showProgress(result);
        if (Date.now() - started > 15 * 60_000) throw new Error('Die Prüfung dauert gerade länger. Bitte versuchen Sie es in Kürze erneut. Es wurde noch keine Anfrage abgeschickt.');
        await wait(3000);
        if (ownCycle !== cycle) return false;
        result = await request('/availability');
      }
      return false;
    } catch (error) { if (ownCycle === cycle) backgroundError(error); return false; }
  }

  $('refreshWeeks').addEventListener('click', () => { void refresh({ force: true }); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting || !form.reportValidity()) return;
    if (!refreshSucceeded || !availableUntil || Date.now() >= availableUntil - 10_000) {
      await refresh({ force: true });
      showError('Bitte wählen Sie nach der neuen Prüfung Ihre Montagewoche aus.'); return;
    }
    submitting = true; clearTimeout(timer); ++cycle; $('submit').disabled = true; showError();
    $('submit').textContent = 'Anfrage wird übermittelt …';
    try {
      const values = new FormData(form);
      const [isoYear, week] = values.get('week').split('-').map(Number);
      const result = await request('/requests', 'POST', { firstName: values.get('firstName'), lastName: values.get('lastName'),
        objectLocation: values.get('objectLocation'), isoYear, week,
        materialDeliverySpace: values.get('materialDeliverySpace') === 'yes',
        theftWeatherProtected: values.get('theftWeatherProtected') === 'yes',
        additionalInfo: values.get('additionalInfo').replace(/[\r\n\t]+/g, ' '), website: values.get('website') });
      if (!result.accepted) throw new Error('Die Anfrage wurde nicht bestätigt. Bitte erneut versuchen.');
      form.reset(); formToken = ''; location.replace('/heat-hero/termin/anfrage-erhalten');
    } catch (error) { showError(error.message); submitting = false; $('submit').disabled = false; $('submit').textContent = 'Terminanfrage absenden →'; }
  });
  // Never restore customer data through application storage or the back/forward cache.
  window.addEventListener('pagehide', () => { clearTimeout(timer); ++cycle; form.reset(); });
  window.addEventListener('pageshow', () => {
    form.reset(); formToken = ''; submitting = false; availableUntil = 0; displayed = null; weekKey = ''; refreshSucceeded = false;
    $('weekCards').replaceChildren(); void refresh({ force: true });
  });
})();
