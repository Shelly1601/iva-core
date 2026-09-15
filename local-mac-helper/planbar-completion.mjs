import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildPlanbarSchedulingFollowup, isoWeekRange, isExcludedPlanbarResource } from '../operations/customer-scheduling.js';

const defaultDataDir = path.join(process.env.IVA_DEVICE_WORKSPACE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'data');
const defaultTasksDir = process.env.IVA_CODEX_TASK_ROOT || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper', 'codex-tasks');
const queues = new Map();
const IDENTITY = ['customerId', 'appointmentId', 'resourceId', 'isoYear', 'week', 'startDate', 'endDateExclusive'];
const DETAIL_FIELDS = ['orderNumber', 'description', 'manufacturer', 'powerKw', 'model', 'variant'];
const STATES = new Set(['scope_pending', 'pending_details', 'external_blocked', 'mismatch', 'completed']);
const fail = (code, message) => Object.assign(new Error(message), { code });
const clean = (value, max = 300) => typeof value === 'string' ? value.replace(/\u0000/g, '').trim().slice(0, max) : '';
const same = (a, b) => String(a ?? '').replace(/\s+/g, ' ').trim() === String(b ?? '').replace(/\s+/g, ' ').trim();
const arrayText = (value, max = 30) => [...new Set((Array.isArray(value) ? value : []).map(x => clean(x, 1000)).filter(Boolean))].slice(0, max);
const jobKey = value => { const id = clean(value, 140); if (!/^[a-zA-Z0-9_-]{1,140}$/.test(id)) throw fail('PLANBAR_COMPLETION_ID', 'Ungültige Auftragskennung.'); return id; };
const caseKey = value => { if (!/^planbar-details-[a-f0-9]{64}$/.test(value || '')) throw fail('PLANBAR_COMPLETION_ID', 'Ungültige Fallkennung.'); return value; };
const caseIdFor = identity => 'planbar-details-' + createHash('sha256').update(JSON.stringify(['heat-hero', identity.customerId, identity.appointmentId])).digest('hex');
function stamp(value, now, { maxAge = Infinity, after = null } = {}) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms > now + 60_000 || now - ms > maxAge || after && ms < Date.parse(after)) throw fail('PLANBAR_COMPLETION_TIME', 'Der Prüfzeitpunkt fehlt, ist veraltet oder widersprüchlich.');
  return new Date(ms).toISOString();
}
function identityOf(value) {
  for (const field of ['customerId', 'appointmentId', 'resourceId', 'resourceName']) if (typeof value?.[field] !== 'string' || value[field].length > 180 || value[field].includes('\u0000')) throw fail('PLANBAR_COMPLETION_IDENTITY', 'Die Terminidentität fehlt oder überschreitet die zulässige Länge.');
  const identity = Object.fromEntries(['customerId', 'appointmentId', 'resourceId', 'resourceName'].map(k => [k, clean(value?.[k], 180)]));
  if (Object.values(identity).some(v => !v) || isExcludedPlanbarResource(identity.resourceName)) throw fail('PLANBAR_COMPLETION_IDENTITY', 'Ein eindeutig belegter zulässiger Planbar-Termin ist erforderlich.');
  const isoYear = Number(value.isoYear), week = Number(value.week), range = isoWeekRange(isoYear, week);
  if (value.startDate !== range.startDate || value.endDateExclusive !== range.endDateExclusive) throw fail('PLANBAR_COMPLETION_IDENTITY', 'Der rückgelesene Termin muss die vollständige Montag-bis-Freitag-Woche umfassen.');
  return { ...identity, isoYear, week, ...range };
}
function details(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const field of ['orderNumber', 'description', 'manufacturer', 'model', 'variant']) if (value[field] !== undefined && (typeof value[field] !== 'string' || value[field].length > (field === 'description' ? 16_000 : field === 'variant' ? 80 : 180) || value[field].includes('\u0000'))) throw fail('PLANBAR_COMPLETION_DETAILS', 'Terminwerte müssen vollständig innerhalb der zulässigen Feldlängen übergeben werden.');
  return { orderNumber: clean(value.orderNumber, 180), description: clean(value.description, 16_000), manufacturer: clean(value.manufacturer, 180),
    powerKw: typeof value.powerKw === 'number' && Number.isFinite(value.powerKw) && value.powerKw > 0 ? value.powerKw : null,
    model: clean(value.model, 180), variant: clean(value.variant, 80) };
}
function requiredFields(expected) {
  return ['orderNumber', 'description', 'manufacturer', 'powerKw', ...(/bosch/i.test(expected?.manufacturer || '') ? ['model'] : []), ...(/vaillant/i.test(expected?.manufacturer || '') ? ['variant'] : [])];
}
function sourceEvidence(value, now) {
  return (Array.isArray(value) ? value : []).slice(0, 50).filter(row => row && DETAIL_FIELDS.includes(row.field)).map(row => ({
    field: row.field, sourceId: clean(row.sourceId, 500), sourceKind: clean(row.sourceKind, 80), evidence: clean(row.evidence, 1800),
    verified: row.verified === true, checkedAt: row.checkedAt ? stamp(row.checkedAt, now) : null,
    matchedDealId: clean(row.matchedDealId, 100), matchedOfferNumber: clean(row.matchedOfferNumber, 180), identityVerified: row.identityVerified === true,
    signedOfferSearchComplete: row.signedOfferSearchComplete === true, signedOfferFound: row.signedOfferFound === false ? false : null,
  })).filter(row => row.sourceId && row.evidence && row.verified && row.checkedAt);
}
function blockers(value) {
  return (Array.isArray(value) ? value : []).slice(0, 20).filter(x => x?.external === true && clean(x.reason)).map(x => ({ external: true, system: clean(x.system, 80), code: clean(x.code, 100), reason: clean(x.reason, 1000) }));
}
function evaluate(record, now) {
  const expected = record.expected, actual = record.actual, readback = record.readback;
  const required = requiredFields(expected), missing = [...record.missingDetails];
  for (const field of required) {
    if (!expected?.[field]) missing.push(field);
    if (!record.sourceEvidence.some(row => row.field === field && (field !== 'orderNumber' || row.sourceKind === 'signed-offer'
      || row.sourceKind === 'original-offer' && row.identityVerified && row.signedOfferSearchComplete && row.signedOfferFound === false
        && /^[0-9]+$/.test(row.matchedDealId) && row.matchedDealId === (record.sourceCheck?.dealId || record.scopeEvidence?.dealId)
        && same(row.matchedOfferNumber, expected?.orderNumber)))) missing.push('Quellenbeleg: ' + field);
  }
  if (expected?.manufacturer && expected.description) {
    const text = expected.description.toLocaleLowerCase('de-DE').replace(/\s+/g, ' ');
    if (!text.includes(expected.manufacturer.toLocaleLowerCase('de-DE'))) missing.push('Hersteller in Sollbeschreibung');
    if (expected.powerKw && !text.replace(',', '.').includes(String(expected.powerKw) + ' kw')) missing.push('Leistung in Sollbeschreibung');
    if (/bosch/i.test(expected.manufacturer) && (!expected.model || !text.includes(expected.model.toLocaleLowerCase('de-DE')))) missing.push('Bosch-Modell in Sollbeschreibung');
    if (/vaillant/i.test(expected.manufacturer) && (!/^(plus|pro)$/i.test(expected.variant) || !text.includes(expected.variant.toLowerCase()))) missing.push('Vaillant Plus/Pro in Sollbeschreibung');
    for (const note of record.preservedNotes) if (!expected.description.includes(note)) missing.push('Belegte Bestandsnotiz erhalten');
  }
  const scopeVerified = readback?.partnerId === 'heat-hero' && readback?.customerSegment === 'private' && readback?.identityVerified === true;
  const differences = required.filter(field => expected?.[field] && !same(expected[field], actual?.[field]));
  if (!readback || !actual) missing.push('Erneutes Planbar-Rücklesen');
  if (readback) {
    if (IDENTITY.some(field => !same(record[field], readback[field]))) throw fail('PLANBAR_COMPLETION_IDENTITY', 'Ein Nachweis für einen anderen Termin darf diesen Fall nicht abschließen.');
    if (!/^HH\s+\S/i.test(readback.firstName) || /^HH\s+HH\b/i.test(readback.firstName)) missing.push('Einmaliges HH-Präfix');
    stamp(readback.checkedAt, now, { maxAge: 15 * 60_000, after: record.reservationVerifiedAt });
  }
  const missingDetails = [...new Set(missing)];
  const status = record.externalBlockers.length && (!scopeVerified || missingDetails.length || differences.length) ? 'external_blocked' : !scopeVerified ? 'scope_pending'
    : missingDetails.length ? 'pending_details' : differences.length ? 'mismatch' : 'completed';
  return { status, missingDetails, differences, detailsComplete: status === 'completed', recoveryRequired: ['pending_details', 'mismatch', 'scope_pending'].includes(status), externalActionsPending: record.remainingActions.length > 0 };
}

