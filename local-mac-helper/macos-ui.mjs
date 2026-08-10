import os from 'node:os';
import path from 'node:path';
import { mkdir, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(new URL('./macos/iva-ax.swift', import.meta.url));
const BIN_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper', 'bin');
const BINARY = path.join(BIN_DIR, 'iva-ax');
const TEMP_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper', 'tmp');
const MAX_OUTPUT_BYTES = 1024 * 1024;
const OUTLOOK_ACCOUNT_LABELS = Object.freeze({
  'foerderung@heat-hero.com': 'Förderung | HEAT HERO',
});

function run(command, args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`macOS-Oberflächenautomation hat nach ${timeoutMs} ms abgebrochen.`));
    }, timeoutMs);
    child.stdout.on('data', chunk => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout.trim());
      reject(new Error((stderr || stdout || `${command} beendet mit Code ${code}`).trim()));
    });
  });
}

async function needsCompile() {
  try {
    const [source, binary] = await Promise.all([stat(SOURCE), stat(BINARY)]);
    return source.mtimeMs > binary.mtimeMs;
  } catch {
    return true;
  }
}

export async function ensureMacUiBridge() {
  if (process.platform !== 'darwin') throw new Error('Die Outlook-Oberflächenautomation ist nur unter macOS verfügbar.');
  if (await needsCompile()) {
    await mkdir(BIN_DIR, { recursive: true, mode: 0o700 });
    await run('/usr/bin/swiftc', [SOURCE, '-o', BINARY], { timeoutMs: 60000 });
  }
  return BINARY;
}

