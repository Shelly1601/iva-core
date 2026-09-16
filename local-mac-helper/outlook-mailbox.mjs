import { runAppleScript } from './outlook.mjs';
import { assertImacExecutionHost } from './imac-host-guard.mjs';

export const FUNDING_MAILBOX_ADDRESS = 'foerderung@heat-hero.com';
const MAX_METADATA_ROWS = 20000;
const LIMITATIONS = Object.freeze([
  'Erfasst native Posteingangs-Metadaten; Mailtext und Anlageninhalte werden hier nicht gelesen oder als verarbeitet bestätigt.',
  'Outlook stellt keinen lesenden Delta-/Sync-Token bereit. Ein inkrementeller Lauf erkennt neue Eingangszeitpunkte, aber keine erst später synchronisierten Alt-Mails vor dem gespeicherten Checkpoint.',
]);
const fail = (code, message) => Object.assign(new Error(message), { code, source: 'outlook-native', coverageVerified: false, complete: false });
const epoch = value => Math.floor(Date.parse(value) / 1000);
const iso = seconds => new Date(seconds * 1000).toISOString();
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const order = (a, b) => b.receivedEpoch - a.receivedEpoch || b.nativeId.localeCompare(a.nativeId, 'en', { numeric: true });
const clean = (value, maximum) => String(value || '').replace(/[\r\n\t\u0000]+/g, ' ').trim().slice(0, maximum);
const description = item => `Absender: ${clean(item.sender, 254)}, Betreff: ${clean(item.subject, 240) || 'Kein Betreff'}, ${new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: '2-digit' }).format(new Date(item.receivedEpoch * 1000))}, ${item.attachmentCount ? 'Hat Dateien' : 'Keine Anlagen gemeldet'}`;

function dateBoundary(value) {
  if (!value) return null;
  // A requested calendar date starts at midnight in the workflow's Berlin zone.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const midnight = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== value) throw fail('OUTLOOK_MAILBOX_BAD_RANGE', 'Der Starttag des Postfachlaufs ist ungültig.');
    const offset = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' }).format(midnight));
    return Math.floor(midnight.getTime() / 1000) - offset * 3600;
  }
  const parsed = epoch(value);
  if (!Number.isFinite(parsed)) throw fail('OUTLOOK_MAILBOX_BAD_RANGE', 'Der Startzeitpunkt des Postfachlaufs ist ungültig.');
  return parsed;
}

