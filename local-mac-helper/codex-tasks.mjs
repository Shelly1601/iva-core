import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { accessSync, constants as fsConstants } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(MODULE_PATH), '..');
const TASK_ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper', 'codex-tasks');
const MAX_PROMPT_LENGTH = 12_000;
const MAX_RUNTIME_MS = 3 * 60 * 60_000;
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

function buildCodexPrompt(request) {
  if (request.mode === 'project-workflow') {
    return `Nadine hat diesen Projekt-Workflow in IVA ausdrücklich über den Button „Manuell auslösen“ gestartet. Führe jetzt genau einen operativen Einmallauf aus, ohne eine weitere Planbestätigung zu verlangen.

Arbeite ausschließlich im bereits gesetzten IVA-Core-Workspace und lies AGENTS.md vollständig. Dies ist kein Bauauftrag: ändere keinen Quellcode, erstelle keinen Commit, pushe und deploye nichts. Führe nur den unten genannten Workflow mit seinen dokumentierten Quellen, Sicherheitsregeln, Verifikationen, Zeitlimits, Protokollen und Rückfallwegen aus. Normale erneute Anmeldungen erledigst du mit den vorhandenen sicheren Zugangsdaten selbstständig. Bei CAPTCHA, Kontosperre, technisch erzwungener externer Bestätigung oder einem fachlichen Sicherheits-Gate stoppst du mit dem konkreten Blocker. Erfinde keinen Erfolg.

Manueller Einmallauf:
${request.prompt}

${request.acceptanceCriteria?.length ? `Abnahmekriterien:\n${request.acceptanceCriteria.map(item => `- ${item}`).join('\n')}` : ''}`.trim();
  }
  return `Nadine hat diesen Auftrag ausdrücklich über ihren IVA-Chat erteilt. Setze ihn jetzt vollständig und eigenständig um, ohne eine weitere Planbestätigung von Nadine zu verlangen.

Arbeite ausschließlich im bereits gesetzten IVA-Core-Workspace. Lies und befolge AGENTS.md vollständig. Bewahre fremde und nicht zum Auftrag gehörende Änderungen. Fertig bedeutet gemäß Projektregel: implementieren, angemessen testen, Fehler beheben, nur die eigenen Änderungen committen, pushen, Railway deployen und die öffentliche Live-URL prüfen. Falls ein echter externer Blocker besteht, dokumentiere ihn konkret im Endergebnis; erfinde keinen Erfolg.

Auftrag:
${request.prompt}

${request.acceptanceCriteria?.length ? `Abnahmekriterien:\n${request.acceptanceCriteria.map(item => `- ${item}`).join('\n')}` : ''}`.trim();
}

export function codexTaskPolicy() {
  return Object.freeze({
    workspace: REPO_ROOT,
    arbitraryWorkspace: false,
    sandbox: 'workspace-write',
    automaticApprovalReview: true,
    maxPromptLength: MAX_PROMPT_LENGTH,
    maxRuntimeMs: MAX_RUNTIME_MS,
  });
}

export async function startCodexTask({ prompt, title = '', requestId = '', acceptanceCriteria = [], mode = 'build' } = {}) {
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
    workspace: REPO_ROOT,
    createdAt: new Date().toISOString(),
  };
  await writeFile(paths.request, JSON.stringify(request, null, 2));
  await writeState(paths, { jobId, title: request.title, requestId: request.requestId, status: 'queued', createdAt: request.createdAt, workspace: REPO_ROOT });
  const child = spawn(process.execPath, [MODULE_PATH, 'run', jobId], { detached: true, stdio: 'ignore' });
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
    prompt: 'Lies PLANBAR_FORECAST_WORKFLOW.md vollständig und führe den dort beschriebenen Forecast jetzt genau einmal für den aktuell vorgesehenen rollierenden Zehn-Wochen-Zeitraum aus. Die unmittelbar folgende Kalenderwoche bleibt ausgelassen. Erzeuge und versende ausschließlich die geprüfte Gesamt-XLSX und die nichtleeren Hersteller-XLSX; niemals PDFs. Prüfe den Versand sichtbar in Outlook „Gesendet“ und verhindere einen Doppelversand.',
    acceptanceCriteria: ['David Service und Antonio Lausich sind vollständig ausgeschlossen.', 'Alle Anhänge sind geprüfte XLSX-Dateien; keine PDF ist enthalten.', 'Empfänger, Zeitraum, Anhänge und sichtbare Gesendet-Prüfung sind protokolliert.'],
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

export async function startProjectWorkflowTask({ workflowId } = {}) {
  const definition = PROJECT_WORKFLOW_TASKS[clean(workflowId, 140)];
  if (!definition) throw new Error('Dieser Projekt-Workflow ist für den operativen Codex-Start nicht freigegeben.');
  return startCodexTask({
    ...definition,
    mode: 'project-workflow',
    requestId: `project-workflow-${workflowId}-${Date.now()}`,
  });
}

export async function getCodexTaskStatus(jobId) {
  const paths = jobPaths(jobId);
  const state = await readJson(paths.state);
  let resultPreview = '';
  if (['completed', 'failed', 'timed_out'].includes(state.status)) {
    resultPreview = clean(await readFile(paths.lastMessage, 'utf8').catch(() => ''), 1800);
  }
  return { ...state, resultPreview };
}

export async function runCodexTask(jobId) {
  const paths = jobPaths(jobId);
  const request = await readJson(paths.request);
  const startedAt = new Date().toISOString();
  await writeState(paths, { jobId, title: request.title, requestId: request.requestId, status: 'running', createdAt: request.createdAt, startedAt, workspace: REPO_ROOT });
  const logHandle = await open(paths.log, 'a');
  const command = codexBinary();
  const args = [
    'exec', '--sandbox', 'workspace-write', '--approve-for-me',
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
  const status = timedOut ? 'timed_out' : exitCode === 0 ? 'completed' : 'failed';
  return writeState(paths, {
    jobId, title: request.title, requestId: request.requestId, status,
    createdAt: request.createdAt, startedAt, completedAt, exitCode,
    workspace: REPO_ROOT,
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url && process.argv[2] === 'run') {
  try { await runCodexTask(process.argv[3]); }
  catch (error) {
    const paths = jobPaths(process.argv[3]);
    await writeFile(paths.lastMessage, `Codex-Auftrag fehlgeschlagen: ${error.message}`).catch(() => {});
    await writeState(paths, { jobId: process.argv[3], status: 'failed', completedAt: new Date().toISOString(), error: clean(error.message, 1000) }).catch(() => {});
    process.exitCode = 1;
  }
}
