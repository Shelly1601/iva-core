import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const dashboardSource = await readFile(new URL('../public/workflow-dashboard.js', import.meta.url), 'utf8');
const context = {};
context.globalThis = context;
vm.runInNewContext(dashboardSource, context, { filename: 'workflow-dashboard.js' });
const { buildWorkflowDashboard, STALE_AFTER_MS } = context.IVAWorkflowDashboard;

const now = Date.parse('2026-09-02T12:00:00.000Z');
const recent = '2026-09-02T11:59:30.000Z';
const stale = new Date(now - STALE_AFTER_MS - 1).toISOString();
const snapshot = {
  generatedAt: recent,
  activity: [
    { id: 'run-live', jobId: 'job-live', name: 'Cockpit bauen', source: 'iMac · Codex', status: 'running', phase: 'testing', progress: 54, summary: 'Tests laufen.', updatedAt: recent },
    { id: 'run-stale', name: 'Alter Lauf', source: 'iMac-Befehl', status: 'running', phase: 'running', progress: 70, summary: 'Seit langem ohne Signal.', updatedAt: stale },
    { id: 'run-queued', name: 'Wartender Lauf', source: 'IVA Core', status: 'queued', summary: 'Eingereiht.', updatedAt: recent },
    { id: 'run-blocked', name: 'Fachlich blockiert', source: 'Railway-Automation', status: 'blocked', error: 'CAPTCHA verlangt externe Bestätigung.', updatedAt: recent },
    { id: 'run-failed', name: 'Technischer Fehler', source: 'Railway-Automation', status: 'failed', error: 'Temporärer Verbindungsfehler.', updatedAt: recent },
    { id: 'run-done', name: 'Erledigter Lauf', source: 'IVA Core', status: 'completed', summary: 'Ergebnis geprüft.', updatedAt: recent },
  ],
  buildProgress: {
    active: [{ id: 'request-live', jobId: 'job-live', title: 'Cockpit bauen', status: 'running', phaseLabel: 'Tests', progress: 54, detail: 'Gezielte Tests laufen.', updatedAt: recent }],
    queued: [], blocked: [], recent: [],
  },
};

const dashboard = buildWorkflowDashboard(snapshot, { now });
assert.equal(dashboard.counts.running, 1, 'Nur frische echte Läufe dürfen als laufend zählen');
assert.equal(dashboard.running[0].title, 'Cockpit bauen');
assert.equal(dashboard.running[0].source, 'iMac · Codex');
assert.equal(dashboard.running[0].phase, 'Tests');
assert.equal(dashboard.running[0].progress, 54);
assert.ok(dashboard.waiting.some(item => item.id === 'run-stale' && item.stale), 'Veraltete Läufe müssen aus „laufend“ entfernt werden');
assert.ok(dashboard.waiting.some(item => item.id === 'run-failed' && item.technicalReview), 'Technische Fehler bleiben eine Prüfung und werden nicht zum fachlichen Blocker');
assert.equal(dashboard.blocked.length, 1, 'Nur ausdrücklich blockierte Läufe gehören in die Blockergruppe');
assert.match(dashboard.blocked[0].blocker, /CAPTCHA/);
assert.equal(dashboard.done.length, 1);
assert.equal(buildWorkflowDashboard({ activity: [{ id: 'no-progress', status: 'running', updatedAt: recent }] }, { now }).running[0].progress, null, 'Ohne gemeldeten Prozentwert darf IVA keinen Fortschritt erfinden');

const cockpit = await readFile(new URL('../public/cockpit.html', import.meta.url), 'utf8');
const controlHtml = await readFile(new URL('../public/control.html', import.meta.url), 'utf8');
const controlJs = await readFile(new URL('../public/control.js', import.meta.url), 'utf8');
const server = await readFile(new URL('../index.js', import.meta.url), 'utf8');

assert.match(cockpit, /Aktuelle Workflows/);
assert.match(cockpit, /id="workflowEntry" href="\/control"/);
assert.match(cockpit, /id="dockWorkflows" href="\/control"/, 'Mobil braucht einen eigenen Workflow-Dockpunkt');
assert.match(cockpit, /\/api\/control\/status/);
assert.match(cockpit, /setInterval\(\(\)=>\{if\(document\.visibilityState==='visible'\)loadWorkflowSummary\(\);\},10000\)/, 'Cockpit-Zahlen müssen automatisch aktualisieren');
for (const id of ['workflowRunning', 'workflowWaiting', 'workflowBlocked', 'workflowDone']) assert.match(controlHtml, new RegExp(`id="${id}"`));
for (const label of ['Laufend', 'Wartend', 'Blockiert', 'Zuletzt erledigt']) assert.match(controlHtml, new RegExp(`>${label}<`));
assert.match(controlHtml, /workflow-dashboard\.js/);
assert.match(controlJs, /Echter Fortschritt/);
assert.match(controlHtml, /Hier siehst du, was IVA gerade macht\./);
assert.match(controlJs, /Konkreter Blocker:/);
assert.match(controlJs, /Technischer Zwischenfehler/);
assert.match(controlJs, /setInterval\(\(\)=>\{ if\(document\.visibilityState==='visible'\)load\(\); \},10000\)/);

const escSource = controlJs.match(/function esc\(value\)\{[^\n]+/)?.[0];
const fmtSource = controlJs.match(/function fmt\(value\)\{[^\n]+/)?.[0];
const workflowCardSource = controlJs.slice(controlJs.indexOf('function workflowCard'), controlJs.indexOf('function renderWorkflowDashboard'));
assert.ok(escSource && fmtSource && workflowCardSource, 'Workflow-Kartenrenderer muss testbar vorhanden sein');
const workflowCard = new Function(`${escSource}\n${fmtSource}\n${workflowCardSource}\nreturn workflowCard;`)();
const attack = '<img src=x onerror="globalThis.pwned=true">';
const rendered = workflowCard({ group: 'blocked', title: attack, source: attack, label: attack, purpose: attack, phase: attack, detail: attack, blocker: attack, progress: '10;position:fixed', updatedAt: recent });
assert.doesNotMatch(rendered, /<img\b/i, 'API-Inhalte dürfen kein HTML einschleusen');
assert.match(rendered, /&lt;img/);
assert.doesNotMatch(rendered, /style="width:10;position/i, 'Fortschrittswerte dürfen kein CSS einschleusen');

const middlewareAt = server.indexOf("app.use('/api'");
const controlRouteAt = server.indexOf("app.get('/api/control/status'");
assert.ok(middlewareAt >= 0 && controlRouteAt > middlewareAt, 'Die Workflow-API muss hinter dem zentralen API_TOKEN-Middleware liegen');
assert.match(server.slice(middlewareAt, controlRouteAt), /process\.env\.API_TOKEN/);
assert.match(controlJs, /Authorization:'Bearer '\+token\(\)/);
assert.match(cockpit, /'Authorization':'Bearer '\+c\.tok/);
assert.doesNotMatch(`${controlJs}\n${cockpit}`, /[?&](?:token|api_token)=/i, 'Token darf nie in einer URL stehen');

console.log('Workflow-Dashboard: Einstieg, Statuslogik, XSS- und API-Sicherheit geprüft.');
