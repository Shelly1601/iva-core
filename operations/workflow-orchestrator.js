import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const WORKFLOW_BUDGET_MS = 30 * 60 * 1000;
export const WORKFLOW_LANES = Object.freeze({ 'customer-scheduling': 0, interactive: 1, batch: 2, history: 3 });
const terminal = new Set(['completed', 'cancelled', 'blocked']);
const clone = value => structuredClone(value);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

// Transactions are synchronous and short. A live transaction owner is never evicted.
function transact(file, change) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  try { fs.mkdirSync(lock); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const recovery = `${lock}.recovery`;
    const busy = () => Object.assign(new Error('Workflow persistence transaction busy'), { code: 'WORKFLOW_STORE_BUSY' });
    try { fs.mkdirSync(recovery); } catch (race) { if (race.code === 'EEXIST') throw busy(); throw race; }
    try {
      let previous;
      try { previous = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')); } catch {}
      if (!previous?.pid || alive(previous.pid)) throw busy();
      // Re-read only under the recovery mutex; an earlier stale observation must
      // never remove the lock acquired by another recovery contender.
      fs.rmSync(lock, { recursive: true }); fs.mkdirSync(lock);
    } finally { fs.rmSync(recovery, { recursive: true, force: true }); }
  }
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  try {
    const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, workflows: {}, index: {} };
    const result = change(state);
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    return clone(result);
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

export function createWorkflowOrchestrator({ file, handlers = {}, resourceLocks, clock = Date.now, maxConcurrency = 8, baseConcurrency = 2, pollMs = 250, retainCompletedWorkflows = Infinity } = {}) {
  if (!file) throw new Error('Persistent workflow file required');
  if (!Number.isFinite(maxConcurrency) || !Number.isFinite(baseConcurrency) || maxConcurrency < 1 || baseConcurrency < 1 || maxConcurrency > 64) throw new Error('Workflow concurrency must be finite and between 1 and 64');
  maxConcurrency = Math.max(2, Math.floor(maxConcurrency));
  baseConcurrency = Math.min(maxConcurrency, Math.max(1, Math.floor(baseConcurrency)));
  const owner = `${process.pid}:${crypto.randomUUID()}`;
  const active = new Map();
  const localScopes = new Map();
  let timer;
  const tx = change => transact(file, change);
  const read = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { workflows: {}, index: {} };
  function enqueue({ id = crypto.randomUUID(), kind, lane = 'interactive', shards, receivedAt = clock(), budgetMs = WORKFLOW_BUDGET_MS }) {
    if (!Array.isArray(shards) || !shards.length) throw new Error('An explicit nonempty shard scope is required');
    if (!(lane in WORKFLOW_LANES)) throw new Error('Unknown workflow lane');
    if (new Set(shards.map(s => s.id)).size !== shards.length || shards.some(s => !s.id || !s.steps?.length || s.steps.some(step => !step.id || !step.handler) || new Set(s.steps.map(step => step.id)).size !== s.steps.length)) throw new Error('Unique shard and step IDs and handlers required');
    return tx(state => {
      if (state.workflows[id]) return state.workflows[id];
      if (Number.isInteger(retainCompletedWorkflows) && retainCompletedWorkflows > 0) {
        const completed = Object.values(state.workflows).filter(workflow => workflow.status === 'completed').sort((a, b) => b.completedAt - a.completedAt);
        for (const prior of completed.slice(Math.max(0, retainCompletedWorkflows - 1))) delete state.workflows[prior.id];
      }
      const deadlineAt = receivedAt + Math.min(WORKFLOW_BUDGET_MS, Math.max(1, budgetMs));
      const workflow = { id, kind, lane, receivedAt, deadlineAt, status: 'queued', shards: [], createdAt: clock() };
      for (const shard of shards) {
        const indexKey = `${kind}:${shard.id}`;
        const stepSignature = JSON.stringify(shard.steps.map(step => [step.id, step.handler, step.scope || null]));
        const cached = shard.fingerprint && state.index[indexKey]?.fingerprint === shard.fingerprint && state.index[indexKey]?.stepSignature === stepSignature ? state.index[indexKey] : null;
        let cursor = deadlineAt;
        const steps = shard.steps.map(step => ({ ...step, status: 'pending', attempts: 0 }));
        for (let i = steps.length - 1; i >= 0; i--) { steps[i].finishBy = cursor; cursor -= steps[i].budgetMs || 10000; }
        workflow.shards.push({ ...shard, steps, stepSignature, indexKey, status: cached ? 'completed' : 'queued', checkpoint: cached?.checkpoint || null, evidence: cached?.evidence || null, reused: Boolean(cached), completedAt: cached ? clock() : null });
      }
      state.workflows[id] = workflow;
      reconcile(workflow);
      return workflow;
    });
  }
  function reconcile(workflow) {
    const now = clock();
    const complete = workflow.shards.every(s => s.status === 'completed');
    const stopped = workflow.shards.every(s => terminal.has(s.status));
    workflow.status = complete ? 'completed' : stopped ? (workflow.shards.some(s => s.status === 'blocked') ? 'blocked' : 'cancelled') : 'running';
    if (stopped) workflow.completedAt ||= now;
    workflow.slaViolated = (workflow.completedAt || now) > workflow.deadlineAt;
    workflow.totalDurationMs = (workflow.completedAt || now) - workflow.receivedAt;
  }
  function claim() {
    return tx(state => {
      const workflows = Object.values(state.workflows).filter(w => !terminal.has(w.status)).sort((a, b) => WORKFLOW_LANES[a.lane] - WORKFLOW_LANES[b.lane] || a.shards.filter(s => s.status === 'running').length - b.shards.filter(s => s.status === 'running').length || a.deadlineAt - b.deadlineAt);
      for (const workflow of workflows) {
        reconcile(workflow);
        for (const shard of workflow.shards) {
          if (shard.status === 'running' && shard.owner?.pid && !alive(shard.owner.pid)) { shard.status = 'queued'; shard.recovery = true; }
          if (shard.status !== 'queued' || (shard.retryAt || 0) > clock()) continue;
          const step = shard.steps.find(s => s.status !== 'completed');
          if (!step) continue;
          // The last slot is reserved for urgent arrivals; long lower-priority work cannot consume it.
          if (workflow.lane !== 'customer-scheduling' && active.size >= maxConcurrency - 1) continue;
          if (step.scope && (localScopes.has(step.scope) || Object.values(state.workflows).some(w => w.shards.some(s => s.status === 'running' && s.steps.some(t => t.status === 'running' && t.scope === step.scope))))) continue;
          if (!handlers[step.handler]) { shard.status = 'paused'; shard.error = `Missing handler: ${step.handler}`; continue; }
          shard.status = 'running'; shard.owner = { id: owner, pid: process.pid, heartbeat: clock() };
          shard.claimedAt ||= clock(); shard.queueDelayMs = shard.claimedAt - workflow.receivedAt;
          workflow.claimedAt ||= clock(); workflow.queueDelayMs = workflow.claimedAt - workflow.receivedAt;
          const recovery = step.status === 'running' || shard.recovery === true;
          step.status = 'running'; step.startedAt = clock(); step.attempts++;
          return { workflow: clone(workflow), shard: clone(shard), step: clone(step), recovery };
        }
      }
      return null;
    });
  }
  async function execute(item) {
    const { workflow, shard, step, recovery } = item;
    const key = `${workflow.id}:${shard.id}`;
    if (step.scope) localScopes.set(step.scope, key);
    try {
      const handler = handlers[step.handler];
      const context = { workflowId: workflow.id, shardId: shard.id, input: shard.input, savedCheckpoint: shard.checkpoint, evidence: shard.evidence, recovery, idempotencyKey: `${key}:${step.id}`, deadlineAt: workflow.deadlineAt, finishBy: step.finishBy,
        checkpoint: async data => checkpoint(workflow.id, shard.id, data) };
      // An interrupted write must reconcile its target before any repeat attempt.
      const action = async () => {
        if (recovery && step.scope) {
          if (typeof handler.reconcile !== 'function') throw Object.assign(new Error('Interrupted write requires target readback'), { code: 'READBACK_REQUIRED' });
          const observed = await handler.reconcile(context);
          if (observed?.verified === true) return observed;
          if (observed?.safeToRetry !== true) throw Object.assign(new Error('Write outcome remains ambiguous'), { code: 'READBACK_REQUIRED' });
        }
        return typeof handler === 'function' ? handler(context) : handler.run(context);
      };
      if (step.scope && !resourceLocks?.withResource) throw Object.assign(new Error('Write resource lock adapter is required'), { code: 'RESOURCE_LOCK_REQUIRED' });
      const result = step.scope ? await resourceLocks.withResource(step.scope, { jobId: workflow.id, title: workflow.kind, scope: step.scope, criticalSection: step.id }, action) : await action();
      if (result?.verified !== true || !result.evidence || typeof result.evidence !== 'object' || !Object.keys(result.evidence).length) throw Object.assign(new Error('Verified readback evidence required'), { code: 'READBACK_REQUIRED' });
      tx(state => {
        const current = state.workflows[workflow.id]; const currentShard = current.shards.find(s => s.id === shard.id); const currentStep = currentShard.steps.find(s => s.id === step.id);
        Object.assign(currentStep, { status: 'completed', completedAt: clock(), stepDurationMs: clock() - currentStep.startedAt, evidence: result.evidence });
        currentShard.evidence = { ...currentShard.evidence, [step.id]: result.evidence };
        currentShard.checkpoint = result.checkpoint ?? currentShard.checkpoint;
        currentShard.recovery = false; currentShard.owner = null;
        currentShard.status = currentShard.steps.every(s => s.status === 'completed') ? 'completed' : 'queued';
        if (currentShard.status === 'completed') {
          currentShard.completedAt = clock();
          if (currentShard.fingerprint) state.index[currentShard.indexKey] = { fingerprint: currentShard.fingerprint, stepSignature: currentShard.stepSignature, evidence: currentShard.evidence, checkpoint: currentShard.checkpoint, verifiedAt: clock() };
        }
        reconcile(current);
      });
    } catch (error) {
      tx(state => {
        const current = state.workflows[workflow.id]; const s = current.shards.find(s => s.id === shard.id); const st = s.steps.find(t => t.id === step.id);
        s.error = String(error.message || error); s.errorCode = error.code || 'STEP_FAILED'; s.owner = null;
        // External blockers isolate one case. Technical errors remain explicit unfinished work.
        s.status = error.externalBlocker === true ? 'blocked' : 'paused';
        st.stepDurationMs = clock() - st.startedAt;
        reconcile(current);
      });
    } finally { if (step.scope) localScopes.delete(step.scope); active.delete(key); }
  }
  function checkpoint(id, shardId, { safeToYield, activeScope = null, caseCheckpoint = null } = {}) {
    return tx(state => {
      const shard = state.workflows[id].shards.find(s => s.id === shardId);
      shard.checkpoint = { safeToYield: safeToYield === true, activeScope, caseCheckpoint, at: clock() };
      if (shard.owner) shard.owner.heartbeat = clock();
      return shard.checkpoint;
    });
  }
  function resume(id, shardId) { return tx(state => { const workflow = state.workflows[id]; const shard = workflow.shards.find(s => s.id === shardId); if (!['paused', 'blocked'].includes(shard.status)) throw new Error('Only paused/blocked shards can resume'); shard.status = 'queued'; shard.recovery = true; workflow.status = 'running'; delete workflow.completedAt; return workflow; }); }
  function cancel(id) { return tx(state => { const workflow = state.workflows[id]; for (const shard of workflow.shards) { if (shard.status === 'running' || shard.steps.some(s => s.status === 'running')) continue; if (!terminal.has(shard.status)) shard.status = 'cancelled'; } reconcile(workflow); return workflow; }); }
  function snapshot() {
    const now = clock();
    return Object.values(read().workflows).map(w => {
      const steps = w.shards.flatMap(s => s.steps); const done = steps.filter(s => s.status === 'completed');
      const durations = done.map(s => s.stepDurationMs || 0); const mean = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 10000;
      const activeShards = w.shards.filter(s => s.status === 'running').length;
      const remaining = steps.filter(s => s.status !== 'completed').length;
      const slowestStep = steps.map(s => ({ id: s.id, durationMs: s.status === 'running' ? now - s.startedAt : s.stepDurationMs || 0, budgetMs: s.budgetMs || 10000 })).sort((a, b) => b.durationMs - a.durationMs)[0];
      return { ...w, activeShards, finished: w.shards.filter(s => s.status === 'completed').length, total: w.shards.length, queueDelayMs: w.queueDelayMs ?? now - w.receivedAt, totalDurationMs: (w.completedAt || now) - w.receivedAt, slaViolated: (w.completedAt || now) > w.deadlineAt, slowestStep, estimatedCompletionAt: terminal.has(w.status) ? w.completedAt : now + remaining * mean / Math.max(1, activeShards || baseConcurrency), resourceLocks: w.shards.filter(s => s.status === 'running').flatMap(s => s.steps.filter(t => t.status === 'running' && t.scope).map(t => ({ scope: t.scope, jobId: w.id, shardId: s.id, heartbeat: s.owner?.heartbeat }))) };
    });
  }
  function pump() {
    const jobs = snapshot().filter(w => !terminal.has(w.status));
    const pressure = jobs.some(w => w.estimatedCompletionAt > w.deadlineAt || w.slowestStep?.durationMs > w.slowestStep?.budgetMs);
    const urgent = jobs.some(w => w.lane === 'customer-scheduling' && w.shards.some(s => s.status === 'queued'));
    const runnableJobs = jobs.filter(w => w.shards.some(s => s.status === 'queued' || s.status === 'running')).length;
    const limit = pressure || urgent ? maxConcurrency : Math.min(maxConcurrency, Math.max(baseConcurrency, runnableJobs + 1));
    while (active.size < limit) { const item = claim(); if (!item) break; const key = `${item.workflow.id}:${item.shard.id}`; const promise = Promise.resolve().then(() => execute(item)); active.set(key, promise); }
    return active.size;
  }
  async function runUntilIdle() { for (;;) { pump(); if (!active.size) return snapshot(); await Promise.race(active.values()); } }
  function start() { if (!timer) { pump(); timer = setInterval(() => { try { pump(); } catch (error) { if (error.code !== 'WORKFLOW_STORE_BUSY') throw error; } }, Math.min(1000, Math.max(10, pollMs))); timer.unref?.(); } return stop; }
  function stop() { clearInterval(timer); timer = null; }
  return { enqueue, checkpoint, resume, cancel, snapshot, pump, runUntilIdle, start, stop };
}
