import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { assertImacFundingHost } from './funding-workflows.mjs';
import { moveOutlookMessageToFolder } from './macos-ui.mjs';

export const FUNDING_MAILBOX = 'foerderung@heat-hero.com';
export const FUNDING_DONE_FOLDER = 'fertig';

function clean(value, max = 500) {
  return String(value || '').replace(/\u0000/g, '').trim().slice(0, max);
}

function stateFile() {
  return path.join(
    process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper'),
    'funding-mail-completion.json',
  );
}

async function loadState(filePath = stateFile()) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return { version: 1, completed: Array.isArray(parsed.completed) ? parsed.completed : [] };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { version: 1, completed: [] };
  }
}

async function saveState(state, filePath = stateFile()) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, filePath);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export function validateFundingMailCompletion(input = {}) {
  const messageFingerprint = clean(input.messageFingerprint, 160);
  const messageDescription = clean(input.messageDescription, 5000);
  const dealId = clean(input.dealId, 100);
  const uploadedFileNames = Array.isArray(input.uploadedFileNames)
    ? [...new Set(input.uploadedFileNames.map(value => clean(value, 240)).filter(Boolean))]
    : [];
  const textRelevant = input.textRelevant === true;
  if (!messageFingerprint) throw new Error('Die Fördermail besitzt keinen stabilen Nachrichten-Fingerprint.');
  if (!messageDescription || !/(?:Betreff:|Kein Betreff)/i.test(messageDescription)) throw new Error('Die Fördermail ist in Outlook nicht exakt identifiziert.');
  if (!dealId) throw new Error('Die Fördermail ist keinem eindeutigen Pipedrive-Deal zugeordnet.');
  if (input.ambiguous === true) throw new Error('Die Fördermail ist nicht eindeutig zugeordnet und bleibt im Posteingang.');
  if (input.pipedriveFilesVerified !== true) throw new Error('Die Dateien der Fördermail wurden im Pipedrive-Deal noch nicht vollständig verifiziert.');
  if (textRelevant && input.pipedriveTextVerified !== true) throw new Error('Der relevante Mailtext wurde im Pipedrive-Deal noch nicht verifiziert.');
  return {
    messageFingerprint,
    messageDescription,
    dealId,
    uploadedFileNames,
    textRelevant,
    pipedriveFilesVerified: true,
    pipedriveTextVerified: !textRelevant || input.pipedriveTextVerified === true,
  };
}

export async function completeFundingMail(input = {}, {
  moveMessage = moveOutlookMessageToFolder,
  load = loadState,
  save = saveState,
} = {}) {
  assertImacFundingHost();
  const completion = validateFundingMailCompletion(input);
  const state = await load();
  const previous = state.completed.find(item => item.messageFingerprint === completion.messageFingerprint);
  if (previous) return { status: 'already_completed', moved: false, destinationFolder: FUNDING_DONE_FOLDER, completion: previous };
  const moved = await moveMessage({
    from: FUNDING_MAILBOX,
    messageDescription: completion.messageDescription,
    destinationFolder: FUNDING_DONE_FOLDER,
  });
  if (moved?.verifiedInDestination !== true) throw new Error('Die Fördermail wurde nicht im Outlook-Unterordner „fertig“ verifiziert.');
  const record = { ...completion, completedAt: new Date().toISOString(), destinationFolder: FUNDING_DONE_FOLDER };
  await save({ version: 1, completed: [...state.completed, record].slice(-5000) });
  return { status: 'completed', moved: true, destinationFolder: FUNDING_DONE_FOLDER, completion: record };
}