export async function runMacUiBridge(args, options) {
  const binary = await ensureMacUiBridge();
  const output = await run(binary, args.map(value => String(value ?? '')), options);
  try { return JSON.parse(output); }
  catch { throw new Error('Die macOS-Oberflächenautomation hat keine gültige Antwort geliefert.'); }
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function emailFromAccountPicker(value) {
  const match = String(value || '').match(/\(([^()\s]+@[^()\s]+)\)\s*$/);
  return normalizeEmail(match?.[1]);
}

export async function inspectOutlookCompose(expectedFrom) {
  const requestedFrom = normalizeEmail(expectedFrom);
  if (!requestedFrom) throw new Error('Für die Outlook-Prüfung fehlt die erwartete Absenderadresse.');
  const account = await runMacUiBridge(['value-app', 'AXPopUpButton', 'accountPicker'], { timeoutMs: 30000 });
  const selectedFrom = emailFromAccountPicker(account.value);
  const exactSenderSelected = selectedFrom === requestedFrom;
  return {
    composeVisible: true,
    exactSenderSelected,
    requestedFrom,
    selectedFrom: selectedFrom || null,
    accountLabel: String(account.value || ''),
    focusedWindowTitle: String(account.focusedWindowTitle || ''),
  };
}

export async function assertOutlookComposeSender(expectedFrom) {
  const inspection = await inspectOutlookCompose(expectedFrom);
  if (!inspection.exactSenderSelected) {
    throw new Error(`Outlook-Abbruch: ausgewählt ist ${inspection.selectedFrom || 'kein eindeutig erkennbares Konto'}, erwartet wird ${inspection.requestedFrom}. Es wurde nichts eingetragen.`);
  }
  return inspection;
}

export async function selectExactOutlookComposeSender(expectedFrom) {
  const requestedFrom = normalizeEmail(expectedFrom);
  const current = await inspectOutlookCompose(requestedFrom);
  if (current.exactSenderSelected) return current;
  await runMacUiBridge(['select-popup-option', 'AXPopUpButton', 'accountPicker', requestedFrom], { timeoutMs: 30000 });
  return assertOutlookComposeSender(requestedFrom);
}

async function fillRecipientField(identifier, values) {
  const addresses = Array.isArray(values) ? values.filter(Boolean).map(String) : [];
  if (!addresses.length) return;
  await runMacUiBridge(['replace-text-app-and-confirm', 'AXTextField', identifier, addresses.join('; ')], { timeoutMs: 30000 });
}

export async function createOutlookDraftViaUi({ from, subject, body, html = '', to = [], cc = [], bcc = [], attachments = [] }) {
  if (attachments.length) {
    throw new Error('Outlook-UI-Abbruch: Anlagen werden über den Oberflächenweg noch nicht sicher unterstützt. Es wurde kein Entwurf geöffnet.');
  }
  let composeOpened = false;
  try {
    await runMacUiBridge(['new-message'], { timeoutMs: 30000 });
    composeOpened = true;
    await selectExactOutlookComposeSender(from);
    await fillRecipientField('toTextField', to);
    if (cc.length) {
      await runMacUiBridge(['press', 'AXButton', 'ccShowButton']);
      await fillRecipientField('ccTextField', cc);
    }
    if (bcc.length) {
      await runMacUiBridge(['press', 'AXButton', 'bccShowButton']);
      await fillRecipientField('bccTextField', bcc);
    }
    const result = await fillVerifiedOutlookCompose({ from, subject, body, html });
    await runMacUiBridge(['save-and-close'], { timeoutMs: 30000 });
    return { ...result, channel: 'macos-accessibility', closedAfterSave: true };
  } catch (error) {
    if (composeOpened) {
      await runMacUiBridge(['press', 'AXButton', 'Verwerfen']).catch(() => {});
    }
    throw error;
  }
}

async function updatePreparedOutlookDraftInCurrentFolder({ from, subject, body, html = '', to = [], cc = [], bcc = [], attachments = [] }) {
  if (attachments.length) throw new Error('Outlook-UI-Abbruch: Ein vorhandener Förderentwurf mit Anlagen wird nicht automatisch überschrieben.');
  const requestedFrom = normalizeEmail(from);
  if (!String(subject || '').trim() || !to.length) throw new Error('Entwurfsaktualisierung abgebrochen: Betreff oder An-Empfänger fehlt.');
  await runMacUiBridge(['set-value-shallowest-and-confirm', 'AXTextField', 'Search Bar', subject], { timeoutMs: 30000 });
  await new Promise(resolve => setTimeout(resolve, 1400));
  try {
    await runMacUiBridge(['open-draft-search-result', subject], { timeoutMs: 30000 });
  } catch (error) {
    if (!/gefunden wurden 0/.test(error.message)) throw error;
    await runMacUiBridge(['select-search-suggestion', subject]);
    await new Promise(resolve => setTimeout(resolve, 1400));
    await runMacUiBridge(['open-draft-search-result', subject], { timeoutMs: 30000 });
  }
  await assertOutlookComposeSender(requestedFrom);

  await runMacUiBridge(['set-value-app', 'AXTextField', 'toTextField', to.join('; ')], { timeoutMs: 30000 });
  // Die Vertriebspartneradresse ändert sich bei diesem Nachabgleich nicht.
  // Cc/Bcc bleiben deshalb unangetastet; damit können keine vorhandenen Chips
  // versehentlich in einer von Outlook virtualisierten Ansicht verloren gehen.
  const result = await fillVerifiedOutlookCompose({ from: requestedFrom, subject, body, html, allowExistingSubject: true });
  await runMacUiBridge(['save'], { timeoutMs: 30000 });
  const verified = await runMacUiBridge(['compose-summary'], { timeoutMs: 30000 });
  const actualRecipients = (verified.recipientEmails || []).map(normalizeEmail);
  if (!to.every(address => actualRecipients.includes(normalizeEmail(address)))) {
    throw new Error(`Entwurfsaktualisierung abgebrochen: Der An-Empfänger ${to.join(', ')} konnte nach dem Speichern nicht sichtbar verifiziert werden.`);
  }
  return {
    ...result,
    updated: true,
    channel: 'macos-accessibility',
    verifiedRecipients: actualRecipients,
    closedAfterSave: false,
  };
}

export async function updateOutlookDraftsViaUi(drafts, { onProgress } = {}) {
  const entries = Array.isArray(drafts) ? drafts : [];
  if (!entries.length || entries.length > 100) throw new Error('Für die Outlook-Entwurfsaktualisierung werden 1 bis 100 Entwürfe benötigt.');
  const requestedFrom = normalizeEmail(entries[0]?.from);
  const accountLabel = OUTLOOK_ACCOUNT_LABELS[requestedFrom];
  if (!accountLabel) throw new Error(`Entwurfsaktualisierung abgebrochen: Für ${requestedFrom || 'das Absenderkonto'} ist kein geprüftes Outlook-Konto hinterlegt.`);
  if (entries.some(entry => normalizeEmail(entry.from) !== requestedFrom)) throw new Error('Entwurfsaktualisierung abgebrochen: Die Entwürfe stammen nicht alle aus demselben Konto.');
  if (new Set(entries.map(entry => String(entry.subject || '').trim())).size !== entries.length) throw new Error('Entwurfsaktualisierung abgebrochen: Die Betreffe sind nicht eindeutig.');

  await run('/usr/bin/open', ['-a', 'Microsoft Outlook'], { timeoutMs: 15000 });
  await runMacUiBridge(['activate']);
  await runMacUiBridge(['shortcut', '18', 'command']);
  await runMacUiBridge(['open-account-folder', accountLabel, 'Entwürfe'], { timeoutMs: 30000 });
  await runMacUiBridge(['press-shallowest', 'AXButton', 'Cancel Search Button']).catch(() => {});

  const results = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    try {
      const result = await updatePreparedOutlookDraftInCurrentFolder(entry);
      results.push({ index, subject: entry.subject, updated: result.updated === true, sent: false, result });
    } catch (error) {
      results.push({ index, subject: entry.subject, updated: false, sent: false, error: error.message });
      break;
    }
    if (typeof onProgress === 'function') onProgress({ processed: index + 1, total: entries.length, subject: entry.subject });
  }
  return { requested: entries.length, updated: results.filter(item => item.updated).length, failed: results.filter(item => item.error).length, results, sent: false };
}

