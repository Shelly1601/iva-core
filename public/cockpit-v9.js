(() => {
  'use strict';

  const byId = id => document.getElementById(id);
  const drawer = byId('widgetDrawer');
  const drawerTitle = byId('widgetTitle');
  const widgetNames = {
    calendar: 'Deine nächsten Termine',
    todos: 'Deine To-dos',
    leads: 'Leads nach Projekt',
    mail: 'Neue Post',
    calendly: 'Calendly-Buchungen',
  };

  function closeWidget() {
    document.body.classList.remove('widget-open');
    drawer?.setAttribute('aria-hidden', 'true');
    document.querySelectorAll('[data-widget]').forEach(button => button.setAttribute('aria-expanded', 'false'));
  }

  function openWidget(name, trigger) {
    const panel = document.querySelector(`[data-widget-panel="${name}"]`);
    if (!panel || !drawer) return;
    document.body.classList.remove('chat-open', 'dash-open');
    document.querySelectorAll('.widget-panel').forEach(item => item.classList.toggle('active', item === panel));
    document.querySelectorAll('[data-widget]').forEach(button => button.setAttribute('aria-expanded', String(button === trigger)));
    drawerTitle.textContent = widgetNames[name] || 'Übersicht';
    drawer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('widget-open');
    if (name === 'todos') setTimeout(() => byId('todoAddToggle')?.focus({ preventScroll: true }), 260);
  }

  document.querySelectorAll('[data-widget]').forEach(button => {
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => openWidget(button.dataset.widget, button));
  });
  byId('widgetClose')?.addEventListener('click', closeWidget);
  byId('sheetBackdrop')?.addEventListener('click', closeWidget);

  const stateCopy = {
    idle: ['IVA ist bereit', 'Antippen und sprechen'],
    listening: ['IVA hört dir zu', 'Sprich einfach los'],
    thinking: ['IVA denkt nach', 'Ich sortiere gerade alles'],
    speaking: ['IVA spricht', 'Du kannst mich jederzeit stoppen'],
  };

  function syncPresence() {
    const current = document.body.dataset.state || 'idle';
    const copy = stateCopy[current] || stateCopy.idle;
    const wakeOn = byId('wakeBtn')?.classList.contains('on');
    byId('presenceState').textContent = wakeOn && current === 'listening' ? 'IVA wartet auf dich' : copy[0];
    byId('presenceHint').textContent = wakeOn && current === 'listening' ? 'Sag „Eva wake up“' : copy[1];
    byId('presenceVoiceBtn')?.setAttribute('aria-pressed', String(current === 'listening'));
  }

  const observer = new MutationObserver(syncPresence);
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-state'] });
  ['wakeBtn', 'micBtn'].forEach(id => {
    const button = byId(id);
    if (button) new MutationObserver(syncPresence).observe(button, { attributes: true, attributeFilter: ['class', 'disabled'] });
  });

  byId('presenceVoiceBtn')?.addEventListener('click', () => {
    const wakeButton = byId('wakeBtn');
    const micButton = byId('micBtn');
    if (micButton?.disabled) {
      byId('gear')?.click();
      return;
    }
    if (wakeButton?.classList.contains('on')) wakeButton.click();
    else micButton?.click();
    syncPresence();
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeWidget();
  });

  syncPresence();
})();
