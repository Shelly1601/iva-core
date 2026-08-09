import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { FUNDING_SENDER_EMAIL } from './funding.mjs';

export const FUNDING_BATCH_MODE = 'outlook-drafts-only';
export const FUNDING_ROLLBACK_CONFIRMATION = 'Alles rückgängig machen';
export const MAX_FUNDING_BATCH_SIZE = 100;

const markerPattern = /^IVA-FUNDING-DRAFT:([0-9a-f-]{36}):([0-9a-f-]{36})$/i;

const now = () => new Date().toISOString();

export function normalizeFundingBatchState(value = {}) {
  return {
    version: 2,
    drafts: value?.drafts && typeof value.drafts === 'object' ? value.drafts : {},
    batches: value?.batches && typeof value.batches === 'object' ? value.batches : {},
    lastBatchId: typeof value?.lastBatchId === 'string' ? value.lastBatchId : null,
  };
}

export function fundingDraftFingerprint(draft) {
  return createHash('sha256').update(JSON.stringify({
    subject: draft.subject,
    body: draft.body,
    html: draft.html,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    attachments: draft.attachments,
    from: draft.from,
  })).digest('hex');
}

export function buildFundingDraftMarker(batchId, itemId) {
  const marker = `IVA-FUNDING-DRAFT:${batchId}:${itemId}`;
  if (!markerPattern.test(marker)) throw new Error('Interne Förderentwurf-Kennung ist ungültig.');
  return marker;
}

export function assertFundingDraftMarker(marker) {
  const normalized = String(marker || '').trim();
  if (!markerPattern.test(normalized)) throw new Error('Ungültige Förderentwurf-Kennung; Rückgängig wurde abgebrochen.');
  return normalized;
}

export function attachFundingDraftMarker(draft, marker) {
  const safeMarker = assertFundingDraftMarker(marker);
  if (!String(draft.html || '').trim()) {
    throw new Error('Förderentwürfe brauchen für eine sichere Rückgängig-Kennung einen HTML-Mailtext.');
  }
  const tracking = `<div aria-hidden="true" data-iva-funding-draft="${safeMarker}" style="display:none!important;font-size:0;line-height:0;color:transparent;max-height:0;overflow:hidden;mso-hide:all;">${safeMarker}</div>`;
  return { ...draft, html: `${draft.html}\n${tracking}` };
}

export function createJsonFundingStateStore(stateFile) {
  const absoluteFile = path.resolve(String(stateFile));
  return {
    async load() {
      try { return normalizeFundingBatchState(JSON.parse(await readFile(absoluteFile, 'utf8'))); }
      catch { return normalizeFundingBatchState(); }
    },
    async save(value) {
      const state = normalizeFundingBatchState(value);
      const directory = path.dirname(absoluteFile);
      const temporary = `${absoluteFile}.${process.pid}.${randomUUID()}.tmp`;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
        await rename(temporary, absoluteFile);
      } finally {
        await unlink(temporary).catch(() => {});
      }
      return state;
    },
  };
}

export function createMemoryFundingStateStore(initial = {}) {
  let state = normalizeFundingBatchState(structuredClone(initial));
  return {
    async load() { return structuredClone(state); },
    async save(value) {
      state = normalizeFundingBatchState(structuredClone(value));
      return structuredClone(state);
    },
  };
}

function normalizeCases(cases) {
  if (!Array.isArray(cases) || !cases.length) throw new Error('Der Förder-Prüflauf enthält keine Fälle.');
  if (cases.length > MAX_FUNDING_BATCH_SIZE) throw new Error(`Ein Förder-Prüflauf darf höchstens ${MAX_FUNDING_BATCH_SIZE} Fälle enthalten.`);
  return cases;
}