function decode(value) {
  try {
    if (typeof value !== 'string' || value.length > 3000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error();
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (cursor.version !== 1 || cursor.mailbox !== FUNDING_MAILBOX_ADDRESS || cursor.folder !== 'Posteingang'
      || !['page', 'checkpoint'].includes(cursor.kind) || !Number.isInteger(cursor.since) || cursor.since < 0
      || !/^\d+$/.test(cursor.accountId || '') || !/^\d+$/.test(cursor.folderId || '')) throw Error();
    if (cursor.kind === 'page' && (!Number.isInteger(cursor.until) || cursor.until < cursor.since || !Number.isInteger(cursor.after?.receivedEpoch)
      || !/^\d+$/.test(cursor.after?.nativeId || '') || cursor.after.receivedEpoch < cursor.since || cursor.after.receivedEpoch > cursor.until)) throw Error();
    return cursor;
  } catch { throw fail('OUTLOOK_MAILBOX_BAD_CURSOR', 'Der gespeicherte Postfach-Cursor ist ungültig oder gehört zu einem anderen Postfach.'); }
}

/** Scripting properties are documented in the installed Outlook.sdef. Only get
 * operations are used; no activate, select, open, sync, read-flag or send. */
export function buildFundingMailboxReadScript({ since, until, nativeId = '' }) {
  if (![since, until].every(Number.isInteger) || since < 0 || until < since) throw fail('OUTLOOK_MAILBOX_BAD_RANGE', 'Der Postfach-Zeitraum ist ungültig.');
  if (nativeId && !/^\d{1,20}$/.test(nativeId)) throw fail('OUTLOOK_MAILBOX_BAD_ID', 'Die native Nachrichten-ID ist ungültig.');
  return `on safeCell(inputValue)
  set cellText to inputValue as text
  set AppleScript's text item delimiters to {tab, return, linefeed}
  set cellParts to text items of cellText
  set AppleScript's text item delimiters to " "
  set cellText to cellParts as text
  set AppleScript's text item delimiters to ""
  if length of cellText > 254 then set cellText to text 1 thru 254 of cellText
  return cellText
end safeCell
if application id "com.microsoft.Outlook" is not running then error "IVA_OUTLOOK_NOT_RUNNING"
set unixNow to (do shell script "/bin/date +%s") as real
set localNow to current date
set lowerBound to localNow + (${since} - unixNow)
set upperBound to localNow + (${until} - unixNow)
tell application id "com.microsoft.Outlook"
  if working offline then error "IVA_OUTLOOK_OFFLINE"
  set accountMatches to {}
  set availableAccounts to (every exchange account) & (every imap account) & (every pop account)
  repeat with candidateAccount in availableAccounts
    ignoring case
      if (email address of candidateAccount as text) is "${FUNDING_MAILBOX_ADDRESS}" then set end of accountMatches to candidateAccount
    end ignoring
  end repeat
  if (count of accountMatches) is not 1 then error "IVA_OUTLOOK_ACCOUNT_UNAVAILABLE"
  set targetAccount to item 1 of accountMatches
  if (class of targetAccount) is exchange account then
    if not (is connected of targetAccount) then error "IVA_OUTLOOK_OFFLINE"
  end if
  set targetInbox to inbox of targetAccount
  if targetInbox is missing value then error "IVA_OUTLOOK_ACCOUNT_UNAVAILABLE"
  set accountRecordId to id of targetAccount as text
  set folderRecordId to id of targetInbox as text
  set metadataMessages to ${nativeId ? `(every message of targetInbox whose id is ${nativeId})` : '(every message of targetInbox whose time received is greater than or equal to lowerBound and time received is less than or equal to upperBound)'}
  set metadataCount to count of metadataMessages
  if metadataCount > ${MAX_METADATA_ROWS} then error "IVA_OUTLOOK_METADATA_LIMIT"
  set resultRows to {"IVA_MAILBOX_V1" & tab & accountRecordId & tab & folderRecordId & tab & metadataCount}
  repeat with candidateMessage in metadataMessages
    set nativeRecordId to id of candidateMessage as text
    set receivedEpoch to unixNow + ((time received of candidateMessage) - localNow)
    set attachmentCount to count of attachments of candidateMessage
    set messageSender to my safeCell(address of sender of candidateMessage)
    set messageSubject to my safeCell(subject of candidateMessage)
    set end of resultRows to nativeRecordId & tab & (receivedEpoch as integer) & tab & attachmentCount & tab & messageSender & tab & messageSubject & tab & "IVA_END"
  end repeat
  set AppleScript's text item delimiters to linefeed
  set outputText to resultRows as text
  set AppleScript's text item delimiters to ""
  return outputText
end tell`;
}

export function parseFundingMailboxMetadata(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > 1024 * 1024) throw fail('OUTLOOK_MAILBOX_INVALID_DATA', 'Outlook lieferte keinen vollständig prüfbaren Metadatenstand.');
  const lines = output.trim().split(/\r?\n/), [version, accountId, folderId, countText] = lines.shift().split('\t');
  if (version !== 'IVA_MAILBOX_V1' || !/^\d+$/.test(accountId) || !/^\d+$/.test(folderId) || !/^\d+$/.test(countText)) throw fail('OUTLOOK_MAILBOX_INVALID_DATA', 'Der native Postfachnachweis ist unvollständig.');
  const count = Number(countText);
  if (count > MAX_METADATA_ROWS || count !== lines.length) throw fail('OUTLOOK_MAILBOX_INVALID_DATA', 'Die native Nachrichtenliste wurde abgeschnitten; der Lauf bleibt offen.');
  const seen = new Set();
  const messages = lines.map(line => {
    const values = line.split('\t'), [nativeId, received, attachments, sender, subject, end] = values;
    if (values.length !== 6 || end !== 'IVA_END' || !/^\d+$/.test(nativeId) || !/^\d+$/.test(received) || !/^\d+$/.test(attachments) || seen.has(nativeId)) throw fail('OUTLOOK_MAILBOX_INVALID_DATA', 'Eine native Nachrichten-ID oder Eingangszeit ist nicht eindeutig lesbar.');
    seen.add(nativeId);
    const receivedEpoch = Number(received), attachmentCount = Number(attachments);
    if (!Number.isSafeInteger(receivedEpoch) || receivedEpoch > 8640000000000 || !Number.isSafeInteger(attachmentCount)) throw fail('OUTLOOK_MAILBOX_INVALID_DATA', 'Eine native Eingangszeit oder Anlagenzahl ist ungültig.');
    return { nativeId, receivedEpoch, attachmentCount, sender: clean(sender, 254), subject: clean(subject, 240) };
  });
  return { accountId, folderId, messages };
}

