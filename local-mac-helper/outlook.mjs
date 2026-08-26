import { access, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createOutlookDraftViaUi, deleteOutlookDraftsViaUi, sendVerifiedOutlookXlsxMessageViaUi, updateOutlookDraftsViaUi, updateOutlookDraftViaUi } from './macos-ui.mjs';

const OUTLOOK_APP = '/Applications/Microsoft Outlook.app';
const MAX_OUTPUT_BYTES = 1024 * 1024;

function appleScriptString(value) {
  const lines = String(value ?? '').replace(/\r/g, '').split('\n');
  return lines.map(line => `"${line.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\t/g, '    ')}"`).join(' & linefeed & ');
}

function email(value, field) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error(`${field}: ungültige E-Mail-Adresse.`);
  return normalized;
}

function recipients(values, field) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter(Boolean).map(value => email(value, field)))].slice(0, 100);
}

export function normalizeDraftPayload(input = {}, { allowNoRecipient = false } = {}) {
  const subject = String(input.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 240);
  const body = String(input.body || '').replace(/\0/g, '').trim().slice(0, 100000);
  const html = String(input.html || '').replace(/\0/g, '').trim().slice(0, 200000);
  const to = recipients(input.to, 'An');
  const cc = recipients(input.cc, 'Cc');
  const bcc = recipients(input.bcc, 'Bcc');
  const attachments = [...new Set((Array.isArray(input.attachments) ? input.attachments : []).filter(Boolean).map(String))].slice(0, 40);
  const from = input.from ? email(input.from, 'Absender') : '';
  if (!subject) throw new Error('Betreff fehlt.');
  if (!body) throw new Error('Mailtext fehlt.');
  if (!allowNoRecipient && !to.length) throw new Error('Mindestens ein Empfänger fehlt.');
  if (!from) throw new Error('Der gewünschte Absender fehlt. Ohne eindeutigen Absender wird kein Outlook-Entwurf erstellt.');
  return { subject, body, html, to, cc, bcc, attachments, from };
}

export async function validateAttachmentPaths(paths = []) {
  for (const filePath of paths) {
    await access(filePath);
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error(`Anlage ist keine Datei: ${filePath}`);
    if (info.size > 35 * 1024 * 1024) throw new Error(`Anlage ist größer als 35 MB: ${filePath}`);
  }
}

export function buildDraftAppleScript(input = {}) {
  const draft = normalizeDraftPayload(input);
  const lines = [
    'tell application id "com.microsoft.Outlook"',
    `set requestedSender to ${appleScriptString(draft.from)}`,
    'set senderAccount to missing value',
    'repeat with accountCandidate in exchange accounts',
    'ignoring case',
    'if (email address of accountCandidate as text) is requestedSender then set senderAccount to accountCandidate',
    'end ignoring',
    'end repeat',
    'if senderAccount is missing value then',
    'repeat with accountCandidate in imap accounts',
    'ignoring case',
    'if (email address of accountCandidate as text) is requestedSender then set senderAccount to accountCandidate',
    'end ignoring',
    'end repeat',
    'end if',
    'if senderAccount is missing value then',
    'repeat with accountCandidate in pop accounts',
    'ignoring case',
    'if (email address of accountCandidate as text) is requestedSender then set senderAccount to accountCandidate',
    'end ignoring',
    'end repeat',
    'end if',
    'if senderAccount is missing value then error "Das gewünschte Outlook-Absenderkonto ist über die native Schnittstelle nicht verfügbar." number 550',
    'set targetDrafts to drafts of senderAccount',
    draft.html
      ? `set draftMessage to make new outgoing message at targetDrafts with properties {subject:${appleScriptString(draft.subject)}, content:${appleScriptString(draft.html)}, account:senderAccount}`
      : `set draftMessage to make new outgoing message at targetDrafts with properties {subject:${appleScriptString(draft.subject)}, plain text content:${appleScriptString(draft.body)}, account:senderAccount}`,
  ];
  for (const address of draft.to) lines.push(`make new to recipient at draftMessage with properties {email address:{address:${appleScriptString(address)}}}`);
  for (const address of draft.cc) lines.push(`make new cc recipient at draftMessage with properties {email address:{address:${appleScriptString(address)}}}`);
  for (const address of draft.bcc) lines.push(`make new bcc recipient at draftMessage with properties {email address:{address:${appleScriptString(address)}}}`);
  for (const filePath of draft.attachments) lines.push(`make new attachment at draftMessage with properties {file:(POSIX file ${appleScriptString(filePath)} as alias)}`);
  lines.push('return "created|" & (subject of draftMessage)', 'end tell');
  return { script: lines.join('\n'), draft };
}

