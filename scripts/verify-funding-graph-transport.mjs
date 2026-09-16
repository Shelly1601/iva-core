import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-graph-transport-'));
process.env.IVA_MAC_HELPER_DATA_DIR = directory;
const { createMicrosoftFundingMailTransport, downloadMicrosoftFundingAttachments } = await import('../local-mac-helper/background-integrations.mjs');
const { createFundingMailboxTransport } = await import('../local-mac-helper/outlook-mailbox.mjs');
const { createFundingIntakeStore, validateFundingIntakeReceipt } = await import('../local-mac-helper/funding-intake-state.mjs');
const { completeFundingMail, validateFundingMailCompletion } = await import('../local-mac-helper/funding-mail-completion.mjs');
const { detectNewFundingMessages } = await import('../local-mac-helper/funding-monitor-state.mjs');
const { processFundingMonitorMessage, runFundingMonitorOnce } = await import('../local-mac-helper/funding-monitor-runner.mjs');
const messageId = '<fixture@example.test>', sourceHash = 'a'.repeat(64);
const row = { messageId, immutableId: 'immutable-1', source: 'microsoft-graph', identityVerified: true, receivedAt: '2026-08-15T12:00:00Z', description: 'Absender: fixture@example.test, Betreff: HH-AB-1234 Unterlagen, 15.08.26, Hat Dateien', hasAttachments: true };
const page = (messages = [row], extra = {}) => ({ messages, source: 'microsoft-graph', coverageVerified: true, complete: true, nextCursor: null, checkpoint: 'msgraph:checkpoint', removedImmutableIds: [], ...extra });
const receipt = () => ({ messageId, source: 'microsoft-graph', sourceHash, dealId: '123', identityVerified: true, sourceReadComplete: true,
  expectedAttachmentCount: 1, attachmentProcessingVerified: true, uploadedFiles: [{ id: '12', filename: 'Ausweis.pdf', dealId: '123', verified: true }], textRelevant: false, verifiedAt: new Date().toISOString() });
const storeFixture = () => createFundingIntakeStore({ filePath: path.join(directory, randomUUID() + '.json') });
const legacyCursor = Buffer.from(JSON.stringify({ version: 2, source: 'outlook-ui-mime', from: 'foerderung@heat-hero.com', folder: 'Posteingang', kind: 'checkpoint' })).toString('base64url');

test('device wrappers use fixed authenticated routes and cache probes across callers', async () => {
  const calls = [], buffer = Buffer.from('%PDF-fixture'), sha256 = createHash('sha256').update(buffer).digest('hex');
  const transport = createMicrosoftFundingMailTransport({ requestImpl: async (route, options) => {
    calls.push({ route, options });
    if (route.includes('/status')) return { ready: true };
    if (route.endsWith('/attachment')) return { buffer, verified: true, sha256, sourceHash, size: buffer.length, disposition: "attachment; filename*=UTF-8''Ausweis.pdf", contentType: 'application/octet-stream' };
    return { ok: true };
  } });
  await Promise.all([transport.status({ probe: true }), transport.status({ probe: true }), transport.status({ probe: true })]);
  assert.equal(calls.length, 1); assert.match(calls[0].route, /\/funding-mail\/status\?probe=1$/);
  await transport.readMessage({ messageId });
  assert.equal(calls.at(-1).options.body.messageId, messageId); assert.equal(calls.at(-1).options.method, 'POST');
  const downloaded = await transport.downloadAttachment({ messageId, attachmentId: 'file-1' });
  assert.equal(downloaded.sha256, sha256); assert.equal(downloaded.verified, true); assert.equal(downloaded.sourceHash, sourceHash);
});

test('binary transport rejects missing proof or mismatched bytes instead of trusting HTTP success', async () => {
  const transport = createMicrosoftFundingMailTransport({ requestImpl: async () => ({ buffer: Buffer.from('fixture'), verified: true, size: 7, sha256: '0'.repeat(64), sourceHash }) });
  await assert.rejects(transport.downloadAttachment({ messageId, attachmentId: 'file-1' }), /Serverbeleg/);
});