export function createOutlookMailboxReader({ execute = runAppleScript, now = () => Date.now(), assertHost = assertImacExecutionHost } = {}) {
  return async function readFundingMailboxPage({ from = FUNDING_MAILBOX_ADDRESS, folder = 'Posteingang', since = null, cursor = null, limit = 100, mode = 'incremental' } = {}) {
    if (String(from).toLowerCase() !== FUNDING_MAILBOX_ADDRESS || folder !== 'Posteingang') throw fail('OUTLOOK_MAILBOX_SCOPE_DENIED', 'Dieser Reader liest ausschließlich den Förderungs-Posteingang.');
    if (!['initial-backfill', 'incremental'].includes(mode)) throw fail('OUTLOOK_MAILBOX_BAD_MODE', 'Der Postfachmodus ist ungültig.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw fail('OUTLOOK_MAILBOX_BAD_LIMIT', 'Eine Postfachseite benötigt 1 bis 200 Nachrichten.');
    const state = cursor ? decode(cursor) : null;
    const sinceArgument = dateBoundary(since), reference = Math.floor(Number(now()) / 1000);
    if (!Number.isFinite(reference)) throw fail('OUTLOOK_MAILBOX_BAD_RANGE', 'Der aktuelle Prüfzeitpunkt fehlt.');
    if (state?.kind === 'page' && sinceArgument !== null && sinceArgument !== state.since) throw fail('OUTLOOK_MAILBOX_BAD_CURSOR', 'Der Zeitraum wurde während einer laufenden Postfachabfrage verändert.');
    if (state?.kind === 'checkpoint' && mode !== 'incremental') throw fail('OUTLOOK_MAILBOX_BAD_CURSOR', 'Ein abgeschlossener Checkpoint ist ausschließlich für den nächsten inkrementellen Lauf bestimmt.');
    const lower = state?.since ?? sinceArgument;
    if (lower === null) throw fail('OUTLOOK_MAILBOX_START_REQUIRED', 'Dem ersten Postfachlauf fehlt ein Startdatum; spätere Läufe benötigen den gespeicherten Checkpoint.');
    const upper = state?.kind === 'page' ? state.until : reference;
    if (lower > upper || upper > reference + 60) throw fail('OUTLOOK_MAILBOX_BAD_RANGE', 'Der gespeicherte Postfach-Zeitraum liegt in der Zukunft.');
    await assertHost();
    let raw;
    try { raw = await execute(buildFundingMailboxReadScript({ since: lower, until: upper }), { timeoutMs: 45000 }); }
    catch (error) {
      const reason = String(error?.message || '');
      if (/IVA_OUTLOOK_ACCOUNT_UNAVAILABLE/.test(reason)) throw fail('OUTLOOK_NATIVE_MAILBOX_UNAVAILABLE', 'Die laufende Outlook-App gibt das eingerichtete Förderkonto nicht über ihre native Leseschnittstelle frei. Das bedeutet keinen leeren Posteingang. Der Lauf bleibt offen; ein bereits verbundener Mail-API-Zugang für genau dieses Konto wird benötigt.');
      if (/IVA_OUTLOOK_OFFLINE/.test(reason)) throw fail('OUTLOOK_MAILBOX_OFFLINE', 'Outlook ist offline. Ein aktueller vollständiger Postfachstand ist nicht belegt.');
      if (/IVA_OUTLOOK_NOT_RUNNING/.test(reason)) throw fail('OUTLOOK_MAILBOX_NOT_RUNNING', 'Die native Outlook-App ist nicht geöffnet.');
      if (/IVA_OUTLOOK_METADATA_LIMIT/.test(reason)) throw fail('OUTLOOK_MAILBOX_TOO_LARGE', 'Der native Zeitraum enthält mehr als 20.000 Nachrichten; ohne geeignete Mail-API wird kein vollständiger Scan behauptet.');
      throw fail('OUTLOOK_MAILBOX_READ_FAILED', 'Der native Outlook-Lesezugriff hat nicht zuverlässig geantwortet. Der gespeicherte Cursor bleibt unverändert; es wurde keine Nachricht bearbeitet.');
    }
    const metadata = parseFundingMailboxMetadata(raw);
    if (state && (state.accountId !== metadata.accountId || state.folderId !== metadata.folderId)) throw fail('OUTLOOK_MAILBOX_IDENTITY_CHANGED', 'Die native Konto- oder Posteingangskennung hat sich geändert. Der gespeicherte Nachrichtenbestand muss vor einer Fortsetzung zugeordnet werden.');
    if (metadata.messages.some(item => item.receivedEpoch < lower || item.receivedEpoch > upper)) throw fail('OUTLOOK_MAILBOX_INVALID_DATA', 'Outlook lieferte Nachrichten außerhalb des angefragten Zeitraums.');
    const ordered = metadata.messages.sort(order).filter(item => state?.kind !== 'page' || order(item, state.after) > 0);
    const selected = ordered.slice(0, limit), complete = selected.length === ordered.length;
    const base = { version: 1, mailbox: FUNDING_MAILBOX_ADDRESS, folder, accountId: metadata.accountId, folderId: metadata.folderId };
    const nextCursor = complete ? null : encode({ ...base, kind: 'page', since: lower, until: upper, after: { nativeId: selected.at(-1).nativeId, receivedEpoch: selected.at(-1).receivedEpoch } });
    return {
      messages: selected.map(item => ({ messageId: `outlook:${metadata.accountId}:${item.nativeId}`, receivedAt: iso(item.receivedEpoch),
        description: description(item),
        hasAttachments: item.attachmentCount > 0 })),
      nextCursor, complete, coverageVerified: true, source: 'outlook-native',
      checkpoint: complete ? encode({ ...base, kind: 'checkpoint', since: upper }) : null,
      coverage: { since: iso(lower), until: iso(upper), scope: 'native-inbox-metadata', nativeRows: metadata.messages.length },
      limitations: [...LIMITATIONS],
    };
  };
}

const readNativeFundingMailboxPage = createOutlookMailboxReader();
async function readLegacyFundingMailboxPage(input = {}) {
  let uiCursor = false;
  try { uiCursor = input.cursor && JSON.parse(Buffer.from(input.cursor, 'base64url').toString()).source === 'outlook-ui-mime'; } catch { /* native validation reports malformed cursors */ }
  if (!uiCursor) {
    try { return await readNativeFundingMailboxPage(input); }
    catch (error) { if (error.code !== 'OUTLOOK_NATIVE_MAILBOX_UNAVAILABLE') throw error; }
  }
  const { readFundingMailboxPageViaUi } = await import('./outlook-ui-mailbox.mjs');
  return readFundingMailboxPageViaUi(input);
}

export function createOutlookMailboxMessageReader({ execute = runAppleScript, now = () => Date.now(), assertHost = assertImacExecutionHost } = {}) {
  return async function readFundingMailboxMessage({ from = FUNDING_MAILBOX_ADDRESS, folder = 'Posteingang', messageId } = {}) {
    if (String(from).toLowerCase() !== FUNDING_MAILBOX_ADDRESS || folder !== 'Posteingang') throw fail('OUTLOOK_MAILBOX_SCOPE_DENIED', 'Dieser Reader liest ausschließlich den Förderungs-Posteingang.');
    const match = String(messageId || '').match(/^outlook:(\d{1,20}):(\d{1,20})$/);
    if (!match) throw fail('OUTLOOK_MAILBOX_BAD_ID', 'Die gespeicherte Nachrichten-ID gehört nicht zum nativen Outlook-Reader.');
    await assertHost();
    let raw;
    try { raw = await execute(buildFundingMailboxReadScript({ since: 0, until: Math.floor(Number(now()) / 1000), nativeId: match[2] }), { timeoutMs: 30000 }); }
    catch { throw fail('OUTLOOK_MAILBOX_READ_FAILED', 'Die gespeicherte Nachricht konnte nicht zuverlässig über die native Outlook-Schnittstelle gelesen werden. Der offene Eintrag bleibt erhalten.'); }
    const metadata = parseFundingMailboxMetadata(raw);
    if (metadata.accountId !== match[1]) throw fail('OUTLOOK_MAILBOX_IDENTITY_CHANGED', 'Die native Kontokennung passt nicht zur gespeicherten Nachricht.');
    const item = metadata.messages.find(row => row.nativeId === match[2]);
    if (!item || metadata.messages.length !== 1) throw fail('OUTLOOK_MAILBOX_MESSAGE_NOT_FOUND', 'Die gespeicherte Nachricht ist im Förderungs-Posteingang nicht mehr eindeutig vorhanden. Ein Verschieben oder Bearbeiten wird daraus nicht abgeleitet.');
    return { messageId, receivedAt: iso(item.receivedEpoch), description: description(item), hasAttachments: item.attachmentCount > 0, source: 'outlook-native' };
  };
}

const readNativeFundingMailboxMessage = createOutlookMailboxMessageReader();
async function readLegacyFundingMailboxMessage(input = {}) {
  if (String(input.messageId || '').startsWith('<')) {
    const { readByMessageId } = await import('./outlook-ui-mailbox.mjs');
    const result = await readByMessageId(input);
    if (result.notFound) throw fail('OUTLOOK_MAILBOX_MESSAGE_NOT_FOUND', 'Die offene Originalmail ist nicht mehr eindeutig im Posteingang vorhanden.');
    return result;
  }
  return readNativeFundingMailboxMessage(input);
}

function cursorTransport(cursor) {
  if (!cursor) return null;
  if (typeof cursor !== 'string' || cursor.length > 8000 || /[\r\n\0]/.test(cursor)) throw fail('FUNDING_MAIL_BAD_CURSOR', 'Der gespeicherte Postfach-Cursor ist ungültig.');
  if (/^msgraph:[A-Za-z0-9_-]+$/.test(cursor)) return 'microsoft-graph';
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (value.source === 'outlook-ui-mime') return 'outlook-ui-mime';
    if (value.version === 1 && value.mailbox === FUNDING_MAILBOX_ADDRESS) return 'outlook-native';
  } catch { /* Malformed legacy cursors never become a new Graph scan. */ }
  throw fail('FUNDING_MAIL_BAD_CURSOR', 'Der gespeicherte Postfach-Cursor gehört zu keinem unterstützten Leseweg.');
}
const directCall = (name, input) => import('./background-integrations.mjs').then(module => module[name](input));

