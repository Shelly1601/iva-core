import os from 'node:os';
import path from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(new URL('./macos/iva-ax.swift', import.meta.url));
const BIN_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper', 'bin');
const BINARY = path.join(BIN_DIR, 'iva-ax');
const MAX_OUTPUT_BYTES = 1024 * 1024;

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
  const account = await runMacUiBridge(['value', 'AXPopUpButton', 'accountPicker']);
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

export async function fillVerifiedOutlookCompose({ from, subject, body, allowExistingSubject = false }) {
  const before = await assertOutlookComposeSender(from);
  const currentSubject = await runMacUiBridge(['value', 'AXTextField', 'subjectTextField']);
  if (!allowExistingSubject && String(currentSubject.value || '').trim()) {
    throw new Error('Outlook-Abbruch: Der geöffnete Entwurf enthält bereits einen Betreff. Er wurde nicht überschrieben.');
  }
  const currentBody = await runMacUiBridge(['value', 'AXTextArea', '']);
  const signature = String(currentBody.value || '').trim();
  const composedBody = signature ? `${String(body).trim()}\n\n${signature}\n` : `${String(body).trim()}\n`;

  await runMacUiBridge(['set-value', 'AXTextField', 'subjectTextField', subject]);
  await runMacUiBridge(['set-value', 'AXTextArea', '', composedBody]);
  const after = await assertOutlookComposeSender(from);
  const verifiedSubject = await runMacUiBridge(['value', 'AXTextField', 'subjectTextField']);
  if (String(verifiedSubject.value || '') !== String(subject)) {
    throw new Error('Outlook-Abbruch: Der Betreff konnte nach dem Eintragen nicht verifiziert werden.');
  }
  await runMacUiBridge(['save']);
  return {
    created: true,
    storedInSelectedAccount: after.selectedFrom,
    subject,
    bodyFormat: 'plain-text-with-paragraphs',
    signaturePreserved: Boolean(signature),
    sent: false,
    context: before.focusedWindowTitle,
  };
}
