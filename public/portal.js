/* The customer portal uses only an HttpOnly server session. No administrator token or password is stored in the browser. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { session: null, projectId: '', invitation: '', busy: false, epoch: 0 };
  const roles = { viewer: 'Ansehen', editor: 'Gestalten', publisher: 'Gestalten & veröffentlichen' };
  const el = (tag, className = '', text) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = String(text); return node; };
  const projects = () => Array.isArray(state.session?.projects) ? state.session.projects : [];
  async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(`/api/portal${path}`, { method, credentials: 'same-origin', cache: 'no-store', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    let result; try { result = await response.json(); } catch { result = {}; }
    if (!response.ok) throw Object.assign(new Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || 'Das hat noch nicht geklappt. Bitte versuche es erneut.'), { status: response.status });
    return result;
  }
  let toastTimer;
  function toast(text) { $('portalToast').textContent = text; $('portalToast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('portalToast').hidden = true; }, 6000); }
  function showLogin() {
    $('portalLoading').hidden = true; $('portalShell').hidden = true; $('authLayout').hidden = false;
    const invited = Boolean(state.invitation); $('emailField').hidden = invited; $('portalEmail').required = !invited;
    $('authEyebrow').textContent = invited ? 'Du bist eingeladen' : 'Schön, dass du da bist'; $('authTitle').textContent = invited ? 'Dein Projekt wartet auf dich.' : 'Willkommen zurück.';
    $('authDescription').textContent = invited ? 'Richte deinen persönlichen Zugang ein, um das freigegebene Projekt zu öffnen.' : 'Melde dich an, um deine Projekte zu öffnen.';
    $('loginSubmit').textContent = invited ? 'Einladung annehmen →' : 'Arbeitsbereich öffnen →'; $('portalPassword').autocomplete = invited ? 'new-password' : 'current-password'; $('portalPassword').minLength = invited ? 12 : 1;
    $('invitePasswordNote').hidden = !invited; $('cancelInvitation').hidden = !invited; $('authHelp').hidden = invited;
  }
  function renderProjectList() {
    $('portalProjectList').replaceChildren();
    for (const project of projects()) {
      const button = el('button', `portal-project${project.projectId === state.projectId ? ' active' : ''}`); button.type = 'button'; button.setAttribute('aria-current', project.projectId === state.projectId ? 'page' : 'false');
      const copy = el('span', 'project-copy'); copy.append(el('b', '', project.name || 'Projekt'), el('small', '', roles[project.role] || roles.viewer));
      button.append(el('span', 'project-avatar', String(project.name || 'P').slice(0, 1).toUpperCase()), copy, el('span', 'project-arrow', '›'));
      button.addEventListener('click', () => { state.projectId = project.projectId; history.replaceState({}, '', `/portal?projectId=${encodeURIComponent(project.projectId)}`); render(); }); $('portalProjectList').append(button);
    }
  }
  function render() {
    $('portalLoading').hidden = true; $('authLayout').hidden = true; $('portalShell').hidden = false;
    $('portalUserEmail').textContent = state.session?.user?.email || '';
    const project = projects().find(item => item.projectId === state.projectId) || projects()[0]; state.projectId = project?.projectId || ''; renderProjectList();
    const content = $('portalContent'); content.replaceChildren();
    if (!project) {
      const empty = el('section', 'portal-empty'); empty.append(el('span', '', '◇'), el('h2', '', 'Dein nächstes Projekt kommt hierhin.'), el('p', '', 'Aktuell ist kein Projekt für diesen Zugang freigegeben. Die Person, die dein Projekt betreut, kann dir einen Einladungslink senden.'));
      const refresh = el('button', 'button subtle', 'Freigaben aktualisieren'); refresh.type = 'button'; refresh.addEventListener('click', () => refreshSession().catch(error => toast(error.message))); empty.append(refresh); content.append(empty); return;
    }
    const heading = el('header', 'portal-project-heading'); const copy = el('div'); copy.append(el('span', 'eyebrow', 'Dein Projekt'), el('h1', '', project.name || 'Projekt'), el('p', '', project.role === 'viewer' ? 'Hier kannst du die freigegebenen Entwürfe und Website-Versionen ansehen.' : 'Deine Ideen, eure nächsten Schritte. Öffne einen Bereich und arbeite direkt weiter.'));
    heading.append(copy, el('span', 'role-badge', roles[project.role] || roles.viewer)); content.append(heading);
    const grid = el('div', 'portal-module-grid'); const modules = Array.isArray(project.modules) ? project.modules : [];
    if (modules.includes('websites')) {
      const card = el('section', 'portal-module'); card.append(el('span', 'module-symbol', '▱'), el('h2', '', 'Website Studio'), el('p', '', project.role === 'viewer' ? 'Sieh dir die aktuelle Website an und entdecke frühere Versionen in der Vorschau.' : 'Beschreibe deine nächste Idee im Chat und sieh rechts, wie deine Website daraus entsteht.'));
      const foot = el('div', 'module-foot'); foot.append(el('small', '', project.role === 'viewer' ? 'Entwürfe & Vorschau' : `Bis zu ${Number.isFinite(Number(project.dailyBuildLimit)) ? Number(project.dailyBuildLimit) : 10} KI-Aufträge pro Tag`));
      const link = el('a', 'button primary', project.role === 'viewer' ? 'Website ansehen ↗' : 'Website gestalten ↗'); link.href = `/website-studio?external=1&projectId=${encodeURIComponent(project.projectId)}`; foot.append(link); card.append(foot); grid.append(card);
    }
    if (!grid.children.length) { const empty = el('section', 'portal-empty'); empty.append(el('span', '', '◇'), el('h2', '', 'Ein guter Anfang ist vorbereitet.'), el('p', '', 'Für dieses Projekt ist im Kundenportal noch kein Bereich freigegeben. Deine Projektbetreuung kann die passenden Bereiche ergänzen.')); content.append(empty); }
    else content.append(grid);
    const note = el('div', 'portal-info-note'); note.append(el('span', '', '↗'), el('p', '', project.role === 'publisher' ? 'Änderungen werden zuerst als Entwurf gespeichert. Du entscheidest im Website Studio, wann ein Stand veröffentlicht wird.' : project.role === 'editor' ? 'Änderungen werden zuerst als Entwurf gespeichert. Die Veröffentlichung übernimmt eure Projektbetreuung.' : 'Dein Zugang ist zum Ansehen freigegeben. Wenn du selbst gestalten möchtest, wende dich an eure Projektbetreuung.')); content.append(note);
  }
  async function refreshSession() {
    const epoch = state.epoch;
    try { const result = await api('/session'); if (epoch !== state.epoch) return; state.session = result; render(); }
    catch (error) { if (epoch !== state.epoch) return; if (error.status === 401) { state.session = null; showLogin(); } else throw error; }
  }
  $('portalLogin').addEventListener('submit', async event => {
    event.preventDefault(); if (state.busy) return; state.busy = true; $('loginSubmit').disabled = true; $('authFeedback').textContent = '';
    const epoch = ++state.epoch; const password = $('portalPassword').value; $('portalPassword').value = ''; $('portalPassword').type = 'password'; $('showPassword').textContent = 'Anzeigen';
    try { await api(state.invitation ? '/accept' : '/login', { method: 'POST', body: state.invitation ? { token: state.invitation, password } : { email: $('portalEmail').value.trim(), password } }); if (epoch !== state.epoch) return; state.invitation = ''; await refreshSession(); }
    catch (error) { if (epoch === state.epoch) $('authFeedback').textContent = error.message; }
    finally { if (epoch === state.epoch) { state.busy = false; $('loginSubmit').disabled = false; } }
  });
  $('portalLogout').addEventListener('click', async () => { if (state.busy) return; state.busy = true; $('portalLogout').disabled = true; const epoch = ++state.epoch; try { await api('/logout', { method: 'POST' }); if (epoch !== state.epoch) return; state.session = null; state.projectId = ''; state.invitation = ''; $('portalContent').replaceChildren(); $('portalProjectList').replaceChildren(); $('portalUserEmail').textContent = ''; $('portalEmail').value = ''; history.replaceState({}, '', '/portal'); showLogin(); } catch (error) { toast(error.message); } finally { if (epoch === state.epoch) { state.busy = false; $('portalLogout').disabled = false; } } });
  $('showPassword').addEventListener('click', () => { const reveal = $('portalPassword').type === 'password'; $('portalPassword').type = reveal ? 'text' : 'password'; $('showPassword').textContent = reveal ? 'Verbergen' : 'Anzeigen'; $('showPassword').setAttribute('aria-label', reveal ? 'Passwort verbergen' : 'Passwort anzeigen'); });
  $('cancelInvitation').addEventListener('click', () => { if (state.busy) return; state.invitation = ''; $('portalPassword').value = ''; $('authFeedback').textContent = ''; showLogin(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.session && !state.busy) refreshSession().catch(error => toast(error.message)); });
  window.addEventListener('pagehide', () => { $('portalPassword').value = ''; });
  const params = new URLSearchParams(location.search); state.projectId = params.get('projectId') || '';
  const fragment = location.hash.slice(1); const invite = new URLSearchParams(fragment); const candidate = invite.get('invite') || invite.get('token') || (/^[A-Za-z0-9_-]{24,2048}$/.test(fragment) ? fragment : '');
  if (candidate) { state.invitation = candidate; history.replaceState({}, '', '/portal'); showLogin(); }
  else refreshSession().catch(error => { showLogin(); $('authFeedback').textContent = error.message; });
})();