export function createFundingMailboxTransport({
  getStatus = input => directCall('microsoftFundingMailStatus', input),
  readGraphPage = input => directCall('readMicrosoftFundingPage', input),
  readGraphMessage = input => directCall('readMicrosoftFundingMessage', input),
  readLegacyPage = readLegacyFundingMailboxPage, readLegacyMessage = readLegacyFundingMailboxMessage,
  now = Date.now, statusTtlMs = 60000,
} = {}) {
  let cached;
  async function status() {
    if (!cached || cached.expiresAt <= now()) {
      const value = { expiresAt: now() + statusTtlMs, promise: Promise.resolve().then(() => getStatus({ probe: true })) };
      cached = value;
      value.promise.catch(() => { if (cached === value) value.expiresAt = now() + Math.min(statusTtlMs, 15000); });
    }
    return cached.promise;
  }
  async function select({ cursor, messageId } = {}) {
    const source = cursorTransport(cursor), available = await status();
    if (source && source !== 'microsoft-graph' && available?.ready === true)
      throw fail('FUNDING_MAIL_TRANSPORT_MIGRATION_REQUIRED', 'Der gespeicherte Outlook-Cursor gehört zum bisherigen Leseweg. Vor dem Wechsel zu M365 ist eine ausdrücklich geprüfte Cursor-Migration erforderlich; der alte Stand bleibt erhalten.');
    if (source === 'microsoft-graph' && available?.ready !== true)
      throw fail('FUNDING_MAIL_GRAPH_UNAVAILABLE', 'Der gespeicherte M365-Lauf benötigt seinen verbundenen M365-Zugang. Es wird kein anderer Leseweg mit diesem Cursor gestartet.');
    if (available?.ready === true) {
      if (messageId && !/^<[^<>\r\n\0]+>$/.test(String(messageId))) throw fail('FUNDING_MAIL_ID_MIGRATION_REQUIRED', 'Für den direkten M365-Zugriff wird die Original-Message-ID benötigt; eine native Outlook-Datensatz-ID kann nicht übernommen werden.');
      return 'microsoft-graph';
    }
    return source || 'outlook-native';
  }
  return {
    select,
    async readPage(input = {}) {
      if (String(input.from || FUNDING_MAILBOX_ADDRESS).toLowerCase() !== FUNDING_MAILBOX_ADDRESS || (input.folder || 'Posteingang') !== 'Posteingang')
        throw fail('OUTLOOK_MAILBOX_SCOPE_DENIED', 'Dieser Reader liest ausschließlich den Förderungs-Posteingang.');
      const source = await select(input);
      return source === 'microsoft-graph' ? readGraphPage(input) : readLegacyPage(input);
    },
    async readMessage(input = {}) {
      if (String(input.from || FUNDING_MAILBOX_ADDRESS).toLowerCase() !== FUNDING_MAILBOX_ADDRESS) throw fail('OUTLOOK_MAILBOX_SCOPE_DENIED', 'Dieser Reader liest ausschließlich das Förderpostfach.');
      const source = await select(input);
      return source === 'microsoft-graph' ? readGraphMessage(input) : readLegacyMessage(input);
    },
  };
}
const fundingMailboxTransport = createFundingMailboxTransport();
export const selectFundingMailboxTransport = input => fundingMailboxTransport.select(input);
export const readFundingMailboxPage = input => fundingMailboxTransport.readPage(input);
export const readFundingMailboxMessage = input => fundingMailboxTransport.readMessage(input);
