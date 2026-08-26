import crypto from 'node:crypto';
import path from 'node:path';
import { access, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sendVerifiedOutlookXlsxMessage } from './outlook.mjs';

export const PLANBAR_FORECAST_SENDER = 'n.sell@heat-hero.com';
export const PLANBAR_FORECAST_RECIPIENT = 'a.keller@heat-hero.com';

const MODULE_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(process.env.IVA_DEVICE_WORKSPACE || path.join(path.dirname(MODULE_PATH), '..'));
const OUTPUT_ROOT = path.resolve(process.env.IVA_PLANBAR_OUTPUT_ROOT || path.join(REPO_ROOT, 'outputs', 'planbar-weekly'));
const SEND_LOG = path.join(OUTPUT_ROOT, 'send-log.json');
const REQUIRED_EXCLUSIONS = Object.freeze(['David Service', 'Dawid Service', 'Antonio Lausic', 'Antonio Lausich', 'Antonio Lausitsch']);
const EXACT_HEADERS = Object.freeze(['Kalenderwoche', 'Kunde', 'Adresse', 'Anlage']);
const MAX_PREPARED_RUN_AGE_MS = 72 * 60 * 60_000;

function sameStrings(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function periodDetails(value) {
  const match = String(value || '').match(/^KW\s+(\d{1,2})-(\d{1,2})\s*\/\s*(\d{4})$/);
  if (!match) throw new Error('Forecast-Abbruch: Das Manifest enthält keinen eindeutigen KW-Zeitraum.');
  const firstWeek = Number(match[1]);
  const lastWeek = Number(match[2]);
  const year = Number(match[3]);
  if (lastWeek - firstWeek !== 9) throw new Error('Forecast-Abbruch: Der Export muss genau zehn Kalenderwochen enthalten.');
  return { firstWeek, lastWeek, year, period: `KW ${firstWeek}-${lastWeek} / ${year}` };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function existingFile(file) {
  await access(file);
  const info = await stat(file);
  if (!info.isFile() || info.size <= 0) throw new Error(`Forecast-Abbruch: Datei fehlt oder ist leer: ${file}`);
  const handle = await open(file, 'r');
  try {
    const probe = Buffer.alloc(1);
    const { bytesRead } = await handle.read(probe, 0, 1, 0);
    if (bytesRead !== 1) throw new Error(`Forecast-Abbruch: Datei konnte nicht aus iCloud geladen werden: ${file}`);
  } finally {
    await handle.close();
  }
  return file;
}

export async function validatePlanbarForecastRun(runDirectory, { outputRoot = OUTPUT_ROOT } = {}) {
  const allowedRoot = path.resolve(String(outputRoot || OUTPUT_ROOT));
  const directory = path.resolve(String(runDirectory || ''));
  if (!directory.startsWith(`${allowedRoot}${path.sep}`)) {
    throw new Error('Forecast-Abbruch: Der Laufordner liegt nicht im verbindlichen Planbar-Ausgabebereich.');
  }
  const manifestFile = await access(path.join(directory, 'xlsx-manifest.json'))
    .then(() => path.join(directory, 'xlsx-manifest.json'))
    .catch(() => path.join(directory, 'manifest.json'));
  const [manifest, qa, names] = await Promise.all([
    readJson(manifestFile),
    readJson(path.join(directory, 'qa.json')),
    readdir(directory),
  ]);
  const period = periodDetails(manifest.period);
  if (!Array.isArray(manifest.files) || manifest.files.length < 2) {
    throw new Error('Forecast-Abbruch: Gesamt- und Herstellerdateien fehlen im Manifest.');
  }
  if (manifest.files.filter(item => item.label === 'Gesamtliste').length !== 1) {
    throw new Error('Forecast-Abbruch: Das Manifest muss genau eine Gesamtliste enthalten.');
  }
  const attachments = [];
  for (const item of manifest.files) {
    const filename = path.basename(String(item.file || ''));
    if (!/^Planbar_[A-Za-z0-9ÄÖÜäöüß_-]+_KW\d{1,2}-\d{1,2}_\d{4}\.xlsx$/.test(filename)) {
      throw new Error(`Forecast-Abbruch: Unerwarteter Anlagendateiname: ${filename || 'leer'}`);
    }
    if (Number(item.rows || 0) <= 0) throw new Error(`Forecast-Abbruch: Leere Herstellerdatei im Manifest: ${filename}`);
    attachments.push(await existingFile(path.join(directory, filename)));
  }
  const actualXlsx = names.filter(name => name.toLowerCase().endsWith('.xlsx')).sort();
  const expectedXlsx = attachments.map(file => path.basename(file)).sort();
  if (!sameStrings(actualXlsx, expectedXlsx)) {
    throw new Error('Forecast-Abbruch: Im Laufordner liegen XLSX-Dateien, die nicht exakt zum Manifest gehören.');
  }
  const verification = manifest.verification || {};
  if (verification.readBack !== true || Number(verification.formulaErrors || 0) !== 0) {
    throw new Error('Forecast-Abbruch: XLSX-Wiedereinlesen oder Formelprüfung ist nicht grün.');
  }
  if (!sameStrings(verification.exactHeaders || [], EXACT_HEADERS)) {
    throw new Error('Forecast-Abbruch: Die Excel-Spalten stimmen nicht exakt mit dem Forecast-Schema überein.');
  }
  if (Number(verification.renderedSheets || 0) !== attachments.length || !Array.isArray(qa) || qa.length !== attachments.length) {
    throw new Error('Forecast-Abbruch: Nicht alle Excel-Dateien wurden gerendert und geprüft.');
  }
  if (!REQUIRED_EXCLUSIONS.every(value => (verification.excludedResources || []).includes(value))) {
    throw new Error('Forecast-Abbruch: David/Dawid Service und Antonio Lausic/Lausich/Lausitsch sind nicht vollständig als Ausschlussregeln belegt.');
  }
  if (Number(verification.excludedResourceLeaks || 0) !== 0) {
    throw new Error('Forecast-Abbruch: Eine ausgeschlossene Ressource ist in die Ausgabedateien gelangt.');
  }
  for (const item of qa) {
    if (!sameStrings(item.headers || [], EXACT_HEADERS) || Number(item.excelErrors || 0) !== 0 || !item.renderFile) {
      throw new Error(`Forecast-Abbruch: QA ist nicht grün für ${path.basename(String(item.file || 'unbekannt'))}.`);
    }
    const sourceFilename = path.basename(String(item.file || ''));
    const renderFilename = path.basename(String(item.renderFile || ''));
    if (renderFilename !== sourceFilename.replace(/\.xlsx$/i, '.png')) {
      throw new Error(`Forecast-Abbruch: QA-Vorschaubild passt nicht zur Excel-Datei ${sourceFilename || 'unbekannt'}.`);
    }
    await existingFile(path.join(directory, 'rendered', renderFilename));
  }
  const subject = `Planbar-Listen KW ${period.firstWeek}-${period.lastWeek} / ${period.year}`;
  return {
    directory,
    manifestFile,
    manifest,
    qa,
    ...period,
    subject,
    attachments,
    attachmentNames: expectedXlsx,
    sender: PLANBAR_FORECAST_SENDER,
    recipient: PLANBAR_FORECAST_RECIPIENT,
  };
}

export async function findRecentValidatedPlanbarForecastRun({ outputRoot = OUTPUT_ROOT, now = new Date(), maxAgeMs = MAX_PREPARED_RUN_AGE_MS } = {}) {
  const allowedRoot = path.resolve(String(outputRoot || OUTPUT_ROOT));
  const directories = (await readdir(allowedRoot, { withFileTypes: true }).catch(error => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }))
    .filter(item => item.isDirectory() && /^\d{4}-\d{2}-\d{2}-kw\d{1,2}-\d{1,2}$/i.test(item.name))
    .map(item => item.name)
    .sort((left, right) => right.localeCompare(left));
  if (!directories.length) return null;
  const run = await validatePlanbarForecastRun(path.join(allowedRoot, directories[0]), { outputRoot: allowedRoot });
  const generatedAt = Date.parse(run.manifest.generatedAt || '');
  const reference = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(generatedAt) || !Number.isFinite(reference)) {
    throw new Error('Forecast-Abbruch: Erzeugungs- oder Prüfzeitpunkt des vorbereiteten Laufs ist ungültig.');
  }
  if (generatedAt > reference + 5 * 60_000) throw new Error('Forecast-Abbruch: Der vorbereitete Lauf liegt unerwartet in der Zukunft.');
  if (reference - generatedAt > Number(maxAgeMs || MAX_PREPARED_RUN_AGE_MS)) return null;
  return run;
}

