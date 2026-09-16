import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createKnowledgeResearchStore } from './research-store.js';
import { normalizeResearchSchedule, nextResearchRunAt } from './research-schedule.js';
import { researchClean, researchHash, normalizeResearchDomains, knowledgeResearchCapabilities, collectKnowledgeResearch, synthesizeKnowledgeResearch } from './research-executor.js';
import { listKnowledgeEntries, getKnowledgeEntry, createKnowledgeEntry, updateKnowledgeEntry } from './store.js';

const ACTIVE = new Set(['queued', 'running']);
const controllers = new Map();
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code: `KNOWLEDGE_RESEARCH_${code}`, status });
const marker = id => `[iva-research:${id}]`;
const hashContent = entry => researchHash(entry?.content || '');
const clone = value => structuredClone(value);
const deadPid = pid => { if (!Number.isInteger(pid) || pid < 1) return true; try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };

function normalize(input, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('INVALID_INPUT', 'Bitte gültige Recherchekriterien angeben.');
  const value = key => input[key] === undefined ? previous[key] : input[key];
  const text = (key, max, fallback = '') => {
    const raw = value(key) ?? fallback;
    if (typeof raw !== 'string' || raw.length > max) throw fail('INVALID_INPUT', `${key}: Bitte einen Text mit höchstens ${max} Zeichen angeben.`);
    return researchClean(raw, max);
  };
  const terms = key => {
    const raw = value(key) ?? [];
    if (!Array.isArray(raw) || raw.length > 20 || raw.some(v => typeof v !== 'string' || v.length > 160)) throw fail('INVALID_INPUT', `${key}: Höchstens 20 Begriffe mit je 160 Zeichen angeben.`);
    return [...new Set(raw.map(v => researchClean(v, 160)).filter(Boolean))];
  };
  const topic = text('topic', 600);
  if (topic.length < 2) throw fail('INVALID_INPUT', 'Bitte ein Recherchethema angeben.');
  const maxSources = value('maxSources') ?? 5, enabled = value('enabled') ?? true;
  if (!Number.isInteger(maxSources) || maxSources < 1 || maxSources > 8) throw fail('INVALID_INPUT', 'Bitte zwischen einer und acht Quellen auswählen.');
  if (typeof enabled !== 'boolean') throw fail('INVALID_INPUT', 'Aktiviert muss wahr oder falsch sein.');
  let schedule, domains;
  try { schedule = normalizeResearchSchedule(input.schedule ?? {}, previous.schedule ?? {}); domains = normalizeResearchDomains(value('domains') ?? []); }
  catch (error) { throw fail('INVALID_INPUT', error.message); }
  return { topic, category: text('category', 140, 'Allgemein') || 'Allgemein', keywords: terms('keywords'), excludeTerms: terms('excludeTerms'), domains,
    region: text('region', 140), objective: text('objective', 2000), schedule, maxSources, enabled };
}

