import crypto from 'node:crypto';
import path from 'node:path';
import { access, link, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sendVerifiedOutlookXlsxMessage, verifyOutlookSentMessage } from './outlook.mjs';
import { collectAndBuildPlanbarForecast } from './planbar-forecast.mjs';

export const PLANBAR_FORECAST_SENDER = 'n.sell@heat-hero.com';
export const PLANBAR_FORECAST_RECIPIENT = 'a.keller@heat-hero.com';

const MODULE_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(process.env.IVA_DEVICE_WORKSPACE || path.join(path.dirname(MODULE_PATH), '..'));
const OUTPUT_ROOT = path.resolve(process.env.IVA_PLANBAR_OUTPUT_ROOT || path.join(REPO_ROOT, 'outputs', 'planbar-weekly'));
const SEND_LOG = path.join(OUTPUT_ROOT, 'send-log.json');
const REQUIRED_EXCLUSIONS = Object.freeze(['David Service', 'Dawid Service', 'Antonio Lausic', 'Antonio Lausich', 'Antonio Lausitsch']);
const EXACT_HEADERS = Object.freeze(['Kalenderwoche', 'Kunde', 'Telefon', 'Adresse', 'Anlage']);
const MAX_PREPARED_RUN_AGE_MS = 15 * 60_000;
const MAX_LIVE_SOURCE_AGE_MS = 2 * 60_000;

export function forecastRebuildRequired(reason) {
  return Object.assign(new Error(`PLANBAR_FORECAST_REBUILD_REQUIRED: ${reason} Daten, XLSX und QA im selben Auftrag neu erzeugen und vor Versand erneut abgleichen; es wurde nichts versendet.`), {
    code: 'PLANBAR_FORECAST_REBUILD_REQUIRED', recoverable: true, nextAction: 'rebuild_forecast_same_job',
  });
}