test('Graph readiness selects direct access once, accepts existing RFC-ID and never falls back on a Graph read error', async () => {
  let probes = 0, legacy = 0, pages = 0;
  const transport = createFundingMailboxTransport({ getStatus: async () => { probes++; return { ready: true }; },
    readGraphPage: async () => { pages++; return page(); }, readGraphMessage: async input => ({ ...row, ...input }),
    readLegacyPage: async () => { legacy++; }, readLegacyMessage: async () => { legacy++; } });
  await transport.readPage({ since: '2026-08-01' }); await transport.readPage({ cursor: 'msgraph:next' });
  assert.equal((await transport.readMessage({ messageId })).messageId, messageId);
  assert.equal(probes, 1); assert.equal(pages, 2); assert.equal(legacy, 0);
  await assert.rejects(transport.readPage({ cursor: legacyCursor }), { code: 'FUNDING_MAIL_TRANSPORT_MIGRATION_REQUIRED' });
  await assert.rejects(transport.readMessage({ messageId: 'outlook:1:2' }), { code: 'FUNDING_MAIL_ID_MIGRATION_REQUIRED' });
  const failing = createFundingMailboxTransport({ getStatus: async () => ({ ready: true }), readGraphPage: async () => { throw new Error('Graph failed'); }, readLegacyPage: async () => { legacy++; } });
  await assert.rejects(failing.readPage({ since: '2026-08-01' }), /Graph failed/); assert.equal(legacy, 0);
});

test('unconfigured Graph retains legacy reader but never passes Graph cursor into Outlook', async () => {
  let legacy = 0;
  const transport = createFundingMailboxTransport({ getStatus: async () => ({ ready: false }), readLegacyPage: async () => { legacy++; return {}; } });
  await transport.readPage({ cursor: legacyCursor }); assert.equal(legacy, 1);
  await assert.rejects(transport.readPage({ cursor: 'msgraph:next' }), { code: 'FUNDING_MAIL_GRAPH_UNAVAILABLE' });
  await assert.rejects(transport.readPage({ cursor: 'broken' }), { code: 'FUNDING_MAIL_BAD_CURSOR' }); assert.equal(legacy, 1);
});

test('Graph intake preserves provider identity, opaque cursor and tombstones without completing removed pending mail', async () => {
  const store = storeFixture(); await store.begin({ mode: 'initial-backfill' });
  const recorded = await store.recordPage(page([row], { complete: false, nextCursor: 'msgraph:next', checkpoint: null }), { mode: 'initial-backfill' });
  assert.equal(recorded.messages[0].source, 'microsoft-graph'); assert.equal(recorded.messages[0].identityVerified, true);
  const next = await store.recordPage(page([], { removedImmutableIds: ['immutable-1'] }), { mode: 'initial-backfill', expectedCursor: 'msgraph:next' });
  assert.equal(next.tombstoneCount, 1); assert.equal(next.pendingCount, 1);
  const run = await store.begin({ mode: 'incremental' }); assert.equal(run.cursor, 'msgraph:checkpoint'); assert.equal(run.source, 'microsoft-graph');
  await assert.rejects(store.recordPage({ ...page([]), source: 'outlook-native', checkpoint: 'legacy' }, { mode: 'incremental', expectedCursor: run.cursor }), { code: 'FUNDING_MAIL_TRANSPORT_MIGRATION_REQUIRED' });
});

test('unverified Graph rows and wrong cursor family cannot advance intake', async () => {
  const store = storeFixture(); await store.begin({ mode: 'initial-backfill' });
  await assert.rejects(store.recordPage(page([{ ...row, identityVerified: false }]), { mode: 'initial-backfill' }), /Original-Message-ID/);
  await assert.rejects(store.recordPage(page([], { checkpoint: legacyCursor }), { mode: 'initial-backfill' }), /Leseweg/);
  assert.equal((await store.status()).backfill.cursor, null);
});

test('pending RFC messages refreshed through Graph retain fresh provider identity without August scan', async () => {
  const store = storeFixture(); await store.begin({ mode: 'initial-backfill' }); await store.recordPage(page(), { mode: 'initial-backfill' });
  let readCursor;
  const detected = await detectNewFundingMessages({ intakeStore: store, filePath: path.join(directory, 'monitor.json'), readPage: async input => { readCursor = input.cursor; return page([], { checkpoint: 'msgraph:new', removedImmutableIds: ['other'] }); }, readMessage: async () => row });
  assert.equal(readCursor, 'msgraph:checkpoint'); assert.equal(detected.source, 'microsoft-graph'); assert.equal(detected.tombstoneCount, 1);
  assert.equal(detected.messages[0].source, 'microsoft-graph'); assert.equal(detected.messages[0].identityVerified, true);
});