/** Local records only: this module never opens Planbar, creates an appointment or sends a message. */
export function createPlanbarCompletionStore({ dataDir = defaultDataDir, tasksDir = defaultTasksDir, now = Date.now, lockTimeoutMs = 5000 } = {}) {
  const file = path.join(path.resolve(dataDir), 'planbar-completion.json'), lock = file + '.lock';
  const time = () => Number(now());
  const iso = () => new Date(time()).toISOString();
  async function load() {
    try {
      const content = await readFile(file, 'utf8');
      const value = JSON.parse(content);
      if (value.version !== 1 || !Array.isArray(value.cases) || !Array.isArray(value.runs)) throw Error('schema');
      return value;
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, cases: [], runs: [] }; throw fail('PLANBAR_COMPLETION_STORE', 'Der bestehende Fallnachweis ist nicht lesbar; er wurde nicht überschrieben.'); }
  }
  async function write(value) {
    const temporary = file + '.' + randomUUID() + '.tmp'; let handle;
    try { handle = await open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); await handle.close(); handle = null; await rename(temporary, file);
      const directory = await open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); }
    }
    finally { await handle?.close().catch(() => {}); await rm(temporary, { force: true }); }
  }
  async function locked(fn) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const until = Date.now() + lockTimeoutMs, owner = { pid: process.pid, nonce: randomUUID() };
    for (;;) {
      try {
        await mkdir(lock, { mode: 0o700 });
        const handle = await open(path.join(lock, 'owner.json'), 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(owner)); } finally { await handle.close(); }
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const previous = await readFile(path.join(lock, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null);
        const age = Date.now() - (await stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
        let dead = false;
        if (Number.isInteger(previous?.pid) && previous.pid > 0) { try { process.kill(previous.pid, 0); } catch (e) { dead = e.code === 'ESRCH'; } }
        if (dead || !previous && age > 10_000) {
          const recovery = lock + '.recovery';
          try {
            await mkdir(recovery, { mode: 0o700 });
            try {
              const current = await readFile(path.join(lock, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null);
              const currentAge = Date.now() - (await stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
              let currentDead = false;
              if (Number.isInteger(current?.pid) && current.pid > 0) { try { process.kill(current.pid, 0); } catch (e) { currentDead = e.code === 'ESRCH'; } }
              if (currentDead || !current && currentAge > 10_000) {
                const abandoned = lock + '.abandoned-' + randomUUID();
                try { await rename(lock, abandoned); await rm(abandoned, { recursive: true, force: true }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
              }
            } finally { await rm(recovery, { recursive: true, force: true }); }
          } catch (e) { if (!['EEXIST', 'ENOENT'].includes(e.code)) throw e; }
          if (Date.now() >= until) throw fail('PLANBAR_COMPLETION_BUSY', 'Der Fallnachweis wartet auf die Wiederherstellung seiner Schreibsperre.');
          await new Promise(resolve => setTimeout(resolve, 25)); continue;
        }
        if (Date.now() >= until) throw fail('PLANBAR_COMPLETION_BUSY', 'Der Fallnachweis wird gerade aktualisiert; denselben Vorgang später erneut prüfen.');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    try { return await fn(); }
    finally { const current = await readFile(path.join(lock, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null); if (current?.nonce === owner.nonce) await rm(lock, { recursive: true, force: true }); }
  }
  const mutate = fn => {
    const previous = queues.get(file) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => locked(async () => { const data = await load(); const result = await fn(data); await write(data); return structuredClone(result); }));
    queues.set(file, current);
    current.finally(() => { if (queues.get(file) === current) queues.delete(file); }).catch(() => {});
    return current;
  };
  function upsert(data, incoming) {
    caseKey(incoming.caseId); identityOf(incoming);
    const previous = data.cases.find(row => row.caseId === incoming.caseId);
    if (previous) {
      if (IDENTITY.some(field => !same(previous[field], incoming[field]))) throw fail('PLANBAR_COMPLETION_IDENTITY', 'Eine bestehende Reservierung darf nicht ersetzt werden.');
      previous.jobIds = [...new Set([...previous.jobIds, incoming.jobId].filter(Boolean))];
      if (Date.parse(incoming.updatedAt) >= Date.parse(previous.sourceUpdatedAt)) {
        previous.remainingActions = arrayText(incoming.remainingActions);
        previous.sourceUpdatedAt = incoming.updatedAt;
        previous.externalActionsPending = previous.remainingActions.length > 0;
      }
      return previous;
    }
    const record = { ...incoming, sourceStatus: incoming.status, status: incoming.customerSegment === 'private' ? 'pending_details' : 'scope_pending',
      jobIds: incoming.jobId ? [incoming.jobId] : [], sourceUpdatedAt: incoming.updatedAt, createdAt: iso(), updatedAt: iso(),
      expected: null, actual: null, readback: null, sourceEvidence: [], externalBlockers: [], differences: [], preservedNotes: arrayText(incoming.preservedNotes),
      detailsComplete: false, recoveryRequired: true, externalActionsPending: incoming.remainingActions.length > 0, history: [] };
    data.cases.push(record); return record;
  }
  async function capture(request, progress) {
    const followup = buildPlanbarSchedulingFollowup({ ...(request.planbar || request), jobId: request.jobId, requestId: request.requestId }, progress);
    if (!followup) return null;
    return mutate(data => upsert(data, followup));
  }
  async function enqueueObservedCase({ scopeEvidence, identity, missingDetails = [], remainingActions = [], preservedNotes = [], runId = '', customerName = '' }) {
    if (scopeEvidence?.partnerId !== 'heat-hero' || scopeEvidence.customerSegment === 'business') return null;
    if (scopeEvidence.identityVerified !== true || !clean(scopeEvidence.evidence, 1500)) throw fail('PLANBAR_COMPLETION_SCOPE', 'Der belegte Bezug zum bestehenden Heat-Hero-Termin fehlt.');
    const checkedAt = stamp(scopeEvidence.checkedAt, time(), { maxAge: 15 * 60_000 });
    const observed = identityOf(identity);
    const segment = scopeEvidence.customerSegment === 'private' ? 'private' : 'unknown';
    return mutate(data => {
      const known = data.cases.find(row => IDENTITY.every(field => same(row[field], observed[field])));
      const record = upsert(data, { ...observed, caseId: known?.caseId || caseIdFor(observed), kind: 'planbar-details', projectId: 'heat-hero', partnerId: 'heat-hero', partnerPrefix: 'HH',
        customerName: clean(customerName, 180), customerSegment: segment, requiresPrivateCustomerCheck: segment !== 'private', jobId: '', requestId: '', schedulingKey: '',
        reservationVerifiedAt: checkedAt, updatedAt: checkedAt, status: 'pending', missingDetails: arrayText(missingDetails), remainingActions: arrayText(remainingActions), preservedNotes });
      record.scopeEvidence = { partnerId: 'heat-hero', customerSegment: segment, identityVerified: true, checkedAt, evidence: clean(scopeEvidence.evidence, 1500), dealId: /^[0-9]+$/.test(scopeEvidence.dealId || '') ? scopeEvidence.dealId : '' };
      if (runId) { const run = data.runs.find(row => row.jobId === jobKey(runId)); if (!run || run.status !== 'running') throw fail('PLANBAR_COMPLETION_RUN', 'Der zugehörige Bestandslauf ist nicht offen.'); run.caseIds = [...new Set([...run.caseIds, record.caseId])]; }
      return record;
    });
  }
  async function recordProof(id, input = {}) {
    caseKey(id);
    return mutate(data => {
      const record = data.cases.find(row => row.caseId === id);
      if (!record) throw fail('PLANBAR_COMPLETION_NOT_FOUND', 'Planbar-Fall nicht gefunden.');
      let readback = null;
      if (input.readback) {
        const value = input.readback;
        if (value.source !== 'planbar' || value.identityVerified !== true || !clean(value.evidence, 1800) || value.partnerId !== 'heat-hero' || value.customerSegment !== 'private') throw fail('PLANBAR_COMPLETION_SCOPE', 'Schreibnachweise dürfen nur eindeutig belegte private Heat-Hero-Termine betreffen.');
        readback = { ...identityOf(value), source: 'planbar', identityVerified: true, partnerId: 'heat-hero', customerSegment: 'private',
          checkedAt: stamp(value.checkedAt, time(), { maxAge: 15 * 60_000, after: record.reservationVerifiedAt }), evidence: clean(value.evidence, 1800), firstName: clean(value.firstName, 180) };
      }
      const next = { ...record, expected: details(input.expected || record.expected), actual: details(input.actual), readback,
        sourceEvidence: sourceEvidence(input.sourceEvidence || record.sourceEvidence, time()), missingDetails: arrayText(input.missingDetails),
        externalBlockers: blockers(input.externalBlockers), preservedNotes: [...new Set([...record.preservedNotes, ...arrayText(input.preservedNotes)])], updatedAt: iso() };
      Object.assign(next, evaluate(next, time()));
      if (next.status === 'completed') { next.completedAt = iso(); next.customerSegment = 'private'; next.requiresPrivateCustomerCheck = false; }
      else next.completedAt = null;
      next.history = [...record.history, { checkedAt: iso(), status: next.status, differences: next.differences, missingDetails: next.missingDetails, externalBlockerCodes: next.externalBlockers.map(x => x.code) }].slice(-100);
      Object.assign(record, next); return record;
    });
  }
  async function reconcile({ tasksDir: directory = tasksDir } = {}) {
    const summary = { checked: 0, captured: 0, skipped: [] };
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/i.test(entry.name)) continue;
      const base = path.join(directory, entry.name); let request;
      try {
        request = JSON.parse(await readFile(path.join(base, 'request.json'), 'utf8'));
        if (!request.planbar) continue;
        summary.checked++;
        const progress = await readFile(path.join(base, 'planbar-progress.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; })
          || (await readFile(path.join(base, 'state.json'), 'utf8').then(JSON.parse)).planbarProgress;
        if (!progress?.reservation?.verified) continue;
        if (await capture(request, progress)) summary.captured++;
      } catch (error) { summary.skipped.push({ jobId: entry.name, code: /^PLANBAR_/.test(error.code || '') ? error.code : 'PLANBAR_COMPLETION_RECEIPT_UNREADABLE' }); }
    }
    return summary;
  }
  async function beginRun(jobId, { refreshedAt, scope, sourceChecks = [] } = {}) {
    jobId = jobKey(jobId);
    if (scope !== 'heat-hero-private') throw fail('PLANBAR_COMPLETION_SCOPE', 'Der Tageslauf muss auf private Heat-Hero-Fälle begrenzt sein.');
    const fresh = refreshedAt ? stamp(refreshedAt, time(), { maxAge: 5 * 60_000 }) : null;
    const checks = (Array.isArray(sourceChecks) ? sourceChecks : []).slice(0, 20).map(row => ({ source: clean(row.source, 80), status: row.status === 'blocked' ? 'unavailable' : clean(row.status, 40), reason: clean(row.reason, 1000), external: row.external === true,
      evidence: clean(row.evidence, 1800), observedCount: Number.isInteger(row.observedCount) && row.observedCount >= 0 ? row.observedCount : null,
      checkedAt: row.checkedAt ? stamp(row.checkedAt, time(), { maxAge: 5 * 60_000 }) : null }));
    if (!checks.some(row => row.source === 'planbar') || checks.some(row => !row.source || !['read', 'unavailable', 'not_required'].includes(row.status))) throw fail('PLANBAR_COMPLETION_SOURCE', 'Die tatsächliche Planbar-Quellenprüfung muss ausgewiesen sein.');
    return mutate(data => {
      const existing = data.runs.find(row => row.jobId === jobId);
      if (existing?.status === 'completed') return existing;
      const run = { jobId, protocol: 2, scope, status: 'running', startedAt: existing?.startedAt || iso(), refreshedAt: fresh, sourceChecks: checks,
        caseIds: [...new Set([...(existing?.caseIds || []), ...data.cases.filter(row => row.status !== 'completed').map(row => row.caseId)])], updatedAt: iso() };
      if (existing) Object.assign(existing, run); else data.runs.push(run);
      return run;
    });
  }
  async function finishRun(jobId, { checkedCaseIds = [], inventoryComplete, finalReadbackStartedAt, finalReadbackAt } = {}) {
    jobId = jobKey(jobId);
    if (!Array.isArray(checkedCaseIds)) throw fail('PLANBAR_COMPLETION_CASES', 'Die geprüften Fälle fehlen.');
    const ids = [...new Set(checkedCaseIds.map(caseKey))];
    return mutate(data => {
      const run = data.runs.find(row => row.jobId === jobId);
      if (!run) throw fail('PLANBAR_COMPLETION_RUN', 'Der Tageslauf wurde nicht begonnen.');
      if (run.status === 'completed') return run;
      const finalAt = finalReadbackAt ? stamp(finalReadbackAt, time(), { maxAge: 15 * 60_000, after: run.refreshedAt }) : null;
      const finalStart = finalReadbackStartedAt ? stamp(finalReadbackStartedAt, time(), { maxAge: 15 * 60_000, after: run.refreshedAt }) : null;
      if (finalStart && finalAt && Date.parse(finalStart) > Date.parse(finalAt)) throw fail('PLANBAR_COMPLETION_TIME', 'Die abschließende Rückprüfung endet vor ihrem Beginn.');
      const cases = ids.map(id => { const row = data.cases.find(row => row.caseId === id); if (!row) throw fail('PLANBAR_COMPLETION_NOT_FOUND', 'Ein geprüfter Fall ist nicht gespeichert.'); return row; });
      const omitted = [...new Set([...run.caseIds, ...data.cases.filter(row => row.status !== 'completed').map(row => row.caseId)])].filter(id => !ids.includes(id));
      const stale = cases.filter(row => row.status === 'completed' && (!row.readback || !finalStart || Date.parse(row.readback.checkedAt) < Date.parse(finalStart) || time() - Date.parse(row.readback.checkedAt) > 15 * 60_000 || !finalAt || Date.parse(row.readback.checkedAt) > Date.parse(finalAt)));
      const incomplete = cases.filter(row => row.status !== 'completed');
      const planbarRead = Boolean(run.refreshedAt) && run.sourceChecks.some(row => row.source === 'planbar' && row.status === 'read' && row.evidence && row.checkedAt && Date.parse(row.checkedAt) >= Date.parse(run.refreshedAt) && row.observedCount !== null);
      const unavailable = run.sourceChecks.filter(row => row.status === 'unavailable');
      const inventoryAccountedFor = cases.length >= Math.max(0, ...run.sourceChecks.filter(row => row.source === 'planbar' && row.status === 'read').map(row => row.observedCount || 0));
      const complete = inventoryComplete === true && inventoryAccountedFor && planbarRead && finalStart && finalAt && !omitted.length && !incomplete.length && !stale.length && !unavailable.length;
      const recoveryRequired = Boolean(omitted.length || stale.length || !inventoryAccountedFor || incomplete.some(row => row.recoveryRequired) || unavailable.some(row => !row.external) || (inventoryComplete !== true || !planbarRead || !finalStart || !finalAt) && !unavailable.some(row => row.source === 'planbar' && row.external));
      Object.assign(run, { status: complete ? 'completed' : 'partial', checkedCaseIds: ids, inventoryComplete: inventoryComplete === true, finalReadbackStartedAt: finalStart, finalReadbackAt: finalAt,
        checked: cases.length, completed: cases.filter(row => row.status === 'completed').length, pending: incomplete.length, omittedCaseIds: omitted, staleCaseIds: stale.map(row => row.caseId),
        sourceFailures: unavailable, inventoryAccountedFor, recoveryRequired, retryRequired: recoveryRequired, completedAt: iso(), updatedAt: iso() });
      return run;
    });
  }
  return Object.freeze({ capture, enqueueObservedCase, recordProof, reconcile, beginRun, finishRun,
    async list({ status } = {}) { if (status && !STATES.has(status)) throw fail('PLANBAR_COMPLETION_STATUS', 'Unbekannter Fallstatus.'); return (await load()).cases.filter(row => !status || row.status === status); },
    async get(id) { caseKey(id); return (await load()).cases.find(row => row.caseId === id) || null; },
    async getRun(id) { const key = jobKey(id); return (await load()).runs.find(row => row.jobId === key) || null; },
  });
}