function appendExactAccountLookup(lines) {
  lines.push(
    'set senderAccount to missing value',
    'if default account is not missing value then',
    'ignoring case',
    'if (email address of default account as text) is requestedSender then set senderAccount to default account',
    'end ignoring',
    'end if',
    'if senderAccount is missing value then',
    'repeat with accountCandidate in exchange accounts',
    'ignoring case',
    'if (email address of accountCandidate as text) is requestedSender then set senderAccount to accountCandidate',
    'end ignoring',
    'end repeat',
    'end if',
    'if senderAccount is missing value then',
    'repeat with accountCandidate in imap accounts',
    'ignoring case',
    'if (email address of accountCandidate as text) is requestedSender then set senderAccount to accountCandidate',
    'end ignoring',
    'end repeat',
    'end if',
    'if senderAccount is missing value then',
    'repeat with accountCandidate in pop accounts',
    'ignoring case',
    'if (email address of accountCandidate as text) is requestedSender then set senderAccount to accountCandidate',
    'end ignoring',
    'end repeat',
    'end if',
    'if senderAccount is missing value then error "Das gewünschte Outlook-Absenderkonto ist über die native Schnittstelle nicht verfügbar." number 550',
  );
}

function appendExactListVerification(lines, { actualVariable, expectedVariable, label }) {
  lines.push(
    `if (count of ${actualVariable}) is not (count of ${expectedVariable}) then error "Outlook-Versand abgebrochen: ${label} stimmen nicht exakt überein." number 571`,
    `repeat with expectedItem in ${expectedVariable}`,
    'set exactMatches to 0',
    `repeat with actualItem in ${actualVariable}`,
    'ignoring case',
    'if (actualItem as text) is (expectedItem as text) then set exactMatches to exactMatches + 1',
    'end ignoring',
    'end repeat',
    `if exactMatches is not 1 then error "Outlook-Versand abgebrochen: ${label} stimmen nicht exakt überein." number 572`,
    'end repeat',
  );
}

