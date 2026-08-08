import { access, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';

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
  const result = await runAppleScript(script, { timeoutMs: 30000 });
  return {
    created: result.startsWith('created|'),
    subject: draft.subject,
    recipients: { to: draft.to, cc: draft.cc, bcc: draft.bcc },
    attachmentCount: draft.attachments.length,
    requestedFrom: draft.from || null,
    senderSelectionRequired: false,
    sent: false,
  };
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
      createLocalDraft: false,
      createAccountDraft: installed && running && appleScript.available && appleScript.accountCount > 0,
      chooseSharedSenderAutomatically: appleScript.defaultAccountAvailable,
      sharedSenderUiPrerequisitesReady: accessibilityEnabled,
      readVisibleOutlookUi: accessibilityEnabled,
      sendMail: false,
    },
  };
}
