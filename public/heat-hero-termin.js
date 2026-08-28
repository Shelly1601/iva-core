(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const api = '/heat-hero-termin-api';
  const form = $('requestForm');
  let formToken = '', timer = null, cycle = 0, submitting = false, loadedAt = 0;
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
  function displayWeeks(data) {
    $('week').replaceChildren(new Option('Bitte Kalenderwoche wählen', ''));
    for (const item of data.weeks) {
      const friday = new Date(`${item.endDateExclusive}T00:00:00Z`); friday.setUTCDate(friday.getUTCDate() - 1);
      $('week').add(new Option(`KW ${item.week}/${item.isoYear} · ${date(item.startDate)}–${date(friday)}`, `${item.isoYear}-${item.week}`));
    }
    $('week').disabled = !data.weeks.length;
    $('submit').disabled = !data.weeks.length;
    loadedAt = Date.now();
    $('availabilityStatus').textContent = data.weeks.length
      ? `Zuletzt geprüft: ${new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(new Date(data.updatedAt))} Uhr. Vor der Einplanung wird erneut geprüft.`
      : 'Im aktuell geprüften Zeitraum sind keine freien Montagewochen verfügbar. Bitte versuchen Sie es später erneut.';
  }
  async function refresh() {
    const ownCycle = ++cycle;
    clearTimeout(timer); showError();
    $('week').disabled = true; $('submit').disabled = true; $('refreshWeeks').disabled = true;
    $('availabilityStatus').textContent = 'Die Plantafel wird aktualisiert und freie Wochen werden geprüft …';
    try {
      if (!formToken) formToken = (await request('/session')).formToken;
      let result = await request('/availability', 'POST');
      const started = Date.now();
      async function poll() {
        if (ownCycle !== cycle) return;
        try {
          if (result.status === 'ready') { displayWeeks(result); $('refreshWeeks').disabled = false; return; }
          if (Date.now() - started > 120_000) throw new Error('Die Prüfung dauert gerade länger. Bitte versuchen Sie es in Kürze erneut. Es wurde noch keine Anfrage abgeschickt.');
          result = await request('/availability');
          timer = setTimeout(poll, 3000);
        } catch (error) { showError(error.message); $('refreshWeeks').disabled = false; $('availabilityStatus').textContent = 'Verfügbarkeit noch nicht bestätigt.'; }
      }
      await poll();
    } catch (error) { showError(error.message); $('refreshWeeks').disabled = false; $('availabilityStatus').textContent = 'Verfügbarkeit noch nicht bestätigt.'; }
  }
  $('refreshWeeks').addEventListener('click', refresh);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting || !form.reportValidity()) return;
    if (!loadedAt || Date.now() - loadedAt > 4 * 60_000) {
      await refresh(); showError('Bitte die neu geprüfte Kalenderwoche noch einmal auswählen.'); return;
    }
    submitting = true; $('submit').disabled = true; showError();
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
  window.addEventListener('pageshow', () => { form.reset(); formToken = ''; submitting = false; loadedAt = 0; refresh(); });
})();