export function buildVerifiedSendAppleScript(input = {}) {
  const message = normalizeDraftPayload(input);
  if (!message.attachments.length || message.attachments.some(file => path.extname(file).toLowerCase() !== '.xlsx')) {
    throw new Error('Outlook-Versand abgebrochen: Es sind ausschließlich eine oder mehrere XLSX-Anlagen zulässig.');
  }
  const expectedAttachmentNames = message.attachments.map(file => path.basename(file));
  if (new Set(expectedAttachmentNames).size !== expectedAttachmentNames.length) {
    throw new Error('Outlook-Versand abgebrochen: Doppelte XLSX-Anlagennamen sind nicht zulässig.');
  }
  const lines = [
    'tell application id "com.microsoft.Outlook"',
    `set requestedSender to ${appleScriptString(message.from)}`,
    `set requestedSubject to ${appleScriptString(message.subject)}`,
  ];
  appendExactAccountLookup(lines);
  lines.push(
    'set targetDrafts to drafts of senderAccount',
    message.html
      ? `set draftMessage to make new outgoing message at targetDrafts with properties {subject:requestedSubject, content:${appleScriptString(message.html)}, account:senderAccount}`
      : `set draftMessage to make new outgoing message at targetDrafts with properties {subject:requestedSubject, plain text content:${appleScriptString(message.body)}, account:senderAccount}`,
    'try',
  );
  for (const address of message.to) lines.push(`make new to recipient at draftMessage with properties {email address:{address:${appleScriptString(address)}}}`);
  for (const address of message.cc) lines.push(`make new cc recipient at draftMessage with properties {email address:{address:${appleScriptString(address)}}}`);
  for (const address of message.bcc) lines.push(`make new bcc recipient at draftMessage with properties {email address:{address:${appleScriptString(address)}}}`);
  for (const filePath of message.attachments) lines.push(`make new attachment at draftMessage with properties {file:(POSIX file ${appleScriptString(filePath)} as alias)}`);
  lines.push(
    'if (subject of draftMessage as text) is not requestedSubject then error "Outlook-Versand abgebrochen: Der Betreff stimmt nicht exakt überein." number 570',
    'set actualTo to {}',
    'repeat with recipientItem in (every to recipient of draftMessage)',
    'set end of actualTo to (address of email address of recipientItem as text)',
    'end repeat',
    `set expectedTo to {${message.to.map(appleScriptString).join(', ')}}`,
  );
  appendExactListVerification(lines, { actualVariable: 'actualTo', expectedVariable: 'expectedTo', label: 'An-Empfänger' });
  lines.push(
    'set actualCc to {}',
    'repeat with recipientItem in (every cc recipient of draftMessage)',
    'set end of actualCc to (address of email address of recipientItem as text)',
    'end repeat',
    `set expectedCc to {${message.cc.map(appleScriptString).join(', ')}}`,
  );
  appendExactListVerification(lines, { actualVariable: 'actualCc', expectedVariable: 'expectedCc', label: 'Cc-Empfänger' });
  lines.push(
    'set actualBcc to {}',
    'repeat with recipientItem in (every bcc recipient of draftMessage)',
    'set end of actualBcc to (address of email address of recipientItem as text)',
    'end repeat',
    `set expectedBcc to {${message.bcc.map(appleScriptString).join(', ')}}`,
  );
  appendExactListVerification(lines, { actualVariable: 'actualBcc', expectedVariable: 'expectedBcc', label: 'Bcc-Empfänger' });
  lines.push(
    'set actualAttachmentNames to {}',
    'repeat with attachmentItem in (every attachment of draftMessage)',
    'set end of actualAttachmentNames to (name of attachmentItem as text)',
    'end repeat',
    `set expectedAttachmentNames to {${expectedAttachmentNames.map(appleScriptString).join(', ')}}`,
  );
  appendExactListVerification(lines, { actualVariable: 'actualAttachmentNames', expectedVariable: 'expectedAttachmentNames', label: 'XLSX-Anlagen' });
  lines.push(
    'save draftMessage',
    'on error preflightError number preflightNumber',
    'try',
    'delete draftMessage',
    'end try',
    'error preflightError number preflightNumber',
    'end try',
    'try',
    'send draftMessage',
    'on error sendError number sendNumber',
    'error "IVA_SEND_ATTEMPTED|" & sendError number sendNumber',
    'end try',
    'return "sent|" & requestedSubject',
    'end tell',
  );
  return { script: lines.join('\n'), message, expectedAttachmentNames };
}

