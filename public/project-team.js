/* Project-scoped team UI. Tokens live only in the password input until submission. */
(() => {
  const widgets = new Map();
  let activeWidget = null;
  const el = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  };
  const button = (label, className = '') => {
    const node = el('button', `ipt-button ${className}`, label);
    node.type = 'button';
    return node;
  };
  function sessionId(projectId) {
    const key = `iva-project-team-session:${projectId}`;
    try {
      const existing = sessionStorage.getItem(key);
      if (/^project-team-[A-Za-z0-9-]{12,100}$/.test(existing || '')) return existing;
      const created = `project-team-${crypto.randomUUID()}`;
      sessionStorage.setItem(key, created);
      return created;
    } catch { return `project-team-${crypto.randomUUID()}`; }
  }
  function field(form, label, name, options = {}) {
    const wrapper = el('label', `ipt-field${options.wide ? ' ipt-wide' : ''}`);
    wrapper.append(el('span', '', label));
    const input = el(options.options ? 'select' : 'input');
    input.name = name;
    if (options.options) for (const [value, title] of options.options) {
      const option = el('option', '', title);
      option.value = value;
      input.append(option);
    }
    else {
      input.type = options.type || 'text';
      input.maxLength = options.maxLength || 180;
      input.placeholder = options.placeholder || '';
    }
    if (options.pattern) input.pattern = options.pattern;
    input.autocomplete = options.type === 'password' ? 'new-password' : 'off';
    wrapper.append(input);
    form.append(wrapper);
    return input;
  }

  function createWidget(project, api) {
    const widget = { projectId: String(project.id), project, api, sessionId: sessionId(project.id), loaded: false, loading: false, loadSequence: 0, dirty: false, saveBusy: false, taskBusy: false, encryptionReady: false, connection: null };
    const root = el('section', 'iva-project-team');
    widget.root = root;
    const header = el('div', 'ipt-header');
    const heading = el('div');
    heading.append(el('div', 'ipt-eyebrow', 'Dein Projektteam'), el('h2', '', 'Team & Anbindungen'));
    const refresh = button('Aktualisieren');
    header.append(heading, refresh);
    const introduction = el('p', 'ipt-intro', 'Alle IVA-Fachagenten stehen in jedem Projekt bereit. IVA wählt den passenden Bereich und die verfügbaren Werkzeuge für deinen Auftrag. Konten werden diesem Projekt zugeordnet und können später ergänzt werden.');
    const loadStatus = el('p', 'ipt-feedback', 'Team wird geladen …');
    loadStatus.setAttribute('role', 'status');
    const chips = el('div', 'ipt-agents');
    chips.setAttribute('aria-label', 'Fachagent auswählen');
    root.append(header, introduction, loadStatus, chips);

    const taskForm = el('form', 'ipt-task');
    const taskLabel = el('label', 'ipt-field');
    taskLabel.append(el('span', '', 'Auftrag für dieses Projekt'));
    const taskInput = el('textarea');
    taskInput.name = 'projectTask';
    taskInput.required = true;
    taskInput.maxLength = 12000;
    taskInput.rows = 3;
    taskInput.placeholder = 'Zum Beispiel: Prüfe unsere Instagram-Referenzen und entwickle drei passende Content-Ideen.';
    taskLabel.append(taskInput);
    const taskActions = el('div', 'ipt-task-actions');
    const roleLabel = el('label', 'ipt-role');
    roleLabel.append(el('span', '', 'Zuständigkeit'));
    const role = el('select');
    const automatic = el('option', '', 'Automatisch durch IVA');
    automatic.value = 'iva-standard';
    role.append(automatic);
    roleLabel.append(role);
    const run = button('Auftrag starten', 'ipt-primary');
    run.type = 'submit';
    run.disabled = true;
    taskActions.append(roleLabel, run);
    const taskStatus = el('p', 'ipt-feedback');
    taskStatus.setAttribute('role', 'status');
    const result = el('div', 'ipt-result');
    result.hidden = true;
    result.setAttribute('role', 'region');
    result.setAttribute('aria-label', 'Ergebnis des Projektauftrags');
    taskForm.append(taskLabel, taskActions, taskStatus, result);
    root.append(taskForm);

    const connectionArea = el('div', 'ipt-connections');
    const connectionHeader = el('div', 'ipt-connection-head');
    connectionHeader.append(el('h3', '', 'Instagram für dieses Projekt'));
    const connectionBadge = el('span', 'ipt-badge', 'Wird geprüft …');
    connectionHeader.append(connectionBadge);
    const connectionSummary = el('p', 'ipt-muted', 'Öffentliche Referenzen lesen, eigene Beiträge auswerten und Kommentare eigener Beiträge prüfen.');
    const connectionDetails = el('p', 'ipt-muted');
    const capabilityNote = el('p', 'ipt-note', 'Für eigene Beiträge und Kommentare braucht IVA ein verbundenes Business- oder Creator-Konto. Öffentliche Referenzen nutzen die verfügbare Recherche-Anbindung. Veröffentlichen, Direktnachrichten und Video-Transkription sind hier noch nicht angebunden.');
    const disclosure = el('details', 'ipt-connection-settings');
    disclosure.append(el('summary', '', 'Konto ergänzen oder ändern'));
    const connectionForm = el('form', 'ipt-connection-form');
    const inputs = {
      label: field(connectionForm, 'Kontobezeichnung', 'label', { placeholder: 'Instagram · Projektname' }),
      handle: field(connectionForm, 'Instagram-Profil', 'handle', { placeholder: '@profil oder Instagram-Link', maxLength: 1200 }),
      accountId: field(connectionForm, 'Professional-Konto-ID', 'accountId', { placeholder: 'Instagram-Konto-ID', maxLength: 40, pattern: '\\d{1,40}' }),
      authMode: field(connectionForm, 'Art der Verbindung', 'authMode', { options: [['instagram', 'Instagram Login'], ['facebook', 'Facebook Login (verknüpfte Seite)']] }),
      graphVersion: field(connectionForm, 'Meta Graph-Version', 'graphVersion', { placeholder: 'Version der Meta-App, z. B. v24.0', maxLength: 12, pattern: 'v\\d{1,2}\\.\\d{1,2}' }),
      accessToken: field(connectionForm, 'Zugriffstoken (optional)', 'accessToken', { type: 'password', maxLength: 6000, placeholder: 'Sicher hinterlegen oder für später leer lassen', wide: true }),
    };
    widget.tokenInput = inputs.accessToken;
    inputs.accessToken.disabled = true;
    const credentialHint = el('p', 'ipt-note ipt-wide', 'Kontodaten können zuerst vorgemerkt werden. Einen bestehenden Zugriffstoken ersetzt du nur, wenn du hier einen neuen eingibst.');
    const encryptionHint = el('p', 'ipt-note ipt-wide');
    const connectionActions = el('div', 'ipt-form-actions ipt-wide');
    const save = button('Kontodaten speichern', 'ipt-primary');
    save.type = 'submit';
    const verify = button('Verbindung prüfen');
    verify.disabled = true;
    connectionActions.append(save, verify);
    const connectionStatus = el('p', 'ipt-feedback ipt-wide');
    connectionStatus.setAttribute('role', 'status');
    connectionForm.append(credentialHint, encryptionHint, connectionActions, connectionStatus);
    disclosure.append(connectionForm);
    connectionArea.append(connectionHeader, connectionSummary, connectionDetails, capabilityNote, disclosure);
    root.append(connectionArea);

    const basePath = `/api/projects/${encodeURIComponent(widget.projectId)}`;
    function feedback(node, message, error = false) {
      node.textContent = message;
      node.classList.toggle('ipt-error', error);
    }
    function renderConnection(connections) {
      widget.encryptionReady = connections.encryptionReady === true;
      inputs.accessToken.disabled = !widget.encryptionReady || widget.saveBusy;
      const items = Array.isArray(connections.items) ? connections.items : [];
      const connection = items.find(item => (item.provider || item.providerId || item.id) === 'instagram') || null;
      widget.connection = connection;
      const verified = connection?.status === 'verified';
      const configured = connection?.configured === true;
      const connectionLabels = {
        verified: 'Verbindung bestätigt',
        verification_failed: 'Verbindungsprüfung fehlgeschlagen',
        encryption_unavailable: 'Zugriffstoken derzeit nicht verfügbar',
        configured: 'Eingerichtet · noch nicht bestätigt',
        missing_connection: 'Vorgemerkt · Zugang fehlt',
      };
      connectionBadge.textContent = connectionLabels[connection?.status] || (configured ? connectionLabels.configured : connection ? connectionLabels.missing_connection : 'Konto später ergänzen');
      connectionBadge.classList.toggle('ipt-verified', verified);
      connectionBadge.classList.toggle('ipt-connection-error', ['verification_failed', 'encryption_unavailable'].includes(connection?.status));
      const parts = [connection?.label, connection?.handle].filter(value => typeof value === 'string' && value.trim());
      if (verified && connection.verifiedAt) {
        const verifiedDate = new Date(connection.verifiedAt);
        if (Number.isFinite(verifiedDate.getTime())) parts.push(`Bestätigt am ${verifiedDate.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}`);
      }
      connectionDetails.textContent = parts.length ? parts.join(' · ') : 'Noch kein eigenes Instagram-Konto in diesem Projekt hinterlegt.';
      verify.disabled = widget.saveBusy || !configured;
      encryptionHint.textContent = widget.encryptionReady ? 'Zugriffstoken werden für dieses Projekt verschlüsselt auf dem Server gespeichert.' : 'Die sichere Token-Speicherung ist noch nicht bereit. Du kannst die Kontodaten bereits vormerken.';
      if (!widget.dirty) {
        for (const name of ['label', 'handle', 'accountId', 'graphVersion']) inputs[name].value = typeof connection?.[name] === 'string' ? connection[name] : '';
        inputs.authMode.value = connection?.authMode === 'facebook' ? 'facebook' : 'instagram';
      }
    }
    function renderAgents(agents) {
      const selected = role.value;
      chips.replaceChildren();
      role.replaceChildren(automatic);
      let activeCount = 0;
      for (const agent of agents) {
        const agentId = String(agent.id || agent.agentId || '');
        if (!agentId) continue;
        const enabled = agent.enabled !== false;
        const name = typeof agent.name === 'string' ? agent.name : agentId;
        const chip = button(name, 'ipt-agent');
        chip.disabled = !enabled;
        chip.title = typeof agent.description === 'string' ? agent.description : name;
        chip.dataset.agentId = agentId;
        chip.setAttribute('aria-pressed', String(selected === agentId));
        chip.addEventListener('click', () => { role.value = agentId; selectRole(); taskInput.focus(); });
        chips.append(chip);
        if (enabled) activeCount++;
        if (agentId !== 'iva-standard') {
          const option = el('option', '', name);
          option.value = agentId;
          option.disabled = !enabled;
          role.append(option);
        }
      }
      if ([...role.options].some(option => option.value === selected && !option.disabled)) role.value = selected;
      selectRole();
      run.disabled = widget.taskBusy || activeCount === 0;
      feedback(loadStatus, `${activeCount} Agenten für dieses Projekt verfügbar. Ihre Werkzeuge richten sich nach den eingerichteten Anbindungen.`);
    }
    function selectRole() {
      for (const chip of chips.children) chip.setAttribute('aria-pressed', String(chip.dataset.agentId === role.value));
    }
    role.addEventListener('change', selectRole);
    connectionForm.addEventListener('input', () => { widget.dirty = true; });

    widget.reload = async () => {
      const sequence = ++widget.loadSequence;
      widget.loading = true;
      refresh.disabled = true;
      try {
        const payload = await widget.api(`${basePath}/team`);
        if (sequence !== widget.loadSequence) return;
        renderAgents(Array.isArray(payload.agents) ? payload.agents : []);
        renderConnection(payload.connections || {});
        widget.loaded = true;
      } catch {
        if (sequence === widget.loadSequence) feedback(loadStatus, 'Team und Anbindungen konnten gerade nicht geladen werden. Bitte erneut aktualisieren.', true);
      } finally { if (sequence === widget.loadSequence) { refresh.disabled = false; widget.loading = false; } }
    };
    refresh.addEventListener('click', () => widget.reload());

    taskForm.addEventListener('submit', async event => {
      event.preventDefault();
      const message = taskInput.value.trim();
      if (!message || widget.taskBusy || !widget.loaded) return;
      widget.taskBusy = true;
      run.disabled = true;
      run.textContent = 'IVA arbeitet …';
      role.disabled = true;
      feedback(taskStatus, 'IVA bearbeitet den Auftrag mit den für dieses Projekt verfügbaren Agenten und Werkzeugen.');
      result.hidden = true;
      try {
        const payload = await widget.api('/api/chat', { method: 'POST', body: { message, sessionId: widget.sessionId, projectId: widget.projectId, agentId: role.value || 'iva-standard' } });
        if (typeof payload.reply !== 'string' || !payload.reply.trim()) throw new Error('missing_reply');
        // Every response stays in its own persistent project widget; never use global selectors.
        result.textContent = payload.reply;
        result.hidden = false;
        feedback(taskStatus, 'Antwort für dieses Projekt liegt vor.');
      } catch { feedback(taskStatus, 'Der Auftrag konnte nicht bestätigt werden. Bitte den aktuellen Verlauf prüfen, bevor du ihn erneut startest.', true); }
      finally {
        widget.taskBusy = false;
        run.disabled = false;
        run.textContent = 'Auftrag starten';
        role.disabled = false;
      }
    });

    connectionForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (widget.saveBusy) return;
      widget.saveBusy = true;
      save.disabled = true;
      verify.disabled = true;
      const body = {};
      for (const name of ['label', 'handle', 'accountId', 'authMode', 'graphVersion']) body[name] = inputs[name].value.trim();
      if (widget.encryptionReady && inputs.accessToken.value.trim()) body.accessToken = inputs.accessToken.value.trim();
      // Clear immediately, including for rejected requests. Never write tokens to browser storage.
      inputs.accessToken.value = '';
      inputs.accessToken.disabled = true;
      feedback(connectionStatus, 'Kontodaten werden gespeichert …');
      try {
        const payload = await widget.api(`${basePath}/connections/instagram`, { method: 'PUT', body });
        if (payload.ok === false) throw new Error('save_rejected');
        widget.dirty = false;
        feedback(connectionStatus, 'Kontodaten gespeichert. Mit „Verbindung prüfen“ kannst du den tatsächlichen Zugriff bestätigen.');
      } catch { feedback(connectionStatus, 'Die Kontodaten konnten nicht gespeichert werden. Prüfe die Verbindung; ein eingegebener Zugriffstoken wurde aus dem Formular entfernt.', true); }
      finally {
        delete body.accessToken;
        inputs.accessToken.value = '';
        widget.saveBusy = false;
        save.disabled = false;
        inputs.accessToken.disabled = !widget.encryptionReady;
        await widget.reload();
      }
    });
    verify.addEventListener('click', async () => {
      if (widget.saveBusy) return;
      widget.saveBusy = true;
      verify.disabled = true;
      save.disabled = true;
      feedback(connectionStatus, 'IVA prüft den Zugriff auf das hinterlegte eigene Konto …');
      try {
        const payload = await widget.api(`${basePath}/connections/instagram/verify`, { method: 'POST', body: {} });
        const confirmed = payload.ok === true && payload.connection?.status === 'verified';
        feedback(connectionStatus, confirmed ? 'Der Zugriff auf das eigene Instagram-Konto wurde bestätigt.' : 'Die Verbindung wurde noch nicht bestätigt. Prüfe Konto-ID, Login-Art, Token und die erforderlichen Berechtigungen.', !confirmed);
      } catch { feedback(connectionStatus, 'Die Verbindung konnte nicht bestätigt werden. Prüfe die Kontodaten und Meta-Berechtigungen.', true); }
      finally { widget.saveBusy = false; save.disabled = false; await widget.reload(); }
    });
    return widget;
  }

  window.mountIvaProjectTeam = (container, { project, api } = {}) => {
    if (!container || !project?.id || typeof api !== 'function') return null;
    const projectId = String(project.id);
    let widget = widgets.get(projectId);
    if (!widget) { widget = createWidget(project, api); widgets.set(projectId, widget); }
    widget.api = api;
    widget.project = project;
    if (activeWidget && activeWidget !== widget) activeWidget.tokenInput.value = '';
    const changedProject = activeWidget !== widget;
    activeWidget = widget;
    // Reparent the existing node on parent renders; preserve text, focus target, details and form edits.
    if (widget.root.parentElement !== container) container.replaceChildren(widget.root);
    if (changedProject || (!widget.loaded && !widget.loading)) widget.reload();
    return { reload: widget.reload };
  };
  window.addEventListener('pagehide', () => { for (const widget of widgets.values()) widget.tokenInput.value = ''; });
})();
