import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { accessSync, constants as fsConstants } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(process.env.IVA_DEVICE_WORKSPACE || path.join(path.dirname(MODULE_PATH), '..'));
const TASK_ROOT = process.env.IVA_CODEX_TASK_ROOT || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper', 'codex-tasks');
const MAX_PROMPT_LENGTH = 12_000;
const MAX_RUNTIME_MS = 3 * 60 * 60_000;
const BUILD_PHASES = Object.freeze({
  planning: 10,
  implementing: 30,
  testing: 50,
  committing: 65,
  pushing: 75,
  deploying: 88,
  live_verification: 96,
  completed: 100,
});
const CODEX_CANDIDATES = Object.freeze([
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  '/Applications/Codex.app/Contents/Resources/codex',
]);

function clean(value, max = 500) {
  return String(value || '').replace(/\u0000/g, '').trim().slice(0, max);
}

function safeJobId(value) {
  const jobId = clean(value, 80);
  if (!/^[a-f0-9-]{20,80}$/i.test(jobId)) throw new Error('Ungültige Codex-Auftrags-ID.');
  return jobId;
}

function jobPaths(jobId) {
  const id = safeJobId(jobId);
  const directory = path.join(TASK_ROOT, id);
  return {
    directory,
    request: path.join(directory, 'request.json'),
    state: path.join(directory, 'state.json'),
    log: path.join(directory, 'codex.log'),
    lastMessage: path.join(directory, 'result.txt'),
  };
}