export function buildSentVerificationAppleScript({ from, subject, to = [], attachments = [], lookbackSeconds = 900 } = {}) {
  const requestedFrom = email(from, 'Absender');
  const requestedSubject = String(subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 240);
  const requestedTo = recipients(to, 'An');
  const expectedAttachments = [...new Set((Array.isArray(attachments) ? attachments : []).map(value => path.basename(String(value))))].sort();
  const seconds = Math.max(60, Math.min(3600, Number(lookbackSeconds) || 900));
  if (!requestedSubject || !requestedTo.length || !expectedAttachments.length) throw new Error('Die Gesendet-Prüfung benötigt Absender, Betreff, Empfänger und Anlagen.');
  const lines = [
    'tell application id "com.microsoft.Outlook"',
    `set requestedSender to ${appleScriptString(requestedFrom)}`,
    `set requestedSubject to ${appleScriptString(requestedSubject)}`,
    `set earliestTime to (current date) - ${seconds}`,
    'set senderAccount to missing value',
    'repeat with accountCandidate in exchange accounts',
    'ignoring case',
    'if (email address of accountCandidate as text) is requestedSender then set senderAccount to accountCandidate',
    'end ignoring',
    'end repeat',
    'if senderAccount is missing value then',
    'repeat with accountCandidate in imap accounts',
    'ignoring case',
    'if (email address of accountCandidate as text) is requestedSender then set senderAccount to accountCandidate',
    'end ignoring',
    'end repeat',
    'end if',
    'if senderAccount is missing value then',
    'repeat with accountCandidate in pop accounts',
    'ignoring case',
    'if (email address of accountCandidate as text) is requestedSender then set senderAccount to accountCandidate',
    'end ignoring',
    'end repeat',
    'end if',
    'if senderAccount is missing value then error "Gesendet-Prüfung: Das Absenderkonto ist nicht verfügbar." number 560',
    'set targetSent to sent items of senderAccount',
    'set recentMatches to {}',
    'repeat 20 times',
    'set recentMatches to {}',
    'repeat with candidate in (every outgoing message of targetSent whose subject is requestedSubject)',
    'if (time sent of candidate) is greater than or equal to earliestTime and (was sent of candidate) is true then set end of recentMatches to candidate',
    'end repeat',
    'if (count of recentMatches) is 1 then exit repeat',
    'if (count of recentMatches) > 1 then error "Gesendet-Prüfung: Mehrere neue Nachrichten mit demselben Betreff gefunden." number 561',
    'delay 1',
    'end repeat',
    'if (count of recentMatches) is not 1 then error "Gesendet-Prüfung: Die Nachricht wurde nicht eindeutig im Gesendet-Ordner gefunden." number 562',
    'set sentMessage to item 1 of recentMatches',
    'set recipientAddresses to {}',
    'repeat with recipientItem in (every to recipient of sentMessage)',
    'set end of recipientAddresses to (address of email address of recipientItem as text)',
    'end repeat',
    'set attachmentNames to {}',
    'repeat with attachmentItem in (every attachment of sentMessage)',
    'set end of attachmentNames to (name of attachmentItem as text)',
    'end repeat',
    'set AppleScript\'s text item delimiters to tab',
    'set recipientText to recipientAddresses as text',
    'set attachmentText to attachmentNames as text',
    'set AppleScript\'s text item delimiters to ""',
    'return (subject of sentMessage as text) & linefeed & recipientText & linefeed & attachmentText',
    'end tell',
  ];
  return { script: lines.join('\n'), expected: { from: requestedFrom, subject: requestedSubject, to: requestedTo, attachments: expectedAttachments } };
}

export async function verifyOutlookSentMessage(input = {}) {
  const { script, expected } = buildSentVerificationAppleScript(input);
  const output = await runAppleScript(script, { timeoutMs: 30000 });
  const [subject = '', recipientLine = '', attachmentLine = ''] = output.split(/\r?\n/);
  const actualRecipients = recipientLine.split('\t').map(email => email.trim().toLowerCase()).filter(Boolean).sort();
  const actualAttachments = attachmentLine.split('\t').map(name => name.trim()).filter(Boolean).sort();
  if (subject !== expected.subject) throw new Error('Gesendet-Prüfung: Der Betreff stimmt nicht exakt überein.');
  if (!expected.to.every(address => actualRecipients.includes(address))) throw new Error('Gesendet-Prüfung: Der An-Empfänger stimmt nicht exakt überein.');
  if (JSON.stringify(actualAttachments) !== JSON.stringify(expected.attachments)) {
    throw new Error('Gesendet-Prüfung: Die Anlagen stimmen nicht exakt mit dem versendeten Manifest überein.');
  }
  return { verified: true, folder: 'Gesendet', subject, recipients: actualRecipients, attachments: actualAttachments };
}

