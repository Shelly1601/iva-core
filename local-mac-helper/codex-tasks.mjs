import crypto from 'node:crypto';
import { withImacExecutionLock } from './ui-execution-lock.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { accessSync, constants as fsConstants } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { materializeIcloudWorkspace } from './icloud-workspace.mjs';
import { assertImacFundingHost } from './funding-workflows.mjs';

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

export function codexJobIdForRequest(requestId) {
  if (!requestId) return crypto.randomUUID();
  const bytes = crypto.createHash('sha256').update(String(requestId)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
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
    const isProjectWorkflow = request.mode === 'project-workflow';
    const isOperational = request.mode === 'operational';
    const operational = {
      externalKey: `codex-task:${request.jobId}`,
      jobId: request.jobId,
      agentId: isProjectWorkflow || isOperational ? 'iva-operations' : 'iva-builder',
      agentName: request.title,
      taskTitle: request.title,
      routeReason: isProjectWorkflow ? 'project-workflow' : isOperational ? 'explicit-imac-operation' : 'explicit-build-order',
      channel: isProjectWorkflow ? 'project-workflow' : isOperational ? 'codex-operational' : 'codex-build',
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
  const runtimeInstruction = `Die verbindlichen Projektanweisungen stehen in ${path.join(REPO_ROOT, '..', 'AGENTS.md')}; lies diese Datei, auch wenn im Unterordner iva-core keine eigene AGENTS.md liegt. Bestehende lokale IVA-Helfer startest du mit absolutem Pfad aus ${path.dirname(MODULE_PATH)}. Dieser geprüfte Laufzeitstand kommt vom zentralen IVA-Core. Projektquellen und Dokumente bleiben im gesetzten iCloud-Workspace. Keine zweite lokale Kopie als laufenden Agenten starten.`;
  if (request.mode === 'project-workflow') {
    return `Nadine hat diesen Projekt-Workflow in IVA ausdrücklich über den Button „Manuell auslösen“ gestartet. Führe jetzt genau einen operativen Einmallauf aus, ohne eine weitere Planbestätigung zu verlangen.

Arbeite ausschließlich im bereits gesetzten IVA-Core-Workspace und lies AGENTS.md vollständig. ${runtimeInstruction} Dies ist kein Bauauftrag: ändere keinen Quellcode, erstelle keinen Commit, pushe und deploye nichts. Führe nur den unten genannten Workflow mit seinen dokumentierten Quellen, Sicherheitsregeln, Verifikationen, Zeitlimits, Protokollen und Rückfallwegen aus. Normale erneute Anmeldungen erledigst du mit den vorhandenen sicheren Zugangsdaten selbstständig. Bei CAPTCHA, Kontosperre, technisch erzwungener externer Bestätigung oder einem fachlichen Sicherheits-Gate stoppst du mit dem konkreten Blocker. Erfinde keinen Erfolg.

Manueller Einmallauf:
${request.prompt}

${request.acceptanceCriteria?.length ? `Abnahmekriterien:\n${request.acceptanceCriteria.map(item => `- ${item}`).join('\n')}` : ''}`.trim();
  }
  if (request.mode === 'operational') {
    return `Nadine hat diese konkrete Aktion ausdrücklich zur Ausführung auf ihrem iMac beauftragt. Führe sie jetzt genau dort aus, ohne eine weitere Planbestätigung zu verlangen.

Arbeite ausschließlich im bereits gesetzten IVA-Core-Workspace und lies AGENTS.md vollständig. ${runtimeInstruction} Dies ist ein operativer iMac-Auftrag und kein IVA-Bauauftrag: Ändere keinen Quellcode, erstelle keinen Commit, pushe und deploye nichts, außer der Auftrag verlangt selbst ausdrücklich eine Code- oder Systemänderung. Versende keine E-Mail und führe keine andere externe Kommunikation aus, sofern sie im Auftrag nicht eindeutig freigegeben ist. Verwende bei lokalen WhatsApp-Aufträgen ausschließlich die native WhatsApp-App. Wiederhole eine Aktion niemals allein deshalb, weil der Erfolgsnachweis verzögert oder uneindeutig ist.

Der autoritative Arbeitsordner liegt in iCloud. Bei „Resource deadlock avoided“, EAGAIN, EDEADLK oder kurzzeitig nicht lesbaren Dateien stößt du zuerst den lokalen iCloud-Download an und wiederholst den lesenden Zugriff; behandle das nicht vorschnell als fehlende Datei. Melde ausschließlich das tatsächlich verifizierte Ergebnis oder einen konkreten Blocker und erfinde keinen Erfolg.

Beende den Ergebnisbericht mit einer eigenen Zeile „Status: erfolgreich“ nur nach tatsächlicher Prüfung des Ergebnisses, sonst „Status: blockiert“ und dem konkreten Grund.

Operativer Auftrag:
${request.prompt}

${request.acceptanceCriteria?.length ? `Abnahmekriterien:\n${request.acceptanceCriteria.map(item => `- ${item}`).join('\n')}` : ''}`.trim();
  }
  const progressCommand = phase => `node ${JSON.stringify(MODULE_PATH)} progress ${request.jobId} ${phase}`;
  return `Nadine hat diesen Auftrag ausdrücklich über ihren IVA-Chat erteilt. Setze ihn jetzt vollständig und eigenständig um, ohne eine weitere Planbestätigung von Nadine zu verlangen.

Arbeite ausschließlich im bereits gesetzten IVA-Core-Workspace. Lies und befolge AGENTS.md vollständig. ${runtimeInstruction} Bewahre fremde und nicht zum Auftrag gehörende Änderungen. Fertig bedeutet gemäß Projektregel: implementieren, angemessen testen, Fehler beheben, nur die eigenen Änderungen committen, pushen, Railway deployen und die öffentliche Live-URL prüfen. Falls ein echter externer Blocker besteht, dokumentiere ihn konkret im Endergebnis; erfinde keinen Erfolg.

Melde Nadine im IVA-Kontrollzentrum ausschließlich tatsächlich begonnene Meilensteine. Führe dafür jeweils beim Start des Schritts genau den passenden lokalen Befehl aus:
- Planung: ${progressCommand('planning')}
- Umsetzung: ${progressCommand('implementing')}
- Tests: ${progressCommand('testing')}
- Commit: ${progressCommand('committing')}
- Push: ${progressCommand('pushing')}
- Railway-Deploy: ${progressCommand('deploying')}
- öffentliche Live-Prüfung: ${progressCommand('live_verification')}
- erst nach erfolgreicher Live-Prüfung: ${progressCommand('completed')}
Bei einem echten Blocker: ${progressCommand('blocked')} "kurzer konkreter Grund". Überspringe keine Anzeige vorab und melde niemals einen noch nicht begonnenen Schritt.

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
    iCloudMaterialization: true,
  });
}

export async function startCodexTask({ prompt, title = '', requestId = '', acceptanceCriteria = [], mode = 'build', projectId = '', workflowId = '', workflowName = '' } = {}) {
  const cleanPrompt = clean(prompt, MAX_PROMPT_LENGTH);
  if (cleanPrompt.length < 10) throw new Error('Der Codex-Auftrag ist zu kurz.');
  const workspaceReadiness = await materializeIcloudWorkspace({ workspace: REPO_ROOT });
  const normalizedMode = ['project-workflow', 'operational'].includes(mode) ? mode : 'build';
  const jobId = codexJobIdForRequest(requestId);
  const paths = jobPaths(jobId);
  const existing = await readJson(paths.state).catch(() => null);
  if (existing) return { jobId, status: existing.status, title: existing.title, workspace: 'iva-core', startedLocally: true, duplicate: true };
  await mkdir(paths.directory, { recursive: true });
  const request = {
    jobId,
    title: clean(title, 180) || 'IVA-Bauauftrag',
    requestId: clean(requestId, 100),
    prompt: cleanPrompt,
    acceptanceCriteria: (Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []).map(value => clean(value, 500)).filter(Boolean).slice(0, 12),
    mode: normalizedMode,
    projectId: clean(projectId, 100),
    workflowId: clean(workflowId, 140),
    workflowName: clean(workflowName, 220),
    workspace: REPO_ROOT,
    workspaceReadiness: {
      iCloud: workspaceReadiness.iCloud,
      materialized: workspaceReadiness.materialized,
      checkedFiles: workspaceReadiness.probes?.length || 0,
    },
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
  'funding-daily-sequence': Object.freeze({
    title: 'Förderung – Tageslauf 1 → 2 → 3',
    prompt: 'Lies FUNDING_WORKFLOWS.md vollständig und führe den dort beschriebenen Tageslauf exakt in der Reihenfolge „Förderung 1 – Vollständigkeit & Unterlagen“ → „Förderung 2 – Förderhöhe prüfen“ → „Förderung 3 – KfW-Zusagen prüfen“ aus. Arbeite ausschließlich auf diesem iMac. Prüfe beim ersten produktiven Lauf alle relevanten Deals, bereits vorhandenen Deal-Dateien und zuordenbaren Fördermails, danach inkrementell plus tägliche Offenfall- und 7-Tage-Reaktionsprüfung. Prüfe die Google-Liste vor vollständigen Deal-Folgeaktionen auf genau eine Spalte Kundename/Name, Datum und Bemerkung; schreibe bei fehlender oder mehrdeutiger Überschrift keinesfalls in eine Ersatzspalte. Kunden- und interne Eskalationsmails bleiben ausnahmslos Outlook-Entwürfe und werden nicht versandt. Die ausdrücklich vorgesehenen echten Folgeaktionen bei eindeutig vollständigen Deals – verifizierte Pipedrive-Felder/Phasen, native WhatsApp an Viktoria, deduplizierter Eintrag in die Google-Tabelle und Verschieben vollständig in Pipedrive verarbeiteter Fördermails in Outlook nach „fertig“ – sind freigegeben. Unklare oder unvollständig verarbeitete Mails bleiben im Eingang. In Fachsystemen nichts löschen. Nach verifiziertem Korrektur-Upload darfst du ausschließlich die exakt zugehörigen Dateien im verwalteten lokalen IVA-Förderordner endgültig entfernen; leere nie den gesamten Benutzer-Papierkorb. Beende den Lauf mit einem kurzen Deal-für-Deal-Bericht; Geheimnisse und Steuerdetails auslassen.',
    acceptanceCriteria: ['Alle drei Workflows laufen in der dokumentierten Reihenfolge und nie parallel.', 'Der Lauf wurde durch die iMac-Hostprüfung zugelassen; MacBook und iPhone waren nur Fernsteuerung.', 'Kunden- und Eskalationsmails sind ausschließlich Entwürfe; kein Mailversand und keine Löschung in Fachsystemen.', 'Bereits vorhandene Deal-Dateien wurden auf PDF-Format, Standardbezeichnung, Lesbarkeit und Vollständigkeit geprüft.', 'Jede Pipedrive-, WhatsApp-, Tabellen- und Mailverschiebeaktion ist eindeutig zugeordnet, dedupliziert und nach der Aktion verifiziert.', 'Nur vollständig in Pipedrive verarbeitete Fördermails wurden nach „fertig“ verschoben.', 'Nach sieben vollen Tagen ohne Antwort wurde EKD intern an Kati, alles andere an Patrick als echter Weiterleitungsentwurf vorbereitet.', 'Lokale Löschung traf ausschließlich verifiziert ersetzte IVA-Arbeitskopien; fremde Papierkorb-Inhalte blieben erhalten.', 'Der Abschluss enthält je Deal die tatsächlich ausgeführten Änderungen oder den konkreten offenen Punkt.'],
  }),
  'funding-monitor': Object.freeze({
    title: 'Förderung 1 – Vollständigkeit & Unterlagen',
    prompt: 'Lies FUNDING_WORKFLOWS.md vollständig und führe ausschließlich „Förderung 1 – Vollständigkeit & Unterlagen“ genau einmal auf diesem iMac aus. Prüfe auch bereits im Deal vorhandene Dateien und die 7-Tage-Reaktionsfrist. Kunden- und interne Eskalationsmails bleiben Entwürfe; alle dort ausdrücklich genannten, eindeutig belegten Pipedrive-, native-WhatsApp-, Tabellen- und Mailverschiebeaktionen nach „fertig“ sind freigegeben. Unvollständig verarbeitete Mails bleiben im Eingang. In Fachsystemen nichts löschen; nur verifiziert ersetzte lokale IVA-Arbeitskopien im verwalteten Förderordner dürfen endgültig entfernt werden, niemals der gesamte Benutzer-Papierkorb. Berichte jede Dealaktion oder den konkreten Blocker.',
    acceptanceCriteria: ['Angebot-veröffentlicht-Deals, offene Förderunterlagen, bestehende Deal-Dateien und neue Fördermails sind vollständig geprüft.', 'Nur eindeutig belegte leere Felder und erlaubte Vorwärtsphasen wurden gespeichert und erneut gelesen.', 'Kunden- und 7-Tage-Eskalationsmails sind Entwürfe; WhatsApp und Tabelle folgen nur nach verifizierter Vollständigkeit und genau einmal.', 'Nur vollständig verarbeitete Fördermails wurden verifiziert nach „fertig“ verschoben.', 'Nur verifiziert ersetzte lokale IVA-Arbeitskopien wurden entfernt; in Fachsystemen und im fremden Papierkorb wurde nichts gelöscht.'],
  }),
  'kfw-funding-amount-morning': Object.freeze({
    title: 'Förderung 2 – Förderhöhe prüfen',
    prompt: 'Lies FUNDING_WORKFLOWS.md vollständig und führe ausschließlich „Förderung 2 – Förderhöhe prüfen“ genau einmal auf diesem iMac aus. Prüfe immer die vollständige Dealakte und verwende den versionierten KfW-Rechenkern mit dem zum Antragsdatum passenden offiziellen Regelstand. Offene Kundenfragen nur als Outlook-Entwurf an Kunde mit VP im CC. Nichts löschen.',
    acceptanceCriteria: ['Keine Förderzahl ohne belegte Gebäude-/Wohneinheitenstruktur, Antragsdatum und Kostenquelle.', 'MFH-Berechnungen verwenden die korrekte Kostenstaffel und beginnen in der Notiz mit dem Eurobetrag.', 'Notizen haben das Wichtigste zuerst und enden mit (Notiz von Nadine via KI).', 'Kundenmails sind nur Entwürfe; nichts wurde gelöscht.'],
  }),
  'kfw-approval-morning': Object.freeze({
    title: 'Förderung 3 – KfW-Zusagen prüfen',
    prompt: 'Lies FUNDING_WORKFLOWS.md vollständig und führe ausschließlich „Förderung 3 – KfW-Zusagen prüfen“ genau einmal auf diesem iMac aus. Setze nur Deals mit eindeutig zugeordnetem offiziellen KfW-Zusageschreiben aus Förderung beantragt auf Gewonnen, bestätige das Speichern und verifiziere den Übergang zu Montage einplanen. Nichts löschen.',
    acceptanceCriteria: ['Jeder Statuswechsel besitzt genau eine offizielle eindeutig zugeordnete KfW-Zusage als Beleg.', 'Gewonnen und der Übergang nach Montage einplanen sind nach dem Speichern erneut gelesen.', 'Unklare Fälle bleiben unverändert und werden konkret gemeldet.', 'Nichts wurde gelöscht.'],
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
  if (['funding-daily-sequence', 'funding-monitor', 'kfw-funding-amount-morning', 'kfw-approval-morning'].includes(normalizedWorkflowId)) {
    assertImacFundingHost();
  }
  if (normalizedWorkflowId === 'funding-daily-sequence') {
    const berlinDay = value => new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(value));
    const today = berlinDay(Date.now());
    const entries = await readdir(TASK_ROOT, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const paths = jobPaths(entry.name);
      const request = await readJson(paths.request).catch(() => null);
      if (request?.mode !== 'project-workflow' || request?.workflowId !== normalizedWorkflowId || berlinDay(request.createdAt) !== today) continue;
      const state = await readJson(paths.state).catch(() => null);
      if (state && ['queued', 'running', 'completed'].includes(state.status)) {
        return { jobId: request.jobId, status: state.status, title: request.title, workspace: 'iva-core', startedLocally: state.status !== 'completed', deduplicated: true };
      }
    }
  }
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
    '--add-dir', path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper'),
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
  const resultText = await readFile(paths.lastMessage, 'utf8').catch(() => '');
  const resultPreview = clean(resultText, 1800);
  const inferredWorkflowStatus = request.mode !== 'build'
    ? inferProjectWorkflowStatus(resultText)
    : '';
  const status = timedOut
    ? 'timed_out'
    : current.status === 'blocked' || inferredWorkflowStatus === 'blocked'
      ? 'blocked'
      : exitCode !== 0
        ? 'failed'
        : (request.mode === 'build' && current.phase !== 'completed') || (request.mode === 'operational' && !/(?:^|\n)\s*Status\s*:\s*(?:\*\*)?erfolgreich\b/i.test(resultText))
          ? 'incomplete'
          : 'completed';
  const finalProgress = status === 'completed' ? 100 : Number(current.progress) || 0;
  const finalState = await writeState(paths, {
    ...current,
    jobId, title: request.title, requestId: request.requestId, status,
    phase: status === 'completed' ? 'completed' : current.phase,
    progress: finalProgress,
    detail: status === 'incomplete'
      ? (request.mode === 'build' ? 'Codex endete, bevor alle Pflichtschritte einschließlich Live-Prüfung bestätigt waren.' : 'Der operative Lauf endete ohne bestätigten Ergebnisnachweis.')
      : inferredWorkflowStatus === 'blocked' && current.status !== 'blocked'
        ? 'Der Workflow endete mit einem fachlichen oder technischen Blocker. Details stehen im Ergebnis.'
        : status === 'completed' ? 'Auftrag abgeschlossen; Ergebnisprüfung liegt vor.' : current.detail,
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
  return withImacExecutionLock(() => withMacWakeGuard(() => runCodexTaskWithoutWakeGuard(jobId), {
    maxSeconds: Math.ceil(MAX_RUNTIME_MS / 1000) + 60,
    sleepDisplays: true,
  }));
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
