export const WORKFLOW_RESULT_BUDGET_MS = 30 * 60_000;
export const SCHEDULING_MINIMAL_BUDGET_MS = 30_000;
export function workflowSla(state = {}, now = Date.now()) {
  const created = Date.parse(state.sla?.originAt || state.createdAt || state.startedAt);
  const origin = Number.isFinite(created) ? created : now;
  const deadline = origin + WORKFLOW_RESULT_BUDGET_MS;
  const end = Date.parse(state.completedAt);
  const metrics = state.metrics || state.sla || {};
  const terminal = ['completed', 'successful', 'sent-and-verified', 'skipped', 'failed', 'stopped', 'timed_out', 'incomplete', 'canceled', 'cancelled'].includes(state.status);
  const duration = Number.isFinite(end) ? Math.max(0, end - origin)
    : terminal ? (Number.isFinite(metrics.totalDurationMs) ? Math.max(0, metrics.totalDurationMs) : null)
    : Math.max(0, now - origin);
  return {
    originAt: new Date(origin).toISOString(), deadlineAt: new Date(deadline).toISOString(),
    budgetMs: WORKFLOW_RESULT_BUDGET_MS, totalDurationMs: duration,
    remainingMs: duration == null ? null : Math.max(0, WORKFLOW_RESULT_BUDGET_MS - duration),
    violated: duration != null && duration > WORKFLOW_RESULT_BUDGET_MS,
    queueDelayMs: metrics.queueDelayMs ?? (state.startedAt ? Math.max(0, Date.parse(state.startedAt) - origin) : null),
    activeShards: metrics.activeShards ?? null, completedShards: metrics.completedShards ?? null,
    totalShards: metrics.totalShards ?? null, slowestStep: metrics.slowestStep ?? null,
    resourceLocks: metrics.resourceLocks || [], estimatedCompletionAt: metrics.estimatedCompletionAt || null,
    owner: state.workerPid ? String(state.workerPid) : state.jobId || state.id || '',
  };
}