function normalizeDeleteEntries(entries = []) {
  if (!Array.isArray(entries) || !entries.length) return [];
  if (entries.length > 100) throw new Error('Rückgängig-Abbruch: Es dürfen höchstens 100 Entwürfe in einem Lauf entfernt werden.');
  return entries.map(entry => {
    const marker = String(entry?.marker || '').trim();
    const subject = String(entry?.subject || '').trim();
    if (!/^IVA-FUNDING-DRAFT:[0-9a-f-]{36}:[0-9a-f-]{36}$/i.test(marker)) throw new Error('Rückgängig-Abbruch: Ungültige IVA-Entwurfkennung.');
    if (!subject) throw new Error('Rückgängig-Abbruch: Entwurf ohne Betreff kann nicht sicher entfernt werden.');
    return { marker, subject };
  });
}

export function buildDeleteDraftsAppleScript({ from, entries = [] } = {}) {
  const requestedFrom = email(from, 'Absender');
  const normalizedEntries = normalizeDeleteEntries(entries);
  const markerList = normalizedEntries.map(entry => appleScriptString(entry.marker)).join(', ');
  const lines = [
    'tell application id "com.microsoft.Outlook"',
    `set requestedSender to ${appleScriptString(requestedFrom)}`,
    'set senderAccount to missing value',
    'repeat with accountCandidate in exchange accounts',
    'ignoring case',
    'if (email address of accountCandidate as text) is requestedSender then set senderAccount to accountCandidate',
    'end ignoring',
    'end repeat',
    'if senderAccount is missing value then',
    'repeat with accountCandidate in imap accounts',
    'ignoring case',
    'if (email address of accountCandidate as text) is requestedSender then set senderAccount to accountCandidate',
    'end ignoring',
    'end repeat',
    'end if',
    'if senderAccount is missing value then',
    'repeat with accountCandidate in pop accounts',
    'ignoring case',
    'if (email address of accountCandidate as text) is requestedSender then set senderAccount to accountCandidate',
    'end ignoring',
    'end repeat',
    'end if',
    'if senderAccount is missing value then error "Das gewünschte Outlook-Absenderkonto ist über die native Schnittstelle nicht verfügbar." number 550',
    'set targetDrafts to drafts of senderAccount',
    `set markerList to {${markerList}}`,
    'set deletedMarkers to {}',
    'repeat with markerText in markerList',
    'set matchesForMarker to {}',
    'repeat with draftMessage in (every outgoing message of targetDrafts)',
    'if ((content of draftMessage as text) contains (markerText as text)) then set end of matchesForMarker to draftMessage',
    'end repeat',
    'if (count of matchesForMarker) > 1 then error "Rückgängig-Abbruch: IVA-Kennung ist in mehreren Entwürfen vorhanden." number 551',
    'if (count of matchesForMarker) is 1 then',
    'delete item 1 of matchesForMarker',
    'set end of deletedMarkers to (markerText as text)',
    'end if',
    'end repeat',
    'set AppleScript\'s text item delimiters to linefeed',
    'set resultText to deletedMarkers as text',
    'set AppleScript\'s text item delimiters to ""',
    'return resultText',
    'end tell',
  ];
  return { script: lines.join('\n'), entries: normalizedEntries, from: requestedFrom };
}

export function runAppleScript(script, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Outlook-Automation hat das Zeitlimit überschritten. Möglicherweise wartet macOS auf eine Freigabe.'));
    }, timeoutMs);
    child.stdout.on('data', chunk => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error((stderr || stdout || `osascript beendet mit Code ${code}`).trim()));
    });
    child.stdin.end(script);
  });
}