export async function updateOutlookDraftViaUi(draft) {
  const batch = await updateOutlookDraftsViaUi([draft]);
  if (batch.failed) throw new Error(batch.results.find(item => item.error)?.error || 'Outlook-Entwurfsaktualisierung fehlgeschlagen.');
  return batch.results[0].result;
}

export async function deleteOutlookDraftsViaUi({ from, entries = [] }) {
  const requestedFrom = normalizeEmail(from);
  const accountLabel = OUTLOOK_ACCOUNT_LABELS[requestedFrom];
  if (!accountLabel) throw new Error(`Rückgängig-Abbruch: Für ${requestedFrom || 'das Absenderkonto'} ist kein geprüfter Outlook-Ordner hinterlegt.`);
  const normalizedEntries = entries.map(entry => ({
    marker: String(entry?.marker || ''),
    subject: String(entry?.subject || '').trim(),
  }));
  if (normalizedEntries.some(entry => !entry.marker || !entry.subject)) {
    throw new Error('Rückgängig-Abbruch: Mindestens ein IVA-Entwurf besitzt keine eindeutige Kennung oder keinen Betreff.');
  }
  await runMacUiBridge(['activate']);
  await runMacUiBridge(['press-shallowest', 'AXButton', 'Cancel Search Button']).catch(() => {});
  await runMacUiBridge(['open-account-drafts', accountLabel], { timeoutMs: 30000 });
  const deletedMarkers = [];
  const failures = [];
  for (const entry of normalizedEntries) {
    try {
      await runMacUiBridge(['delete-account-draft', entry.subject], { timeoutMs: 30000 });
      deletedMarkers.push(entry.marker);
    } catch (error) {
      failures.push({ marker: entry.marker, subject: entry.subject, error: error.message });
    }
  }
  return {
    deletedMarkers,
    missingMarkers: normalizedEntries.filter(entry => !deletedMarkers.includes(entry.marker)).map(entry => entry.marker),
    failures,
    channel: 'macos-accessibility',
    recoverableFromDeletedItems: true,
    sent: false,
  };
}