test('download verifies each file and final message version, tolerating Exchange reported-size differences', async () => {
  const buffer = Buffer.from('%PDF-actual'), sha256 = createHash('sha256').update(buffer).digest('hex');
  const message = { ...row, sourceHash, sourceReadComplete: true, attachmentsComplete: true, attachments: [{ attachmentId: 'file-1', name: 'Ausweis.pdf', size: 9000, supported: true }] };
  let reads = 0;
  const result = await downloadMicrosoftFundingAttachments({ messageId }, { readMessage: async () => { reads++; return message; }, downloadAttachment: async () => ({ buffer, sha256, sourceHash, verified: true, size: buffer.length }) });
  assert.equal(result.complete, true); assert.equal(result.sourceHash, sourceHash); assert.equal(result.immutableId, row.immutableId); assert.equal(reads, 2);
  assert.deepEqual(await fs.readFile(result.files[0].filePath), buffer);
  let changedRead = 0;
  await assert.rejects(downloadMicrosoftFundingAttachments({ messageId }, { readMessage: async () => ({ ...message, sourceHash: ++changedRead > 1 ? 'b'.repeat(64) : sourceHash }), downloadAttachment: async () => ({ buffer, sha256, sourceHash, verified: true, size: buffer.length }) }), /während des Anlagendownloads geändert/);
  await assert.rejects(downloadMicrosoftFundingAttachments({ messageId }, { readMessage: async () => message, downloadAttachment: async () => ({ buffer, sha256, sourceHash: 'b'.repeat(64), verified: true, size: buffer.length }) }), /Originalstand/);
});

test('partial inventory or unsupported attachment never produces a completed download', async () => {
  for (const override of [{ attachmentsComplete: false }, { sourceReadComplete: false }, { attachments: [{ attachmentId: 'a', supported: false }] }]) {
    await assert.rejects(downloadMicrosoftFundingAttachments({ messageId }, { readMessage: async () => ({ ...row, sourceHash, sourceReadComplete: true, attachmentsComplete: true, attachments: [], ...override }), downloadAttachment: async () => { throw new Error('must not download'); } }));
  }
});

test('Graph source hash is mandatory in receipt, forwarded unchanged, and completion replay cannot change it', async () => {
  assert.throws(() => validateFundingIntakeReceipt({ ...receipt(), sourceHash: undefined }), /Hash/);
  assert.equal(validateFundingIntakeReceipt(receipt()).sourceHash, sourceHash);
  const store = storeFixture(); await store.begin({ mode: 'initial-backfill' }); await store.recordPage(page(), { mode: 'initial-backfill' });
  let state = { completed: [], pendingMoves: [] }, moved = false, moves = 0, replays = 0;
  const originalReceipt = receipt();
  const deps = { transport: 'microsoft-graph', intakeStore: store, load: async () => structuredClone(state), save: async value => { state = structuredClone(value); },
    resolveIdentity: async ({ folder }) => moved === (folder === 'Fertig') ? { ...row, description: undefined } : { notFound: true, messageId },
    moveMessage: async input => { assert.equal(input.receipt.sourceHash, sourceHash); assert.equal(input.messageId, messageId); if (input.reconcileOnly) { replays++; assert.deepEqual(input.receipt, validateFundingIntakeReceipt(originalReceipt)); return { moved: false, verified: true, verifiedInDestination: true }; } moves++; moved = true; } };
  assert.equal((await completeFundingMail({ receipt: originalReceipt }, deps)).status, 'completed');
  assert.equal((await completeFundingMail({ receipt: originalReceipt }, deps)).status, 'already_completed'); assert.equal(moves, 1); assert.equal(replays, 1);
  await assert.rejects(completeFundingMail({ receipt: { ...receipt(), sourceHash: 'b'.repeat(64) } }, deps), /Nachrichtenstand/);
});