function codexBinary() {
  for (const candidate of CODEX_CANDIDATES) {
    try { accessSync(candidate, fsConstants.X_OK); return candidate; } catch {}
  }
  throw new Error('Codex CLI wurde auf diesem Mac nicht gefunden.');
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeState(paths, value) {
  await writeFile(paths.state, JSON.stringify(value, null, 2));
  return value;
}

async function reportTaskState(request, state, resultPreview = '') {
  try {
    const { reportOperationalRun, reportProjectWorkflowRun } = await import('./device-agent.mjs');
    const terminal = ['completed', 'failed', 'blocked', 'timed_out', 'incomplete'].includes(state.status);
    const operational = {
      externalKey: `codex-task:${request.jobId}`,
      jobId: request.jobId,
      agentId: request.mode === 'project-workflow' ? 'iva-operations' : 'iva-builder',
      agentName: request.title,
      taskTitle: request.title,
      routeReason: request.mode === 'project-workflow' ? 'project-workflow' : 'explicit-build-order',
      channel: request.mode === 'project-workflow' ? 'project-workflow' : 'codex-build',
      source: 'iMac · Codex',
      projectId: request.projectId || '',
      workflowId: request.workflowId || '',
      requestPreview: request.title,
      status: state.status,
      phase: state.phase,
      progress: state.progress,
      detail: state.detail,
      resultPreview: resultPreview || state.detail,
      error: state.error || (['failed', 'blocked', 'timed_out', 'incomplete'].includes(state.status) ? state.detail : ''),
      startedAt: state.startedAt || request.createdAt,
      completedAt: terminal ? state.completedAt || state.updatedAt : '',
      updatedAt: state.updatedAt,
    };
    await reportOperationalRun(operational);
    if (terminal && request.mode === 'project-workflow' && request.workflowId) {
      await reportProjectWorkflowRun({
        runId: `codex-${request.jobId}`,
        workflowId: request.workflowId,
        workflowName: request.workflowName || request.title,
        status: state.status,
        startedAt: state.startedAt || request.createdAt,
        completedAt: terminal ? state.completedAt || state.updatedAt : state.updatedAt,
        summary: resultPreview || state.detail || 'Lokaler Projekt-Workflow läuft.',
        error: operational.error,
        metrics: { jobId: request.jobId, phase: state.phase, progress: state.progress },
      });
    }
  } catch (error) {
    // Der lokale Zustand bleibt die Quelle für spätere Statusabfragen. Ein
    // vorübergehend nicht erreichbarer Server darf den eigentlichen Lauf nie
    // abbrechen oder fälschlich als fehlgeschlagen markieren.
    console.error(`Kontrollzentrum-Meldung fehlgeschlagen: ${clean(error.message, 300)}`);
  }
}

function buildCodexPrompt(request) {
  if (request.mode === 'project-workflow') {
    return `Nadine hat diesen Projekt-Workflow in IVA ausdrücklich über den Button „Manuell auslösen“ gestartet. Führe jetzt genau einen operativen Einmallauf aus, ohne eine weitere Planbestätigung zu verlangen.

Arbeite ausschließlich im bereits gesetzten IVA-Core-Workspace und lies AGENTS.md vollständig. Dies ist kein Bauauftrag: ändere keinen Quellcode, erstelle keinen Commit, pushe und deploye nichts. Führe nur den unten genannten Workflow mit seinen dokumentierten Quellen, Sicherheitsregeln, Verifikationen, Zeitlimits, Protokollen und Rückfallwegen aus. Normale erneute Anmeldungen erledigst du mit den vorhandenen sicheren Zugangsdaten selbstständig. Bei CAPTCHA, Kontosperre, technisch erzwungener externer Bestätigung oder einem fachlichen Sicherheits-Gate stoppst du mit dem konkreten Blocker. Erfinde keinen Erfolg.

Manueller Einmallauf:
${request.prompt}

${request.acceptanceCriteria?.length ? `Abnahmekriterien:\n${request.acceptanceCriteria.map(item => `- ${item}`).join('\n')}` : ''}`.trim();
  }
  const progressCommand = phase => `node local-mac-helper/codex-tasks.mjs progress ${request.jobId} ${phase}`;
  return `Nadine hat diesen Auftrag ausdrücklich über ihren IVA-Chat erteilt. Setze ihn jetzt vollständig und eigenständig um, ohne eine weitere Planbestätigung von Nadine zu verlangen.

Arbeite ausschließlich im bereits gesetzten IVA-Core-Workspace. Lies und befolge AGENTS.md vollständig. Bewahre fremde und nicht zum Auftrag gehörende Änderungen. Fertig bedeutet gemäß Projektregel: implementieren, angemessen testen, Fehler beheben, nur die eigenen Änderungen committen, pushen, Railway deployen und die öffentliche Live-URL prüfen. Falls ein echter externer Blocker besteht, dokumentiere ihn konkret im Endergebnis; erfinde keinen Erfolg.

Melde Nadine im IVA-Kontrollzentrum ausschließlich tatsächlich begonnene Meilensteine. Führe dafür jeweils beim Start des Schritts genau den passenden lokalen Befehl aus:
- Planung: ${progressCommand('planning')}
- Umsetzung: ${progressCommand('implementing')}
- Tests: ${progressCommand('testing')}
- Commit: ${progressCommand('committing')}
- Push: ${progressCommand('pushing')}
- Railway-Deploy: ${progressCommand('deploying')}
- öffentliche Live-Prüfung: ${progressCommand('live_verification')}
- erst nach erfolgreicher Live-Prüfung: ${progressCommand('completed')}
Bei einem echten Blocker: node local-mac-helper/codex-tasks.mjs progress ${request.jobId} blocked "kurzer konkreter Grund". Überspringe keine Anzeige vorab und melde niemals einen noch nicht begonnenen Schritt.

Auftrag:
${request.prompt}

${request.acceptanceCriteria?.length ? `Abnahmekriterien:\n${request.acceptanceCriteria.map(item => `- ${item}`).join('\n')}` : ''}`.trim();
}

export function codexTaskPolicy() {
  return Object.freeze({
    workspace: REPO_ROOT,
    taskStateDirectory: TASK_ROOT,
    taskStateWritableForCodex: true,
    arbitraryWorkspace: false,
    sandbox: 'workspace-write',
    automaticApprovalReview: true,
    maxPromptLength: MAX_PROMPT_LENGTH,
    maxRuntimeMs: MAX_RUNTIME_MS,
  });
}

export async function startCodexTask({ prompt, title = '', requestId = '', acceptanceCriteria = [], mode = 'build', projectId = '', workflowId = '', workflowName = '' } = {}) {
  const cleanPrompt = clean(prompt, MAX_PROMPT_LENGTH);
  if (cleanPrompt.length < 10) throw new Error('Der Codex-Bauauftrag ist zu kurz.');
  const jobId = crypto.randomUUID();
  const paths = jobPaths(jobId);
  await mkdir(paths.directory, { recursive: true });
  const request = {
    jobId,
    title: clean(title, 180) || 'IVA-Bauauftrag',
    requestId: clean(requestId, 100),
    prompt: cleanPrompt,
    acceptanceCriteria: (Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []).map(value => clean(value, 500)).filter(Boolean).slice(0, 12),
    mode: mode === 'project-workflow' ? 'project-workflow' : 'build',
    projectId: clean(projectId, 100),
    workflowId: clean(workflowId, 140),
    workflowName: clean(workflowName, 220),
    workspace: REPO_ROOT,
    createdAt: new Date().toISOString(),
  };
  await writeFile(paths.request, JSON.stringify(request, null, 2));
  const initialState = await writeState(paths, { jobId, title: request.title, requestId: request.requestId, mode: request.mode, projectId: request.projectId, workflowId: request.workflowId, status: 'queued', phase: request.mode === 'build' ? 'planning' : 'queued', progress: request.mode === 'build' ? 5 : 0, detail: 'Auftrag wartet auf den lokalen Codex-Start.', createdAt: request.createdAt, updatedAt: request.createdAt, workspace: REPO_ROOT });
  await reportTaskState(request, initialState);
  const childEnv = { ...process.env };
  delete childEnv.IVA_MAC_WAKE_GUARD_ACTIVE;
  const child = spawn(process.execPath, [MODULE_PATH, 'run', jobId], { detached: true, stdio: 'ignore', env: childEnv });
  child.unref();
  return { jobId, status: 'queued', title: request.title, workspace: 'iva-core', startedLocally: true };
}

const PROJECT_WORKFLOW_TASKS = Object.freeze({
  'funding-monitor': Object.freeze({
    title: 'Fördermonitor manuell ausführen',
    prompt: 'Führe den bestehenden lokalen Fördermonitor jetzt genau einmal im fest gesperrten Review-only-Modus aus. Verwende die vorhandenen lokalen Module und Zustände, versende keine E-Mail, verändere Pipedrive nicht und lege ausschließlich nachvollziehbare Prüffälle für neue eindeutig erkannte Eingänge an. Beachte Lock, Idempotenz, Audit und die vorhandenen Sicherheitsregeln.',
    acceptanceCriteria: ['Der Lauf bleibt review-only, versendet nichts und verändert Pipedrive nicht.', 'Neue Eingänge werden dedupliziert und nachvollziehbar in die Prüfliste übernommen.', 'Laufergebnis oder konkreter technischer Blocker ist im Audit festgehalten.'],
  }),
  'planbar-weekly-export': Object.freeze({
    title: 'Planbar-Forecast manuell ausführen',
    prompt: 'Lies PLANBAR_FORECAST_WORKFLOW.md vollständig und führe den dort beschriebenen Forecast jetzt genau einmal für den aktuell vorgesehenen rollierenden Zehn-Wochen-Zeitraum aus. Die unmittelbar folgende Kalenderwoche bleibt ausgelassen. Erzeuge ausschließlich die geprüfte Gesamt-XLSX und die nichtleeren Hersteller-XLSX sowie manifest.json beziehungsweise xlsx-manifest.json und qa.json im aktuellen Laufordner. David Service, Dawid Service sowie Antonio Lausic, Lausich und Lausitsch sind harte Ausschlüsse. Versende niemals über Finder-, Spotlight- oder Outlook-Dateisuche und füge keine Anlage manuell nach einem Suchtreffer hinzu. Rufe nach vollständiger Tabellen-QA ausschließlich `node local-mac-helper/planbar-forecast-mail.mjs "<absoluter Laufordner>" --commit` auf. Dieser Sender akzeptiert nur die exakten vollständigen XLSX-Pfade aus dem geprüften Manifest, vergleicht Absender, Empfänger, Betreff und alle Anlagennamen erneut, verbietet PDFs und prüft danach den nativen Outlook-Ordner „Gesendet“. Wenn Outlook den Versand bereits bestätigt, die Gesendet-Prüfung aber noch nicht sichtbar ist, niemals erneut senden; dann ausschließlich den vorhandenen Versand anhand des Sendelogs und in „Gesendet“ nachprüfen.',
    acceptanceCriteria: ['David/Dawid Service und Antonio Lausic/Lausich/Lausitsch sind vollständig ausgeschlossen.', 'Alle Anhänge stammen exakt aus dem geprüften Manifest, sind XLSX-Dateien und keine PDF ist enthalten.', 'Empfänger, Zeitraum, Anhänge und native Outlook-Gesendet-Prüfung sind im Sendelog protokolliert.', 'Ein fehlgeschlagener Nachweis nach bestätigtem Senden löst niemals einen Doppelversand aus.'],
  }),
  'planbar-completion-morning': Object.freeze({
    title: 'Planbar-Vervollständigung manuell ausführen',
    prompt: 'Lies PLANBAR_VERVOLLSTAENDIGUNG_WORKFLOW.md vollständig und führe den dort beschriebenen Morgenworkflow jetzt genau einmal außerplanmäßig aus. Verarbeite nur die dort erlaubten Eingänge, ändere nur die ausdrücklich freigegebenen leeren beziehungsweise eindeutig belegten Zielfelder und verifiziere jede Speicherung sichtbar. Beachte Laufzeitlimit, Idempotenz, Bericht und Display-Regel.',
    acceptanceCriteria: ['Kein Termin wird angelegt, gelöscht, verschoben oder einer anderen Ressource zugeordnet.', 'Pipedrive und HH-Beispiele bleiben rein lesend.', 'Jede Änderung oder jeder Blocker wird im vorgesehenen Ergebnisbericht dokumentiert.'],
  }),
  'montage-required-fields-morning': Object.freeze({
    title: 'Montage-Pflichtfelder manuell prüfen',
    prompt: 'Führe den in AGENTS.md und in der Heat-Hero-Projektautomation „Montage-Pflichtfelder morgens prüfen“ beschriebenen Ablauf jetzt genau einmal aus. Prüfe alle offenen Deals in „Montage terminieren“: Telefonnummer und E-Mail gegen die TMB sowie die Anlage gegen das unterschriebene Angebot. Ergänze ausschließlich eindeutig belegte leere Felder, überschreibe keine bestehenden Widersprüche und verifiziere jeden Schreibschritt sichtbar. Melde unklare Fälle statt zu raten.',
    acceptanceCriteria: ['Nur eindeutig belegte leere Pflichtfelder werden ergänzt.', 'Bestehende Werte und Widersprüche werden nicht still überschrieben.', 'Ergebnis, Änderungen und manuelle Prüffälle werden protokolliert.'],
  }),
});

export async function startProjectWorkflowTask({ workflowId, findPreparedForecast, sendPreparedForecast } = {}) {
  const normalizedWorkflowId = clean(workflowId, 140);
  const definition = PROJECT_WORKFLOW_TASKS[normalizedWorkflowId];
  if (!definition) throw new Error('Dieser Projekt-Workflow ist für den operativen Codex-Start nicht freigegeben.');
  if (normalizedWorkflowId === 'planbar-weekly-export') {
    const mail = typeof findPreparedForecast === 'function' && typeof sendPreparedForecast === 'function'
      ? null
      : await import('./planbar-forecast-mail.mjs');
    const findPrepared = typeof findPreparedForecast === 'function' ? findPreparedForecast : mail.findRecentValidatedPlanbarForecastRun;
    const sendPrepared = typeof sendPreparedForecast === 'function'
      ? sendPreparedForecast
      : directory => mail.sendPlanbarForecastRun(directory, { commit: true });
    const prepared = await findPrepared();
    if (prepared) return sendPrepared(prepared.directory);
  }
  return startCodexTask({
    ...definition,
    mode: 'project-workflow',
    projectId: 'heat-hero',
    workflowId: normalizedWorkflowId,
    workflowName: definition.title,
    requestId: `project-workflow-${normalizedWorkflowId}-${Date.now()}`,
  });
}

export async function startPlanbarCustomerSchedulingTask(input = {}) {
  const customerName = clean(input.customerName, 220).replace(/\s+/g, ' ');
  const partnerName = clean(input.partnerName, 80).replace(/\s+/g, ' ');
  const partnerPrefix = clean(input.partnerPrefix, 6).toUpperCase();
  const schedulingMode = input.schedulingMode === 'enter-block-first' ? 'enter-block-first' : 'free-resource';
  const allowFreeResourceFallback = schedulingMode === 'enter-block-first' && input.allowFreeResourceFallback === true;
  const isoYear = Number(input.isoYear);
  const week = Number(input.week);
  if (!customerName || !partnerName || !/^[A-Z0-9]{1,6}$/.test(partnerPrefix) || !Number.isInteger(isoYear) || !Number.isInteger(week)) {
    throw new Error('Kundenname, Partner, Planbar-Kürzel, ISO-Jahr oder Kalenderwoche fehlen für die Planbar-Terminierung.');
  }
  const materialDeliverySpace = input.materialDeliverySpace === true ? 'Ja' : 'Nein';
  const theftWeatherProtected = input.theftWeatherProtected === true ? 'Ja' : 'Nein';
  const additionalInfo = clean(input.additionalInfo, 2000);
  const prompt = `Lies KUNDE_TERMINIEREN_WORKFLOW.md und PLANBAR_VERVOLLSTAENDIGUNG_WORKFLOW.md vollständig und führe den Workflow „Kunde terminieren“ jetzt genau einmal aus.

Auftrag:
- Kunde: ${customerName}
- Partner/Kundentyp: ${partnerName}
- Verbindliches Planbar-Präfix vor dem Vornamen: ${partnerPrefix}
- ISO-Kalenderwoche: KW ${week}/${isoYear}
- Materialannahme einige Tage vor Montagebeginn: ${materialDeliverySpace}
- Diebstahl- und wettersicher: ${theftWeatherProtected}${additionalInfo ? `\n- Zusatzinfo: ${additionalInfo}` : ''}

Der IVA-Auftrag ist die ausdrückliche Freigabe für die in KUNDE_TERMINIEREN_WORKFLOW.md eng beschriebenen Planbar- und Pipedrive-Schritte; verlange keine weitere Bestätigung. ${schedulingMode === 'enter-block-first' ? `Dieser Partner verwendet ENTER-Blöcke: Ersetze vorrangig den ersten zulässigen vollständigen Block mit dem exakten Text „Geblockt für Kunde ENTER“. ${allowFreeResourceFallback ? 'Nur wenn kein solcher Block vorhanden ist, darf ersatzweise die erste Ressource verwendet werden, die Montag bis Freitag vollständig frei ist.' : 'Ist kein solcher Block vorhanden, bleibt Planbar unverändert; eine freie Ressource darf nicht ersatzweise verwendet werden.'}` : 'Verwende ausschließlich die erste zulässige Ressource, die von Montag bis Freitag vollständig frei ist.'} Schließe Dawid/David Service sowie Antonio Lausic und alle dokumentierten Schreibvarianten aus. Erst nach sichtbar verifizierter Planbar-Anlage sende über die native WhatsApp-App genau einmal „${customerName}, KW ${week}“ in die Gruppe „Terminierungen Dispo“ innerhalb der Community „Heat Hero GmbH“. Bei nicht eindeutig unterscheidbarer gleichnamiger Gruppe wird nichts gesendet. Keine Web-Version von WhatsApp verwenden.`;
  return startCodexTask({
    prompt,
    title: `Planbar: ${partnerName}-Kunde ${customerName} in KW ${week}/${isoYear} terminieren`,
    requestId: `planbar-schedule-${isoYear}-${week}-${Date.now()}`,
    mode: 'project-workflow',
    acceptanceCriteria: [
      'Der Kunde und der Deal sind eindeutig sowie Angebot und Beschreibung vollständig belegt.',
      schedulingMode === 'enter-block-first'
        ? `Ein vollständiger ENTER-Block wurde ersetzt${allowFreeResourceFallback ? ' oder nach belegtem Fehlen ein ausdrücklich erlaubter vollständig freier Fünf-Tage-Platz verwendet' : ''}.`
        : 'Die verwendete Ressource ist Montag bis Freitag vollständig frei und gehört zu keiner ausgeschlossenen Ressource.',
      `Der Planbar-Vorname trägt genau einmal das Präfix ${partnerPrefix}.`,
      'Die Planbar-Anlage ist nach dem Speichern sichtbar verifiziert.',
      'Erst danach ist genau eine WhatsApp-Nachricht in der exakten Community-Gruppe sichtbar versendet und verifiziert.',
      'Bei einem fachlichen oder technischen Blocker bleibt Planbar unverändert und es wird keine WhatsApp-Nachricht gesendet.',
    ],
  });
}

export async function getCodexTaskStatus(jobId) {
  const paths = jobPaths(jobId);
  const state = await readJson(paths.state);
  let resultPreview = '';
  if (['completed', 'failed', 'blocked', 'timed_out', 'incomplete'].includes(state.status)) {
    resultPreview = clean(await readFile(paths.lastMessage, 'utf8').catch(() => ''), 1800);
  }
  return { ...state, resultPreview };
}

export async function updateCodexTaskProgress(jobId, phase, detail = '') {
  const paths = jobPaths(jobId);
  const state = await readJson(paths.state);
  const request = await readJson(paths.request).catch(() => null);
  const nextPhase = clean(phase, 60);
  const isBlocked = nextPhase === 'blocked';
  if (!isBlocked && !Object.hasOwn(BUILD_PHASES, nextPhase)) throw new Error('Unbekannter IVA-Baumeilenstein.');
  const currentProgress = Number(state.progress) || 0;
  const nextProgress = isBlocked ? currentProgress : nextPhase === 'completed' ? 99 : BUILD_PHASES[nextPhase];
  if (!isBlocked && nextProgress < currentProgress) throw new Error('Ein abgeschlossener Baumeilenstein kann nicht zurückgesetzt werden.');
  const updated = await writeState(paths, {
    ...state,
    status: isBlocked ? 'blocked' : 'running',
    phase: isBlocked ? (state.phase || 'planning') : nextPhase,
    progress: nextProgress,
    detail: clean(detail, 1000) || (isBlocked ? 'Der Bauauftrag ist blockiert.' : `${nextPhase} wurde begonnen.`),
    error: isBlocked ? clean(detail, 1000) : '',
    updatedAt: new Date().toISOString(),
  });
  if (request) await reportTaskState(request, updated);
  return updated;
}

export function inferProjectWorkflowStatus(lastMessage = '') {
  const text = String(lastMessage || '');
  return /(?:^|\n)\s*Status\s*:\s*(?:\*\*)?\s*(?:(?:fachlich|technisch)\s+)?blockiert\b/i.test(text)
    ? 'blocked'
    : '';
}

async function runCodexTaskWithoutWakeGuard(jobId) {
  const paths = jobPaths(jobId);
  const request = await readJson(paths.request);
  const startedAt = new Date().toISOString();
  const runningState = await writeState(paths, { jobId, title: request.title, requestId: request.requestId, mode: request.mode, projectId: request.projectId, workflowId: request.workflowId, status: 'running', phase: request.mode === 'build' ? 'planning' : 'running', progress: request.mode === 'build' ? 10 : 5, detail: request.mode === 'build' ? 'Planung wurde begonnen.' : 'Workflow wurde gestartet.', createdAt: request.createdAt, startedAt, updatedAt: startedAt, workspace: REPO_ROOT });
  await reportTaskState(request, runningState);
  const logHandle = await open(paths.log, 'a');
  const command = codexBinary();
  const args = [
    'exec', '--approve-for-me', '--add-dir', paths.directory,
    '-C', REPO_ROOT, '--output-last-message', paths.lastMessage,
    buildCodexPrompt(request),
  ];
  const child = spawn(command, args, { cwd: REPO_ROOT, stdio: ['ignore', logHandle.fd, logHandle.fd] });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, MAX_RUNTIME_MS);
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve(code));
  }).catch(async error => {
    await writeFile(paths.lastMessage, `Codex konnte nicht gestartet werden: ${error.message}`);
    return -1;
  });
  clearTimeout(timer);
  await logHandle.close();
  const completedAt = new Date().toISOString();
  const current = await readJson(paths.state).catch(() => ({}));
  const resultPreview = clean(await readFile(paths.lastMessage, 'utf8').catch(() => ''), 1800);
  const inferredWorkflowStatus = request.mode === 'project-workflow'
    ? inferProjectWorkflowStatus(resultPreview)
    : '';
  const status = timedOut
    ? 'timed_out'
    : current.status === 'blocked' || inferredWorkflowStatus === 'blocked'
      ? 'blocked'
      : exitCode !== 0
        ? 'failed'
        : request.mode === 'build' && current.phase !== 'completed'
          ? 'incomplete'
          : 'completed';
  const finalProgress = status === 'completed' ? 100 : Number(current.progress) || 0;
  const finalState = await writeState(paths, {
    ...current,
    jobId, title: request.title, requestId: request.requestId, status,
    phase: status === 'completed' ? 'completed' : current.phase,
    progress: finalProgress,
    detail: status === 'incomplete'
      ? 'Codex endete, bevor alle Pflichtschritte einschließlich Live-Prüfung bestätigt waren.'
      : inferredWorkflowStatus === 'blocked' && current.status !== 'blocked'
        ? 'Der Workflow endete mit einem fachlichen oder technischen Blocker. Details stehen im Ergebnis.'
        : current.detail,
    error: inferredWorkflowStatus === 'blocked' && current.status !== 'blocked'
      ? 'Der Workflow endete mit einem fachlichen oder technischen Blocker.'
      : current.error,
    createdAt: request.createdAt, startedAt, completedAt, exitCode,
    updatedAt: completedAt, workspace: REPO_ROOT,
  });
  await reportTaskState(request, finalState, resultPreview);
  return finalState;
}

export async function runCodexTask(jobId) {
  const { withMacWakeGuard } = await import('./mac-wake-guard.mjs');
  return withMacWakeGuard(() => runCodexTaskWithoutWakeGuard(jobId), {
    maxSeconds: Math.ceil(MAX_RUNTIME_MS / 1000) + 60,
    sleepDisplays: true,
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url && process.argv[2] === 'progress') {
  try { await updateCodexTaskProgress(process.argv[3], process.argv[4], process.argv.slice(5).join(' ')); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
} else if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url && process.argv[2] === 'run') {
  try { await runCodexTask(process.argv[3]); }
  catch (error) {
    const paths = jobPaths(process.argv[3]);
    await writeFile(paths.lastMessage, `Codex-Auftrag fehlgeschlagen: ${error.message}`).catch(() => {});
    await writeState(paths, { jobId: process.argv[3], status: 'failed', completedAt: new Date().toISOString(), error: clean(error.message, 1000) }).catch(() => {});
    process.exitCode = 1;
  }
}