export async function openOutlookAccountFolder({ from, folder }) {
  const requestedFrom = normalizeEmail(from);
  const accountLabel = OUTLOOK_ACCOUNT_LABELS[requestedFrom];
  if (!accountLabel) throw new Error(`Für ${requestedFrom || 'das Outlook-Konto'} ist kein geprüftes Konto hinterlegt.`);
  const folderName = String(folder || '').trim();
  if (!folderName) throw new Error('Outlook-Ordnername fehlt.');
  // `activate` allein stellt unter macOS kein geschlossenes Outlook-Hauptfenster
  // wieder her. Der Monitor öffnet die App deshalb zuerst idempotent und darf
  // erst danach den fest hinterlegten Kontoordner auswählen.
  await run('/usr/bin/open', ['-a', 'Microsoft Outlook'], { timeoutMs: 15000 });
  await runMacUiBridge(['activate']);
  await runMacUiBridge(['press-shallowest', 'AXButton', 'Cancel Search Button']).catch(() => {});
  return runMacUiBridge(['open-account-folder', accountLabel, folderName], { timeoutMs: 30000 });
}

export async function inspectOutlookMessageAttachments(description) {
  const exactDescription = String(description || '');
  if (!exactDescription) throw new Error('Für die Outlook-Anlagenprüfung fehlt die exakte Nachrichtenbeschreibung.');
  return runMacUiBridge(['inspect-message-attachments', exactDescription], { timeoutMs: 30000 });
}

function attachmentNameFromDescription(value) {
  return String(value || '').match(/^(.+?\.(?:pdf|png|jpe?g|heic|tiff?))(?:,\s+.*)?$/i)?.[1]?.trim() || null;
}