export async function createOutlookDraft(input = {}) {
  const { script, draft } = buildDraftAppleScript(input);
  await validateAttachmentPaths(draft.attachments);
  const diagnosis = await diagnoseOutlook();
  if (!diagnosis.outlook.installed || !diagnosis.outlook.running) {
    throw new Error('Microsoft Outlook ist nicht geöffnet. Es wurde kein Entwurf erstellt.');
  }
  if (!diagnosis.capabilities.createAccountDraft && diagnosis.capabilities.sharedSenderUiPrerequisitesReady) {
    const result = await createOutlookDraftViaUi(draft);
    return {
      ...result,
      recipients: { to: draft.to, cc: draft.cc, bcc: draft.bcc },
      attachmentCount: draft.attachments.length,
      requestedFrom: draft.from || null,
      senderSelectionRequired: false,
      sent: false,
    };
  }
  if (!diagnosis.capabilities.createAccountDraft) {
    throw new Error('Outlook kann das gewünschte Absenderkonto weder nativ noch über die freigegebene macOS-Oberfläche sicher ansprechen. Es wurde nichts erstellt.');
  }
  const result = await runAppleScript(script, { timeoutMs: 30000 });
  return {
    created: result.startsWith('created|'),
    subject: draft.subject,
    recipients: { to: draft.to, cc: draft.cc, bcc: draft.bcc },
    attachmentCount: draft.attachments.length,
    requestedFrom: draft.from || null,
    senderSelectionRequired: false,
    sent: false,
    channel: 'outlook-applescript',
  };
}

export async function sendVerifiedOutlookXlsxMessage(input = {}) {
  const message = normalizeDraftPayload(input);
  if (!message.attachments.length || message.attachments.some(file => path.extname(file).toLowerCase() !== '.xlsx')) {
    throw new Error('Outlook-Versand abgebrochen: Es sind ausschließlich eine oder mehrere XLSX-Anlagen zulässig.');
  }
  await validateAttachmentPaths(message.attachments);
  const diagnosis = await diagnoseOutlook();
  if (!diagnosis.outlook.installed || !diagnosis.outlook.running) {
    throw new Error('Microsoft Outlook ist nicht geöffnet. Es wurde nichts versendet.');
  }
  let sent;
  if (diagnosis.capabilities.sharedSenderUiPrerequisitesReady) {
    sent = await sendVerifiedOutlookXlsxMessageViaUi(message);
  } else if (diagnosis.outlook.available) {
    const { script } = buildVerifiedSendAppleScript(message);
    let output = '';
    let sendAttemptError = '';
    try {
      output = await runAppleScript(script, { timeoutMs: 120000 });
    } catch (error) {
      if (!String(error?.message || error).includes('IVA_SEND_ATTEMPTED|')) throw error;
      sendAttemptError = String(error?.message || error).slice(0, 500);
    }
    if (!sendAttemptError && !output.startsWith('sent|')) {
      throw new Error('Outlook-Versand abgebrochen: Die native Schnittstelle hat den Versand nicht bestätigt.');
    }
    sent = {
      sent: true,
      channel: 'outlook-applescript-exact-account',
      verifiedBeforeSend: true,
      sendAttemptError,
    };
  } else {
    throw new Error('Outlook-Versand abgebrochen: Weder das exakte Outlook-Konto noch die freigegebene macOS-Oberflächenprüfung ist verfügbar.');
  }
  try {
    const sentFolder = await verifyOutlookSentMessage(message);
    return { ...sent, sentFolderVerified: true, sentFolder };
  } catch (error) {
    return {
      ...sent,
      sentFolderVerified: false,
      sentFolderVerificationError: String(error?.message || error).slice(0, 500),
    };
  }
}

export async function deleteOutlookDrafts(input = {}) {
  const { script, entries, from } = buildDeleteDraftsAppleScript(input);
  if (!entries.length) return { deletedMarkers: [], missingMarkers: [], recoverableFromDeletedItems: true, sent: false };
  const diagnosis = await diagnoseOutlook();
  if (!diagnosis.outlook.installed || !diagnosis.outlook.running) {
    throw new Error('Rückgängig-Abbruch: Microsoft Outlook ist nicht geöffnet.');
  }
  if (!diagnosis.capabilities.createAccountDraft && diagnosis.capabilities.sharedSenderUiPrerequisitesReady) {
    return deleteOutlookDraftsViaUi({ from, entries });
  }
  if (!diagnosis.capabilities.createAccountDraft) {
    throw new Error('Rückgängig-Abbruch: Das Outlook-Entwurfskonto kann nicht sicher angesprochen werden.');
  }
  const output = await runAppleScript(script, { timeoutMs: 30000 });
  const deletedMarkers = output.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  return {
    deletedMarkers,
    missingMarkers: entries.filter(entry => !deletedMarkers.includes(entry.marker)).map(entry => entry.marker),
    channel: 'outlook-applescript',
    recoverableFromDeletedItems: true,
    sent: false,
  };
}