function prepareBatch(cases, renderDraft, batchId = randomUUID()) {
  const seen = new Set();
  const seenSubjects = new Set();
  return {
    id: batchId,
    mode: FUNDING_BATCH_MODE,
    status: 'preview',
    sendEnabled: false,
    pipedriveMutationEnabled: false,
    createdAt: now(),
    updatedAt: now(),
    items: normalizeCases(cases).map((input, index) => {
      const draft = renderDraft(input);
      if (draft.from !== FUNDING_SENDER_EMAIL) throw new Error(`Förderentwurf ${index + 1} hat nicht das festgelegte Absenderkonto.`);
      const fingerprint = fundingDraftFingerprint(draft);
      const duplicateInBatch = seen.has(fingerprint);
      if (seenSubjects.has(draft.subject)) {
        throw new Error(`Der Förder-Prüflauf enthält den Betreff „${draft.subject}“ mehrfach. Zur sicheren Rückgängig-Funktion muss jeder Fall eindeutig sein.`);
      }
      seen.add(fingerprint);
      seenSubjects.add(draft.subject);
      const itemId = randomUUID();
      const marker = buildFundingDraftMarker(batchId, itemId);
      return {
        id: itemId,
        index,
        dealId: input?.dealId ? String(input.dealId) : null,
        subject: draft.subject,
        fingerprint,
        marker,
        duplicateInBatch,
        status: duplicateInBatch ? 'skipped_duplicate_in_batch' : 'planned',
        sent: false,
        draft: attachFundingDraftMarker(draft, marker),
      };
    }),
  };
}

function publicBatch(batch) {
  return {
    ...batch,
    items: batch.items.map(({ draft, ...item }) => item),
  };
}

export class FundingBatchService {
  #queue = Promise.resolve();

  constructor({ store, renderDraft, createDraft, deleteDrafts, audit = async () => {} }) {
    if (!store?.load || !store?.save) throw new Error('Förder-Batch-Speicher fehlt.');
    if (typeof renderDraft !== 'function' || typeof createDraft !== 'function' || typeof deleteDrafts !== 'function') {
      throw new Error('Förder-Batch-Abhängigkeiten sind unvollständig.');
    }
    this.store = store;
    this.renderDraft = renderDraft;
    this.createDraft = createDraft;
    this.deleteDrafts = deleteDrafts;
    this.audit = audit;
  }