// A complete initial claim is linked atomically before invoking Outlook. It is
// never deleted, so process crashes and trimmed UI history cannot permit resend.
export function createForecastDeliveryLedger({ outputRoot = OUTPUT_ROOT } = {}) {
  const directory = path.join(path.resolve(outputRoot), 'delivery-receipts');
  const filename = key => path.join(directory, crypto.createHash('sha256').update(key).digest('hex') + '.json');
  async function read(key) {
    try { return await readJson(filename(key)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function atomic(entry, exclusive = false) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `${process.pid}-${crypto.randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(entry) + '\n'); await handle.sync(); await handle.close();
      if (exclusive) await link(temporary, filename(entry.deliveryRunKey));
      else await rename(temporary, filename(entry.deliveryRunKey));
      return true;
    } catch (error) { if (exclusive && error.code === 'EEXIST') return false; throw error; }
    finally { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
  }
  return {
    read,
    async claim(entry) { const created = await atomic(entry, true); return { created, entry: created ? entry : await read(entry.deliveryRunKey) }; },
    async save(entry) { const current = await read(entry.deliveryRunKey); if (current?.status === 'sent_verified' && entry.status !== 'sent_verified') return; await atomic(entry); },
    async list() { const names = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; }); return Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => readJson(path.join(directory, name)))); },
  };
}
const deliveryLedger = createForecastDeliveryLedger();
let deliveryQueue = Promise.resolve();

function sameStrings(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function normalizedForecastRow(row = {}) {
  return {
    kalenderwoche: String(row.kalenderwoche || '').trim(),
    kalenderwocheNummer: Number(row.kalenderwocheNummer),
    kunde: String(row.kunde || '').replace(/\s+/g, ' ').trim(),
    telefon: String(row.telefon || 'Nicht angegeben').replace(/\s+/g, ' ').trim(),
    adresse: String(row.adresse || '').replace(/\s+/g, ' ').trim(),
    anlage: String(row.anlage || '').replace(/\s+/g, ' ').trim(),
    hersteller: String(row.hersteller || '').replace(/\s+/g, ' ').trim(),
    sourceId: String(row.sourceId || '').trim(),
  };
}

function forecastRowKey(row) {
  return [row.sourceId, row.kalenderwocheNummer, row.kalenderwoche, row.kunde, row.telefon, row.adresse, row.anlage, row.hersteller].join('|');
}

export function assertPlanbarForecastRowsCurrent(exportRows, currentRows) {
  const expected = (Array.isArray(exportRows) ? exportRows : []).map(normalizedForecastRow).sort((a, b) => forecastRowKey(a).localeCompare(forecastRowKey(b), 'de'));
  const current = (Array.isArray(currentRows) ? currentRows : []).map(normalizedForecastRow).sort((a, b) => forecastRowKey(a).localeCompare(forecastRowKey(b), 'de'));
  if (!expected.length || !current.length) {
    throw new Error('Forecast-Abbruch: Der Export oder die aktuelle Planbar-Abfrage enthält keine vergleichbaren Termine.');
  }
  if (JSON.stringify(expected) !== JSON.stringify(current)) {
    const expectedKeys = new Set(expected.map(forecastRowKey));
    const currentKeys = new Set(current.map(forecastRowKey));
    const removed = expected.filter(row => !currentKeys.has(forecastRowKey(row))).slice(0, 5).map(row => `${row.kunde} (${row.kalenderwoche})`);
    const added = current.filter(row => !expectedKeys.has(forecastRowKey(row))).slice(0, 5).map(row => `${row.kunde} (${row.kalenderwoche})`);
    const details = [removed.length && `nicht mehr aktuell: ${removed.join(', ')}`, added.length && `neu/verschoben: ${added.join(', ')}`].filter(Boolean).join('; ');
    throw forecastRebuildRequired(`Planbar wurde nach der Exporterstellung geändert${details ? ` (${details})` : ''}.`);
  }
  return { rowCount: current.length, exactMatch: true };
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
  if (info.size > 64 * 1024 * 1024) throw new Error('Forecast-Abbruch: Eine Anlage überschreitet das geprüfte Dateilimit.');
  const handle = await open(file, 'r');
  try {
    const probe = Buffer.alloc(1);
    const { bytesRead } = await handle.read(probe, 0, 1, 0);
    if (bytesRead !== 1) throw new Error(`Forecast-Abbruch: Datei konnte nicht vollständig gelesen werden: ${file}`);
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
  const [manifest, qa, names, sourceSnapshot] = await Promise.all([
    readJson(manifestFile),
    readJson(path.join(directory, 'qa.json')),
    readdir(directory),
    readJson(path.join(directory, 'forecast-data.json')),
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
  if (!Array.isArray(sourceSnapshot?.source?.entries) || !Array.isArray(sourceSnapshot?.forecast?.rows)
    || !sourceSnapshot?.source?.collectedAt || sourceSnapshot?.source?.cacheBypass !== true || sourceSnapshot?.source?.reloadVerified !== true || !sourceSnapshot?.source?.planbarRefreshedAt) {
    throw forecastRebuildRequired('Der belegte, neu geladene und cachefreie Planbar-Snapshot dieses Laufs fehlt.');
  }
  if (Number(manifest.totalRows) !== Number(sourceSnapshot.forecast.rowCount)
    || !sameStrings(manifest.manufacturers || [], Object.keys(sourceSnapshot.forecast.byManufacturer || {}))) {
    throw new Error('Forecast-Abbruch: XLSX-Manifest und Planbar-Snapshot gehören nicht eindeutig zum selben Datenstand.');
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
    attachmentHashes: Object.fromEntries(await Promise.all(attachments.map(async file => [path.basename(file), crypto.createHash('sha256').update(await readFile(file)).digest('hex')]))),
    attachmentNames: expectedXlsx,
    sourceSnapshot,
    sender: PLANBAR_FORECAST_SENDER,
    recipient: PLANBAR_FORECAST_RECIPIENT,
  };
}

export async function assertPlanbarForecastRunCurrent(run, {
  now = new Date(),
  collectFreshForecast = collectAndBuildPlanbarForecast,
  maxPreparedAgeMs = MAX_PREPARED_RUN_AGE_MS,
  maxLiveSourceAgeMs = MAX_LIVE_SOURCE_AGE_MS,
} = {}) {
  const reference = now instanceof Date ? now.getTime() : Date.parse(now);
  const sourceCollectedAt = Date.parse(run.sourceSnapshot?.source?.collectedAt || '');
  if (!Number.isFinite(reference) || !Number.isFinite(sourceCollectedAt)
    || sourceCollectedAt > reference + 60_000 || reference - sourceCollectedAt > maxPreparedAgeMs) {
    throw forecastRebuildRequired('Der Export stammt nicht aus einer unmittelbar aktuellen Planbar-Abfrage.');
  }
  const fresh = await collectFreshForecast({ isoYear: run.year, firstWeek: run.firstWeek, lastWeek: run.lastWeek });
  const freshCollectedAt = Date.parse(fresh?.source?.collectedAt || '');
  const checkedAt = Date.now();
  if (checkedAt - sourceCollectedAt > maxPreparedAgeMs) throw forecastRebuildRequired('Der Export ist während des erneuten Abgleichs zu alt geworden.');
  if (!Number.isFinite(freshCollectedAt) || freshCollectedAt > checkedAt + 60_000
    || checkedAt - freshCollectedAt > maxLiveSourceAgeMs || fresh?.source?.cacheBypass !== true || fresh?.source?.reloadVerified !== true || !Number.isFinite(Date.parse(fresh?.source?.planbarRefreshedAt || '')) || Date.parse(fresh.source.planbarRefreshedAt) > freshCollectedAt) {
    throw new Error('Forecast-Abbruch: Die erneute Planbar-Abfrage konnte nicht als aktuell und cachefrei belegt werden. Es wurde nichts versendet.');
  }
  const comparison = assertPlanbarForecastRowsCurrent(run.sourceSnapshot.forecast.rows, fresh.forecast?.rows);
  if (Number(run.manifest.totalRows) !== Number(fresh.forecast?.rowCount)) {
    throw forecastRebuildRequired('Die aktuelle Baustellenzahl weicht vom geprüften Export ab.');
  }
  const freshManufacturers = Object.keys(fresh.forecast?.byManufacturer || {});
  if (!sameStrings(run.manifest.manufacturers || [], freshManufacturers)) {
    throw forecastRebuildRequired('Die aktuellen Herstellergruppen weichen vom geprüften Export ab.');
  }
  return { ...comparison, sourceCollectedAt: run.sourceSnapshot.source.collectedAt, recheckedAt: fresh.source.collectedAt, cacheBypass: true };
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
    const entries = new Map((Array.isArray(value.entries) ? value.entries : []).map(item => [item.deliveryRunKey || item.id, item]));
    for (const entry of await deliveryLedger.list()) entries.set(entry.deliveryRunKey, entry);
    return { version: 1, entries: [...entries.values()] };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { version: 1, entries: await deliveryLedger.list() };
  }
}

async function saveSendLog(log) {
  await mkdir(path.dirname(SEND_LOG), { recursive: true, mode: 0o700 });
  const temporary = `${SEND_LOG}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, entries: log.entries }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, SEND_LOG);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function newDeliveryEntry(run, context, status, now) {
  const timestamp = now().toISOString();
  return {
    id: crypto.randomUUID(), createdAt: timestamp, submissionStartedAt: timestamp, verificationNotBefore: timestamp, verificationNotAfter: new Date(Date.parse(timestamp) + 10 * 60_000).toISOString(), sentAt: timestamp,
    period: run.period, sender: run.sender, recipient: run.recipient,
    subject: run.subject, attachments: run.attachmentNames, attachmentHashes: run.attachmentHashes || {},
    runMode: context.runMode, automationSlotKey: context.automationSlotKey,
    deliveryRunKey: context.deliveryRunKey,
    status, sentFolderVerified: status === 'sent_verified', sentFolderVerificationError: '',
  };
}

export function deliverValidatedPlanbarForecast(run, options = {}) {
  const operation = deliveryQueue.catch(() => {}).then(() => deliverValidatedPlanbarForecastUnlocked(run, options));
  deliveryQueue = operation.catch(() => {});
  return operation;
}

async function deliverValidatedPlanbarForecastUnlocked(run, {
  send = sendVerifiedOutlookXlsxMessage,
  verify = verifyOutlookSentMessage,
  loadLog = loadSendLog,
  saveLog = saveSendLog,
  runMode = 'manual',
  automationSlotKey = '',
  deliveryRunKey = '',
  now = () => new Date(),
  verifyCurrent = assertPlanbarForecastRunCurrent,
  ledger = loadLog === loadSendLog ? deliveryLedger : null,
  rebuildRun,
  maxRebuilds = 3,
} = {}) {
  const normalizedMode = runMode === 'automatic' ? 'automatic' : 'manual';
  if (String(automationSlotKey || '').length > 180 || String(deliveryRunKey || '').length > 180) throw new Error('Forecast-Abbruch: Die stabile Auftrags-ID ist zu lang; sie wird nicht gekürzt.');
  const normalizedSlotKey = normalizedMode === 'automatic' ? String(automationSlotKey || '').slice(0, 180) : '';
  const normalizedManualKey = normalizedMode === 'manual' ? String(deliveryRunKey || '').slice(0, 180) : '';
  const context = {
    runMode: normalizedMode,
    automationSlotKey: normalizedSlotKey,
    deliveryRunKey: normalizedMode === 'automatic' ? `automatic:${normalizedSlotKey}` : `manual:${normalizedManualKey}`,
  };
  if (context.runMode === 'automatic' && !context.automationSlotKey) {
    throw new Error('Forecast-Abbruch: Dem automatischen Lauf fehlt der eindeutige Wochen-Slot.');
  }
  if (context.runMode === 'manual' && !normalizedManualKey) {
    throw new Error('Forecast-Abbruch: Dem manuellen Lauf fehlt die eindeutige Auftrags-ID.');
  }
  const log = await loadLog();
  const persistLog = async value => { if (ledger) for (const item of value.entries) await ledger.save(item); await saveLog(value); };
  const receipt = ledger ? await ledger.read(context.deliveryRunKey) : null;
  const duplicate = receipt || log.entries.find(item => item.deliveryRunKey === context.deliveryRunKey
    && ['sent_verified', 'submitted_unverified', 'submission_started', 'submission_uncertain'].includes(item.status));
  const body = `Hallo Angelo,\n\nanbei die Planbar-Listen für ${run.period}.\n\nViele Grüße\nNadine`;
  const preview = {
    period: run.period,
    sender: run.sender,
    recipient: run.recipient,
    subject: run.subject,
    attachmentCount: run.attachments.length,
    attachments: run.attachmentNames,
    excludedResourceLeaks: run.manifest.verification.excludedResourceLeaks,
    sent: false,
    runMode: context.runMode,
    automationSlotKey: context.automationSlotKey,
    deliveryRunKey: context.deliveryRunKey,
  };
  if (duplicate?.status === 'sent_verified') {
    return {
      ...preview,
      period: duplicate.period, sender: duplicate.sender, recipient: duplicate.recipient, subject: duplicate.subject,
      attachments: duplicate.attachments, attachmentCount: duplicate.attachments.length,
      preview: false,
      sent: true,
      sentFolderVerified: true,
      duplicateVerified: true,
      sendLogEntry: duplicate,
    };
  }
  if (duplicate) {
    if (!log.entries.some(item => item.deliveryRunKey === duplicate.deliveryRunKey)) log.entries.push(duplicate);
    else log.entries = log.entries.map(item => item.deliveryRunKey === duplicate.deliveryRunKey ? duplicate : item);
    try {
      const start = Date.parse(duplicate.verificationNotBefore || duplicate.createdAt || duplicate.sentAt);
      const end = Date.parse(duplicate.verificationNotAfter || '') || start + 10 * 60_000;
      const possibleOtherAttempt = log.entries.some(item => item.deliveryRunKey !== duplicate.deliveryRunKey
        && item.sender === duplicate.sender && item.recipient === duplicate.recipient && item.subject === duplicate.subject
        && sameStrings(item.attachments || [], duplicate.attachments || [])
        && Date.parse(item.verificationNotBefore || item.createdAt || item.sentAt) <= end
        && (Date.parse(item.verificationNotAfter || '') || Date.parse(item.createdAt || item.sentAt) + 10 * 60_000) >= start);
      if (possibleOtherAttempt) throw new Error('Mehrere ausdrücklich getrennte Aufträge mit identischem Inhalt haben überlappende Versandzeitfenster. Der Gesendet-Beleg muss eindeutig dem ursprünglichen Auftrag zugeordnet werden.');
      const sentFolder = await verify({
        from: duplicate.sender,
        to: [duplicate.recipient],
        subject: duplicate.subject,
        body,
        attachments: duplicate.attachments,
        notBefore: duplicate.verificationNotBefore || duplicate.createdAt || duplicate.sentAt,
        notAfter: duplicate.verificationNotAfter || new Date(Date.parse(duplicate.createdAt || duplicate.sentAt) + 10 * 60_000).toISOString(),
        lookbackSeconds: Math.max(120, Math.min(8 * 24 * 60 * 60,
          Math.ceil((now().getTime() - Date.parse(duplicate.createdAt || duplicate.sentAt || 0)) / 1000) + 120)),
      });
      if (sentFolder?.verified !== true) throw new Error('Outlook hat den vorhandenen Versand nicht eindeutig verifiziert.');
      duplicate.status = 'sent_verified';
      duplicate.sentFolderVerified = true;
      duplicate.sentFolderVerificationError = '';
      duplicate.verifiedAt = now().toISOString();
      duplicate.sentFolder = sentFolder;
      await persistLog(log);
      return {
        ...preview,
        period: duplicate.period, sender: duplicate.sender, recipient: duplicate.recipient, subject: duplicate.subject,
        attachments: duplicate.attachments, attachmentCount: duplicate.attachments.length,
        preview: false,
        sent: true,
        sentFolderVerified: true,
        duplicateVerified: true,
        sendLogEntry: duplicate,
        outlook: { sent: true, sentFolderVerified: true, sentFolder, reverifiedWithoutResend: true },
      };
    } catch (error) {
      duplicate.sentFolderVerificationError = String(error?.message || error).slice(0, 500);
      duplicate.lastVerificationAttemptAt = now().toISOString();
      await persistLog(log);
      throw new Error(`Forecast-Abbruch: Für genau diesen Auftrag existiert bereits ein Versandversuch; der Gesendet-Nachweis ist noch nicht sichtbar. Derselbe Auftrag wurde nicht erneut gesendet. ${duplicate.sentFolderVerificationError}`);
    }
  }

  let freshness;
  for (let attempt = 0; ; attempt += 1) {
    try { freshness = await verifyCurrent(run); break; }
    catch (error) {
      const rebuildLimit = Number.isFinite(Number(maxRebuilds)) ? Math.min(3, Math.max(0, Math.floor(Number(maxRebuilds)))) : 3;
      if (error.code !== 'PLANBAR_FORECAST_REBUILD_REQUIRED' || typeof rebuildRun !== 'function' || attempt >= rebuildLimit) throw error;
      const rebuilt = await rebuildRun({ run, attempt: attempt + 1, error, ...context });
      if (!rebuilt || rebuilt.period !== run.period || rebuilt.sender !== run.sender || rebuilt.recipient !== run.recipient) throw new Error('Forecast-Abbruch: Der Neuaufbau darf Zeitraum, Empfänger und Auftrag nicht verändern.');
      run = rebuilt;
    }
  }
  preview.attachments = run.attachmentNames;
  preview.attachmentCount = run.attachments.length;

  const message = {
    from: run.sender,
    to: [run.recipient],
    subject: run.subject,
    body,
    attachments: run.attachments,
    sentVerificationLookbackSeconds: 120,
  };
  // Vor dem UI-Aufruf persistieren: Stirbt der Prozess während des Klicks,
  // darf der nächste Lauf nur nachprüfen und niemals blind erneut senden.
  const entry = newDeliveryEntry(run, context, 'submission_started', now);
  if (freshness) {
    entry.sourceCollectedAt = freshness.sourceCollectedAt;
    entry.planbarRecheckedAt = freshness.recheckedAt;
    entry.planbarExactMatch = freshness.exactMatch === true;
  }
  if (ledger) {
    const claimed = await ledger.claim(entry);
    if (!claimed.created) return deliverValidatedPlanbarForecastUnlocked(run, { send, verify, loadLog: async () => ({ ...log, entries: [...log.entries, claimed.entry] }), saveLog, ledger, runMode, automationSlotKey, deliveryRunKey, now, verifyCurrent });
  }
  log.entries.push(entry);
  await persistLog(log);
  let result;
  try {
    result = await send({ ...message, sentVerificationNotBefore: entry.verificationNotBefore, sentVerificationNotAfter: entry.verificationNotAfter });
    if (result?.sent !== true) throw new Error('Outlook hat den Versand nicht bestätigt.');
    entry.status = result.sentFolderVerified === true ? 'sent_verified' : 'submitted_unverified';
    entry.sentFolderVerified = result.sentFolderVerified === true;
    entry.sentFolderVerificationError = result.sentFolderVerificationError || '';
    if (result.sentFolder) entry.sentFolder = result.sentFolder;
    await persistLog(log);
  } catch (sendError) {
    entry.status = 'submission_uncertain';
    entry.sentFolderVerificationError = String(sendError?.message || sendError).slice(0, 500);
    await persistLog(log);
    try {
      const sentFolder = await verify({ ...message, lookbackSeconds: 120, notBefore: entry.verificationNotBefore, notAfter: entry.verificationNotAfter });
      if (sentFolder?.verified !== true) throw new Error('Outlook hat den vorhandenen Versand nicht eindeutig verifiziert.');
      entry.status = 'sent_verified';
      entry.sentFolderVerified = true;
      entry.sentFolderVerificationError = '';
      entry.sentFolder = sentFolder;
      entry.verifiedAt = now().toISOString();
      await persistLog(log);
      return {
        ...preview, preview: false, sent: true, sentFolderVerified: true,
        recoveredAfterUncertainSubmission: true, sendLogEntry: entry,
        outlook: { sent: true, sentFolderVerified: true, sentFolder, recoveredAfterUncertainSubmission: true },
      };
    } catch (verificationError) {
      entry.lastVerificationAttemptAt = now().toISOString();
      entry.sentFolderVerificationError = String(verificationError?.message || verificationError).slice(0, 500);
      await persistLog(log);
      throw new Error(`Forecast-Abbruch: Der Versandstatus ist technisch unklar. Es wird ausdrücklich nicht erneut gesendet; ausschließlich der Gesendet-Ordner darf nachgeprüft werden. ${entry.sentFolderVerificationError}`);
    }
  }
  return { ...preview, preview: false, sent: true, freshness, sentFolderVerified: entry.sentFolderVerified, sendLogEntry: entry, outlook: result };
}

export async function sendPlanbarForecastRun(runDirectory, {
  commit = false,
  send = sendVerifiedOutlookXlsxMessage,
  verify = verifyOutlookSentMessage,
  runMode = 'manual',
  automationSlotKey = '',
  deliveryRunKey = '',
  collectFreshForecast,
  rebuildRun,
} = {}) {
  if (commit) {
    const key = runMode === 'automatic' ? `automatic:${automationSlotKey}` : `manual:${deliveryRunKey}`;
    const receipt = (await loadSendLog()).entries.find(item => item.deliveryRunKey === key && ['submission_started', 'submission_uncertain', 'submitted_unverified', 'sent_verified'].includes(item.status));
    if (receipt) return deliverValidatedPlanbarForecast({ ...receipt, attachmentNames: receipt.attachments, manifest: { verification: { excludedResourceLeaks: 0 } } }, { send, verify, runMode, automationSlotKey, deliveryRunKey });
  }
  const run = await validatePlanbarForecastRun(runDirectory);
  if (!commit) {
    return {
      period: run.period, sender: run.sender, recipient: run.recipient, subject: run.subject,
      attachmentCount: run.attachments.length, attachments: run.attachmentNames,
      excludedResourceLeaks: run.manifest.verification.excludedResourceLeaks,
      sent: false, preview: true,
      runMode: runMode === 'automatic' ? 'automatic' : 'manual',
      automationSlotKey: runMode === 'automatic' ? String(automationSlotKey || '') : '',
      deliveryRunKey: runMode === 'automatic' ? `automatic:${String(automationSlotKey || '')}` : `manual:${String(deliveryRunKey || '')}`,
    };
  }
  return deliverValidatedPlanbarForecast(run, {
    send, verify, runMode, automationSlotKey, deliveryRunKey, rebuildRun,
    verifyCurrent: async currentRun => {
      const freshness = await assertPlanbarForecastRunCurrent(currentRun, { collectFreshForecast: collectFreshForecast || collectAndBuildPlanbarForecast });
      const checked = await validatePlanbarForecastRun(currentRun.directory);
      if (JSON.stringify(checked.attachmentHashes) !== JSON.stringify(currentRun.attachmentHashes)) throw forecastRebuildRequired('Die geprüften XLSX-Anlagen haben sich vor Versand verändert.');
      assertPlanbarForecastRowsCurrent(currentRun.sourceSnapshot.forecast.rows, checked.sourceSnapshot.forecast.rows);
      return freshness;
    },
  });
}

export async function recordPlanbarForecastRebuild(runDirectory, error, {
  outputRoot = OUTPUT_ROOT, runMode = 'manual', automationSlotKey = '', deliveryRunKey = '',
} = {}) {
  if (error?.code !== 'PLANBAR_FORECAST_REBUILD_REQUIRED') throw error;
  const root = path.resolve(outputRoot), directory = path.resolve(runDirectory);
  if (!directory.startsWith(root + path.sep)) throw new Error('Der Neuaufbau-Marker benötigt einen gültigen Forecast-Laufordner.');
  const key = runMode === 'automatic' ? `automatic:${automationSlotKey}` : `manual:${deliveryRunKey}`;
  if (key.endsWith(':') || key.length > 200) throw new Error('Dem Neuaufbau fehlt die stabile Forecast-Auftrags-ID.');
  const requests = path.join(root, 'rebuild-requests');
  await mkdir(requests, { recursive: true, mode: 0o700 });
  const file = path.join(requests, crypto.createHash('sha256').update(key).digest('hex') + '.json');
  const previous = await readJson(file).catch(failure => { if (failure.code === 'ENOENT') return null; throw failure; });
  const attempt = Number(previous?.attempt || 0) + 1;
  const marker = { version: 1, code: attempt <= 3 ? error.code : 'PLANBAR_FORECAST_SOURCE_UNSTABLE', recoverable: attempt <= 3,
    nextAction: attempt <= 3 ? 'rebuild_forecast_same_job' : 'wait_for_stable_source_same_job',
    runMode, automationSlotKey, deliveryRunKey: key, attempt, runDirectory: path.relative(root, directory),
    createdAt: new Date().toISOString(), sent: false, reason: error.message,
    instruction: 'Denselben Auftrag und dieselbe Versand-ID behalten. Plantafel neu laden; Daten, XLSX und QA neu erzeugen; deterministischen Sender erneut aufrufen. Bei vorhandenem Versandversuch nur Gesendet prüfen.' };
  for (const target of [file, path.join(directory, 'forecast-rebuild-required.json')]) {
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(marker, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, target); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  return marker;
}

export async function latestVerifiedPlanbarForecastDelivery({ after = '', runMode = '', automationSlotKey = '', deliveryRunKey = '' } = {}) {
  const cutoff = Date.parse(after || 0);
  const entries = (await loadSendLog()).entries
    .filter(item => item.status === 'sent_verified' && item.sentFolderVerified === true)
    .filter(item => !runMode || item.runMode === runMode)
    .filter(item => !automationSlotKey || item.automationSlotKey === automationSlotKey)
    .filter(item => !deliveryRunKey || item.deliveryRunKey === deliveryRunKey || item.deliveryRunKey === `manual:${deliveryRunKey}`)
    .filter(item => !Number.isFinite(cutoff) || Date.parse(item.sentAt || item.createdAt || 0) >= cutoff)
    .sort((left, right) => String(right.sentAt || right.createdAt).localeCompare(String(left.sentAt || left.createdAt)));
  const entry = entries[0];
  if (!entry) return null;
  return {
    deliveryRunKey: entry.runMode === 'manual' ? String(entry.deliveryRunKey || '').replace(/^manual:/, '') : entry.deliveryRunKey,
    canonicalDeliveryRunKey: entry.deliveryRunKey, automationSlotKey: entry.automationSlotKey, runMode: entry.runMode,
    period: entry.period || '',
    subject: entry.subject || '',
    sentAt: entry.sentAt || entry.createdAt || '',
    sentFolderVerified: true,
    attachmentCount: Array.isArray(entry.attachments) ? entry.attachments.length : 0,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
  const directory = process.argv.slice(2).find(value => value && !value.startsWith('--'));
  const commit = process.argv.includes('--commit');
  const runModeIndex = process.argv.indexOf('--run-mode');
  const automationSlotIndex = process.argv.indexOf('--automation-slot');
  const deliveryRunIndex = process.argv.indexOf('--delivery-run');
  const runMode = runModeIndex >= 0 ? process.argv[runModeIndex + 1] : 'manual';
  const automationSlotKey = automationSlotIndex >= 0 ? process.argv[automationSlotIndex + 1] : '';
  const deliveryRunKey = deliveryRunIndex >= 0 ? process.argv[deliveryRunIndex + 1] : '';
  try {
    const result = await sendPlanbarForecastRun(directory, { commit, runMode, automationSlotKey, deliveryRunKey });
    console.log(JSON.stringify(result, null, 2));
    if (commit && result.sentFolderVerified !== true) process.exitCode = 2;
  } catch (error) {
    if (error.code !== 'PLANBAR_FORECAST_REBUILD_REQUIRED') throw error;
    const marker = await recordPlanbarForecastRebuild(directory, error, { runMode, automationSlotKey, deliveryRunKey });
    console.log(JSON.stringify(marker, null, 2));
    process.exitCode = marker.recoverable ? 3 : 4;
  }
}