export async function updateOutlookDraft(input = {}) {
  const draft = normalizeDraftPayload(input);
  await validateAttachmentPaths(draft.attachments);
  const diagnosis = await diagnoseOutlook();
  if (!diagnosis.outlook.installed || !diagnosis.outlook.running) {
    throw new Error('Microsoft Outlook ist nicht geöffnet. Es wurde kein Entwurf aktualisiert.');
  }
  if (!diagnosis.capabilities.sharedSenderUiPrerequisitesReady) {
    throw new Error('Outlook kann den vorhandenen Entwurf nicht über die freigegebene macOS-Oberfläche aktualisieren.');
  }
  return updateOutlookDraftViaUi(draft);
}

export async function updateOutlookDrafts(inputs = [], { onProgress } = {}) {
  const drafts = (Array.isArray(inputs) ? inputs : []).map(input => normalizeDraftPayload(input));
  if (!drafts.length) return { requested: 0, updated: 0, failed: 0, results: [], sent: false };
  for (const draft of drafts) await validateAttachmentPaths(draft.attachments);
  const diagnosis = await diagnoseOutlook();
  if (!diagnosis.outlook.installed || !diagnosis.outlook.running) {
    throw new Error('Microsoft Outlook ist nicht geöffnet. Es wurden keine Entwürfe aktualisiert.');
  }
  if (!diagnosis.capabilities.sharedSenderUiPrerequisitesReady) {
    throw new Error('Outlook kann vorhandene Entwürfe nicht über die freigegebene macOS-Oberfläche aktualisieren.');
  }
  return updateOutlookDraftsViaUi(drafts, { onProgress });
}

async function commandSucceeds(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
}

export async function diagnoseOutlook() {
  const installed = await commandSucceeds('/bin/test', ['-d', OUTLOOK_APP]);
  const running = await commandSucceeds('/usr/bin/pgrep', ['-x', 'Microsoft Outlook']);
  let appleScript = { available: false, version: null, defaultAccountAvailable: false, accountCount: 0, error: null };
  if (installed && running) {
    const diagnosticScript = `tell application id "com.microsoft.Outlook"
set accountTotal to (count of exchange accounts) + (count of imap accounts) + (count of pop accounts)
set hasDefault to default account is not missing value
return (version as text) & "|" & (accountTotal as text) & "|" & (hasDefault as text)
end tell`;
    try {
      const [version, accountCount, hasDefault] = (await runAppleScript(diagnosticScript, { timeoutMs: 8000 })).split('|');
      appleScript = { available: true, version, accountCount: Number(accountCount || 0), defaultAccountAvailable: hasDefault === 'true', error: null };
    } catch (error) {
      appleScript.error = error.message;
    }
  }
  let accessibilityEnabled = false;
  try {
    accessibilityEnabled = (await runAppleScript('tell application "System Events" to return UI elements enabled', { timeoutMs: 5000 })) === 'true';
  } catch {}
  return {
    platform: process.platform,
    outlook: { installed, running, bundleId: 'com.microsoft.Outlook', ...appleScript },
    accessibility: {
      enabled: accessibilityEnabled,
      settingsPath: 'Systemeinstellungen → Datenschutz & Sicherheit → Bedienungshilfen',
    },
    capabilities: {
      createLocalDraft: accessibilityEnabled,
      createAccountDraft: installed && running && appleScript.available && (appleScript.defaultAccountAvailable || appleScript.accountCount > 0),
      chooseSharedSenderAutomatically: appleScript.defaultAccountAvailable || accessibilityEnabled,
      sharedSenderUiPrerequisitesReady: accessibilityEnabled,
      readVisibleOutlookUi: accessibilityEnabled,
      sendMail: false,
      sendVerifiedXlsxMail: installed && running && (accessibilityEnabled || appleScript.available),
    },
  };
}