function publicPlan(plan) {
  const result = clone(plan);
  for (const key of ['requestId', 'requestHash', 'lastContentHash', 'lastFingerprint', 'pendingPublication']) delete result[key];
  for (const run of [result.latestRun, ...(result.runs || [])].filter(Boolean)) for (const key of ['leaseId', 'ownerPid', 'deadlineAt', 'revision', 'recoveryOnly']) delete run[key];
  result.versions = (result.versions || []).map(({ content, notes, ...meta }) => meta);
  return result;
}
function findPlan(state, id) { const plan = state.plans.find(p => p.id === id); if (!plan) throw fail('NOT_FOUND', 'Die Recherche wurde nicht gefunden.', 404); return plan; }
function archiveRun(plan) { if (plan.latestRun) plan.runs = [...(plan.runs || []), clone(plan.latestRun)].slice(-30); }
function queueRun(plan, at, trigger = 'manual') {
  if (ACTIVE.has(plan.latestRun?.status)) return;
  if (plan.pendingPublication && plan.latestRun?.revision === plan.revision) {
    Object.assign(plan.latestRun, { status: 'queued', phase: 'publishing', queuedAt: at, error: null, completedAt: null });
    return;
  }
  archiveRun(plan);
  plan.latestRun = { id: randomUUID(), status: 'queued', phase: 'queued', trigger, revision: plan.revision, queuedAt: at, startedAt: null, completedAt: null, error: null,
    sourceCount: 0, sources: [], limitations: [], changed: false, knowledgeEntryId: plan.knowledgeEntryId || null };
  plan.updatedAt = at;
}
function finish(plan, status, at, details = {}) {
  Object.assign(plan.latestRun, { status, completedAt: at, ...details });
  delete plan.latestRun.leaseId; delete plan.latestRun.ownerPid; delete plan.latestRun.deadlineAt; delete plan.latestRun.recoveryOnly;
  plan.updatedAt = at;
}
function reportContent(plan, result, sources, checkedAt) {
  const sections = [`${result.title}\n\nRecherche geprüft: ${checkedAt}\nThema: ${plan.topic}`];
  if (plan.objective) sections.push(`Ziel: ${plan.objective}`);
  sections.push('Erkenntnisse\n' + result.findings.map(f => `• ${f.text} [${f.sourceId}]\n  Beleg: „${f.quote}“`).join('\n\n'));
  sections.push('Gelesene Quellen\n' + sources.map(s => `[${s.id}] ${s.title || s.url}\n${s.url}`).join('\n\n'));
  sections.push('Grenzen\n' + [...new Set(['Automatisch zusammengefasste öffentliche Quellen; Aussagen gelten für den angegebenen Prüfzeitpunkt.', ...result.limitations])].map(v => `• ${v}`).join('\n'));
  return sections.join('\n\n');
}