test('completed Graph replay requires current server receipt and destination proof; unavailable transport preserves the record', async () => {
  const originalReceipt = validateFundingIntakeReceipt(receipt());
  const previous = { messageFingerprint: originalReceipt.messageFingerprint, dealId: originalReceipt.dealId, receipt: originalReceipt };
  let completed = 0, saves = 0, reconciles = 0;
  const deps = { selectTransport: async () => 'microsoft-graph', transport: 'microsoft-graph',
    load: async () => ({ completed: [previous], pendingMoves: [] }), save: async () => { saves++; },
    intakeStore: { completeMessage: async () => { completed++; } }, resolveIdentity: async () => row,
    moveMessage: async input => { reconciles++; assert.equal(input.reconcileOnly, true); if (JSON.stringify(input.receipt) !== JSON.stringify(originalReceipt)) throw new Error('RECEIPT_CHANGED'); return { moved: false, verified: true, verifiedInDestination: true }; } };
  await assert.rejects(completeFundingMail({ receipt: { ...originalReceipt, uploadedFiles: [{ ...originalReceipt.uploadedFiles[0], id: 'changed' }] } }, deps), /RECEIPT_CHANGED/);
  await assert.rejects(completeFundingMail({ receipt: originalReceipt }, { ...deps, resolveIdentity: async () => ({ notFound: true, messageId }) }), /nicht mehr bestätigt in Fertig/);
  await assert.rejects(completeFundingMail({ receipt: originalReceipt }, { ...deps, transport: undefined, selectTransport: async () => 'outlook-native' }), /nicht auf einen anderen Leseweg/);
  const nativeReceipt = { ...originalReceipt }; delete nativeReceipt.source; delete nativeReceipt.sourceHash;
  assert.throws(() => validateFundingMailCompletion({ receipt: nativeReceipt }), /nicht exakt identifiziert/);
  await assert.rejects(completeFundingMail({ receipt: originalReceipt }, { ...deps, load: async () => ({ completed: [{ ...previous, receipt: nativeReceipt }], pendingMoves: [] }) }), /früherer Outlook-Abschluss/);
  assert.equal(completed, 0); assert.equal(saves, 0); assert.equal(reconciles, 2);
});

test('uncertain Graph move is reconciled with receipt on server even when destination identity is already visible', async () => {
  const store = storeFixture(); await store.begin({ mode: 'initial-backfill' }); await store.recordPage(page(), { mode: 'initial-backfill' });
  let state = { completed: [], pendingMoves: [] }, moved = false, calls = 0;
  const deps = { transport: 'microsoft-graph', intakeStore: store, load: async () => structuredClone(state), save: async value => { state = structuredClone(value); },
    resolveIdentity: async ({ folder }) => moved === (folder === 'Fertig') ? row : { notFound: true, messageId },
    moveMessage: async input => { calls++; assert.equal(input.receipt.sourceHash, sourceHash); if (!moved) { moved = true; throw new Error('response lost'); } return { alreadyMoved: true }; } };
  await assert.rejects(completeFundingMail({ receipt: receipt() }, deps), /response lost/);
  assert.equal((await completeFundingMail({ receipt: receipt() }, deps)).status, 'completed'); assert.equal(calls, 2);
});

test('Graph identity bypasses only UI locator requirement and downloads inline-only attachment inventory', async () => {
  const board = { cases: [{ dealId: '123', customerName: 'Fixture Kunde', orderNumber: 'HH-AB-1234', missingBaseDocumentIds: [] }] };
  let directCalls = 0, uiCalls = 0; const saved = [];
  const deps = { reviewExists: async () => false, acknowledge: async () => {}, saveReview: async value => saved.push(value),
    downloadUiAttachments: async () => { uiCalls++; }, downloadGraphAttachments: async () => { directCalls++; return { source: 'microsoft-graph', messageId, identityVerified: true, complete: true, verified: true, sourceHash, sourceReadComplete: true, expectedCount: 0 }; } };
  const message = { ...row, fingerprint: 'c'.repeat(64), hasAttachments: false, description: row.description.replace('Hat Dateien', 'Keine Anlagen') };
  assert.equal((await processFundingMonitorMessage(message, board, deps)).status, 'mail_text_review_required'); assert.equal(directCalls, 1); assert.equal(uiCalls, 0); assert.equal(saved[0].sourceHash, sourceHash);
  assert.equal((await processFundingMonitorMessage({ ...message, identityVerified: false, uiDescriptionVerified: true }, board, deps)).status, 'graph_message_identity_pending'); assert.equal(directCalls, 1); assert.equal(uiCalls, 0);
});

test('a tombstone-only Graph page runs without UI idleness and without a full Pipedrive board scan', async () => {
  let boards = 0, ui = 0;
  const result = await runFundingMonitorOnce({}, { loadState: async () => ({ mode: 'review-only', emailSendEnabled: false, replyDraftsOnly: true }),
    checkStatus: async () => ({ ready: true }), checkUiReadiness: async () => { ui++; throw new Error('must not inspect UI'); },
    detectMessages: async () => ({ source: 'microsoft-graph', tombstoneCount: 2, newMessageCount: 0, scanComplete: false }),
    scanBoard: async () => { boards++; }, auditLog: async () => {} });
  assert.equal(result.dealsChecked, 0); assert.equal(result.scanComplete, false); assert.equal(boards, 0); assert.equal(ui, 0);
});

after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
