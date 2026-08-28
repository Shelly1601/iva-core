(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const api = '/heat-hero-termin-api';
  const form = $('requestForm');
  let formToken = '', timer = null, cycle = 0, submitting = false, loadedAt = 0, availableUntil = 0;
  let displayed = null, weekKey = '';
  function showError(message = '') { $('error').textContent = message; $('error').hidden = !message; }
  async function request(path, method = 'GET', body) {
    const response = await fetch(`${api}${path}`, { method, cache: 'no-store', credentials: 'omit',
      headers: { 'X-Form-Token': formToken, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25_000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Die Anfrage konnte nicht verarbeitet werden.');
    return data;
  }
  const date = value => new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(new Date(value));
  const checkedAt = value => new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(new Date(value));
  function displayWeeks(data) {
    const key = JSON.stringify(data.weeks);
    if (key !== weekKey) {
      const selected = $('week').value;
      $('week').replaceChildren(new Option('Bitte Kalenderwoche wählen', ''));
      for (const item of data.weeks) {
        const friday = new Date(`${item.endDateExclusive}T00:00:00Z`); friday.setUTCDate(friday.getUTCDate() - 1);
        $('week').add(new Option(`KW ${item.week}/${item.isoYear} · ${date(item.startDate)}–${date(friday)}`, `${item.isoYear}-${item.week}`));
      }
      if (selected && data.weeks.some(item => `${item.isoYear}-${item.week}` === selected)) $('week').value = selected;
      else if (selected) showError('Die gewählte Woche ist inzwischen nicht mehr frei. Bitte wählen Sie eine andere Woche.');
      weekKey = key;
    }
    $('week').disabled = !data.weeks.length;
    $('submit').disabled = submitting || !data.weeks.length;
    loadedAt = Date.now();
    availableUntil = Date.parse(data.requestExpiresAt || data.expiresAt) || loadedAt + 4 * 60_000;
    displayed = data;
    $('availabilityStatus').textContent = data.status === 'preview'
      ? `Vorläufige Auswahl · Planbar-Stand vom ${checkedAt(data.updatedAt)} Uhr. ${data.refreshing ? 'Die aktuelle Prüfung läuft im Hintergrund. ' : ''}Sie können Ihre Wunschwoche anfragen; die Verfügbarkeit wird vor der Einplanung erneut geprüft.`
      : data.weeks.length
        ? `Zuletzt geprüft: ${checkedAt(data.updatedAt)} Uhr. ${data.refreshing ? 'Wird im Hintergrund aktualisiert. ' : ''}Vor der Einplanung wird erneut geprüft.`
        : 'Im aktuell geprüften Zeitraum sind keine freien Montagewochen verfügbar. Bitte versuchen Sie es später erneut.';
  }
  function backgroundError(error) {
    $('refreshWeeks').disabled = false;
    if (displayed && Date.now() < availableUntil) {
      displayWeeks({ ...displayed, status: 'preview', refreshing: false });
      $('availabilityStatus').textContent += ' Die Hintergrundaktualisierung ist noch nicht abgeschlossen.';
    } else {
      showError(error.message); $('availabilityStatus').textContent = 'Verfügbarkeit noch nicht bestätigt.';
      $('week').disabled = true; $('submit').disabled = true;
    }
  }
  async function refresh({ force = false } = {}) {
    const ownCycle = ++cycle;
    clearTimeout(timer); showError();
    $('refreshWeeks').disabled = true;
    if (!displayed || Date.now() >= availableUntil) {
      $('week').disabled = true; $('submit').disabled = true;
      $('availabilityStatus').textContent = 'Die Plantafel wird aktualisiert und freie Wochen werden geprüft …';
    }
    try {
      if (!formToken) {
        const session = await request('/session');
        if (ownCycle !== cycle) return;
        formToken = session.formToken;
        if (['ready', 'preview'].includes(session.availability?.status)) {
          displayWeeks({ ...session.availability, refreshing: session.availability.status === 'preview' });
          if (session.availability.status === 'ready' && !force) { $('refreshWeeks').disabled = false; return; }
        }
      }
      // Rendering above happens before the slow operational refresh request.
      let result = await request('/availability', 'POST', { force });
      const started = Date.now();
      async function poll() {
        if (ownCycle !== cycle) return;
        try {
          if (['ready', 'preview'].includes(result.status)) {
            displayWeeks(result);
            if (!result.refreshing) { $('refreshWeeks').disabled = false; return; }
          }
          if (result.status === 'unavailable') throw new Error(result.message || 'Die aktuellen Montagewochen konnten noch nicht geprüft werden. Bitte starten Sie die Prüfung erneut.');
          if (!displayed) $('availabilityStatus').textContent = result.phase === 'queued'
            ? 'Die aktuelle Planung wird noch abgeschlossen. Ihre Prüfung wartet sicher und startet automatisch. Bitte lassen Sie die Seite geöffnet.'
            : 'Die Plantafel wird aktualisiert und freie Wochen werden geprüft …';
          if (Date.now() - started > 15 * 60_000) throw new Error('Die Prüfung dauert gerade länger. Bitte versuchen Sie es in Kürze erneut. Es wurde noch keine Anfrage abgeschickt.');
          result = await request('/availability');
          if (ownCycle !== cycle) return;
          timer = setTimeout(poll, 3000);
        } catch (error) { if (ownCycle === cycle) backgroundError(error); }
      }
      await poll();
    } catch (error) { if (ownCycle === cycle) backgroundError(error); }
  }
  $('refreshWeeks').addEventListener('click', () => refresh({ force: true }));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting || !form.reportValidity()) return;
    if (!loadedAt || Date.now() >= availableUntil - 10_000) {
      await refresh(); showError('Bitte die neu geprüfte Kalenderwoche noch einmal auswählen.'); return;
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
  window.addEventListener('pageshow', () => { form.reset(); formToken = ''; submitting = false; loadedAt = 0; availableUntil = 0; displayed = null; weekKey = ''; refresh(); });
})();