async function loadSendLog() {
  try {
    const value = await readJson(SEND_LOG);
    return { version: 1, entries: Array.isArray(value.entries) ? value.entries : [] };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { version: 1, entries: [] };
  }
}

async function saveSendLog(log) {
  await mkdir(path.dirname(SEND_LOG), { recursive: true, mode: 0o700 });
  const temporary = `${SEND_LOG}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, entries: log.entries.slice(-200) }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, SEND_LOG);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function sendPlanbarForecastRun(runDirectory, { commit = false, send = sendVerifiedOutlookXlsxMessage } = {}) {
  const run = await validatePlanbarForecastRun(runDirectory);
  const log = await loadSendLog();
  const duplicate = log.entries.find(item => item.subject === run.subject && ['sent_verified', 'submitted_unverified'].includes(item.status));
  if (duplicate) {
    throw new Error(`Forecast-Abbruch: Dieser Zeitraum wurde bereits am ${duplicate.sentAt || duplicate.createdAt} an Outlook übergeben.`);
  }
  const preview = {
    period: run.period,
    sender: run.sender,
    recipient: run.recipient,
    subject: run.subject,
    attachmentCount: run.attachments.length,
    attachments: run.attachmentNames,
    excludedResourceLeaks: run.manifest.verification.excludedResourceLeaks,
    sent: false,
  };
  if (!commit) return { ...preview, preview: true };
  const body = `Hallo Angelo,\n\nanbei die Planbar-Listen für ${run.period}.\n\nViele Grüße\nNadine`;
  const result = await send({
    from: run.sender,
    to: [run.recipient],
    subject: run.subject,
    body,
    attachments: run.attachments,
  });
  if (result?.sent !== true) throw new Error('Forecast-Abbruch: Outlook hat den Versand nicht bestätigt.');
  const entry = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    sentAt: new Date().toISOString(),
    period: run.period,
    sender: run.sender,
    recipient: run.recipient,
    subject: run.subject,
    attachments: run.attachmentNames,
    status: result.sentFolderVerified === true ? 'sent_verified' : 'submitted_unverified',
    sentFolderVerified: result.sentFolderVerified === true,
    sentFolderVerificationError: result.sentFolderVerificationError || '',
  };
  log.entries.push(entry);
  await saveSendLog(log);
  return { ...preview, preview: false, sent: true, sentFolderVerified: entry.sentFolderVerified, sendLogEntry: entry, outlook: result };
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
  const directory = process.argv.slice(2).find(value => value && !value.startsWith('--'));
  const commit = process.argv.includes('--commit');
  const result = await sendPlanbarForecastRun(directory, { commit });
  console.log(JSON.stringify(result, null, 2));
  if (commit && result.sentFolderVerified !== true) process.exitCode = 2;
}