function managedFundingDownloadRoot() {
  return path.join(
    process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper'),
    'incoming',
  );
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function waitForDownloadedAttachments(directory, expectedNames, { timeoutMs = 120000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let stableSignature = '';
  let stablePasses = 0;
  while (Date.now() < deadline) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort();
    const metadata = await Promise.all(entries.map(async name => {
      const file = await stat(path.join(directory, name));
      return { name, size: file.size };
    }));
    const signature = JSON.stringify(metadata);
    if (metadata.length >= expectedNames.length && metadata.every(item => item.size > 0) && signature === stableSignature) stablePasses += 1;
    else stablePasses = 0;
    stableSignature = signature;
    if (stablePasses >= 2) return metadata;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Outlook-Download wurde nicht innerhalb von ${Math.round(timeoutMs / 1000)} Sekunden vollständig verifiziert.`);
}

export async function downloadOutlookMessageAttachments(description, destinationDirectory) {
  const managedRoot = managedFundingDownloadRoot();
  await mkdir(managedRoot, { recursive: true, mode: 0o700 });
  const resolvedRoot = await realpath(managedRoot);
  const destination = path.resolve(String(destinationDirectory || ''));
  if (!destination || !isInside(resolvedRoot, destination) || destination === resolvedRoot) {
    throw new Error('Outlook-Anlagen dürfen nur in einen eigenen IVA-Förder-Eingangsordner geladen werden.');
  }
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const existing = await readdir(destination);
  if (existing.length) throw new Error('Der IVA-Förder-Eingangsordner ist nicht leer; Download abgebrochen.');

  const inspection = await inspectOutlookMessageAttachments(description);
  const expectedNames = (inspection.attachments || []).map(item => attachmentNameFromDescription(item.description)).filter(Boolean);
  const expectedCount = Number(String(inspection.attachmentGrid?.description || '').match(/\d+/)?.[0] || expectedNames.length);
  if (!expectedNames.length || expectedNames.length !== expectedCount) {
    throw new Error('Outlook-Anlagen konnten vor dem Download nicht vollständig und eindeutig benannt werden.');
  }
  const started = await runMacUiBridge(['download-open-message-attachments', destination], { timeoutMs: 30000 });
  const files = await waitForDownloadedAttachments(destination, expectedNames);
  const normalizedExpected = expectedNames.map(value => value.normalize('NFC').toLowerCase()).sort();
  const normalizedActual = files.map(item => item.name.normalize('NFC').toLowerCase()).sort();
  if (JSON.stringify(normalizedExpected) !== JSON.stringify(normalizedActual)) {
    throw new Error('Die lokal gespeicherten Outlook-Anlagen stimmen nicht exakt mit der sichtbaren Anlagenliste überein.');
  }
  return {
    destination,
    expectedCount,
    downloadedCount: files.length,
    files,
    verified: true,
    messageMutated: false,
    ...started,
  };
}

export async function inspectOutlookMessagesAttachments(descriptions) {
  const exactDescriptions = Array.isArray(descriptions) ? descriptions.map(String).filter(Boolean) : [];
  if (!exactDescriptions.length) return { count: 0, inspections: [] };
  await mkdir(TEMP_DIR, { recursive: true, mode: 0o700 });
  const inputFile = path.join(TEMP_DIR, `${randomUUID()}.json`);
  try {
    await writeFile(inputFile, JSON.stringify(exactDescriptions), { mode: 0o600 });
    return await runMacUiBridge(['inspect-message-attachments-file', inputFile], { timeoutMs: Math.max(30000, exactDescriptions.length * 2500) });
  } finally {
    await unlink(inputFile).catch(() => {});
  }
}

async function pasteHtmlIntoOutlook(html) {
  await mkdir(TEMP_DIR, { recursive: true, mode: 0o700 });
  const htmlFile = path.join(TEMP_DIR, `${randomUUID()}.html`);
  try {
    await writeFile(htmlFile, String(html), { mode: 0o600 });
    return await runMacUiBridge(['paste-html-file-app-largest', 'AXTextArea', '', htmlFile], { timeoutMs: 30000 });
  } finally {
    await unlink(htmlFile).catch(() => {});
  }
}

export async function fillVerifiedOutlookCompose({ from, subject, body, html = '', allowExistingSubject = false }) {
  const before = await assertOutlookComposeSender(from);
  const currentSubject = await runMacUiBridge(['value-app', 'AXTextField', 'subjectTextField']);
  const existingSubject = String(currentSubject.value || '').trim();
  if (!allowExistingSubject && existingSubject) {
    throw new Error('Outlook-Abbruch: Der geöffnete Entwurf enthält bereits einen Betreff. Er wurde nicht überschrieben.');
  }
  if (allowExistingSubject && existingSubject && existingSubject !== String(subject).trim()) {
    throw new Error('Outlook-Abbruch: Der vorhandene Betreff stimmt nicht exakt mit dem zu aktualisierenden Entwurf überein.');
  }

  if (!allowExistingSubject || !existingSubject) {
    await runMacUiBridge(['paste-text-app', 'AXTextField', 'subjectTextField', subject]);
  }
  if (String(html).trim()) await pasteHtmlIntoOutlook(html);
  else await runMacUiBridge(['paste-text-app', 'AXTextArea', '', `${String(body).trim()}\n`]);
  const after = await assertOutlookComposeSender(from);
  const verifiedSubject = await runMacUiBridge(['value-app', 'AXTextField', 'subjectTextField']);
  if (String(verifiedSubject.value || '') !== String(subject)) {
    throw new Error('Outlook-Abbruch: Der Betreff konnte nach dem Eintragen nicht verifiziert werden.');
  }
  return {
    created: true,
    storedInSelectedAccount: after.selectedFrom,
    subject,
    bodyFormat: String(html).trim() ? 'html-rich-text' : 'plain-text-with-paragraphs',
    existingOutlookSignaturePreserved: false,
    sent: false,
    context: before.focusedWindowTitle,
  };
}
