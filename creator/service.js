import { randomUUID } from 'node:crypto';
import { createCreatorStore, creatorId, creatorText, creatorError } from './store.js';
import { snapshotCreatorSources, normalizeSourceRights, normalizeExactSnippet, creatorHash, httpsUrl, sourceWarnings, checkCreatorOriginality } from './sources.js';
import { CREATOR_TYPES, generateCreatorStep, normalizeCreatorPlan, normalizeCreatorOutline, normalizeCreatorUnit } from './generation.js';

const liveJobs = new Map(), workQueue = [];
let running = 0;
const active = status => ['queued', 'running'].includes(status);
const now = () => new Date().toISOString();
function completeVersion(version) {
  if (version?.stage !== 'complete' || !Array.isArray(version.outline) || !version.outline.length || !Array.isArray(version.units) || version.units.length !== version.outline.length || new Set(version.outline.map(u => u.id)).size !== version.outline.length || new Set(version.units.map(u => u.id)).size !== version.units.length || version.outline.some(o => !version.units.some(u => u.id === o.id && u.content?.trim() && u.examples?.length && u.exercises?.length))) throw creatorError('Nur eine vollständig ausgearbeitete Fassung kann exportiert oder als Verkaufsseite verwendet werden.', 409, 'CREATOR_INCOMPLETE');
  for (const snippet of version.exactSnippets || []) if (!version.units.some(u => u.exactSnippetIds?.includes(snippet.id))) throw creatorError('Eine ausgewählte wörtliche Textstelle fehlt in der Ausarbeitung.', 422, 'CREATOR_SNIPPET_MISSING');
  checkCreatorOriginality(version.units, version.sourceSnapshots, version.exactSnippets);
  return version;
}
const notFound = () => creatorError('Dieses Creator-Produkt gehört nicht zum gewählten Projekt.', 404);
function productIn(state, id) { creatorId(id, 'Produkt'); const p = state.products.find(p => p.id === id); if (!p) throw notFound(); return p; }
function jobIn(state, id) { creatorId(id, 'Auftrag'); const j = state.jobs.find(j => j.id === id); if (!j) throw creatorError('Creator-Auftrag nicht gefunden.', 404); return j; }
const jobPublic = j => { const { ownerPid, input, ...publicValue } = j; return publicValue; };
function versionSummary(v) { return { id: v.id, createdAt: v.createdAt, stage: v.stage, unitCount: v.units.length, title: v.title, productRevision: v.productRevision, jobId: v.jobId || null, edited: v.edited === true }; }
function productSummary(p) { const { versions, sources, snippets, createKey, createHash, ...summary } = p; return { ...summary, sourceCount: sources.length, snippetCount: snippets.length, versionCount: versions.length, completedUnits: versions.at(-1)?.units.length || 0, latestVersionId: versions.at(-1)?.id || null }; }
function metadata(input, previous = {}) {
  const out = { ...previous };
  for (const key of ['title', 'brief', 'audience']) if (key in input) { if (typeof input[key] !== 'string') throw creatorError(`${key} ist ungültig.`); const max = key === 'title' ? 250 : 8000; if (input[key].length > max) throw creatorError('Das Produktbriefing ist zu lang.', 413); out[key] = input[key].trim(); }
  if ('type' in input) { if (!CREATOR_TYPES.includes(input.type)) throw creatorError('Unbekannter Produkttyp.'); out.type = input.type; }
  if ('unitCount' in input) { if (!Number.isInteger(input.unitCount) || input.unitCount < 4 || input.unitCount > 12) throw creatorError('Bitte vier bis zwölf Einheiten wählen.'); out.unitCount = input.unitCount; }
  if ('salesLinks' in input) { if (!Array.isArray(input.salesLinks) || input.salesLinks.length > 8) throw creatorError('Höchstens acht Verkaufslinks sind möglich.'); out.salesLinks = input.salesLinks.map(link => ({ label: creatorText(link.label, 100), url: httpsUrl(link.url) })); if (out.salesLinks.some(l => !l.label || !l.url)) throw creatorError('Verkaufslink braucht Bezeichnung und HTTPS-Adresse.'); }
  if (!out.title || !out.brief || !out.type) throw creatorError('Produkttitel, Typ und eigenes Briefing fehlen.');
  out.audience ||= ''; out.unitCount ||= 6; out.salesLinks ||= []; return out;
}
function editable(state, p) { if (state.jobs.some(j => j.productId === p.id && active(j.status))) throw creatorError('Während der Ausarbeitung ist das Produkt gesperrt. Zuerst den Auftrag anhalten.', 409); }
function appendVersion(p, content) {
  if (p.versions.length >= 100) throw creatorError('Dieses Produkt hat 100 unveränderliche Fassungen. Bitte ein neues Produkt für weitere Arbeiten anlegen.', 507);
  const version = { ...structuredClone(content), id: randomUUID(), createdAt: now() }; p.versions.push(version); p.updatedAt = version.createdAt; return version;
}
function queueWork(key, task) { workQueue.push({ key, task }); pump(); }
function pump() { while (running < 2 && workQueue.length) { const item = workQueue.shift(); running++; void item.task().catch(() => {}).finally(() => { running--; liveJobs.delete(item.key); pump(); }); } }
function processAlive(pid) { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } }
async function abortable(promise, signal) {
  signal.throwIfAborted(); let abort;
  const rejected = new Promise((_, reject) => { abort = () => reject(signal.reason || new Error('aborted')); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([promise, rejected]); } finally { signal.removeEventListener('abort', abort); }
}

export function createCreatorService({ dataDir, getProject, listKnowledgeEntries, getKnowledgeEntry, getOpportunity, generate = generateCreatorStep, timeoutMs = 20 * 60 * 1000 } = {}) {
  const store = createCreatorStore({ dataDir, getProject });
  const keyOf = (projectId, id) => `${dataDir}:${projectId}:${id}`;
  function scopeId(scope) { return creatorId(scope?.projectId, 'Projekt'); }
  async function recover(projectId) {
    const state = await store.read(projectId), stale = state.jobs.filter(j => active(j.status) && (!processAlive(j.ownerPid) || (j.ownerPid === process.pid && !liveJobs.has(keyOf(projectId, j.id))) || (j.deadlineAt && Date.parse(j.deadlineAt) < Date.now())));
    if (!stale.length) return state;
    await store.mutate(projectId, current => { for (const old of stale) { const j = jobIn(current, old.id); if (!active(j.status)) continue; j.status = 'interrupted'; j.phase = 'interrupted'; j.message = 'Die Ausarbeitung wurde unterbrochen. Gespeicherte Einheiten bleiben erhalten und können fortgesetzt werden.'; j.finishedAt = now(); const p = productIn(current, j.productId); p.status = 'incomplete'; } });
    return store.read(projectId);
  }
  async function list(scope) { return (await recover(scopeId(scope))).products.map(productSummary); }
  async function get(scope, id) {
    const state = await recover(scopeId(scope)), p = productIn(state, id);
    return { ...productSummary(p), sources: p.sources.map(({ content, ...source }) => ({ ...source, excerpt: content.slice(0, 800) })), snippets: p.snippets, latestVersion: p.versions.at(-1) || null, versions: p.versions.map(versionSummary), jobs: state.jobs.filter(j => j.productId === id).map(jobPublic), warnings: sourceWarnings(p.sources) };
  }
  async function create(scope, input = {}) {
    const projectId = scopeId(scope), data = metadata(input), key = input.idempotencyKey ? creatorId(input.idempotencyKey, 'Anfrageschlüssel') : null, fingerprint = creatorHash(data);
    return store.mutate(projectId, state => {
      const old = key && state.products.find(p => p.createKey === key); if (old) { if (old.createHash !== fingerprint) throw creatorError('Dieser Anfrageschlüssel wurde mit anderem Inhalt verwendet.', 409); return productSummary(old); }
      const p = { ...data, id: randomUUID(), projectId, status: 'draft', revision: 1, createdAt: now(), updatedAt: now(), sources: [], snippets: [], versions: [], createKey: key, createHash: fingerprint }; state.products.unshift(p); return productSummary(p);
    });
  }
  async function update(scope, id, input = {}) {
    const projectId = scopeId(scope); await recover(projectId);
    return store.mutate(projectId, state => {
      const p = productIn(state, id); editable(state, p);
      const previous = p.versions.at(-1), next = metadata(input, { type: p.type, title: p.title, brief: p.brief, audience: p.audience, unitCount: p.unitCount, salesLinks: p.salesLinks });
      if ('units' in input || 'plan' in input) {
        if (!previous || input.baseVersionId !== previous.id) throw creatorError('Die Fassung wurde inzwischen geändert. Bitte die aktuelle Fassung laden.', 409);
        const submittedUnits = 'units' in input ? input.units : previous.units;
        if (!Array.isArray(submittedUnits) || !previous.outline.length || submittedUnits.length !== previous.outline.length || new Set(submittedUnits.map(u => u.id)).size !== submittedUnits.length) throw creatorError('Bitte alle Einheiten der aktuellen Gliederung speichern.');
        const units = previous.outline.map(outline => { const unit = submittedUnits.find(u => u.id === outline.id); if (!unit) throw creatorError('Eine Einheit fehlt.'); return normalizeCreatorUnit(unit, outline, next, previous.sourceSnapshots, previous.exactSnippets); });
        const plan = 'plan' in input ? normalizeCreatorPlan(input.plan, previous.sourceSnapshots) : previous.plan;
        checkCreatorOriginality([{ content: JSON.stringify(plan) }], previous.sourceSnapshots, []);
        const originality = checkCreatorOriginality(units, previous.sourceSnapshots, previous.exactSnippets);
        completeVersion({ ...previous, plan, units, stage: 'complete' });
        Object.assign(p, next, { revision: p.revision + 1, status: 'ready' });
        appendVersion(p, { ...previous, productRevision: p.revision, productSnapshot: { ...next, id, projectId }, title: next.title, plan, units, stage: 'complete', edited: true, originality });
      } else if ('salesLinks' in input && !['type', 'title', 'brief', 'audience', 'unitCount'].some(k => k in input) && previous?.stage === 'complete' && previous.productRevision === p.revision) {
        Object.assign(p, next, { revision: p.revision + 1, status: 'ready' });
        appendVersion(p, { ...previous, productRevision: p.revision, productSnapshot: { ...next, id, projectId }, edited: true });
      } else { Object.assign(p, next, { revision: p.revision + 1, status: 'draft', updatedAt: now() }); }
      return productSummary(p);
    });
  }
  async function addSources(scope, id, input = {}) {
    const projectId = scopeId(scope); const state = await recover(projectId), p = productIn(state, id); editable(state, p);
    const sources = await snapshotCreatorSources(input, { projectId, getKnowledgeEntry, getOpportunity });
    return store.mutate(projectId, state => {
      const p = productIn(state, id); editable(state, p);
      for (const source of sources) {
        const existing = p.sources.find(s => s.type === source.type && s.originalId === source.originalId && s.sha256 === source.sha256);
        if (existing) continue;
        if (p.sources.length >= 12) throw creatorError('Ein Produkt kann höchstens zwölf Quellen enthalten.');
        source.id = `S${p.sources.length + 1}`; p.sources.push(source);
      }
      for (const rights of input.sourceRights || []) { const source = p.sources.find(s => s.id === rights.sourceId || s.originalId === rights.sourceId); if (!source) throw creatorError('Der Rechtevermerk gehört zu keiner ausgewählten Quelle.'); source.rights = normalizeSourceRights(rights); }
      if (p.sources.reduce((n, s) => n + s.content.length, 0) > 400000) throw creatorError('Die Quellen sind zusammen zu groß.', 413);
      p.revision++; p.status = 'draft'; p.updatedAt = now(); return { sources: p.sources.map(({ content, ...s }) => ({ ...s, excerpt: content.slice(0, 800) })), warnings: sourceWarnings(p.sources) };
    });
  }
  async function addExactSnippet(scope, id, input = {}) {
    const projectId = scopeId(scope); await recover(projectId);
    return store.mutate(projectId, state => { const p = productIn(state, id); editable(state, p); if (p.snippets.length >= 30) throw creatorError('Höchstens dreißig einzelne Textstellen sind möglich.'); const old = p.snippets.find(s => s.sourceId === input.sourceId && s.text === String(input.text || '').trim()); if (old) return old; const snippet = normalizeExactSnippet(input, p.sources, p.snippets); p.snippets.push(snippet); p.revision++; p.status = 'draft'; p.updatedAt = now(); return snippet; });
  }
  async function getJob(scope, id) { return jobPublic(jobIn(await recover(scopeId(scope)), id)); }
  async function cancelJob(scope, id) {
    const projectId = scopeId(scope), state = await store.read(projectId), job = jobIn(state, id);
    if (!active(job.status)) return jobPublic(job);
    liveJobs.get(keyOf(projectId, id))?.abort(new Error('canceled'));
    return store.mutate(projectId, state => { const j = jobIn(state, id); if (active(j.status)) { j.status = 'interrupted'; j.phase = 'interrupted'; j.message = 'Ausarbeitung angehalten. Gespeicherte Einheiten können fortgesetzt werden.'; j.finishedAt = now(); productIn(state, j.productId).status = 'incomplete'; } return jobPublic(j); });
  }
  async function startJob(scope, id, input = {}) {
    const projectId = scopeId(scope); await recover(projectId);
    const mode = input.mode || (input.resume ? 'resume' : 'full'); if (!['full', 'outline', 'resume'].includes(mode)) throw creatorError('Unbekannter Ausarbeitungsmodus.');
    if (workQueue.length >= 20) throw creatorError('Die Creator-Warteschlange ist voll. Bitte später erneut versuchen.', 429);
    const controller = new AbortController(), jobId = randomUUID(), key = keyOf(projectId, jobId); liveJobs.set(key, controller);
    let created;
    try {
      created = await store.mutate(projectId, state => {
        const p = productIn(state, id), old = state.jobs.find(j => j.productId === id && active(j.status)); if (old) return { existing: true, job: jobPublic(old) };
        const previous = p.versions.at(-1), previousJob = state.jobs.find(j => j.productId === id && j.input?.revision === p.revision && !active(j.status)), resume = mode === 'resume' && ((previous && previous.productRevision === p.revision && previous.stage !== 'complete') || (!previous && previousJob));
        if (mode === 'resume' && !resume) throw creatorError('Es gibt keine passende unvollständige Fassung zum Fortsetzen.', 409);
        const snapshot = { id: p.id, projectId, type: p.type, title: p.title, brief: p.brief, audience: p.audience, unitCount: p.unitCount, salesLinks: p.salesLinks };
        const j = { id: jobId, projectId, productId: id, status: 'queued', phase: 'queued', message: 'Ausarbeitung ist eingereiht.', mode, createdAt: now(), startedAt: null, finishedAt: null, deadlineAt: null, ownerPid: process.pid, completedUnits: resume ? previous?.units.length || 0 : 0, totalUnits: p.unitCount, latestVersionId: resume ? previous?.id || null : null, models: [], warnings: [], input: { product: snapshot, revision: p.revision, sources: structuredClone(resume && previous ? previous.sourceSnapshots : p.sources), snippets: structuredClone(resume && previous ? previous.exactSnippets : p.snippets), instruction: creatorText(input.instruction, 4000), resumeVersionId: resume ? previous?.id || null : null } };
        state.jobs.unshift(j); p.status = 'generating'; p.updatedAt = now(); return { job: jobPublic(j) };
      });
    } catch (e) { liveJobs.delete(key); throw e; }
    if (created.existing) { liveJobs.delete(key); return created.job; }
    queueWork(key, () => execute(projectId, jobId, controller)); return created.job;
  }
  async function execute(projectId, jobId, controller) {
    const signal = controller.signal, timer = setTimeout(() => controller.abort(new Error('timeout')), Math.max(1, Math.min(timeoutMs, 1200000)));
    let current;
    try {
      current = await store.mutate(projectId, state => { const j = jobIn(state, jobId); if (!active(j.status)) return null; j.status = 'running'; j.phase = 'plan'; j.startedAt = now(); j.deadlineAt = new Date(Date.now() + Math.min(timeoutMs, 1200000)).toISOString(); return j; });
      if (!current) return;
      const input = current.input, p = productIn(await store.read(projectId), current.productId), previous = p.versions.find(v => v.id === input.resumeVersionId);
      let content = previous ? structuredClone(previous) : { productSnapshot: input.product, productRevision: input.revision, title: input.product.title, stage: 'plan', plan: null, outline: [], units: [], sourceSnapshots: input.sources, exactSnippets: input.snippets, sourceUsage: [], warnings: sourceWarnings(input.sources), jobId };
      content.jobId = jobId;
      async function save(stage, phaseMessage) {
        signal.throwIfAborted();
        await store.mutate(projectId, state => { const j = jobIn(state, jobId); if (!active(j.status) || signal.aborted) throw new Error('interrupted'); const p = productIn(state, j.productId); if (p.revision !== input.revision) throw new Error('revision changed'); const version = appendVersion(p, { ...content, stage }); j.latestVersionId = version.id; j.completedUnits = content.units.length; j.phase = stage; j.message = phaseMessage; j.updatedAt = now(); });
      }
      async function step(stage, unit, validate) {
        let feedback = '';
        for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted(); await store.project(projectId);
        const unitIndex = unit ? content.outline.findIndex(u => u.id === unit.id) : -1;
        const assignedSnippets = stage === 'unit' ? input.snippets.filter((s, i) => i % content.outline.length === unitIndex) : [];
        const result = await abortable(Promise.resolve().then(() => generate({ stage, input: { ...input, snippets: assignedSnippets, instruction: [input.instruction, feedback].filter(Boolean).join('\n\n'), plan: content.plan, outline: content.outline, unit }, signal, onProgress: async () => {} })), signal);
        signal.throwIfAborted(); if (!result?.data || typeof result.data !== 'object') throw creatorError('Der Generator hat kein verwertbares Ergebnis geliefert.', 422);
        if (typeof result.model === 'string' && /^[\w:./-]{1,160}$/.test(result.model)) await store.mutate(projectId, state => { const j = jobIn(state, jobId); if (!active(j.status)) throw new Error('interrupted'); if (!j.models.includes(result.model)) j.models.push(result.model); });
        if (Array.isArray(result.sourceUsage)) content.sourceUsage.push({ stage, unitId: unit?.id || null, excerpts: result.sourceUsage.filter(r => input.sources.some(s => s.id === r.sourceId) && Number.isInteger(r.offset) && Number.isInteger(r.end) && r.offset >= 0 && r.end > r.offset).map(r => ({ sourceId: r.sourceId, offset: r.offset, end: r.end, sha256: creatorText(r.sha256, 64) })) });
        if (result.warnings?.length) content.warnings = [...new Set([...content.warnings, 'Ein Modellversuch war nicht verfügbar; der gespeicherte Inhalt stammt aus dem ausgewiesenen erfolgreichen Modell.'])];
        try { return validate(result.data, assignedSnippets); }
        catch (error) {
          if (attempt || !String(error.code || '').startsWith('CREATOR_')) throw error;
          feedback = `Korrigiere denselben Schritt vollständig. Die lokale Prüfung meldet: ${creatorText(error.message, 800)}. Erzeuge die vollständige korrigierte JSON-Ausgabe; keine bloße Erklärung. Formuliere bei Textüberschneidungen auch den Aufbau und die Beispiele selbstständig neu.`;
          await store.mutate(projectId, state => { const j = jobIn(state, jobId); if (!active(j.status)) throw new Error('interrupted'); j.message = 'IVA überarbeitet den aktuellen Abschnitt nach der Inhaltsprüfung.'; j.repairAttempts = (j.repairAttempts || 0) + 1; });
        }
        }
      }
      if (!content.plan) { content.plan = await step('plan', null, data => { const plan = normalizeCreatorPlan(data, input.sources); checkCreatorOriginality([{ content: JSON.stringify(plan) }], input.sources, []); return plan; }); await save('plan', 'Eigenes Produktkonzept gespeichert.'); }
      if (!content.outline.length) { content.outline = await step('outline', null, data => { const outline = normalizeCreatorOutline(data, input.product.unitCount, input.sources); checkCreatorOriginality([{ content: JSON.stringify(outline) }], input.sources, []); return outline; }); await save('outline', 'Eigene Gliederung gespeichert.'); }
      if (current.mode !== 'outline') {
        for (const unit of content.outline) {
          if (content.units.some(u => u.id === unit.id)) continue;
          await store.mutate(projectId, state => { const j = jobIn(state, jobId); if (!active(j.status)) throw new Error('interrupted'); j.phase = 'unit'; j.message = `Einheit ${content.units.length + 1} von ${content.outline.length} wird vollständig ausgearbeitet: ${unit.title}`; });
          const generated = await step('unit', unit, (data, assigned) => {
            if (data.exactSnippetIds?.some(id => !assigned.some(s => s.id === id))) throw creatorError('Es dürfen nur die dieser Einheit zugewiesenen Textstellen vorkommen.', 422);
            const prepared = { ...data, content: typeof data.content === 'string' ? data.content : '', exactSnippetIds: assigned.map(s => s.id) };
            for (const snippet of assigned) {
              const block = `> ${snippet.text}\n> — ${snippet.attribution} (${snippet.locator})`;
              if (![prepared.content, ...(prepared.examples || []), ...(prepared.exercises || [])].some(text => String(text).includes(block))) prepared.content += `\n\n${block}`;
            }
            const normalized = normalizeCreatorUnit(prepared, unit, input.product, input.sources, input.snippets);
            checkCreatorOriginality([...content.units, normalized], input.sources, input.snippets); return normalized;
          });
          content.units.push(generated); content.originality = checkCreatorOriginality(content.units, input.sources, input.snippets);
          await save('unit', `${content.units.length} von ${content.outline.length} Einheiten gespeichert.`);
        }
        if (content.units.length !== content.outline.length) throw new Error('incomplete');
        completeVersion({ ...content, stage: 'complete' });
        await save('complete', 'Alle Einheiten wurden ausgearbeitet und gespeichert. Redaktionelle Schlussprüfung bleibt erforderlich.');
      }
      signal.throwIfAborted();
      await store.mutate(projectId, state => { const j = jobIn(state, jobId); if (!active(j.status) || signal.aborted) throw new Error('interrupted'); j.status = 'completed'; j.phase = current.mode === 'outline' ? 'outline' : 'complete'; j.message = current.mode === 'outline' ? 'Gliederung fertig. Die Inhalte können anschließend ausgearbeitet werden.' : 'Vollständige Fassung gespeichert; bereit für Prüfung und Export.'; j.finishedAt = now(); j.result = { productId: j.productId, versionId: j.latestVersionId, stage: j.phase }; productIn(state, j.productId).status = current.mode === 'outline' ? 'incomplete' : 'ready'; });
    } catch (e) {
      // Provider exceptions can contain credentials or request bodies. Persist
      // only our bounded diagnosis; retain every already-saved complete unit.
      await store.mutate(projectId, state => { const j = jobIn(state, jobId); if (!active(j.status)) return; j.status = signal.aborted ? 'interrupted' : 'failed'; j.phase = j.status; j.message = signal.aborted ? 'Die Ausarbeitung wurde angehalten oder hat ihr Zeitfenster erreicht. Gespeicherte Einheiten können fortgesetzt werden.' : e.code === 'budget_exceeded' ? 'Das Modellbudget ist ausgeschöpft. Gespeicherte Einheiten können nach Anpassung fortgesetzt werden.' : e.code === 'CREATOR_SOURCE_OVERLAP' ? 'Eine nicht freigegebene längere Textübernahme wurde erkannt. Der betroffene Abschnitt wurde nicht gespeichert.' : 'Der aktuelle Schritt lieferte keine vollständig geprüfte Ausarbeitung. Verbindung und Produktbriefing prüfen; gespeicherte Einheiten bleiben erhalten.'; j.error = { code: signal.aborted ? 'CREATOR_INTERRUPTED' : ['CREATOR_SOURCE_OVERLAP', 'budget_exceeded'].includes(e.code) ? e.code : 'CREATOR_GENERATION_FAILED', message: j.message }; j.finishedAt = now(); productIn(state, j.productId).status = 'incomplete'; }).catch(() => {});
    } finally { clearTimeout(timer); }
  }
  async function exportData(scope, id, { versionId } = {}) {
    const p = productIn(await recover(scopeId(scope)), id), version = versionId ? p.versions.find(v => v.id === versionId) : p.versions.at(-1);
    if (!version) throw creatorError('Es gibt noch keine gespeicherte Fassung.', 404);
    completeVersion(version);
    return { product: { ...version.productSnapshot, status: version.stage === 'complete' ? 'ready' : 'incomplete' }, version, warnings: [...version.warnings, 'Automatische Textähnlichkeitsprüfung ersetzt keine redaktionelle Prüfung.'] };
  }
  return { list, create, get, update, addSources, addExactSnippet, startJob, getJob, cancelJob, exportData };
}
