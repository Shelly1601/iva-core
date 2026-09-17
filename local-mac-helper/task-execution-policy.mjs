import { WORKFLOW_RESULT_BUDGET_MS } from './workflow-sla.mjs';

export const MAX_AUTOMATIC_RECOVERIES = 3;
export function taskExecutionLane(request = {}) {
  if (request.planbar || request.action === 'planbar.customer.schedule' || request.lane === 'customer-scheduling') return 'customer-scheduling';
  if (request.lane === 'history' || request.workflowId === 'funding-initial-backfill' || ['backfill', 'initial-backfill'].includes(request.fundingRun?.mode)) return 'history';
  if (request.runMode === 'automatic' || request.automationSlotKey || request.forecastDelivery?.runMode === 'automatic'
    || ['schedule', 'catch-up', 'automatic'].includes(request.trigger) || request.lane === 'batch') return 'batch';
  return 'interactive';
}
export function taskResourcePriority(request = {}) {
  return ({ 'customer-scheduling': 100, interactive: 50, batch: 0, history: 0 })[taskExecutionLane(request)];
}
export function taskResultDeadline(request = {}, state = {}, now = Date.now()) {
  const origins = [request.sla?.originAt, state.sla?.originAt, request.createdAt, state.createdAt].map(Date.parse).filter(Number.isFinite);
  return (origins.length ? Math.min(...origins) : now) + WORKFLOW_RESULT_BUDGET_MS;
}
export function taskRecoveryAllowed(request = {}, state = {}, now = Date.now()) {
  return Number(state.recoveryAttempts || 0) < MAX_AUTOMATIC_RECOVERIES && now < taskResultDeadline(request, state, now);
}
export function taskWatchdogRequest(request, state, now = Date.now()) {
  return { jobId: request.jobId, status: 'requested', action: 'yield-at-safe-checkpoint', reason: 'SLA_EXCEEDED',
    safeToYieldRequired: true, preserveAmbiguousWrites: true, requestedAt: new Date(now).toISOString(),
    deadlineAt: new Date(taskResultDeadline(request, state, now)).toISOString(), completed: false };
}
