/* IVA Website Studio. Project scope is captured for every operation; preview content stays in an opaque sandbox. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const API = '/api/website-studio';
  const state = { projects: [], sites: [], projectId: '', siteId: '', site: null, status: null, epoch: 0, refreshSequence: 0, previewSequence: 0, previewRevision: '', previewKey: '', messageKey: '', poll: null, drafts: new Map(), importKind: 'url', loading: false, actionBusy: false };
  const activeJobs = new Set(['queued', 'running', 'pending', 'starting', 'building', 'importing', 'publishing']);
  const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; };
  const icon = name => { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true'); const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', `#i-${name}`); svg.append(use); return svg; };
  const button = (label, className = 'button subtle') => { const node = element('button', className, label); node.type = 'button'; return node; };
  const asArray = (value, key) => Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] : [];
  const scope = () => ({ projectId: state.projectId, siteId: state.siteId, epoch: state.epoch });
  const isCurrent = captured => captured.epoch === state.epoch && captured.projectId === state.projectId && captured.siteId === state.siteId;
  const draftKey = captured => `${captured.projectId}/${captured.siteId || 'new'}`;
  const busy = () => activeJobs.has(state.site?.job?.status);
  function token() { try { return localStorage.getItem('iva_token') || ''; } catch { return ''; } }
  function safeLink(value) { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; } }
  function externalLink(label, url, className = 'inline-link') { const href = safeLink(url); if (!href) return element('span', 'muted', label); const link = element('a', className, label); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link; }
  function sitePath(captured, suffix = '', extra = {}) { const query = new URLSearchParams({ projectId: captured.projectId, ...extra }); return `${API}/sites/${encodeURIComponent(captured.siteId)}${suffix}?${query}`; }
  async function request(url, { method = 'GET', body, raw = false, blob = false, contentType } = {}) {
    const headers = new Headers();
    const access = token(); if (access) headers.set('Authorization', `Bearer ${access}`);
    if (body !== undefined) headers.set('Content-Type', contentType || (raw ? 'application/octet-stream' : 'application/json'));
    const response = await fetch(url, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : raw ? body : JSON.stringify(body), cache: 'no-store' });
    if (response.status === 401) { if (!$('authDialog').open) $('authDialog').showModal(); throw new Error('Bitte verbinde dich mit deinem IVA-Zugang.'); }
    if (!response.ok) {
      let payload; try { payload = await response.json(); } catch { /* Do not show arbitrary HTML error bodies. */ }
      const message = typeof payload?.error === 'string' ? payload.error : payload?.error?.message || payload?.message;
      throw Object.assign(new Error(message || `Die Anfrage konnte nicht abgeschlossen werden (${response.status}).`), { status: response.status });
    }
    if (blob) return response.blob();
    if (response.status === 204) return {};
    return response.json();
  }
  let toastTimer;
  function toast(message, error = false) { const node = $('toast'); node.textContent = message; node.classList.toggle('error', error); node.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { node.hidden = true; }, error ? 8000 : 4500); }
  function date(value, short = false) { if (!value) return ''; const parsed = new Date(value); return Number.isNaN(parsed.valueOf()) ? '' : parsed.toLocaleString('de-DE', short ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  function closeActionDialogs() { for (const dialog of document.querySelectorAll('dialog[open]')) if (!['authDialog', 'connectionsDialog'].includes(dialog.id)) dialog.close(); }
  function openDialog(id) { document.querySelector('.more-menu')?.removeAttribute('open'); const dialog = $(id); dialog._scope = scope(); const feedback = dialog.querySelector('.form-feedback'); if (feedback) feedback.textContent = ''; if (!dialog.open) dialog.showModal(); return dialog; }
  function setFormBusy(form, value) { for (const control of form.querySelectorAll('button[type="submit"]')) control.disabled = value; form.setAttribute('aria-busy', String(value)); }
  async function formAction(form, action) { if (form.getAttribute('aria-busy') === 'true') return; const feedback = form.querySelector('.form-feedback'); if (feedback) feedback.textContent = ''; setFormBusy(form, true); try { await action(); } catch (error) { if (feedback) feedback.textContent = error.message; else toast(error.message, true); } finally { setFormBusy(form, false); updateControls(); } }
  function fillProjects(select, selected) { select.replaceChildren(); if (!state.projects.length) { const empty = element('option', '', 'Zuerst ein Projekt anlegen'); empty.value = ''; select.append(empty); } for (const project of state.projects) { const option = element('option', '', project.name || project.title || 'Projekt'); option.value = project.id; select.append(option); } select.value = selected || state.projects[0]?.id || ''; }
  function fillSites() { const select = $('siteSelect'); select.replaceChildren(); if (!state.sites.length) { const empty = element('option', '', 'Neue Website starten'); empty.value = ''; select.append(empty); } for (const site of state.sites) { const option = element('option', '', site.name || 'Website'); option.value = site.id; select.append(option); } select.value = state.siteId; select.disabled = !state.sites.length; }
  function saveDraft() { state.drafts.set(draftKey(scope()), $('chatInput').value); }
  function loadDraft() { $('chatInput').value = state.drafts.get(draftKey(scope())) || ''; }
  function clearSite() {
    state.site = null; state.siteId = ''; state.previewRevision = ''; state.previewKey = ''; state.messageKey = ''; state.lastDraftRevision = '';
    clearTimeout(state.poll); state.poll = null; state.previewSequence++;
    $('websitePreview').hidden = true; $('websitePreview').removeAttribute('srcdoc'); $('previewEmpty').hidden = false; $('previewLoading').hidden = true; $('previewError').hidden = true; $('previewCanvas').classList.remove('has-preview');
    renderPreviewWarnings([]);
    $('messages').replaceChildren(); $('chatIntro').hidden = false; $('jobCard').hidden = true;
  }
  async function selectProject(projectId, preferredSite = '') {
    saveDraft(); state.epoch++; closeActionDialogs(); clearSite(); state.projectId = projectId; state.sites = []; state.loading = true; state.actionBusy = false;
    $('projectSelect').value = projectId; fillSites(); loadDraft(); renderSite();
    const captured = scope();
    if (!projectId) { state.loading = false; updateControls(); return; }
    try {
      const result = await request(`${API}/sites?${new URLSearchParams({ projectId })}`);
      if (!isCurrent(captured)) return;
      state.sites = asArray(result, 'sites'); state.loading = false;
      const selected = state.sites.find(site => site.id === preferredSite) || state.sites[0];
      if (selected) await selectSite(selected.id); else { fillSites(); renderSite(); }
    } catch (error) { if (isCurrent(captured)) { state.loading = false; renderSite(); toast(error.message, true); } }
  }
  async function selectSite(siteId) {
    saveDraft(); state.epoch++; closeActionDialogs(); clearSite(); state.siteId = siteId; state.loading = true; state.actionBusy = false; fillSites(); loadDraft(); renderSite();
    const captured = scope();
    try { await refreshSite(captured); } catch (error) { if (isCurrent(captured)) toast(error.message, true); }
    finally { if (isCurrent(captured)) { state.loading = false; updateControls(); } }
  }
  async function refreshSite(captured = scope()) {
    if (!captured.siteId || !captured.projectId) return;
    const sequence = ++state.refreshSequence;
    const payload = await request(sitePath(captured));
    if (!isCurrent(captured) || sequence !== state.refreshSequence) return;
    const site = payload.site || payload;
    if (site.id !== captured.siteId || (site.projectId && site.projectId !== captured.projectId)) throw new Error('Die Website-Antwort passt nicht zum gewählten Projekt.');
    state.site = site; const index = state.sites.findIndex(entry => entry.id === site.id); if (index >= 0) state.sites[index] = site; else state.sites.push(site);
    fillSites(); renderSite();
    clearTimeout(state.poll);
    if (activeJobs.has(site.job?.status)) state.poll = setTimeout(() => { if (isCurrent(captured)) refreshSite(captured).catch(error => { if (isCurrent(captured)) { toast(error.message, true); state.poll = setTimeout(() => { if (isCurrent(captured)) refreshSite(captured).catch(next => toast(next.message, true)); }, 5000); } }); }, 2000);
  }
  function renderMessages() {
    const messages = asArray(state.site?.messages, 'messages');
    const key = JSON.stringify(messages); if (state.messageKey === key) return; state.messageKey = key;
    const scroll = $('chatScroll'); const nearEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
    $('messages').replaceChildren(); $('chatIntro').hidden = messages.length > 0;
    for (const message of messages) {
      const role = message.role === 'user' ? 'user' : 'assistant';
      const article = element('article', `message ${role}`); const header = element('div', 'message-header');
      header.append(element('span', 'message-avatar', role === 'user' ? 'Du' : 'IVA'), element('span', '', role === 'user' ? 'Du' : 'IVA'));
      const timestamp = date(message.createdAt || message.timestamp, true); if (timestamp) header.append(element('span', 'message-time', timestamp));
      const content = typeof message.content === 'string' ? message.content : typeof message.text === 'string' ? message.text : Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
      article.append(header, element('div', 'message-text', content)); $('messages').append(article);
    }
    if (nearEnd || messages.length < 3) scroll.scrollTop = scroll.scrollHeight;
  }
  function revisionName(id) { const versions = state.site?.revisions || []; const index = versions.findIndex(revision => revision.id === id); return index >= 0 ? `Version ${index + 1}` : 'Entwurf'; }
  function renderSite() {
    const site = state.site;
    const project = state.projects.find(item => item.id === state.projectId);
    $('siteContext').lastElementChild.textContent = site ? `${project?.name || 'Projekt'} · ${site.name}` : state.projectId ? `${project?.name || 'Projekt'} · Neue Website` : 'Wähle ein Projekt, um zu starten.';
    $('assistantStatus').textContent = busy() ? 'Gestaltung läuft im Hintergrund' : site ? 'Bereit für deinen nächsten Schritt' : 'Dein Team für die nächste Website';
    $('readyIndicator').className = `ready-indicator${busy() ? ' busy' : state.projectId ? ' ready' : ''}`;
    $('emptyTitle').textContent = site ? 'Deine Website ist bereit zum Gestalten.' : 'Ein freier Raum für deine Ideen.';
    $('emptyDescription').textContent = site ? 'Sag IVA links, was entstehen soll, oder übernimm deinen bestehenden Website-Code.' : 'Starte mit einer Idee oder bring deine bestehende Website mit. Die Vorschau wächst mit jedem Schritt.';
    $('emptyStart').lastChild.textContent = site ? 'Idee beschreiben' : 'Website starten';
    $('previewLocation').textContent = site ? `${site.name} · Vorschau` : 'Deine Website entsteht hier';
    $('revisionChip').hidden = !site?.draftRevisionId;
    $('revisionChip').textContent = site?.draftRevisionId ? revisionName(state.previewRevision || site.draftRevisionId) : 'Entwurf';
    const publication = site?.publication;
    const published = publication?.status === 'published' || publication?.status === 'active' || publication?.status === 'live';
    $('publicationDot').classList.toggle('live', published);
    $('publicationStatus').textContent = published ? `Veröffentlicht${publication.url ? ` · ${new URL(safeLink(publication.url) || location.origin).hostname}` : ''}` : site?.publishedRevisionId && publication?.status ? `Veröffentlichung: ${publication.status}` : site ? 'Entwurf · noch nicht veröffentlicht' : 'Noch keine Website ausgewählt';
    const job = site?.job; const failed = ['failed', 'error', 'stopped', 'cancelled'].includes(job?.status);
    $('jobCard').hidden = !activeJobs.has(job?.status) && !failed;
    $('jobCard').classList.toggle('failed', failed);
    $('jobTitle').textContent = failed ? 'Dieser Schritt wurde nicht abgeschlossen' : job?.status === 'queued' ? 'Dein Auftrag ist eingeplant' : 'IVA arbeitet an deiner Website';
    $('jobDetail').textContent = job?.error || job?.message || job?.detail || (job?.status === 'queued' ? 'Der Auftrag startet, sobald ein Platz frei ist.' : 'Du kannst hierbleiben oder später zurückkommen.');
    renderMessages(); updateControls();
    if (site?.draftRevisionId && !state.previewRevision) loadPreview(site.draftRevisionId).catch(error => { $('previewError').textContent = error.message; $('previewError').hidden = false; });
    else if (site?.draftRevisionId && state.previewRevision && !site.revisions?.some(revision => revision.id === state.previewRevision)) loadPreview(site.draftRevisionId).catch(error => toast(error.message, true));
    else if (site?.draftRevisionId && state.previewKey && state.previewRevision === state.lastDraftRevision && site.draftRevisionId !== state.lastDraftRevision) loadPreview(site.draftRevisionId).catch(error => toast(error.message, true));
    state.lastDraftRevision = site?.draftRevisionId || '';
  }
  function updateControls() {
    const site = Boolean(state.site); const locked = busy() || state.loading || state.actionBusy;
    for (const control of document.querySelectorAll('[data-site-action]')) control.disabled = !site || (['githubButton', 'publishButton', 'addMedia'].includes(control.id) && locked);
    for (const id of ['githubButton', 'publishButton', 'exportButton', 'historyButton', 'refreshPreview']) $(id).disabled ||= !state.site?.draftRevisionId;
    $('sendButton').disabled = !state.projectId || locked || !$('chatInput').value.trim();
    $('chatInput').disabled = !state.projectId || state.loading;
    $('newSite').disabled = !state.projects.length;
    $('importButton').disabled = locked;
    $('introImport').disabled = locked;
    $('composerNote').textContent = locked ? 'Dein Auftrag wird im Hintergrund verarbeitet.' : 'Änderungen landen zuerst in deiner Vorschau.';
  }
  function renderPreviewWarnings(warnings) {
    const entries = [...new Set(asArray(warnings, 'warnings').map(warning => typeof warning === 'string' ? warning : warning?.message || warning?.text || '').filter(Boolean))].slice(0, 20);
    $('previewWarningList').replaceChildren(...entries.map(warning => element('li', '', String(warning).slice(0, 1500))));
    $('previewWarningCount').textContent = entries.length ? String(entries.length) : '';
    $('previewWarnings').hidden = !entries.length;
    if (!entries.length) $('previewWarnings').open = false;
  }
  async function loadPreview(revisionId, { force = false } = {}) {
    const captured = scope(); if (!captured.siteId || !revisionId) return;
    const key = `${captured.projectId}/${captured.siteId}/${revisionId}`;
    if (state.previewKey === key && !force) return;
    const sequence = ++state.previewSequence; $('previewLoading').hidden = false; $('previewError').hidden = true;
    renderPreviewWarnings([]);
    $('websitePreview').hidden = true; $('previewEmpty').hidden = true;
    try {
      const preview = await request(sitePath(captured, '/preview', { revisionId }));
      if (!isCurrent(captured) || sequence !== state.previewSequence) return;
      renderPreviewWarnings(preview.warnings);
      if (typeof preview.html !== 'string' || !preview.html.trim()) {
        const errors = asArray(preview.errors, 'errors').map(error => typeof error === 'string' ? error : error.message || error.text || 'Vorschau konnte nicht erstellt werden.');
        throw new Error(errors.join('\n') || preview.message || 'Für diese Version konnte noch keine Vorschau erstellt werden.');
      }
      const frame = $('websitePreview');
      // Never add allow-same-origin, forms, popups or top-navigation here. The imported code has no access to IVA credentials.
      frame.setAttribute('sandbox', 'allow-scripts'); frame.srcdoc = preview.html; frame.hidden = false;
      $('previewEmpty').hidden = true; $('previewCanvas').classList.add('has-preview'); state.previewRevision = revisionId; state.previewKey = key;
      $('revisionChip').textContent = revisionName(revisionId); $('previewLocation').textContent = `${state.site.name} · ${revisionName(revisionId)}${revisionId === state.site.draftRevisionId ? '' : ' · frühere Version'}`;
      if (Array.isArray(preview.errors) && preview.errors.length) { $('previewError').textContent = preview.errors.map(error => typeof error === 'string' ? error : error.message || error.text || '').filter(Boolean).join('\n'); $('previewError').hidden = !$('previewError').textContent; }
    } catch (error) { if (isCurrent(captured) && sequence === state.previewSequence) { $('previewError').textContent = error.message; $('previewError').hidden = false; state.previewKey = key; state.previewRevision = revisionId; $('previewEmpty').hidden = false; $('previewCanvas').classList.remove('has-preview'); $('emptyTitle').textContent = 'Diese Vorschau braucht noch einen Schritt.'; $('emptyDescription').textContent = 'Der Website-Code ist gespeichert. Beschreibe IVA im Chat, dass sie die Vorschau für diese Version reparieren soll.'; } }
    finally { if (isCurrent(captured) && sequence === state.previewSequence) $('previewLoading').hidden = true; }
  }
  function openNewSite({ name = '', url = '' } = {}) {
    fillProjects($('newSiteProject'), state.projectId); $('newSiteName').value = name; $('newSiteUrl').value = url;
    openDialog('newSiteDialog');
    if (!state.projects.length) $('newSiteDialog').querySelector('.form-feedback').textContent = 'Lege zuerst ein Projekt an. Danach kannst du hier deine Website starten.';
  }
  function openImport() { if (!state.site) { openNewSite(); return; } $('importTarget').textContent = `Importieren in „${state.site.name}“. Der aktuelle Stand bleibt als Version erhalten.`; $('importUrl').value = state.site.sourceUrl || ''; updateImportKind('url'); openDialog('importDialog'); }
  function updateImportKind(kind) { state.importKind = kind; for (const node of document.querySelectorAll('[data-import]')) node.classList.toggle('active', node.dataset.import === kind); $('importUrlLabel').hidden = kind !== 'url'; $('importRepoLabel').hidden = kind !== 'github'; $('importZipLabel').hidden = kind !== 'zip'; $('importUrl').required = kind === 'url'; $('importRepository').required = kind === 'github'; $('importZip').required = kind === 'zip'; $('importNote').textContent = kind === 'url' ? 'Übernimm deine eigene öffentlich erreichbare Website. Geschützte Inhalte und Backend-Funktionen gehören nicht zum URL-Import. Für eine fremde Referenz gib IVA den Link im Chat.' : kind === 'github' ? 'IVA übernimmt den Quellcode. Für private Repositories muss dein GitHub-Zugang verbunden sein.' : 'Exportiere dein Projekt beim bisherigen Anbieter und lade die ZIP-Datei hier hoch. Zugangsdaten gehören in die Anbindungen.'; }
  function optimisticJob(result, kind = 'build') { if (!state.site) return; const job = result.job || result; if (activeJobs.has(job.status)) state.site.job = { ...job, type: kind }; renderSite(); }
  async function refreshAfterAction(captured, result, kind) { if (!isCurrent(captured)) return; optimisticJob(result, kind); await refreshSite(captured); }
  async function submitChat(event) {
    event.preventDefault(); if (busy() || state.actionBusy || !state.projectId) return;
    const message = $('chatInput').value.trim(); if (!message) return;
    let captured = scope(); state.actionBusy = true; updateControls();
    try {
      if (!captured.siteId) {
        const project = state.projects.find(item => item.id === captured.projectId);
        const created = await request(`${API}/sites`, { method: 'POST', body: { projectId: captured.projectId, name: `${project?.name || 'Meine'} Website`.slice(0, 180) } });
        if (!isCurrent(captured)) return;
        const site = created.site || created; state.sites.unshift(site); await selectSite(site.id);
        if (state.projectId !== captured.projectId || state.siteId !== site.id) return;
        captured = scope();
      }
      const current = scope(); state.actionBusy = true; updateControls();
      const result = await request(sitePath(current, '/chat'), { method: 'POST', body: { projectId: current.projectId, message, model: $('modelSelect').value, baseRevisionId: state.site?.draftRevisionId || null } });
      if (!isCurrent(current)) return;
      $('chatInput').value = ''; state.drafts.delete(draftKey(current)); state.drafts.delete(`${current.projectId}/new`);
      await refreshAfterAction(current, result, 'build'); $('chatScroll').scrollTop = $('chatScroll').scrollHeight;
    } catch (error) { if (isCurrent(captured)) { if (!$('chatInput').value) $('chatInput').value = message; toast(error.message, true); } }
    finally { if (isCurrent(captured)) { state.actionBusy = false; updateControls(); } }
  }
  function openHistory() {
    if (!state.site) return;
    const captured = scope(); const revisions = [...(state.site.revisions || [])].reverse(); $('revisionList').replaceChildren();
    for (const revision of revisions) {
      const current = revision.id === state.site.draftRevisionId;
      const row = element('article', `revision-row${current ? ' current' : ''}`); const top = element('div', 'revision-row-top');
      top.append(element('strong', '', revisionName(revision.id))); if (current) top.append(element('span', 'small-badge', 'Aktueller Entwurf')); else if (revision.id === state.site.publishedRevisionId) top.append(element('span', 'small-badge', 'Veröffentlicht'));
      row.append(top, element('p', '', revision.summary || 'Gespeicherter Website-Stand'), element('small', '', `${date(revision.createdAt)}${revision.fileCount ? ` · ${revision.fileCount} Dateien` : ''}`));
      const actions = element('div', 'revision-row-actions'); const preview = button('Ansehen'); const restore = button('Als Entwurf übernehmen'); restore.disabled = current || busy();
      preview.addEventListener('click', () => { if (!isCurrent(captured)) return; $('historyDialog').close(); showPane('preview'); loadPreview(revision.id).catch(error => toast(error.message, true)); });
      restore.addEventListener('click', async () => { if (!isCurrent(captured)) return; restore.disabled = true; try { const result = await request(sitePath(captured, '/restore'), { method: 'POST', body: { projectId: captured.projectId, revisionId: revision.id, baseRevisionId: state.site.draftRevisionId } }); if (!isCurrent(captured)) return; state.previewRevision = ''; state.previewKey = ''; await refreshAfterAction(captured, result, 'restore'); $('historyDialog').close(); toast('Die Version ist jetzt dein neuer Entwurf.'); } catch (error) { toast(error.message, true); } finally { restore.disabled = current || busy(); } });
      actions.append(preview, restore); row.append(actions); $('revisionList').append(row);
    }
    if (!revisions.length) $('revisionList').append(element('p', 'muted', 'Sobald IVA deine Website anlegt oder du sie importierst, erscheint hier die erste Version.'));
    openDialog('historyDialog');
  }
  function githubReady() { const github = state.status?.github; return github === true || github?.configured === true || github?.connected === true || ['configured', 'connected', 'ready', 'verified'].includes(github?.status); }
  function openGitHub() {
    if (!state.site) return; $('githubSummary').replaceChildren();
    const github = state.site.github;
    if (github?.url || github?.repositoryUrl) { $('githubSummary').append(element('p', '', 'Diese Website ist bereits einem Repository zugeordnet.'), externalLink(github.repository || github.repo || 'Repository öffnen', github.url || github.repositoryUrl)); }
    else $('githubSummary').textContent = githubReady() ? 'Dein GitHub-Zugang ist hinterlegt. IVA kann ein privates Repository anlegen.' : 'Verbinde GitHub einmal, damit IVA den Code für dich sichern kann.';
    $('repositoryName').value = github?.repo || github?.repository?.split('/').at(-1) || state.site.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'meine-website';
    $('githubSubmit').disabled = !githubReady(); openDialog('githubDialog');
  }
  function openPublish() { if (!state.site?.draftRevisionId) return; const revision = state.previewRevision || state.site.draftRevisionId; $('publishName').textContent = state.site.name; $('publishRevision').textContent = revisionName(revision); const dialog = openDialog('publishDialog'); dialog._revisionId = revision; }
  function connectionRow(name, detail, label, ready) { const row = element('div', 'connection-row'); const copy = element('div'); copy.append(element('b', '', name), element('p', '', detail)); const badge = element('span', 'small-badge', label); if (!ready) badge.style.borderColor = '#526078'; row.append(copy, badge); return row; }
  function renderConnections() {
    const root = $('connectionStatus'); root.replaceChildren();
    const github = state.status?.github; const hosting = state.status?.hosting;
    root.append(connectionRow('GitHub', 'Website-Code und private Repositories', githubReady() ? 'Zugang hinterlegt' : 'Noch nicht verbunden', githubReady()));
    if (github?.connectUrl && safeLink(github.connectUrl)) root.append(externalLink('GitHub verbinden ↗', github.connectUrl, 'button subtle'));
    const hostReady = hosting?.ready === true || hosting?.configured === true || ['ready', 'active', 'configured', 'verified'].includes(hosting?.status);
    root.append(connectionRow('Website-Hosting', hosting?.message || 'Veröffentlichung auf deiner Website-Adresse', hostReady ? 'Verfügbar' : hosting?.status === 'checking' ? 'Wird geprüft' : 'Einrichtung erforderlich', hostReady));
    const models = state.status?.models;
    if (Array.isArray(models)) for (const model of models) root.append(connectionRow(model.label || model.name || model.provider || model.id || 'Modell', 'Gestaltung und Weiterentwicklung', model.available === false || model.configured === false ? 'Nicht verbunden' : 'Verfügbar', model.available !== false && model.configured !== false));
    else if (models && typeof models === 'object') for (const [key, model] of Object.entries(models)) { const enabled = model === true || model?.available === true || model?.configured === true; root.append(connectionRow(key, 'Gestaltung und Weiterentwicklung', enabled ? 'Verfügbar' : 'Nicht verbunden', enabled)); }
    $('githubTokenForm').hidden = Boolean(github?.connectUrl && safeLink(github.connectUrl));
  }
  async function refreshStatus() {
    try { state.status = await request(`${API}/status`); renderConnections();
      const models = state.status?.models;
      for (const option of $('modelSelect').options) { if (option.value === 'auto') continue; const details = Array.isArray(models) ? models.find(model => [model.id, model.provider, model.key].includes(option.value)) : models?.[option.value]; option.disabled = details === false || details?.available === false || details?.configured === false; }
      if ($('modelSelect').selectedOptions[0]?.disabled) $('modelSelect').value = 'auto';
    } catch (error) { $('connectionStatus').replaceChildren(element('p', 'muted', error.message)); }
  }
  function renderDomain(domain = state.site?.domain, publication = state.site?.publication) {
    const root = $('domainContent'); root.replaceChildren();
    root.append(element('p', 'muted', 'Verknüpfe deine eigene Domain mit dieser Website. Du kannst den bisherigen Domain-Anbieter behalten.'));
    if (publication?.url) root.append(externalLink('Veröffentlichte Website öffnen ↗', publication.url));
    if (domain?.hostname) root.append(element('div', 'domain-current', `${domain.hostname} · ${domain.status === 'active' ? 'verbunden' : domain.status === 'awaiting_dns' ? 'wartet auf DNS-Eintrag' : 'Einrichtung läuft'}`));
    if (domain?.message || domain?.error) root.append(element('p', 'field-note', domain.message || domain.error));
    const records = Array.isArray(domain?.dns) ? domain.dns : domain?.recordValue || domain?.target ? [{ type: domain.recordType || domain.type || 'CNAME', name: domain.recordName || domain.hostname || '@', value: domain.recordValue || domain.target }] : [];
    for (const record of records) { const row = element('div', 'domain-record'); for (const [label, value] of [['Typ', record.type], ['Name', record.name], ['Wert', record.value]]) row.append(element('b', '', label), element('code', '', value || '')); root.append(row); }
    const form = element('form'); const label = element('label', '', 'Deine Domain'); const input = element('input'); input.name = 'hostname'; input.required = true; input.maxLength = 253; input.placeholder = 'www.goalsandconcepts.de'; input.autocomplete = 'url'; input.value = domain?.hostname || ''; label.append(input);
    const feedback = element('div', 'form-feedback'); feedback.setAttribute('role', 'status'); const actions = element('div', 'dialog-actions'); const submit = button('Domain einrichten', 'button primary'); submit.type = 'submit'; const check = button('Verbindung prüfen'); check.disabled = !domain?.hostname;
    actions.append(check, submit); form.append(label, element('p', 'field-note', 'IVA bereitet die Verbindung vor. Die nötigen DNS-Einträge zeigt sie dir hier an.'), feedback, actions); root.append(form);
    const captured = $('domainDialog')._scope || scope();
    form.addEventListener('submit', event => { event.preventDefault(); formAction(form, async () => { if (!isCurrent(captured)) return; const result = await request(sitePath(captured, '/domain'), { method: 'POST', body: { projectId: captured.projectId, hostname: input.value.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '') } }); if (!isCurrent(captured)) return; renderDomain(result.domain || result); await refreshSite(captured); }); });
    check.addEventListener('click', () => formAction(form, async () => { if (!isCurrent(captured)) return; check.disabled = true; try { const result = await request(sitePath(captured, '/domain')); if (isCurrent(captured)) renderDomain(result.domain || result); } finally { check.disabled = false; } }));
  }
  function showPane(pane) { document.querySelector('.workspace').dataset.pane = pane; for (const button of document.querySelectorAll('[data-pane]')) { if (button.tagName !== 'BUTTON') continue; button.classList.toggle('active', button.dataset.pane === pane); button.setAttribute('aria-pressed', String(button.dataset.pane === pane)); } }
  function prefill(message) { $('chatInput').value = message; saveDraft(); updateControls(); showPane('chat'); $('chatInput').focus(); }
  async function boot() {
    $('assistantStatus').textContent = 'Projekte werden geladen …';
    try {
      const projects = await request(`${API}/projects`); state.projects = asArray(projects, 'projects');
      const params = new URLSearchParams(location.search); const requested = params.get('projectId'); const selected = state.projects.find(project => project.id === requested)?.id || state.projectId || state.projects[0]?.id || '';
      fillProjects($('projectSelect'), selected); await selectProject(selected, params.get('siteId') || '');
      await refreshStatus();
    } catch (error) { $('assistantStatus').textContent = 'Verbindung erforderlich'; toast(error.message, true); }
    updateControls();
  }
  $('projectSelect').addEventListener('change', event => selectProject(event.target.value));
  $('siteSelect').addEventListener('change', event => selectSite(event.target.value));
  $('newSite').addEventListener('click', () => openNewSite());
  $('emptyStart').addEventListener('click', () => { if (state.site) { showPane('chat'); $('chatInput').focus(); } else openNewSite(); });
  $('chatInput').addEventListener('input', () => { saveDraft(); updateControls(); });
  $('chatInput').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('chatForm').requestSubmit(); } });
  $('chatForm').addEventListener('submit', submitChat);
  for (const node of document.querySelectorAll('[data-prompt]')) node.addEventListener('click', () => prefill(node.dataset.prompt));
  for (const node of document.querySelectorAll('[data-close]')) node.addEventListener('click', () => node.closest('dialog').close());
  for (const node of document.querySelectorAll('button[data-pane]')) node.addEventListener('click', () => showPane(node.dataset.pane));
  for (const node of document.querySelectorAll('[data-device]')) if (node.tagName === 'BUTTON') node.addEventListener('click', () => { $('previewCanvas').dataset.device = node.dataset.device; for (const choice of document.querySelectorAll('button[data-device]')) { choice.classList.toggle('active', choice === node); choice.setAttribute('aria-pressed', String(choice === node)); } });
  for (const node of document.querySelectorAll('[data-import]')) node.addEventListener('click', () => updateImportKind(node.dataset.import));
  $('introImport').addEventListener('click', openImport); $('importButton').addEventListener('click', openImport);
  $('historyButton').addEventListener('click', openHistory); $('githubButton').addEventListener('click', openGitHub); $('publishButton').addEventListener('click', openPublish);
  $('refreshPreview').addEventListener('click', () => loadPreview(state.previewRevision || state.site?.draftRevisionId, { force: true }));
  $('previewTab').addEventListener('click', () => { if (state.site?.draftRevisionId) loadPreview(state.site.draftRevisionId); });
  for (const id of ['domainButton', 'footerDomain']) $(id).addEventListener('click', () => { if (state.site) { openDialog('domainDialog'); renderDomain(); } });
  for (const id of ['connectionSettings', 'githubConnect']) $(id).addEventListener('click', () => { $('githubDialog').close(); openDialog('connectionsDialog'); refreshStatus(); });
  $('newSiteForm').addEventListener('submit', event => { event.preventDefault(); formAction(event.currentTarget, async () => {
    const original = $('newSiteDialog')._scope; const projectId = $('newSiteProject').value; if (!projectId) throw new Error('Lege zuerst ein IVA-Projekt an.');
    const sourceUrl = $('newSiteUrl').value.trim(); const result = await request(`${API}/sites`, { method: 'POST', body: { projectId, name: $('newSiteName').value.trim(), ...(sourceUrl ? { sourceUrl } : {}) } }); const site = result.site || result;
    if (!isCurrent(original)) { toast('Die Website wurde in deinem gewählten Projekt angelegt.'); return; }
    $('newSiteDialog').close(); await selectProject(projectId, site.id);
    if (state.projectId !== projectId || state.siteId !== site.id) return;
    if (sourceUrl) { const captured = scope(); try { const imported = await request(sitePath(captured, '/import'), { method: 'POST', body: { projectId, kind: 'url', url: sourceUrl } }); await refreshAfterAction(captured, imported, 'import'); toast('Deine Website wurde angelegt. Der Import wurde gestartet.'); } catch (error) { toast(`Website angelegt. Der Import konnte noch nicht abgeschlossen werden: ${error.message}`, true); } }
    else { toast('Deine Website ist bereit. Beschreibe IVA deine Idee.'); $('chatInput').focus(); }
  }); });
  $('importForm').addEventListener('submit', event => { event.preventDefault(); formAction(event.currentTarget, async () => {
    const captured = $('importDialog')._scope; if (!isCurrent(captured)) return;
    let result;
    if (state.importKind === 'zip') { const file = $('importZip').files[0]; if (!file) throw new Error('Wähle bitte deinen ZIP-Export aus.'); if (file.size > 25 * 1024 * 1024) throw new Error('Der ZIP-Export darf höchstens 25 MiB groß sein.'); result = await request(sitePath(captured, '/import-zip'), { method: 'POST', body: file, raw: true, contentType: 'application/zip' }); }
    else result = await request(sitePath(captured, '/import'), { method: 'POST', body: { projectId: captured.projectId, kind: state.importKind, ...(state.importKind === 'url' ? { url: $('importUrl').value.trim() } : { repository: $('importRepository').value.trim() }) } });
    if (!isCurrent(captured)) return; $('importDialog').close(); state.previewRevision = ''; state.previewKey = ''; await refreshAfterAction(captured, result, 'import'); toast(activeJobs.has(result.status || result.job?.status) ? 'Dein Import läuft im Hintergrund.' : 'Website importiert. Die Vorschau wird aktualisiert.'); $('importZip').value = '';
  }); });
  $('githubForm').addEventListener('submit', event => { event.preventDefault(); formAction(event.currentTarget, async () => { const captured = $('githubDialog')._scope; if (!isCurrent(captured)) return; const result = await request(sitePath(captured, '/github'), { method: 'POST', body: { projectId: captured.projectId, name: $('repositoryName').value.trim() } }); if (!isCurrent(captured)) return; await refreshAfterAction(captured, result, 'github'); $('githubDialog').close(); toast(activeJobs.has(result.status || result.job?.status) ? 'Die GitHub-Sicherung wurde gestartet.' : 'Deine Website wurde in GitHub gesichert.'); }); });
  $('publishForm').addEventListener('submit', event => { event.preventDefault(); formAction(event.currentTarget, async () => { const dialog = $('publishDialog'); const captured = dialog._scope; if (!isCurrent(captured)) return; const result = await request(sitePath(captured, '/publish'), { method: 'POST', body: { projectId: captured.projectId, revisionId: dialog._revisionId } }); if (!isCurrent(captured)) return; await refreshAfterAction(captured, result, 'publish'); dialog.close(); const publication = result.publication || result; toast(['active', 'live', 'published'].includes(publication.status) ? 'Deine Website ist veröffentlicht.' : 'Veröffentlichung vorbereitet. Den Status siehst du unter der Vorschau.'); }); });
  $('githubTokenForm').addEventListener('submit', event => { event.preventDefault(); formAction(event.currentTarget, async () => { const githubToken = $('githubToken').value.trim(); if (!githubToken) throw new Error('Gib deinen GitHub-Zugang ein.'); $('githubToken').value = ''; await request(`${API}/connections`, { method: 'POST', body: { githubToken } }); await refreshStatus(); toast('GitHub-Zugang wurde hinterlegt.'); }); });
  $('connectionsDialog').addEventListener('close', () => { $('githubToken').value = ''; });
  $('authForm').addEventListener('submit', event => { event.preventDefault(); formAction(event.currentTarget, async () => { const access = $('authToken').value.trim(); if (!access) return; try { localStorage.setItem('iva_token', access); } catch { throw new Error('Dein Browser lässt das Speichern des IVA-Zugangs nicht zu.'); } $('authToken').value = ''; await request(`${API}/projects`); $('authDialog').close(); await boot(); }); });
  $('exportButton').addEventListener('click', async () => { if (!state.site) return; const captured = scope(); const name = state.site.name; $('exportButton').disabled = true; try { const blob = await request(sitePath(captured, '/export'), { blob: true }); const url = URL.createObjectURL(blob); const link = element('a'); link.href = url; link.download = `${name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'website'}.zip`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000); toast('Dein Website-Export wurde heruntergeladen.'); } catch (error) { toast(error.message, true); } finally { updateControls(); } });
  $('addMedia').addEventListener('click', () => { $('mediaFile')._scope = scope(); $('mediaFile').click(); });
  $('mediaFile').addEventListener('change', async () => { const file = $('mediaFile').files[0]; const captured = $('mediaFile')._scope; $('mediaFile').value = ''; if (!file || !isCurrent(captured)) return; if (file.size > 3 * 1024 * 1024) { toast('Einzelne Bilder, Videos, Schrift- und 3D-Dateien dürfen höchstens 3 MiB groß sein.', true); return; } state.actionBusy = true; updateControls(); try { const result = await request(sitePath(captured, '/assets', { name: file.name }), { method: 'POST', body: file, raw: true, contentType: file.type || 'application/octet-stream' }); if (!isCurrent(captured)) return; state.previewRevision = ''; state.previewKey = ''; await refreshAfterAction(captured, result, 'asset'); toast('Die Datei ist in deiner Website hinterlegt. Sag IVA, wo sie erscheinen soll.'); } catch (error) { if (isCurrent(captured)) toast(error.message, true); } finally { if (isCurrent(captured)) { state.actionBusy = false; updateControls(); } } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.siteId) refreshSite().catch(error => toast(error.message, true)); });
  boot();
})();