  #serialized(operation) {
    const task = this.#queue.then(operation, operation);
    this.#queue = task.catch(() => {});
    return task;
  }

  preview(cases) {
    const batch = prepareBatch(cases, this.renderDraft);
    return publicBatch(batch);
  }

  create(cases) {
    return this.#serialized(async () => {
      const batch = prepareBatch(cases, this.renderDraft);
      const state = await this.store.load();
      batch.status = 'creating';
      state.batches[batch.id] = publicBatch(batch);
      state.lastBatchId = batch.id;
      await this.store.save(state);

      let failure = null;
      for (const item of batch.items) {
        if (item.duplicateInBatch) continue;
        const prior = state.drafts[item.fingerprint];
        const priorWithSameSubject = Object.values(state.drafts).find(entry => entry?.created === true && entry?.rolledBack !== true && entry?.subject === item.subject);
        if ((prior?.created === true && prior?.rolledBack !== true) || priorWithSameSubject) {
          item.status = 'skipped_existing_draft';
          item.existingBatchId = prior?.batchId || priorWithSameSubject?.batchId || null;
          continue;
        }
        try {
          const result = await this.createDraft(item.draft);
          if (result?.created !== true) throw new Error('Outlook hat die Erstellung des Entwurfs nicht bestätigt.');
          item.status = 'created';
          item.createdAt = now();
          item.channel = result.channel || null;
          state.drafts[item.fingerprint] = {
            created: true,
            rolledBack: false,
            createdAt: item.createdAt,
            subject: item.subject,
            batchId: batch.id,
            itemId: item.id,
            marker: item.marker,
            sent: false,
          };
        } catch (error) {
          item.status = 'failed';
          item.error = error.message;
          failure = error;
        }
        batch.updatedAt = now();
        state.batches[batch.id] = publicBatch(batch);
        await this.store.save(state);
        if (failure) break;
      }

      for (const item of batch.items) {
        if (failure && item.status === 'planned') item.status = 'not_attempted';
      }
      const createdCount = batch.items.filter(item => item.status === 'created').length;
      batch.status = failure ? (createdCount ? 'partial' : 'failed') : 'created';
      batch.updatedAt = now();
      batch.summary = {
        requested: batch.items.length,
        created: createdCount,
        skipped: batch.items.filter(item => item.status.startsWith('skipped_')).length,
        failed: batch.items.filter(item => item.status === 'failed').length,
      };
      state.batches[batch.id] = publicBatch(batch);
      await this.store.save(state);
      await this.audit({
        category: 'funding-draft-batch',
        action: 'created',
        batchId: batch.id,
        status: batch.status,
        summary: batch.summary,
        sent: false,
        pipedriveMutated: false,
      });
      return { batch: publicBatch(batch), complete: !failure, error: failure?.message || null };
    });
  }

  rollback(batchId, confirmation) {
    return this.#serialized(async () => {
      if (String(confirmation || '').trim() !== FUNDING_ROLLBACK_CONFIRMATION) {
        throw new Error(`Rückgängig wurde nicht ausgeführt. Bestätigung muss exakt „${FUNDING_ROLLBACK_CONFIRMATION}“ lauten.`);
      }
      const state = await this.store.load();
      const resolvedId = batchId === 'last' || !batchId ? state.lastBatchId : String(batchId);
      const batch = state.batches[resolvedId];
      if (!batch) throw new Error('Der angegebene Förder-Prüflauf wurde nicht gefunden.');
      if (batch.status === 'rolled_back') return { batch, idempotent: true, sent: false, pipedriveMutated: false };

      const targets = batch.items.filter(item => item.status === 'created').map(item => ({
        marker: assertFundingDraftMarker(item.marker),
        subject: item.subject,
        itemId: item.id,
      }));
      if (!targets.length) {
        batch.status = 'rolled_back';
        batch.rolledBackAt = now();
        batch.updatedAt = now();
        state.batches[resolvedId] = batch;
        await this.store.save(state);
        return { batch, idempotent: false, deletedCount: 0, sent: false, pipedriveMutated: false };
      }

      batch.status = 'rolling_back';
      batch.updatedAt = now();
      state.batches[resolvedId] = batch;
      await this.store.save(state);
      const result = await this.deleteDrafts({ from: FUNDING_SENDER_EMAIL, entries: targets });
      const deleted = new Set((result?.deletedMarkers || []).map(assertFundingDraftMarker));
      for (const item of batch.items) {
        if (!deleted.has(item.marker)) continue;
        item.status = 'rolled_back';
        item.rolledBackAt = now();
        const draftState = state.drafts[item.fingerprint];
        if (draftState?.batchId === batch.id && draftState?.itemId === item.id) {
          state.drafts[item.fingerprint] = { ...draftState, created: false, rolledBack: true, rolledBackAt: item.rolledBackAt };
        }
      }
      const remaining = batch.items.filter(item => item.status === 'created').length;
      batch.status = remaining ? 'partial_rollback' : 'rolled_back';
      batch.updatedAt = now();
      if (!remaining) batch.rolledBackAt = now();
      batch.rollback = {
        requested: targets.length,
        deleted: deleted.size,
        missing: targets.length - deleted.size,
        recoverableFromOutlookDeletedItems: result?.recoverableFromDeletedItems !== false,
      };
      state.batches[resolvedId] = batch;
      await this.store.save(state);
      await this.audit({
        category: 'funding-draft-batch',
        action: 'rolled-back',
        batchId: batch.id,
        status: batch.status,
        rollback: batch.rollback,
        sent: false,
        pipedriveMutated: false,
      });
      return { batch, idempotent: false, result, sent: false, pipedriveMutated: false };
    });
  }

  async list() {
    const state = await this.store.load();
    return Object.values(state.batches).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async get(batchId) {
    const state = await this.store.load();
    return state.batches[String(batchId)] || null;
  }
}
