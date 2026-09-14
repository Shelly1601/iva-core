/* Project configuration and customer invitations. Admin requests use the existing authenticated project API. */
(() => {
  'use strict';
  const widgets = new Map();
  const roles = ['viewer', 'editor', 'publisher'];
  const roleLabels = { viewer: 'Ansehen', editor: 'Gestalten', publisher: 'Gestalten & veröffentlichen' };
  let catalog = null;
  let catalogRequest = null;
  let creation = null;
  let visibleProjectId = '';
  const el = (tag, className = '', text) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = String(text); return node; };
  const btn = (text, style = '') => { const node = el('button', `ipa-button ${style}`, text); node.type = 'button'; return node; };
  const array = value => Array.isArray(value) ? value : [];
  const endpoint = id => `/api/projects/${encodeURIComponent(id)}/access`;
  const date = value => { const parsed = new Date(value); return Number.isNaN(parsed.valueOf()) ? '' : parsed.toLocaleString('de-DE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); };
  function roleSelect(value) { const select = el('select'); for (const role of roles) { const option = el('option', '', roleLabels[role]); option.value = role; select.append(option); } select.value = roles.includes(value) ? value : 'editor'; return select; }
  function field(label, input) { const wrapper = el('label', 'ipa-field'); input.setAttribute('aria-label', label); wrapper.append(el('span', '', label), input); return wrapper; }
  function moduleList(items, selected, changed) {
    const wrapper = el('div', 'ipa-modules'); const picked = new Set(selected);
    for (const item of items) {
      const label = el('label', 'ipa-module'); const input = el('input'); input.type = 'checkbox'; input.name = 'projectModules'; input.value = item.id; input.checked = picked.has(item.id);
      const copy = el('span', 'ipa-module-copy'); copy.append(el('strong', '', item.label || item.id), el('small', '', item.externalAvailable ? 'Kundenzugang verfügbar' : 'Nur intern'));
      label.append(input, copy); input.addEventListener('change', changed); wrapper.append(label);
    }
    return wrapper;
  }
  async function getCatalog(api) {
    if (catalog) return catalog;
    if (!catalogRequest) catalogRequest = api('/api/project-modules').then(result => { const items = array(result.catalog); if (!items.length) throw new Error('Die Projektbereiche konnten noch nicht geladen werden.'); catalog = items; return catalog; }).finally(() => { catalogRequest = null; });
    return catalogRequest;
  }
  function selectedModules(root) { return [...root.querySelectorAll('input[name="projectModules"]')].filter(input => input.checked).map(input => input.value); }
  function widget(project, api) {
    const root = el('section', 'iva-project-access'); const state = { loading: false, busy: false, config: null, sequence: 0 };
    const header = el('div', 'ipa-header'); const title = el('div'); title.append(el('span', 'ipa-eyebrow', 'Dein Projekt, deine Freigaben'), el('h2', '', 'Bereiche & Kundenzugänge'));
    const refresh = btn('Aktualisieren'); header.append(title, refresh);
    const intro = el('p', 'ipa-intro', 'Wähle die Bereiche für dieses Projekt. Kundenzugänge erhalten nur die freigegebenen Bereiche dieses Projekts.');
    const feedback = el('p', 'ipa-feedback', 'Einstellungen werden geladen …'); feedback.setAttribute('role', 'status');
    const form = el('form'); const modulesHost = el('div'); const external = el('input'); external.type = 'checkbox'; external.className = 'ipa-toggle-input';
    const externalLabel = el('label', 'ipa-external-toggle'); const externalCopy = el('span'); externalCopy.append(el('strong', '', 'Kundenzugang für dieses Projekt'), el('small', '', 'Persönlicher Zugang im Browser – ohne Installation.')); externalLabel.append(external, externalCopy);
    const permissions = el('div', 'ipa-permissions'); const maximumRole = roleSelect('editor'); const dailyLimit = el('input'); dailyLimit.type = 'number'; dailyLimit.min = '1'; dailyLimit.max = '50'; dailyLimit.value = '10'; dailyLimit.required = true;
    permissions.append(field('Externe dürfen höchstens', maximumRole), field('KI-Aufträge pro Tag und Person', dailyLimit));
    const availability = el('p', 'ipa-note', 'Im Kundenportal ist derzeit das Website Studio verfügbar. Weitere gewählte Bereiche bleiben intern, bis der jeweilige Kundenzugang verfügbar ist.');
    const actions = el('div', 'ipa-actions'); const save = btn('Einstellungen speichern', 'ipa-primary'); save.type = 'submit'; actions.append(save);
    form.append(modulesHost, externalLabel, permissions, availability, actions);
    const people = el('div', 'ipa-people'); const peopleHeading = el('div', 'ipa-section-title'); peopleHeading.append(el('h3', '', 'Menschen mit Zugang'), el('p', '', 'Einladungen gelten nur für dieses Projekt. Du kannst Zugänge jederzeit entfernen.'));
    const members = el('div', 'ipa-members'); const invitation = el('form', 'ipa-invite'); const email = el('input'); email.type = 'email'; email.required = true; email.maxLength = 254; email.placeholder = 'kunde@unternehmen.de'; email.autocomplete = 'email';
    const inviteRole = roleSelect('editor'); const invite = btn('Einladungslink erstellen', 'ipa-primary'); invite.type = 'submit'; invitation.append(field('E-Mail-Adresse', email), field('Berechtigung', inviteRole), invite);
    const inviteFeedback = el('p', 'ipa-feedback'); inviteFeedback.setAttribute('role', 'status'); const inviteResult = el('div', 'ipa-invite-result'); inviteResult.hidden = true;
    people.append(peopleHeading, members, invitation, inviteFeedback, inviteResult); root.append(header, intro, feedback, form, people);
    function sync() {
      const enabled = external.checked;
      permissions.classList.toggle('ipa-disabled', !enabled); maximumRole.disabled = !enabled || state.busy; dailyLimit.disabled = !enabled || state.busy;
      const cap = roles.indexOf(maximumRole.value); for (const option of inviteRole.options) option.disabled = roles.indexOf(option.value) > cap;
      if (roles.indexOf(inviteRole.value) > cap) inviteRole.value = maximumRole.value;
      const savedEnabled = state.config?.externalEnabled === true;
      const websiteEnabled = array(state.config?.modules).some(id => array(state.config?.catalog || catalog).some(item => item.id === id && item.externalAvailable));
      invite.disabled = state.busy || !savedEnabled || !websiteEnabled; email.disabled = invite.disabled; inviteRole.disabled = invite.disabled;
      invitation.classList.toggle('ipa-disabled', !savedEnabled || !websiteEnabled);
      people.hidden = !state.config;
      if (!savedEnabled) inviteFeedback.textContent = 'Aktiviere den Kundenzugang und speichere die Einstellungen, bevor du jemanden einlädst.';
      else if (!websiteEnabled) inviteFeedback.textContent = 'Wähle zuerst einen Bereich, der im Kundenportal verfügbar ist, und speichere die Einstellungen.';
      else if (!state.busy) inviteFeedback.textContent = '';
      save.disabled = state.loading || state.busy || !state.config;
      refresh.disabled = state.loading || state.busy;
    }
    function renderMembers() {
      members.replaceChildren();
      if (!array(state.config?.members).length) { members.append(el('p', 'ipa-empty', 'Bisher hat noch niemand einen Kundenzugang für dieses Projekt.')); return; }
      for (const member of state.config.members) {
        const row = el('div', 'ipa-member'); const initials = String(member.email || '?').slice(0, 1).toUpperCase(); const identity = el('div', 'ipa-member-identity'); identity.append(el('strong', '', member.email || member.userId));
        const effective = roles[Math.min(Math.max(0, roles.indexOf(member.role)), Math.max(0, roles.indexOf(state.config.externalRole)))]; identity.append(el('small', '', state.config.externalEnabled ? roleLabels[effective] : 'Kundenzugang pausiert'));
        const remove = btn('Zugang entfernen', 'ipa-remove'); row.append(el('span', 'ipa-person-avatar', initials), identity, remove); members.append(row);
        remove.addEventListener('click', async () => { if (state.busy) return; remove.disabled = true; try { await api(`${endpoint(project.id)}/members/${encodeURIComponent(member.userId)}`, { method: 'DELETE' }); await load(); feedback.textContent = 'Der Kundenzugang wurde für dieses Projekt entfernt.'; } catch (error) { feedback.textContent = error.message; feedback.classList.add('ipa-error'); } finally { remove.disabled = false; } });
      }
    }
    function renderConfig(config) {
      state.config = config;
      const items = array(config.catalog).length ? config.catalog : catalog || [];
      if (items.length) catalog = items;
      modulesHost.replaceChildren(moduleList(items, array(config.modules), () => { feedback.textContent = 'Du hast ungespeicherte Änderungen.'; }));
      external.checked = config.externalEnabled === true; maximumRole.value = roles.includes(config.externalRole) ? config.externalRole : 'editor'; dailyLimit.value = String(config.dailyBuildLimit ?? 10); inviteRole.value = maximumRole.value;
      renderMembers(); sync(); applyVisibility();
    }
    function applyVisibility() {
      if (visibleProjectId !== project.id) return;
      const enabled = new Set(array(state.config?.modules));
      const websiteLink = document.getElementById('websiteStudioEntry'); if (websiteLink) websiteLink.hidden = !enabled.has('websites');
      const team = document.getElementById('projectTeam')?.closest('.project-team-host'); if (team) team.hidden = !enabled.has('team');
    }
    async function load() {
      const sequence = ++state.sequence; state.loading = true; feedback.classList.remove('ipa-error'); feedback.textContent = 'Einstellungen werden geladen …'; sync();
      try { const config = await api(endpoint(project.id)); if (sequence !== state.sequence) return; renderConfig(config); feedback.textContent = ''; }
      catch (error) { if (sequence === state.sequence) { feedback.textContent = error.message; feedback.classList.add('ipa-error'); } }
      finally { if (sequence === state.sequence) { state.loading = false; sync(); } }
    }
    external.addEventListener('change', sync); maximumRole.addEventListener('change', sync); refresh.addEventListener('click', load);
    form.addEventListener('submit', async event => { event.preventDefault(); if (state.busy || !state.config) return; state.busy = true; sync(); feedback.classList.remove('ipa-error'); feedback.textContent = 'Einstellungen werden gespeichert …';
      const input = { modules: selectedModules(modulesHost), externalEnabled: external.checked, externalRole: maximumRole.value, dailyBuildLimit: Number(dailyLimit.value) };
      try { const config = await api(endpoint(project.id), { method: 'POST', body: input }); renderConfig(config.access || config); feedback.textContent = 'Bereiche und Kundenzugänge wurden gespeichert.'; inviteResult.hidden = true; }
      catch (error) { feedback.textContent = error.message; feedback.classList.add('ipa-error'); }
      finally { state.busy = false; sync(); }
    });
    invitation.addEventListener('submit', async event => { event.preventDefault(); if (state.busy || invite.disabled) return; state.busy = true; sync(); inviteFeedback.classList.remove('ipa-error'); inviteFeedback.textContent = 'Einladungslink wird erstellt …'; inviteResult.hidden = true;
      try {
        const result = await api(`${endpoint(project.id)}/invites`, { method: 'POST', body: { email: email.value.trim(), role: inviteRole.value } });
        const url = new URL(result.inviteUrl, location.origin); if (url.origin !== location.origin || !url.pathname.startsWith('/portal')) throw new Error('Der Einladungslink konnte nicht angezeigt werden.');
        inviteResult.replaceChildren(); inviteResult.append(el('strong', '', `Einladung für ${result.email || email.value.trim()}`), el('p', '', `Teile diesen Link mit der Person. Er gilt bis ${date(result.expiresAt)}.`));
        const link = el('input'); link.readOnly = true; link.value = url.href; link.setAttribute('aria-label', 'Persönlicher Einladungslink'); const copy = btn('Link kopieren'); const linkRow = el('div', 'ipa-link-row'); linkRow.append(link, copy); inviteResult.append(linkRow); inviteResult.hidden = false;
        copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(url.href); copy.textContent = 'Kopiert'; } catch { link.focus(); link.select(); copy.textContent = 'Link zum Kopieren markiert'; } });
        inviteFeedback.textContent = 'Der Link ist bereit. Es wurde keine E-Mail versendet.';
      } catch (error) { inviteFeedback.textContent = error.message; inviteFeedback.classList.add('ipa-error'); }
      finally { state.busy = false; sync(); }
    });
    load(); return { root, load, applyVisibility };
  }
  window.mountIvaProjectAccess = (container, { project, api } = {}) => { if (!container || !project?.id || typeof api !== 'function') return; visibleProjectId = project.id; let value = widgets.get(project.id); if (!value) { value = widget(project, api); widgets.set(project.id, value); } container.replaceChildren(value.root); value.applyVisibility(); };
  window.prepareIvaProjectModules = async api => {
    const form = document.getElementById('projectForm'); if (!form) return;
    if (!creation) {
      const section = el('section', 'ipa-new-project'); section.append(el('h3', '', 'Welche Bereiche gehören zum Projekt?'), el('p', 'ipa-note', 'Du kannst die Auswahl und Kundenzugänge später ändern.'));
      const choices = el('div'); const feedback = el('p', 'ipa-feedback', 'Bereiche werden geladen …'); section.append(choices, feedback); form.querySelector('.dialog-actions').before(section); creation = { section, choices, feedback, ready: false };
    }
    creation.ready = false; creation.feedback.textContent = 'Bereiche werden geladen …';
    try { const items = await getCatalog(api); creation.choices.replaceChildren(moduleList(items, items.map(item => item.id), () => {})); creation.ready = true; creation.feedback.textContent = ''; }
    catch (error) { creation.feedback.textContent = error.message; }
  };
  window.readIvaNewProjectModules = () => { if (!creation?.ready) throw new Error('Bitte warte, bis die Projektbereiche geladen sind.'); return selectedModules(creation.choices); };
})();