/** Durable, bounded research queue. HTTP callers only enqueue; tick performs at most one run. */
export function createKnowledgeResearchService(deps = {}) {
  const env = deps.env || process.env, now = deps.now || Date.now;
  const store = createKnowledgeResearchStore({ file: deps.file || path.join(env.DATA_DIR || '/data', 'knowledge-research.json') });
  const knowledge = deps.knowledge || { list: listKnowledgeEntries, get: getKnowledgeEntry, create: createKnowledgeEntry, update: updateKnowledgeEntry };
  const timeoutMs = Math.max(20, Math.min(120000, deps.timeoutMs || 120000));
  const iso = () => new Date(now()).toISOString();
  const key = id => `${store.file}:${id}`;
  const criteriaHash = plan => researchHash(JSON.stringify(normalize({}, plan)));

  async function healthyKnowledge() {
    if (deps.knowledge) return;
    try {
      const file = path.join(process.env.DATA_DIR || '/data', 'knowledge-base.json');
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid knowledge file');
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Array.isArray(data.entries)) throw new Error('Invalid knowledge entries');
    } catch (error) { if (error.code !== 'ENOENT') throw fail('STORE_UNREADABLE', 'Die Wissensdatenbank ist gerade nicht sicher lesbar; es wird nichts überschrieben.', 503); }
  }
  async function existingEntry(plan) {
    await healthyKnowledge();
    if (plan.knowledgeEntryId) {
      const entry = await knowledge.get(plan.knowledgeEntryId);
      if (!entry || entry.status === 'archived') throw fail('ENTRY_CHANGED', 'Der zugehörige Wissenseintrag wurde gelöscht oder archiviert. Bitte einen neuen Rechercheauftrag anlegen.', 409);
      if (!String(entry.notes || '').includes(marker(plan.id))) throw fail('ENTRY_CHANGED', 'Die Zuordnung des Wissenseintrags wurde manuell verändert.', 409);
      return entry;
    }
    const [active, archived] = await Promise.all([knowledge.list({ query: marker(plan.id), limit: 300 }), knowledge.list({ query: marker(plan.id), status: 'archived', limit: 300 })]);
    const rows = [...new Map([...active, ...archived].map(row => [row.id, row])).values()];
    const matches = rows.filter(row => String(row.notes || '').includes(marker(plan.id)));
    if (matches.length > 1) throw fail('ENTRY_CONFLICT', 'Mehrere Wissenseinträge sind dieser Recherche zugeordnet; bitte die Zuordnung prüfen.', 409);
    const entry = matches[0] ? await knowledge.get(matches[0].id) : null;
    if (entry?.status === 'archived') throw fail('ENTRY_CHANGED', 'Der zugehörige Wissenseintrag wurde archiviert. Bitte einen neuen Rechercheauftrag anlegen.', 409);
    return entry;
  }
  function assertCurrent(plan, claimed, signal) {
    signal?.throwIfAborted();
    if (!plan.enabled || plan.revision !== claimed.revision || plan.latestRun?.id !== claimed.latestRun.id || plan.latestRun.status !== 'running' || plan.latestRun.leaseId !== claimed.latestRun.leaseId)
      throw fail('CANCELED', 'Diese Recherche wurde pausiert oder verändert.', 409);
  }
  function published(plan, entry, at) {
    const pending = plan.pendingPublication;
    plan.knowledgeEntryId = entry.id; plan.lastContentHash = pending.contentHash; plan.lastFingerprint = pending.fingerprint;
    plan.versions = [...(plan.versions || []), { runId: plan.latestRun.id, knowledgeEntryId: entry.id, title: pending.input.title,
      contentHash: pending.contentHash, content: pending.input.content, notes: pending.input.notes, checkedAt: pending.checkedAt, sourceCount: pending.sources.length }].slice(-10);
    finish(plan, 'succeeded', at, { phase: 'complete', changed: true, checkedAt: pending.checkedAt, sourceCount: pending.sources.length, sources: pending.sources,
      limitations: pending.limitations, knowledgeEntryId: entry.id, error: null });
    delete plan.pendingPublication;
  }
  async function publish(claimed, signal, { readOnly = false } = {}) {
    return store.mutate(async state => {
      const plan = findPlan(state, claimed.id); assertCurrent(plan, claimed, signal);
      const pending = plan.pendingPublication;
      if (!pending) throw fail('PUBLICATION_MISSING', 'Das gespeicherte Rechercheergebnis fehlt.', 500);
      let entry = await existingEntry(plan);
      assertCurrent(plan, claimed, signal);
      if (entry && hashContent(entry) === pending.contentHash && String(entry.notes || '').includes(`run:${plan.latestRun.id}`)) {
        published(plan, entry, iso()); return publicPlan(plan);
      }
      if (readOnly) {
        finish(plan, 'interrupted', iso(), { error: 'Der Server wurde während des Speicherns unterbrochen. „Jetzt recherchieren“ wiederholt nur die ausstehende Speicherung.' });
        return publicPlan(plan);
      }
      if (entry && (!plan.lastContentHash || hashContent(entry) !== plan.lastContentHash)) throw fail('ENTRY_CHANGED', 'Der Wissenseintrag wurde manuell bearbeitet. Diese Recherche überschreibt die Änderungen nicht.', 409);
      await healthyKnowledge(); assertCurrent(plan, claimed, signal);
      entry = entry ? await knowledge.update(entry.id, pending.input, { expectedContentHash: plan.lastContentHash }) : await knowledge.create(pending.input);
      assertCurrent(plan, claimed, signal);
      if (!entry?.id) throw fail('READBACK_FAILED', 'Der Wissenseintrag konnte noch nicht bestätigt werden.', 503);
      // A write result alone is not proof: reopen the entry before marking it learned.
      const confirmed = await knowledge.get(entry.id);
      assertCurrent(plan, claimed, signal);
      if (!confirmed || confirmed.status !== 'ready' || hashContent(confirmed) !== pending.contentHash || !String(confirmed.notes || '').includes(`run:${plan.latestRun.id}`))
        throw fail('READBACK_FAILED', 'Der gespeicherte Wissenseintrag konnte noch nicht vollständig rückgelesen werden.', 503);
      published(plan, confirmed, iso()); return publicPlan(plan);
    });
  }
  async function list() { return (await store.read()).plans.map(publicPlan).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async function create(input = {}) {
    const criteria = normalize(input), requestId = input.requestId;
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId))) throw fail('INVALID_REQUEST', 'Die Kennung für den Rechercheauftrag ist ungültig.');
    const requestHash = researchHash(JSON.stringify(criteria));
    return store.mutate(state => {
      const existing = requestId && state.plans.find(p => p.requestId === requestId);
      if (existing) { if (existing.requestHash !== requestHash) throw fail('REQUEST_CONFLICT', 'Diese Anfragekennung wurde bereits für andere Kriterien verwendet.', 409); return publicPlan(existing); }
      if (state.plans.length >= 100) throw fail('PLAN_LIMIT', 'Es sind bereits 100 Rechercheaufträge eingerichtet.', 409);
      const at = iso(), plan = { id: randomUUID(), ...criteria, requestId, requestHash, revision: 1, createdAt: at, updatedAt: at, nextRunAt: criteria.enabled ? nextResearchRunAt(criteria.schedule, at) : null,
        latestRun: null, knowledgeEntryId: null, versions: [], runs: [] };
      if (plan.enabled && plan.schedule.frequency === 'once') queueRun(plan, at, 'initial');
      state.plans.push(plan); return publicPlan(plan);
    });
  }
  async function update(id, patch = {}) {
    const result = await store.mutate(state => {
      const plan = findPlan(state, id), criteria = normalize(patch, plan), changed = criteriaHash(plan) !== researchHash(JSON.stringify(criteria));
      if (!changed) return publicPlan(plan);
      Object.assign(plan, criteria, { revision: plan.revision + 1, updatedAt: iso() });
      if (ACTIVE.has(plan.latestRun?.status)) finish(plan, 'canceled', iso(), { error: plan.enabled ? 'Recherchekriterien geändert. Der neue Lauf kann jetzt gestartet werden.' : 'Recherche pausiert.' });
      delete plan.pendingPublication;
      plan.nextRunAt = plan.enabled ? nextResearchRunAt(plan.schedule, iso()) : null;
      controllers.get(key(id))?.abort(fail('CANCELED', 'Recherche pausiert oder verändert.', 409));
      return publicPlan(plan);
    });
    return result;
  }
  async function runNow(id) {
    return store.mutate(state => { const plan = findPlan(state, id); if (!plan.enabled) throw fail('PAUSED', 'Bitte die Recherche zuerst aktivieren.', 409); queueRun(plan, iso()); return publicPlan(plan); });
  }
  async function claim() {
    return store.mutate(state => {
      const at = iso(), timestamp = now();
      for (const plan of state.plans) {
        const run = plan.latestRun;
        if (run?.status === 'running' && (Date.parse(run.deadlineAt) <= timestamp || deadPid(run.ownerPid))) {
          if (plan.pendingPublication && plan.enabled && run.revision === plan.revision) {
            Object.assign(run, { status: 'queued', recoveryOnly: true });
          } else finish(plan, 'interrupted', at, { error: 'Die Recherche wurde unterbrochen. Kein Wissen wurde als gelernt bestätigt; ein neuer Lauf kann manuell gestartet werden.' });
        }
      }
      if (state.plans.some(plan => plan.latestRun?.status === 'running')) return null;
      for (const plan of state.plans) {
        if (plan.enabled && plan.nextRunAt && Date.parse(plan.nextRunAt) <= timestamp) {
          if (!ACTIVE.has(plan.latestRun?.status)) queueRun(plan, at, 'schedule');
          plan.nextRunAt = nextResearchRunAt(plan.schedule, at);
        }
      }
      const plan = state.plans.filter(p => p.enabled && p.latestRun?.status === 'queued').sort((a, b) => a.latestRun.queuedAt.localeCompare(b.latestRun.queuedAt))[0];
      if (!plan) return null;
      Object.assign(plan.latestRun, { status: 'running', phase: plan.pendingPublication ? 'publishing' : 'collecting', startedAt: at,
        ownerPid: process.pid, leaseId: randomUUID(), deadlineAt: new Date(timestamp + timeoutMs + 5000).toISOString() });
      return clone(plan);
    });
  }
  async function execute(claimed, signal) {
    if (claimed.pendingPublication) return publish(claimed, signal, { readOnly: claimed.latestRun.recoveryOnly === true });
    const capability = knowledgeResearchCapabilities(deps);
    if (!capability.ready) throw fail('NOT_CONFIGURED', capability.message || 'Für die Recherche fehlen eine Suchanbindung oder ein Sprachmodell.', 503);
    const collected = await collectKnowledgeResearch(claimed, { ...deps, signal }); signal.throwIfAborted();
    const unchanged = await store.mutate(async state => {
      const plan = findPlan(state, claimed.id); assertCurrent(plan, claimed, signal);
      if (plan.lastFingerprint !== collected.fingerprint) return null;
      const entry = await existingEntry(plan); assertCurrent(plan, claimed, signal);
      if (!entry || hashContent(entry) !== plan.lastContentHash) throw fail('ENTRY_CHANGED', 'Der Wissenseintrag wurde manuell geändert. Die Recherche überschreibt ihn nicht.', 409);
      finish(plan, 'unchanged', iso(), { phase: 'complete', changed: false, checkedAt: iso(), sourceCount: collected.sources.length,
        sources: collected.sources.map(({ text, ...source }) => source), limitations: collected.limitations, error: null, knowledgeEntryId: entry.id });
      return publicPlan(plan);
    });
    if (unchanged) return unchanged;
    const result = await synthesizeKnowledgeResearch(claimed, collected, { ...deps, signal }); signal.throwIfAborted();
    const checkedAt = iso(), content = reportContent(claimed, result, collected.sources, checkedAt);
    const pending = { checkedAt, contentHash: researchHash(content), fingerprint: collected.fingerprint, sources: collected.sources.map(({ text, ...source }) => source), limitations: result.limitations,
      input: { title: result.title, kind: 'knowledge', category: claimed.category, sourceOwner: 'public-reference', sourceUrl: collected.sources[0].url,
        tags: ['Selbstrecherche', ...claimed.keywords].slice(0, 24), content,
        notes: `${marker(claimed.id)} run:${claimed.latestRun.id}\nGeprüft: ${checkedAt}; Modell: ${result.model}. Öffentliche Quellen, automatisch zusammengefasst.` } };
    await store.mutate(state => { const plan = findPlan(state, claimed.id); assertCurrent(plan, claimed, signal); plan.pendingPublication = pending; plan.latestRun.phase = 'publishing'; });
    return publish(claimed, signal);
  }
  async function tick() {
    const claimed = await claim(); if (!claimed) return { worked: false };
    const controller = new AbortController(); controllers.set(key(claimed.id), controller);
    const timeout = setTimeout(() => controller.abort(fail('TIMEOUT', 'Die Recherche hat ihr Zeitlimit erreicht. Es wird nicht automatisch erneut gesucht.', 504)), timeoutMs);
    let onAbort;
    try {
      const aborted = new Promise((_, reject) => { onAbort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', onAbort, { once: true }); });
      const plan = await Promise.race([execute(claimed, controller.signal), aborted]);
      return { worked: true, planId: plan.id, runId: plan.latestRun.id, status: plan.latestRun.status };
    } catch (error) {
      const plan = await store.mutate(state => {
        const plan = findPlan(state, claimed.id);
        if (plan.latestRun?.id === claimed.latestRun.id && plan.latestRun.leaseId === claimed.latestRun.leaseId && plan.latestRun.status === 'running') {
          const message = String(error.code || '').startsWith('KNOWLEDGE_RESEARCH_') ? error.message
            : ['NO_READABLE_SOURCES', 'NO_GROUNDED_FINDINGS'].includes(error.code) ? error.message : 'Die Recherche konnte nicht sicher abgeschlossen werden. Es wurde kein neues Wissen bestätigt.';
          finish(plan, plan.pendingPublication ? 'interrupted' : 'failed', iso(), { error: researchClean(message, 500), limitations: [plan.pendingPublication ? 'Eine ausstehende Speicherung wird beim nächsten manuellen Start ohne neue Such- oder Modellkosten geprüft.' : 'Keine automatische Wiederholung dieses fehlgeschlagenen Laufs.'] });
        }
        return publicPlan(plan);
      });
      return { worked: true, planId: plan.id, runId: plan.latestRun.id, status: plan.latestRun.status };
    } finally { clearTimeout(timeout); controller.signal.removeEventListener('abort', onAbort); if (controllers.get(key(claimed.id)) === controller) controllers.delete(key(claimed.id)); }
  }
  return { list, create, update, runNow, tick, async capabilities() { return knowledgeResearchCapabilities(deps); } };
}
