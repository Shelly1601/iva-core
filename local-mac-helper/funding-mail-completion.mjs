import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { assertImacFundingHost } from './funding-workflows.mjs';
import { moveOutlookMessageToFolder } from './macos-ui.mjs';
import { createFundingIntakeStore, validateFundingIntakeReceipt, withFundingFileLock } from './funding-intake-state.mjs';

export const FUNDING_MAILBOX = 'foerderung@heat-hero.com';
export const FUNDING_DONE_FOLDER = 'Fertig';
let completionQueue = Promise.resolve();

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
    return { version: 2, completed: Array.isArray(parsed.completed) ? parsed.completed : [], pendingMoves: Array.isArray(parsed.pendingMoves) ? parsed.pendingMoves : [] };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { version: 2, completed: [], pendingMoves: [] };
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
  const receipt = validateFundingIntakeReceipt(input.receipt || input);
  const messageFingerprint = receipt.messageFingerprint;
  const messageDescription = clean(input.messageDescription, 5000);
  const dealId = receipt.dealId;
  const uploadedFileNames = receipt.uploadedFiles.map(file => file.filename);
  const textRelevant = receipt.textRelevant;
  if (!messageFingerprint) throw new Error('Die Fördermail besitzt keinen stabilen Nachrichten-Fingerprint.');
  if (!messageDescription || !/(?:Betreff:|Kein Betreff)/i.test(messageDescription)) throw new Error('Die Fördermail ist in Outlook nicht exakt identifiziert.');
  if (!dealId) throw new Error('Die Fördermail ist keinem eindeutigen Pipedrive-Deal zugeordnet.');
  if (input.ambiguous === true) throw new Error('Die Fördermail ist nicht eindeutig zugeordnet und bleibt im Posteingang.');
  return {
    messageFingerprint,
    messageDescription,
    dealId,
    uploadedFileNames,
    textRelevant,
    pipedriveFilesVerified: true,
    pipedriveTextVerified: true,
    receipt,
  };
}

async function resolveMailboxIdentity(input) {
  const { resolveSourceIdentity } = await import('./outlook-ui-mailbox.mjs');
  return resolveSourceIdentity(input);
}

function verifiedIdentity(result, messageId) {
  return result?.identityVerified === true && result.messageId === messageId;
}

async function inspectMove(completion, resolveIdentity) {
  const resolve = folder => resolveIdentity({ from: FUNDING_MAILBOX, folder, messageId: completion.receipt.messageId, description: completion.messageDescription });
  const destination = await resolve(FUNDING_DONE_FOLDER);
  if (verifiedIdentity(destination, completion.receipt.messageId)) return { verifiedInDestination: true };
  if (destination?.notFound !== true) throw new Error('Die Identität im Zielordner ist noch nicht belegt.');
  const source = await resolve('Posteingang');
  return { verifiedInDestination: false, verifiedInSource: verifiedIdentity(source, completion.receipt.messageId) };
}

export async function completeFundingMail(input = {}, {
  moveMessage = moveOutlookMessageToFolder,
  load = loadState,
  save = saveState,
  verifyMove,
  resolveIdentity = resolveMailboxIdentity,
  intakeStore = createFundingIntakeStore(),
} = {}) {
  assertImacFundingHost();
  const completion = validateFundingMailCompletion(input);
  const operation = completionQueue.catch(() => {}).then(() => withFundingFileLock(stateFile(), async () => {
  const state = await load();
  state.pendingMoves ||= [];
  const previous = state.completed.find(item => item.messageFingerprint === completion.messageFingerprint);
  if (previous) {
    if (previous.dealId !== completion.dealId) throw new Error('Die bereits bearbeitete Fördermail gehört zu einem anderen Deal.');
    await intakeStore.completeMessage({ ...completion.receipt, moveVerified: true });
    return { status: 'already_completed', moved: false, destinationFolder: FUNDING_DONE_FOLDER, completion: previous };
  }
  const pending = state.pendingMoves.find(item => item.messageFingerprint === completion.messageFingerprint);
  if (pending && pending.dealId !== completion.dealId) throw new Error('Die offene Mailverschiebung gehört zu einem anderen Deal.');
  const before = pending ? await (verifyMove || (value => inspectMove(value, resolveIdentity)))(completion) : null;
  if (pending && before?.verifiedInDestination !== true && before?.verifiedInSource !== true) throw new Error('Der Ausgang der Mailverschiebung ist offen; zuerst Quelle und Ziel eindeutig rücklesen.');
  if (!pending) {
    state.pendingMoves.push({ messageFingerprint: completion.messageFingerprint, messageId: completion.receipt.messageId, dealId: completion.dealId, startedAt: new Date().toISOString() });
    await save(state);
  }
  if (before?.verifiedInDestination !== true) {
    const source = await resolveIdentity({ from: FUNDING_MAILBOX, folder: 'Posteingang', messageId: completion.receipt.messageId, description: completion.messageDescription });
    if (!verifiedIdentity(source, completion.receipt.messageId) || !source.description) throw new Error('Die Quellnachricht wurde nicht anhand ihrer tatsächlichen Message-ID verifiziert.');
    await moveMessage({ from: FUNDING_MAILBOX, messageDescription: source.description, destinationFolder: FUNDING_DONE_FOLDER });
  }
  const destination = await resolveIdentity({ from: FUNDING_MAILBOX, folder: FUNDING_DONE_FOLDER, messageId: completion.receipt.messageId, description: completion.messageDescription });
  if (!verifiedIdentity(destination, completion.receipt.messageId)) throw new Error('Die Fördermail wurde nicht anhand ihrer Message-ID in Fertig rückgelesen.');
  const { messageDescription, ...metadata } = completion;
  const record = { ...metadata, completedAt: new Date().toISOString(), destinationFolder: FUNDING_DONE_FOLDER };
  await save({ version: 2, completed: [...state.completed, record].slice(-5000), pendingMoves: state.pendingMoves.filter(item => item.messageFingerprint !== completion.messageFingerprint) });
  await intakeStore.completeMessage({ ...completion.receipt, moveVerified: true });
  return { status: 'completed', moved: before?.verifiedInDestination !== true, destinationFolder: FUNDING_DONE_FOLDER, completion: record };
  }));
  completionQueue = operation;
  return operation;
}
